import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "environment-shell.sh");
const resolver = join(root, "executor/lib/gateway-profile.mjs");
const cleared = [
  "STATEWRIGHT_GATEWAY_URL", "STATEWRIGHT_PB_URL", "STATEWRIGHT_API_KEY",
  "STATEWRIGHT_DOCS_URL", "STATEWRIGHT_CLIENT_ID", "STATEWRIGHT_MCP_SESSION_ID",
  "STATEWRIGHT_ROUTE_CONTROL_DIR", "STATEWRIGHT_MANAGED_CLIENT_HOST",
  "STATEWRIGHT_MANAGED_CLAUDE_ROOT_SESSION_ID", "STATEWRIGHT_MANAGED_CODEX_ROOT_SESSION_ID",
  "STATEWRIGHT_MANAGED_MCP_URL", "STATEWRIGHT_MANAGED_MCP_SESSION_ID",
  "STATEWRIGHT_MANAGED_MCP_TOKEN", "STATEWRIGHT_MANAGED_TELEMETRY_OWNER",
  "STATEWRIGHT_ADAPTER_URL", "STATEWRIGHT_ADAPTER_TOKEN",
];

for (const shell of ["/bin/bash", "/bin/zsh"]) {
  test(`${shell}: environment shortcuts preserve arguments and isolate the child`, async t => {
    try { await access(shell, constants.X_OK); }
    catch (error) {
      if (["ENOENT", "EACCES"].includes(error.code)) return t.skip("shell unavailable");
      throw error;
    }
    // Read before fixture creation: absence of the shipping shell fragment fails.
    await readFile(source);
    const scratch = await mkdtemp(join(tmpdir(), "statewright-claude-shell-"));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const bin = join(scratch, "bin");
    const home = join(scratch, "home");
    await mkdir(bin);
    await mkdir(join(home, ".statewright"), { recursive: true });
    await writeFile(join(home, ".statewright/environments.json"), JSON.stringify({ gateways: {
      staging: { gateway_url: "https://stage.example.test", auth_url: "https://stage-auth.example.test" },
      dev1: { gateway_url: "https://dev1.example.test" },
      dev2: { gateway_url: "https://dev2.example.test" },
    } }));
    // Any password-manager call is a test failure, not a credential lookup.
    await writeFile(join(bin, "gopass"), "#!/bin/sh\necho UNEXPECTED_PASSWORD_LOOKUP >&2\nexit 99\n", { mode: 0o700 });
    await writeFile(join(bin, "claude"), `#!${process.execPath}
import { resolveGatewayProfile } from ${JSON.stringify(resolver)};
try {
  const profile = await resolveGatewayProfile(process.env, process.env.FIXTURE_HOME);
  console.log(JSON.stringify({args: process.argv.slice(2), profile,
    cleared: ${JSON.stringify(cleared)}.filter(key => key in process.env),
    anthropic: process.env.ANTHROPIC_API_KEY, selected: process.env.STATEWRIGHT_ENV}));
  process.exitCode = 23;
} catch (error) { console.error(error.message); process.exitCode = 42; }
`, { mode: 0o700 });
    const env = {
      PATH: bin, FIXTURE_BIN: bin, FIXTURE_HOME: home, ZDOTDIR: scratch,
      ANTHROPIC_API_KEY: "synthetic-native-credential", STATEWRIGHT_ENV: "inherited",
      ...Object.fromEntries(cleared.map(key => [key, "synthetic-stale-value"])),
    };
    const shellOptions = shell.endsWith("bash") ? ["--noprofile", "--norc"] : ["-f"];
    const launch = name => spawnSync(shell, [...shellOptions, "-c", `
# Never resolve a real client even if a system shell startup file changes PATH.
PATH="$FIXTURE_BIN"
export PATH
# A previously defined alias must not expand inside the new function definitions.
alias sclaude='false'
. "$1"
. "$1"
shift
"$@"
result=$?
[ "$STATEWRIGHT_ENV" = inherited ] || exit 81
[ "$STATEWRIGHT_API_KEY" = synthetic-stale-value ] || exit 82
exit "$result"
`, "fixture", source, name, "--resume", "session with spaces", "--permission-mode", "plan", "--desktop", "", "*", "literal $(false)"],
    { env, encoding: "utf8", timeout: 5000 });

    for (const [name, profileName, gateway] of [
      ["claude", "production", "https://mcp.statewright.ai/mcp"],
      ["sclaude", "staging", "https://stage.example.test/mcp"],
      ["d1claude", "dev1", "https://dev1.example.test/mcp"],
      ["d2claude", "dev2", "https://dev2.example.test/mcp"],
    ]) {
      const result = launch(name);
      assert.equal(result.status, 23, result.stderr);
      assert.equal(result.stderr, "");
      const recorded = JSON.parse(result.stdout);
      assert.deepEqual(recorded.args, ["--resume", "session with spaces", "--permission-mode", "plan", "--desktop", "", "*", "literal $(false)"]);
      assert.equal(recorded.profile.name, profileName);
      assert.equal(recorded.profile.gatewayUrl, gateway);
      assert.equal(recorded.anthropic, "synthetic-native-credential");
      assert.deepEqual(recorded.cleared, []);
    }
    const missing = launch("d3claude");
    assert.equal(missing.status, 42);
    assert.match(missing.stderr, /environment 'dev3' is not configured/);
    assert.equal(missing.stdout, "");
    await writeFile(join(home, ".statewright/environments.json"), JSON.stringify({
      gateways: { dev3: { gateway_url: "https://dev3.example.test" } },
    }));
    const configured = launch("d3claude");
    assert.equal(configured.status, 23, configured.stderr);
    assert.equal(JSON.parse(configured.stdout).profile.gatewayUrl, "https://dev3.example.test/mcp");
  });
}
