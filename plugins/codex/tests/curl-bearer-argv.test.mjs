import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Obviously fake credentials, not sw_-shaped, so a secret scanner needs no allowlist.
const FAKE_TOKEN = "FAKE-bearer-argv-token";
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(TEST_DIR, "..");
const SCRIPTS = ["hook.sh", "mcp-proxy.sh", "capture.sh"].map((name) => join(PLUGIN, name));

function stripBearerHelper(source) {
  return source.replace(/statewright_bearer_config\(\) \{[\s\S]*?\n\}\n/, "");
}

function run(command, args, { env = {}, stdin = "", cwd } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

test("hook.sh, mcp-proxy.sh and capture.sh do not put a bearer token in curl argv", async () => {
  for (const path of SCRIPTS) {
    const source = await readFile(path, "utf8");
    assert.match(source, /statewright_bearer_config\(\)/, path);
    const rest = stripBearerHelper(source);
    assert.doesNotMatch(rest, /Authorization:\s*Bearer/, `${path} still has Authorization: Bearer outside the curl config helper`);
    assert.match(source, /-K <\(statewright_bearer_config/, `${path} should pass bearers through -K`);
  }

  const home = await mkdtemp(join(tmpdir(), "statewright-bearer-argv-"));
  const bin = join(home, "bin");
  const argvLog = join(home, "curl-argv.jsonl");
  try {
    await mkdir(bin);
    await mkdir(join(home, ".statewright"), { recursive: true });
    await writeFile(join(home, ".statewright", "api_key"), `${FAKE_TOKEN}\n`, { mode: 0o600 });
    // Stub curl records argv only and never copies -K config contents into the log.
    await writeFile(join(bin, "curl"), `#!/usr/bin/env python3
import json, os, sys
log = os.environ["CURL_ARGV_LOG"]
with open(log, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(sys.argv[1:]) + "\\n")
out_path = None
write_out = None
args = sys.argv[1:]
i = 0
while i < len(args):
    arg = args[i]
    if arg in ("-o", "--output") and i + 1 < len(args):
        out_path = args[i + 1]
        i += 2
        continue
    if arg in ("-w", "--write-out") and i + 1 < len(args):
        write_out = args[i + 1]
        i += 2
        continue
    if arg in ("-X", "--request", "-H", "--header", "--max-time", "-d", "--data", "--data-binary",
               "--data-urlencode", "-K", "--config", "-D", "-A", "-o", "-w") and i + 1 < len(args):
        i += 2
        continue
    i += 1
body = json.dumps({"id": "ok", "jsonrpc": "2.0", "result": {"tools": [], "content": [{"type": "text", "text": "ok"}]}})
if out_path:
    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(body)
    sys.stdout.write("200" if write_out and "http_code" in write_out else "")
else:
    sys.stdout.write(body)
    if write_out and "http_code" in write_out:
        sys.stdout.write("\\n200")
`, { mode: 0o755 });
    await chmod(join(bin, "curl"), 0o755);

    const pathEnv = `${bin}:${process.env.PATH || "/usr/bin:/bin"}`;
    const baseEnv = {
      PATH: pathEnv,
      HOME: home,
      USER: "bearer-argv-test",
      LANG: "C",
      LC_ALL: "C",
      CURL_ARGV_LOG: argvLog,
      STATEWRIGHT_API_KEY: FAKE_TOKEN,
      STATEWRIGHT_PB_URL: "http://127.0.0.1:9",
      STATEWRIGHT_GATEWAY_URL: "http://127.0.0.1:9",
      STATEWRIGHT_NO_BROWSER: "true",
      STATEWRIGHT_NO_UPDATE_CHECK: "1",
      STATEWRIGHT_SENTRY_DISABLED: "true",
      STATEWRIGHT_CLIENT_ID: "swc_fixture",
    };

    const identity = await run("bash", ["-c", `source "$1"; statewright_client_id codex fixture-thread`, "_", join(PLUGIN, "client-id.sh")], {
      env: { ...baseEnv, STATEWRIGHT_CLIENT_ID: "hook-bearer-argv-fixture" },
    });
    assert.equal(identity.code, 0, identity.stderr);
    const clientId = identity.stdout.trim();
    const sessionKey = clientId.replace(/^swc_/, "").slice(0, 16);
    const sessionDir = join(home, ".statewright", "sessions", sessionKey);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, ".capture_enabled"), "");
    await writeFile(join(sessionDir, ".active"), "");
    await writeFile(join(sessionDir, ".state_cache"), JSON.stringify({
      state: "intake",
      run_id: "run-fake",
      run_session_id: "session-fake",
      workflow: "fake-workflow",
      allowed_tools: ["Bash"],
      transitions: [],
    }));

    const hookInput = JSON.stringify({
      thread_id: "fixture-thread",
      tool_name: "Bash",
      tool_input: {},
      tool_response: "ok",
    }) + "\n";

    const capture = await run("bash", [join(PLUGIN, "capture.sh")], { env: baseEnv, stdin: hookInput, cwd: PLUGIN });
    assert.equal(capture.code, 0, capture.stderr || capture.stdout);

    const hook = await run("bash", [join(PLUGIN, "hook.sh"), "post-tool"], {
      env: { ...baseEnv, STATEWRIGHT_CLIENT_ID: "hook-bearer-argv-fixture" },
      stdin: hookInput,
      cwd: PLUGIN,
    });
    assert.equal(hook.code, 0, hook.stderr || hook.stdout);

    const adapter = await run("bash", [join(PLUGIN, "mcp-proxy.sh")], {
      env: {
        ...baseEnv,
        STATEWRIGHT_ADAPTER_URL: "http://127.0.0.1:9",
        STATEWRIGHT_ADAPTER_TOKEN: FAKE_TOKEN,
        STATEWRIGHT_MANAGED_MCP_URL: "",
        STATEWRIGHT_MANAGED_MCP_TOKEN: "",
      },
      stdin: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n",
      cwd: PLUGIN,
    });
    assert.equal(adapter.code, 0, adapter.stderr || adapter.stdout);

    const gateway = await run("bash", [join(PLUGIN, "mcp-proxy.sh")], {
      env: {
        ...baseEnv,
        STATEWRIGHT_ADAPTER_URL: "",
        STATEWRIGHT_ADAPTER_TOKEN: "",
        STATEWRIGHT_MANAGED_MCP_URL: "",
        STATEWRIGHT_MANAGED_MCP_TOKEN: "",
      },
      stdin: [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      ].join("\n") + "\n",
      cwd: PLUGIN,
    });
    assert.equal(gateway.code, 0, gateway.stderr || gateway.stdout);

    const raw = await readFile(argvLog, "utf8");
    assert.notEqual(raw.trim(), "", "stub curl should have been invoked");
    const invocations = raw.trim().split("\n").map((line) => JSON.parse(line));
    for (const args of invocations) {
      for (const arg of args) {
        assert.doesNotMatch(arg, /Authorization:\s*Bearer/, `bearer header leaked into curl argv: ${args.length} args`);
        assert.doesNotMatch(arg, new RegExp(FAKE_TOKEN), "fake token leaked into curl argv");
      }
    }
    const authenticated = invocations.filter((args) => args.includes("-K") || args.includes("--config"));
    assert.ok(authenticated.length > 0, "expected at least one curl invocation to use -K");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("statewright_bearer_config rejects CR and newline before they reach a curl config", async () => {
  const driver = `#!/usr/bin/env bash
set -euo pipefail
script="$1"
eval "$(sed -n '/^statewright_bearer_config()/,/^}/p' "$script")"
if out=$(statewright_bearer_config $'ok-token\\ninjected'); then
  echo "newline should have been rejected" >&2
  exit 1
fi
test -z "$out"
if out=$(statewright_bearer_config $'ok-token\\rinjected'); then
  echo "cr should have been rejected" >&2
  exit 1
fi
test -z "$out"
out=$(statewright_bearer_config "FAKE-clean-token")
test "$out" = $'header = "Authorization: Bearer FAKE-clean-token"'
`;
  const home = await mkdtemp(join(tmpdir(), "statewright-bearer-config-"));
  try {
    const driverPath = join(home, "probe.sh");
    await writeFile(driverPath, driver, { mode: 0o755 });
    for (const script of [join(PLUGIN, "hook.sh"), join(PLUGIN, "mcp-proxy.sh"), join(PLUGIN, "capture.sh")]) {
      const result = await run("bash", [driverPath, script], { env: { PATH: process.env.PATH, HOME: home, LANG: "C" } });
      assert.equal(result.code, 0, `${script}: ${result.stderr || result.stdout}`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
