import { createServer } from "node:http"
import { readFileSync, mkdirSync } from "node:fs"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { once } from "node:events"
import { DatabaseSync } from "node:sqlite"
import app, { EnvDO, GuardDO } from "../src/index.ts"
import { LocalNamespace } from "./durable.mjs"

const MAX_BODY = 16 * 1024 * 1024
const ENV_ID = /^(linux|mac|win)-[0-9a-hjkmnp-tv-z]{8}$/

function loadEnvironment(input) {
  const env = { ...input }
  for (const key of ["MCP_AUTH_TOKEN", "BROKER_SECRET", "GITHUB_PAT_DISPATCH"]) {
    if (env[`${key}_FILE`]) {
      if (env[key]) throw new Error(`Set only ${key} or ${key}_FILE, not both`)
      env[key] = readFileSync(env[`${key}_FILE`], "utf8").trim()
    }
    if (!env[key]?.trim()) throw new Error(`${key} is required`)
  }
  for (const key of ["GITHUB_OWNER", "GITHUB_REPO"]) {
    if (!env[key]?.trim()) throw new Error(`${key} is required`)
  }
  return env
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    const cleanup = () => {
      req.off("data", data)
      req.off("end", end)
      req.off("error", error)
      req.off("aborted", aborted)
    }
    const error = (cause) => { cleanup(); reject(cause) }
    const aborted = () => error(new Error("request aborted"))
    const data = (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        cleanup()
        req.resume()
        reject(Object.assign(new Error("request body too large"), { status: 413 }))
      } else chunks.push(chunk)
    }
    const end = () => { cleanup(); resolveBody(Buffer.concat(chunks)) }
    req.on("data", data)
    req.on("end", end)
    req.on("error", error)
    req.on("aborted", aborted)
  })
}

function reply(res, status, message) {
  if (res.destroyed || res.headersSent) return
  res.writeHead(status, { "content-type": "application/json", "connection": "close" })
  res.end(JSON.stringify({ ok: false, error: message }))
}

export async function startServer(input = process.env) {
  const env = loadEnvironment(input)
  const port = Number(env.PORT ?? 8787)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be 0..65535")
  const host = env.HOST || "0.0.0.0"
  const publicUrl = env.PUBLIC_URL ? new URL(env.PUBLIC_URL) : null
  if (publicUrl && (!/^https?:$/.test(publicUrl.protocol) || publicUrl.username || publicUrl.password ||
      publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash)) {
    throw new Error("PUBLIC_URL must be an http(s) origin without credentials, path, query or fragment")
  }
  const dataDir = resolve(env.DATA_DIR || "./data")
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  // A process-lifetime SQLite lock fails closed if two brokers share a volume.
  // Unlike a PID file, the OS releases it after a crash or docker kill.
  const lock = new DatabaseSync(join(dataDir, "broker-lock.sqlite"))
  try { lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;") }
  catch { lock.close(); throw new Error("DATA_DIR is already in use by another broker") }

  env.ENV_DO = new LocalNamespace(EnvDO, join(dataDir, "environments"), env)
  env.GUARD_DO = new LocalNamespace(GuardDO, join(dataDir, "guard"), env)
  const controllers = new Set()
  const inflight = new Set()
  const background = new Set()
  let closing = false
  let closePromise
  let origin
  const allowedHosts = new Set((env.ALLOWED_HOSTS || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean))
  if (publicUrl) allowedHosts.add(publicUrl.host.toLowerCase())

  const handle = async (req, res) => {
    if (closing) return reply(res, 503, "broker is stopping")
    const controller = new AbortController()
    controllers.add(controller)
    const abort = () => controller.abort()
    req.once("aborted", abort)
    res.once("close", () => { if (!res.writableFinished) abort() })
    try {
      if (!req.url?.startsWith("/") || req.url.startsWith("//")) return reply(res, 400, "invalid request target")
      const incomingHost = (req.headers.host || "").toLowerCase()
      if (!allowedHosts.has(incomingHost)) return reply(res, 403, "Host is not allowed; set PUBLIC_URL or ALLOWED_HOSTS")
      if (req.headers.origin && req.headers.origin !== (publicUrl?.origin || origin)) return reply(res, 403, "Origin is not allowed")
      const url = new URL(req.url, publicUrl?.origin || origin)
      const agent = /^\/agent\/([^/]+)\/(hello|control|next|chunk)$/.exec(url.pathname)
      if (agent) {
        let id
        try { id = decodeURIComponent(agent[1]) } catch { return reply(res, 400, "invalid environment id") }
        // Reject unknown runners without opening/creating a database for them.
        if (!ENV_ID.test(id) || !env.ENV_DO.hasName(id)) return reply(res, 404, "unknown environment")
        const method = agent[2] === "next" ? "GET" : "POST"
        if (req.method !== method) return reply(res, 405, "method not allowed")
      }
      if (Number(req.headers["content-length"] || 0) > MAX_BODY) return reply(res, 413, "request body too large")
      const headers = new Headers()
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1])
      const hasBody = req.method !== "GET" && req.method !== "HEAD"
      const body = hasBody ? await readBody(req) : undefined
      const request = new Request(url, { method: req.method, headers, body, signal: controller.signal })
      const ctx = {
        waitUntil(value) {
          const promise = Promise.resolve(value).catch((error) => console.error("background task failed:", error?.name || "Error"))
          background.add(promise)
          void promise.finally(() => background.delete(promise))
        },
        passThroughOnException() {},
      }
      const response = await app.fetch(request, env, ctx)
      if (controller.signal.aborted || res.destroyed) { await response.body?.cancel(); return }
      res.statusCode = response.status
      for (const [key, value] of response.headers) res.setHeader(key, value)
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        res.setHeader("x-accel-buffering", "no")
        res.setHeader("cache-control", "no-cache, no-transform")
        res.flushHeaders()
      }
      if (req.method === "HEAD" || !response.body) { await response.body?.cancel(); res.end() }
      else await pipeline(Readable.fromWeb(response.body), res, { signal: controller.signal })
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) {
        // Never echo environment values or a dependency error containing a token.
        if (!res.headersSent) reply(res, error.status || 500, error.status === 413 ? "request body too large" : "internal server error")
        else res.destroy()
        if (!error.status) console.error("request failed:", error?.name || "Error")
      }
    } finally {
      controllers.delete(controller)
      req.off("aborted", abort)
    }
  }
  const server = createServer((req, res) => {
    const promise = handle(req, res)
    inflight.add(promise)
    void promise.finally(() => inflight.delete(promise))
  })
  // Upload/header limits must not cut off a 50s long-poll or an SSE response.
  server.requestTimeout = 30_000
  server.headersTimeout = 15_000
  server.setTimeout(0)
  server.keepAliveTimeout = 65_000
  const sweep = setInterval(() => {
    env.ENV_DO.evictIdle(10 * 60_000)
    env.GUARD_DO.evictIdle(10 * 60_000)
  }, 60_000)
  sweep.unref()

  const close = () => closePromise ??= (async () => {
    closing = true
    clearInterval(sweep)
    const stopped = new Promise((resolveStop) => server.close(resolveStop))
    for (const controller of controllers) controller.abort()
    server.closeAllConnections()
    await Promise.allSettled([...inflight, ...background])
    await stopped
    await Promise.all([env.ENV_DO.close(), env.GUARD_DO.close()])
    lock.close()
  })()
  try {
    server.listen(port, host)
    await once(server, "listening")
    const actualPort = server.address().port
    origin = `http://127.0.0.1:${actualPort}`
    for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) allowedHosts.add(`${hostname}:${actualPort}`)
    return { server, env, origin, close }
  } catch (error) { await close(); throw error }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const broker = await startServer()
  console.log(`gha-mcp broker listening on port ${broker.server.address().port}; storage: local SQLite`)
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    const deadline = setTimeout(() => process.exit(1), 10_000)
    deadline.unref()
    broker.close().then(() => process.exit(0), () => process.exit(1))
  })
}
