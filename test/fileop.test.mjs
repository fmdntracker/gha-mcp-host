/*
 * fileop tests.
 *
 * Real files in a real temp directory, no mocks: the whole point of these
 * primitives is what happens on disk, and a mocked fs proves nothing about
 * rename semantics, modes, or leftover temp files.
 *
 * Run: node --test test/
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

import { SHA256_EMPTY, handleFileOp } from "../lib/fileop.mjs"

const IS_WIN = process.platform === "win32"

function tmpDir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fileop-"))
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
	// macOS hands out /var/... which realpaths to /private/var; tests compare
	// content, never paths, so this only matters if you add a path assertion.
	return dir
}

function put(dir, name, data) {
	const p = path.join(dir, name)
	fs.writeFileSync(p, typeof data === "string" ? Buffer.from(data, "utf8") : data)
	return p
}

const bytesOf = (p) => fs.readFileSync(p)
const textOf = (p) => fs.readFileSync(p).toString("utf8")
const shaOf = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")
const b64 = (s) => Buffer.from(s, "utf8").toString("base64")
const leftoverTmp = (dir) => fs.readdirSync(dir).filter((n) => n.includes(".gt") && n.endsWith(".tmp"))

/* ---------------------------------------------------------------- file_read */

test("read returns lines, base_sha and no next_byte at eof", (t) => {
	const dir = tmpDir(t)
	const p = put(dir, "a.txt", "one\ntwo\nthree\n")
	const r = handleFileOp({ op: "read", path: p })
	assert.equal(r.ok, true)
	assert.equal(r.text, "one\ntwo\nthree\n")
	assert.equal(r.base_sha, shaOf(p))
	assert.equal(r.truncated, false)
	// EOF is the ABSENCE of next_byte, not next_byte === total.
	assert.equal("next_byte" in r, false)
	assert.equal(r.eol, "lf")
	assert.equal(r.has_bom, false)
})

test("read honours offset and limit, and a negative offset reads the tail", (t) => {
	const dir = tmpDir(t)
	const p = put(dir, "a.txt", "l0\nl1\nl2\nl3\nl4")
	const mid = handleFileOp({ op: "read", path: p, offset: 1, limit: 2 })
	assert.equal(mid.text, "l1\nl2")
	assert.equal(mid.start_line, 1)
	assert.equal(mid.truncated_by, "limit")
	const tail = handleFileOp({ op: "read", path: p, offset: -2 })
	assert.equal(tail.text, "l3\nl4")
})

test("read truncates by bytes and hands back a resumable next_byte", (t) => {
	const dir = tmpDir(t)
	const p = put(dir, "big.txt", "abcdefghij")
	const first = handleFileOp({ op: "read", path: p, max_bytes: 1024 })
	assert.equal(first.text, "abcdefghij")
	const part = handleFileOp({ op: "read", path: p, max_bytes: 4 })
	assert.equal(part.text, "abcd")
	assert.equal(part.truncated, true)
	assert.equal(part.truncated_by, "bytes")
	assert.equal(part.next_byte, 4)
	const rest = handleFileOp({ op: "read", path: p, from_byte: part.next_byte })
	assert.equal(rest.text, "efghij")
})

test("read refuses binary and invalid utf-8 instead of mangling them", (t) => {
	const dir = tmpDir(t)
	const bin = put(dir, "bin", Buffer.from([0x41, 0x00, 0x42]))
	const rb = handleFileOp({ op: "read", path: bin })
	assert.equal(rb.ok, false)
	assert.equal(rb.error, "binary_file")
	assert.equal(rb.retryable, "no")

	const bad = put(dir, "bad", Buffer.from([0x61, 0x80, 0x62]))
	const rn = handleFileOp({ op: "read", path: bad })
	assert.equal(rn.ok, false)
	assert.equal(rn.error, "not_utf8")
})

test("read reports a missing file without leaking errno text", (t) => {
	const dir = tmpDir(t)
	const p = path.join(dir, "nope.txt")
	const r = handleFileOp({ op: "read", path: p })
	assert.equal(r.ok, false)
	assert.equal(r.error, "not_found")
	assert.equal(r.retryable, "fix_args")
	assert.equal(r.message, `File not found: ${p}`)
	assert.equal(r.message.includes("ENOENT:"), false)
})

test("a directory is not a file", (t) => {
	const dir = tmpDir(t)
	for (const op of ["read", "edit", "write"]) {
		const r = handleFileOp({ op, path: dir, old_str: "x", new_str: "y", content_b64: "" })
		assert.equal(r.ok, false)
		assert.equal(r.error, "target_is_directory", `op=${op}`)
	}
})

/* ---------------------------------------------------------------- file_edit */

test("edit replaces exactly once and verifies what landed on disk", (t) => {
	const dir = tmpDir(t)
	const p = put(dir, "a.txt", "hello world\n")
	const r = handleFileOp({ op: "edit", path: p, old_str: "world", new_str: "there" })
	assert.equal(r.ok, true)
	assert.equal(r.replacements, 1)
	assert.equal(textOf(p), "hello there\n")
	assert.equal(r.sha_verified, shaOf(p))
	assert.equal(r.size_verified, bytesOf(p).length)
	assert.deepEqual(leftoverTmp(dir), [])
})

test("a missing match fails loudly and changes nothing", (t) => {
	const dir = tmpDir(t)
	const p = put(dir, "a.txt", "hello\n")
	const r = handleFileOp({ op: "edit", path: p, old_str: "HELLO", new_str: "x" })
	assert.equal(r.ok, false)
	assert.equal(r.error, "edit_no_occurrence_found")
	assert.equal(r.retryable, "reread")
	assert.match(r.message, /0 occurrences found for old_string/)
	assert.match(r.message, /could not find the string to replace/)
	assert.equal(textOf(p), "hello\n")
})

test("an ambiguous match is refused rather than guessed", (t) => {
	const dir = tmpDir(t)
	const p = put(dir, "a.txt", "x\nx\n")
	const r = handleFileOp({ op: "edit", path: p, old_str: "x", new_str: "y" })
	assert.equal(r.ok, false)
	assert.equal(r.error, "edit_expected_occurrence_mismatch")
	assert.equal(r.occurrences, 2)
	assert.equal(r.expected_replacements, 1)
	assert.equal(textOf(p), "x\nx\n")

	const both = handleFileOp({ op: "edit", path: p, old_str: "x", new_str: "y", expected_replacements: 2 })
	assert.equal(both.ok, true)
	assert.equal(both.replacements, 2)
	assert.equal(textOf(p), "y\ny\n")
})

test("CRLF survives an edit", (t) => {
	const dir = tmpDir(t)
	const p = put(dir, "crlf.txt", "a\r\nb\r\nc\r\n")
	const r = handleFileOp({ op: "edit", path: p, old_str: "b", new_str: "B" })
	assert.equal(r.ok, true)
	assert.equal(r.eol, "crlf")
	assert.equal(textOf(p), "a\r\nB\r\nc\r\n")
	assert.equal(bytesOf(p).includes(0x0d), true)
})

test("an old_str written with LF still matches a CRLF file", (t) => {
	const dir = tmpDir(t)
	const p = put(dir, "crlf.txt", "one\r\ntwo\r\n")
	const r = handleFileOp({ op: "edit", path: p, old_str: "one\ntwo", new_str: "1\n2" })
	assert.equal(r.ok, true)
	assert.equal(textOf(p), "1\r\n2\r\n")
})

test("a BOM is preserved and is not part of the match", (t) => {
	const dir = tmpDir(t)
	const p = put(dir, "bom.txt", "\uFEFFhello\n")
	const r = handleFileOp({ op: "edit", path: p, old_str: "hello", new_str: "bye" })
	assert.equal(r.ok, true)
	assert.equal(r.has_bom, true)
	const raw = bytesOf(p)
	assert.deepEqual([raw[0], raw[1], raw[2]], [0xef, 0xbb, 0xbf])
	assert.equal(raw.toString("utf8"), "\uFEFFbye\n")
})

test("replacement text is literal: $&, $1 and backslashes are not expanded", (t) => {
	const dir = tmpDir(t)
	const p = put(dir, "a.txt", "KEY\n")
	const r = handleFileOp({ op: "edit", path: p, old_str: "KEY", new_str: "$& $1 $` \\n" })
	assert.equal(r.ok, true)
	assert.equal(textOf(p), "$& $1 $` \\n\n")
})

test("base_sha refuses an edit built from a stale read", (t) => {
	const dir = tmpDir(t)
	const p = put(dir, "a.txt", "v1\n")
	const stale = shaOf(p)
	put(dir, "a.txt", "v2\n")
	const r = handleFileOp({ op: "edit", path: p, old_str: "v2", new_str: "v3", base_sha: stale })
	assert.equal(r.ok, false)
	assert.equal(r.error, "sha_mismatch")
	assert.equal(r.retryable, "reread")
	assert.equal(r.current_sha256, shaOf(p))
	assert.equal(textOf(p), "v2\n")
})

test("an edit that changes nothing does not rewrite the file", (t) => {
	const dir = tmpDir(t)
	const p = put(dir, "a.txt", "same\n")
	const before = fs.statSync(p).mtimeMs
	const r = handleFileOp({ op: "edit", path: p, old_str: "same", new_str: "same" })
	assert.equal(r.ok, true)
	assert.equal(r.noop, true)
	assert.equal(r.replacements, 0)
	assert.equal(fs.statSync(p).mtimeMs, before)
})

test("edit preserves the file mode", { skip: IS_WIN }, (t) => {
	const dir = tmpDir(t)
	const p = put(dir, "x.sh", "echo a\n")
	fs.chmodSync(p, 0o755)
	const r = handleFileOp({ op: "edit", path: p, old_str: "a", new_str: "b" })
	assert.equal(r.ok, true)
	assert.equal(fs.statSync(p).mode & 0o777, 0o755)
	assert.equal(r.mode, 0o755)
})

/* --------------------------------------------------------------- file_write */

test("write creates a file and verifies it byte for byte", (t) => {
	const dir = tmpDir(t)
	const p = path.join(dir, "new.txt")
	const r = handleFileOp({ op: "write", path: p, content_b64: b64("fresh\n") })
	assert.equal(r.ok, true)
	assert.equal(r.created, true)
	assert.equal(textOf(p), "fresh\n")
	assert.equal(r.sha_verified, shaOf(p))
	assert.deepEqual(leftoverTmp(dir), [])
	if (!IS_WIN) assert.equal(fs.statSync(p).mode & 0o777, 0o644)
})

test("create_parents is opt-in", (t) => {
	const dir = tmpDir(t)
	const p = path.join(dir, "deep", "er", "f.txt")
	const refused = handleFileOp({ op: "write", path: p, content_b64: b64("x") })
	assert.equal(refused.ok, false)
	assert.equal(refused.error, "not_found")
	const made = handleFileOp({ op: "write", path: p, content_b64: b64("x"), create_parents: true })
	assert.equal(made.ok, true)
	assert.equal(textOf(p), "x")
})

test("base_sha on a write: empty sha means 'must not exist yet'", (t) => {
	const dir = tmpDir(t)
	const p = path.join(dir, "guard.txt")
	const created = handleFileOp({ op: "write", path: p, content_b64: b64("1"), base_sha: SHA256_EMPTY })
	assert.equal(created.ok, true)
	// The sentinel is a real sha256, never "": one rule, no second meaning.
	assert.equal(SHA256_EMPTY.length, 64)
	const again = handleFileOp({ op: "write", path: p, content_b64: b64("2"), base_sha: SHA256_EMPTY })
	assert.equal(again.ok, false)
	assert.equal(again.error, "sha_mismatch")
	assert.equal(textOf(p), "1")
})

test("an overwrite preserves the mode of the file it replaces", { skip: IS_WIN }, (t) => {
	const dir = tmpDir(t)
	const p = put(dir, "x.sh", "old\n")
	fs.chmodSync(p, 0o700)
	const r = handleFileOp({ op: "write", path: p, content_b64: b64("new\n") })
	assert.equal(r.ok, true)
	assert.equal(fs.statSync(p).mode & 0o777, 0o700)
})

test("resending the same write_id replays the result instead of writing twice", (t) => {
	const dir = tmpDir(t)
	const p = put(dir, "a.txt", "start\n")
	const job = { op: "edit", path: p, old_str: "start", new_str: "end", write_id: "wid-1" }
	const first = handleFileOp({ ...job })
	assert.equal(first.ok, true)
	assert.equal(textOf(p), "end\n")
	// The second delivery must not find "start" missing and report a failure:
	// a duplicate delivery is expected on this transport, not an error.
	const second = handleFileOp({ ...job })
	assert.equal(second.ok, true)
	assert.equal(second.replayed, true)
	assert.equal(textOf(p), "end\n")
})

test("an unknown op is refused with the list of the ones that exist", () => {
	const r = handleFileOp({ op: "append", path: "/tmp/x" })
	assert.equal(r.ok, false)
	assert.equal(r.error, "bad_input")
	assert.deepEqual(r.supported, ["read", "write", "edit"])
})

test("every failure carries a phase and one of the five recovery verbs", (t) => {
	const dir = tmpDir(t)
	const verbs = new Set(["fix_args", "reread", "retry", "wait", "no"])
	const phases = new Set([
		"resolve",
		"precheck",
		"transfer",
		"temp_create",
		"temp_write",
		"temp_chmod",
		"temp_sync",
		"rename",
		"dir_sync",
		"verify",
		"respond",
	])
	const failures = [
		handleFileOp({ op: "read", path: path.join(dir, "missing") }),
		handleFileOp({ op: "edit", path: put(dir, "b.txt", "a\n"), old_str: "zzz", new_str: "y" }),
		handleFileOp({ op: "edit", path: path.join(dir, "b.txt"), old_str: "", new_str: "y" }),
		handleFileOp({ op: "nope", path: path.join(dir, "b.txt") }),
	]
	for (const f of failures) {
		assert.equal(f.ok, false)
		assert.equal(verbs.has(f.retryable), true, `bad retryable: ${f.retryable}`)
		assert.equal(phases.has(f.phase), true, `bad phase: ${f.phase}`)
		assert.equal(typeof f.message, "string")
		assert.ok(f.message.length > 0 && f.message.length <= 512)
	}
})
