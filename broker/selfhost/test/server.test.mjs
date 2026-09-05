import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHmac } from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { startServer } from "../dist/server.mjs"

const settings = {
  HOST: "127.0.0.1", PORT: "0", GITHUB_OWNER: "test", GITHUB_REPO: "runner",
  MCP_AUTH_TOKEN: "test-client-token", BROKER_SECRET: "test-enroll-secret",
  GITHUB_PAT_DISPATCH: "test-dispatch-token", MAX_ENV_CREATES_PER_HOUR: "1",
}

test("fails fast when secrets are missing", async () => {
  await assert.rejects(startServer({ ...settings, MCP_AUTH_TOKEN: "" }), /MCP_AUTH_TOKEN is required/)
  await assert.rejects(startServer({ ...settings, PUBLIC_URL: "https://example.com/subpath" }), /PUBLIC_URL/)
})

test("HTTP, MCP, enrollment, execution, SSE and restart work without Cloudflare", { timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gha-http-test-"))
  let broker
  const dispatched = []
  const github = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => { body += chunk })
    req.on("end", () => {
      res.setHeader("content-type", "application/json")
      if (req.method === "POST" && req.url.endsWith("/dispatches")) {
        assert.equal(req.headers.authorization, "Bearer test-dispatch-token")
        dispatched.push(JSON.parse(body))
        res.end(JSON.stringify({ run: { id: 123, run_attempt: 1, html_url: "https://example.com/run/123" } }))
      } else if (req.method === "POST" && req.url.endsWith("/cancel")) {
        res.writeHead(202); res.end("{}")
      } else { res.writeHead(404); res.end("{}") }
    })
  })
  github.listen(0, "127.0.0.1")
  await once(github, "listening")
  const env = { ...settings, DATA_DIR: directory, GITHUB_API_BASE: `http://127.0.0.1:${github.address().port}` }
  t.after(async () => {
    await broker?.close()
    github.closeAllConnections()
    await new Promise((r) => github.close(r))
    rmSync(directory, { recursive: true, force: true })
  })
  broker = await startServer(env)
  await assert.rejects(startServer(env), /already in use/)

  let id = 0
  async function rpc(method, params = {}) {
    const requestId = ++id
    const response = await fetch(`${broker.origin}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${settings.MCP_AUTH_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      signal: AbortSignal.timeout(18_000),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    const messages = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim()))
      : [JSON.parse(text)]
    const reply = messages.find((message) => message.id === requestId)
    assert.ok(reply, text)
    assert.equal(reply.error, undefined, text)
    return { result: reply.result, messages }
  }
  async function tool(name, args = {}, meta) {
    return rpc("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) })
  }
  async function agent(action, token, body) {
    const response = await fetch(`${broker.origin}/agent/${envId}/${action}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.status, 200)
    return response.json()
  }

  assert.equal((await fetch(`${broker.origin}/healthz`)).status, 200)
  assert.equal((await fetch(`${broker.origin}/missing`)).status, 404)
  assert.equal((await fetch(`${broker.origin}/mcp`, { method: "POST" })).status, 401)
  assert.equal((await fetch(`${broker.origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${settings.BROKER_SECRET}` } })).status, 401)
  assert.equal((await fetch(`${broker.origin}/healthz`, { headers: { host: "attacker.example" } })).status, 403)
  assert.equal((await fetch(`${broker.origin}/healthz`, { headers: { origin: "https://attacker.example" } })).status, 403)
  assert.equal((await fetch(`${broker.origin}/agent/linux-00000000/next`)).status, 404)
  assert.equal(readdirSync(join(directory, "environments")).length, 0)
  const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })
  assert.equal(initialized.result.protocolVersion, "2025-06-18")
  const listed = await rpc("tools/list")
  for (const name of ["env_create", "env_status", "env_list", "env_extend", "env_destroy", "exec", "exec_read", "exec_kill"]) {
    assert.ok(listed.result.tools.some((tool) => tool.name === name), name)
  }

  const created = (await tool("env_create", { platform: "linux", ttl_minutes: 10 })).result.structuredContent
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.state, "provisioning")
  const envId = created.env_id
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].inputs.env_id, envId)
  const ts = String(Math.floor(Date.now() / 1000))
  const nonce = "test-nonce"
  const signature = createHmac("sha256", settings.BROKER_SECRET).update([envId, "123", "1", nonce, ts].join("\n")).digest("hex")
  const hello = () => fetch(`${broker.origin}/agent/${envId}/hello`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-run-id": "123", "x-run-attempt": "1", "x-nonce": nonce, "x-ts": ts, "x-sig": signature },
    body: JSON.stringify({ shells: { bash: "/bin/bash" }, work_dir: "/tmp/test", platform: "linux" }),
  })
  const enrolled = await hello()
  assert.equal(enrolled.status, 200)
  const agentToken = (await enrolled.json()).agent_token
  assert.ok(agentToken)
  assert.equal((await hello()).status, 409, "enrollment must remain one-shot")
  assert.equal((await fetch(`${broker.origin}/agent/${envId}/next`, { headers: { authorization: `Bearer ${settings.MCP_AUTH_TOKEN}` } })).status, 401)

  async function runCommand(text, delay = 0, progress = false) {
    const pending = tool("exec", { env_id: envId, command: text, deadline_ms: 12000, idle_return_ms: 10000 }, progress ? { progressToken: "test-progress" } : undefined)
    let claimed
    for (let attempt = 0; attempt < 5 && !claimed; attempt++) {
      claimed = (await agent("next?wait=1&worker=0", agentToken)).command
    }
    assert.ok(claimed, "exec must enqueue a claimable command")
    assert.equal(claimed.command, text)
    if (delay) await sleep(delay)
    const output = Buffer.from("hello from the runner\n")
    await agent("chunk", agentToken, {
      command_id: claimed.command_id, start_byte: 0, bytes_b64: output.toString("base64"),
      total_bytes: output.length, state: "exited", exit_code: 0, eof: true, cwd_after: "/tmp/test",
    })
    const result = await pending
    assert.equal(result.result.structuredContent.state, "exited", JSON.stringify(result))
    assert.equal(result.result.structuredContent.text, output.toString())
    if (progress) assert.ok(result.messages.some((message) => message.method === "notifications/progress"), JSON.stringify(result.messages))
    return result.result.structuredContent
  }
  const executed = await runCommand("echo example")
  const reread = (await tool("exec_read", { env_id: envId, command_id: executed.command_id, from_byte: 0 })).result.structuredContent
  assert.equal(reread.text, executed.text)
  assert.deepEqual(Object.keys(reread).sort(), Object.keys(executed).sort())
  const deduped = (await tool("exec", { env_id: envId, command: "echo example", deadline_ms: 12000, idle_return_ms: 10000 })).result.structuredContent
  assert.equal(deduped.deduped, true)
  assert.equal(deduped.command_id, executed.command_id)
  await runCommand("echo progress", 5300, true)

  const previousOrigin = broker.origin
  await broker.close()
  broker = await startServer(env)
  assert.ok(broker.origin)
  const restored = (await tool("exec_read", { env_id: envId, command_id: executed.command_id, from_byte: 0 })).result.structuredContent
  assert.equal(restored.state, "exited")
  assert.equal(restored.text, executed.text, "terminal output must survive process restart")
  const status = (await tool("env_status", { env_id: envId })).result.structuredContent
  assert.equal(status.state, "ready")
  assert.equal((await agent("control", agentToken, { wait: 1, running: [] })).destroy, false)
  const rate = (await tool("env_create", { platform: "linux" })).result.structuredContent
  assert.equal(rate.error.code, "rate_capped", "guard state must survive restart")
  assert.equal(dispatched.length, 1)
  const extended = (await tool("env_extend", { env_id: envId, minutes: 1 })).result.structuredContent
  assert.equal(extended.ok, true)
  const aborted = new AbortController()
  const longPoll = fetch(`${broker.origin}/agent/${envId}/next?wait=50`, { headers: { authorization: `Bearer ${agentToken}` }, signal: aborted.signal })
  await sleep(30)
  aborted.abort()
  await assert.rejects(longPoll, { name: "AbortError" })
  const destroyed = (await tool("env_destroy", { env_id: envId })).result.structuredContent
  assert.equal(destroyed.cancel_status, 202)
  assert.equal((await fetch(`${broker.origin}/agent/${envId}/next`, { headers: { authorization: `Bearer ${agentToken}` } })).status, 410)
})
