import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
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
async function fixture(t, {nativeSettings = false} = {}) {
  const server = new WebSocketServer({port: 0, host: "127.0.0.1"});
  let proxy, client;
  t.after(async () => {
    client?.terminate(); await proxy?.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  await once(server, "listening");
  let socket, state = null, active = false, turnId, sequence = 0, heldRead, heldStart, heldOwner, ownerEntered = false, wrongModel = false;
  let heldSettings, rejectSettings = false, readbackMismatch = false, rejectedModel;
  let settings = {model: "gpt-6-sol", modelProvider: "openai", effort: "high", serviceTier: "priority"};
  const native = nativeSettings ? await (await import("./native-settings-fixture.mjs"))
    .nativeSettingsFixture(t, threadId, message => socket?.send(JSON.stringify(message))) : null;
  if (native) settings = native.settings;
  const calls = [], confirmed = [], injected = [], frames = [], errors = [], usage = [];
  server.on("connection", ws => {
    socket = ws;
    ws.on("message", async raw => {
      const r = JSON.parse(String(raw)); calls.push(r);
      if (!r.method || r.id === undefined) return;
      const reply = result => ws.send(JSON.stringify({id: r.id, result}));
      const notify = (method, params) => ws.send(JSON.stringify({method, params}));
      if (native && r.method === "thread/settings/update") {
        try { reply(await native.update(r.params)); }
        catch (error) { ws.send(JSON.stringify({id: r.id, error: {code: -32603, message: error.message}})); }
        return;
      }
      if (native && r.method === "thread/read") return reply(await native.read());
      if (["thread/start", "thread/resume"].includes(r.method)) return reply({...settings, thread: {id: threadId}});
      if (r.method === "thread/read") return reply({thread: {id: threadId,
        model: readbackMismatch ? "wrong-model" : settings.model, modelProvider: settings.modelProvider,
        reasoningEffort: settings.effort, status: {type: active ? "active" : "idle"}}});
      if (r.method === "turn/interrupt") {
        active = false; reply({});
        return notify("turn/completed", {threadId, turn: {id: turnId, status: "interrupted"}});
      }
      if (r.method === "thread/settings/update") {
        if (heldSettings) await heldSettings;
        if (rejectSettings) return ws.send(JSON.stringify({id: r.id, error: {code: -32603, message: "fixture settings rejected"}}));
        const {threadId: _, ...updates} = r.params;
        const next = {...settings, ...updates, ...(wrongModel ? {model: "wrong-model"} : {})};
        const changed = !isDeepStrictEqual(settings, next);
        settings = next; reply({});
        // Native Codex acknowledges identical settings without a notification.
        if (changed) notify("thread/settings/updated", {threadId, threadSettings: settings});
        return;
      }
      if (r.method === "turn/start") {
        if (sequence > 0 && heldStart) await heldStart;
        if (r.params.model === rejectedModel && rejectedModel) {
          return ws.send(JSON.stringify({id: r.id, error: {code: -32603, message: "fixture model rejected"}}));
        }
        if (!native) {
          const updates = Object.fromEntries(["model", "effort", "serviceTier", "collaborationMode"]
            .filter(key => Object.hasOwn(r.params, key)).map(key => [key, r.params[key]]));
          const next = {...settings, ...updates};
          if (!isDeepStrictEqual(settings, next)) {
            settings = next; notify("thread/settings/updated", {threadId, threadSettings: settings});
          }
        }
        active = true; turnId = `turn-${++sequence}`;
        reply({turn: {id: turnId}});
        return notify("turn/started", {threadId, turn: {id: turnId}});
      }
      reply({});
    });
  });
  proxy = await startCodexAppServerRouteProxy({upstreamUrl: `ws://127.0.0.1:${server.address().port}`,
    workflowService: {ownsThread: async id => {
      if (heldOwner && sequence > 1) {ownerEntered = true; await heldOwner;}
      return id === threadId;
    }, getState: async () => {
      if (heldRead) await heldRead; return state;
    }},
    routeOwner: async () => ({client_id: "handoff-client", root_session_id: threadId}),
    onRouteInjected: async r => injected.push(r), onRouteConfirmed: async r => confirmed.push(r),
    onNativeUsage: async event => usage.push(event),
    onProtocolError: async error => errors.push(error)});
  client = new WebSocket(proxy.url);
  client.on("message", raw => frames.push(JSON.parse(String(raw))));
  await once(client, "open");
  let id = 0;
  const rpc = async (method, params = {}, {allowError = false} = {}) => {
    const key = ++id; client.send(JSON.stringify({id: key, method, params}));
    await until(() => frames.some(f => f.id === key));
    const response = frames.find(f => f.id === key);
    if (allowError) return response;
    assert.equal(response.error, undefined); return response.result;
  };
  await rpc("initialize"); client.send(JSON.stringify({method: "initialized"}));
  await rpc("thread/resume", {threadId});
  await rpc("turn/start", {threadId, model: "gpt-6-sol", effort: "high"});
  const completeTool = (tool, result, overrides = {}) => socket.send(JSON.stringify({method: "item/completed", params: {
    threadId, turnId, item: {type: "mcpToolCall", id: `item-${sequence}-${tool}`, server: "statewright", tool,
      status: "completed", result: {structuredContent: result}, ...overrides}}}));
  return {calls, frames, confirmed, injected, errors, usage, rpc, completeTool, setState: v => {state = v;},
    rejectModel: model => {rejectedModel = model;},
    tokens: (id = turnId) => socket.send(JSON.stringify({method: "thread/tokenUsage/updated", params: {
      threadId, turnId: id, tokenUsage: {
        total: {inputTokens: 1000, cachedInputTokens: 50, outputTokens: 100, reasoningOutputTokens: 10, totalTokens: 1100},
        last: {inputTokens: 100, cachedInputTokens: 50, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 110},
      }}})),
    hold: p => {heldRead = p;}, holdStart: p => {heldStart = p;}, mismatch: () => {wrongModel = true;},
    holdOwner: p => {heldOwner = p;}, ownerEntered: () => ownerEntered,
    holdSettings: p => {heldSettings = p;}, rejectSettings: () => {rejectSettings = true;},
    mismatchReadback: () => {readbackMismatch = true;},
    finish: () => {active = false; socket.send(JSON.stringify({method: "turn/completed", params: {threadId, turn: {id: turnId, status: "completed"}}}));}};
}

test("Desktop native usage stays bound to the actual turn across phase handoff", async t => {
  const f = await fixture(t);
  const intake = stateFor("intake", 1, "openai-codex/gpt-5.6-terra", "low");
  f.setState(intake); f.completeTool("statewright_load_workflow", {loaded: true, state_snapshot: intake});
  await until(() => f.injected.some(r => r.turnId === "turn-2"));
  f.tokens();
  await until(() => f.usage.length === 1);
  assert.equal(f.usage[0].binding.state, "intake");
  assert.equal(f.usage[0].model, "gpt-5.6-terra");
  assert.equal(f.usage[0].effort, "low");
  assert.equal(f.usage[0].token_usage_delta.total_tokens, 110);
  const review = stateFor("frontier_review", 2, "openai-codex/gpt-6-astra", "high");
  f.setState(review); f.completeTool("statewright_transition", {transitioned: true, from: "intake", to: "frontier_review"});
  await until(() => f.injected.some(r => r.turnId === "turn-3"));
  f.tokens("turn-2"); f.tokens("foreign"); f.tokens();
  await until(() => f.usage.length === 2);
  assert.equal(f.usage[1].binding.state_epoch, 2);
  assert.equal(f.usage[1].model, "gpt-6-astra");
  assert.equal(f.usage[1].effort, "high");
  // No queued route remains: an ordinary user turn must use the current
  // authoritative phase binding without losing its epoch.
  f.finish();
  await f.rpc("turn/start", {threadId, model: "gpt-6-astra", effort: "high"});
  f.tokens();
  await until(() => f.usage.length === 3);
  assert.equal(f.usage[2].turn_id, "turn-4");
  assert.equal(f.usage[2].binding.state_epoch, 2);
  assert.equal(f.usage[2].binding.state, "frontier_review");
  assert.equal(f.usage[2].token_usage_delta.total_tokens, 110);
});

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

test("model-neutral workflow inherits the native model through handoffs and restores effort", async t => {
  const f = await fixture(t);
  const diagnose = stateFor("diagnose", 1, null, "medium");
  f.setState(diagnose);
  f.completeTool("statewright_load_workflow", {loaded: true, state_snapshot: diagnose});
  await until(() => f.injected.some(r => r.turnId === "turn-2") || f.errors.length);
  assert.deepEqual(f.errors, []);
  assert.equal(f.injected.at(-1).effectiveModel, "gpt-6-sol");
  assert.equal(f.injected.at(-1).effectiveEffort, "medium");
  const review = stateFor("review", 2, null, "high");
  f.setState(review);
  f.completeTool("statewright_transition", {transitioned: true, from: "diagnose", to: "review"});
  await until(() => f.injected.some(r => r.turnId === "turn-3") || f.errors.length);
  assert.deepEqual(f.errors, []);
  assert.equal(f.injected.at(-1).effectiveModel, "gpt-6-sol");
  assert.equal(f.injected.at(-1).effectiveEffort, "high");
  f.setState({...review, state: "complete", state_epoch: 3, is_final: true});
  f.completeTool("statewright_transition", {transitioned: true, from: "review", to: "complete"});
  f.finish();
  await until(() => f.confirmed.some(r => r.confirmed && r.route.restored_original));
  const restored = f.confirmed.find(r => r.confirmed && r.route.restored_original);
  assert.equal(restored.actualModel, "gpt-6-sol");
  assert.equal(restored.actualEffort, "high");
});

test("ordinary turn in a model-neutral workflow preserves native selection and its connection", async t => {
  const f = await fixture(t);
  f.setState(stateFor("diagnose", 1, null, "medium"));
  f.finish();
  await f.rpc("turn/start", {threadId, model: "gpt-6-astra", effort: "high",
    collaborationMode: {mode: "default", settings: {model: "gpt-6-astra", reasoning_effort: "high", developer_instructions: "keep"}}});
  assert.deepEqual(f.errors, []);
  const turn = f.calls.filter(c => c.method === "turn/start").at(-1);
  assert.equal(turn.params.model, "gpt-6-astra");
  assert.equal(turn.params.effort, "medium");
  assert.equal(turn.params.collaborationMode.settings.model, "gpt-6-astra");
  assert.equal(turn.params.collaborationMode.settings.developer_instructions, "keep");
  await f.rpc("thread/read", {threadId, includeTurns: false});
});

for (const rejected of [false, true]) test(`model-neutral completion preserves only accepted explicit native choices (rejected=${rejected})`, async t => {
  const f = await fixture(t);
  const state = stateFor("diagnose", 1, null, "medium");
  f.setState(state);
  f.completeTool("statewright_load_workflow", {loaded: true, state_snapshot: state});
  await until(() => f.injected.some(r => r.turnId === "turn-2"));
  f.finish();
  if (rejected) f.rejectModel("user-selected");
  const response = await f.rpc("turn/start", {threadId, model: "user-selected", effort: "high"}, {allowError: true});
  if (rejected) {
    assert.match(response.error.message, /model rejected/);
    await f.rpc("turn/start", {threadId});
  } else assert.equal(response.error, undefined);
  f.setState({...state, state: "complete", state_epoch: 2, is_final: true});
  f.completeTool("statewright_transition", {transitioned: true, from: "diagnose", to: "complete"});
  f.finish();
  await until(() => f.confirmed.some(r => r.confirmed && r.route.restored_original));
  const restored = f.confirmed.find(r => r.confirmed && r.route.restored_original);
  assert.equal(restored.actualModel, rejected ? "gpt-6-sol" : "user-selected");
  assert.equal(restored.actualEffort, "high");
});

test("consecutive phases with unchanged native settings still start distinct turns", async t => {
  const f = await fixture(t);
  const localize = stateFor("localize", 1, "openai-codex/gpt-5.6-terra", "medium");
  f.setState(localize); f.completeTool("statewright_load_workflow", {state_snapshot: localize});
  await until(() => f.injected.length === 1);
  f.setState({...localize, state: "baseline", state_epoch: 2});
  f.completeTool("statewright_transition", {transitioned: true, from: "localize", to: "baseline"});
  await until(() => f.injected.length === 2);
  assert.deepEqual(f.errors, []);
  assert.equal(f.calls.filter(c => c.method === "turn/start").length, 3);
  assert.equal(f.confirmed.at(-1).route.state, "baseline");
  assert.equal(f.confirmed.at(-1).confirmed, true);
  assert.equal(f.confirmed.at(-1).confirmation_source, "native_settings_snapshot_and_update_ack");
  assert.equal(f.frames.filter(c => c.method === "thread/settings/updated").length, 1);
});

test("real native settings canary: phase handoffs and restoration with a duplicate route", {
  skip: process.env.STATEWRIGHT_NATIVE_SETTINGS_CANARY !== "1",
}, async t => {
  // Only turn lifecycle events are simulated. All settings acknowledgements,
  // notifications and readbacks come from the actual bundled native binary.
  const f = await fixture(t, {nativeSettings: true});
  const states = [stateFor("intake", 1, "openai-codex/gpt-5.6-terra", "low"),
    stateFor("localize", 2, "openai-codex/gpt-5.6-terra", "medium"),
    stateFor("baseline", 3, "openai-codex/gpt-5.6-terra", "medium"),
    {...stateFor("frontier_review", 4, "openai-codex/gpt-6-astra", "high"), service_tier: "default"},
    stateFor("record", 5, "openai-codex/gpt-5.6-terra", "low")];
  for (const [index, state] of states.entries()) {
    f.setState(state);
    f.completeTool(index === 0 ? "statewright_load_workflow" : "statewright_transition",
      index === 0 ? {state_snapshot: state} : {transitioned: true, from: states[index - 1].state, to: state.state});
    await until(() => f.injected.length === index + 1 || f.errors.length);
    assert.deepEqual(f.errors, []);
    assert.equal(f.confirmed.at(-1).confirmed, true);
  }
  assert.equal(f.confirmed[2].confirmation_source, "native_settings_snapshot_and_update_ack");
  f.setState({...states.at(-1), state: "complete", state_epoch: 6, is_final: true});
  f.completeTool("statewright_transition", {transitioned: true, to: "complete"});
  f.finish();
  await until(() => f.confirmed.some(r => r.confirmed && r.route.restored_original));
  assert.equal(f.confirmed.at(-1).actualModel, "gpt-6-sol");
  assert.equal(f.confirmed.at(-1).actualEffort, "high");
});

test("unchanged native settings can confirm original-route restoration", async t => {
  const f = await fixture(t);
  const state = stateFor("intake", 1, "openai-codex/gpt-6-sol", "high");
  f.setState(state); f.completeTool("statewright_load_workflow", {state_snapshot: state});
  await until(() => f.injected.length === 1);
  f.setState({...state, state: "complete", is_final: true, state_epoch: 2});
  f.completeTool("statewright_transition", {transitioned: true, from: "intake", to: "complete"});
  f.finish();
  await until(() => f.confirmed.some(r => r.confirmed && r.route.restored_original));
  assert.equal(f.confirmed.at(-1).confirmation_source, "native_settings_snapshot_and_update_ack");
  assert.equal(f.calls.filter(c => c.method === "turn/start").length, 2);
});

for (const failure of ["rejected-ack", "cancelled-ack", "readback-mismatch", "state-changed"]) {
  test(`unchanged-settings handoff fails closed for ${failure}`, async t => {
    const f = await fixture(t);
    const state = stateFor("localize", 1, "openai-codex/gpt-5.6-terra", "medium");
    f.setState(state); f.completeTool("statewright_load_workflow", {state_snapshot: state});
    await until(() => f.injected.length === 1);
    const next = {...state, state: "baseline", state_epoch: 2};
    f.setState(next);
    let release;
    if (["cancelled-ack", "state-changed"].includes(failure)) f.holdSettings(new Promise(r => {release = r;}));
    if (failure === "rejected-ack") f.rejectSettings();
    if (failure === "readback-mismatch") f.mismatchReadback();
    f.completeTool("statewright_transition", {transitioned: true, from: "localize", to: "baseline"});
    if (release) {
      await until(() => f.calls.filter(c => c.method === "thread/settings/update").length === 2);
      if (failure === "cancelled-ack") await f.rpc("turn/interrupt", {threadId, turnId: "turn-2"});
      else f.setState({...next, state_epoch: 3});
      release();
    }
    await until(() => f.errors.some(e => e.side === "workflow_handoff"));
    assert.equal(f.calls.filter(c => c.method === "turn/start").length, 2);
    assert.equal(f.injected.length, 1);
    assert.equal(f.confirmed.filter(r => r.confirmed).length, 1);
  });
}

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
