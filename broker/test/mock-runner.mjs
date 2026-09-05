#!/usr/bin/env node
/*
 * Mock runner + fake GitHub API, in one dependency-free process.
 *
 * It stands in for BOTH halves of the outside world so the regression suite can
 * run offline in seconds:
 *
 *   1. A fake api.github.com. `workflow_dispatch` returns a run id and starts a
 *      simulated runner for that env_id; the runs list reports it as
 *      in_progress with `run-name: gha-mcp <env_id>` (which is what env_list
 *      parses); cancel stops it.
 *   2. A simulated runner that speaks the real /agent wire protocol -- enroll
 *      HMAC, control long-poll, N exec workers on /next, byte-offset chunks on
 *      /chunk -- but fabricates command output instead of spawning processes,
 *      so faults are deterministic.
 *
 * Running the suite against the real API would burn Actions minutes and produce
 * exactly the dispatch pattern that got the previous account suspended.
 *
 * Usage:
 *   node test/mock-runner.mjs --broker=http://127.0.0.1:8787 \
 *                             --gh-port=8788 --secret=devsecret [--workers=2]
 *
 * Commands are directives, not shell (see simulate() below):
 *   sim:echo <text>      sim:spam <kib>     sim:drip <lines> <ms>
 *   sim:sleep <ms>       sim:hang           sim:exit <code>
 *   sim:vanish           sim:stall          sim:ansi
 */
import { createHmac, randomUUID } from "node:crypto"
import { createServer } from "node:http"

const args = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const m = /^--([^=]+)=?(.*)$/.exec(a)
		return m ? [m[1], m[2] === "" ? "true" : m[2]] : [a, "true"]
	}),
)
const BROKER = (args.broker || "http://127.0.0.1:8787").replace(/\/+$/, "")
const GH_PORT = Number(args["gh-port"] || 8788)
const SECRET = args.secret || "devsecret"
const WORKERS = Number(args.workers || 2)
const VERBOSE = args.verbose === "true"

const log = (...a) => console.error("[mock]", ...a)
const vlog = (...a) => VERBOSE && log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------ fake GitHub */

let nextRunId = 900000000
const runs = new Map() // runId -> { envId, status, runners }

function ghJson(res, status, body) {
	const text = JSON.stringify(body)
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) })
	res.end(text)
}

const gh = createServer((req, res) => {
	const url = new URL(req.url, `http://127.0.0.1:${GH_PORT}`)
	let body = ""
	req.on("data", (c) => (body += c))
	req.on("end", () => {
		const dispatch = /^\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/.exec(url.pathname)
		if (dispatch && req.method === "POST") {
			let parsed = {}
			try {
				parsed = JSON.parse(body)
			} catch {}
			const envId = parsed?.inputs?.env_id
			if (!envId) return ghJson(res, 422, { message: "env_id input missing" })
			if (args.fault === "suspended") {
				// Scenario (f): the account-level 403 must open the breaker, not retry.
				return ghJson(res, 403, { message: "Sorry. Your account was suspended", status: "403" })
			}
			const runId = String(nextRunId++)
			runId && runs.set(runId, { envId, status: "in_progress", stop: null })
			ghJson(res, 200, {
				run: { id: Number(runId), html_url: `{{http://localhost/run/${runId}}}`, run_attempt: 1 },
			})
			startRunner(envId, runId, Number(parsed?.inputs?.ttl_minutes || 60)).catch((e) => log("runner died:", e))
			return
		}

		const cancel = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/([^/]+)\/cancel$/.exec(url.pathname)
		if (cancel && req.method === "POST") {
			const r = runs.get(cancel[3])
			if (!r) return ghJson(res, 409, { message: "already finished" })
			r.status = "completed"
			if (r.stop) r.stop()
			return ghJson(res, 202, {})
		}

		const list = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs$/.exec(url.pathname)
		if (list && req.method === "GET") {
			const want = url.searchParams.get("status")
			const workflow_runs = [...runs.entries()]
				.filter(([, r]) => r.status === want)
				.map(([id, r]) => ({
					id: Number(id),
					run_attempt: 1,
					// Exactly what the real workflows produce via `run-name:`.
					name: `gha-mcp ${r.envId}`,
					status: r.status,
					html_url: `{{http://localhost/run/${id}}}`,
					created_at: new Date().toISOString(),
				}))
			return ghJson(res, 200, { total_count: workflow_runs.length, workflow_runs })
		}

		ghJson(res, 404, { message: `mock github has no route for ${req.method} ${url.pathname}` })
	})
})

/* --------------------------------------------------------- simulated runner */

async function post(path, token, body, timeoutMs = 70000) {
	const ctl = new AbortController()
	const t = setTimeout(() => ctl.abort(), timeoutMs)
	try {
		const res = await fetch(BROKER + path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(body),
			signal: ctl.signal,
		})
		const text = await res.text()
		return { status: res.status, json: text ? JSON.parse(text) : null }
	} catch (e) {
		return { status: 0, json: null, error: String(e) }
	} finally {
		clearTimeout(t)
	}
}

async function get(path, token, timeoutMs = 70000) {
	const ctl = new AbortController()
	const t = setTimeout(() => ctl.abort(), timeoutMs)
	try {
		const res = await fetch(BROKER + path, {
			headers: token ? { authorization: `Bearer ${token}` } : {},
			signal: ctl.signal,
		})
		const text = await res.text()
		return { status: res.status, json: text ? JSON.parse(text) : null }
	} catch (e) {
		return { status: 0, json: null, error: String(e) }
	} finally {
		clearTimeout(t)
	}
}

async function startRunner(envId, runId, ttlMinutes) {
	const ts = Math.floor(Date.now() / 1000)
	const nonce = randomUUID()
	const sig = createHmac("sha256", SECRET)
		.update([envId, runId, "1", nonce, String(ts)].join("\n"))
		.digest("hex")

	let enrolled = null
	for (let i = 0; i < 20 && !enrolled; i++) {
		const res = await fetch(`${BROKER}/agent/${envId}/hello`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-run-id": runId,
				"x-run-attempt": "1",
				"x-nonce": nonce,
				"x-ts": String(ts),
				"x-sig": sig,
			},
			body: JSON.stringify({
				platform: envId.startsWith("win-") ? "windows" : envId.startsWith("mac-") ? "macos" : "linux",
				node: process.version,
				work_dir: "/tmp/gha-mcp/work",
				run_url: `{{http://localhost/run/${runId}}}`,
				mock: true,
			}),
		}).catch(() => null)
		if (res && res.ok) enrolled = await res.json()
		else await sleep(300)
	}
	if (!enrolled?.agent_token) throw new Error(`enroll failed for ${envId}`)
	log(`runner ${envId} enrolled (run ${runId}, ttl ${ttlMinutes}m)`)

	const state = {
		token: enrolled.agent_token,
		stopped: false,
		dead: false, // sim:vanish -- process is gone, nothing more is ever sent
		jobs: new Map(), // command_id -> { total, buf, state, killed }
	}
	const run = runs.get(runId)
	if (run) run.stop = () => (state.stopped = true)

	controlLoop(envId, state).catch((e) => log("control loop:", e))
	for (let i = 0; i < WORKERS; i++) execLoop(envId, state, String(i)).catch((e) => log("exec loop:", e))
}

async function controlLoop(envId, st) {
	while (!st.stopped && !st.dead) {
		const running = [...st.jobs.entries()]
			.filter(([, j]) => j.state === "running")
			.map(([id]) => ({ command_id: id }))
		const r = await post(`/agent/${envId}/control`, st.token, {
			disk_free_mb: Number(args["disk-free-mb"] || 40000),
			running,
			agent_version: "mock-0.1.0",
			wait: 25,
		})
		if (st.dead) return
		if (r.status === 410) {
			log(`runner ${envId} lease gone; stopping`)
			st.stopped = true
			return
		}
		if (r.status !== 200) {
			// A dropped long-poll is a normal event (wrangler reload swaps the
			// isolate). Reconnect with jitter; never treat it as fatal.
			await sleep(300 + Math.random() * 500)
			continue
		}
		if (r.json?.destroy) {
			log(`runner ${envId} destroyed`)
			st.stopped = true
			return
		}
		for (const action of r.json?.actions || []) await handleAction(envId, st, action)
	}
}

async function handleAction(envId, st, action) {
	vlog("action", action.type)
	if (action.type === "kill") {
		const ids = action.command_id === "all" ? [...st.jobs.keys()] : [action.command_id]
		for (const id of ids) {
			const job = st.jobs.get(id)
			if (!job || job.state !== "running") continue
			job.killed = true
			job.state = "killed"
			await push(envId, st, id, "", "killed", null, { killed_reason: `signal ${action.signal}` })
		}
		return
	}
	if (action.type === "pull") {
		// Scenario (e): the broker ring evicted this range, so re-serve it from the
		// runner's own output file -- here, the in-memory buffer standing in for it.
		const job = st.jobs.get(action.command_id)
		const buf = job ? job.buf : Buffer.alloc(0)
		const slice = buf.subarray(action.from_byte, action.from_byte + action.max_bytes)
		await post(`/agent/${envId}/chunk`, st.token, {
			command_id: action.command_id,
			start_byte: action.from_byte,
			bytes_b64: slice.toString("base64"),
			total_bytes: buf.length,
			state: job?.state || "lost",
			exit_code: job?.exit_code ?? null,
			pull: true,
			req_id: action.req_id,
		})
	}
}

async function push(envId, st, id, text, state, exitCode, extra = {}) {
	const job = st.jobs.get(id)
	if (!job || st.dead) return
	const bytes = Buffer.from(text, "utf8")
	const start = job.total
	job.buf = Buffer.concat([job.buf, bytes])
	job.total += bytes.length
	if (exitCode !== null && exitCode !== undefined) job.exit_code = exitCode
	await post(`/agent/${envId}/chunk`, st.token, {
		command_id: id,
		start_byte: start,
		bytes_b64: bytes.toString("base64"),
		total_bytes: job.total,
		state,
		exit_code: exitCode ?? null,
		runtime_ms: Date.now() - job.started,
		disk_free_mb: Number(args["disk-free-mb"] || 40000),
		...extra,
	})
}

async function execLoop(envId, st, worker) {
	while (!st.stopped && !st.dead) {
		const r = await get(`/agent/${envId}/next?wait=25&worker=${worker}`, st.token)
		if (st.dead) return
		if (r.status === 410) return
		if (r.status !== 200) {
			await sleep(300 + Math.random() * 500)
			continue
		}
		const cmd = r.json?.command
		if (!cmd) continue
		// O_EXCL stand-in: the broker is allowed to redeliver, the runner is not
		// allowed to run it twice.
		if (st.jobs.has(cmd.command_id)) {
			vlog("redelivered, ignoring", cmd.command_id)
			continue
		}
		st.jobs.set(cmd.command_id, {
			total: 0,
			buf: Buffer.alloc(0),
			state: "running",
			started: Date.now(),
			exit_code: null,
			killed: false,
		})
		simulate(envId, st, cmd).catch((e) => log("simulate:", e))
	}
}

async function simulate(envId, st, cmd) {
	const id = cmd.command_id
	const job = st.jobs.get(id)
	const text = String(cmd.command || "").trim()
	const [, verb = "", rest = ""] = /^sim:(\w+)\s*(.*)$/s.exec(text) || []
	const done = async (code, tail = "") => {
		if (job.killed) return
		job.state = "exited"
		await push(envId, st, id, tail, "exited", code, { cwd_after: cmd.cwd || "/tmp/gha-mcp/work", eof: true })
	}

	switch (verb) {
		case "echo":
			return done(0, rest + "\n")

		case "exit":
			return done(Number(rest) || 0, `exiting ${Number(rest) || 0}\n`)

		case "sleep":
			await sleep(Number(rest) || 1000)
			return done(0, "slept\n")

		case "spam": {
			// Scenario (e): more output than the broker ring holds, so early bytes
			// must come back through a pull rather than silently vanishing.
			const kib = Number(rest) || 64
			for (let i = 0; i < kib; i++) {
				if (job.killed) return
				await push(envId, st, id, `${String(i).padStart(6, "0")} ${"x".repeat(1015)}\n`, "running", null)
			}
			return done(0)
		}

		case "drip": {
			const [n = "10", ms = "500"] = rest.split(/\s+/)
			for (let i = 0; i < Number(n); i++) {
				if (job.killed) return
				await sleep(Number(ms))
				await push(envId, st, id, `line ${i}\n`, "running", null)
			}
			return done(0)
		}

		case "ansi":
			// The runner strips ANSI before the bytes ever leave it, so what the
			// broker sees is already clean.
			return done(0, "plain after strip\n")

		case "hang":
			// Scenario: exec must return on deadline, and exec_read(until:'exit')
			// must come back with a warning rather than hitting the client timeout.
			await push(envId, st, id, "started, now going quiet forever\n", "running", null)
			return

		case "stall":
			// Claimed, running, never a single byte.
			return

		case "vanish":
			// Scenario (b): the runner is SIGKILLed. Nothing is ever sent again, so
			// the environment must degrade to runner_gone / lost -- never to a
			// transport error, and never to state "unknown".
			log(`runner ${envId} vanishing on purpose`)
			st.dead = true
			return

		default:
			return done(0, `${text}\n`)
	}
}

/* --------------------------------------------------------------------- go */

gh.listen(GH_PORT, "127.0.0.1", () => {
	log(`fake github on http://127.0.0.1:${GH_PORT}, broker at ${BROKER}`)
	log(`fault mode: ${args.fault || "none"}, exec workers per runner: ${WORKERS}`)
})

process.on("SIGINT", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))
