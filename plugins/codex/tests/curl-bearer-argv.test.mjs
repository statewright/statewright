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
const REPO = resolve(TEST_DIR, "../../..");

const PLUGIN_SCRIPTS = [
  { plugin: "codex", rels: ["hook.sh", "mcp-proxy.sh", "capture.sh"] },
  { plugin: "claude-code", rels: ["hook.sh", "mcp-proxy.sh", "capture.sh", "skills/statewright/run.sh", "examples/statusline.sh"] },
  { plugin: "cursor", rels: ["hook.sh", "mcp-proxy.sh"] },
  { plugin: "executor", rels: ["mcp-proxy.sh"] },
].flatMap(({ plugin, rels }) => rels.map((rel) => ({
  plugin,
  rel,
  path: join(REPO, "plugins", plugin, rel),
})));

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

function rpc(messages) {
  return messages.map((message) => JSON.stringify(message)).join("\n") + "\n";
}

test("plugin curl callers do not put a bearer token in curl argv", async () => {
  for (const { path } of PLUGIN_SCRIPTS) {
    const source = await readFile(path, "utf8");
    assert.match(source, /statewright_bearer_config\(\)/, path);
    const rest = stripBearerHelper(source);
    assert.doesNotMatch(rest, /Authorization:\s*Bearer/, `${path} still has Authorization: Bearer outside the curl config helper`);
    assert.match(source, /-K <\([\s\S]*?statewright_bearer_config/, `${path} should pass bearers through -K`);
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
    // statusline.sh and some hooks wrap curl in `timeout`; ignore the duration.
    await writeFile(join(bin, "timeout"), `#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
  case "$1" in
    -*) shift ;;
    *) break ;;
  esac
done
shift
exec "$@"
`, { mode: 0o755 });
    await chmod(join(bin, "timeout"), 0o755);

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

    const argvCount = async () => {
      try {
        const raw = await readFile(argvLog, "utf8");
        return raw.trim() ? raw.trim().split("\n").length : 0;
      } catch {
        return 0;
      }
    };

    const invoke = async (label, command, args, { env = {}, stdin = "", cwd } = {}) => {
      const before = await argvCount();
      const result = await run(command, args, { env: { ...baseEnv, ...env }, stdin, cwd });
      assert.equal(result.code, 0, `${label}: ${result.stderr || result.stdout}`);
      const after = await argvCount();
      assert.ok(after > before, `${label} should invoke curl`);
      return result;
    };

    const runProxy = (label, script, env, messages) => invoke(
      label,
      "bash",
      [script],
      { env, stdin: rpc(messages), cwd: dirname(script) },
    );

    const listOnly = [{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }];
    const handshake = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ];

    const setupCaptureSession = async (plugin, identityArgs, hookInput) => {
      const pluginDir = join(REPO, "plugins", plugin);
      const identity = await run("bash", ["-c", 'source "$1"; statewright_client_id "$@"', "_", join(pluginDir, "client-id.sh"), ...identityArgs], {
        env: { ...baseEnv, STATEWRIGHT_CLIENT_ID: `${plugin}-bearer-argv-fixture` },
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
      return { pluginDir, hookInput, clientEnv: { STATEWRIGHT_CLIENT_ID: `${plugin}-bearer-argv-fixture` } };
    };

    const hookInput = JSON.stringify({
      thread_id: "fixture-thread",
      session_id: "fixture-session",
      tool_name: "Bash",
      tool_input: {},
      tool_response: "ok",
    }) + "\n";

    const codexSession = await setupCaptureSession("codex", ["codex", "fixture-thread"], hookInput);
    await invoke("codex capture.sh", "bash", [join(codexSession.pluginDir, "capture.sh")], {
      env: codexSession.clientEnv,
      stdin: hookInput,
      cwd: codexSession.pluginDir,
    });
    await invoke("codex hook.sh post-tool", "bash", [join(codexSession.pluginDir, "hook.sh"), "post-tool"], {
      env: codexSession.clientEnv,
      stdin: hookInput,
      cwd: codexSession.pluginDir,
    });
    await runProxy("codex mcp-proxy adapter", join(REPO, "plugins/codex/mcp-proxy.sh"), {
      STATEWRIGHT_ADAPTER_URL: "http://127.0.0.1:9",
      STATEWRIGHT_ADAPTER_TOKEN: FAKE_TOKEN,
      STATEWRIGHT_MANAGED_MCP_URL: "",
      STATEWRIGHT_MANAGED_MCP_TOKEN: "",
      STATEWRIGHT_MANAGED_MCP_BEARER: "",
    }, listOnly);
    await runProxy("codex mcp-proxy gateway", join(REPO, "plugins/codex/mcp-proxy.sh"), {
      STATEWRIGHT_ADAPTER_URL: "",
      STATEWRIGHT_ADAPTER_TOKEN: "",
      STATEWRIGHT_MANAGED_MCP_URL: "",
      STATEWRIGHT_MANAGED_MCP_TOKEN: "",
      STATEWRIGHT_MANAGED_MCP_BEARER: "",
    }, handshake);
    await runProxy("codex mcp-proxy managed", join(REPO, "plugins/codex/mcp-proxy.sh"), {
      STATEWRIGHT_ADAPTER_URL: "",
      STATEWRIGHT_ADAPTER_TOKEN: "",
      STATEWRIGHT_MANAGED_MCP_URL: "http://127.0.0.1:9",
      STATEWRIGHT_MANAGED_MCP_BEARER: FAKE_TOKEN,
    }, listOnly);

    const claudeSession = await setupCaptureSession("claude-code", ["fixture-session"], hookInput);
    await invoke("claude-code capture.sh", "bash", [join(claudeSession.pluginDir, "capture.sh")], {
      env: claudeSession.clientEnv,
      stdin: hookInput,
      cwd: claudeSession.pluginDir,
    });
    await invoke("claude-code hook.sh post-tool", "bash", [join(claudeSession.pluginDir, "hook.sh"), "post-tool"], {
      env: {
        ...claudeSession.clientEnv,
        STATEWRIGHT_ADAPTER_URL: "http://127.0.0.1:9",
        STATEWRIGHT_ADAPTER_TOKEN: FAKE_TOKEN,
      },
      stdin: hookInput,
      cwd: claudeSession.pluginDir,
    });
    await runProxy("claude-code mcp-proxy adapter", join(REPO, "plugins/claude-code/mcp-proxy.sh"), {
      STATEWRIGHT_ADAPTER_URL: "http://127.0.0.1:9",
      STATEWRIGHT_ADAPTER_TOKEN: FAKE_TOKEN,
      STATEWRIGHT_MANAGED_MCP_URL: "",
      STATEWRIGHT_MANAGED_MCP_TOKEN: "",
    }, listOnly);
    await runProxy("claude-code mcp-proxy gateway", join(REPO, "plugins/claude-code/mcp-proxy.sh"), {
      STATEWRIGHT_ADAPTER_URL: "",
      STATEWRIGHT_ADAPTER_TOKEN: "",
      STATEWRIGHT_MANAGED_MCP_URL: "",
      STATEWRIGHT_MANAGED_MCP_TOKEN: "",
    }, handshake);
    await runProxy("claude-code mcp-proxy managed", join(REPO, "plugins/claude-code/mcp-proxy.sh"), {
      STATEWRIGHT_ADAPTER_URL: "",
      STATEWRIGHT_ADAPTER_TOKEN: "",
      STATEWRIGHT_MANAGED_MCP_URL: "http://127.0.0.1:9",
      STATEWRIGHT_MANAGED_MCP_TOKEN: FAKE_TOKEN,
    }, listOnly);
    await invoke("claude-code run.sh list", "bash", [join(REPO, "plugins/claude-code/skills/statewright/run.sh"), "list"], {
      cwd: join(REPO, "plugins/claude-code"),
    });
    await invoke("claude-code statusline.sh", "bash", [join(REPO, "plugins/claude-code/examples/statusline.sh")], {
      stdin: "{}\n",
      cwd: join(REPO, "plugins/claude-code/examples"),
    });

    await runProxy("cursor mcp-proxy gateway", join(REPO, "plugins/cursor/mcp-proxy.sh"), {
      STATEWRIGHT_ADAPTER_URL: "",
      STATEWRIGHT_ADAPTER_TOKEN: "",
    }, handshake);
    await runProxy("cursor mcp-proxy adapter", join(REPO, "plugins/cursor/mcp-proxy.sh"), {
      STATEWRIGHT_ADAPTER_URL: "http://127.0.0.1:9",
      STATEWRIGHT_ADAPTER_TOKEN: FAKE_TOKEN,
    }, listOnly);
    await invoke("cursor hook.sh stop", "bash", [join(REPO, "plugins/cursor/hook.sh"), "stop"], {
      env: {
        STATEWRIGHT_ADAPTER_URL: "http://127.0.0.1:9",
        STATEWRIGHT_ADAPTER_TOKEN: FAKE_TOKEN,
      },
      stdin: "{}\n",
      cwd: join(REPO, "plugins/cursor"),
    });

    await runProxy("executor mcp-proxy adapter", join(REPO, "plugins/executor/mcp-proxy.sh"), {
      STATEWRIGHT_ADAPTER_URL: "http://127.0.0.1:9",
      STATEWRIGHT_ADAPTER_TOKEN: FAKE_TOKEN,
    }, listOnly);
    await runProxy("executor mcp-proxy gateway", join(REPO, "plugins/executor/mcp-proxy.sh"), {
      STATEWRIGHT_ADAPTER_URL: "",
      STATEWRIGHT_ADAPTER_TOKEN: "",
    }, handshake);

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
    for (const { path: script } of PLUGIN_SCRIPTS) {
      const result = await run("bash", [driverPath, script], { env: { PATH: process.env.PATH, HOME: home, LANG: "C" } });
      assert.equal(result.code, 0, `${script}: ${result.stderr || result.stdout}`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
