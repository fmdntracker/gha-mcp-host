import { createHash } from "node:crypto"
import { mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

// Only the DurableObject surface used by EnvDO/GuardDO. Not a general Workers
// emulator: there are no Cloudflare requests, credentials, bindings or quotas.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
  }
}

export class SqliteStorage {
  constructor(filename) {
    this.db = new DatabaseSync(filename)
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;")
    this.statements = new Map()
  }

  exec(query, ...bindings) {
    let statement = this.statements.get(query)
    if (!statement) {
      statement = this.db.prepare(query)
      if (this.statements.size >= 128) this.statements.delete(this.statements.keys().next().value)
      this.statements.set(query, statement)
    }
    const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), [])
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }
  }

  async transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = await fn()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  close() {
    this.statements.clear()
    this.db.close()
  }
}

// Per-object serialization + an explicit SQLite transaction preserve DO RPC
// atomicity, including enqueue+queue and the one-shot enrollment check. Long
// polls happen in the HTTP router, OUTSIDE this queue, exactly as on Workers.
export class LocalNamespace {
  constructor(ObjectClass, directory, env) {
    this.ObjectClass = ObjectClass
    this.directory = directory
    this.env = env
    this.objects = new Map()
    this.closed = false
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  idFromName(name) {
    return createHash("sha256").update(String(name)).digest("hex")
  }

  hasName(name) {
    const id = this.idFromName(name)
    return this.objects.has(id) || existsSync(join(this.directory, `${id}.sqlite`))
  }

  get(id) {
    if (this.closed) throw new Error("storage is closed")
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid object id")
    let record = this.objects.get(id)
    if (record) return record.stub
    const sql = new SqliteStorage(join(this.directory, `${id}.sqlite`))
    const instance = new this.ObjectClass({ storage: { sql } }, this.env)
    record = { sql, instance, pending: Promise.resolve(), active: 0, lastUsed: Date.now() }
    record.stub = new Proxy({}, {
      get: (_, method) => {
        if (typeof method !== "string" || method === "then") return undefined
        // Only own prototype methods, never Object.prototype or fields.
        if (method === "constructor" || !Object.hasOwn(this.ObjectClass.prototype, method) ||
            typeof instance[method] !== "function") return undefined
        return (...args) => {
          if (this.closed) return Promise.reject(new Error("storage is closed"))
          record.active += 1
          record.lastUsed = Date.now()
          const result = record.pending.then(async () => {
            try { return await sql.transaction(() => record.instance[method](...args)) }
            catch (error) {
              // Discard uncommitted in-memory state along with a rolled-back DB.
              record.instance = new this.ObjectClass({ storage: { sql } }, this.env)
              throw error
            }
          })
          const settled = result.finally(() => {
            record.active -= 1
            record.lastUsed = Date.now()
          })
          record.pending = settled.then(() => undefined, () => undefined)
          return settled
        }
      },
    })
    this.objects.set(id, record)
    return record.stub
  }

  evictIdle(maxIdleMs) {
    for (const [id, record] of this.objects) {
      if (record.active === 0 && Date.now() - record.lastUsed > maxIdleMs) {
        record.sql.close()
        this.objects.delete(id)
      }
    }
  }

  async close() {
    this.closed = true
    await Promise.all([...this.objects.values()].map((r) => r.pending))
    for (const record of this.objects.values()) record.sql.close()
    this.objects.clear()
  }
}
