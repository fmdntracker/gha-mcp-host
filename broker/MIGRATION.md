# Consolidating gha-mcp under fmdntracker

## Scope of this PR

- Canonical source repository: `fmdntracker/gha-mcp-host`.
- Runner, shared run-agent action (including the new Git authentication setup),
  platform dispatch workflows, tests and licenses stay at the root unchanged.
- Broker source snapshot: `nmt3325/gha-mcp-broker` at `3da8089484f3e5db757aace928bd9f3d8403890e`.
  Runtime `src/`, `test/`, package declarations and third-party attribution are
  copied into `broker/` without rewriting their contents or importing private
  Git history. Source CI and deployment workflows are adapted at the root.
- Runner baseline: `7344b9de444b0fea807e313dfb8a75f1deac2c67`. Previously reverted work branches are not
  reused. The existing `main` and previous branches are not rewritten.
- Only CI / documentation / layout are changed. Existing runner CI is pinned to
  Node 22, uses an explicit test-file glob, and ignores comment-only matches in
  guards whose documentation otherwise made the baseline fail. Broker guards
  likewise ignore comment-only matches and scan implementation/dependencies,
  not the historical rejection note in VENDOR.md.

## Production is a separate, manual operation

This PR does not merge itself, deploy a Worker, update a Cloudflare build
connection, grant permissions, synchronize secrets or archive the old repository.
The existing production configuration remains in place until explicitly changed.

After review and merge, choose ONE deployment path:

1. **Cloudflare Workers Builds:** authorize access to the canonical repository,
   change the production Git source to `fmdntracker/gha-mcp-host` / `main`, and set
   the root directory to `broker/`. The broker build and deploy commands remain
   `npm run typecheck` and `npx wrangler deploy`, relative to that directory.
   Check the provider's dependency-install step uses a compatible npm version;
   Node 22's bundled npm 10.9.8 has an observed `edgesOut` resolver failure with
   this dependency tree. Preview uploads likewise need the `broker/` root.
2. **Manual GitHub workflow:** configure `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` in the canonical repository, then use
   `.github/workflows/broker-deploy.yml` from `main`. It defaults to a dry run,
   pins npm 11.19.1 and deploys only when `dry_run` is explicitly disabled.
   Do not also leave an unintended second automatic deployment path active.

Keep the Cloudflare account, Worker name `gha-mcp`, compatibility settings,
`ENV_DO` / `GUARD_DO` bindings and existing `v1` migration unchanged. No new
Durable Object namespace or migration is required for this directory move.
Keep `GITHUB_OWNER=fmdntracker`, `GITHUB_REPO=gha-mcp-host` and `GITHUB_REF=main`.
Never point dispatch at the contributor fork used to open the PR.

Existing Worker secret values remain in Cloudflare: `GITHUB_PAT_DISPATCH`,
`BROKER_SECRET` and `MCP_AUTH_TOKEN`. Existing runner repository secrets remain
where they are. No secret values belong in Git or this document. The manual
workflow deliberately does not upload or overwrite Worker secrets.

Validate `/healthz`, MCP authentication, and create / exec / read / destroy on
Linux, macOS and Windows after a separately authorized cutover. Local checks
and a dry-run bundle are not evidence that a live production cutover succeeded.
Only then consider archiving the old broker repository as a separate action.

## Rollback after a future deployment

If a future cutover fails, restore the prior Cloudflare source / root settings
or roll back to the previously deployed Worker version. Preserve the existing
secrets and Durable Objects. Reverting Git alone does not undo a Cloudflare
configuration change. For this PR before merge, simply close the PR; production
has not been changed.

## Validation limitation inherited from the source

The broker has no Vitest test files. The preserved `test/e2e.sh` still contains
an assertion for the removed deny layer; it is not counted as passed validation
and should be refreshed before it is used as an acceptance gate.
