import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHostLaunch,
  hostRoutingMode,
  hostRequiresTerminalStop,
  hostSupportsLiveRouting,
  prepareHostSession,
  SUPPORTED_HOSTS,
} from "../lib/host-adapters.mjs";

const state = {
  state: "implementing",
  model: "openai/gpt-5.6-terra",
  thinking_level: "medium",
};
const base = {
  cwd: "/repo",
  prompt: "Fix it",
  hostSessionId: "session-1",
  hostArgs: [],
  pluginsRoot: "/statewright/plugins",
};

test("every supported TUI has an executor launch contract", () => {
  assert.deepEqual(SUPPORTED_HOSTS, ["pi", "claude", "opencode", "cursor", "omx"]);
  for (const host of SUPPORTED_HOSTS) {
    const launch = buildHostLaunch({ ...base, host }, state);
    assert.ok(launch.command);
    assert.ok(launch.args.includes("Fix it") || launch.args.includes("--prompt"));
  }
});

test("hosts use the strongest available workflow routing boundary", () => {
  assert.equal(hostSupportsLiveRouting("pi"), true);
  assert.equal(hostSupportsLiveRouting("opencode"), true);
  assert.equal(hostSupportsLiveRouting("claude"), false);
  assert.equal(hostRoutingMode("claude"), "restart");
  assert.equal(hostRoutingMode("cursor"), "restart");

  const pi = buildHostLaunch({ ...base, host: "pi" }, state);
  assert.deepEqual(pi.args.slice(0, 2), ["--session-id", "session-1"]);
  assert.ok(pi.args.includes("--no-extensions"));
  assert.ok(pi.args.includes("openai/gpt-5.6-terra"));
  assert.ok(pi.args.includes("medium"));
  assert.ok(pi.args.includes("/statewright/plugins/pi/src/index.ts"));

  const opencode = buildHostLaunch({ ...base, host: "opencode" }, state);
  assert.deepEqual(opencode.args.slice(0, 4), ["run", "--interactive", "--dir", "/repo"]);
  assert.ok(opencode.args.includes("openai/gpt-5.6-terra"));
  assert.ok(opencode.args.includes("medium"));

  const claude = buildHostLaunch({ ...base, host: "claude" }, state, true);
  assert.ok(claude.args.includes("--resume"));
  assert.ok(!claude.args.includes("--session-id"));
  assert.ok(!claude.args.includes("--effort"));

  const cursor = buildHostLaunch({ ...base, host: "cursor" }, state);
  assert.deepEqual(
    cursor.args.slice(cursor.args.indexOf("--resume"), cursor.args.indexOf("--resume") + 2),
    ["--resume", "session-1"],
  );

  const omx = buildHostLaunch({ ...base, host: "omx" }, state);
  assert.ok(omx.args.includes("gpt-5.6-terra"));
  assert.ok(omx.args.some((arg) => arg.includes("model_reasoning_effort")));
  assert.ok(!omx.args.includes("--plugin-dir"));
  assert.ok(omx.args.includes('mcp_servers.statewright.command="bash"'));
  assert.ok(omx.args.some((arg) => arg.includes("plugins/executor/mcp-proxy.sh")));
  assert.ok(omx.args.includes(
    'mcp_servers.statewright.env_vars=["STATEWRIGHT_ADAPTER_URL","STATEWRIGHT_ADAPTER_TOKEN"]',
  ));
});

test("OMX waits for the Codex terminal hook after its wrapper exits", () => {
  assert.equal(hostRequiresTerminalStop("omx"), true);
  assert.equal(hostRequiresTerminalStop("claude"), false);
});

test("Cursor sessions are executor-owned and resumable", async () => {
  const calls = [];
  const id = await prepareHostSession({
    ...base,
    host: "cursor",
    hostBin: "cursor-agent",
    environment: { PATH: "/bin" },
  }, "fallback", async (...args) => {
    calls.push(args);
    return { stdout: "chat_123\n" };
  });
  assert.equal(id, "chat_123");
  assert.deepEqual(calls[0].slice(0, 2), ["cursor-agent", ["create-chat"]]);
  const keychainError = new Error("SecItemCopyMatching failed -25300");
  keychainError.stdout = "9b6abd72-de88-41dc-8c05-685c3bbae4a4\n";
  assert.equal(
    await prepareHostSession({ ...base, host: "cursor" }, "fallback", async () => {
      throw keychainError;
    }),
    "9b6abd72-de88-41dc-8c05-685c3bbae4a4",
  );
  assert.equal(
    await prepareHostSession({ ...base, host: "pi" }, "pi-session"),
    "pi-session",
  );
});
