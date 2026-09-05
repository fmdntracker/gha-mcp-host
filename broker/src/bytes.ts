/**
 * Byte helpers and the read-time window transform.
 *
 * INVARIANTS -- read these before changing anything here.
 *
 * 1. Byte offsets are RAW offsets into the runner's `out.raw`. Nothing in this
 *    file may change them. `safeCut()` only decides how many raw bytes a
 *    window covers; `stripAnsi()` and the redactor change the rendered text
 *    and never the offsets. A rendered window's character length is therefore
 *    unrelated to `next_byte - start_byte`, and that is deliberate: it is what
 *    makes re-reading the same `{start_byte, len}` byte-identical after the
 *    client gives up with `MCP error -32001` and retries.
 *
 * 2. The cut happens at exactly ONE point in the system: here, at read time.
 *    The runner never cuts -- it pushes exact raw ranges at raw offsets. Two
 *    cut sites cannot be kept in agreement forever, and the moment they
 *    disagree, idempotent re-reads break. If you are tempted to pre-cut on the
 *    runner to save bandwidth, don't.
 *
 * 3. Stripping is applied per window, but `safeCut()` guarantees no window
 *    boundary falls inside an escape sequence (except the bounded `forcedSplit`
 *    case). That guarantee is the reason per-window stripping produces the same
 *    result as stripping the whole stream at once.
 */

/**
 * How far back `safeCut` will look for an unterminated escape sequence.
 *
 * Real terminals bound this far below 4 KiB: VTE caps string sequences at 4096
 * (VTE_SEQ_STRING_MAX_CAPACITY), alacritty at 1024 (MAX_OSC_RAW), and the OSC 8
 * hyperlink URI limit is 2083. Anything longer than this window is pathological
 * (a Sixel blob, say) and gets split rather than allowed to stall the reader.
 */
export const ANSI_LOOKBACK = 4096

/** A UTF-8 scalar is at most 4 bytes, so at most 3 trailing continuation bytes. */
const UTF8_MAX_TAIL = 3

/** Workers has btoa/atob but they are latin1-only, so chunk the conversion. */
export function b64encode(bytes: Uint8Array): string {
	let out = ""
	const step = 0x2000
	for (let i = 0; i < bytes.length; i += step) {
		out += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)))
	}
	return btoa(out)
}

export function b64decode(s: string): Uint8Array {
	if (!s) return new Uint8Array(0)
	const bin = atob(s)
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length)
	out.set(a, 0)
	out.set(b, a.length)
	return out
}

export type Cut = {
	/** How many leading bytes of the input this window may show. */
	end: number
	/** Bytes the writer has already produced that this window withholds. */
	heldBack: number
	/** True when a trailing partial line or partial escape was withheld. */
	partialLineDropped: boolean
	/**
	 * True when an escape sequence had to be split to guarantee the reader makes
	 * forward progress. Only reachable for sequences longer than ANSI_LOOKBACK,
	 * or when the window is smaller than the sequence it starts with.
	 */
	forcedSplit: boolean
}

/**
 * Is the escape sequence starting at `esc` fully contained in [esc, limit)?
 *
 * A malformed sequence counts as terminated: we are deciding where to cut, not
 * validating a terminal stream, and treating garbage as unterminated would let
 * one stray 0x1b hold the whole window back.
 */
function escapeTerminated(bytes: Uint8Array, esc: number, limit: number): boolean {
	if (esc + 1 >= limit) return false
	const kind = bytes[esc + 1]

	// OSC / DCS / SOS / PM / APC all carry a string terminated by BEL or ESC \.
	if (kind === 0x5d || kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) {
		for (let i = esc + 2; i < limit; i++) {
			if (bytes[i] === 0x07) return true
			if (bytes[i] === 0x1b) return i + 1 < limit && bytes[i + 1] === 0x5c
		}
		return false
	}

	// CSI: parameter bytes 0x30-0x3f, intermediates 0x20-0x2f, final 0x40-0x7e.
	if (kind === 0x5b) {
		for (let i = esc + 2; i < limit; i++) {
			const c = bytes[i]
			if (c >= 0x40 && c <= 0x7e) return true
			if (!((c >= 0x30 && c <= 0x3f) || (c >= 0x20 && c <= 0x2f))) return true
		}
		return false
	}

	// Two-byte escape; its final byte is bytes[esc + 1], which we already have.
	return true
}

/**
 * Decide where to cut a byte window so the caller never sees a broken
 * character or a half escape sequence.
 *
 * Normal case: cut after the last \n. That alone makes multibyte truncation
 * impossible, because a newline is never a UTF-8 continuation byte.
 *
 * Two cases need the continuation-byte walk:
 *   1. eof, where there may be no trailing newline at all
 *   2. a single line longer than the window
 *
 * The escape check runs in every case, including the newline case, because an
 * OSC string may legally contain a newline -- cutting at that newline would
 * split the sequence and leave residue that per-window stripping cannot see.
 */
export function safeCut(bytes: Uint8Array, eof: boolean): Cut {
	if (bytes.length === 0) {
		return { end: 0, heldBack: 0, partialLineDropped: false, forcedSplit: false }
	}

	let end = bytes.length
	let partialLineDropped = false

	if (!eof) {
		let nl = -1
		for (let i = bytes.length - 1; i >= 0; i--) {
			if (bytes[i] === 0x0a) {
				nl = i
				break
			}
		}
		if (nl >= 0) {
			end = nl + 1
			partialLineDropped = end < bytes.length
		} else {
			// One line longer than the window. Cutting mid-line is the only option;
			// the walk below keeps it from being mid-character.
			partialLineDropped = true
		}
	}

	/** Where we would cut if we refused to hold anything back. */
	const floorEnd = end

	if (end === bytes.length || bytes[end - 1] !== 0x0a) {
		let steps = 0
		while (end > 0 && steps < UTF8_MAX_TAIL && (bytes[end - 1] & 0xc0) === 0x80) {
			end--
			steps++
		}
		if (steps > 0 && end > 0 && (bytes[end - 1] & 0xc0) === 0xc0) end--
	}

	const lookFloor = Math.max(0, end - ANSI_LOOKBACK)
	for (let i = end - 1; i >= lookFloor; i--) {
		if (bytes[i] !== 0x1b) continue
		if (!escapeTerminated(bytes, i, end)) {
			end = i
			partialLineDropped = true
		}
		break
	}

	// Liveness beats a perfect cut. A zero-length window would make the reader
	// loop forever on the same from_byte, which is a worse failure than one
	// visibly mangled escape sequence.
	let forcedSplit = false
	if (end === 0) {
		end = floorEnd > 0 ? floorEnd : bytes.length
		forcedSplit = true
	}

	return { end, heldBack: bytes.length - end, partialLineDropped, forcedSplit }
}

/*
 * These three used to run on the runner at write time, against a second
 * `out.strip` file. That made the byte cursor point into a file whose contents
 * depended on when the stripper happened to run, so a re-read after -32001 was
 * not guaranteed to return the same bytes. They live here now.
 *
 * Order matters: OSC first, because its payload can contain '[' and would
 * otherwise be partly eaten by the CSI pattern.
 */
export const RE_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
export const RE_CSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g
export const RE_ESC_SHORT = /\x1b[@-Z\\-_]/g

export function stripAnsi(s: string): string {
	return s.replace(RE_OSC, "").replace(RE_CSI, "").replace(RE_ESC_SHORT, "")
}

/**
 * Mask known secret values in rendered output.
 *
 * Longest first, so a secret that contains another secret is masked whole.
 * Values shorter than 8 characters are ignored: masking those turns ordinary
 * build output into a field of asterisks, and GitHub's own `::add-mask::` is
 * not available to us anyway (actions/runner#643 -- it does not apply to
 * workflow_dispatch inputs).
 */
export function makeRedactor(secrets: string[]): (s: string) => string {
	const list = [...new Set(secrets.filter((v) => typeof v === "string" && v.length >= 8))].sort(
		(a, b) => b.length - a.length,
	)
	if (list.length === 0) return (s) => s
	return (s) => {
		for (const v of list) {
			if (s.includes(v)) s = s.split(v).join("***")
		}
		return s
	}
}

/**
 * Invalid sequences become U+FFFD rather than throwing: output can be binary.
 *
 * ignoreBOM is spelled out because workers-types declares every field of
 * TextDecoderConstructorOptions as required. false is the default either way.
 */
const DECODER = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false })

export type RenderedWindow = {
	/** Stripped and redacted text for the bytes this window covers. */
	text: string
	/** Raw bytes covered, i.e. next_byte - start_byte. Not text.length. */
	rawBytes: number
	partialLineDropped: boolean
	forcedSplit: boolean
}

/**
 * The whole read-time transform in one place: cut, decode, strip, redact.
 * `rawBytes` is what the caller must add to `from_byte` to get `next_byte`.
 */
export function renderWindow(
	raw: Uint8Array,
	opts: { eof: boolean; redact?: (s: string) => string },
): RenderedWindow {
	const cut = safeCut(raw, opts.eof)
	const text = stripAnsi(DECODER.decode(raw.subarray(0, cut.end)))
	return {
		text: opts.redact ? opts.redact(text) : text,
		rawBytes: cut.end,
		partialLineDropped: cut.partialLineDropped,
		forcedSplit: cut.forcedSplit,
	}
}
