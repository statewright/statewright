import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { WebSocketServer } from "ws";
import { desktopAppServerLaunchPlan, desktopBrokerEnvironment, desktopClassifierState, desktopProfileEnvironment, desktopThreadAuthorizer, runDesktopAppServerBroker, startDesktopMcpBridge, startProfileDesktopMcpBridge } from "../lib/codex-desktop-app-server-launcher.mjs";
import { adoptCodexRootSession, claimCodexRootSession, readCodexRootSession, resetCodexRootSession } from "../lib/managed-client-identity.mjs";

function fakeMcpBridge(onClose = () => {}) {
  return async () => ({
    url: "http://127.0.0.1:43123",
    token: "desktop-bridge-token",
    close: async () => onClose(),
  });
}

test("Desktop profile binds gateway and keyring independently of inherited shell credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "desktop-keyring-profile-"));
  try {
    await mkdir(join(home, ".statewright"));
    await writeFile(join(home, ".statewright", "environments.json"), JSON.stringify({ gateways: { staging: { gateway_url: "https://stage.example/mcp", auth_url: "https://stage-auth.example" } } }));
    for (const gateway of ["https://mcp.statewright.ai", "https://stage.example", "https://dev.example"]) {
      const state = { gateway_url: gateway, client_id: "swc_0123456789abcdef0123456789abcdef" };
      const inherited = { STATEWRIGHT_API_KEY: "foreign-key", STATEWRIGHT_ENV: "unconfigured", STATEWRIGHT_GATEWAY_URL: "https://foreign.example", STATEWRIGHT_PB_URL: "https://foreign-auth.example", PATH: "/usr/bin" };
      const selected = await desktopProfileEnvironment(state, inherited, home);
      assert.equal(selected.STATEWRIGHT_API_KEY, undefined);
      assert.equal(selected.STATEWRIGHT_ENV, undefined);
      assert.equal(selected.STATEWRIGHT_GATEWAY_URL, `${gateway}/mcp`);
      assert.notEqual(selected.STATEWRIGHT_PB_URL, inherited.STATEWRIGHT_PB_URL);
      if (gateway === "https://stage.example") assert.equal(selected.STATEWRIGHT_PB_URL, "https://stage-auth.example");
      let lookups = 0;
      const result = await startProfileDesktopMcpBridge({ state, environment: inherited, home,
        getCredential: async (requested, options) => {
          lookups++;
          assert.equal(requested, `${gateway}/mcp`);
          assert.equal(options.environment.STATEWRIGHT_API_KEY, undefined);
          return "selected-fixture-key";
        },
        startBridge: async ({ environment, clientId }) => {
          assert.equal(environment.STATEWRIGHT_API_KEY, "selected-fixture-key");
          assert.equal(environment.STATEWRIGHT_GATEWAY_URL, `${gateway}/mcp`);
          assert.equal(clientId, state.client_id);
          return "started";
        },
      });
      assert.equal(result, "started");
      assert.equal(lookups, 1);
      assert.equal(inherited.STATEWRIGHT_API_KEY, "foreign-key");
    }
    await assert.rejects(desktopProfileEnvironment({}, {}, home), /no gateway/);
    await assert.rejects(desktopProfileEnvironment({ gateway_url: "https://user:secret@stage.example" }, {}, home));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Desktop keyring absence or failure never falls back to inherited keys or starts an auth flow", async () => {
  for (const code of ["CREDENTIAL_MISSING", "CREDENTIAL_STORE_UNAVAILABLE", "CREDENTIAL_HELPER_TIMEOUT"]) {
    let starts = 0;
    await assert.rejects(startProfileDesktopMcpBridge({
      state: { gateway_url: "https://stage.example", client_id: "fixture" }, home: "/nonexistent-desktop-fixture",
      environment: { STATEWRIGHT_API_KEY: "wrong-gateway" },
      getCredential: async () => { throw Object.assign(new Error(code), { code }); },
      startBridge: async () => { starts++; },
    }), { code });
    assert.equal(starts, 0);
  }
});

test("Desktop broker is explicit, app-server-only, isolated, and client scoped", () => {
  const environment = {
    STATEWRIGHT_DESKTOP_ORIGINAL_CODEX: "/Applications/ChatGPT.app/Contents/Resources/codex",
    STATEWRIGHT_DESKTOP_CLIENT_ID: "swc_0123456789abcdef0123456789abcdef",
    STATEWRIGHT_ROUTE_CONTROL_DIR: "/tmp/foreign-parent-routes",
  };
  const home = "/tmp/desktop-broker-home";
  assert.deepEqual(desktopAppServerLaunchPlan(["app-server", "--listen", "stdio://"], environment, home), {
    command: environment.STATEWRIGHT_DESKTOP_ORIGINAL_CODEX,
    clientId: "swc_0123456789abcdef0123456789abcdef",
    controlDir: "/tmp/desktop-broker-home/.statewright/codex-desktop-app-server/swc_0123456789abcdef0123456789abcdef/routes",
  });
  assert.throws(() => desktopAppServerLaunchPlan(["app-server"], {}), /ORIGINAL_CODEX/);
  assert.throws(() => desktopAppServerLaunchPlan(["exec"], environment), /app-server invocation/);
  assert.throws(() => desktopAppServerLaunchPlan(["app-server"], { ...environment, STATEWRIGHT_DESKTOP_CLIENT_ID: "desktop-demo" }), /canonical swc/);
});

test("Desktop broker strips parent workflow bridge and writer identity", () => {
  const child = desktopBrokerEnvironment({
    STATEWRIGHT_API_KEY: "keep-user-auth", STATEWRIGHT_CLIENT_ID: "swc_parent",
    STATEWRIGHT_MCP_SESSION_ID: "parent-session", STATEWRIGHT_ROUTE_CONTROL_DIR: "/tmp/parent-control",
    STATEWRIGHT_MANAGED_MCP_URL: "http://127.0.0.1:1000", STATEWRIGHT_MANAGED_MCP_TOKEN: "parent-token",
    STATEWRIGHT_MANAGED_MCP_SESSION_ID: "parent-managed-session", STATEWRIGHT_MANAGED_TELEMETRY_OWNER: "supervisor",
    STATEWRIGHT_MANAGED_CODEX_ROOT_SESSION_ID: "parent-root", STATEWRIGHT_ADAPTER_URL: "http://127.0.0.1:2000",
    STATEWRIGHT_ADAPTER_TOKEN: "adapter-token", CODEX_SESSION_ID: "parent-writer", CODEX_THREAD_ID: "parent-thread",
    LOCAL_MODELS_RUN_DIR: "/tmp/foreign-local-models-run",
  }, { controlDir: "/tmp/desktop-control", clientId: "swc_0123456789abcdef0123456789abcdef" });
  assert.equal(child.STATEWRIGHT_API_KEY, "keep-user-auth");
  assert.equal(child.STATEWRIGHT_CLIENT_ID, "swc_0123456789abcdef0123456789abcdef");
  assert.equal(child.STATEWRIGHT_ROUTE_CONTROL_DIR, "/tmp/desktop-control");
  for (const name of [
    "STATEWRIGHT_MCP_SESSION_ID", "STATEWRIGHT_MANAGED_MCP_URL", "STATEWRIGHT_MANAGED_MCP_TOKEN",
    "STATEWRIGHT_MANAGED_MCP_SESSION_ID", "STATEWRIGHT_MANAGED_TELEMETRY_OWNER",
    "STATEWRIGHT_MANAGED_CODEX_ROOT_SESSION_ID", "STATEWRIGHT_ADAPTER_URL", "STATEWRIGHT_ADAPTER_TOKEN",
    "CODEX_SESSION_ID", "CODEX_THREAD_ID", "LOCAL_MODELS_RUN_DIR",
  ]) assert.equal(child[name], undefined, `${name} must not escape the parent session`);
});

test("Desktop bridge owns gateway authentication outside the App Server sandbox", async () => {
  let started = 0;
  const bridge = await startDesktopMcpBridge({
    environment: { STATEWRIGHT_API_KEY: "desktop-api-key", STATEWRIGHT_GATEWAY_URL: "https://example.test/custom" },
    clientId: "swc_0123456789abcdef0123456789abcdef",
    bridgeFactory: options => {
      assert.deepEqual(options, {
        gatewayUrl: "https://example.test/custom/mcp",
        apiKey: "desktop-api-key",
        clientId: "swc_0123456789abcdef0123456789abcdef",
      });
      return { start: async () => { started += 1; } };
    },
  });
  assert.equal(started, 1);
  assert.ok(bridge);
});

test("Desktop classifier state uses only the selected authenticated bridge", async () => {
  let observed;
  const state = { run_id: "run-one", state: "implement", state_epoch: 2 };
  assert.deepEqual(await desktopClassifierState({
    bridge: { url: "http://127.0.0.1:43123", token: "desktop-token" },
    clientId: "swc_0123456789abcdef0123456789abcdef",
    fetchImpl: async (url, options) => {
      observed = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "fixture",
        result: { structuredContent: state } }));
    },
  }), state);
  assert.equal(observed.url, "http://127.0.0.1:43123/mcp");
  assert.equal(observed.options.headers.Authorization, "Bearer desktop-token");
  assert.equal(observed.options.headers["X-Statewright-Client-Id"], "swc_0123456789abcdef0123456789abcdef");
  assert.equal(observed.body.params.name, "statewright_get_state");
});

test("Desktop broker buffers an immediate stdio request and initializes its private route boundary", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-control-"));
  const codexHome = join(home, "custom-codex-home");
  const historicalThread = "01a0e31b-188e-7a70-91a8-97cbe7107d8b";
  const sessions = join(codexHome, "sessions", "2026", "09", "27");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, `rollout-2026-09-27T09-43-18-${historicalThread}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: historicalThread, cwd: "/repo" } })}\n`);
  await writeFile(join(codexHome, "history.jsonl"), `${JSON.stringify({ session_id: historicalThread, ts: 1, text: "Continue the historical Desktop task" })}\n`);
  const controlDir = join(home, ".statewright", "codex-desktop-app-server", "swc_0123456789abcdef0123456789abcdef", "routes");
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let upstreamSocket = null;
  const received = new Promise(resolve => upstream.once("connection", socket => {
    upstreamSocket = socket;
    socket.once("message", raw => resolve(String(raw)));
  }));
  let closed = 0;
  let bridgeClosed = 0;
  let launch;
  try {
    launch = await runDesktopAppServerBroker({
      argv: ["app-server", "--listen", "stdio://"],
      environment: {
        STATEWRIGHT_DESKTOP_ORIGINAL_CODEX: "/Applications/ChatGPT.app/Contents/Resources/codex",
        STATEWRIGHT_DESKTOP_CLIENT_ID: "swc_0123456789abcdef0123456789abcdef",
        STATEWRIGHT_ROUTE_CONTROL_DIR: "/tmp/foreign-parent-routes",
        CODEX_HOME: codexHome,
      },
      home,
      stdin,
      stdout,
      stderr,
      startMcpBridge: fakeMcpBridge(() => { bridgeClosed += 1; }),
      startRuntime: async options => {
        assert.equal(typeof options.onThreadStarted, "function");
        assert.equal(typeof options.authorizeThread, "function");
        assert.deepEqual(await options.getThreadCwds([historicalThread]), {
          [historicalThread]: { cwd: "/repo", lastUserMessage: "Continue the historical Desktop task", threadSource: null },
        });
        assert.equal(options.requiredMcpToolSuffix, "statewright_get_state");
        assert.equal(options.requiredMcpReadyTimeoutMs, 30_000);
        assert.equal(options.environment.STATEWRIGHT_ROUTE_CONTROL_DIR, controlDir);
        assert.equal(options.environment.STATEWRIGHT_MANAGED_CLIENT_HOST, "codex");
        assert.equal(options.environment.STATEWRIGHT_CLIENT_ID, "swc_0123456789abcdef0123456789abcdef");
        assert.equal(options.environment.STATEWRIGHT_MANAGED_MCP_URL, "http://127.0.0.1:43123");
        assert.equal(options.environment.STATEWRIGHT_MANAGED_MCP_TOKEN, "desktop-bridge-token");
        assert.equal(typeof options.classifierApprovalService.getState, "function");
        assert.equal(typeof options.classifierApprovalService.ownsThread, "function");
        await options.onThreadStarted({ threadId: "desktop-thread" });
        return { proxyUrl: `ws://127.0.0.1:${address.port}`, proxyToken: "classifier-token",
          close: async () => { closed += 1; } };
      },
    });
    stdin.write('{"id":1,"method":"initialize","params":{}}\n');
    assert.equal(await received, '{"id":1,"method":"initialize","params":{}}');
    assert.deepEqual(JSON.parse(await readFile(join(controlDir, "identity.json"), "utf8")), {
      version: 1, host: "codex", client_id: "swc_0123456789abcdef0123456789abcdef",
    });
    assert.deepEqual(JSON.parse(await readFile(join(controlDir, "codex-root-session.json"), "utf8")), {
      version: 1, session_id: "desktop-thread", client_id: "swc_0123456789abcdef0123456789abcdef",
    });
    const manifest = JSON.parse(await readFile(join(controlDir, "..", "manifest.json"), "utf8"));
    assert.equal(manifest.proxyToken, "classifier-token");
    assert.equal(manifest.proxyUrl, `ws://127.0.0.1:${address.port}`);
  } finally {
    await launch?.close();
    assert.equal(closed, 1);
    assert.equal(bridgeClosed, 1);
    upstreamSocket?.terminate();
    await new Promise(resolve => upstream.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("Desktop broker ignores an inherited parent route directory and refuses a conflicting owned identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-conflict-"));
  const clientId = "swc_0123456789abcdef0123456789abcdef";
  const ownControl = join(home, ".statewright", "codex-desktop-app-server", clientId, "routes");
  const foreign = join(home, "foreign-parent-routes");
  const stdin = new PassThrough();
  let started = false;
  try {
    await mkdir(ownControl, { recursive: true });
    await mkdir(foreign, { recursive: true });
    await writeFile(join(ownControl, "identity.json"), JSON.stringify({ version: 1, host: "codex", client_id: "swc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) + "\n");
    await writeFile(join(foreign, "identity.json"), "parent-bytes\n");
    await assert.rejects(() => runDesktopAppServerBroker({
      argv: ["app-server"], home, stdin, stdout: new PassThrough(), stderr: new PassThrough(),
      environment: {
        STATEWRIGHT_DESKTOP_ORIGINAL_CODEX: "/Applications/ChatGPT.app/Contents/Resources/codex",
        STATEWRIGHT_DESKTOP_CLIENT_ID: clientId,
        STATEWRIGHT_ROUTE_CONTROL_DIR: foreign,
      },
      startRuntime: async () => { started = true; throw new Error("must not start"); },
      startMcpBridge: fakeMcpBridge(),
    }), /refused to replace/);
    assert.equal(started, false);
    assert.equal(await readFile(join(foreign, "identity.json"), "utf8"), "parent-bytes\n");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Desktop broker closes its MCP bridge when App Server startup fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-start-failure-"));
  let bridgeClosed = 0;
  try {
    await assert.rejects(() => runDesktopAppServerBroker({
      argv: ["app-server"], home, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      environment: {
        STATEWRIGHT_DESKTOP_ORIGINAL_CODEX: "/Applications/ChatGPT.app/Contents/Resources/codex",
        STATEWRIGHT_DESKTOP_CLIENT_ID: "swc_0123456789abcdef0123456789abcdef",
      },
      startMcpBridge: fakeMcpBridge(() => { bridgeClosed += 1; }),
      startRuntime: async () => { throw new Error("app server startup failed"); },
    }), /app server startup failed/);
    assert.equal(bridgeClosed, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Desktop broker reuses the launcher's unsandboxed MCP bridge without leaking its launcher identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-external-bridge-"));
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  let innerBridgeStarted = 0;
  let socket = null;
  upstream.once("connection", value => { socket = value; });
  let launch;
  try {
    launch = await runDesktopAppServerBroker({
      argv: ["app-server"], home, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      environment: {
        STATEWRIGHT_DESKTOP_ORIGINAL_CODEX: "/Applications/ChatGPT.app/Contents/Resources/codex",
        STATEWRIGHT_DESKTOP_CLIENT_ID: "swc_0123456789abcdef0123456789abcdef",
        STATEWRIGHT_DESKTOP_MCP_URL: "http://127.0.0.1:43124",
        STATEWRIGHT_DESKTOP_MCP_TOKEN: "launcher-owned-token",
      },
      startMcpBridge: async () => { innerBridgeStarted += 1; throw new Error("inner bridge must not start"); },
      startRuntime: async options => {
        assert.equal(options.environment.STATEWRIGHT_MANAGED_MCP_URL, "http://127.0.0.1:43124");
        assert.equal(options.environment.STATEWRIGHT_MANAGED_MCP_TOKEN, "launcher-owned-token");
        assert.equal(options.environment.STATEWRIGHT_DESKTOP_MCP_URL, undefined);
        assert.equal(options.environment.STATEWRIGHT_DESKTOP_MCP_TOKEN, undefined);
        return { proxyUrl: `ws://127.0.0.1:${upstream.address().port}`, proxyToken: "classifier-token",
          close: async () => {} };
      },
    });
    assert.equal(innerBridgeStarted, 0);
  } finally {
    await launch?.close();
    socket?.terminate();
    await new Promise(resolve => upstream.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("Desktop broker rejects an incomplete launcher MCP bridge identity", async () => {
  const environment = {
    STATEWRIGHT_DESKTOP_ORIGINAL_CODEX: "/Applications/ChatGPT.app/Contents/Resources/codex",
    STATEWRIGHT_DESKTOP_CLIENT_ID: "swc_0123456789abcdef0123456789abcdef",
    STATEWRIGHT_DESKTOP_MCP_URL: "http://127.0.0.1:43124",
  };
  await assert.rejects(() => runDesktopAppServerBroker({
    argv: ["app-server"], environment,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  }), /bridge identity is incomplete/);
});

test("Desktop broker reserves its only new-thread slot before vendor forwarding", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-reserve-"));
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  let socket = null;
  upstream.once("connection", value => { socket = value; });
  let authorize;
  let launch;
  try {
    launch = await runDesktopAppServerBroker({
      argv: ["app-server"], home, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      environment: {
        STATEWRIGHT_DESKTOP_ORIGINAL_CODEX: "/Applications/ChatGPT.app/Contents/Resources/codex",
        STATEWRIGHT_DESKTOP_CLIENT_ID: "swc_0123456789abcdef0123456789abcdef",
      },
      startMcpBridge: fakeMcpBridge(),
      startRuntime: async options => {
        authorize = options.authorizeThread;
        return { proxyUrl: `ws://127.0.0.1:${upstream.address().port}`, proxyToken: "classifier-token",
          close: async () => {} };
      },
    });
    await authorize({ method: "thread/start", threadId: null });
    await assert.rejects(() => authorize({ method: "thread/start", threadId: null }), /single-thread experimental/);
    await assert.rejects(() => authorize({ method: "turn/start", threadId: "foreign-thread" }), /not forwarded/);
  } finally {
    await launch?.close();
    socket?.terminate();
    await new Promise(resolve => upstream.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("Desktop broker adopts a user-selected historical thread through an auditable same-root transfer", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-adopt-"));
  const controlDir = join(home, "routes");
  const clientId = "swc_0123456789abcdef0123456789abcdef";
  const times = [
    new Date("2026-09-27T12:00:00.000Z"), new Date("2026-09-27T12:00:00.000Z"),
    new Date("2026-09-27T12:00:30.000Z"), new Date("2026-09-27T12:00:30.000Z"),
  ];
  try {
    await mkdir(controlDir, { recursive: true });
    await claimCodexRootSession(controlDir, { sessionId: "current-thread", clientId });
    const authorize = desktopThreadAuthorizer({
      controlDir, clientId, home, now: () => times.shift(),
      readThreadCwds: async () => ({
        "current-thread": { cwd: "/repo/project" },
        "historical-thread": { cwd: "/repo/project" },
      }),
    });
    const prepared = await authorize({ method: "thread/resume", threadId: "historical-thread" });
    assert.equal((await readCodexRootSession(controlDir, clientId)).sessionId, "current-thread");
    await prepared.commit();
    assert.deepEqual(await readCodexRootSession(controlDir, clientId), {
      sessionId: "historical-thread", clientId,
    });
    const record = JSON.parse(await readFile(join(controlDir, "codex-root-session.json"), "utf8"));
    assert.equal(record.version, 2);
    assert.equal(record.ownership_transfer.kind, "codex_root_session_transfer");
    assert.equal(record.ownership_transfer.from_session_id, "current-thread");
    assert.equal(record.ownership_transfer.to_session_id, "historical-thread");
    assert.equal(record.ownership_transfer.root, "/repo/project");
    assert.ok(record.ownership_transfer.transfer_id);
    assert.ok(record.ownership_transfer.adopted_at);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Desktop broker rejects historical adoption owned by another managed session", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-wrong-session-"));
  const controlDir = join(home, "routes");
  try {
    await mkdir(controlDir, { recursive: true });
    await claimCodexRootSession(controlDir, {
      sessionId: "current-thread", clientId: "swc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const authorize = desktopThreadAuthorizer({
      controlDir, clientId: "swc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", home,
      readThreadCwds: async () => { throw new Error("foreign session must fail before metadata read"); },
    });
    await assert.rejects(
      authorize({ method: "thread/resume", threadId: "historical-thread" }),
      /another managed session/,
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Desktop broker rejects historical adoption from another immutable root", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-wrong-root-"));
  const controlDir = join(home, "routes");
  const clientId = "swc_0123456789abcdef0123456789abcdef";
  try {
    await mkdir(controlDir, { recursive: true });
    await claimCodexRootSession(controlDir, { sessionId: "current-thread", clientId });
    const authorize = desktopThreadAuthorizer({
      controlDir, clientId, home,
      readThreadCwds: async () => ({
        "current-thread": { cwd: "/repo/one" },
        "historical-thread": { cwd: "/repo/two" },
      }),
    });
    await assert.rejects(
      authorize({ method: "thread/resume", threadId: "historical-thread" }),
      /another or unproven project root/,
    );
    assert.equal((await readCodexRootSession(controlDir, clientId)).sessionId, "current-thread");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Desktop broker reserves historical adoption before asynchronous metadata reads", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-concurrent-adopt-"));
  const controlDir = join(home, "routes");
  const clientId = "swc_0123456789abcdef0123456789abcdef";
  let releaseMetadata;
  const metadataGate = new Promise(resolve => { releaseMetadata = resolve; });
  let metadataStarted;
  const metadataStart = new Promise(resolve => { metadataStarted = resolve; });
  let metadataReads = 0;
  try {
    await mkdir(controlDir, { recursive: true });
    await claimCodexRootSession(controlDir, { sessionId: "current-thread", clientId });
    const authorize = desktopThreadAuthorizer({
      controlDir, clientId, home,
      readThreadCwds: async () => {
        metadataReads += 1;
        metadataStarted();
        await metadataGate;
        return {
          "current-thread": { cwd: "/repo/project" },
          "historical-thread": { cwd: "/repo/project" },
        };
      },
    });
    const first = authorize({ method: "thread/resume", threadId: "historical-thread" });
    await metadataStart;
    await assert.rejects(
      authorize({ method: "thread/resume", threadId: "other-historical-thread" }),
      /adoption is still pending/,
    );
    releaseMetadata();
    const prepared = await first;
    await prepared.cancel();
    assert.equal(metadataReads, 1, "the rejected concurrent request cannot reach adoption preparation effects");
    assert.equal((await readCodexRootSession(controlDir, clientId)).sessionId, "current-thread");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Desktop broker rejects a stale historical ownership transfer", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-stale-transfer-"));
  const controlDir = join(home, "routes");
  const clientId = "swc_0123456789abcdef0123456789abcdef";
  const times = [
    new Date("2026-09-27T12:00:00.000Z"), new Date("2026-09-27T12:00:29.000Z"),
    new Date("2026-09-27T12:00:29.000Z"), new Date("2026-09-27T12:00:31.000Z"),
  ];
  try {
    await mkdir(controlDir, { recursive: true });
    await claimCodexRootSession(controlDir, { sessionId: "current-thread", clientId });
    const authorize = desktopThreadAuthorizer({
      controlDir, clientId, home, now: () => times.shift(),
      readThreadCwds: async () => ({
        "current-thread": { cwd: "/repo/project" },
        "historical-thread": { cwd: "/repo/project" },
      }),
    });
    const prepared = await authorize({ method: "thread/resume", threadId: "historical-thread" });
    await assert.rejects(
      prepared.commit(),
      /transfer is stale/,
    );
    assert.equal((await readCodexRootSession(controlDir, clientId)).sessionId, "current-thread");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Desktop adoption rejects invalid or overlong declared transfer windows", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-invalid-window-"));
  const controlDir = join(home, "routes");
  const clientId = "swc_0123456789abcdef0123456789abcdef";
  const baseTransfer = {
    version: 1, kind: "codex_root_session_transfer",
    transfer_id: "01234567-89ab-cdef-0123-456789abcdef",
    from_session_id: "current-thread", to_session_id: "historical-thread",
    client_id: clientId, root: "/repo/project",
  };
  try {
    await mkdir(controlDir, { recursive: true });
    await claimCodexRootSession(controlDir, { sessionId: "current-thread", clientId });
    for (const [issued_at, expires_at] of [
      ["2026-09-27T12:00:01.000Z", "2026-09-27T12:00:00.000Z"],
      ["2026-09-27T12:00:00.000Z", "2026-09-27T12:00:30.001Z"],
    ]) {
      await assert.rejects(adoptCodexRootSession(controlDir, { ...baseTransfer, issued_at, expires_at }, {
        now: () => new Date("2026-09-27T12:00:00.000Z"),
      }), /transfer is stale/);
    }
    assert.equal((await readCodexRootSession(controlDir, clientId)).sessionId, "current-thread");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Desktop root mutations share the adoption compare-and-swap lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-transfer-race-"));
  const controlDir = join(home, "routes");
  const clientId = "swc_0123456789abcdef0123456789abcdef";
  const instant = new Date("2026-09-27T12:00:00.000Z");
  try {
    await mkdir(controlDir, { recursive: true });
    await claimCodexRootSession(controlDir, { sessionId: "current-thread", clientId });
    await adoptCodexRootSession(controlDir, {
      version: 1, kind: "codex_root_session_transfer",
      transfer_id: "01234567-89ab-cdef-0123-456789abcdef",
      from_session_id: "current-thread", to_session_id: "historical-thread",
      client_id: clientId, root: "/repo/project",
      issued_at: instant.toISOString(), expires_at: new Date(instant.getTime() + 30_000).toISOString(),
    }, {
      now: () => instant,
      renameFile: async (from, to) => {
        await assert.rejects(
          resetCodexRootSession(controlDir, { sessionId: "racing-thread", clientId }),
          /already being updated/,
        );
        await rename(from, to);
      },
    });
    assert.equal((await readCodexRootSession(controlDir, clientId)).sessionId, "historical-thread");
    assert.deepEqual((await readdir(controlDir)).sort(), ["codex-root-session.json"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Desktop broker rejects a prepared transfer after the registered root changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-stale-root-"));
  const controlDir = join(home, "routes");
  const clientId = "swc_0123456789abcdef0123456789abcdef";
  try {
    await mkdir(controlDir, { recursive: true });
    await claimCodexRootSession(controlDir, { sessionId: "current-thread", clientId });
    const authorize = desktopThreadAuthorizer({
      controlDir, clientId, home,
      readThreadCwds: async () => ({
        "current-thread": { cwd: "/repo/project" },
        "historical-thread": { cwd: "/repo/project" },
      }),
    });
    const prepared = await authorize({ method: "thread/resume", threadId: "historical-thread" });
    await resetCodexRootSession(controlDir, { sessionId: "newer-thread", clientId });
    await assert.rejects(prepared.commit(), /stale or belongs to another session/);
    assert.equal((await readCodexRootSession(controlDir, clientId)).sessionId, "newer-thread");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Desktop adoption cleans its temporary record when atomic commit fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-transfer-cleanup-"));
  const controlDir = join(home, "routes");
  const clientId = "swc_0123456789abcdef0123456789abcdef";
  const issuedAt = "2026-09-27T12:00:00.000Z";
  try {
    await mkdir(controlDir, { recursive: true });
    await claimCodexRootSession(controlDir, { sessionId: "current-thread", clientId });
    await assert.rejects(adoptCodexRootSession(controlDir, {
      version: 1,
      kind: "codex_root_session_transfer",
      transfer_id: "01234567-89ab-cdef-0123-456789abcdef",
      from_session_id: "current-thread",
      to_session_id: "historical-thread",
      client_id: clientId,
      root: "/repo/project",
      issued_at: issuedAt,
      expires_at: "2026-09-27T12:00:30.000Z",
    }, {
      now: () => new Date(issuedAt),
      renameFile: async () => { throw new Error("synthetic rename failure"); },
    }), /synthetic rename failure/);
    assert.equal((await readCodexRootSession(controlDir, clientId)).sessionId, "current-thread");
    assert.deepEqual((await readdir(controlDir)).sort(), ["codex-root-session.json"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Desktop broker detaches open stdin when its backend closes", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-close-"));
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const stdin = new PassThrough();
  const connected = new Promise(resolve => upstream.once("connection", resolve));
  let closed = 0;
  const exitCodes = [];
  let launch;
  try {
    launch = await runDesktopAppServerBroker({
      argv: ["app-server"], home, stdin, stdout: new PassThrough(), stderr: new PassThrough(),
      environment: {
        STATEWRIGHT_DESKTOP_ORIGINAL_CODEX: "/Applications/ChatGPT.app/Contents/Resources/codex",
        STATEWRIGHT_DESKTOP_CLIENT_ID: "swc_0123456789abcdef0123456789abcdef",
      },
      startMcpBridge: fakeMcpBridge(),
      startRuntime: async () => ({
        proxyUrl: `ws://127.0.0.1:${upstream.address().port}`,
        proxyToken: "classifier-token",
        close: async () => { closed += 1; },
      }),
      setExitCode: code => exitCodes.push(code),
    });
    const socket = await connected;
    socket.close();
    while (closed === 0) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(stdin.listenerCount("data"), 0);
    stdin.write('{"id":99,"method":"initialize","params":{}}\n');
    assert.equal(closed, 1, "post-close input cannot revive the backend");
    assert.deepEqual(exitCodes, [1], "an unsolicited backend close is an executable failure");
  } finally {
    await launch?.close();
    await new Promise(resolve => upstream.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});
