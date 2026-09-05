# gha-mcp-host

Unified source repository for **gha-mcp**: ephemeral Linux / macOS / Windows
shell environments for an AI agent, provisioned as GitHub Actions jobs and driven
over MCP.

The runner stays at the repository root; the Cloudflare Worker + Durable Objects
broker lives in [`broker/`](./broker/). Both are maintained in
`fmdntracker/gha-mcp-host`. Moving the source does not change the existing Worker
URL, its Durable Objects or runtime secrets. See the [migration and rollback
guide](./broker/MIGRATION.md) for the build-source cutover.

```
AI ──MCP──▶ broker (Cloudflare Worker + Durable Object)
                │  workflow_dispatch
                ▼
        GitHub Actions job  ──▶  agent.mjs  ──▶  bash / pwsh
                ▲                    │
                └────── HTTPS long-poll (outbound only) ──┘
```

## Why this repository is public

Standard GitHub-hosted runners are free and unmetered on public repositories,
including macOS. On the Free plan a private repository gets 2,000 minutes/month,
and macOS bills at 10x, which works out to roughly 200 usable macOS minutes a
month -- not enough to be useful.

**Credential-bearing runner workflows are `workflow_dispatch` only.** The
optional broker deployment workflow is also manual-only and deploys only from
`main`. CI is separate: it runs on pushes and pull requests with `contents: read`
and no application secrets.

Fork pull requests receive no repository secrets. Do not add `pull_request`,
`pull_request_target` or `issue_comment` triggers to the runner or deployment
workflows. Public source code is not a reason to publish credentials: Worker and
runner secrets stay in Cloudflare and GitHub's secret stores, not in this tree.

## Why this repository is not a fork

This is a standalone repository with its own history. GitHub disables Actions on
forked repositories by default, whereas a fresh standalone repository can run the
dispatch workflows as soon as its secrets are set.

Broker and runner sources now share this **fmdntracker** repository. The earlier
broker repository is retained only for history and rollback. The Cloudflare
account and deployed Worker are unchanged. Dispatch still targets this repository
through `GITHUB_OWNER`, `GITHUB_REPO` and `GITHUB_REF` in `broker/wrangler.toml`.

## Files

| Path | Role |
| --- | --- |
| `broker/` | Cloudflare Worker, Durable Objects, broker tests and dependency configuration. |
| `broker/MIGRATION.md` | Build-source cutover, verification and rollback procedure. |
| `.github/workflows/broker-ci.yml` | Broker typecheck, invariant gates and dry-run bundle; no deployment secrets. |
| `.github/workflows/broker-deploy.yml` | Optional manual deployment of the existing Worker; dry-run by default. |
| `agent.mjs` | Entry point: role dispatch, plus the invariants worth reading before editing anything. |
| `lib/config.mjs` | Platform detection, configuration, on-disk layout, tunable constants. |
| `lib/util.mjs` | Small helpers, and the ENOSPC evidence guard. |
| `lib/clock.mjs` | Adaptive tail clock: poll interval from free space and observed write rate. |
| `lib/state.mjs` | The shutdown flag. |
| `lib/broker.mjs` | Broker HTTP on an absolute deadline, and chunk push retries. |
| `lib/shell.mjs` | Shell probing, selection, and script generation. Ported from `actions/runner`. |
| `lib/exec.mjs` | One command: spawn, tail `out.raw`, push chunks, decide the kill reason. |
| `lib/worker.mjs` | The `/next` long-poll loop. |
| `lib/control.mjs` | Enroll, the TTL lease, control actions, and the only tree kills. |
| `vendor/process-utils.mjs` | Process-tree kill, vendored from `google-gemini/gemini-cli` (Apache-2.0). |
| `third_party/*/LICENSE` | Upstream licence texts, verbatim. Provenance is in `VENDOR.md`. |
| `.github/actions/run-agent/action.yml` | Shared setup: Node, Windows console encoding, git credentials, then run the agent in the foreground. |
| `.github/workflows/{linux,macos,windows}.yml` | One per platform, literal `runs-on`, `workflow_dispatch` only. |
| `.github/workflows/probe.yml` | Gate 0. Measures long-GET tolerance and orphan behaviour on all three OSes before anything else is trusted. |
| `.github/workflows/ci.yml` | Syntax and import checks, the tail-clock bounds test, the pwsh script-generation test, and the greps that enforce the invariants below. |

## The agent

Two roles, one entry point, zero dependencies, Node >= 20:

```
node agent.mjs --role=control   # enroll, hold the /control long-poll, own the TTL
                                # lease, spawn exec workers, sole tree-killer
node agent.mjs --role=exec      # hold /next, run one command at a time
```

The control plane is a separate process from the exec workers so that a command
producing 100 MB of output cannot delay a `kill` or a lease renewal.

### The invariants worth knowing before editing it

**No pipes, anywhere.** Children are spawned with `stdio: ['ignore', fd, fd]`
where `fd` is an appending descriptor on `out.raw`. Node cannot tune a child's
stdout high-water mark, so a chatty child on a `'pipe'` stdio stalls the parent's
event loop. Worse, the previous system's supervisor forked a child, redirected the
child's descriptors, and never closed its *own* copies -- so the caller never saw
EOF and a job that had already exited 0 was reported as
`command timed out after 30s and was terminated`. Writing straight to a file fd
removes the entire class of bug, and survives the worker dying.

**One output file, written once, never rewritten.** `out.raw` is exactly the bytes
the child wrote, in the order it wrote them, and byte offsets into it are the
cursor the entire protocol is built on. Nothing here transforms that stream: no
ANSI stripping, no CR rewriting, no second copy. Any such transformation moves the
offsets, and then re-reading the same range returns different bytes. Stripping and
secret redaction happen once, in the broker, at read time. `out.raw` is never
deleted while the environment lives.

**Completion comes from the exit event AND an `rc` file, never from stdout EOF.**
An orphaned grandchild holding the output file open is normal and must not look
like a running job.

**Duplicate delivery is expected; double execution is not.** `/next` may hand the
same command to two workers. Exclusion is `fs.openSync(started_at, 'wx')` --
`O_EXCL` on the runner, not a lock in the broker. A lock in the broker would have
to be broken when a runner dies, and would then be wrong.

**Disconnection is a normal event.** `wrangler deploy` swaps the Worker isolate
and drops every in-flight long poll. Every loop reconnects with jittered backoff
and treats a dropped poll as uneventful.

**No `TERM`.** A bare `TERM` makes tools emit escape sequences with no terminal to
interpret them; `TERM=dumb` makes `tput` exit 3, which kills any script under
`set -e`. `CI=1` and `NO_COLOR=1` are set instead.

**`set -e` is deliberately absent** from the POSIX wrapper, and
`$ErrorActionPreference` is left alone in the pwsh wrapper. Both turn ordinary
multi-command input into surprise aborts.

**Secrets are scrubbed from every child environment**: `BROKER_SECRET`,
`GHA_MCP_*`, `GITHUB_TOKEN`, `ACTIONS_*`, `INPUT_*`. The PAT for private clones is
never an environment variable -- it goes into a `GIT_CONFIG_GLOBAL` credential
store file with mode 600, and is additionally redacted to `***` by the broker on
the way back out.

### Job layout on disk

```
$RUNNER_TEMP/gha-mcp/<env_id>/
  work/                     default working directory (macOS /work is read-only)
  overlay.env               persisted env vars, sourced by every command
  cwd                       sticky working directory
  state.json  meta.json     enroll result; exit_reason
  shells.json               which shells this runner actually has
  jobs/<command_id>/
    cmd.sh | cmd.ps1 | cmd.cmd
    started_at              O_EXCL marker: the exclusion mechanism
    pid  pgid  rc  cwd_out
    stdin.bin               caller-supplied stdin, handed to the child as fd 0
    out.raw                 the one output stream; what byte offsets refer to
    kill                    kill marker, written before any signal is sent
    meta.json
```

## Setup

Repository secrets (Settings -> Secrets and variables -> Actions):

| Secret | Required | What |
| --- | --- | --- |
| `BROKER_URL` | yes | e.g. `https://gha-mcp.<subdomain>.workers.dev` |
| `BROKER_SECRET` | yes | shared secret for the one-shot enroll HMAC; must match the broker's |
| `GH_PAT` | no | fine-grained PAT if the agent needs to clone other private repos |

The broker needs the mirror image: the same `BROKER_SECRET`, plus a fine-grained
PAT owned by *this* account with **Actions: read and write** on *this* repository
only, stored as the Worker secret `GITHUB_PAT_DISPATCH`. Nothing in this
repository ever sees that PAT.

## Broker development and deployment

Run broker commands from `broker/`, not the repository root. The normal deployment
path is Cloudflare Workers Builds with this repository and root directory
`/broker`. [broker/README.md](./broker/README.md) describes the broker; the
[migration guide](./broker/MIGRATION.md) documents cutover and rollback. Merely
merging source files does not change the Cloudflare Git connection.

## Gate 0

Run `probe.yml` before trusting any of this. It answers, on all three OSes at
once, the questions the design rests on:

1. Can a hosted runner hold a GET open for 20 / 30 / 50 / 70 seconds against
   `workers.dev`? If not, long-polling is the wrong transport and no application
   design fixes it. Pass `long_get_base` as your deployed broker's origin, whose
   `/probe?wait=` endpoint answers slowly on purpose.
2. Does a background process inheriting the step's stdout hang the step?
3. What is `TERM` on macOS and Windows runners?

## Status

M1: shell only -- `env_create`, `env_status`, `env_list`, `env_destroy`,
`env_extend`, `exec`, `exec_read`, `exec_kill`. File editing in M1 is
`exec` + base64 + `git apply`; dedicated edit tools come in M2.
