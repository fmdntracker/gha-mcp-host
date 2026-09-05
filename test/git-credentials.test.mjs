import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Exercise the actual action setup, not a second implementation of its quoting.
// Stop before the PAT branch: these tests use only synthetic offline credentials.
// Git's Windows checkout can use CRLF; parse logical YAML lines on every OS.
const action = fs.readFileSync(new URL("../.github/actions/run-agent/action.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const name = "    - name: Install PAT credentials without exposing the token to commands\n";
assert.equal(action.split(name).length, 2, "credential setup step must be unique");
const step = action.split(name)[1].split("\n    - name: ")[0];
const run = step.split("      run: |\n")[1];
assert.ok(run, "credential setup must be a literal shell block");
const script = run.split("\n").map(line => line.startsWith("        ") ? line.slice(8) : line).join("\n");
const stop = 'if [ -n "${GHA_MCP_PAT:-}" ]; then';
assert.equal(script.split(stop).length, 2, "PAT boundary must be unique");
const setup = script.split(stop)[0];
assert.ok(setup.includes("credential.helper"));

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(GIT_|GCM_|GH_|GHA_MCP_)/.test(key) || key === "GITHUB_TOKEN") delete env[key];
  }
  return env;
}

function exec(command, args, options) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 15000, windowsHide: true, ...options });
  assert.equal(result.error, undefined, "subprocess must start");
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout;
}

// Use the Git for Windows Bash, not an unrelated WSL bash on PATH.
let bash = "bash";
if (process.platform === "win32") {
  const gitExec = exec("git", ["--exec-path"], { env: cleanEnv() }).trim();
  bash = path.resolve(gitExec, "../../..", "bin/bash.exe");
}

for (const folder of ["plain", "path with spaces", "quote' and $cash"]) {
  test(`credential helper reads its store from ${folder}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gha-credential-test-"));
    try {
      const temp = path.join(root, folder);
      fs.mkdirSync(temp);
      const empty = path.join(root, "empty-config");
      fs.writeFileSync(empty, "");
      const scriptPath = path.join(root, "setup.sh");
      fs.writeFileSync(scriptPath, setup);
      const env = {
        ...cleanEnv(),
        RUNNER_TEMP: temp,
        RUNNER_OS: { linux: "Linux", darwin: "macOS", win32: "Windows" }[process.platform],
        GITHUB_ENV: path.join(root, "github-env"),
        GIT_CONFIG_SYSTEM: empty,
        GIT_CONFIG_GLOBAL: empty,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      };
      exec(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", scriptPath], { cwd: root, env });
      const store = path.join(temp, "gha-mcp-credentials");
      assert.equal(fs.readFileSync(store, "utf8"), "", "setup must not read or install a real token");
      fs.writeFileSync(store, "https://fixture-user:fixture-password@credentials.invalid\n", { mode: 0o600 });
      env.GIT_CONFIG_GLOBAL = path.join(temp, "gha-mcp-gitconfig");
      // credential fill only queries the isolated local helper; it makes no HTTP request.
      const answer = exec("git", ["credential", "fill"], {
        cwd: root, env, input: "protocol=https\nhost=credentials.invalid\n\n",
      });
      const fields = answer.trim().split(/\r?\n/);
      assert.ok(fields.includes("username=fixture-user"));
      assert.ok(fields.includes("password=fixture-password"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
