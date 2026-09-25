import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { WebSocketServer } from "ws";
import { desktopAppServerLaunchPlan, desktopBrokerEnvironment, runDesktopAppServerBroker, startDesktopMcpBridge } from "../lib/codex-desktop-app-server-launcher.mjs";

function fakeMcpBridge(onClose = () => {}) {
  return async () => ({
    url: "http://127.0.0.1:43123",
    token: "desktop-bridge-token",
    close: async () => onClose(),
  });
}

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
  }, { controlDir: "/tmp/desktop-control", clientId: "swc_0123456789abcdef0123456789abcdef" });
  assert.equal(child.STATEWRIGHT_API_KEY, "keep-user-auth");
  assert.equal(child.STATEWRIGHT_CLIENT_ID, "swc_0123456789abcdef0123456789abcdef");
  assert.equal(child.STATEWRIGHT_ROUTE_CONTROL_DIR, "/tmp/desktop-control");
  for (const name of [
    "STATEWRIGHT_MCP_SESSION_ID", "STATEWRIGHT_MANAGED_MCP_URL", "STATEWRIGHT_MANAGED_MCP_TOKEN",
    "STATEWRIGHT_MANAGED_MCP_SESSION_ID", "STATEWRIGHT_MANAGED_TELEMETRY_OWNER",
    "STATEWRIGHT_MANAGED_CODEX_ROOT_SESSION_ID", "STATEWRIGHT_ADAPTER_URL", "STATEWRIGHT_ADAPTER_TOKEN",
    "CODEX_SESSION_ID", "CODEX_THREAD_ID",
  ]) assert.equal(child[name], undefined, `${name} must not escape the parent session`);
});

test("Desktop bridge owns gateway authentication outside the App Server sandbox", async () => {
  let started = 0;
  const bridge = await startDesktopMcpBridge({
    environment: { STATEWRIGHT_API_KEY: "desktop-api-key", STATEWRIGHT_GATEWAY_URL: "https://example.test/mcp" },
    clientId: "swc_0123456789abcdef0123456789abcdef",
    bridgeFactory: options => {
      assert.deepEqual(options, {
        gatewayUrl: "https://example.test/mcp",
        apiKey: "desktop-api-key",
        clientId: "swc_0123456789abcdef0123456789abcdef",
      });
      return { start: async () => { started += 1; } };
    },
  });
  assert.equal(started, 1);
  assert.ok(bridge);
});

test("Desktop broker buffers an immediate stdio request and initializes its private route boundary", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-desktop-control-"));
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
      },
      home,
      stdin,
      stdout,
      stderr,
      startMcpBridge: fakeMcpBridge(() => { bridgeClosed += 1; }),
      startRuntime: async options => {
        assert.equal(typeof options.onThreadStarted, "function");
        assert.equal(typeof options.authorizeThread, "function");
        assert.equal(options.environment.STATEWRIGHT_ROUTE_CONTROL_DIR, controlDir);
        assert.equal(options.environment.STATEWRIGHT_MANAGED_CLIENT_HOST, "codex");
        assert.equal(options.environment.STATEWRIGHT_CLIENT_ID, "swc_0123456789abcdef0123456789abcdef");
        assert.equal(options.environment.STATEWRIGHT_MANAGED_MCP_URL, "http://127.0.0.1:43123");
        assert.equal(options.environment.STATEWRIGHT_MANAGED_MCP_TOKEN, "desktop-bridge-token");
        await options.onThreadStarted({ threadId: "desktop-thread" });
        return { proxyUrl: `ws://127.0.0.1:${address.port}`, close: async () => { closed += 1; } };
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
        return { proxyUrl: `ws://127.0.0.1:${upstream.address().port}`, close: async () => {} };
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
        return { proxyUrl: `ws://127.0.0.1:${upstream.address().port}`, close: async () => {} };
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
