import { createMcpHandler } from "agents/mcp/server"
import { loadConfig } from "./config"
import { setApiBase } from "./github"
import { SERVER_INFO, serverFactory } from "./mcp"
import { Deadline, POLL_MIN_MS, isJsonPayload, makePollClock, sleep } from "./result"
import { buildTools, type Bindings } from "./tools"

export { EnvDO } from "./env-do"
export { GuardDO } from "./guard-do"

/*
 * Command dispatch latency is what the model feels on every exec, so /next
 * probes the queue on a tighter ceiling than /control, where the thing being
 * waited for is a kill or a destroy that can tolerate another second or two.
 */
const NEXT_POLL_MAX_MS = 2_500

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

function bearer(request: Request): string {
	const h = request.headers.get("authorization") || ""
	return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : ""
}

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	)
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export default {
	async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url)
		const cfg = loadConfig(env as Record<string, unknown>)
		setApiBase(env.GITHUB_API_BASE ? String(env.GITHUB_API_BASE) : null)

		if (url.pathname === "/healthz") {
			return json({ ok: true, server: SERVER_INFO, owner: cfg.owner, repo: cfg.repo })
		}

		/*
		 * Gate 0. Before anything else in this project is worth building, a hosted
		 * runner on all three operating systems has to be able to hold a GET open
		 * for ~50s against workers.dev. If it cannot, long-polling is the wrong
		 * transport and no amount of application design fixes it.
		 */
		if (url.pathname === "/probe") {
			const wait = Math.min(70, Math.max(0, Number(url.searchParams.get("wait") || "0")))
			const startedAt = Date.now()
			await sleep(wait * 1000)
			return json({ ok: true, waited_s: wait, held_ms: Date.now() - startedAt })
		}

		/* ------------------------------------------------------------- MCP lane */
		if (url.pathname === "/mcp") {
			const expected = String(env.MCP_AUTH_TOKEN || "")
			// The two auth lanes never cross-accept: an agent token must never open
			// the MCP surface, and MCP_AUTH_TOKEN must never drive /agent/*.
			if (!expected || !timingSafeEqual(bearer(request), expected)) {
				return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } }, 401)
			}

			// Built per request because the tool list closes over these bindings and
			// this config. responseMode is deliberately left at its default: JSON
			// mode drops notifications emitted before a final result, and those
			// notifications are the progress heartbeat that lets a client wait past
			// the 60s protocol default.
			const handler = createMcpHandler(serverFactory(buildTools(env, cfg)), { route: "/mcp" })
			return handler(request, env, ctx)
		}

		/* ----------------------------------------------------------- agent lane */
		const agent = /^\/agent\/([^/]+)\/(hello|control|next|chunk)$/.exec(url.pathname)
		if (agent) {
			const envId = decodeURIComponent(agent[1])
			const action = agent[2]
			const stub = env.ENV_DO.get(env.ENV_DO.idFromName(envId)) as any

			if (action === "hello") {
				const runId = request.headers.get("x-run-id") || ""
				const runAttempt = request.headers.get("x-run-attempt") || "1"
				const nonce = request.headers.get("x-nonce") || ""
				const ts = Number(request.headers.get("x-ts") || "0")
				const sig = request.headers.get("x-sig") || ""
				const secret = String(env.BROKER_SECRET || "")
				if (!secret) return json({ ok: false, reason: "BROKER_SECRET is not configured" }, 500)

				if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
					return json({ ok: false, reason: "timestamp outside the +/-300s window" }, 401)
				}
				const expect = await hmacHex(secret, [envId, runId, runAttempt, nonce, String(ts)].join("\n"))
				if (!timingSafeEqual(sig, expect)) return json({ ok: false, reason: "bad signature" }, 401)

				let facts: Record<string, unknown> = {}
				try {
					facts = (await request.json()) as Record<string, unknown>
				} catch {
					facts = {}
				}

				// Replay is blocked by the one-shot state check inside the DO rather
				// than by a nonce cache: the env leaves `provisioning` on first success,
				// so a replayed hello can never mint a second token.
				const r = await stub.enroll({
					runId,
					runAttempt,
					facts,
					execWorkers: cfg.execWorkers,
					unreachableLimitSeconds: cfg.unreachableLimitSeconds,
					redact: [],
				})
				if (!r.ok) return json(r, 409)
				return json(r)
			}

			const auth = await stub.authAgent(bearer(request))
			if (!auth.ok) return json({ ok: false, reason: auth.reason }, auth.status || 401)

			if (action === "control") {
				let body: any = {}
				try {
					body = await request.json()
				} catch {
					body = {}
				}
				// Renew the lease and drain immediately, then park. The hanging request
				// is held HERE, in a stateless Worker, never inside the Durable Object:
				// a 50s await inside the DO would sit in front of its input gate and
				// stall every other command for that environment.
				const first = await stub.controlPoll(body)
				if (first.destroy || first.actions.length) return json(first)

				const waitS = Math.min(cfg.agentWaitSeconds, Math.max(1, Number(body.wait) || cfg.agentWaitSeconds))

				// Holding the request costs nothing -- Workers bill per request, not per
				// second parked -- but every probe inside the hold is a billed Durable
				// Object request. At a flat 1s cadence, learning that nothing happened
				// cost 22 requests per park, which is how two idle long-polls per
				// environment reached 106,857 DO requests in a single day against a
				// 100,000/day ceiling. The park still lasts as long as the runner asked
				// for; only the probing relaxes.
				const dl = new Deadline(waitS * 1000, request.signal)
				const clock = makePollClock()
				while (await dl.tick(clock.next())) {
					if (await stub.hasActions()) {
						return json(await stub.controlPoll(body))
					}
				}

				// The runner is gone (cancelled job, killed step, dead network). There
				// is nobody to read a response, so the closing round trip -- which
				// exists to renew the lease and drain the last window -- would be spent
				// on nothing. Let the lease expire instead; that is what it is for.
				if (dl.aborted) return json({ destroy: false, actions: [] })
				return json(await stub.controlPoll(body))
			}

			if (action === "next") {
				const waitS = Math.min(
					cfg.agentWaitSeconds,
					Math.max(1, Number(url.searchParams.get("wait")) || cfg.agentWaitSeconds),
				)
				const worker = url.searchParams.get("worker") || "0"
				const dl = new Deadline(waitS * 1000, request.signal)
				const clock = makePollClock(POLL_MIN_MS, NEXT_POLL_MAX_MS)
				for (;;) {
					const r = await stub.claimNext(worker)
					if (r.command) return json({ command: r.command })
					// A claim is a write, so an aborted request must not start another
					// one: the job would be handed to a worker that has already gone
					// away and would have to time out as `lost`.
					if (!(await dl.tick(clock.next()))) return json({ command: null })
				}
			}

			if (action === "chunk") {
				const text = await request.text()
				if (!isJsonPayload(request.headers.get("content-type"), text)) {
					return json({ ok: false, reason: "expected a JSON body" }, 400)
				}
				let body: any
				try {
					body = JSON.parse(text)
				} catch {
					return json({ ok: false, reason: "malformed JSON" }, 400)
				}
				return json(await stub.ingestChunk(body))
			}
		}

		return json({ ok: false, error: "not found" }, 404)
	},
}
