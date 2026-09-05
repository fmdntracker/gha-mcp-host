import { b64encode } from "./bytes"
import { isTerminal, type CmdState } from "./env-schema"
import { sliceRing, type Ring } from "./ring"

/**
 * One read of a command's output, as it leaves the Durable Object.
 *
 * These are raw bytes and they are never cut here. ANSI stripping, UTF-8
 * boundary repair and the partial-line hold all happen exactly once, at broker
 * read time, in renderWindow() -- see the INVARIANTS block in bytes.ts. A second
 * cut site would make a re-read of the same {start_byte, max_bytes} return a
 * different number of bytes than the first read did, and idempotent re-reads are
 * the one property the whole 60-second-timeout design rests on.
 *
 * There is deliberately no next_byte and no partial_line_dropped: both are
 * consequences of the cut, so both belong to whoever performs it.
 */
export type WindowResult = {
	found: boolean
	state: CmdState | null
	exit_code: number | null
	runtime_ms: number | null
	total_bytes: number
	/** Bytes the runner has written to out.raw. Ahead of total_bytes in flight. */
	bytes_written: number | null
	last_output_at: number | null
	started_at: number | null
	cwd: string | null
	shell: string | null
	killed_reason: string | null
	command_warnings: string[]
	bytes_b64: string
	/** Where these bytes actually start, which is not always what was asked for. */
	start_byte: number
	eof: boolean
	truncated: boolean
	range_evicted: boolean
	available_from_byte: number
	/** Bytes this window skipped past because nothing can serve them any more. */
	head_discarded_bytes: number
	output_capped: boolean
}

export function emptyWindow(fromByte: number): WindowResult {
	return {
		found: false,
		state: null,
		exit_code: null,
		runtime_ms: null,
		total_bytes: 0,
		bytes_written: null,
		last_output_at: null,
		started_at: null,
		cwd: null,
		shell: null,
		killed_reason: null,
		command_warnings: [],
		bytes_b64: "",
		start_byte: fromByte,
		eof: false,
		truncated: false,
		range_evicted: false,
		available_from_byte: 0,
		head_discarded_bytes: 0,
		output_capped: false,
	}
}

export type WindowSources = {
	/** The live cache, if this isolate still has one. */
	ring?: Ring
	/** The tail persisted when the command reached a terminal state. */
	tail?: { start: number; bytes: Uint8Array } | null
	/**
	 * The runner can no longer be asked to re-serve a range. Only then is the
	 * persisted tail better than reporting the range as evicted, because only then
	 * is there nothing left to wait for.
	 */
	runnerGone: boolean
}

function n(v: unknown): number | null {
	if (v === null || v === undefined) return null
	const x = Number(v)
	return Number.isFinite(x) ? x : null
}

function parseWarnings(v: unknown): string[] {
	if (typeof v !== "string" || !v) return []
	try {
		const parsed = JSON.parse(v)
		return Array.isArray(parsed) ? parsed.filter((w) => typeof w === "string") : []
	} catch {
		return [v]
	}
}

export function readWindow(
	row: any,
	sources: WindowSources,
	fromByte: number,
	maxBytes: number,
): WindowResult {
	const total = Math.max(0, n(row.total_bytes) ?? 0)
	const state = String(row.state) as CmdState
	const terminal = isTerminal(state)
	const ring = sources.ring
	const tail = sources.tail || null

	let start = fromByte
	// Annotated, not inferred: new Uint8Array(0) is Uint8Array<ArrayBuffer>, and
	// the views handed back by sliceRing() and subarray() are
	// Uint8Array<ArrayBufferLike>, which is wider. Without this the three
	// assignments below do not typecheck.
	let bytes: Uint8Array = new Uint8Array(0)
	let rangeEvicted = false
	let headDiscarded = 0

	const fromRing = ring ? sliceRing(ring, fromByte, maxBytes) : null
	if (fromRing) {
		bytes = fromRing
	} else if (fromByte >= total) {
		// Caught up. Not an error, and not eof unless the command is finished.
	} else if (tail && fromByte >= tail.start) {
		const offset = fromByte - tail.start
		bytes = tail.bytes.subarray(offset, Math.min(tail.bytes.length, offset + maxBytes))
	} else if (tail && terminal && sources.runnerGone) {
		// Everything before the tail is gone for good: the ring died with the
		// isolate and the runner is no longer there to re-serve it. Skip forward
		// rather than send the reader off to pull a range nobody will answer, and
		// say exactly how much was skipped so the gap is never silent.
		start = tail.start
		headDiscarded = tail.start - fromByte
		bytes = tail.bytes.subarray(0, Math.min(tail.bytes.length, maxBytes))
	} else {
		rangeEvicted = true
	}

	const end = start + bytes.length
	return {
		found: true,
		state,
		exit_code: n(row.exit_code),
		runtime_ms: n(row.runtime_ms),
		total_bytes: total,
		bytes_written: n(row.bytes_written),
		// A command that has produced nothing has no last_output_at, and reporting
		// null there would make idle_seconds read 0 for exactly the command most
		// likely to be hung on input it will never get. Fall back to the spawn time.
		last_output_at: n(row.last_output_at) ?? n(row.started_at),
		started_at: n(row.started_at),
		cwd: row.cwd ? String(row.cwd) : null,
		shell: row.shell ? String(row.shell) : null,
		killed_reason: row.killed_reason ? String(row.killed_reason) : null,
		command_warnings: parseWarnings(row.warnings),
		bytes_b64: b64encode(bytes),
		start_byte: start,
		eof: terminal && end >= total,
		truncated: end < total,
		range_evicted: rangeEvicted,
		available_from_byte: ring ? ring.start : tail ? tail.start : total,
		head_discarded_bytes: headDiscarded,
		output_capped: (n(row.output_capped) ?? 0) === 1,
	}
}
