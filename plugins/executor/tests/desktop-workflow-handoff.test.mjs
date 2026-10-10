import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { startCodexAppServerRouteProxy } from "../lib/codex-app-server-route-proxy.mjs";

const threadId = "handoff-thread";
const stateFor = (state, epoch, model, effort) => ({state, state_epoch: epoch,
  run_id: "handoff-run", run_session_id: "handoff-session", model,
  thinking_level: effort, service_tier: "priority", is_final: false});
async function until(check) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("workflow did not hand off to a new native turn");
}
async function fixture(t) {
  const server = new WebSocketServer({port: 0, host: "127.0.0.1"});
  await once(server, "listening");
  let socket, state = null, active = false, turnId, sequence = 0, heldRead, heldStart, heldOwner, ownerEntered = false, wrongModel = false;
  let settings = {model: "gpt-6-sol", modelProvider: "openai", effort: "high", serviceTier: "priority"};
  const calls = [], confirmed = [], injected = [], frames = [], errors = [];
  server.on("connection", ws => {
    socket = ws;
    ws.on("message", async raw => {
      const r = JSON.parse(String(raw)); calls.push(r);
      if (!r.method || r.id === undefined) return;
      const reply = result => ws.send(JSON.stringify({id: r.id, result}));
      const notify = (method, params) => ws.send(JSON.stringify({method, params}));
      if (["thread/start", "thread/resume"].includes(r.method)) return reply({...settings, thread: {id: threadId}});
      if (r.method === "thread/read") return reply({thread: {id: threadId, status: {type: active ? "active" : "idle"}}});
      if (r.method === "turn/interrupt") {
        active = false; reply({});
        return notify("turn/completed", {threadId, turn: {id: turnId, status: "interrupted"}});
      }
      if (r.method === "thread/settings/update") {
        settings = {...settings, ...r.params, ...(wrongModel ? {model: "wrong-model"} : {})}; reply({});
        return notify("thread/settings/updated", {threadId, threadSettings: settings});
      }
      if (r.method === "turn/start") {
        if (sequence > 0 && heldStart) await heldStart;
        active = true; turnId = `turn-${++sequence}`;
        reply({turn: {id: turnId}});
        return notify("turn/started", {threadId, turn: {id: turnId}});
      }
      reply({});
    });
  });
  const proxy = await startCodexAppServerRouteProxy({upstreamUrl: `ws://127.0.0.1:${server.address().port}`,
    workflowService: {ownsThread: async id => {
      if (heldOwner && sequence > 1) {ownerEntered = true; await heldOwner;}
      return id === threadId;
    }, getState: async () => {
      if (heldRead) await heldRead; return state;
    }},
    routeOwner: async () => ({client_id: "handoff-client", root_session_id: threadId}),
    onRouteInjected: async r => injected.push(r), onRouteConfirmed: async r => confirmed.push(r),
    onProtocolError: async error => errors.push(error)});
  const client = new WebSocket(proxy.url);
  client.on("message", raw => frames.push(JSON.parse(String(raw))));
  await once(client, "open");
  let id = 0;
  const rpc = async (method, params = {}) => {
    const key = ++id; client.send(JSON.stringify({id: key, method, params}));
    await until(() => frames.some(f => f.id === key));
    const response = frames.find(f => f.id === key);
    assert.equal(response.error, undefined); return response.result;
  };
  await rpc("initialize"); client.send(JSON.stringify({method: "initialized"}));
  await rpc("thread/resume", {threadId});
  await rpc("turn/start", {threadId, model: "gpt-6-sol", effort: "high"});
  const completeTool = (tool, result, overrides = {}) => socket.send(JSON.stringify({method: "item/completed", params: {
    threadId, turnId, item: {type: "mcpToolCall", id: `item-${sequence}-${tool}`, server: "statewright", tool,
      status: "completed", result: {structuredContent: result}, ...overrides}}}));
  t.after(async () => { client.terminate(); await proxy.close(); for (const s of server.clients) s.terminate(); await new Promise(r => server.close(r)); });
  return {calls, frames, confirmed, injected, errors, rpc, completeTool, setState: v => {state = v;},
    hold: p => {heldRead = p;}, holdStart: p => {heldStart = p;}, mismatch: () => {wrongModel = true;},
    holdOwner: p => {heldOwner = p;}, ownerEntered: () => ownerEntered,
    finish: () => {active = false; socket.send(JSON.stringify({method: "turn/completed", params: {threadId, turn: {id: turnId, status: "completed"}}}));}};
}

test("Desktop load and transition cut over native turns and restore the original route", async t => {
  const f = await fixture(t);
  const intake = stateFor("intake", 1, "openai-codex/gpt-5.6-terra", "low");
  f.setState(intake); f.completeTool("statewright_load_workflow", {loaded: true, state_snapshot: intake});
  await until(() => f.calls.filter(c => c.method === "turn/start").length === 2 || f.errors.length);
  assert.deepEqual(f.errors, []);
  assert.equal(f.calls.filter(c => c.method === "turn/start")[1].params.model, "gpt-5.6-terra");
  const review = stateFor("frontier_review", 2, "openai-codex/gpt-6-astra", "high");
  f.setState(review); f.completeTool("statewright_transition", {transitioned: true, from: "intake", to: "frontier_review"});
  await until(() => f.calls.filter(c => c.method === "turn/start").length === 3);
  assert.equal(f.calls.filter(c => c.method === "turn/start")[2].params.model, "gpt-6-astra");
  assert.equal(f.confirmed.filter(r => r.confirmed).length, 2);
  f.setState({...review, state: "complete", state_epoch: 3, is_final: true});
  f.completeTool("statewright_transition", {transitioned: true, from: "frontier_review", to: "complete"});
  f.finish();
  await until(() => f.confirmed.some(r => r.confirmed && r.route.restored_original));
  assert.equal(f.calls.filter(c => c.method === "thread/settings/update").at(-1).params.model, "gpt-6-sol");
  assert.equal(f.calls.filter(c => c.method === "turn/start").length, 3);
});

test("foreign, failed and duplicate lifecycle completions cannot start extra turns", async t => {
  const f = await fixture(t);
  const intake = stateFor("intake", 1, "openai-codex/gpt-5.6-terra", "low");
  f.setState(intake);
  f.completeTool("statewright_load_workflow", {loaded: true, state_snapshot: intake}, {server: "codex_apps"});
  f.completeTool("statewright_load_workflow", {loaded: true, state_snapshot: intake}, {status: "failed"});
  await new Promise(r => setTimeout(r, 30));
  assert.equal(f.calls.filter(c => c.method === "turn/start").length, 1);
  f.completeTool("statewright_load_workflow", {loaded: true, state_snapshot: intake});
  f.completeTool("statewright_load_workflow", {loaded: true, state_snapshot: intake});
  await until(() => f.calls.filter(c => c.method === "turn/start").length === 2);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(f.calls.filter(c => c.method === "turn/start").length, 2);
});

test("a manual interruption supersedes an in-flight workflow handoff", async t => {
  const f = await fixture(t);
  const intake = stateFor("intake", 1, "openai-codex/gpt-5.6-terra", "low");
  let release;
  f.hold(new Promise(resolve => {release = resolve}));
  f.setState(intake); f.completeTool("statewright_load_workflow", {state_snapshot: intake});
  await new Promise(r => setTimeout(r, 15));
  await f.rpc("turn/interrupt", {threadId, turnId: "turn-1"});
  release();
  await until(() => f.errors.length > 0);
  assert.equal(f.calls.filter(c => c.method === "turn/start").length, 1);
  assert.equal(f.calls.filter(c => c.method === "turn/interrupt").length, 1);
  assert.equal(f.calls.filter(c => c.method === "thread/settings/update").length, 0);
});

for (const kind of ["approval", "foreign-run", "native-mismatch"]) {
  test(`handoff stops rather than inferring success for ${kind}`, async t => {
    const f = await fixture(t);
    const intake = stateFor("intake", 1, "openai-codex/gpt-5.6-terra", "low");
    f.setState({...intake, ...(kind === "approval" ? {pending_approval: {approval_id: "approval"}}
      : kind === "foreign-run" ? {run_id: "foreign-run"} : {})});
    if (kind === "native-mismatch") f.mismatch();
    f.completeTool("statewright_load_workflow", {state_snapshot: intake});
    await until(() => f.errors.length > 0);
    assert.equal(f.calls.filter(c => c.method === "turn/start").length, 1);
    assert.equal(f.injected.length, 0);
    assert.equal(f.confirmed.filter(r => r.confirmed).length, 0);
  });
}

test("late lifecycle completion cannot restart a turn already cancelled by the user", async t => {
  const f = await fixture(t);
  await f.rpc("turn/interrupt", {threadId, turnId: "turn-1"});
  const intake = stateFor("intake", 1, "openai-codex/gpt-5.6-terra", "low");
  f.setState(intake); f.completeTool("statewright_load_workflow", {state_snapshot: intake});
  await new Promise(r => setTimeout(r, 40));
  assert.equal(f.calls.filter(c => c.method === "turn/start").length, 1);
  assert.equal(f.calls.filter(c => c.method === "turn/interrupt").length, 1);
});

test("cancellation during native continuation acceptance interrupts only the returned continuation", async t => {
  const f = await fixture(t);
  let release; f.holdStart(new Promise(resolve => {release = resolve}));
  const intake = stateFor("intake", 1, "openai-codex/gpt-5.6-terra", "low");
  f.setState(intake); f.completeTool("statewright_load_workflow", {state_snapshot: intake});
  await until(() => f.calls.filter(c => c.method === "turn/start").length === 2);
  await f.rpc("turn/interrupt", {threadId, turnId: "turn-1"});
  release();
  await until(() => f.calls.some(c => c.method === "turn/interrupt" && c.params.turnId === "turn-2"));
  assert.equal(f.injected.length, 0);
});

test("cancellation during the post-start asynchronous ownership lookup cannot claim the continuation", async t => {
  const f = await fixture(t);
  let release; f.holdOwner(new Promise(resolve => {release = resolve}));
  const intake = stateFor("intake", 1, "openai-codex/gpt-5.6-terra", "low");
  f.setState(intake); f.completeTool("statewright_load_workflow", {state_snapshot: intake});
  await until(f.ownerEntered);
  await f.rpc("turn/interrupt", {threadId, turnId: "turn-1"});
  release();
  await until(() => f.calls.some(c => c.method === "turn/interrupt" && c.params.turnId === "turn-2"));
  assert.equal(f.injected.length, 0);
});
