import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
await build({
  absWorkingDir: here,
  entryPoints: ["server.mjs"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  nodePaths: [resolve(here, "node_modules")],
  alias: {
    "cloudflare:workers": resolve(here, "durable.mjs"),
    "agents/mcp/server": resolve(here, "mcp-adapter.mjs"),
  },
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  legalComments: "linked",
  logLevel: "info",
})
