import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { startCodexAppServerRouteProxy } from "../lib/codex-app-server-route-proxy.mjs";
import { createDesktopThreadDispatcher } from "../lib/desktop-thread-dispatcher.mjs";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for protocol evidence");
    await wait(5);
  }
}

test("late and duplicate internal replies stay private through the Desktop dispatcher", { timeout: 20000 }, async t => {
  const lanes = new Map(), output = [], timers = [];
  const dispatcher = createDesktopThreadDispatcher({
    emit: message => output.push(message), readBinding: async () => null, saveBinding: async () => {},
    openLane: async ({ key, threadId, emit, onClose }) => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const lane = { probes: [], requests: [], closed: 0 };
      lanes.set(threadId ?? key, lane);
      server.on("connection", ws => {
        lane.native = ws;
        ws.on("message", raw => {
          const request = JSON.parse(String(raw)); lane.requests.push(request);
          if (!request.method || request.id === undefined) return;
          const send = result => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ id: request.id, result }));
          if (request.method === "mcpServerStatus/list") {
            lane.probes.push(request);
            const result = { data: [{ name: "statewright", tools: { statewright_get_state: {} } }], nextCursor: null };
            if (threadId === FIRST && lane.probes.length === 1) timers.push(setTimeout(() => send(result), 13000));
            else send(result);
          } else if (request.method === "thread/resume") send({ thread: { id: threadId } });
          else if (request.method === "turn/start") send({ turn: { id: `turn-${request.id}`, status: "inProgress" } });
          else send({});
        });
      });
      const proxy = await startCodexAppServerRouteProxy({ upstreamUrl: `ws://127.0.0.1:${server.address().port}`,
        requiredMcpToolSuffix: "statewright_get_state", requiredMcpReadyTimeoutMs: 30000 });
      const socket = new WebSocket(proxy.url);
      socket.on("message", raw => emit(JSON.parse(String(raw)))); socket.on("close", onClose);
      await once(socket, "open");
      return { send: message => socket.send(JSON.stringify(message)), close: async () => {
        lane.closed++; socket.terminate(); await proxy.close();
        for (const client of server.clients) client.terminate();
        await new Promise(resolve => server.close(resolve));
      } };
    },
  });
  t.after(async () => { for (const timer of timers) clearTimeout(timer); await dispatcher.close(); });
  const call = async (id, method, params = {}) => {
    await dispatcher.handle({ id, method, params });
    await until(() => output.some(message => message.id === id));
    const response = output.find(message => message.id === id); assert.equal(response.error, undefined); return response;
  };
  await call("init", "initialize");
  await call("resume-a", "thread/resume", { threadId: FIRST });
  await call("resume-b", "thread/resume", { threadId: SECOND });
  await dispatcher.handle({ id: "slow-turn", method: "turn/start", params: { threadId: FIRST, input: [] } });
  await call("independent-turn", "turn/start", { threadId: SECOND, input: [] });
  await until(() => lanes.get(FIRST).probes.length === 2, 14000);
  await until(() => output.some(message => message.id === "slow-turn"));
  await wait(1100); // first response arrives after its 12-second internal timeout
  const first = lanes.get(FIRST), second = lanes.get(SECOND);
  assert.equal(first.closed, 0, "late owned reply must not retire its chat");
  assert.equal(output.some(message => String(message.id).startsWith("statewright-")), false);
  const owned = first.probes[0].id;
  first.native.send(JSON.stringify({ id: owned, error: { code: -1, message: "duplicate late error" } }));
  first.native.send(JSON.stringify({ id: first.probes[1].id, result: {} }));
  // Request IDs in the reverse direction are independent, even when identical.
  first.native.send(JSON.stringify({ id: owned, method: "item/tool/requestUserInput", params: { threadId: FIRST } }));
  await until(() => output.some(message => message.method === "item/tool/requestUserInput"));
  const prompt = output.find(message => message.method === "item/tool/requestUserInput");
  await dispatcher.handle({ id: prompt.id, result: { answers: {} } });
  await until(() => first.requests.some(message => message.id === owned && message.result));
  await call("still-attached", "turn/start", { threadId: FIRST, input: [] });
  // A real foreign response still retires only the offending lane.
  first.native.send(JSON.stringify({ id: second.probes[0].id, result: {} }));
  await until(() => first.closed === 1);
  await call("other-survives", "turn/start", { threadId: SECOND, input: [] });
  assert.equal(second.closed, 0);
});

test("internal ownership excludes unissued, noncanonical and wrong-type IDs and rejects client reuse", { timeout: 5000 }, async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let native, owned;
  const output = [], forwarded = [];
  server.on("connection", ws => {
    native = ws;
    ws.on("message", raw => {
      const request = JSON.parse(String(raw)); forwarded.push(request);
      if (request.method === "mcpServerStatus/list") {
        owned = request.id;
        ws.send(JSON.stringify({ id: owned, result: { data: [{ name: "statewright", tools: { statewright_get_state: {} } }] } }));
      } else if (request.id !== undefined) ws.send(JSON.stringify({ id: request.id, result: {} }));
    });
  });
  const proxy = await startCodexAppServerRouteProxy({ upstreamUrl: `ws://127.0.0.1:${server.address().port}`,
    requiredMcpToolSuffix: "statewright_get_state", requiredMcpReadyTimeoutMs: 1000 });
  const client = new WebSocket(proxy.url);
  client.on("message", raw => output.push(JSON.parse(String(raw))));
  t.after(async () => { client.terminate(); await proxy.close(); for (const ws of server.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); });
  await once(client, "open");
  client.send(JSON.stringify({ id: "turn", method: "turn/start", params: { threadId: FIRST, input: [] } }));
  await until(() => output.some(message => message.id === "turn"));
  const prefix = owned.slice(0, owned.lastIndexOf(":") + 1);
  const foreign = [`${prefix}0`, `${prefix}01`, `${prefix}1.0`, `${prefix}2`, `${prefix}1e0`, 1, "statewright-provider-switch-1"];
  for (const id of foreign) native.send(JSON.stringify({ id, result: {} }));
  await until(() => foreign.every(id => output.some(message => message.id === id)));
  assert.equal(output.some(message => message.id === owned), false);
  const closed = once(client, "close");
  client.send(JSON.stringify({ id: `${prefix}2`, method: "thread/list", params: {} }));
  await closed;
  assert.equal(forwarded.some(message => message.method === "thread/list"), false);
});

test("missing required Statewright tool fails only its turn and does not accept another server's tool", { timeout: 5000 }, async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const forwarded = [], output = [];
  server.on("connection", ws => ws.on("message", raw => {
    const request = JSON.parse(String(raw)); forwarded.push(request);
    if (request.id !== undefined) ws.send(JSON.stringify({ id: request.id, result: request.method === "mcpServerStatus/list"
      ? { data: [{ name: "unrelated", tools: { statewright_get_state: {} } }], nextCursor: null } : {} }));
  }));
  const proxy = await startCodexAppServerRouteProxy({ upstreamUrl: `ws://127.0.0.1:${server.address().port}`,
    requiredMcpToolSuffix: "statewright_get_state", requiredMcpReadyTimeoutMs: 100 });
  const client = new WebSocket(proxy.url);
  client.on("message", raw => output.push(JSON.parse(String(raw))));
  t.after(async () => { client.terminate(); await proxy.close(); for (const ws of server.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); });
  await once(client, "open");
  client.send(JSON.stringify({ id: "blocked", method: "turn/start", params: { threadId: FIRST, input: [] } }));
  await until(() => output.some(message => message.id === "blocked"));
  assert.match(output.find(message => message.id === "blocked").error.message, /MCP tools did not become ready/);
  assert.equal(forwarded.some(message => message.method === "turn/start"), false);
  assert.equal(client.readyState, WebSocket.OPEN);
});
