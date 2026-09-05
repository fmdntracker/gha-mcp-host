/*
 * The result contract every tool returns, and the timing primitives every
 * polling loop uses.
 *
 * Two rules shape this file:
 *
 *  - withCap() never rejects. A tool that hits its cap must still return a
 *    well-formed tool result, because a rejection surfaces to the client as
 *    "MCP error -32001: Request timed out" -- the exact failure this project
 *    exists to eliminate. Returning a partial answer with a command_id in it
 *    is always better than returning nothing with no way to resume.
 *
 *  - The error taxonomy is two fields, an `on_error` verb plus a strict
 *    boolean `retryable`, rather than one tri-state. `retryable: null` is
 *    indistinguishable from a missing key once it has been through JSON, and
 *    a caller that cannot tell those apart will guess.
 */

/** Absolute ceiling for any single tool call. The client gives up around 60s. */
export const HARD_CAP_MS = 55_000
/** Leave room to serialise and ship the response. */
export const SOFT_CAP_MS = 45_000

export type OnError = "retry" | "stop" | "reexecute_unsafe" | "ask_user"

export type CommonTail = {
	ok: boolean
	/** What the caller should do next. `retryable` is true if and only if this is "retry". */
	on_error: OnError | null
	retryable: boolean
	retry_after_ms: number | null
	warnings: string[]
	hint: string | null
	next_action: string | null
}

const RETRYABLE_CODES = new Set([
	"broker_unreachable",
	"broker_internal",
	"runner_busy_queue_full",
	"enroll_race",
	"github_5xx",
	"github_secondary_rate_limit",
	"do_unavailable",
])

const STOP_CODES = new Set([
	"account_suspended",
	"bad_input",
	"env_not_found",
	"env_expired",
	"platform_unavailable",
	"shell_unavailable",
	"rate_capped",
	"unauthorized",
])

const REEXECUTE_CODES = new Set(["lost", "spawn_gap"])

export function onErrorFor(code: string): OnError {
	if (RETRYABLE_CODES.has(code)) return "retry"
	if (REEXECUTE_CODES.has(code)) return "reexecute_unsafe"
	if (STOP_CODES.has(code)) return "stop"
	return "stop"
}

export function tail(partial: Partial<CommonTail> & { ok: boolean }): CommonTail {
	const on_error = partial.on_error ?? null
	return {
		ok: partial.ok,
		on_error,
		retryable: on_error === "retry",
		retry_after_ms: partial.retry_after_ms ?? null,
		warnings: partial.warnings ?? [],
		hint: partial.hint ?? null,
		next_action: partial.next_action ?? null,
	}
}

export function ok<T extends Record<string, unknown>>(
	fields: T,
	opts: Partial<CommonTail> = {},
): T & CommonTail {
	return { ...fields, ...tail({ ...opts, ok: true, on_error: null }) }
}

export function fail(
	code: string,
	message: string,
	opts: Partial<CommonTail> & { extra?: Record<string, unknown> } = {},
): Record<string, unknown> & CommonTail {
	const on_error = opts.on_error ?? onErrorFor(code)
	return {
		error: { code, message },
		...(opts.extra ?? {}),
		...tail({ ...opts, ok: false, on_error }),
	}
}

/**
 * Sleep, resolving early if `signal` aborts.
 *
 * Resolving rather than rejecting is intentional: callers use this inside
 * `while (await dl.tick(...))` loops, and an exception there would unwind past
 * the code that turns a partial read into a usable tool result.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return new Promise((r) => setTimeout(r, ms))
	if (signal.aborted) return Promise.resolve()
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout>
		const finish = () => {
			clearTimeout(timer)
			signal.removeEventListener("abort", finish)
			resolve()
		}
		timer = setTimeout(finish, ms)
		signal.addEventListener("abort", finish, { once: true })
	})
}

export function clamp(n: number, lo: number, hi: number): number {
	if (!Number.isFinite(n)) return lo
	return Math.max(lo, Math.min(hi, n))
}

export function numArg(v: unknown, d: number): number {
	const n = Number(v)
	return Number.isFinite(n) ? n : d
}

/**
 * Run `work`, but never let the caller wait past `ms`. On timeout -- or on
 * abort -- the fallback value is returned; the underlying work keeps running
 * server-side, which is exactly what we want for a command that is still
 * executing on the runner.
 */
export async function withCap<T>(
	work: Promise<T>,
	ms: number,
	fallback: () => T,
	signal?: AbortSignal,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	let onAbort: (() => void) | undefined
	const capped = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(fallback()), Math.max(1, ms))
		if (signal) {
			if (signal.aborted) {
				resolve(fallback())
				return
			}
			onAbort = () => resolve(fallback())
			signal.addEventListener("abort", onAbort, { once: true })
		}
	})
	try {
		return await Promise.race([work, capped])
	} finally {
		if (timer) clearTimeout(timer)
		if (signal && onAbort) signal.removeEventListener("abort", onAbort)
	}
}

/**
 * A deadline that every polling loop in this Worker must respect.
 *
 * An aborted signal counts as expired. That is the whole mechanism by which a
 * disconnected client stops costing us Durable Object round trips: the loop
 * condition goes false on the next iteration instead of running to the cap.
 */
export class Deadline {
	readonly at: number
	private readonly signal?: AbortSignal

	constructor(ms: number, signal?: AbortSignal) {
		this.at = Date.now() + ms
		this.signal = signal
	}

	get remaining(): number {
		return this.at - Date.now()
	}

	get aborted(): boolean {
		return this.signal?.aborted === true
	}

	get expired(): boolean {
		return this.remaining <= 0 || this.aborted
	}

	/** Sleep, but never past the deadline. Returns false once the deadline is gone. */
	async tick(ms: number): Promise<boolean> {
		if (this.expired) return false
		await sleep(Math.min(ms, this.remaining), this.signal)
		return !this.expired
	}
}

/**
 * The cadence of a loop that is waiting for something to show up in a Durable
 * Object.
 *
 * Every iteration of such a loop is one billed DO request, so a flat interval
 * makes the cost of *waiting* proportional to how long the client is willing
 * to wait -- which is backwards. A 20s park at one request per second is 22
 * requests to learn that nothing happened, and on 2026-09-04 that arithmetic
 * turned a mostly idle environment into 106,857 DO requests in a day against
 * a free-tier ceiling of 100,000.
 *
 * The shape is the runner's tail clock (lib/clock.mjs) applied to the other
 * side of the wire: poll fast at first, because the common case is work that
 * arrives just after the loop parks, then relax geometrically to a ceiling,
 * because a queue that has been empty for ten seconds is unlikely to be
 * filled in the next 250ms. The floor bounds dispatch latency; the ceiling
 * bounds cost. Callers that care about latency pass a lower ceiling rather
 * than a lower floor.
 */
export const POLL_MIN_MS = 250
export const POLL_MAX_MS = 5_000

export type PollClock = {
	/** How long to sleep before the next round trip. Grows on every call. */
	next: () => number
	/** Something arrived: drop back to the floor. */
	reset: () => void
}

export function makePollClock(
	minMs: number = POLL_MIN_MS,
	maxMs: number = POLL_MAX_MS,
	factor = 2,
): PollClock {
	const floor = clamp(minMs, 1, maxMs)
	let ms = floor
	return {
		next(): number {
			const cur = ms
			ms = clamp(Math.round(ms * factor), floor, maxMs)
			return cur
		},
		reset(): void {
			ms = floor
		},
	}
}

/**
 * Guard against proxies and captive portals that answer 200 with an HTML body.
 *
 * The MCP lane no longer needs this -- the SDK owns parsing there -- but
 * /agent/:env_id/chunk is a plain POST from a runner sitting behind whatever
 * network GitHub gave it, and a 200 with an HTML body must not be parsed as a
 * chunk and silently acknowledged.
 */
export function isJsonPayload(contentType: string | null, body: string): boolean {
	if (contentType && contentType.includes("application/json")) return true
	const t = body.trimStart()
	return t.startsWith("{") || t.startsWith("[")
}
