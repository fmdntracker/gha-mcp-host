/*
 * File primitives: file_read / file_write / file_edit.
 *
 * These are queue jobs, not a new transport. A file job is enqueued with
 * type:"file", claimed by the same exec worker, and its result comes back as
 * that job's one and only output chunk -- so window(), the ring buffer, the
 * pull path, kill and the redelivery rules all work unchanged, and the DO wire
 * contract does not move. Two consequences worth knowing:
 *
 *  - The queue is shared with exec. A file edit waits behind a running command
 *    and vice versa. That is the price of getting per-env serialisation for
 *    free, and serialisation is what stops our own tools from racing each other
 *    on the same path.
 *  - If we run out of deadline before the runner answers, the job is still a
 *    normal command: exec_read(command_id) resumes it. Nothing is lost, which
 *    is why timing out here is not reported as a failure.
 *
 * The typed error object is produced on the runner and passed through verbatim;
 * this file only maps its `retryable` verb onto the broker's on_error verb so
 * one taxonomy reaches the model.
 */

import { z } from "zod"

import type { BrokerConfig } from "./config"
import type { ToolDef } from "./mcp"
import { Deadline, SOFT_CAP_MS, clamp, fail, makePollClock, numArg, ok } from "./result"
import { type Bindings, envStub, platformOf, sha256Hex, tryCall } from "./tools-shared"

const TERMINAL = new Set(["exited", "killed", "lost"])

/** Window we ask the DO for. The runner keeps its result JSON under this. */
const RESULT_WINDOW_BYTES = 262_144
/** Ceiling on a single read, so the JSON envelope stays inside the window. */
const READ_MAX_BYTES = 131_072
/** Ceiling on base64 content, so one queue entry stays under the DO's 2MB. */
const WRITE_MAX_B64 = 700_000
const STR_MAX = 65_536

/*
 * Cadence for the result probe, same reasoning as WINDOW_POLL_* in
 * tools-exec.ts: each probe is a billed Durable Object request and only the
 * last one carries the answer. A file job is usually done in well under a
 * second, so the floor is what matters here and the ceiling only pays for
 * itself when the job is stuck behind a long-running command.
 */
const RESULT_POLL_MIN_MS = 200
const RESULT_POLL_MAX_MS = 2_000

// Mirrors ENV_ID_RE in schemas.ts. Kept local so adding file tools does not
// touch the exec schemas.
const EnvIdField = z
	.string()
	.regex(/^(linux|mac|win)-[0-9a-hjkmnp-tv-z]{8}$/, "env_id must look like linux-ab12cd34")
const PathField = z.string().min(1).max(4096)

export const FileReadInput = z.strictObject({
	env_id: EnvIdField,
	path: PathField,
	offset: z.number().optional(),
	limit: z.number().optional(),
	from_byte: z.number().optional(),
	max_bytes: z.number().optional(),
	deadline_ms: z.number().optional(),
})

export const FileWriteInput = z.strictObject({
	env_id: EnvIdField,
	path: PathField,
	content_b64: z.string(),
	base_sha: z.string().optional(),
	create_parents: z.boolean().optional(),
	deadline_ms: z.number().optional(),
})

export const FileEditInput = z.strictObject({
	env_id: EnvIdField,
	path: PathField,
	old_str: z.string().min(1),
	new_str: z.string(),
	expected_replacements: z.number().optional(),
	base_sha: z.string().optional(),
	deadline_ms: z.number().optional(),
})

/** The runner's 5 recovery verbs, mapped onto the broker's on_error verb. */
const ON_ERROR_FOR: Record<string, "retry" | "stop"> = {
	fix_args: "stop",
	reread: "stop",
	retry: "retry",
	wait: "retry",
	no: "stop",
}

function decodeJsonChunk(b64: string): Record<string, unknown> | null {
	try {
		const bin = atob(b64)
		const bytes = new Uint8Array(bin.length)
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
		const parsed = JSON.parse(new TextDecoder().decode(bytes))
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
	} catch {
		return null
	}
}

type JobArgs = Record<string, unknown>

async function submit(
	env: Bindings,
	envId: string,
	op: "read" | "write" | "edit",
	jobArgs: JobArgs,
	deadlineMsRaw: unknown,
	ctx: { signal: AbortSignal; note: (m: string) => void },
): Promise<Record<string, unknown>> {
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

	const warnings: string[] = [...((snap.warnings as string[]) || [])]
	const deadlineMs = clamp(numArg(deadlineMsRaw, 20000), 1000, 45000)
	const commandId = crypto.randomUUID().replace(/-/g, "").slice(0, 16)

	// write_id is derived from the arguments on the SERVER, not supplied by the
	// caller: an LLM that retries a write does not reliably resend the same id,
	// and it is exactly that retry we are trying to make idempotent. Identical
	// arguments therefore replay the recorded result instead of writing twice.
	const writeId = await sha256Hex(JSON.stringify([envId, op, jobArgs]))
	const mutating = op !== "read"

	const payload = { command_id: commandId, type: "file", op, write_id: writeId, ...jobArgs }

	const enq = await stub.enqueue({
		command_id: commandId,
		idem_hash: mutating ? `key:file:${writeId}` : `nodedupe:${commandId}`,
		payload,
		label: `file_${op}`,
		cwd: null,
		shell: null,
		maxQueue: 8,
		idemWindowMs: deadlineMs + 60_000,
	})
	if (!enq.ok) {
		return fail("runner_busy_queue_full", `the runner already has ${enq.queue_depth} jobs queued (max ${enq.max_queue})`, {
			retry_after_ms: 2000,
			hint: "file jobs share the queue with exec; wait for one to finish",
			next_action: "exec_read on an earlier command_id",
		})
	}
	if (enq.deduped) {
		warnings.push("an identical file job was already submitted; returning that one instead of applying it twice")
	}

	const effectiveId: string = enq.command_id
	const dl = new Deadline(Math.min(deadlineMs, SOFT_CAP_MS), ctx.signal)
	const clock = makePollClock(RESULT_POLL_MIN_MS, RESULT_POLL_MAX_MS)
	const started = Date.now()
	let w: any = null
	let pollErrorCode: string | null = null

	for (;;) {
		const r = await tryCall(() => stub.window(effectiveId, 0, RESULT_WINDOW_BYTES))
		if (r.value) {
			w = r.value
			pollErrorCode = null
		} else {
			pollErrorCode = r.pollError?.code ?? null
		}
		if (w && TERMINAL.has(w.state)) break
		ctx.note(w?.state === "queued" ? `file_${op} queued behind another job` : `file_${op} running`)
		if (!(await dl.tick(clock.next()))) break
	}

	const elapsedMs = Date.now() - started
	const common = { env_id: envId, command_id: effectiveId, platform, op, elapsed_ms: elapsedMs }

	if (!w || !TERMINAL.has(w.state)) {
		// Not a failure: the job is a normal queue entry and its result is readable
		// with exec_read. Saying "failed" here would invite a duplicate write.
		return ok(
			{ ...common, state: w?.state ?? "queued", still_running: true, queue_depth: Number(enq.queue_depth || 0), poll_error: pollErrorCode },
			{
				warnings: [
					...warnings,
					"the runner has not answered yet; the job is queued or in flight and has NOT been abandoned",
				],
				hint: "do not resubmit: resubmitting the same write is what duplicates content",
				next_action: `exec_read(env_id: "${envId}", command_id: "${effectiveId}", from_byte: 0, until: "exit")`,
			},
		)
	}

	if (w.state === "lost") {
		return fail("lost", "the runner died before reporting the result of this file job", {
			extra: { ...common, state: w.state, agent_error: w.agent_error ?? null },
			warnings,
			hint: mutating
				? "whether the write committed is unknown; read the file back before retrying"
				: null,
			next_action: `file_read(env_id: "${envId}", path: ...)`,
		})
	}

	const json = decodeJsonChunk(String(w.bytes_b64 || ""))
	if (!json) {
		return fail("broker_internal", "the runner's file result did not arrive as parseable JSON", {
			on_error: "retry",
			retry_after_ms: 1000,
			extra: { ...common, state: w.state, truncated: Boolean(w.truncated), bytes_returned: Number(w.total_bytes || 0) },
			warnings,
			hint: w.truncated ? "the result exceeded the window; lower max_bytes" : null,
			next_action: `exec_read(env_id: "${envId}", command_id: "${effectiveId}", from_byte: 0)`,
		})
	}

	if (json.ok === true) {
		const { ok: _ok, ...rest } = json
		return ok({ ...common, ...rest, state: w.state, runtime_ms: Number(w.runtime_ms ?? 0) }, { warnings })
	}

	const { ok: _bad, error, message, retryable, ...rest } = json
	const verb = ON_ERROR_FOR[String(retryable)] ?? "stop"
	return fail(String(error || "io_error"), String(message || "the file operation failed"), {
		on_error: verb,
		retry_after_ms: verb === "retry" ? 1000 : null,
		extra: { ...common, ...rest, retryable: undefined, state: w.state },
		warnings,
		hint:
			retryable === "reread"
				? "the file is not what you think it is; read it again and rebuild the edit from what it actually contains"
				: retryable === "retry"
					? "nothing was committed; sending the same content again is safe"
					: null,
		next_action: retryable === "reread" ? `file_read(env_id: "${envId}", path: ...)` : null,
	})
}

export function buildFileTools(env: Bindings, _cfg: BrokerConfig): ToolDef[] {
	const fileRead: ToolDef = {
		name: "file_read",
		title: "Read a text file",
		description:
			"Read a UTF-8 text file from the environment. Addressed two ways at once: `offset`/`limit` select lines (a negative offset reads the tail), " +
			"`from_byte`/`max_bytes` bound how much is transferred. Line numbers are never mixed into the text. " +
			"Returns base_sha, the sha256 of the whole file -- pass it back to file_write or file_edit and the write is refused if the file changed in between. " +
			"End of file is signalled by the ABSENCE of next_byte; while next_byte is present there is more to read. " +
			"Binary files and invalid UTF-8 are refused rather than mangled: base64 them through exec instead. " +
			"CRLF and a leading BOM are measured and reported, never silently normalised.",
		inputSchema: FileReadInput,
		readOnly: true,
		async handler(args, ctx) {
			const maxBytes = clamp(numArg(args.max_bytes, 65536), 1024, READ_MAX_BYTES)
			return submit(
				env,
				args.env_id,
				"read",
				{
					path: args.path,
					offset: numArg(args.offset, 0),
					limit: clamp(numArg(args.limit, 2000), 1, 100000),
					from_byte: Math.max(0, numArg(args.from_byte, 0)),
					max_bytes: maxBytes,
				},
				args.deadline_ms,
				ctx,
			)
		},
	}

	const fileWrite: ToolDef = {
		name: "file_write",
		title: "Write a file atomically",
		description:
			"Replace a file's contents. content_b64 is base64 so any byte sequence survives the trip. " +
			"The write is atomic: a temp file in the SAME directory is written, fsynced, chmod'd to the old file's mode, then renamed over the target. " +
			"A reader therefore sees either the whole old file or the whole new one, never a half-written file, and a crash mid-write leaves the original intact. " +
			"Pass base_sha from file_read to make this conditional: if the file changed since you read it the write is refused with sha_mismatch instead of overwriting someone else's change. " +
			"Retrying with identical arguments is safe -- the recorded result is replayed rather than applied twice. " +
			"Set create_parents to create missing directories. For files larger than the limit, write in pieces with exec, or use exec redirection.",
		inputSchema: FileWriteInput,
		async handler(args, ctx) {
			if (String(args.content_b64 || "").length > WRITE_MAX_B64) {
				return fail("bad_input", `content_b64 is longer than ${WRITE_MAX_B64} characters`, {
					hint: "one queue entry has to fit in the durable object; split the write or use exec with base64 -d",
					next_action: "exec",
				})
			}
			return submit(
				env,
				args.env_id,
				"write",
				{
					path: args.path,
					content_b64: args.content_b64,
					base_sha: args.base_sha ?? null,
					create_parents: Boolean(args.create_parents),
				},
				args.deadline_ms,
				ctx,
			)
		},
	}

	const fileEdit: ToolDef = {
		name: "file_edit",
		title: "Replace exact text in a file",
		description:
			"Replace old_str with new_str in a text file. Matching is EXACT and literal -- no regex, no fuzzy matching, no whitespace tolerance -- because a near miss that edits the wrong line is worse than a failure. " +
			"old_str must occur exactly expected_replacements times (default 1); any other count is refused and nothing is written, so ambiguity never silently picks a match. " +
			"Include enough surrounding context to make the match unique. " +
			"$& and $1 inside new_str are literal. CRLF line endings and a leading BOM are preserved. " +
			"The write-back is atomic (temp + rename in the same directory) and pass base_sha from file_read to refuse the edit if the file moved under you. " +
			"Retrying with identical arguments replays the recorded result instead of applying the edit twice.",
		inputSchema: FileEditInput,
		async handler(args, ctx) {
			if (String(args.old_str).length > STR_MAX || String(args.new_str).length > STR_MAX) {
				return fail("bad_input", `old_str and new_str must each be at most ${STR_MAX} characters`, {
					hint: "for a change this large, write the whole file with file_write",
					next_action: "file_write",
				})
			}
			return submit(
				env,
				args.env_id,
				"edit",
				{
					path: args.path,
					old_str: args.old_str,
					new_str: args.new_str,
					expected_replacements: clamp(numArg(args.expected_replacements, 1), 1, 10000),
					base_sha: args.base_sha ?? null,
				},
				args.deadline_ms,
				ctx,
			)
		},
	}

	return [fileRead, fileWrite, fileEdit]
}
