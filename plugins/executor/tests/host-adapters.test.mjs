import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  buildHostLaunch,
  hostRoutingMode,
  hostRequiresTerminalStop,
  hostSupportsLiveRouting,
  prepareHostSession,
  SUPPORTED_HOSTS,
  createPiNativeSession,
  assertPiNativeSession,
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
  hostSessionFile: "/private/native-thread.jsonl",
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
  assert.deepEqual(pi.args.slice(0, 2), ["--session", "/private/native-thread.jsonl"]);
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

test("resume uses the owned Claude thread and never creates a replacement Cursor chat", async () => {
  const claude = buildHostLaunch({ ...base, host: "claude", resumeWorkflow: true }, state);
  assert.ok(claude.args.includes("--resume"));
  assert.ok(!claude.args.includes("--session-id"));
  assert.equal(await prepareHostSession({ ...base, host: "cursor", resumeWorkflow: true }, "owned-chat",
    async () => { assert.fail("resume must not create a chat"); }), "owned-chat");
});

test("native-session overrides cannot retarget executor ownership", () => {
  for (const arg of ["--session", "--session-id", "--session=/foreign/thread.jsonl", "--resume", "-r", "--fork", "--no-session"]) {
    assert.throws(() => buildHostLaunch({ ...base, host: "pi", hostArgs: [arg] }, state), /owns native-session/);
  }
  assert.throws(() => buildHostLaunch({ ...base, host: "pi", hostSessionFile: null }, state), /exact owned/);
});

const challenge = { schema: "statewright/native-readiness-challenge/v1",
  executor_session_id: randomUUID(), native_session_id: randomUUID(),
  native_session_file: "/private/owned.jsonl", parent_lifetime_id: randomUUID(), child_lifetime_id: randomUUID() };
const ownedPi = { ...base, host: "pi", piRequestFrontend: true, piAgentDir: "/private/agent",
  hostSessionId: challenge.native_session_id, hostSessionFile: challenge.native_session_file,
  nativeReadiness: { challenge }, environment: { PATH: "/bin", STATEWRIGHT_PI_REQUEST_LAUNCH: "foreign" } };

test("owned Pi launches the fixed Node SDK frontend with private exact configuration", () => {
  const launch = buildHostLaunch(ownedPi, state);
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, ["/statewright/plugins/pi/request-main.mjs", "--thinking", "medium", "--", "Fix it"]);
  const config = JSON.parse(launch.environment.STATEWRIGHT_PI_REQUEST_LAUNCH);
  assert.deepEqual(config, { schema: "statewright/pi-request-launch/v1", challenge,
    cwd: "/repo", agent_dir: "/private/agent", model: { provider: "openai", id: "gpt-5.6-terra" } });
  assert.equal(launch.environment.PATH, "/bin");
});

test("owned Pi rejects stock executable/arguments and ambiguous routed models", () => {
  for (const changes of [{ hostBin: "pi" }, { hostArgs: ["--extension", "/foreign.ts"] },
    { hostSessionFile: "/foreign.jsonl" }, { piAgentDir: "relative" }]) {
    assert.throws(() => buildHostLaunch({ ...ownedPi, ...changes }, state), /owned Pi|Owned Pi/);
  }
  for (const model of [null, "gpt-5.6-terra", {}, ["openai/gpt-5.6-terra"], "openai/"]) {
    assert.throws(() => buildHostLaunch(ownedPi, { ...state, model }), /model/);
  }
  assert.throws(() => buildHostLaunch({ ...base, host: "claude", piRequestFrontend: true }, state), /owned Pi|Owned Pi/);
});

test("Pi SDK native header is ownership-checked and malformed history is never repaired", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = randomUUID();
  const pluginsRoot = fileURLToPath(new URL("../../", import.meta.url));
  const file = await createPiNativeSession({ pluginsRoot, cwd: root, sessionDir: root, sessionId });
  await assertPiNativeSession({ sessionFile: file, sessionId, cwd: root });
  const original = await readFile(file, "utf8");
  const malformedEntry = (id, parentId, extra = {}) => original + JSON.stringify({ type: "thinking_level_change", id, parentId,
    timestamp: new Date().toISOString(), thinkingLevel: "off", ...extra }) + "\n";
  for (const raw of ["", "{}\n", "invalid-json\n", original.replace(sessionId, randomUUID()),
    original.replace('"version":3', '"version":999'), original + "not-json\n", original + "null\n",
    original + original.replace(sessionId, randomUUID()), original + '{"type":"message"}\n',
    malformedEntry("self", "self"), malformedEntry("child", "missing"), malformedEntry("row", null, { thinkingLevel: null })]) {
    await writeFile(file, raw);
    await assert.rejects(assertPiNativeSession({ sessionFile: file, sessionId, cwd: root }));
    assert.equal(await readFile(file, "utf8"), raw);
  }
});

test("OMX config flags are not Pi session-selection aliases", () => {
  assert.doesNotThrow(() => buildHostLaunch({ ...base, host: "omx", hostArgs: ["-c", 'ui.theme="dark"'] }, state));
});
