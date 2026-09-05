import { isJsonPayload } from "./result"

const UA = "gha-mcp-broker/0.1"
let API = "https://api.github.com"

/**
 * Test hook. Lets the end-to-end suite point the client at a local fake GitHub so
 * it never dispatches a real workflow -- running the regression scenarios against
 * the real API would burn Actions minutes and, worse, is exactly the traffic
 * pattern that got the previous account suspended.
 */
export function setApiBase(base: string | null | undefined) {
	if (base && /^https?:\/\//.test(base)) API = base.replace(/\/+$/, "")
}

export type GhFailure = {
	ok: false
	code:
		| "account_suspended"
		| "github_secondary_rate_limit"
		| "github_5xx"
		| "bad_input"
		| "unauthorized"
		| "platform_unavailable"
		| "broker_unreachable"
	status: number
	message: string
	retryAfterMs: number | null
}

export type DispatchOk = {
	ok: true
	runId: string | null
	runUrl: string | null
	runAttempt: string | null
}

function classify(status: number, body: string, headers: Headers): GhFailure {
	const lower = body.toLowerCase()
	// The single most important case: the whole account is suspended, which is not
	// a rate limit and has no time-based recovery. It must open a circuit breaker,
	// not be retried -- the previous system hammered it 5 times in a row.
	if (status === 403 && lower.includes("suspend")) {
		return {
			ok: false,
			code: "account_suspended",
			status,
			message:
				"GitHub reports this account as suspended. This is not a rate limit and does not recover on its own. Stop dispatching and contact GitHub Support.",
			retryAfterMs: null,
		}
	}
	const retryAfter = Number(headers.get("retry-after") || "")
	if (status === 403 || status === 429) {
		return {
			ok: false,
			code: "github_secondary_rate_limit",
			status,
			message: body.slice(0, 300),
			retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 60_000,
		}
	}
	if (status === 401) {
		return { ok: false, code: "unauthorized", status, message: "GITHUB_PAT_DISPATCH rejected", retryAfterMs: null }
	}
	if (status === 404) {
		return {
			ok: false,
			code: "platform_unavailable",
			status,
			message: "workflow or repository not found; check GITHUB_OWNER/GITHUB_REPO and that the workflow exists on the default branch",
			retryAfterMs: null,
		}
	}
	if (status >= 500) {
		return { ok: false, code: "github_5xx", status, message: body.slice(0, 300), retryAfterMs: 3000 }
	}
	return { ok: false, code: "bad_input", status, message: body.slice(0, 300), retryAfterMs: null }
}

async function call(
	token: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; text: string; json: any; headers: Headers } | null> {
	try {
		const res = await fetch(API + path, {
			method,
			headers: {
				accept: "application/vnd.github+json",
				"x-github-api-version": "2022-11-28",
				"user-agent": UA,
				authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		const text = await res.text()
		let json: any = null
		if (isJsonPayload(res.headers.get("content-type"), text)) {
			try {
				json = JSON.parse(text)
			} catch {
				json = null
			}
		}
		return { status: res.status, text, json, headers: res.headers }
	} catch {
		return null
	}
}

export async function dispatchWorkflow(opts: {
	token: string
	owner: string
	repo: string
	workflow: string
	ref: string
	inputs: Record<string, string>
}): Promise<DispatchOk | GhFailure> {
	const r = await call(
		opts.token,
		"POST",
		`/repos/${opts.owner}/${opts.repo}/actions/workflows/${opts.workflow}/dispatches`,
		{ ref: opts.ref, inputs: opts.inputs, return_run_details: true },
	)
	if (!r) {
		return { ok: false, code: "broker_unreachable", status: 0, message: "could not reach api.github.com", retryAfterMs: 2000 }
	}
	if (r.status === 204) {
		// Older behaviour: dispatch accepted with no body. The run id is resolved
		// lazily, once, only if provisioning overruns its platform threshold.
		return { ok: true, runId: null, runUrl: null, runAttempt: null }
	}
	if (r.status >= 200 && r.status < 300) {
		const j = r.json || {}
		const run = j.run || j.workflow_run || j
		return {
			ok: true,
			runId: run.id != null ? String(run.id) : run.run_id != null ? String(run.run_id) : null,
			runUrl: run.html_url || run.run_html_url || null,
			runAttempt: run.run_attempt != null ? String(run.run_attempt) : "1",
		}
	}
	return classify(r.status, r.text, r.headers)
}

export async function cancelRun(opts: {
	token: string
	owner: string
	repo: string
	runId: string
}): Promise<{ ok: boolean; status: number; message: string }> {
	const r = await call(
		opts.token,
		"POST",
		`/repos/${opts.owner}/${opts.repo}/actions/runs/${opts.runId}/cancel`,
	)
	if (!r) return { ok: false, status: 0, message: "could not reach api.github.com" }
	// 202 accepted, 409 means it already finished -- both are "the job will not
	// keep running", which is the only thing the caller cares about.
	const ok = r.status === 202 || r.status === 409
	return { ok, status: r.status, message: ok ? "cancel accepted" : r.text.slice(0, 200) }
}

export type RunSummary = {
	run_id: string
	run_attempt: number
	name: string
	status: string
	html_url: string
	created_at: string
}

/**
 * The authority for "which environments are alive" is GitHub's in-progress run
 * list, not a stored index. A stored index always drifts and manufactures the
 * phantom rows the previous system produced.
 */
export async function listLiveRuns(opts: {
	token: string
	owner: string
	repo: string
}): Promise<{ ok: true; runs: RunSummary[] } | GhFailure> {
	const out: RunSummary[] = []
	for (const status of ["in_progress", "queued"]) {
		const r = await call(
			opts.token,
			"GET",
			`/repos/${opts.owner}/${opts.repo}/actions/runs?status=${status}&per_page=100&exclude_pull_requests=true`,
		)
		if (!r) {
			return { ok: false, code: "broker_unreachable", status: 0, message: "could not reach api.github.com", retryAfterMs: 2000 }
		}
		if (r.status < 200 || r.status >= 300) return classify(r.status, r.text, r.headers)
		for (const run of (r.json && r.json.workflow_runs) || []) {
			out.push({
				run_id: String(run.id),
				run_attempt: Number(run.run_attempt || 1),
				name: String(run.name || ""),
				status: String(run.status || ""),
				html_url: String(run.html_url || ""),
				created_at: String(run.created_at || ""),
			})
		}
	}
	return { ok: true, runs: out }
}

export async function findRunForEnv(opts: {
	token: string
	owner: string
	repo: string
	envId: string
}): Promise<RunSummary | null> {
	const live = await listLiveRuns(opts)
	if (!live.ok) return null
	// The workflows set `run-name: gha-mcp <env_id>`, so the env id is visible on
	// the runs list even though dispatch inputs are not.
	const hit = live.runs.find((r) => r.name.includes(opts.envId))
	return hit || null
}
