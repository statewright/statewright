import test from "node:test";
import assert from "node:assert/strict";
import {once} from "node:events";
import {WebSocket, WebSocketServer} from "ws";
import {startCodexAppServerRouteProxy} from "../lib/codex-app-server-route-proxy.mjs";

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for protocol evidence");
}

for (const scenario of ["hosted", "hosted-notification-first", "hosted-streaming", "hosted-foreign-start", "switch", "failed-switch", "foreign-switch"]) {
  test(`Statewright native shim handoff: ${scenario}`, async t => {
    const hosted = scenario.startsWith("hosted");
    const server = new WebSocketServer({port: 0, host: "127.0.0.1"});
    await once(server, "listening");
    let upstream;
    const calls = [], rawEvents = [], statuses = [], visible = [];
    const send = value => {rawEvents.push(value); upstream.send(JSON.stringify(value));};
    server.on("connection", ws => {
      upstream = ws;
      ws.on("message", raw => {
        const req = JSON.parse(String(raw)); calls.push(req);
        if (req.method === "thread/start") return send({id: req.id, result: {
          thread: {id: "t1"}, modelProvider: hosted ? "openai" : "another-provider", model: "previous-model"}});
        if (req.method === "thread/resume" && req.params.modelProvider === "openai") {
          send({method: "warning", params: {threadId: "t1", message:
            "This session was recorded with model `previous-model` but is resuming with `gpt-6-astra`. Consider switching back to `previous-model` as it may affect Codex performance."}});
          send({method: "warning", params: {threadId: "t1", message: "Unrelated diagnostic"}});
          return send(scenario === "failed-switch" ? {id: req.id, error: {code: -32600, message: "resume failed"}}
            : {id: req.id, result: {thread: {id: scenario === "foreign-switch" ? "foreign" : "t1"}, modelProvider: "openai", model: "gpt-6-astra"}});
        }
        if (req.method === "turn/start") {
          const start = {method: "turn/started", params: {threadId: "t1", turn: {id: "next", status: "inProgress", items: []}}};
          if (scenario === "hosted-foreign-start") send({...start, params: {...start.params, turn: {...start.params.turn, id: "foreign"}}});
          const early = ["hosted-notification-first", "hosted-streaming"].includes(scenario);
          if (early) send(start);
          if (scenario === "hosted-streaming") send({method: "item/agentMessage/delta", params: {threadId: "t1", turnId: "next", itemId: "answer", delta: "partial answer"}});
          send({id: req.id, result: {turn: {id: "next", status: "inProgress"}}});
          if (!early) send(start);
          return;
        }
        send({id: req.id, result: {thread: {id: "t1"}, modelProvider: "another-provider", model: "previous-model"}});
      });
    });
    let route = {session_id: "t1", run_id: "run1", state: "intake", model: "openai-codex/gpt-6-astra", effort: "high"};
    const proxy = await startCodexAppServerRouteProxy({upstreamUrl: `ws://127.0.0.1:${server.address().port}`,
      onHandoffStatus: event => statuses.push(event),
      takePendingRoute: async () => {const next = route; route = null; return next;}});
    const client = new WebSocket(proxy.url);
    client.on("message", raw => visible.push(JSON.parse(String(raw))));
    await once(client, "open");
    t.after(async () => {client.terminate(); await proxy.close(); for (const ws of server.clients) ws.terminate(); await new Promise(resolve => server.close(resolve));});
    client.send(JSON.stringify({id: 1, method: "thread/start", params: {}}));
    await until(() => visible.some(x => x.id === 1));
    client.send(JSON.stringify({id: 2, method: "turn/start", params: {threadId: "t1", input: [{type: "text", text: "real user input"}]}}));
    const failed = scenario.endsWith("switch") && scenario !== "switch";
    await until(() => failed ? visible.some(x => x.id === 2 && x.error) : statuses.length === 1 && visible.some(x => x.id === 2));
    const warnings = visible.filter(x => x.method === "warning");
    if (!hosted) {
      assert(warnings.some(x => x.params.message === "Unrelated diagnostic"));
      assert.equal(warnings.some(x => x.params.message.startsWith("This session")), failed);
      assert(rawEvents.some(x => x.params?.message?.startsWith("This session")));
    }
    if (failed) {
      assert.equal(statuses.length, 0);
      assert.equal(calls.filter(x => x.method === "turn/start").length, 0);
    } else {
      assert.equal(statuses.length, 1);
      assert.equal(statuses[0].schema, "statewright/app-server-handoff/v1");
      assert.equal(statuses[0].state, "intake");
      assert.equal(statuses[0].model, "gpt-6-astra");
      assert.equal(statuses[0].run_id, "run1");
      assert.equal(statuses[0].turn_id, "next");
      assert.equal(visible.some(x => x.params?.item?.text?.includes("running")), scenario !== "hosted-streaming");
      assert.equal(calls.find(x => x.method === "turn/start").params.input[0].text, "real user input");
      const terminal = {method: "turn/completed", params: {threadId: "t1", turn: {id: "next", status: "interrupted", items: []}}};
      send(terminal);
      await until(() => visible.some(x => x.method === "turn/completed"));
      assert.deepEqual(visible.find(x => x.method === "turn/completed"), terminal, "unowned native interruption remains intact");
    }
  });
}
