import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  appServerHomePrefixForClient,
  codexAppServerTransportEnabled,
  routeConfigEdits,
  startCodexAppServerRuntime,
} from "../lib/codex-app-server-transport.mjs";
import { ensureCodexAppServerResident, nextCodexResidentRouteRequest, residentControlDir, residentMatchesRuntime, residentRoot, residentRuntimeRevision } from "../lib/codex-app-server-resident.mjs";
import { applyCompactResumeRequest, applyRouteToTurnStart, applyThreadListCwd, clarifyActiveWriterResumeError, hydrateBoundedResumeTurns, labelThreadListResponse, settingsConfirmRoute, startCodexAppServerRouteProxy } from "../lib/codex-app-server-route-proxy.mjs";

function once(socket, event) {
  return new Promise((resolveEvent) => socket.once(event, resolveEvent));
}

test("Codex App Server transport remains opt-in and supports an explicit environment override", () => {
  assert.equal(codexAppServerTransportEnabled({ environment: {} }), false);
  assert.equal(codexAppServerTransportEnabled({
    config: { routing: { managed_clients: { codex_transport: "app-server" } } },
  }), true);
  assert.equal(codexAppServerTransportEnabled({
    environment: { STATEWRIGHT_CODEX_TRANSPORT: "restart" },
    config: { routing: { managed_clients: { codex_transport: "app-server" } } },
  }), false);
  assert.equal(codexAppServerTransportEnabled({
    environment: { STATEWRIGHT_CODEX_TRANSPORT: "app-server" },
  }), true);
});

test("App Server transport creates bounded, filesystem-safe temporary home names", () => {
  assert.equal(appServerHomePrefixForClient("swc_abc:unsafe/path"), "statewright-swc_abc-unsafe-path");
  assert.match(appServerHomePrefixForClient("x".repeat(100)), /^statewright-x{60}$/);
});

test("App Server runtime confirms its owned child exits before close completes", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-app-server-close-"));
  const codexHome = join(home, ".codex");
  const fake = join(home, "fake-codex.mjs");
  const pidPath = join(home, "app-server.pid");
  try {
    await mkdir(codexHome, { recursive: true });
    await writeFile(fake, `#!/usr/bin/env node\nimport { createServer } from "node:http";\nimport { writeFileSync } from "node:fs";\nconst target = new URL(process.argv.at(-1));\nprocess.on("SIGTERM", () => {});\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\ncreateServer((_request, response) => { response.writeHead(200); response.end("ok\\n"); }).listen(Number(target.port), target.hostname);\n`);
    await chmod(fake, 0o755);
    const runtime = await startCodexAppServerRuntime({
      command: fake,
      environment: { ...process.env, CODEX_HOME: codexHome, STATEWRIGHT_SENTRY_DISABLED: "true" },
      cwd: home,
      home,
      clientId: "swc_shutdown_test",
      shutdownGraceMs: 20,
      reporter: { async report() {} },
    });
    const pid = Number(await readFile(pidPath, "utf8"));
    await runtime.close();
    assert.throws(() => process.kill(pid, 0));
    const retainedHomes = (await readdir(tmpdir())).filter((entry) => entry.startsWith("statewright-swc_shutdown_test-app-server-"));
    assert.ok(retainedHomes.length >= 1, "the isolated home must remain addressable after shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("resident App Server state is stable per managed client and keeps routes outside the transient launcher", () => {
  const home = "/tmp/statewright-home";
  const root = residentRoot(home, "swc_abc:unsafe/path");
  assert.equal(root, "/tmp/statewright-home/.statewright/codex-app-server/swc_abc-unsafe-path");
  assert.equal(residentControlDir(home, "swc_abc:unsafe/path"), `${root}/routes`);
});

test("resident App Server accepts routes only for the attached root session", async () => {
  const control = await mkdtemp(join(tmpdir(), "statewright-resident-routes-"));
  const clientId = "swc_0123456789abcdef0123456789abcdef";
  try {
    await writeFile(join(control, "codex-root-session.json"), JSON.stringify({ version: 1, session_id: "root-thread", client_id: clientId }));
    const routePath = join(control, "01-root.route.json");
    await writeFile(routePath, JSON.stringify({ session_id: "root-thread", root_session_id: "root-thread", client_id: clientId, model: "gpt-5.6-terra" }));
    assert.equal(await nextCodexResidentRouteRequest(control, clientId, "child-thread"), null);
    const candidates = await Promise.all([
      nextCodexResidentRouteRequest(control, clientId, "root-thread"),
      nextCodexResidentRouteRequest(control, clientId, "root-thread"),
    ]);
    const pending = candidates.find(Boolean);
    assert.equal(candidates.filter(Boolean).length, 1);
    assert.deepEqual(pending.route, {
      session_id: "root-thread", root_session_id: "root-thread", client_id: clientId, model: "gpt-5.6-terra",
    });
    assert.equal((await readdir(control)).filter((name) => name.endsWith(".route.json")).length, 0);
    await pending.release();
    const retry = await nextCodexResidentRouteRequest(control, clientId, "root-thread", {
      unlinkImpl: async () => { const error = new Error("synthetic acknowledgement failure"); error.code = "EACCES"; throw error; },
    });
    await assert.rejects(retry.ack(), { code: "EACCES" });
    assert.equal((await readdir(control)).filter((name) => name.endsWith(".route.json")).length, 0);
    await retry.release();
    const finalAttempt = await nextCodexResidentRouteRequest(control, clientId, "root-thread");
    await finalAttempt.ack();
    await finalAttempt.ack();
  } finally { await rm(control, { recursive: true, force: true }); }
});

test("resident runtime revision changes reuse only when the loaded transport bundle matches", async () => {
  const revision = await residentRuntimeRevision();
  assert.match(revision, /^[a-f0-9]{16}$/);
  assert.equal(residentMatchesRuntime({ runtimeRevision: revision }, revision), true);
  assert.equal(residentMatchesRuntime({ runtimeRevision: revision, threadListCwd: "/repo" }, revision, "/repo"), true);
  assert.equal(residentMatchesRuntime({ runtimeRevision: revision, threadListCwd: "/repo" }, revision, null), false);
  assert.equal(residentMatchesRuntime({ runtimeRevision: revision, threadListCwd: null }, revision, "/repo"), false);
  assert.equal(residentMatchesRuntime({ runtimeRevision: "stale" }, revision), false);
  assert.equal(residentMatchesRuntime({}, revision), false);
});

test("a mismatched launch never retires a live resident that may own detached work", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-resident-mismatch-"));
  const clientId = "swc_scope_mismatch";
  const root = residentRoot(home, clientId);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      pid: child.pid,
      proxyUrl: "ws://127.0.0.1:1",
      runtimeRevision: await residentRuntimeRevision(),
      threadListCwd: "/repo-a",
    }));
    await assert.rejects(
      ensureCodexAppServerResident({ command: "codex", cwd: "/repo-b", home, clientId, threadListCwd: "/repo-b" }),
      /may be preserving detached work/i,
    );
    assert.doesNotThrow(() => process.kill(child.pid, 0));
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    await rm(home, { recursive: true, force: true });
  }
});

test("App Server transport writes only next-turn model and effort config overrides", () => {
  assert.deepEqual(routeConfigEdits({
    model: "openai-codex/gpt-5.6-sol",
    effort: "high",
  }), [
    { keyPath: "model", mergeStrategy: "upsert", value: "gpt-5.6-sol" },
    { keyPath: "model_reasoning_effort", mergeStrategy: "upsert", value: "high" },
  ]);
  assert.deepEqual(routeConfigEdits({ model: "gpt-5.6-terra" }), [
    { keyPath: "model", mergeStrategy: "upsert", value: "gpt-5.6-terra" },
  ]);
  assert.throws(() => routeConfigEdits({ effort: "high" }), /missing a model/);
});

test("App Server routing overrides the native next turn and requires a settings receipt", () => {
  const { message, receipt } = applyRouteToTurnStart({
    id: 12,
    method: "turn/start",
    params: { threadId: "thread-1", input: [] },
  }, { session_id: "thread-1", model: "openai-codex/gpt-5.6-sol", effort: "high" });
  assert.equal(message.params.model, "gpt-5.6-sol");
  assert.equal(message.params.effort, "high");
  assert.deepEqual(settingsConfirmRoute(receipt, {
    method: "thread/settings/updated",
    params: { threadId: "thread-1", threadSettings: { model: "gpt-5.6-sol", effort: "high" } },
  }), {
    ...receipt,
    actualModel: "gpt-5.6-sol",
    actualEffort: "high",
    confirmed: true,
  });
  assert.equal(settingsConfirmRoute(receipt, {
    method: "thread/settings/updated",
    params: { threadId: "thread-1", threadSettings: { model: "gpt-5.6-terra", effort: "high" } },
  }).confirmed, false);
  assert.deepEqual(applyRouteToTurnStart({
    method: "turn/start", params: { threadId: "different-thread" },
  }, { session_id: "thread-1", model: "gpt-5.6-sol" }), {
    message: { method: "turn/start", params: { threadId: "different-thread" } }, receipt: null,
  });
});

test("App Server routing selects the ladder entry owned by the persistent thread provider", () => {
  const route = {
    session_id: "thread-1",
    model: "local_compatible/local-code-model",
    model_ladder: [
      { model: "local_compatible/local-code-model", thinking_level: "low" },
      { model: "openai-codex/gpt-5.6-luna", thinking_level: "low" },
    ],
  };
  const local = applyRouteToTurnStart({
    id: 12, method: "turn/start", params: { threadId: "thread-1", input: [] },
  }, route, "local_compatible");
  assert.equal(local.message.params.model, "local-code-model");
  assert.equal(local.message.params.effort, "low");
  const cloud = applyRouteToTurnStart({
    id: 13, method: "turn/start", params: { threadId: "thread-1", input: [] },
  }, route, "openai");
  assert.equal(cloud.message.params.model, "gpt-5.6-luna");
  assert.equal(cloud.message.params.effort, "low");
});

test("App Server resume history is scoped to the managed project unless the client supplied a cwd", () => {
  assert.deepEqual(applyThreadListCwd({ id: 1, method: "thread/list", params: { limit: 20 } }, "/repo"), {
    id: 1,
    method: "thread/list",
    params: { limit: 20, cwd: "/repo" },
  });
  assert.deepEqual(applyThreadListCwd({ id: 2, method: "thread/list", params: { cwd: ["/other"] } }, "/repo"), {
    id: 2,
    method: "thread/list",
    params: { cwd: ["/other"] },
  });
  assert.deepEqual(applyThreadListCwd({ id: 3, method: "model/list", params: {} }, "/repo"), {
    id: 3,
    method: "model/list",
    params: {},
  });
});

test("App Server resume list labels thread names with their home-relative project directory", () => {
  const source = {
    id: 1,
    result: {
      data: [
        { id: "auldwyrm", cwd: "/Users/ben/dev/auldwyrm", name: "auldwyrm", status: { type: "active" } },
        { id: "resume", cwd: "/Users/ben/dev/resume", name: "Frame faith alignment", status: { type: "notLoaded" } },
        { id: "legacy", cwd: null, preview: "Untouched legacy entry" },
        { id: "fallback", cwd: "/Users/ben/dev/nomad", name: null, preview: "What is next?" },
      ],
    },
  };
  const labelled = labelThreadListResponse(source, "/Users/ben");
  assert.equal(labelled.result.data[0].name, "[~/dev/auldwyrm] auldwyrm");
  assert.equal(labelled.result.data[1].name, "[~/dev/resume] Frame faith alignment");
  assert.equal(labelled.result.data[2].preview, "Untouched legacy entry");
  assert.equal(labelled.result.data[3].preview, "[~/dev/nomad] What is next?");
  assert.equal(labelled.result.data[0].id, "auldwyrm");
  assert.equal(labelled.result.data[0].status.type, "active");
  assert.equal(labelThreadListResponse(labelled, "/Users/ben"), labelled);
  assert.equal(labelThreadListResponse(source, "/Users/ben", { "codex:auldwyrm": { label: "adv" } }).result.data[0].name, "[adv · ~/dev/auldwyrm] auldwyrm");
});

test("resident proxy retires after its last idle TUI disconnects", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let idleCalls = 0;
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
    idleMs: 10,
    onIdle: async () => { idleCalls += 1; resolveIdle(); },
  });
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  client.close();
  await idle;
  assert.equal(idleCalls, 1);
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("resident proxy preserves a detached active turn until it completes", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let upstreamSocket;
  const upstreamConnection = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  let idleCalls = 0;
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
    idleMs: 10,
    onIdle: async () => { idleCalls += 1; resolveIdle(); },
  });
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  await upstreamConnection;
  const active = once(client, "message");
  upstreamSocket.send(JSON.stringify({ method: "thread/status/changed", params: { threadId: "thread-1", status: { type: "active" } } }));
  await active;
  client.close();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  assert.equal(idleCalls, 0);
  upstreamSocket.send(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1" } }));
  await idle;
  assert.equal(idleCalls, 1);
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("resident proxy preserves a submitted turn before its activity acknowledgement", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let upstreamSocket;
  const upstreamConnection = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  let idleCalls = 0;
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
    idleMs: 10,
    onIdle: async () => { idleCalls += 1; resolveIdle(); },
  });
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  await upstreamConnection;
  const submitted = once(upstreamSocket, "message");
  client.send(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-1", input: [] } }));
  await submitted;
  client.terminate();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  assert.equal(idleCalls, 0);
  assert.equal(upstreamSocket.readyState, WebSocket.OPEN);
  upstreamSocket.send(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1" } }));
  await idle;
  assert.equal(idleCalls, 1);
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("resident proxy clears provisional activity when turn submission is rejected", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let upstreamSocket;
  const upstreamConnection = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
    idleMs: 10,
    onIdle: async () => resolveIdle(),
  });
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  await upstreamConnection;
  const submitted = once(upstreamSocket, "message");
  client.send(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-1", input: [] } }));
  await submitted;
  const rejected = once(client, "message");
  upstreamSocket.send(JSON.stringify({ id: 1, error: { code: -32600, message: "rejected" } }));
  await rejected;
  client.close();
  await idle;
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("resident proxy cancels pending idle retirement when a TUI reconnects", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let idleCalls = 0;
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
    idleMs: 30,
    onIdle: async () => { idleCalls += 1; resolveIdle(); },
  });
  const first = new WebSocket(proxy.url);
  await once(first, "open");
  first.close();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  const second = new WebSocket(proxy.url);
  await once(second, "open");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
  assert.equal(idleCalls, 0);
  second.close();
  await idle;
  assert.equal(idleCalls, 1);
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("resident proxy keeps JSON-RPC request correlation local to each TUI", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  const upstreamSockets = [];
  upstream.on("connection", (socket) => upstreamSockets.push(socket));
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
  });
  const first = new WebSocket(proxy.url);
  await once(first, "open");
  while (upstreamSockets.length < 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
  const second = new WebSocket(proxy.url);
  await once(second, "open");
  while (upstreamSockets.length < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
  const forwardedRequests = upstreamSockets.map((socket) => once(socket, "message"));
  first.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "thread-a" } }));
  second.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "thread-b" } }));
  await Promise.all(forwardedRequests);
  const firstResponse = once(first, "message");
  const secondResponse = once(second, "message");
  upstreamSockets[0].send(JSON.stringify({ id: 1, result: { thread: { id: "thread-a", turns: [] }, initialTurnsPage: { data: [{ id: "a" }] } } }));
  upstreamSockets[1].send(JSON.stringify({ id: 1, result: { thread: { id: "thread-b", turns: [] }, initialTurnsPage: { data: [{ id: "b" }] } } }));
  assert.deepEqual(JSON.parse(String(await firstResponse)).result.thread.turns, [{ id: "a" }]);
  assert.deepEqual(JSON.parse(String(await secondResponse)).result.thread.turns, [{ id: "b" }]);
  first.close();
  second.close();
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("compact resume requests server-supported metadata and bounded recent history", () => {
  const request = { id: 4, method: "thread/resume", params: { threadId: "thread-1", initialTurnsPage: { limit: 200 } } };
  assert.deepEqual(applyCompactResumeRequest(request), {
    id: 4,
    method: "thread/resume",
    params: { threadId: "thread-1", excludeTurns: true, initialTurnsPage: { limit: 4, sortDirection: "desc", itemsView: "summary" } },
  });
  assert.deepEqual(applyCompactResumeRequest(request, true, 2).params.initialTurnsPage, { limit: 2, sortDirection: "desc", itemsView: "summary" });
  assert.equal(applyCompactResumeRequest(request, false), request);
  const readRequest = { id: 4, method: "thread/read", params: {} };
  assert.equal(applyCompactResumeRequest(readRequest), readRequest);
});

test("bounded resume pages are normalized for the native Codex transcript surface", () => {
  const response = {
    id: 4,
    result: {
      thread: { id: "thread-1", turns: [] },
      initialTurnsPage: { data: [{ id: "newest" }, { id: "older" }] },
    },
  };
  assert.deepEqual(hydrateBoundedResumeTurns(response).result.thread.turns, [{ id: "older" }, { id: "newest" }]);
  assert.equal(hydrateBoundedResumeTurns({ result: { thread: { turns: [{ id: "existing" }] } } }).result.thread.turns[0].id, "existing");
});

test("active-writer resume errors preserve the native refusal and explain when to retry", () => {
  const response = {
    id: 4,
    error: {
      code: -32600,
      message: "thread thread-1 already has an active writer",
      data: { threadId: "thread-1" },
    },
  };
  const clarified = clarifyActiveWriterResumeError(response);
  assert.equal(clarified.error.code, -32600);
  assert.deepEqual(clarified.error.data, { threadId: "thread-1" });
  assert.match(clarified.error.message, /^thread thread-1 already has an active writer\b/);
  assert.match(clarified.error.message, /wait a minute or two for the current turn to finish, then try again/i);
  assert.match(clarified.error.message, /if it still fails, close the other Codex client or recover the stale managed session/i);
  assert.equal(clarifyActiveWriterResumeError(clarified), clarified);
  const unrelated = { id: 5, error: { code: -32600, message: "thread not found" } };
  assert.equal(clarifyActiveWriterResumeError(unrelated), unrelated);
});

test("App Server route proxy keeps a pending route when upstream forwarding fails", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  let acknowledged = 0;
  const protocolErrors = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
    takePendingRoute: async () => ({
      route: { session_id: "thread-send-failure", model: "openai-codex/gpt-5.6-sol" },
      ack: async () => { acknowledged += 1; },
    }),
    forwardPayload: async () => { throw new Error("synthetic upstream send failure"); },
    onProtocolError: async (error) => protocolErrors.push(error),
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    const closed = once(client, "close");
    client.send(JSON.stringify({
      id: 1,
      method: "turn/start",
      params: { threadId: "thread-send-failure", input: [] },
    }));
    await closed;
    assert.equal(acknowledged, 0);
    assert.match(protocolErrors[0].message, /synthetic upstream send failure/);
  } finally {
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("App Server route proxy reserves a pending route until forwarding acknowledges it", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  let pending = { session_id: "thread-race", model: "openai-codex/gpt-5.6-sol" };
  let releaseFirstForward;
  const firstForwardBlocked = new Promise((resolveForward) => { releaseFirstForward = resolveForward; });
  let firstForwardStarted;
  const firstForwarding = new Promise((resolveStarted) => { firstForwardStarted = resolveStarted; });
  const forwarded = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
    takePendingRoute: async (threadId) => pending?.session_id === threadId ? {
      route: pending,
      ack: async () => { pending = null; },
    } : null,
    forwardPayload: async (_socket, payload) => {
      forwarded.push(JSON.parse(payload));
      if (forwarded.length === 1) {
        firstForwardStarted();
        await firstForwardBlocked;
      }
    },
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    client.send(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-race", input: [] } }));
    await firstForwarding;
    client.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thread-race", input: [] } }));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    assert.equal(forwarded.length, 1);
    releaseFirstForward();
    for (let attempt = 0; attempt < 100 && forwarded.length < 2; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    assert.equal(forwarded.length, 2);
    assert.equal(forwarded[0].params.model, "gpt-5.6-sol");
    assert.equal(forwarded[1].params.model, undefined);
  } finally {
    releaseFirstForward?.();
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("App Server route proxy quarantines a route after post-forward acknowledgement failure", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  let reserved = false;
  let releaseCount = 0;
  let releaseFirstForward;
  const firstForwardBlocked = new Promise((resolveForward) => { releaseFirstForward = resolveForward; });
  let firstForwardStarted;
  const firstForwarding = new Promise((resolveStarted) => { firstForwardStarted = resolveStarted; });
  const forwarded = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
    takePendingRoute: async () => {
      if (reserved) return null;
      reserved = true;
      return {
        route: { session_id: "thread-ack-failure", model: "openai-codex/gpt-5.6-sol" },
        ack: async () => { throw new Error("synthetic acknowledgement failure"); },
        release: async () => { reserved = false; releaseCount += 1; },
      };
    },
    forwardPayload: async (_socket, payload) => {
      forwarded.push(JSON.parse(payload));
      if (forwarded.length === 1) {
        firstForwardStarted();
        await firstForwardBlocked;
      }
    },
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    const closed = once(client, "close");
    client.send(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-ack-failure", input: [] } }));
    await firstForwarding;
    client.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thread-ack-failure", input: [] } }));
    releaseFirstForward();
    await closed;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].params.model, "gpt-5.6-sol");
    assert.equal(releaseCount, 0);
  } finally {
    releaseFirstForward?.();
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("App Server route proxy injects one pending route and records the server receipt", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  const injected = [];
  const confirmed = [];
  let acknowledged = 0;
  let pending = { session_id: "thread-proxy", model: "openai-codex/gpt-5.6-sol", effort: "high" };
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
    takePendingRoute: async (threadId) => {
      if (pending?.session_id !== threadId) return null;
      const route = pending;
      pending = null;
      return { route, ack: async () => { acknowledged += 1; } };
    },
    onRouteInjected: async (receipt) => injected.push(receipt),
    onRouteConfirmed: async (receipt) => confirmed.push(receipt),
    threadListCwd: "/repo",
  });
  let upstreamSocket;
  const upstreamConnection = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  await upstreamConnection;
  assert.equal((await fetch(`${proxy.url.replace("ws:", "http:")}/readyz`)).status, 200);
  assert.equal((await fetch(`${proxy.url.replace("ws:", "http:")}/healthz`)).status, 200);
  const listForwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: -1, method: "thread/list", params: { limit: 20 } }));
  assert.deepEqual(await listForwarded, { id: -1, method: "thread/list", params: { limit: 20, cwd: "/repo" } });
  const labelledList = new Promise((resolveMessage) => client.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  upstreamSocket.send(JSON.stringify({
    id: -1,
    result: { data: [{ id: "thread-proxy", cwd: "/repo", name: "Project session", status: { type: "notLoaded" } }] },
  }));
  assert.deepEqual(await labelledList, {
    id: -1,
    result: { data: [{ id: "thread-proxy", cwd: "/repo", name: "[/repo] Project session", status: { type: "notLoaded" } }] },
  });
  const childForwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 0, method: "turn/start", params: { threadId: "child-thread", input: [] } }));
  const childRequest = await childForwarded;
  assert.equal(childRequest.params.model, undefined);
  assert.equal(injected.length, 0);
  const forwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-proxy", input: [] } }));
  const request = await forwarded;
  assert.equal(request.params.model, "gpt-5.6-sol");
  assert.equal(request.params.effort, "high");
  assert.equal(injected.length, 1);
  assert.equal(acknowledged, 1);
  upstreamSocket.send(JSON.stringify({
    method: "thread/settings/updated",
    params: { threadId: "thread-proxy", threadSettings: { model: "gpt-5.6-sol", effort: "high" } },
  }));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  assert.deepEqual(confirmed.map(({ confirmed: value }) => value), [true]);
  const nativeResponse = new Promise((resolveMessage) => client.once("message", (raw, isBinary) => {
    resolveMessage({ message: JSON.parse(String(raw)), isBinary });
  }));
  upstreamSocket.send(JSON.stringify({ id: 1, result: { ok: true } }));
  assert.deepEqual(await nativeResponse, { message: { id: 1, result: { ok: true } }, isBinary: false });
  const forwardedResume = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "thread-proxy", initialTurnsPage: { limit: 100 } } }));
  assert.deepEqual(await forwardedResume, {
    id: 2,
    method: "thread/resume",
    params: { threadId: "thread-proxy", excludeTurns: true, initialTurnsPage: { limit: 4, sortDirection: "desc", itemsView: "summary" } },
  });
  const compactResumeResponse = new Promise((resolveMessage) => client.once("message", (raw, isBinary) => {
    resolveMessage({ message: JSON.parse(String(raw)), isBinary });
  }));
  upstreamSocket.send(JSON.stringify({ id: 2, result: { thread: { id: "thread-proxy", turns: [] }, initialTurnsPage: { data: [{ id: "newest" }, { id: "older" }] } } }));
  assert.deepEqual(await compactResumeResponse, {
    message: { id: 2, result: { thread: { id: "thread-proxy", turns: [{ id: "older" }, { id: "newest" }] }, initialTurnsPage: { data: [{ id: "newest" }, { id: "older" }] } } },
    isBinary: false,
  });
  const rejectedResumeForwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 3, method: "thread/resume", params: { threadId: "thread-proxy" } }));
  assert.equal((await rejectedResumeForwarded).method, "thread/resume");
  const rejectedResumeResponse = new Promise((resolveMessage) => client.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  upstreamSocket.send(JSON.stringify({ id: 3, error: { code: -32600, message: "thread thread-proxy already has an active writer" } }));
  const rejected = await rejectedResumeResponse;
  assert.equal(rejected.error.code, -32600);
  assert.match(rejected.error.message, /wait a minute or two for the current turn to finish, then try again/i);
  const nonResumeForwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 4, method: "thread/read", params: { threadId: "thread-proxy" } }));
  assert.equal((await nonResumeForwarded).method, "thread/read");
  const nonResumeResponse = new Promise((resolveMessage) => client.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  const nativeNonResumeError = { id: 4, error: { code: -32600, message: "thread thread-proxy already has an active writer" } };
  upstreamSocket.send(JSON.stringify(nativeNonResumeError));
  assert.deepEqual(await nonResumeResponse, nativeNonResumeError);
  client.close();
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("App Server route proxy binds a bare-picker selection and refreshes labels on subsequent lists", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  const labels = {};
  const resumed = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
    getThreadLabels: async () => labels,
    onThreadResumed: async ({ threadId }) => {
      resumed.push(threadId);
      labels[`codex:${threadId}`] = { label: "adv" };
    },
  });
  const upstreamConnection = new Promise((resolveConnection) => upstream.once("connection", resolveConnection));
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  const upstreamSocket = await upstreamConnection;
  const resumeForwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "picker-thread" } }));
  assert.equal((await resumeForwarded).method, "thread/resume");
  const resumeResult = new Promise((resolveMessage) => client.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  upstreamSocket.send(JSON.stringify({ id: 1, result: { thread: { id: "picker-thread" } } }));
  await resumeResult;
  assert.deepEqual(resumed, ["picker-thread"]);
  const listForwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 2, method: "thread/list", params: {} }));
  await listForwarded;
  const listResult = new Promise((resolveMessage) => client.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  upstreamSocket.send(JSON.stringify({ id: 2, result: { data: [{ id: "picker-thread", cwd: "/repo", name: "Selected session" }] } }));
  assert.equal((await listResult).result.data[0].name, "[adv · /repo] Selected session");
  client.close();
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("App Server route proxy fails open when optional picker-label callbacks fail", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
    getThreadLabels: async () => { throw new Error("label store unavailable"); },
    onThreadResumed: async () => { throw new Error("label write unavailable"); },
  });
  const upstreamConnection = new Promise((resolveConnection) => upstream.once("connection", resolveConnection));
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  const upstreamSocket = await upstreamConnection;
  client.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "still-resumes" } }));
  await new Promise((resolveMessage) => upstreamSocket.once("message", resolveMessage));
  const result = new Promise((resolveMessage) => client.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  upstreamSocket.send(JSON.stringify({ id: 1, result: { thread: { id: "still-resumes" } } }));
  assert.equal((await result).result.thread.id, "still-resumes");
  client.close();
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});
