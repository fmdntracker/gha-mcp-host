# Self-hosted broker

See [SELF_HOSTING.md](../../SELF_HOSTING.md) for the complete Japanese setup,
Cloudflare cutover, HTTPS, GHCR publication, persistence and backup guide.

```bash
# Run from the repository root:
cp .env.example .env
# Fill in PUBLIC_URL, GITHUB_PAT_DISPATCH, BROKER_SECRET and MCP_AUTH_TOKEN.
docker compose -f compose.yaml -f compose.build.yaml up -d --build --wait
```

This is Node.js 24 + native SQLite, not a Wrangler/Miniflare development server.
The runner still executes on GitHub Actions; only the broker moves home.
The image is built automatically on relevant pushes to main and version tags.
