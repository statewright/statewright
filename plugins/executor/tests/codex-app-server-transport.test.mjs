import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import {
  appServerHomePrefixForClient,
  codexAppServerTransportEnabled,
  routeConfigEdits,
} from "../lib/codex-app-server-transport.mjs";
import { applyRouteToTurnStart, settingsConfirmRoute, startCodexAppServerRouteProxy } from "../lib/codex-app-server-route-proxy.mjs";

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
  }, { model: "openai-codex/gpt-5.6-sol", effort: "high" });
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
});

test("App Server route proxy injects one pending route and records the server receipt", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  const injected = [];
  const confirmed = [];
  let pending = { model: "openai-codex/gpt-5.6-sol", effort: "high" };
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
    takePendingRoute: async () => {
      const route = pending;
      pending = null;
      return route;
    },
    onRouteInjected: async (receipt) => injected.push(receipt),
    onRouteConfirmed: async (receipt) => confirmed.push(receipt),
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
  const forwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-proxy", input: [] } }));
  const request = await forwarded;
  assert.equal(request.params.model, "gpt-5.6-sol");
  assert.equal(request.params.effort, "high");
  assert.equal(injected.length, 1);
  upstreamSocket.send(JSON.stringify({
    method: "thread/settings/updated",
    params: { threadId: "thread-proxy", threadSettings: { model: "gpt-5.6-sol", effort: "high" } },
  }));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  assert.deepEqual(confirmed.map(({ confirmed: value }) => value), [true]);
  client.close();
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});
