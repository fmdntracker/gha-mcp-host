// SPDX-License-Identifier: ISC
//
// Vendored from npm/write-file-atomic, file lib/index.js (ISC).
//   upstream: https://github.com/npm/write-file-atomic
//   blob:     d470cdd18de8c370eb245db765ccd4aa7c6fc2c9
//   tree:     23e111d95367e1d987c1b4d7823791eaaf6b21df
//
// NOTICE OF MODIFICATION (gha-mcp M2)
//  - async path deleted; the sync path only (writeFileSync -> writeAtomic).
//  - dependencies removed: signal-exit (exit handler), worker_threads threadId
//    (banned by ci gate 1), sha1-of-__filename tmp names -> crypto.randomBytes.
//  - tmp is created with "wx" at 0o600 instead of "w" at options.mode, and the
//    mode is applied with chmod immediately before the rename.
//  - a chmod failure now ABORTS the commit instead of being swallowed by
//    isChownErrOk(). Upstream keeps the file; we would rather not commit than
//    commit with the wrong mode.
//  - chown is never attempted (upstream copies uid/gid off the old file).
//  - fsync failures are branched on errno: EPERM / EINVAL / ENOTSUP /
//    EOPNOTSUPP are reported as fsync_skipped and the write continues; any
//    other errno aborts.
//  - rename retries on {EPERM, EACCES, EBUSY} until a deadline supplied by the
//    caller. EXDEV / ENOENT / ENOTDIR / EISDIR are deliberately NOT retried:
//    they cannot succeed later and would only burn the deadline.
//    (graceful-fs is not vendored; see VENDOR.md for why.)
//  - tmp names are derived from path.dirname(target) so the rename is always
//    intra-directory and EXDEV is unreachable by construction.
//  - sweepOrphanTmp() reclaims tmp files left behind by SIGKILL. `finally`
//    cannot win against SIGKILL, so zero-orphans is only an invariant if it is
//    re-established at startup.

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

/** Marker used by both the writer and the orphan sweeper. */
export const TMP_MARK = ".gt"
export const TMP_SUFFIX = ".tmp"

/** SIGKILL leftovers older than this are reclaimed. > HARD_CAP_MS (55s). */
export const ORPHAN_TMP_MS = 120000

const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"])
const FSYNC_SKIP_CODES = new Set(["EPERM", "EINVAL", "ENOTSUP", "EOPNOTSUPP"])
const RENAME_NAP_MS = 50
const RENAME_NAP_MAX_MS = 250
const TMP_NAME_TRIES = 8

// Sync sleep with no timer and no busy loop. Node allows Atomics.wait on the
// main thread (browsers do not). Used only while retrying a locked rename.
const napBuf = new Int32Array(new SharedArrayBuffer(4))
function napSync(ms) {
	if (ms > 0) Atomics.wait(napBuf, 0, 0, ms)
}

/** tmp path in the SAME directory as target: <base>.gt<4hex>.tmp */
export function tmpNameFor(target) {
	const dir = path.dirname(target)
	const base = path.basename(target)
	const hex = crypto.randomBytes(2).toString("hex")
	return path.join(dir, base + TMP_MARK + hex + TMP_SUFFIX)
}

export function isOurTmp(name) {
	return name.indexOf(TMP_MARK) > 0 && name.endsWith(TMP_SUFFIX)
}

/**
 * fs.renameSync with a bounded retry window. `deadline` is an absolute epoch
 * ms supplied by the caller (this module owns no retry budget of its own).
 * Windows Defender turns concurrent writes into EPERM; see
 * https://github.com/npm/write-file-atomic/issues/227
 */
export function renameWithRetry(from, to, deadline) {
	let retried = 0
	let waitedMs = 0
	for (;;) {
		try {
			fs.renameSync(from, to)
			return { retried, waited_ms: waitedMs }
		} catch (err) {
			if (!RENAME_RETRY_CODES.has(err.code)) throw err
			const left = typeof deadline === "number" ? deadline - Date.now() : 0
			if (left <= 0) throw err
			const nap = Math.min(RENAME_NAP_MS * (retried + 1), RENAME_NAP_MAX_MS, left)
			napSync(nap)
			waitedMs += nap
			retried += 1
		}
	}
}

/**
 * Write `data` (Buffer) to `target` atomically. The rename is the commit point;
 * there is no copy fallback. Returns observations, never guesses.
 *
 * opts.mode      number  applied with chmod right before the rename
 * opts.fsync     false   skip the fsync
 * opts.deadline  number  absolute epoch ms for the rename retry window
 */
export function writeAtomic(target, data, opts = {}) {
	const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8")
	const out = {
		tmp_path: "",
		bytes_written: bytes.length,
		fsync_skipped: null,
		rename_retried: 0,
		rename_waited_ms: 0,
	}
	let fd = null
	let tmp = ""
	let committed = false
	try {
		for (let i = 0; i < TMP_NAME_TRIES; i++) {
			tmp = tmpNameFor(target)
			try {
				fd = fs.openSync(tmp, "wx", 0o600)
				break
			} catch (err) {
				if (err.code !== "EEXIST" || i === TMP_NAME_TRIES - 1) throw err
			}
		}
		out.tmp_path = tmp
		fs.writeSync(fd, bytes, 0, bytes.length, 0)
		if (opts.fsync !== false) {
			try {
				fs.fsyncSync(fd)
			} catch (err) {
				if (!FSYNC_SKIP_CODES.has(err.code)) throw err
				out.fsync_skipped = err.code
			}
		}
		fs.closeSync(fd)
		fd = null
		// A chmod failure aborts: do not commit a file with the wrong mode.
		if (opts.mode !== null && opts.mode !== undefined) fs.chmodSync(tmp, opts.mode)
		const r = renameWithRetry(tmp, target, opts.deadline)
		out.rename_retried = r.retried
		out.rename_waited_ms = r.waited_ms
		committed = true
		return out
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd)
			} catch {
				// the fd may already be closed by the error path
			}
		}
		if (!committed && tmp) {
			try {
				fs.unlinkSync(tmp)
			} catch {
				// nothing was staged
			}
		}
	}
}

/**
 * Reclaim tmp files left by a killed process. Only touches names this module
 * creates, and only when they are older than `olderThanMs`, so a tmp belonging
 * to a live write is never removed.
 */
export function sweepOrphanTmp(dir, olderThanMs = ORPHAN_TMP_MS) {
	const reclaimed = []
	let names = []
	try {
		names = fs.readdirSync(dir)
	} catch {
		return reclaimed
	}
	const cutoff = Date.now() - olderThanMs
	for (const name of names) {
		if (!isOurTmp(name)) continue
		const p = path.join(dir, name)
		try {
			const st = fs.statSync(p, { bigint: true })
			if (Number(st.mtimeMs) > cutoff) continue
			const size = Number(st.size)
			fs.unlinkSync(p)
			reclaimed.push({ path: p, bytes: size })
		} catch {
			// raced with another sweeper or with the owning process
		}
	}
	return reclaimed
}
