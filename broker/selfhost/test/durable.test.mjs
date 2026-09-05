import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DurableObject, LocalNamespace } from "../durable.mjs"

class Counter extends DurableObject {
  init() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, n INTEGER)")
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO counter VALUES (1, 0)")
  }
  async increment() {
    this.init()
    const n = this.ctx.storage.sql.exec("SELECT n FROM counter").toArray()[0].n
    await new Promise((r) => setTimeout(r, 1))
    this.ctx.storage.sql.exec("UPDATE counter SET n = ?", n + 1)
    return n + 1
  }
  async read() { this.init(); return this.ctx.storage.sql.exec("SELECT n FROM counter").toArray()[0].n }
  async fail() { this.init(); this.ctx.storage.sql.exec("UPDATE counter SET n=999"); throw new Error("rollback") }
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "gha-storage-test-"))
  const namespaces = []
  const open = () => { const ns = new LocalNamespace(Counter, directory, {}); namespaces.push(ns); return ns }
  t.after(async () => { for (const ns of namespaces) await ns.close(); rmSync(directory, { recursive: true, force: true }) })
  return open
}

test("serializes concurrent RPCs without lost updates and isolates names", async (t) => {
  const ns = fixture(t)()
  const one = ns.get(ns.idFromName("one"))
  const two = ns.get(ns.idFromName("two"))
  const results = await Promise.all(Array.from({ length: 25 }, () => one.increment()))
  assert.equal(new Set(results).size, 25)
  assert.equal(await one.read(), 25)
  assert.equal(await two.read(), 0)
  assert.equal(one.then, undefined)
  assert.equal(one.constructor, undefined)
  assert.throws(() => ns.get("../../outside"), /invalid object id/)
})

test("a failed RPC rolls back and does not poison subsequent calls", async (t) => {
  const ns = fixture(t)()
  const one = ns.get(ns.idFromName("one"))
  await one.increment()
  await assert.rejects(one.fail(), /rollback/)
  assert.equal(await one.read(), 1)
  assert.equal(await one.increment(), 2)
})

test("state survives namespace recreation; close drains pending RPCs", async (t) => {
  const open = fixture(t)
  const first = open()
  const id = first.idFromName("persistent")
  const pending = first.get(id).increment()
  await first.close()
  assert.equal(await pending, 1)
  const second = open()
  assert.equal(second.hasName("persistent"), true)
  assert.equal(second.hasName("unknown"), false)
  assert.equal(await second.get(id).read(), 1)
})

test("idle eviction bounds open handles and recreates from SQLite", async (t) => {
  const ns = fixture(t)()
  const id = ns.idFromName("idle")
  await ns.get(id).increment()
  ns.evictIdle(-1)
  assert.equal(ns.objects.size, 0)
  assert.equal(await ns.get(id).read(), 1)
})
