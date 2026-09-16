import test from "node:test";
import assert from "node:assert/strict";
import {once} from "node:events";
import {mkdtemp, writeFile, readdir, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {WebSocket, WebSocketServer} from "ws";
import {hardInterruptNotice} from "../lib/app-server-handoff.mjs";
import {routeIdentity, startCodexAppServerRouteProxy} from "../lib/codex-app-server-route-proxy.mjs";
import {peekCodexResidentRouteRequest} from "../lib/codex-app-server-resident.mjs";

const sol = {provider: "openai", model: "gpt-5.6-sol"};
// These transport fixtures explicitly supply a compatibility boundary.
process.env.STATEWRIGHT_QWEN_BASE_URL = 'http://127.0.0.1:1/v1';
test('standalone routing cannot silently bypass the local-model compatibility layer', () => {
  assert.throws(() => routeIdentity('casa/qwen3.8-27b', {}), /Direct-backend fallback is disabled/);
  assert.equal(routeIdentity('openai-codex/gpt-5.6-sol', {}).provider, 'openai');
});
const astra = {provider: "openai", model: "gpt-6-astra"};
const qwen = {provider: "qwen_private", model: "qwen3.8-27b"};
const until = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("timed out waiting for protocol evidence");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

for (const [from, to] of [[sol, astra], [astra, sol], [sol, qwen], [qwen, astra]]) {
  for (const mode of ["owned", "operator", "stale", "legacy", "lookup-fails", "lookup-stalls", "completed", "failed", "operator-race", ...(from.provider !== to.provider ? ["provider-fails", "provider-mismatch"] : [])]) {
    test(`${from.model}=>${to.model}: ${mode}`, async t => {
      const server = new WebSocketServer({host: "127.0.0.1", port: 0});
      await once(server, "listening");
      let upstream, pending, releaseLookup, resumeCount = 0;
      const owned = ["owned", "provider-fails", "provider-mismatch"].includes(mode);
      const visible = [], calls = [];
      const send = value => upstream.send(JSON.stringify(value));
      server.on("connection", socket => {
        upstream = socket;
        socket.on("message", raw => {
          const request = JSON.parse(String(raw)); calls.push(request);
          if (request.method === "thread/start") send({id: request.id, result: {thread: {id: "t"}, modelProvider: from.provider, model: from.model}});
          else if (request.method === "thread/resume") {
            resumeCount++;
            if (mode === "provider-fails" && resumeCount === 1) return send({id: request.id, error: {code: -32600, message: "destination unavailable"}});
            const actual = mode.startsWith("provider-") ? from : to;
            send({id: request.id, result: {thread: {id: "t"}, modelProvider: actual.provider, model: actual.model}});
          }
          else if (request.method === "turn/start") {
            send({id: request.id, result: {turn: {id: "next"}}});
            send({method: "turn/started", params: {threadId: "t", turn: {id: "next", status: "inProgress"}}});
          } else send({id: request.id, result: {}});
        });
      });
      const proxy = await startCodexAppServerRouteProxy({upstreamUrl: `ws://127.0.0.1:${server.address().port}`,
        takePendingRoute: async () => pending ? {route: pending, ack: async () => {pending = null;}, release: async () => {}} : null,
        peekPendingRoute: async (threadId, turnId) => {
          assert.equal(threadId, "t"); assert.equal(turnId, "old");
          if (mode === "lookup-fails") throw Error("unavailable");
          if (mode === "lookup-stalls") return new Promise(() => {});
          if (mode === "operator-race") await new Promise(resolve => {releaseLookup = resolve;});
          return pending;
        }});
      const client = new WebSocket(proxy.url);
      client.on("message", raw => visible.push(JSON.parse(String(raw))));
      await once(client, "open");
      t.after(async () => {client.terminate(); await proxy.close(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve));});
      client.send(JSON.stringify({id: 1, method: "thread/start", params: {}}));
      await until(() => visible.some(value => value.id === 1));
      send({method: "turn/started", params: {threadId: "t", turn: {id: "old", status: "inProgress"}}});
      await until(() => visible.some(value => value.method === "turn/started"));
      // A partial native answer must not be replaced by a synthetic agent item.
      send({method: "item/agentMessage/delta", params: {threadId: "t", turnId: "old", itemId: "answer", delta: "partial"}});
      pending = {session_id: "t", turn_id: mode === "stale" ? "different" : "old", run_id: "run", state: "validate", model: `${to.provider === "openai" ? "openai-codex" : "casa"}/${to.model}`, effort: "high"};
      if (mode === "legacy") delete pending.turn_id;
      if (mode === "operator") {
        client.send(JSON.stringify({id: 2, method: "turn/interrupt", params: {threadId: "t", turnId: "old"}}));
        await until(() => calls.some(value => value.id === 2));
      }
      const terminal = {method: "turn/completed", params: {threadId: "t", turn: {id: "old", status: ["completed", "failed"].includes(mode) ? mode : "interrupted", items: []}}};
      send(terminal);
      if (mode === "operator-race") {
        await until(() => releaseLookup);
        client.send(JSON.stringify({id: 2, method: "turn/interrupt", params: {threadId: "t", turnId: "old"}}));
        await until(() => calls.some(value => value.id === 2));
        releaseLookup();
      }
      await until(() => visible.some(value => value.method === "turn/completed"));
      const index = visible.findIndex(value => value.method === "turn/completed");
      assert.deepEqual(visible[index], terminal);
      const warnings = visible.filter(value => value.method === "warning");
      assert.equal(warnings.length, owned ? 1 : 0);
      if (!owned) return;
      assert.equal(visible[index - 1].params.message, hardInterruptNotice(from, to));
      assert(pending, "display must not consume the route");
      client.send(JSON.stringify({id: 3, method: "turn/start", params: {threadId: "t", input: [{type: "text", text: "untouched queued input"}]}}));
      await until(() => visible.some(value => value.id === 3));
      if (mode.startsWith("provider-")) {
        assert(visible.find(value => value.id === 3).error);
        assert(!calls.some(value => value.method === "turn/start"));
        assert(pending, "failed destination preserves the route for retry");
        const resumes = calls.filter(value => value.method === "thread/resume");
        assert.equal(resumes.length, 2);
        assert.equal(resumes[1].params.modelProvider, from.provider);
        assert.equal(resumes[1].params.model, from.model);
        client.send(JSON.stringify({id: 4, method: "thread/read", params: {threadId: "t"}}));
        await until(() => visible.some(value => value.id === 4));
        assert.equal(client.readyState, WebSocket.OPEN);
        return;
      }
      const start = calls.find(value => value.method === "turn/start");
      assert.equal(start.params.model, to.model);
      assert.equal(start.params.input[0].text, "untouched queued input");
      const resumes = calls.filter(value => value.method === "thread/resume");
      assert.equal(resumes.length, from.provider === to.provider ? 0 : 1);
      if (resumes.length) assert.equal(resumes[0].params.modelProvider, to.provider);
    });
  }
}

test("notice excludes effort-only, unknown and unrelated provider routes", () => {
  for (const [from, to] of [[sol, sol], [{model: sol.model}, astra], [sol, {provider: "other", model: "model"}]]) assert.equal(hardInterruptNotice(from, to), null);
});

test("resident peek validates client/root/turn without consuming or searching past a stale route", async t => {
  const clientId = "swc_0123456789abcdef0123456789abcdef";
  const dir = await mkdtemp(join(tmpdir(), "statewright-preface-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  await writeFile(join(dir, "codex-root-session.json"), JSON.stringify({version: 1, session_id: "t", client_id: clientId}));
  const route = {client_id: clientId, session_id: "t", root_session_id: "t", turn_id: "old", model: "openai-codex/gpt-6-astra"};
  await writeFile(join(dir, "01.route.json"), JSON.stringify(route));
  const before = await readdir(dir);
  assert.deepEqual(await peekCodexResidentRouteRequest(dir, clientId, "t", "old"), route);
  assert.equal(await peekCodexResidentRouteRequest(dir, clientId, "t", "new"), null);
  assert.equal(await peekCodexResidentRouteRequest(dir, "other", "t", "old"), null);
  assert.equal(await peekCodexResidentRouteRequest(dir, clientId, "foreign", "old"), null);
  await writeFile(join(dir, "02.route.json"), JSON.stringify({...route, turn_id: "new"}));
  assert.equal(await peekCodexResidentRouteRequest(dir, clientId, "t", "new"), null);
  assert.deepEqual((await readdir(dir)).filter(name => name !== "02.route.json"), before);
});
