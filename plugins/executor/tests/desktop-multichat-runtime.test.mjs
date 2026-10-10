import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { WebSocketServer } from "ws";
import { runDesktopAppServerBroker } from "../lib/codex-desktop-app-server-launcher.mjs";
import { desktopLaneClientId, startDesktopBridgePool } from "../lib/desktop-bridge-pool.mjs";
import { claimManagedSessionOwner, releaseManagedSessionOwner } from "../lib/managed-client-identity.mjs";

const PROFILE = "swc_0123456789abcdef0123456789abcdef";
const A = "01234567-89ab-cdef-0123-456789abcdef";
const B = "12345678-9abc-def0-1234-56789abcdef0";
const NEW = "23456789-abcd-ef01-2345-6789abcdef01";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "statewright-multichat-runtime-test-"));
  const codexHome = join(home, "codex-fixture");
  const sessions = join(codexHome, "sessions", "2026", "10", "10");
  await mkdir(sessions, { recursive: true });
  for (const [id, project] of [[A, "alpha"], [B, "beta"]]) {
    await writeFile(join(sessions, `rollout-2026-10-10T00-00-00-${id}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id, cwd: join(home, project) } })}\n`);
  }
  const bridges = [];
  const runtimes = [];
  const brokers = [];
  const behavior = new Map();
  const pool = await startDesktopBridgePool({ profileClientId: PROFILE,
    legacyBridge: { clientId: PROFILE, url: "http://127.0.0.1:18000", token: "legacy-fixture", close() {} },
    createBridge: async clientId => {
      const bridge = { clientId, url: `http://127.0.0.1:${18001 + bridges.length}`,
        token: `fixture-child-${bridges.length}`, close() {} };
      bridges.push(bridge);
      return bridge;
    },
  });
  const bindingPath = id => join(home, ".statewright", "codex-desktop-app-server", PROFILE, "threads", `${id}.json`);
  const leases = async () => {
    const directory = join(home, ".statewright", "managed-client-leases");
    const names = await readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    return Promise.all(names.map(async name => JSON.parse(await readFile(join(directory, name), "utf8"))));
  };
  const startRuntime = async options => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const runtime = { options, forwarded: [], closed: false };
    runtimes.push(runtime);
    server.on("connection", socket => {
      let queue = Promise.resolve();
      socket.on("message", raw => {
        queue = queue.then(async () => {
          const message = JSON.parse(String(raw));
          if (!message.method || message.id === undefined) return;
          let lifecycle;
          let result = {};
          try {
            if (message.method.startsWith("thread/") || message.method.startsWith("turn/")) {
              lifecycle = await options.authorizeThread({ method: message.method, threadId: message.params?.threadId });
            }
            runtime.forwarded.push(message);
            if (message.method === "thread/resume") {
              const id = message.params.threadId;
              if (behavior.get(id) === "failure") throw new Error("Native fixture resume failed.");
              result = { thread: { id: behavior.get(id) === "mismatch" ? NEW : id } };
              // Mirror the native transport contract: only the exact native
              // response may commit the pending adoption lifecycle.
              if (result.thread.id !== lifecycle?.threadId) throw new Error("Native fixture returned a mismatched thread.");
              await lifecycle.commit();
            } else if (message.method === "thread/start") {
              result = { thread: { id: NEW } };
              await options.onThreadStarted({ threadId: NEW });
            } else if (message.method === "thread/read") {
              result = { thread: { id: message.params.threadId } };
            }
            socket.send(JSON.stringify({ id: message.id, result }));
          } catch (error) {
            await lifecycle?.cancel?.();
            socket.send(JSON.stringify({ id: message.id, error: { code: -32603, message: error.message } }));
          }
        }).catch(error => { runtime.error = error; socket.terminate(); });
      });
    });
    return {
      proxyUrl: `ws://127.0.0.1:${server.address().port}`,
      proxyToken: "fixture-proxy-token",
      close: async () => {
        if (runtime.closed) return;
        runtime.closed = true;
        for (const socket of server.clients) socket.terminate();
        await new Promise(resolve => server.close(resolve));
      },
    };
  };
  const start = async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const waiters = new Map();
    let buffer = "";
    let sequence = 0;
    const received = [];
    stdout.on("data", chunk => {
      buffer += String(chunk);
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        received.push(message);
        const waiter = waiters.get(message.id);
        if (waiter) { waiters.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); }
      }
    });
    const launch = await runDesktopAppServerBroker({
      argv: ["app-server", "--listen", "stdio://"], home, stdin, stdout, stderr, startRuntime,
      environment: {
        STATEWRIGHT_DESKTOP_ORIGINAL_CODEX: "/fixture/codex",
        STATEWRIGHT_DESKTOP_CLIENT_ID: PROFILE,
        STATEWRIGHT_DESKTOP_BRIDGE_POOL_URL: pool.url,
        STATEWRIGHT_DESKTOP_BRIDGE_POOL_TOKEN: pool.token,
        STATEWRIGHT_ROUTE_CONTROL_DIR: "/foreign-parent/routes",
        CODEX_HOME: codexHome,
      },
      startMcpBridge: () => { throw new Error("Pool mode must not start an in-sandbox bridge."); },
      setExitCode: () => {},
    });
    const broker = { received, close: () => launch.close(),
      call: (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`Fixture response timed out: ${method}`)); }, 3000);
        waiters.set(id, { resolve, timer });
        stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      }),
      notify: method => stdin.write(`${JSON.stringify({ method })}\n`),
    };
    brokers.push(broker);
    assert.ok((await broker.call("initialize")).result);
    broker.notify("initialized");
    return broker;
  };
  t.after(async () => {
    try { for (const broker of brokers) await broker.close(); }
    finally { await pool.close(); await rm(home, { recursive: true, force: true }); }
    for (const runtime of runtimes) assert.equal(runtime.error, undefined);
  });
  return { home, bridges, runtimes, behavior, bindingPath, leases, start };
}

test("pool broker resumes two different projects with isolated workflow identities, controls and bridges", async t => {
  const f = await fixture(t);
  const broker = await f.start();
  for (const threadId of [A, B]) {
    const response = await broker.call("thread/resume", { threadId });
    assert.equal(response.error, undefined);
    assert.equal(response.result.thread.id, threadId);
  }
  const owners = await f.leases();
  assert.equal(owners.length, 2);
  assert.deepEqual(new Set(owners.map(owner => owner.cwd)), new Set([join(f.home, "alpha"), join(f.home, "beta")]));
  const active = f.runtimes.filter(runtime => runtime.options.classifierApprovalService);
  assert.equal(active.length, 2);
  for (const [index, threadId] of [A, B].entries()) {
    const options = active[index].options;
    const clientId = desktopLaneClientId(PROFILE, `thread:${threadId}`);
    const bridge = f.bridges.find(value => value.clientId === clientId);
    assert.equal(options.clientId, clientId);
    assert.equal(options.environment.STATEWRIGHT_CLIENT_ID, clientId);
    assert.equal(options.environment.STATEWRIGHT_MANAGED_MCP_URL, bridge.url);
    assert.equal(options.environment.STATEWRIGHT_MANAGED_MCP_TOKEN, bridge.token);
    assert.equal(options.environment.STATEWRIGHT_DESKTOP_BRIDGE_POOL_TOKEN, undefined);
    assert.equal(options.environment.STATEWRIGHT_ROUTE_CONTROL_DIR,
      join(f.home, ".statewright", "codex-desktop-app-server", clientId, "routes"));
    assert.equal(await options.classifierApprovalService.ownsThread(threadId), true);
    assert.equal(await options.classifierApprovalService.ownsThread(index ? A : B), false);
  }
  assert.equal(new Set(active.map(runtime => runtime.options.environment.STATEWRIGHT_ROUTE_CONTROL_DIR)).size, 2);
  assert.equal(new Set(active.map(runtime => runtime.options.environment.STATEWRIGHT_MANAGED_MCP_TOKEN)).size, 2);
  await broker.close();
  assert.deepEqual(await f.leases(), []);
  assert.ok(f.runtimes.every(runtime => runtime.closed));
});

test("discovery reads historical chats without claiming or binding a writer", async t => {
  const f = await fixture(t);
  const broker = await f.start();
  assert.equal((await broker.call("thread/read", { threadId: A })).result.thread.id, A);
  assert.equal((await broker.call("thread/read", { threadId: B })).result.thread.id, B);
  assert.equal(f.runtimes.length, 1);
  assert.equal(f.runtimes[0].options.clientId, desktopLaneClientId(PROFILE, "discovery"));
  assert.equal(f.runtimes[0].options.classifierApprovalService, undefined);
  assert.deepEqual(await f.leases(), []);
  await assert.rejects(readFile(f.bindingPath(A)), { code: "ENOENT" });
  const rejected = await broker.call("turn/start", { threadId: A });
  assert.match(rejected.error.message, /Resume this chat/);
});

for (const behavior of ["failure", "mismatch"]) {
  test(`native resume ${behavior} releases provisional writer ownership and creates no binding`, async t => {
    const f = await fixture(t);
    f.behavior.set(A, behavior);
    const broker = await f.start();
    const failed = await broker.call("thread/resume", { threadId: A });
    assert.ok(failed.error);
    assert.deepEqual(await f.leases(), []);
    await assert.rejects(readFile(f.bindingPath(A)), { code: "ENOENT" });
    f.behavior.delete(A);
    const retry = await broker.call("thread/resume", { threadId: A });
    assert.equal(retry.error, undefined);
    assert.equal((await f.leases()).length, 1);
  });
}

test("preexisting writer lease blocks resume and survives broker closure", async t => {
  const f = await fixture(t);
  const owner = await claimManagedSessionOwner({ host: "codex", sessionId: A,
    clientId: "swc_abcdef0123456789abcdef0123456789", home: f.home, cwd: join(f.home, "alpha") });
  const broker = await f.start();
  const rejected = await broker.call("thread/resume", { threadId: A });
  assert.match(rejected.error.message, /second managed writer/);
  assert.equal(f.runtimes.flatMap(runtime => runtime.forwarded).filter(message => message.method === "thread/resume").length, 0);
  await assert.rejects(readFile(f.bindingPath(A)), { code: "ENOENT" });
  await broker.close();
  assert.deepEqual(await f.leases(), [owner]);
  assert.equal(await releaseManagedSessionOwner({ host: "codex", sessionId: A, ownerId: owner.owner_id, home: f.home }), true);
});

test("restart preserves historical and newly-created chat bindings and bridge identities", async t => {
  const f = await fixture(t);
  const first = await f.start();
  assert.equal((await first.call("thread/resume", { threadId: A })).result.thread.id, A);
  assert.equal((await first.call("thread/start")).result.thread.id, NEW);
  const before = new Map();
  for (const id of [A, NEW]) before.set(id, JSON.parse(await readFile(f.bindingPath(id), "utf8")));
  assert.equal(before.get(A).key, `thread:${A}`);
  assert.match(before.get(NEW).key, /^new:/);
  const firstClientIds = f.runtimes.filter(runtime => runtime.options.classifierApprovalService).map(runtime => runtime.options.clientId);
  await first.close();
  assert.deepEqual(await f.leases(), []);
  const runtimeCount = f.runtimes.length;
  const second = await f.start();
  for (const id of [A, NEW]) {
    assert.equal((await second.call("thread/resume", { threadId: id })).result.thread.id, id);
    assert.deepEqual(JSON.parse(await readFile(f.bindingPath(id), "utf8")), before.get(id));
  }
  const secondClientIds = f.runtimes.slice(runtimeCount).filter(runtime => runtime.options.classifierApprovalService).map(runtime => runtime.options.clientId);
  assert.deepEqual(secondClientIds, firstClientIds);
  assert.equal(f.bridges.length, 3); // Discovery plus two persistent chat lanes.
  await second.close();
  assert.deepEqual(await f.leases(), []);
});
