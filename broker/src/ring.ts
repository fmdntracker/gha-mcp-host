import { concat } from "./bytes"

/**
 * The broker's in-memory view of one command's output.
 *
 * Output bytes never enter Durable Object storage while a command is live: the
 * runner's out.raw file is the only real buffer, and this is a cache in front
 * of it. If the Durable Object is evicted the ring is empty, which is
 * indistinguishable from eviction by size, and both are answered the same way
 * -- by asking the runner to re-serve the range.
 */
export type Ring = {
	/** Raw byte offset of ring.bytes[0] within the runner's out.raw. */
	start: number
	bytes: Uint8Array
	/** Cumulative bytes this ring once could have served and no longer can. */
	discarded: number
}

export const RING_MAX = 512 * 1024

/**
 * How much of the tail is persisted when a command reaches a terminal state.
 *
 * The ring dies with the isolate, and a runner whose lease has expired cannot
 * re-serve anything, so without this the exit code of a finished command would
 * outlive the output that explains it.
 */
export const TAIL_MAX = 32 * 1024

export function newRing(startByte: number): Ring {
	// A first chunk at a non-zero offset means the head was never seen at all.
	return { start: startByte, bytes: new Uint8Array(0), discarded: startByte }
}

export type AppendResult = {
	/** The chunk started past our end: bytes in between will never be served. */
	gap: boolean
	/** The chunk overlapped what we already hold, i.e. it was redelivered. */
	duplicate: boolean
}

/**
 * Append a chunk addressed by its absolute start offset.
 *
 * start_byte is the dedupe key, not a sequence number, which is what makes the
 * runner's at-least-once push safe: a redelivered chunk overlaps and only its
 * unseen tail is kept.
 */
export function appendChunk(
	ring: Ring,
	startByte: number,
	incoming: Uint8Array,
	ringMax = RING_MAX,
): AppendResult {
	const end = ring.start + ring.bytes.length
	let gap = false
	let duplicate = false

	if (startByte === end) {
		ring.bytes = concat(ring.bytes, incoming)
	} else if (startByte < end) {
		duplicate = true
		const skip = end - startByte
		if (skip < incoming.length) ring.bytes = concat(ring.bytes, incoming.subarray(skip))
	} else {
		// A gap. The runner's file stays authoritative; restart the ring here so
		// offsets never lie about what this cache can serve.
		gap = true
		ring.discarded += startByte - end
		ring.start = startByte
		ring.bytes = incoming.slice()
	}

	if (ring.bytes.length > ringMax) {
		const drop = ring.bytes.length - ringMax
		// slice, not subarray: a subarray would keep every buffer this ring has
		// ever been handed alive for the lifetime of the environment.
		ring.bytes = ring.bytes.slice(drop)
		ring.start += drop
		ring.discarded += drop
	}

	return { gap, duplicate }
}

/**
 * The bytes this ring can serve from `fromByte`, or null when it cannot serve
 * that offset at all -- either it has aged out of the head, or it is ahead of
 * anything the ring has received.
 */
export function sliceRing(ring: Ring, fromByte: number, maxBytes: number): Uint8Array | null {
	if (fromByte < ring.start) return null
	const offset = fromByte - ring.start
	if (offset > ring.bytes.length) return null
	return ring.bytes.subarray(offset, Math.min(ring.bytes.length, offset + maxBytes))
}

/** The last `n` bytes and the absolute offset they start at. */
export function tailOf(ring: Ring, n = TAIL_MAX): { start: number; bytes: Uint8Array } {
	const take = Math.min(n, ring.bytes.length)
	const from = ring.bytes.length - take
	return { start: ring.start + from, bytes: ring.bytes.slice(from) }
}
