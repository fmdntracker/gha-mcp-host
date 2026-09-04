/*
 * File primitives: read / write / edit.
 *
 * Transport is route B: these arrive as ordinary queue jobs with type="file",
 * are claimed by the same exec worker loop, and their result is delivered back
 * through the same ingestChunk path as command output. Nothing in the DO wire
 * contract changes. The queue gives us per-env serialisation for free, so a
 * file job and an `exec` never touch the same file concurrently through our own
 * tools; the in-process lock below is the second line of defence only.
 *
 * What is deliberately NOT here:
 *  - no fuzzy / Levenshtein matching. A near miss must fail loudly.
 *  - no rollback. A committed rename stays committed; we return evidence
 *    (sha_verified) instead of pretending we can undo it.
 *  - no directory ops and no symlink creation: `exec` writes those naturally.
 *
 * Pipeline order is fixed and must not be reordered:
 *   raw Buffer -> UTF-8 round-trip check -> BOM split -> match/replace
 *   -> BOM restore -> encode -> tmp write -> chmod -> rename -> verify
 */

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

import { jobDir, stickyCwdPath, workDir } from "./config.mjs"
import { pushChunk } from "./broker.mjs"
import { clamp, log, mkdirp, num, readTextOr } from "./util.mjs"
import { sweepOrphanTmp, writeAtomic } from "./vendor/write-file-atomic.mjs"

/* ------------------------------------------------------------------ limits */

export const READ_DEFAULT_BYTES = 64 * 1024
export const READ_MAX_BYTES = 8 * 1024 * 1024
export const WRITE_MAX_BYTES = 1024 * 1024
export const OLD_STR_MAX_BYTES = 64 * 1024
export const LINE_LIMIT_DEFAULT = 2000
export const BINARY_SCAN_PREFIX_BYTES = 8000
export const RENAME_BUDGET_MS = 10000
export const RESULT_TTL_MS = 110000
export const NEW_FILE_MODE = 0o644

/** sha256 of the empty byte string. base_sha is ALWAYS 64 hex, never "". */
export const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

// Copied from openclaw/openclaw src/agents/utf8-file.ts (Apache-2.0):
// reject invalid file bytes without stripping a valid leading UTF-8 BOM.
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const BOM = "\uFEFF"

/** write_id -> { at, json }. Duplicate delivery replays the recorded fact. */
const replayCache = new Map()
/** absolute paths currently being mutated by this process. */
const mutating = new Set()

/* ------------------------------------------------------------------ helpers */

function sha256Hex(buf) {
	return crypto.createHash("sha256").update(buf).digest("hex")
}

function fail(error, phase, retryable, message, extra = {}) {
	return { ok: false, error, phase, retryable, message, ...extra }
}

const ERRNO_MAP = {
	ENOENT: ["not_found", "fix_args"],
	ENOTDIR: ["parent_not_found", "fix_args"],
	EISDIR: ["target_is_directory", "fix_args"],
	EACCES: ["permission_denied", "no"],
	EPERM: ["permission_denied", "no"],
	EBUSY: ["rename_locked", "retry"],
	ENOSPC: ["disk_full", "no"],
	EDQUOT: ["quota_exceeded", "no"],
	EFBIG: ["file_too_large", "no"],
	ENAMETOOLONG: ["path_too_long", "fix_args"],
	ELOOP: ["broken_symlink", "fix_args"],
	EMFILE: ["io_error", "wait"],
}

// err.message is never forwarded: it carries absolute paths and, on Windows,
// localised text that the model then tries to pattern-match on.
function errnoFail(phase, err, given, resolved) {
	const [code, retryable] = ERRNO_MAP[err.code] || ["io_error", "no"]
	const msg =
		code === "not_found" ? `File not found: ${given}` : `${err.code} on ${given} during ${phase}`
	return fail(code, phase, retryable, msg, {
		errno: err.code || null,
		path_as_given: given,
		path_resolved: resolved,
	})
}

function resolveTarget(given) {
	const sticky = readTextOr(stickyCwdPath(), "").trim()
	const base = sticky || workDir()
	return path.isAbsolute(given) ? path.normalize(given) : path.resolve(base, given)
}

function statOrNull(abs) {
	try {
		return fs.statSync(abs, { bigint: true })
	} catch (err) {
		if (err.code === "ENOENT" || err.code === "ENOTDIR") return null
		throw err
	}
}

/** Positional reads only: a partial read is resumable and never shifts. */
function readWindow(abs, from, want) {
	const fd = fs.openSync(abs, "r")
	try {
		const buf = Buffer.allocUnsafe(want)
		let got = 0
		while (got < want) {
			const n = fs.readSync(fd, buf, got, want - got, from + got)
			if (n <= 0) break
			got += n
		}
		return buf.subarray(0, got)
	} finally {
		fs.closeSync(fd)
	}
}

function sha256File(abs, maxBytes) {
	const h = crypto.createHash("sha256")
	const fd = fs.openSync(abs, "r")
	try {
		const buf = Buffer.allocUnsafe(65536)
		let pos = 0
		for (;;) {
			const n = fs.readSync(fd, buf, 0, buf.length, pos)
			if (n <= 0) break
			h.update(buf.subarray(0, n))
			pos += n
			if (maxBytes && pos > maxBytes) return null
		}
	} finally {
		fs.closeSync(fd)
	}
	return h.digest("hex")
}

/** Strict decode plus a byte round-trip. Anything lossy is refused, not fixed. */
function decodeStrict(raw) {
	let text
	try {
		text = strictUtf8Decoder.decode(raw)
	} catch {
		return null
	}
	return Buffer.compare(Buffer.from(text, "utf8"), raw) === 0 ? text : null
}

function hasNulPrefix(raw) {
	const n = Math.min(raw.length, BINARY_SCAN_PREFIX_BYTES)
	for (let i = 0; i < n; i++) if (raw[i] === 0) return true
	return false
}

// Copied from sindresorhus/strip-bom (MIT), split instead of stripped so the
// BOM can be put back byte-for-byte on write.
function splitBom(text) {
	return text.charCodeAt(0) === 0xfeff
		? { bom: BOM, body: text.slice(1) }
		: { bom: "", body: text }
}

function detectEol(body) {
	const crlf = body.split("\r\n").length - 1
	const all = body.split("\n").length - 1
	if (crlf === 0) return "lf"
	return crlf === all ? "crlf" : "mixed"
}

const toLf = (s) => s.split("\r\n").join("\n")
const fromLf = (s, eol) => (eol === "crlf" ? s.split("\n").join("\r\n") : s)

/* --------------------------------------------------------------------- read */

function opRead(a) {
	const given = String(a.path || "")
	const abs = resolveTarget(given)
	let st
	try {
		st = fs.statSync(abs, { bigint: true })
	} catch (err) {
		return errnoFail("precheck", err, given, abs)
	}
	if (st.isDirectory()) {
		return fail("target_is_directory", "precheck", "fix_args", `Not a file: ${given}`, {
			path_as_given: given,
			path_resolved: abs,
		})
	}
	const total = Number(st.size)
	const from = clamp(num(a.from_byte, 0), 0, total)
	const want = clamp(num(a.max_bytes, READ_DEFAULT_BYTES), 1, READ_MAX_BYTES)
	let raw
	try {
		raw = readWindow(abs, from, want)
	} catch (err) {
		return errnoFail("transfer", err, given, abs)
	}
	if (hasNulPrefix(raw)) {
		return fail("binary_file", "precheck", "no", `Binary file, not read as text: ${given}`, {
			path_as_given: given,
			path_resolved: abs,
			total_bytes: total,
			is_binary: true,
			binary_scan_prefix_bytes: BINARY_SCAN_PREFIX_BYTES,
		})
	}
	const text = decodeStrict(raw)
	if (text === null) {
		return fail("not_utf8", "precheck", "no", `Not valid UTF-8, cannot be read as text: ${given}`, {
			path_as_given: given,
			path_resolved: abs,
			total_bytes: total,
			hint: from > 0 ? "a byte window can split a multi-byte character" : null,
		})
	}
	const { bom, body } = splitBom(text)
	const eol = detectEol(body)
	const lines = toLf(body).split("\n")
	const offRaw = num(a.offset, 0)
	const limit = clamp(num(a.limit, LINE_LIMIT_DEFAULT), 1, 100000)
	// A negative offset reads the tail, which is the only cheap way to see the
	// end of a file whose length the model does not know yet.
	const start = offRaw < 0 ? Math.max(0, lines.length + offRaw) : Math.min(offRaw, lines.length)
	const end = Math.min(lines.length, start + limit)
	const out = lines.slice(start, end).join("\n")
	const returned = from + raw.length
	return {
		ok: true,
		path_as_given: given,
		path_resolved: abs,
		text: out,
		start_line: start,
		end_line: end,
		lines_returned: end - start,
		lines_in_window: lines.length,
		byte_range: [from, returned],
		bytes_returned: raw.length,
		total_bytes: total,
		truncated: returned < total || end < lines.length,
		truncated_by: returned < total ? "bytes" : end < lines.length ? "limit" : null,
		// EOF is signalled by the ABSENCE of next_byte.
		...(returned < total ? { next_byte: returned } : {}),
		base_sha: total <= READ_MAX_BYTES ? sha256File(abs) : null,
		base_sha_scope: total <= READ_MAX_BYTES ? "file" : "skipped_too_large",
		has_bom: bom !== "",
		eol,
		mtime_ms: Number(st.mtimeMs),
		mode: Number(st.mode) & 0o777,
	}
}

/* -------------------------------------------------------------------- write */

function commit(abs, given, bytes, cur, phaseState) {
	const deadline = Date.now() + RENAME_BUDGET_MS
	const mode = cur ? Number(cur.mode) & 0o777 : NEW_FILE_MODE
	sweepOrphanTmp(path.dirname(abs))
	let w
	try {
		w = writeAtomic(abs, bytes, { mode, deadline })
	} catch (err) {
		return errnoFail(phaseState, err, given, abs)
	}
	const after = statOrNull(abs)
	return {
		ok: true,
		path_as_given: given,
		path_resolved: abs,
		created: !cur,
		bytes_written: w.bytes_written,
		size_verified: after ? Number(after.size) : null,
		sha_verified: sha256File(abs),
		mode: after ? Number(after.mode) & 0o777 : mode,
		fsync_skipped: w.fsync_skipped,
		rename_retried: w.rename_retried,
		rename_waited_ms: w.rename_waited_ms,
	}
}

function opWrite(a) {
	const given = String(a.path || "")
	const abs = resolveTarget(given)
	const bytes = Buffer.from(String(a.content_b64 || ""), "base64")
	if (bytes.length > WRITE_MAX_BYTES) {
		return fail("file_too_large", "precheck", "no", `content exceeds ${WRITE_MAX_BYTES} bytes`, {
			path_as_given: given,
			bytes: bytes.length,
			limit_bytes: WRITE_MAX_BYTES,
		})
	}
	let cur
	try {
		cur = statOrNull(abs)
	} catch (err) {
		return errnoFail("precheck", err, given, abs)
	}
	if (cur && cur.isDirectory()) {
		return fail("target_is_directory", "precheck", "fix_args", `Not a file: ${given}`, {
			path_as_given: given,
			path_resolved: abs,
		})
	}
	const curSha = cur ? sha256File(abs) : SHA256_EMPTY
	if (a.base_sha && String(a.base_sha) !== curSha) {
		return fail(
			"sha_mismatch",
			"precheck",
			"reread",
			`${given} changed since it was read. Read it again and retry.`,
			{ path_as_given: given, path_resolved: abs, current_sha256: curSha },
		)
	}
	if (!cur && a.create_parents) {
		try {
			mkdirp(path.dirname(abs))
		} catch (err) {
			return errnoFail("resolve", err, given, abs)
		}
	}
	return commit(abs, given, bytes, cur, "rename")
}

/* --------------------------------------------------------------------- edit */

function countOccurrences(hay, needle) {
	let n = 0
	let i = hay.indexOf(needle)
	while (i !== -1) {
		n += 1
		i = hay.indexOf(needle, i + needle.length)
	}
	return n
}

// indexOf + slice, never String#replace: `$&`, "$`", `$'` and `$1` inside
// new_str must stay literal.
function replaceAllLiteral(hay, needle, repl) {
	let out = ""
	let at = 0
	for (;;) {
		const i = hay.indexOf(needle, at)
		if (i === -1) break
		out += hay.slice(at, i) + repl
		at = i + needle.length
	}
	return out + hay.slice(at)
}

function opEdit(a) {
	const given = String(a.path || "")
	const abs = resolveTarget(given)
	const oldStr = String(a.old_str === undefined ? "" : a.old_str)
	const newStr = String(a.new_str === undefined ? "" : a.new_str)
	const expected = Math.max(1, num(a.expected_replacements, 1))
	if (!oldStr) {
		return fail("bad_input", "precheck", "fix_args", "old_str must not be empty", {
			path_as_given: given,
		})
	}
	if (Buffer.byteLength(oldStr, "utf8") > OLD_STR_MAX_BYTES) {
		return fail("pattern_too_large", "precheck", "fix_args", `old_str exceeds ${OLD_STR_MAX_BYTES} bytes`, {
			path_as_given: given,
		})
	}
	let st
	try {
		st = fs.statSync(abs, { bigint: true })
	} catch (err) {
		return errnoFail("precheck", err, given, abs)
	}
	if (st.isDirectory()) {
		return fail("target_is_directory", "precheck", "fix_args", `Not a file: ${given}`, {
			path_as_given: given,
			path_resolved: abs,
		})
	}
	const total = Number(st.size)
	if (total > READ_MAX_BYTES) {
		return fail("file_too_large", "precheck", "no", `${given} is larger than ${READ_MAX_BYTES} bytes`, {
			path_as_given: given,
			path_resolved: abs,
			total_bytes: total,
		})
	}
	let raw
	try {
		raw = readWindow(abs, 0, total)
	} catch (err) {
		return errnoFail("transfer", err, given, abs)
	}
	const curSha = sha256Hex(raw)
	if (a.base_sha && String(a.base_sha) !== curSha) {
		return fail(
			"sha_mismatch",
			"precheck",
			"reread",
			`${given} changed since it was read. Read it again and retry.`,
			{ path_as_given: given, path_resolved: abs, current_sha256: curSha },
		)
	}
	const text = decodeStrict(raw)
	if (text === null) {
		return fail("not_utf8", "precheck", "no", `${given} is not valid UTF-8 and cannot be edited safely.`, {
			path_as_given: given,
			path_resolved: abs,
			current_sha256: curSha,
		})
	}
	const { bom, body } = splitBom(text)
	const eol = detectEol(body)
	const hay = toLf(body)
	const needle = toLf(oldStr)
	const repl = toLf(newStr)
	const found = countOccurrences(hay, needle)
	// Wording follows google-gemini/gemini-cli packages/core/src/tools/edit.ts
	// (Apache-2.0) so operators reading two agents' logs see one vocabulary.
	if (found === 0) {
		return fail(
			"edit_no_occurrence_found",
			"precheck",
			"reread",
			`0 occurrences found for old_string in ${given}. Failed to edit, could not find the string to replace.`,
			{ path_as_given: given, path_resolved: abs, current_sha256: curSha, occurrences: 0 },
		)
	}
	if (found !== expected) {
		return fail(
			"edit_expected_occurrence_mismatch",
			"precheck",
			"fix_args",
			`Expected ${expected} occurrence(s) but found ${found} for old_string in ${given}.`,
			{
				path_as_given: given,
				path_resolved: abs,
				current_sha256: curSha,
				occurrences: found,
				expected_replacements: expected,
			},
		)
	}
	if (needle === repl) {
		return {
			ok: true,
			noop: true,
			path_as_given: given,
			path_resolved: abs,
			replacements: 0,
			sha_verified: curSha,
			size_verified: total,
			message: "old_str and new_str are identical; nothing was written.",
		}
	}
	const nextBody = fromLf(replaceAllLiteral(hay, needle, repl), eol)
	const bytes = Buffer.from(bom + nextBody, "utf8")
	const res = commit(abs, given, bytes, st, "rename")
	if (!res.ok) return res
	return {
		...res,
		replacements: found,
		base_sha: curSha,
		eol,
		has_bom: bom !== "",
		eol_restored: eol === "crlf",
		mixed_eol: eol === "mixed",
	}
}

/* ----------------------------------------------------------------- dispatch */

const OPS = { read: opRead, write: opWrite, edit: opEdit }
const MUTATING_OPS = new Set(["write", "edit"])

function pruneReplayCache(now) {
	for (const [k, v] of replayCache) if (now - v.at > RESULT_TTL_MS) replayCache.delete(k)
}

export function handleFileOp(job) {
	const op = String(job.op || "")
	const fn = OPS[op]
	if (!fn) {
		return fail("bad_input", "resolve", "fix_args", `unknown file op: ${op || "(missing)"}`, {
			supported: Object.keys(OPS),
		})
	}
	const now = Date.now()
	pruneReplayCache(now)
	const wid = job.write_id ? String(job.write_id) : ""
	if (wid && replayCache.has(wid)) {
		return { ...replayCache.get(wid).json, replayed: true }
	}
	const abs = job.path ? resolveTarget(String(job.path)) : ""
	const needsLock = MUTATING_OPS.has(op) && abs
	if (needsLock && mutating.has(abs)) {
		return fail("write_in_progress", "precheck", "wait", `another write to ${job.path} is in flight`, {
			path_as_given: String(job.path),
		})
	}
	if (needsLock) mutating.add(abs)
	try {
		const res = fn(job)
		if (wid && MUTATING_OPS.has(op)) replayCache.set(wid, { at: now, json: res })
		return res
	} catch (err) {
		// A throw here would leave the job in `running` forever, which is worse
		// than a reported failure.
		return fail("io_error", "respond", "no", `${err.code || "unhandled"} during ${op}`, {
			errno: err.code || null,
		})
	} finally {
		if (needsLock) mutating.delete(abs)
	}
}

/**
 * Queue-job entry point. Mirrors runCommand(): the result is delivered as one
 * terminal chunk, so the broker's existing window()/poll path reads it with no
 * changes. `exit_code` is 0 on ok and 1 otherwise; the JSON body carries the
 * typed error.
 */
export async function runFileJob(job) {
	const startedAt = Date.now()
	const dir = jobDir(job.command_id)
	mkdirp(dir)
	try {
		// Same O_EXCL guard as exec: redelivery of a claimed job is expected.
		fs.writeFileSync(path.join(dir, "started_at"), String(startedAt), { flag: "wx" })
	} catch (err) {
		if (err.code === "EEXIST") {
			log(`duplicate delivery of ${job.command_id} ignored`)
			return
		}
		throw err
	}
	const res = handleFileOp(job)
	const body = Buffer.from(JSON.stringify(res), "utf8")
	await pushChunk({
		command_id: job.command_id,
		start_byte: 0,
		bytes_b64: body.toString("base64"),
		total_bytes: body.length,
		bytes_written: body.length,
		state: "exited",
		exit_code: res.ok ? 0 : 1,
		runtime_ms: Date.now() - startedAt,
		eof: true,
		cwd_after: null,
	})
}
