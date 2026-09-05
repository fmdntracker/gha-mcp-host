# gha-mcp-broker

A Cloudflare Worker that lets an AI client open a real Linux, macOS or Windows
shell on a GitHub Actions runner and drive it over MCP.

The runner half lives in [`nmt3325/gha-mcp-runner`](https://github.com/nmt3325/gha-mcp-runner).
This repository is the broker: it dispatches the workflow, holds the lease, and
is the only thing the MCP client ever talks to.

```
MCP client  --POST /mcp-->  Worker  --workflow_dispatch-->  GitHub Actions
                              |                                  |
                          EnvDO (one per environment)  <--long poll--  runner agent
                          GuardDO (rate limit, breaker)
```

## The constraint everything is shaped by

An MCP request is cancelled after **60 seconds** by default. Anything slower
comes back to the caller as `MCP error -32001: Request timed out`, and a build,
a test run or an `npm install` is routinely slower than that.

So no tool here waits for a command to finish. `exec` starts the command,
returns whatever output exists when its deadline is near, and hands back a byte
offset. `exec_read` resumes from that offset. Output is addressed **by absolute
byte range**, like HTTP Range, with no server-side cursor anywhere:

- Re-reading the same `{from_byte, max_bytes}` returns the same bytes. A client
  that just lost a response to a timeout can simply ask again.
- Two readers cannot interfere with each other, because neither of them moves
  anything.
- A command that outlives the client, the isolate, or both is still readable
  afterwards from wherever the reader left off.

When the client sends a `progressToken`, the server also emits
`notifications/progress` every 5 seconds while a tool is working, which lets a
client that opted into `resetTimeoutOnProgress` wait longer than 60s. It is
treated as a bonus, never as a requirement.

## Tools

| Tool | What it does |
| --- | --- |
| `env_create` | Dispatch a runner for one platform, return an `env_id` |
| `env_status` | State, TTL, disk, queue depth, recent commands, runner facts |
| `env_list` | Every live environment this broker knows about |
| `env_extend` | Push the lease out, up to the hard cap from creation |
| `env_destroy` | Cancel the run and release the environment |
| `exec` | Start a command, return the first window of output |
| `exec_read` | Read any byte range of a command's output |
| `exec_kill` | Kill one command, or all of them, with the whole process tree |

Every `exec` and `exec_read` result has the **same key set**, always, with every
field present -- `state`, `exit_code`, `text`, `start_byte`, `next_byte`, `eof`,
`killed_reason`, `poll_error` and the rest. A field that appears only in the
interesting case forces the caller to branch on key existence, and a caller that
guesses wrong reports `state: unknown` instead of what actually happened.

Run multiple environments at once and address each one by its `env_id`:
`linux-xxxxxxxx`, `mac-xxxxxxxx`, `win-xxxxxxxx`.

## Layout

| File | Role |
| --- | --- |
| `src/index.ts` | Routes. `/mcp` for clients, `/agent/:envId/*` for runners |
| `src/mcp.ts` | Tool registration, progress heartbeat, error shaping |
| `src/tools-env.ts` | Environment lifecycle tools |
| `src/tools-exec.ts` | `exec`, `exec_read`, `exec_kill` |
| `src/tools-shared.ts` | The shared result shape both exec tools return |
| `src/schemas.ts` | Zod input schemas, one source of truth per tool |
| `src/env-do.ts` | `EnvDO`: one Durable Object per environment |
| `src/env-schema.ts` | Its SQL schema and migrations |
| `src/env-window.ts` | Pure byte-window reader, unit testable without a DO |
| `src/env-snapshot.ts` | Pure status builder |
| `src/ring.ts` | The in-memory output cache and its 32 KiB persisted tail |
| `src/kill-reason.ts` | Why a command died, and which reason wins |
| `src/bytes.ts` | Base64, ANSI stripping, the single output cut site |
| `src/guard-do.ts` | Create-rate limit and the account-suspension breaker |
| `src/github.ts` | Workflow dispatch and run lookup |
| `src/result.ts` | `ok`/`fail`, retry classification, deadlines |

### Where output actually lives

The runner appends everything to a single `out.raw` file and never deletes it,
so for as long as the environment lives, the runner can re-serve any byte range
on demand. The broker keeps a 512 KiB in-memory ring in front of that, and when
a command reaches a terminal state it persists the last 32 KiB together with the
exit code -- because a finished command's exit code must not outlive the output
that explains it.

ANSI stripping, UTF-8 boundary repair and the partial-line hold happen **exactly
once**, at broker read time. Two cut sites would mean the same byte range could
answer differently on a re-read, and re-reading is the entire recovery story.

## Setup

```bash
npm install
```

Worker secrets:

```bash
npx wrangler secret put GITHUB_PAT_DISPATCH   # repo scope on the runner repo
npx wrangler secret put BROKER_SECRET         # shared with the runner repo
npx wrangler secret put MCP_AUTH_TOKEN        # bearer token your MCP client sends
```

Runner repository secrets: `BROKER_URL` (this Worker's URL) and `BROKER_SECRET`
(the same value).

```bash
npx wrangler deploy
```

Then add `https://<your-worker>/mcp` as an MCP server with an
`Authorization: Bearer <MCP_AUTH_TOKEN>` header.

`wrangler.toml` vars worth knowing: `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_REF`,
`DEFAULT_TTL_MINUTES`, `MAX_TTL_MINUTES`, `MAX_ENV_CREATES_PER_HOUR`,
`MAX_OUTPUT_BYTES`, `EXEC_WORKERS`, `AGENT_WAIT_SECONDS`.

Other routes: `GET /healthz`, and `GET /probe?wait=N` which holds a response
open for N seconds so you can measure how long a GET actually survives from
inside each runner OS before something in the middle cuts it.

## What this deliberately does not do

**No command allow list or deny list.** A shell on a machine holding a token
with repository write access cannot be made safe by pattern matching the command
string; a list long enough to matter is a list long enough to break real work,
and every version of it is bypassable in one line of shell. The real controls
are the ones that hold regardless of what runs: a short lease, a disposable
runner, a create-rate limit, and a token scoped to one repository. See
`src/config.ts`.

**No reattach-to-a-live-stream protocol.** Every design that keeps a mutable
read position on the server breaks the moment a request is cancelled at 60
seconds, because the client cannot tell whether the read it lost had already
moved the cursor.

## Status

M1: shells only. File editing tools, `outputSchema` declarations and disk
reclaim are M2.

Provenance and third-party attribution for everything vendored or ported are in
[`VENDOR.md`](./VENDOR.md).
