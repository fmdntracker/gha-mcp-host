# Monorepo migration — 2026-09-05

The authoritative Git repository is now `fmdntracker/gha-mcp-host`:

- Runner entry point, libraries and dispatch workflows stay at the root.
- Cloudflare Worker source, configuration, tests and attribution live in `broker/`.
- Broker CI and the optional manual deployment workflow live in the root `.github/workflows/`.

## Provenance

Imported from `nmt3325/gha-mcp-broker` at commit
`3da8089484f3e5db757aace928bd9f3d8403890e`. Runtime source files, test fixtures and
upstream licence text are copied without changes. The old repository is retained
for history and rollback, not deleted. No credentials are copied into Git.

## Cloudflare cutover

Authorize the Cloudflare GitHub App for **fmdntracker/gha-mcp-host only**, then point
the existing `gha-mcp` Worker's production and preview Builds triggers at this
repository. Keep the existing build token and runtime secrets.

| Setting | Value |
| --- | --- |
| Repository | `fmdntracker/gha-mcp-host` |
| Root directory | `/broker` |
| Build command | `npm run typecheck` |
| Production branch | `main` |
| Production deploy command | `npx wrangler deploy` |
| Preview deploy command | `npx wrangler versions upload` |
| Build watch paths | `broker/**` |

Keep the Worker name, Cloudflare account, URL, `EnvDO` / `GuardDO` bindings and `v1`
DO migration unchanged. Preserve `GITHUB_PAT_DISPATCH`, `BROKER_SECRET` and
`MCP_AUTH_TOKEN` on the Worker, and the existing runner repository secrets.
Do not deploy both repository connections as competing sources.

A missing GitHub App authorization can block the build-source change without
interrupting the currently deployed Worker. Do not disconnect the old build source
until the new connection is usable. The repository migration does not itself prove
that production has switched; verify the new build's repository, commit and outcome.

## Verification

From the repository root:

```sh
node --test test/*.test.mjs
cd broker
npm install --no-audit --no-fund
npm run typecheck
npx vitest run --passWithNoTests
npx wrangler deploy --dry-run
```

The broker currently has no Vitest cases; a successful no-tests run is not an e2e
pass. After cutover, provision and operate a fresh Linux, macOS and Windows runner,
and destroy only the temporary environments created for that check.

## Rollback

If the new source cannot build, keep the existing deployment. If a deployed
version regresses, roll back the existing Worker to its preceding version; do not
create a new Worker or new DO namespace. If necessary, restore the old Builds
repository/root (`nmt3325/gha-mcp-broker`, `/`) and previous trigger settings.
Disable the competing source before re-enabling the old one. No runtime secret
rotation is required merely because source files moved.

## Optional manual deploy

`broker-deploy.yml` defaults to a dry run. Real deployment is restricted to `main`
and requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.
The normal Workers Builds path needs neither of these copied to GitHub. This
workflow intentionally does not run `wrangler secret bulk` or synchronize runner
secrets: existing values stay where they are.
