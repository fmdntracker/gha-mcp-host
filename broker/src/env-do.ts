import { DurableObject } from "cloudflare:workers"
import { b64decode, b64encode } from "./bytes"
import { initSchema, isTerminal, mget, mnum, mset, type CmdState, type Sql } from "./env-schema"
import { buildSnapshot, queueDepth } from "./env-snapshot"
import { emptyWindow, readWindow, type WindowResult } from "./env-window"
import { pickKilledReason } from "./kill-reason"
import { appendChunk, newRing, tailOf, type Ring } from "./ring"

export type { CmdState, EnvState } from "./env-schema"
export type { WindowResult } from "./env-window"

/**
 * Output bytes never enter Durable Object storage while a command runs: storage
 * holds total_bytes and nothing more, and the ring in front of it is in memory
 * only. If the object is evicted the ring is empty, which is indistinguishable
 * from eviction by size, and both are answered the same way -- by asking the
 * runner to re-serve the range, since its out.raw is the only real buffer.
 *
 * The single exception is the tail persisted when a command finishes, because a
 * finished command's exit code must not outlive the output that explains it.
 */
const PULL_TTL_MS = 90_000
const CLAIM_REDELIVER_MS = 30_000

/**
 * Past this, the runner is assumed unable to re-serve a range. Deliberately the
 * same threshold the exec tools use for runner_gone: two different answers to
 * "is the runner still there" is how a reader ends up blocked on a pull that
 * nobody is left to answer.
 */
const RUNNER_GONE_MS = 120_000

/** Bounded so a repeating warning cannot grow a row without limit. */
const MAX_STORED_WARNINGS = 10

function numOr(v: unknown, d: number | null): number | null {
	if (v === null || v === undefined) return d
	const x = Number(v)
	return Number.isFinite(x) ? x : d
}

/**
 * The one precondition worth failing an environment over.
 *
 * Every shell decision downstream -- the exit-code epilogue, the UTF-8 console
 * setup, the script extension -- assumes a specific interpreter is present. A
 * runner image that has quietly lost it produces commands that exit 0 with no
 * output, which is exactly the failure the previous system spent its life
 * chasing. So check once, here, and fail loudly rather than excluding the shell
 * silently and letting the first exec inherit the confusion.
 */
function missingShell(platform: string, facts: Record<string, unknown>): string | null {
	const shells = (facts.shells || {}) as Record<string, unknown>
	const need = platform === "windows" ? "pwsh" : "bash"
	if (shells[need]) return null
	const seen = Object.keys(shells)
		.filter((k) => shells[k])
		.join(", ")
	return `runner cannot host a ${platform} environment: ${need} is missing (shells present: ${seen || "none"})`
}

function mergeWarnings(stored: unknown, incoming: unknown, ...extras: (string | null)[]): string | null {
	const out: string[] = []
	const push = (v: unknown) => {
		if (typeof v === "string" && v.trim()) out.push(v.slice(0, 300))
	}
	if (typeof stored === "string" && stored) {
		try {
			for (const w of JSON.parse(stored)) push(w)
		} catch {
			push(stored)
		}
	}
	if (Array.isArray(incoming)) for (const w of incoming) push(w)
	else push(incoming)
	for (const e of extras) push(e)
	const unique = [...new Set(out)].slice(0, MAX_STORED_WARNINGS)
	return unique.length ? JSON.stringify(unique) : null
}

export class EnvDO extends DurableObject {
	private rings = new Map<string, Ring>()
	private actions: any[] = []
	private pulls = new Map<string, any>()
	private ready = false

	private get sql(): Sql {
		return this.ctx.storage.sql as unknown as Sql
	}

	private init() {
		if (this.ready) return
		initSchema(this.sql)
		this.ready = true
	}

	private mget(k: string): string | null {
		this.init()
		return mget(this.sql, k)
	}

	private mset(k: string, v: string | number | null) {
		this.init()
		mset(this.sql, k, v)
	}

	private mnum(k: string, d: number | null = null): number | null {
		this.init()
		return mnum(this.sql, k, d)
	}

	/* ------------------------------------------------------------ lifecycle */

	async provision(input: {
		envId: string
		platform: string
		ttlMinutes: number
		label: string | null
		createdBy: string | null
	}): Promise<void> {
		this.init()
		this.mset("env_id", input.envId)
		this.mset("platform", input.platform)
		this.mset("state", "provisioning")
		this.mset("label", input.label)
		this.mset("created_by", input.createdBy)
		this.mset("created_at", Date.now())
		this.mset("ttl_expires_at", Date.now() + input.ttlMinutes * 60_000)
		this.mset("overlay_version", 0)
	}

	async setDispatch(d: { runId: string | null; runAttempt: string | null; runUrl: string | null }) {
		if (d.runId) this.mset("run_id", d.runId)
		if (d.runAttempt) this.mset("run_attempt", d.runAttempt)
		if (d.runUrl) this.mset("run_url", d.runUrl)
	}

	/**
	 * One-shot enroll. The real security property is not the HMAC (which only
	 * proves possession of a repo secret every job already has) but that this can
	 * succeed exactly once per env, while state is still `provisioning`, and only
	 * for the (run_id, run_attempt) pair we saved from the dispatch response.
	 *
	 * A mismatch is never a silent 401: the env is marked `failed` with the reason
	 * recorded, so the caller sees why instead of watching it hang in provisioning.
	 */
	async enroll(claim: {
		runId: string
		runAttempt: string
		facts: Record<string, unknown>
		execWorkers: number
		unreachableLimitSeconds: number
		redact: string[]
	}): Promise<
		| { ok: true; agent_token: string; ttl_expires_at: number; exec_workers: number; unreachable_limit_s: number; redact: string[] }
		| { ok: false; reason: string }
	> {
		this.init()
		const state = this.mget("state")
		if (state !== "provisioning") {
			return { ok: false, reason: `enroll rejected: env state is ${state}, expected provisioning (enroll is one-shot)` }
		}
		const expectRun = this.mget("run_id")
		const expectAttempt = this.mget("run_attempt")
		if (expectRun && expectRun !== claim.runId) {
			this.mset("state", "failed")
			this.mset("failure_reason", `run_id mismatch: dispatch recorded ${expectRun}, caller claimed ${claim.runId}`)
			return { ok: false, reason: "run_id mismatch" }
		}
		if (expectAttempt && expectAttempt !== claim.runAttempt) {
			this.mset("state", "failed")
			this.mset("failure_reason", `run_attempt mismatch: expected ${expectAttempt}, got ${claim.runAttempt}`)
			return { ok: false, reason: "run_attempt mismatch" }
		}
		const shellProblem = missingShell(this.mget("platform") || "", claim.facts)
		if (shellProblem) {
			this.mset("state", "failed")
			this.mset("failure_reason", shellProblem)
			return { ok: false, reason: shellProblem }
		}

		// No expiry is embedded in the token. It is validated against
		// ttl_expires_at on every request, so env_extend takes effect immediately
		// and "401 right after a successful extend" cannot happen.
		const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")
		this.mset("agent_token", token)
		this.mset("state", "ready")
		this.mset("run_id", claim.runId)
		this.mset("run_attempt", claim.runAttempt)
		this.mset("last_seen_at", Date.now())
		this.mset("facts", JSON.stringify(claim.facts))
		if (typeof claim.facts.run_url === "string") this.mset("run_url", claim.facts.run_url)
		if (typeof claim.facts.work_dir === "string" && !this.mget("sticky_cwd")) {
			this.mset("sticky_cwd", claim.facts.work_dir)
		}
		return {
			ok: true,
			agent_token: token,
			ttl_expires_at: this.mnum("ttl_expires_at", Date.now() + 3_600_000)!,
			exec_workers: claim.execWorkers,
			unreachable_limit_s: claim.unreachableLimitSeconds,
			redact: claim.redact,
		}
	}

	/**
	 * The shells this runner reported at enroll, exactly as probed.
	 *
	 * exec consults this before queueing anything. A shell that is not installed
	 * is a permanent condition, and the runner's only way to report it is to fail
	 * the command -- which surfaces as `lost`, and `lost` reads as "retrying may
	 * work". An empty object means the runner enrolled without publishing facts,
	 * and the caller must then treat every shell as allowed rather than guess.
	 */
	async shellsAvailable(): Promise<Record<string, string | null>> {
		this.init()
		try {
			const facts = JSON.parse(this.mget("facts") || "{}")
			const shells = facts && typeof facts === "object" ? facts.shells : null
			return shells && typeof shells === "object" ? shells : {}
		} catch {
			return {}
		}
	}

	async authAgent(token: string): Promise<{ ok: boolean; reason?: string; status?: number }> {
		const expected = this.mget("agent_token")
		if (!expected || token !== expected) return { ok: false, reason: "bad agent token", status: 401 }
		const state = this.mget("state")
		if (state === "destroying" || state === "expired") return { ok: false, reason: `env ${state}`, status: 410 }
		const ttl = this.mnum("ttl_expires_at", 0)!
		if (Date.now() > ttl) {
			this.mset("state", "expired")
			return { ok: false, reason: "lease expired", status: 410 }
		}
		return { ok: true }
	}

	/**
	 * Extend, and only ever extend.
	 *
	 * `minutes` is ADDED to the lease the environment already has. Measuring from
	 * now instead looks identical for an env that is nearly up and silently
	 * SHORTENS every other one: env_extend(minutes: 15) against a lease with 39
	 * minutes left used to leave it with 15, which is the opposite of what the
	 * caller asked for and cost them the environment. A lease that has already
	 * lapsed extends from now, because extending from a point in the past would
	 * be a no-op. The hard cap is still measured from creation, since GitHub kills
	 * the job at 6 hours no matter what this row says, and if the cap lands before
	 * where the lease already was we keep the later of the two.
	 */
	async extend(minutes: number, maxTtlMinutes: number): Promise<{ ttl_expires_at: number; warnings: string[] }> {
		const warnings: string[] = []
		const now = Date.now()
		const createdAt = this.mnum("created_at", now)!
		const hardCap = createdAt + maxTtlMinutes * 60_000
		const current = this.mnum("ttl_expires_at", now)!
		let next = Math.max(current, now) + minutes * 60_000
		if (next > hardCap) {
			warnings.push(
				`ttl clamped to ${maxTtlMinutes} minutes from creation (GitHub kills the job at 6h regardless)`,
			)
			next = hardCap
		}
		if (next < current) {
			warnings.push(
				`this environment is already at its ${maxTtlMinutes}-minute ceiling, so the lease is unchanged`,
			)
			next = current
		}
		this.mset("ttl_expires_at", next)
		return { ttl_expires_at: next, warnings }
	}

	async markDestroying(): Promise<{ run_id: string | null }> {
		this.mset("state", "destroying")
		this.actions.push({ type: "destroy" })
		return { run_id: this.mget("run_id") }
	}

	async markFailed(reason: string) {
		this.mset("state", "failed")
		this.mset("failure_reason", reason)
	}

	/* -------------------------------------------------------------- control */

	async controlPoll(body: {
		disk_free_mb: number | null
		running: any[]
		agent_version?: string
	}): Promise<{ ttl_expires_at: number; destroy: boolean; actions: any[] }> {
		this.init()
		this.mset("last_seen_at", Date.now())
		if (body.disk_free_mb !== null && body.disk_free_mb !== undefined) {
			this.mset("disk_free_mb", body.disk_free_mb)
		}
		if (body.agent_version) this.mset("agent_version", body.agent_version)

		// The runner is the only place that knows a job died between the O_EXCL
		// marker and spawn. Record it so exec/exec_read can answer `lost` with
		// on_error=reexecute_unsafe rather than hanging on a queued row.
		//
		// COALESCE keeps an existing reason on purpose here, the opposite of the
		// merge in ingestChunk: spawn_gap is the lowest-priority reason there is,
		// because it is inferred from a process that is not there rather than
		// observed.
		for (const r of body.running || []) {
			if (r && r.spawn_gap && r.command_id) {
				this.sql.exec(
					`UPDATE command SET state = 'lost', killed_reason = COALESCE(killed_reason, 'spawn_gap'), ended_at = ?
					 WHERE command_id = ? AND state IN ('queued','running')`,
					Date.now(),
					String(r.command_id),
				)
			}
		}

		const actions = this.actions
		this.actions = []
		const state = this.mget("state")
		return {
			ttl_expires_at: this.mnum("ttl_expires_at", Date.now())!,
			destroy: state === "destroying" || state === "expired",
			actions,
		}
	}

	async pushAction(action: any): Promise<void> {
		this.actions.push(action)
	}

	async hasActions(): Promise<boolean> {
		return this.actions.length > 0 || this.mget("state") === "destroying"
	}

	/* ---------------------------------------------------------------- queue */

	async enqueue(cmd: {
		command_id: string
		idem_hash: string
		payload: Record<string, unknown>
		label: string | null
		cwd: string | null
		shell: string | null
		maxQueue: number
		idemWindowMs: number
	}): Promise<
		| { ok: true; command_id: string; deduped: boolean; queue_position: number; queue_depth: number; overlay_version: number }
		| { ok: false; code: "runner_busy_queue_full"; queue_depth: number; max_queue: number }
	> {
		this.init()
		const since = Date.now() - cmd.idemWindowMs
		const dupe = this.sql
			.exec(
				`SELECT command_id FROM command WHERE idem_hash = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
				cmd.idem_hash,
				since,
			)
			.toArray()
		if (dupe.length) {
			const depth = queueDepth(this.sql)
			return {
				ok: true,
				command_id: String(dupe[0].command_id),
				deduped: true,
				queue_position: 0,
				queue_depth: depth,
				overlay_version: this.mnum("overlay_version", 0)!,
			}
		}

		const depth = queueDepth(this.sql)
		if (depth >= cmd.maxQueue) {
			return { ok: false, code: "runner_busy_queue_full", queue_depth: depth, max_queue: cmd.maxQueue }
		}

		this.sql.exec(
			`INSERT INTO command (command_id, idem_hash, state, created_at, total_bytes, label, cwd, shell)
			 VALUES (?, ?, 'queued', ?, 0, ?, ?, ?)`,
			cmd.command_id,
			cmd.idem_hash,
			Date.now(),
			cmd.label,
			cmd.cwd,
			cmd.shell,
		)
		this.sql.exec(
			`INSERT INTO queue (command_id, payload) VALUES (?, ?)`,
			cmd.command_id,
			JSON.stringify(cmd.payload),
		)
		return {
			ok: true,
			command_id: cmd.command_id,
			deduped: false,
			queue_position: depth,
			queue_depth: depth + 1,
			overlay_version: this.mnum("overlay_version", 0)!,
		}
	}

	async queueDepth(): Promise<number> {
		this.init()
		return queueDepth(this.sql)
	}

	/**
	 * Redelivery is allowed on purpose: a claim that is not acknowledged within
	 * CLAIM_REDELIVER_MS becomes claimable again. Double execution is prevented on
	 * the runner by an O_EXCL marker file, not by a lock here, because a lock
	 * would have to be broken on a lost runner and would then be wrong.
	 *
	 * The payload is returned exactly as exec enqueued it, max_output_bytes
	 * included; the runner only falls back to its own default when the field is
	 * absent, which is what makes an old runner safe against a new broker.
	 */
	async claimNext(worker: string): Promise<{ command: any | null }> {
		this.init()
		const now = Date.now()
		const rows = this.sql
			.exec(
				`SELECT seq, command_id, payload FROM queue
				 WHERE claimed_by IS NULL OR claimed_at < ?
				 ORDER BY seq ASC LIMIT 1`,
				now - CLAIM_REDELIVER_MS,
			)
			.toArray()
		if (!rows.length) return { command: null }
		const row = rows[0]
		this.sql.exec(`UPDATE queue SET claimed_by = ?, claimed_at = ? WHERE seq = ?`, worker, now, row.seq)
		this.sql.exec(
			`UPDATE command SET state = 'running', started_at = COALESCE(started_at, ?) WHERE command_id = ?`,
			now,
			row.command_id,
		)
		let payload: any = null
		try {
			payload = JSON.parse(String(row.payload))
		} catch {
			payload = null
		}
		return { command: payload }
	}

	/* --------------------------------------------------------------- output */

	async ingestChunk(body: {
		command_id: string
		start_byte: number
		bytes_b64: string
		total_bytes: number
		bytes_written?: number | null
		state: CmdState
		exit_code: number | null
		runtime_ms?: number
		eof?: boolean
		req_id?: string
		pull?: boolean
		cwd_after?: string | null
		killed_reason?: string | null
		signal?: string | null
		output_capped?: boolean
		disk_free_mb?: number | null
		warnings?: string[] | string | null
		agent_error?: string | null
	}): Promise<{ ok: true }> {
		this.init()
		const id = String(body.command_id)
		const now = Date.now()
		const incoming = b64decode(body.bytes_b64 || "")

		if (body.pull && body.req_id) {
			this.pulls.set(body.req_id, {
				at: now,
				start: body.start_byte,
				bytes: incoming,
				total: body.total_bytes,
				state: body.state,
				error: body.agent_error || null,
			})
			this.gcPulls()
			return { ok: true }
		}

		if (incoming.length) {
			let r = this.rings.get(id)
			if (!r) {
				r = newRing(body.start_byte)
				this.rings.set(id, r)
			}
			appendChunk(r, body.start_byte, incoming)
		}
		const ring = this.rings.get(id)

		const prevRows = this.sql
			.exec(
				`SELECT state, exit_code, signal, total_bytes, bytes_written, head_discarded_bytes,
				        output_capped, last_output_at, runtime_ms, ended_at, killed_reason, warnings,
				        tail_b64, tail_start
				 FROM command WHERE command_id = ?`,
				id,
			)
			.toArray()
		if (!prevRows.length) {
			// A chunk for a command this object has never heard of. The runner is
			// clearly alive, which is worth recording; there is nothing else to do
			// with the bytes, and inventing a row would invent a command.
			this.mset("last_seen_at", now)
			return { ok: true }
		}
		const prev = prevRows[0]

		// Every field below is merged against what is already stored, because a
		// redelivered chunk is normal: start_byte is a dedupe key, not a sequence
		// number. An older duplicate must never lower total_bytes, erase a known
		// exit code, or replace a good tail with an empty one.
		const settled = prev.state === "exited" || prev.state === "killed"
		const state = settled ? String(prev.state) : body.state
		const terminal = isTerminal(state)
		const total = Math.max(numOr(prev.total_bytes, 0)!, Math.max(0, numOr(body.total_bytes, 0)!))
		const reported = numOr(body.bytes_written, null)
		const written = reported === null ? numOr(prev.bytes_written, null) : Math.max(numOr(prev.bytes_written, 0)!, reported)

		// killed_reason is merged in JS, not in SQL. The old COALESCE(?, ...) kept
		// whichever reason arrived first, and the runner reports in the order the
		// operating system reveals things rather than in order of explanatory
		// power, so a full disk got recorded as an inactivity timeout. See
		// PRIORITY in kill-reason.ts.
		const picked = pickKilledReason(prev.killed_reason, body.killed_reason ?? null)

		// agent_error is the runner's own account of a command that never got as
		// far as running: a shell that is not installed, a cwd it could not create,
		// a spawn that threw. It used to be accepted here and then dropped on the
		// floor, so the tool result was state:"lost" with zero bytes and no reason
		// anywhere -- the single hardest thing to diagnose from the client side,
		// and worse than useless because `lost` reads as "retrying might work".
		// Merging it into the row's warnings is enough: readWindow already returns
		// them as command_warnings and execResult already reports those, so every
		// later re-read explains itself too.
		const agentError =
			typeof body.agent_error === "string" && body.agent_error.trim() ? body.agent_error.trim() : null
		const warnings = mergeWarnings(
			prev.warnings,
			body.warnings ?? null,
			picked.warning,
			agentError ? `the runner could not run this command: ${agentError}` : null,
		)

		// The tail is rewritten only when there is something better to write. A
		// redelivered terminal chunk arriving after the isolate restarted has an
		// empty ring behind it and must not erase what an earlier one persisted.
		let tailB64 = prev.tail_b64 === null || prev.tail_b64 === undefined ? null : String(prev.tail_b64)
		let tailStart = numOr(prev.tail_start, null)
		if (terminal && ring && ring.bytes.length > 0) {
			const t = tailOf(ring)
			tailB64 = b64encode(t.bytes)
			tailStart = t.start
		}

		this.sql.exec(
			`UPDATE command SET state = ?, exit_code = ?, signal = ?, total_bytes = ?, bytes_written = ?,
			   head_discarded_bytes = ?, output_capped = ?, last_output_at = ?, runtime_ms = ?, ended_at = ?,
			   killed_reason = ?, warnings = ?, tail_b64 = ?, tail_start = ?
			 WHERE command_id = ?`,
			state,
			numOr(body.exit_code, numOr(prev.exit_code, null)),
			body.signal ?? (prev.signal ? String(prev.signal) : null),
			total,
			written,
			Math.max(numOr(prev.head_discarded_bytes, 0)!, ring ? ring.discarded : 0),
			numOr(prev.output_capped, 0) === 1 || body.output_capped ? 1 : 0,
			incoming.length ? now : numOr(prev.last_output_at, null),
			numOr(body.runtime_ms, numOr(prev.runtime_ms, null)),
			numOr(prev.ended_at, terminal ? now : null),
			picked.reason,
			warnings,
			tailB64,
			tailStart,
			id,
		)
		if (terminal) this.sql.exec(`DELETE FROM queue WHERE command_id = ?`, id)
		if (body.cwd_after) this.mset("sticky_cwd", body.cwd_after)
		if (body.disk_free_mb !== null && body.disk_free_mb !== undefined) {
			this.mset("disk_free_mb", body.disk_free_mb)
		}
		this.mset("last_seen_at", now)
		return { ok: true }
	}

	private gcPulls() {
		const cutoff = Date.now() - PULL_TTL_MS
		for (const [k, v] of this.pulls) if (v.at < cutoff) this.pulls.delete(k)
	}

	async requestPull(command_id: string, from_byte: number, max_bytes: number): Promise<{ req_id: string }> {
		const req_id = crypto.randomUUID()
		this.actions.push({ type: "pull", req_id, command_id, from_byte, max_bytes })
		return { req_id }
	}

	async takePull(req_id: string): Promise<any | null> {
		const v = this.pulls.get(req_id)
		if (!v) return null
		this.pulls.delete(req_id)
		return {
			start: v.start,
			bytes_b64: b64encode(v.bytes),
			total: v.total,
			state: v.state,
			error: v.error,
		}
	}

	/**
	 * Read a byte window of the raw stream.
	 *
	 * Raw is the point: nothing is stripped, held back or repaired here. The cut
	 * happens exactly once, later, in the broker. Two cut sites would mean the
	 * same {from_byte, max_bytes} could answer differently on a re-read, and
	 * re-reading after an MCP timeout is the whole recovery story.
	 */
	async window(command_id: string, from_byte: number, max_bytes: number): Promise<WindowResult> {
		this.init()
		const rows = this.sql.exec(`SELECT * FROM command WHERE command_id = ?`, command_id).toArray()
		if (!rows.length) return emptyWindow(from_byte)
		const row = rows[0]

		const ring = this.rings.get(command_id)
		const ringCanServe = !!ring && from_byte >= ring.start && from_byte - ring.start <= ring.bytes.length
		let tail: { start: number; bytes: Uint8Array } | null = null
		if (!ringCanServe && row.tail_start !== null && row.tail_start !== undefined) {
			tail = { start: Number(row.tail_start) || 0, bytes: b64decode(String(row.tail_b64 || "")) }
		}
		const lastSeen = this.mnum("last_seen_at", null)
		const runnerGone = lastSeen === null || Date.now() - lastSeen > RUNNER_GONE_MS

		return readWindow(row, { ring, tail, runnerGone }, from_byte, max_bytes)
	}

	async killCommand(command_id: string, signal: "TERM" | "KILL"): Promise<{ killed: string[] }> {
		this.init()
		this.actions.push({ type: "kill", command_id, signal })
		if (command_id === "all") {
			const rows = this.sql
				.exec(`SELECT command_id FROM command WHERE state IN ('queued','running')`)
				.toArray()
			return { killed: rows.map((r) => String(r.command_id)) }
		}
		return { killed: [command_id] }
	}

	async setOverlay(content: string): Promise<{ overlay_version: number }> {
		const next = (this.mnum("overlay_version", 0) || 0) + 1
		this.mset("overlay_version", next)
		this.mset("overlay_preview", content.replace(/=(.*)$/gm, "=***"))
		this.actions.push({ type: "overlay", content })
		return { overlay_version: next }
	}

	/* --------------------------------------------------------------- status */

	async snapshot(verbose: boolean): Promise<Record<string, unknown>> {
		this.init()
		return buildSnapshot(this.sql, verbose)
	}

	async liveness(): Promise<{ state: string; last_seen_ms_ago: number | null; run_id: string | null }> {
		const lastSeen = this.mnum("last_seen_at", null)
		return {
			state: this.mget("state") || "lost",
			last_seen_ms_ago: lastSeen === null ? null : Date.now() - lastSeen,
			run_id: this.mget("run_id"),
		}
	}
}
