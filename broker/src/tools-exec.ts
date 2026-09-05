import type { BrokerConfig } from "./config"
import type { ToolDef } from "./mcp"
import { Deadline, SOFT_CAP_MS, clamp, fail, makePollClock, numArg, ok } from "./result"
import { ExecInput, ExecKillInput, ExecReadInput, type ExecArgs, type ExecKillArgs, type ExecReadArgs } from "./schemas"
import {
	type Bindings,
	type PollError,
	type ReturnedBecause,
	envStub,
	execResult,
	platformOf,
	sha256Hex,
	tryCall,
} from "./tools-shared"

const TERMINAL = new Set(["exited", "killed", "lost"])

/*
 * Cadence for the window probes in this lane.
 *
 * Every probe is one billed Durable Object request, and every probe re-reads
 * the SAME window -- only the last one shapes the answer. The ones in between
 * exist solely to notice an exit or a quiet period early. At a flat 300ms that
 * was ~66 requests to produce one result, and two idle long-polls plus this
 * lane put 106,857 requests on a 100,000/day free-tier ceiling in one day.
 *
 * The floor is lower than the old flat rate, so a short command still comes
 * back fast; the ceiling is what bounds the cost of waiting. The trade is that
 * an exit is noticed up to the ceiling late, which only ever delays a return
 * the deadline was already going to allow.
 */
const WINDOW_POLL_MIN_MS = 200
const WINDOW_POLL_MAX_MS = 2_000

export function buildExecTools(env: Bindings, cfg: BrokerConfig): ToolDef[] {
	/* ------------------------------------------------------------------ exec */
	const exec: ToolDef = {
		name: "exec",
		title: "Run a shell command",
		description:
			"Start a command and return as soon as it exits, goes quiet, or the deadline passes -- whichever comes first. " +
			"This never blocks to completion, so a 40-minute build is normal: you get a command_id and resume with exec_read. " +
			"Output comes back as text with ANSI escapes stripped, addressed by byte offset into the runner's raw output, so re-reading the same offset always returns the same thing. " +
			"cwd persists between calls in the same environment. " +
			"For binary output, base64 it inside the command -- env_status(verbose) returns the right recipe per platform. " +
			"Note: writing to $GITHUB_PATH or $GITHUB_ENV has no effect here; use the env argument, or export inside a single command.",
		inputSchema: ExecInput,
		async handler(args: ExecArgs, ctx) {
			const envId = args.env_id
			const command = args.command
			const platform = platformOf(envId)
			const stub = envStub(env, envId)

			const snap = await stub.snapshot(false)
			if (!snap.env_id) return fail("env_not_found", `no environment ${envId}`, { next_action: "env_list" })
			if (snap.state === "provisioning") {
				return fail("enroll_race", "the runner has not enrolled yet", {
					retry_after_ms: 3000,
					next_action: `env_status(env_id: "${envId}", wait_ready_ms: 45000)`,
				})
			}
			if (snap.state !== "ready") {
				return fail(snap.state === "expired" ? "env_expired" : "env_not_found", `environment is ${snap.state}`, {
					extra: { failure_reason: snap.failure_reason ?? null },
					next_action: "env_create",
				})
			}

			// A shell this runner does not have is a PERMANENT condition, so it is
			// refused here instead of being queued. The runner refuses it too, but its
			// only channel for saying so is a failed command, which arrives as
			// state:"lost" -- and `lost` reads as "retrying might work", so a client
			// that believes it loops forever. facts.shells is empty only when the
			// runner enrolled without publishing them, and then every shell has to be
			// allowed rather than guessed at.
			if (args.shell) {
				const probe = await tryCall(() => stub.shellsAvailable())
				const shells = (probe.value || {}) as Record<string, unknown>
				const names = Object.keys(shells)
				if (names.length && !shells[args.shell]) {
					const present = names.filter((k) => shells[k])
					return fail(
						"bad_input",
						`shell '${args.shell}' is not installed on this ${platform} runner (present: ${present.join(", ") || "none"})`,
						{
							hint: "No fallback is attempted by design, so retrying cannot help. Use one of the shells listed above, or call env_status(verbose: true) to see them with versions.",
							next_action: present.length
								? `exec(env_id: "${envId}", command: ..., shell: "${present[0]}")`
								: `env_status(env_id: "${envId}", verbose: true)`,
						},
					)
				}
			}

			const warnings: string[] = [...((snap.warnings as string[]) || [])]
			const maxBytes = clamp(numArg(args.max_bytes, 65536), 1024, 262144)
			const deadlineMs = clamp(numArg(args.deadline_ms, 20000), 1000, 45000)
			const idleReturnMs = clamp(numArg(args.idle_return_ms, 1500), 200, 30000)

			let timeoutS = clamp(numArg(args.timeout_s, 3600), 1, 21600)
			const ttlRemaining = Number(snap.ttl_remaining_s || 0)
			if (timeoutS > ttlRemaining - 30) {
				const clamped = Math.max(1, ttlRemaining - 30)
				warnings.push(
					`timeout_s clamped from ${timeoutS}s to ${clamped}s because the lease has ${ttlRemaining}s left; call env_extend if the job needs longer`,
				)
				timeoutS = clamped
			}

			// Stringified before hashing so {PORT: 8080} and {PORT: "8080"} dedupe
			// against each other instead of running the same command twice.
			const envVars = args.env
				? Object.fromEntries(Object.entries(args.env).map(([k, v]) => [k, String(v)]))
				: null

			const commandId = crypto.randomUUID().replace(/-/g, "").slice(0, 16)
			const idemHash = args.allow_duplicate
				? `nodedupe:${commandId}`
				: args.idempotency_key
					? `key:${args.idempotency_key}`
					: await sha256Hex(
							JSON.stringify([envId, command, args.cwd ?? null, envVars, args.stdin_b64 ?? null]),
						)

			const payload = {
				command_id: commandId,
				command,
				shell: args.shell ?? null,
				cwd: args.cwd ?? null,
				env: envVars,
				stdin_b64: args.stdin_b64 ?? null,
				timeout_s: timeoutS,
				inactivity_kill_s: clamp(numArg(args.inactivity_kill_s, 0), 0, 21600),
				max_output_bytes: cfg.defaultMaxOutputBytes,
				keep_raw: Boolean(args.keep_raw),
			}

			const enq = await stub.enqueue({
				command_id: commandId,
				idem_hash: idemHash,
				payload,
				label: args.label ? args.label.slice(0, 64) : null,
				cwd: args.cwd ?? null,
				shell: payload.shell,
				maxQueue: 8,
				idemWindowMs: deadlineMs + 60_000,
			})

			if (!enq.ok) {
				return fail(
					"runner_busy_queue_full",
					`the runner already has ${enq.queue_depth} commands queued (max ${enq.max_queue})`,
					{
						retry_after_ms: 2000,
						hint: "being busy is not an error; wait for one to finish or create a second environment",
						next_action: "exec_read on an earlier command_id",
					},
				)
			}
			if (enq.deduped) {
				warnings.push("an identical command was already submitted; returning that one instead of running it twice")
			}

			const effectiveId = enq.command_id
			const dl = new Deadline(Math.min(deadlineMs, SOFT_CAP_MS), ctx.signal)
			const clock = makePollClock(WINDOW_POLL_MIN_MS, WINDOW_POLL_MAX_MS)
			const started = Date.now()
			let w: any = null
			let pollError: PollError = null
			let because: ReturnedBecause = "deadline"

			for (;;) {
				const r = await tryCall(() => stub.window(effectiveId, 0, maxBytes))
				if (r.value) {
					w = r.value
					pollError = null
				} else {
					pollError = r.pollError
				}
				if (w && TERMINAL.has(w.state)) {
					because = "exit"
					break
				}
				if (w?.truncated) {
					because = "cap"
					break
				}
				const elapsed = Date.now() - started
				const quiet = w?.last_output_at ? Date.now() - w.last_output_at : elapsed
				// The >3s floor stops a command that simply has not printed anything
				// yet from being reported as "idle" 200ms in.
				if (elapsed > 3000 && quiet >= idleReturnMs && w?.state === "running") {
					because = "idle"
					break
				}
				ctx.note(w?.state === "queued" ? "queued behind another command" : "command running")
				if (!(await dl.tick(clock.next()))) {
					because = w?.state === "queued" ? "queued" : "deadline"
					break
				}
			}

			return execResult({
				commandId: effectiveId,
				envId,
				platform,
				w,
				returnedBecause: because,
				pollError,
				warnings,
				deduped: enq.deduped,
				queuePosition: enq.queue_position,
				queueDepth: enq.queue_depth,
				overlayVersion: enq.overlay_version,
				runnerGone: Number(snap.last_seen_ms_ago ?? 0) > 120_000,
				stickyCwd: (snap.sticky_cwd as string) ?? null,
			})
		},
	}

	/* ------------------------------------------------------------- exec_read */
	const execRead: ToolDef = {
		name: "exec_read",
		title: "Read more output / wait for exit",
		description:
			"Resume a command's output from a byte offset, optionally waiting. This is where long waits belong: " +
			"until 'exit' waits up to wait_ms for the command to finish, until 'any_output' returns as soon as there is anything new. " +
			"Returns exactly the same fields as exec. Loop with from_byte = next_byte until eof is true. " +
			"Re-reading an offset you have already read is always safe and always returns the same bytes, which is what makes this recoverable after a client-side timeout.",
		inputSchema: ExecReadInput,
		readOnly: true,
		async handler(args: ExecReadArgs, ctx) {
			const envId = args.env_id
			const commandId = args.command_id
			const platform = platformOf(envId)
			const stub = envStub(env, envId)

			const snap = await stub.snapshot(false)
			if (!snap.env_id) return fail("env_not_found", `no environment ${envId}`, { next_action: "env_list" })

			const fromByte = Math.max(0, numArg(args.from_byte, 0))
			const maxBytes = clamp(numArg(args.max_bytes, 65536), 1024, 262144)
			const waitMs = clamp(numArg(args.wait_ms, 20000), 0, 45000)
			const until = args.until === "exit" ? "exit" : "any_output"
			const warnings: string[] = [...((snap.warnings as string[]) || [])]

			const dl = new Deadline(Math.min(waitMs, SOFT_CAP_MS), ctx.signal)
			const clock = makePollClock(WINDOW_POLL_MIN_MS, WINDOW_POLL_MAX_MS)
			let w: any = null
			let pollError: PollError = null
			let because: ReturnedBecause = "deadline"
			let pulled = false

			for (;;) {
				const r = await tryCall(() => stub.window(commandId, fromByte, maxBytes))
				if (r.value) {
					w = r.value
					pollError = null
				} else {
					pollError = r.pollError
				}
				if (w && !w.found) {
					return fail("bad_input", `no command ${commandId} in ${envId}`, {
						next_action: `env_status(env_id: "${envId}")`,
					})
				}

				// The broker cannot reach the runner inbound, so an evicted range is
				// fetched by queuing a pull on the control channel the runner is
				// already parked on -- it arrives in milliseconds.
				if (w?.range_evicted && !pulled) {
					pulled = true
					ctx.note("re-serving an evicted range from the runner")
					const { req_id } = await stub.requestPull(commandId, fromByte, maxBytes)
					const pullDl = new Deadline(Math.min(15000, Math.max(2000, dl.remaining)), ctx.signal)
					const pullClock = makePollClock(150, 1_000)
					for (;;) {
						const got = await stub.takePull(req_id)
						if (got) {
							// Only the payload and its offset are replaced. next_byte is
							// not computed here: execResult derives it from the bytes
							// safeCut actually consumed, which is the one cut site.
							w = { ...w, bytes_b64: got.bytes_b64, start_byte: got.start, range_evicted: false }
							warnings.push("this range was re-served from the runner's own output file")
							break
						}
						if (!(await pullDl.tick(pullClock.next()))) {
							warnings.push("the runner did not answer the range request in time; retry exec_read")
							pollError = { code: "broker_unreachable", message: "range pull timed out", retryable: true }
							break
						}
					}
				}

				const terminal = Boolean(w && TERMINAL.has(w.state))
				const haveBytes = Boolean(w?.bytes_b64)
				if (terminal && (until === "exit" || haveBytes || w.eof)) {
					because = "exit"
					break
				}
				if (until === "any_output" && haveBytes) {
					because = w?.truncated ? "cap" : "idle"
					break
				}
				ctx.note(until === "exit" ? "waiting for the command to exit" : "waiting for output")
				if (!(await dl.tick(clock.next()))) {
					because = w?.state === "queued" ? "queued" : "deadline"
					break
				}
			}

			if (until === "exit" && because === "deadline") {
				// Honest about the one thing this contract cannot distinguish.
				warnings.push(
					"waited for exit and it has not happened yet. A healthy long build and a stuck command look identical from here -- check idle_seconds and the tail of the output before assuming progress.",
				)
			}

			return execResult({
				commandId,
				envId,
				platform,
				w,
				returnedBecause: because,
				pollError,
				warnings,
				deduped: false,
				queuePosition: 0,
				queueDepth: Number(snap.queue_depth || 0),
				overlayVersion: Number(snap.overlay_version || 0),
				runnerGone: Number(snap.last_seen_ms_ago ?? 0) > 120_000,
				stickyCwd: (snap.sticky_cwd as string) ?? null,
			})
		},
	}

	/* ------------------------------------------------------------- exec_kill */
	const execKill: ToolDef = {
		name: "exec_kill",
		title: "Kill a command",
		description:
			"Kill one command_id or 'all'. Kills the whole process tree, so a build that spawned children does not leave orphans behind holding the runner's stdout open.",
		inputSchema: ExecKillInput,
		async handler(args: ExecKillArgs, ctx) {
			const envId = args.env_id
			const commandId = args.command_id
			const signal = args.signal ?? "TERM"

			const stub = envStub(env, envId)
			const { killed } = await stub.killCommand(commandId, signal)

			// The kill rides the control long-poll, which is parked, so confirmation
			// normally arrives within a second or two.
			const dl = new Deadline(12000, ctx.signal)
			const clock = makePollClock(300, WINDOW_POLL_MAX_MS)
			let state: string | null = null
			let exitCode: number | null = null
			if (commandId !== "all") {
				for (;;) {
					const r = await tryCall(() => stub.window(commandId, 0, 1024))
					state = r.value?.state ?? state
					exitCode = r.value?.exit_code ?? exitCode
					if (state && TERMINAL.has(state)) break
					ctx.note("waiting for the command to report termination")
					if (!(await dl.tick(clock.next()))) break
				}
			}

			// 'all' is accepted here but it is not a command_id, so echoing it back as
			// an exec_read suggestion sends the caller to a command that cannot be
			// found. Name one that was actually killed instead.
			const readId: string | null = commandId === "all" ? (killed?.[0] ?? null) : commandId

			return ok(
				{ env_id: envId, killed, state: state ?? "killed", exit_code: exitCode, tree_killed: true, signal },
				{
					warnings:
						state && !TERMINAL.has(state) && commandId !== "all"
							? ["the kill was delivered but the command has not reported termination yet; check with exec_read"]
							: [],
					next_action: readId
						? `exec_read(env_id: "${envId}", command_id: "${readId}", from_byte: 0)`
						: `env_status(env_id: "${envId}", verbose: true)`,
				},
			)
		},
	}

	return [exec, execRead, execKill]
}
