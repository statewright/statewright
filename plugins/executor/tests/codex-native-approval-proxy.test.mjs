import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { startCodexAppServerRouteProxy } from "../lib/codex-app-server-route-proxy.mjs";

const threadId = "approval-fixture-thread";
const destination = { run_id: "fixture-run", run_session_id: "fixture-session", state: "implement",
  model: "openai-codex/fixture-destination-model", thinking_level: "high", is_final: false };
const pending = { ...destination, state: "review", model: "openai-codex/fixture-origin-model",
  pending_approval: { approval_id: "fixture-approval", from_state: "review", to_state: "implement",
    message: "Review fixture evidence" } };
const formMethod = "mcpServer/elicitation/request";

async function until(predicate, label) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { withService = true, delayedIdle = false, nativeGoal = null, startProvider = "openai" } = {}) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const calls = [], timeline = [], errors = [], statuses = [], serviceCalls = [], injected = [], readStatuses = [], idleEvents = [];
  const clients = [], upstreamSockets = [], saved = new Map(), holds = new Set();
  let socket, visible, state = null, decision = "pending", active = false, sequence = 0;
  let approvalStateRead = null, route = null, routeHold = null, rpcHold = null;
  let owned = true, goal = structuredClone(nativeGoal), settings = null;
  function makeHold() {
    const hold = { entered: deferred(), release: deferred() };
    holds.add(hold);
    return hold;
  }
  const send = value => socket.send(JSON.stringify(value));
  server.on("connection", ws => {
    socket = ws;
    const connectionId = upstreamSockets.push(ws);
    ws.on("close", () => { timeline.push({ side: "upstream-close", connectionId }); });
    ws.on("message", async raw => {
      const request = JSON.parse(String(raw));
      calls.push(request);
      timeline.push({ side: "upstream", message: request });
      if (!request.method) return;
      if (rpcHold?.method === request.method && rpcHold.predicate(request)) {
        const hold = rpcHold;
        rpcHold = null;
        hold.entered.resolve();
        await hold.release.promise;
      }
      const reply = result => {
        timeline.push({ side: "ack", connectionId, message: { id: request.id, result } });
        ws.send(JSON.stringify({ id: request.id, result }));
      };
      const notify = value => ws.send(JSON.stringify(value));
      if (["thread/start", "thread/resume"].includes(request.method)) {
        return reply({ thread: { id: threadId, status: { type: "idle" }, turns: [] },
          modelProvider: request.params.modelProvider ?? startProvider, model: request.params.model ?? "fixture-origin-model" });
      }
      if (request.method === "thread/goal/get") return reply({ goal: structuredClone(goal) });
      if (request.method === "thread/goal/set") {
        goal = { ...goal, ...request.params };
        timeline.push({ side: "effect", message: request });
        return reply({ goal: structuredClone(goal) });
      }
      if (request.method === "thread/settings/update") {
        settings = structuredClone(request.params);
        return reply({});
      }
      if (request.method === "thread/read") {
        readStatuses.push({ status: active ? "active" : "idle", decision });
        return reply({ thread: { id: threadId, status: { type: active ? "active" : "idle" } } });
      }
      if (request.method === "turn/interrupt") {
        reply({});
        if (delayedIdle) return;
        active = false;
        return notify({ method: "turn/completed", params: { threadId,
          turn: { id: request.params.turnId, status: "interrupted", items: [] } } });
      }
      if (request.method === "turn/start") {
        active = true;
        const turn = { id: `fixture-turn-${++sequence}`, status: "inProgress", items: [] };
        reply({ turn });
        return notify({ method: "turn/started", params: { threadId, turn } });
      }
      reply({ fixture: true });
    });
  });
  const receipt = ticket => ({ ...ticket, status: decision, can_decide: true,
    review_url: "https://example.invalid/fixture-evidence",
    approval_requirement: { required_approvals: 1,
      reviewers: [{ display_name: "Fixture Reviewer", user_id: "fixture-reviewer" }] } });
  const service = {
    pollMs: 60_000,
    ownsThread: async id => owned && id === threadId,
    restore: async id => structuredClone(saved.get(id) ?? null),
    park: async (id, snapshot) => {
      serviceCalls.push({ method: "park", id });
      saved.set(id, structuredClone(snapshot));
    },
    clear: async (id, approvalId) => {
      serviceCalls.push({ method: "clear", id, approvalId });
      assert.equal(saved.get(id)?.pending_approval.approval_id, approvalId);
      saved.delete(id);
    },
    getState: async id => {
      assert.equal(id, threadId);
      const snapshot = structuredClone(state);
      if (snapshot?.state === destination.state && approvalStateRead) {
        const hold = approvalStateRead;
        approvalStateRead = null;
        hold.entered.resolve();
        await hold.release.promise;
      }
      return snapshot;
    },
    read: async ticket => { serviceCalls.push({ method: "read", ticket }); return receipt(ticket); },
    resolve: async (ticket, value) => {
      serviceCalls.push({ method: "resolve", ticket, decision: value });
      decision = value;
      state = structuredClone(destination);
      return receipt(ticket);
    },
    openReview: async url => { serviceCalls.push({ method: "openReview", url }); },
  };
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${server.address().port}`,
    ...(withService ? { approvalService: service } : {}),
    takePendingRoute: async () => {
      const next = route;
      route = null;
      if (routeHold) {
        const hold = routeHold;
        routeHold = null;
        hold.entered.resolve();
        await hold.release.promise;
      }
      return next;
    },
    onProtocolError: event => { errors.push(event); },
    onHandoffStatus: event => { statuses.push(event); },
    onRouteInjected: event => { injected.push(event); },
    idleMs: 20,
    onIdle: () => { idleEvents.push("idle"); },
  });
  t.after(async () => {
    for (const hold of holds) hold.release.resolve();
    for (const client of clients) client.terminate();
    await proxy.close();
    for (const ws of server.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  async function connect() {
    visible = [];
    const messages = visible;
    const client = new WebSocket(proxy.url);
    clients.push(client);
    client.on("message", raw => {
      const message = JSON.parse(String(raw));
      messages.push(message);
      timeline.push({ side: "native", message });
    });
    await once(client, "open");
    return client;
  }
  let client = await connect();
  let requestId = 0;
  function request(method, params = {}) {
    const id = ++requestId;
    client.send(JSON.stringify({ id, method, params }));
    return id;
  }
  async function response(id, { allowError = false } = {}) {
    await until(() => visible.some(message => message.id === id), `request ${id} response`);
    const message = visible.find(message => message.id === id);
    if (!allowError) assert.equal(message.error, undefined, `request ${id}: ${JSON.stringify(message.error)}`);
    return message;
  }
  async function rpc(method, params = {}) {
    return (await response(request(method, params))).result;
  }
  async function observePending() {
    await rpc("thread/start");
    const { turn } = await rpc("turn/start", { threadId, input: [{ type: "text", text: "Fixture request" }] });
    await until(() => visible.some(message => message.method === "turn/started" && message.params.turn.id === turn.id), "origin turn");
    state = structuredClone(pending);
    const completion = { method: "item/completed", params: { threadId, turnId: turn.id,
      item: { id: "fixture-transition", type: "mcpToolCall", server: "statewright",
        tool: "statewright_transition", result: { structuredContent: structuredClone(pending) } } } };
    send(completion);
    await until(() => visible.some(message => message.method === formMethod), "native approval form");
    return completion;
  }
  function respond(form, action) {
    client.send(JSON.stringify({ id: form.id, result: { action } }));
  }
  return { calls, timeline, errors, statuses, serviceCalls, saved, injected, readStatuses, idleEvents, upstreamSockets,
    rpc, request, response, send, observePending, respond,
    get visible() { return visible; },
    get client() { return client; },
    get state() { return state; },
    get decision() { return decision; },
    get goal() { return goal; },
    get settings() { return settings; },
    armPending() { state = structuredClone(pending); },
    changeRoot() { owned = false; },
    setRoute(value) { route = value; },
    setNativeIdle() {
      active = false;
      send({ method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
    },
    holdApprovedRead() {
      const hold = makeHold();
      approvalStateRead = hold;
      return hold;
    },
    holdReservation() { routeHold = makeHold(); return routeHold; },
    holdRpc(method, predicate = () => true) {
      rpcHold = { ...makeHold(), method, predicate };
      return rpcHold;
    },
    async reconnect() { client = await connect(); },
  };
}

function form(f) { return f.visible.find(message => message.method === formMethod); }
function starts(f) { return f.calls.filter(message => message.method === "turn/start"); }
function resolved(f, request) {
  return f.visible.some(message => message.method === "serverRequest/resolved" && message.params.requestId === request.id);
}

const pausedGoal = { status: "paused", objective: "Complete the fixture milestone", createdAt: 12345 };
const parkedSteerMessage = "Approval parked the prior turn; submit a new turn to continue with the approved route";

function assertParkedSteerRefusal(response) {
  assert.deepEqual(response.error, { code: -32603, message: parkedSteerMessage });
}

test("steer cannot reach inference while an earlier gate's park RPC is pending", { timeout: 8000 }, async t => {
  const f = await fixture(t, { nativeGoal: { ...pausedGoal, status: "active" } });
  await f.rpc("thread/start");
  const { turn } = await f.rpc("turn/start", { threadId, input: [{ type: "text", text: "Origin user input" }] });
  await until(() => f.visible.some(message => message.method === "turn/started" && message.params.turn.id === turn.id), "origin turn");
  f.armPending();
  const hold = f.holdRpc("thread/goal/get");
  const oldId = f.request("turn/start", { threadId, input: [{ type: "text", text: "First gated input" }] });
  await hold.entered.promise;
  const steerId = f.request("turn/steer", { threadId, expectedTurnId: turn.id,
    input: [{ type: "text", text: "Preapproval steer must stay parked" }] });
  await f.rpc("initialize");
  assert.equal(f.calls.some(message => message.id === steerId), false, "steer is inference and must be gated before forwarding");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(form(f), undefined, "replacement permission form must wait for predecessor safety RPC completion");
  assert.equal(f.goal.status, "active", "the held safety RPC has not yet paused the native goal");
  hold.release.resolve();
  await until(() => form(f), "steer's replacement approval form");
  assert.equal(f.goal.status, "paused", "safety parking must complete before presenting permission");
  assert.equal(f.goal.objective, pausedGoal.objective);
  assert.equal(f.goal.createdAt, pausedGoal.createdAt);
  assert.equal(f.visible.filter(message => message.method === formMethod).length, 1);
  assert.ok(f.calls.some(message => message.method === "turn/interrupt" && message.params.turnId === turn.id));
  f.respond(form(f), "accept");
  assertParkedSteerRefusal(await f.response(steerId, { allowError: true }));
  assert.ok((await f.response(oldId, { allowError: true })).error);
  assert.equal(f.calls.some(message => message.id === steerId || message.id === oldId), false);
  assert.equal(starts(f).length, 1, "no native starts beyond the origin");
  assert.equal(f.goal.status, "paused");
  assert.equal(f.decision, "approved");
  assert.equal(f.saved.size, 1, "refused steer retains the checkpoint for a new-turn retry");
});

test("reconnected beforeTurn gate waits for the predecessor's delayed goal pause before presenting or releasing", { timeout: 8000 }, async t => {
  const f = await fixture(t, { nativeGoal: { ...pausedGoal, status: "active" } });
  await f.rpc("thread/start");
  const { turn } = await f.rpc("turn/start", { threadId, input: [{ type: "text", text: "Predecessor origin" }] });
  await until(() => f.visible.some(message => message.method === "turn/started" && message.params.turn.id === turn.id), "predecessor origin turn");
  f.armPending();
  const hold = f.holdRpc("thread/goal/set", request => request.params.status === "paused");
  const oldId = f.request("turn/start", { threadId, input: [{ type: "text", text: "Disconnected predecessor request" }] });
  await hold.entered.promise;
  assert.equal(f.goal.status, "active");
  assert.equal(form(f), undefined);
  const closed = once(f.client, "close");
  f.client.close();
  await closed;
  await f.reconnect();
  const successorId = f.request("thread/goal/set", { threadId, status: "active" });
  await f.rpc("initialize");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(form(f), undefined, "a new connection must share the predecessor's pending safety work");
  assert.equal(f.serviceCalls.filter(call => call.method === "park").length, 1, "successor parking waits behind predecessor parking");
  assert.equal(f.calls.some(message => message.id === successorId), false);
  assert.equal(f.serviceCalls.some(call => call.method === "resolve"), false);
  assert.equal(starts(f).length, 1);
  hold.release.resolve();
  await until(() => form(f), "successor permission form after predecessor safety completion");
  assert.equal(f.goal.status, "paused");
  assert.ok(f.calls.some(message => message.method === "turn/interrupt" && message.params.turnId === turn.id));
  const pauseIndex = f.timeline.findIndex(event => event.side === "effect" && event.message.params.status === "paused");
  const formIndex = f.timeline.findIndex(event => event.side === "native" && event.message.method === formMethod);
  assert.ok(pauseIndex >= 0 && formIndex > pauseIndex);
  assert.equal(f.visible.filter(message => message.method === formMethod).length, 1);
  f.respond(form(f), "accept");
  await f.response(successorId);
  await until(() => f.saved.size === 0, "successor native acceptance");
  await new Promise(resolve => setTimeout(resolve, 30));
  await f.rpc("initialize");
  assert.equal(f.goal.status, "active", "no delayed predecessor pause may override the released successor");
  assert.equal(f.settings.model, "fixture-destination-model");
  assert.equal(f.settings.effort, destination.thinking_level);
  assert.equal(f.calls.some(message => message.id === oldId), false);
  assert.equal(starts(f).length, 1, "only the origin started; the predecessor never released a turn");
  assert.deepEqual(f.timeline.filter(event => event.side === "effect").map(event => event.message.params.status), ["paused", "active"]);
  assert.equal(f.serviceCalls.filter(call => call.method === "resolve").length, 1);
});

test("native-idle disconnect keeps upstream alive until the safety pause acknowledgement and serializes reconnect", { timeout: 8000 }, async t => {
  const f = await fixture(t, { nativeGoal: { ...pausedGoal, status: "active" } });
  await f.rpc("thread/start");
  assert.equal(starts(f).length, 0, "there is no active origin turn to keep the predecessor connection alive");
  f.armPending();
  const hold = f.holdRpc("thread/goal/set", request => request.params.status === "paused");
  const oldId = f.request("thread/goal/set", { threadId, status: "active" });
  await hold.entered.promise;
  const predecessor = f.upstreamSockets[0];
  const pause = f.calls.find(message => message.method === "thread/goal/set" && message.params.status === "paused");
  const closed = once(f.client, "close");
  f.client.close();
  await closed;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(predecessor.readyState, WebSocket.OPEN, "unanswered safety RPC alone must preserve upstream after disconnect");
  assert.equal(f.idleEvents.length, 0, "pending safety must suppress resident idle even without active turns or clients");
  await f.reconnect();
  const successorId = f.request("thread/goal/set", { threadId, status: "active" });
  await f.rpc("initialize");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(predecessor.readyState, WebSocket.OPEN);
  assert.equal(form(f), undefined, "reconnected gate cannot overtake unacknowledged predecessor parking");
  assert.equal(f.calls.some(message => message.id === successorId), false);
  assert.equal(f.serviceCalls.filter(call => call.method === "park").length, 1);
  hold.release.resolve();
  await until(() => form(f), "native-idle successor form after safety acknowledgement");
  await until(() => predecessor.readyState === WebSocket.CLOSED, "predecessor close after safety acknowledgement");
  const ackIndex = f.timeline.findIndex(event => event.side === "ack" && event.connectionId === 1 && event.message.id === pause.id);
  const closeIndex = f.timeline.findIndex(event => event.side === "upstream-close" && event.connectionId === 1);
  assert.ok(ackIndex >= 0 && closeIndex > ackIndex, "upstream closes only after the predecessor pause was acknowledged");
  assert.equal(f.goal.status, "paused");
  assert.equal(starts(f).length, 0);
  f.respond(form(f), "accept");
  await f.response(successorId);
  await until(() => f.saved.size === 0, "native-idle successor positive acceptance");
  assert.equal(f.goal.status, "active");
  assert.equal(f.settings.model, "fixture-destination-model");
  assert.equal(f.settings.effort, destination.thinking_level);
  assert.equal(f.calls.some(message => message.id === oldId), false);
  assert.equal(starts(f).length, 0);
  assert.equal(f.calls.some(message => message.method === "turn/interrupt"), false);
  assert.deepEqual(f.timeline.filter(event => event.side === "effect").map(event => event.message.params.status), ["paused", "active"]);
  assert.equal(f.serviceCalls.filter(call => call.method === "resolve").length, 1);
});

test("beforeTurn releases native turn/start with the authoritative destination when no route is queued", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  await f.rpc("thread/start");
  f.armPending();
  const id = f.request("turn/start", { threadId, model: "fixture-origin-model", effort: "low",
    input: [{ type: "text", text: "Preserve this gated user request" }] });
  await until(() => form(f), "beforeTurn approval form");
  assert.equal(starts(f).length, 0);
  f.respond(form(f), "accept");
  await f.response(id);
  assert.equal(starts(f).length, 1, "release the original request, not an extra automatic turn");
  const released = starts(f)[0];
  assert.equal(released.id, id);
  assert.equal(released.params.model, "fixture-destination-model");
  assert.equal(released.params.effort, destination.thinking_level);
  assert.equal(released.params.input[0].text, "Preserve this gated user request");
  assert.equal(f.saved.size, 0);
});

test("beforeTurn installs destination settings before releasing a paused native goal to active", { timeout: 8000 }, async t => {
  const f = await fixture(t, { nativeGoal: pausedGoal });
  await f.rpc("thread/start");
  f.armPending();
  const id = f.request("thread/goal/set", { threadId, status: "active" });
  await until(() => form(f), "goal activation approval form");
  assert.equal(f.goal.status, "paused");
  assert.equal(f.calls.some(message => message.id === id), false);
  f.respond(form(f), "accept");
  await f.response(id);
  const settingsIndex = f.calls.findIndex(message => message.method === "thread/settings/update");
  const activeIndex = f.calls.findIndex(message => message.id === id);
  assert.ok(settingsIndex >= 0 && settingsIndex < activeIndex, "destination settings must precede inference activation");
  assert.equal(f.settings.model, "fixture-destination-model");
  assert.equal(f.settings.effort, destination.thinking_level);
  assert.equal(f.goal.status, "active");
  assert.equal(f.goal.objective, pausedGoal.objective);
  assert.equal(f.goal.createdAt, pausedGoal.createdAt);
  assert.equal(starts(f).length, 0);
});

test("approved steer is refused and its checkpoint survives until a retried new turn receives native positive acceptance", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  await f.rpc("thread/start");
  f.armPending();
  const steerId = f.request("turn/steer", { threadId, expectedTurnId: "fixture-turn-1",
    input: [{ type: "text", text: "Interrupted steer cannot continue" }] });
  await until(() => form(f), "steer approval form");
  f.respond(form(f), "accept");
  assertParkedSteerRefusal(await f.response(steerId, { allowError: true }));
  assert.equal(f.calls.some(message => message.id === steerId), false);
  assert.equal(f.saved.size, 1);
  const hold = f.holdRpc("turn/start");
  const retryId = f.request("turn/start", { threadId, input: [{ type: "text", text: "Explicit new-turn retry" }] });
  await hold.entered.promise;
  await f.rpc("initialize");
  assert.equal(f.saved.size, 1, "sending a native request is not positive native acceptance");
  assert.equal(f.serviceCalls.some(call => call.method === "clear"), false);
  hold.release.resolve();
  await f.response(retryId);
  await until(() => f.saved.size === 0, "checkpoint consumption after native acceptance");
  assert.equal(starts(f).length, 1);
  assert.equal(starts(f)[0].params.model, "fixture-destination-model");
  assert.equal(f.visible.filter(message => message.method === formMethod).length, 1, "retry must not reopen an already approved form");
  assert.equal(f.serviceCalls.filter(call => call.method === "resolve").length, 1);
});

test("observed approval pauses a real active goal and resumes it only after destination settings", { timeout: 8000 }, async t => {
  const f = await fixture(t, { nativeGoal: { ...pausedGoal, status: "active" } });
  await f.observePending();
  assert.equal(f.goal.status, "paused");
  assert.equal(f.goal.objective, pausedGoal.objective);
  assert.equal(f.goal.createdAt, pausedGoal.createdAt);
  f.respond(form(f), "accept");
  await until(() => f.saved.size === 0, "native goal release");
  const pauseIndex = f.calls.findIndex(message => message.method === "thread/goal/set" && message.params.status === "paused");
  const settingsIndex = f.calls.findIndex(message => message.method === "thread/settings/update");
  const activeIndex = f.calls.findIndex(message => message.method === "thread/goal/set" && message.params.status === "active");
  assert.ok(pauseIndex >= 0 && settingsIndex > pauseIndex && activeIndex > settingsIndex);
  assert.equal(f.settings.model, "fixture-destination-model");
  assert.equal(f.settings.effort, destination.thinking_level);
  assert.equal(f.goal.status, "active");
  assert.equal(starts(f).length, 1, "goal release must not also create a separate continuation turn");
});

for (const boundary of ["reservation", "provider"]) {
  test(`newer native input prevents forwarding the old request across an async ${boundary} boundary`, { timeout: 8000 }, async t => {
    const f = await fixture(t, { startProvider: boundary === "provider" ? "fixture-origin-provider" : "openai" });
    await f.rpc("thread/start");
    f.armPending();
    let acknowledgements = 0, releases = 0;
    f.setRoute({ route: { session_id: threadId, run_id: destination.run_id, state: destination.state,
      model: destination.model,
      effort: destination.thinking_level },
    ack: async () => { acknowledgements++; }, release: async () => { releases++; } });
    const hold = boundary === "reservation" ? f.holdReservation()
      : f.holdRpc("thread/resume", request => request.params.modelProvider === "openai");
    const oldId = f.request("turn/start", { threadId, input: [{ type: "text", text: "Old request must not execute" }] });
    await until(() => form(f), "old request's beforeTurn approval");
    f.respond(form(f), "accept");
    await hold.entered.promise;
    const newId = f.request("turn/start", { threadId, input: [{ type: "text", text: "New request owns continuation" }] });
    await f.rpc("initialize");
    hold.release.resolve();
    const oldResponse = await f.response(oldId, { allowError: true });
    assert.ok(oldResponse.error, "superseded old request needs an explicit failure, not a successful turn");
    await f.response(newId);
    assert.equal(f.calls.some(message => message.id === oldId), false);
    assert.deepEqual(starts(f).map(message => message.id), [newId]);
    assert.equal(acknowledgements, 0);
    assert.equal(releases, 1);
    assert.equal(starts(f)[0].params.model, "fixture-destination-model");
    assert.equal(f.saved.size, 0, "only the latest request consumes the approval checkpoint");
  });
}

test("root ownership changing while pending blocks the private resolver and continuation", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  await f.observePending();
  const request = form(f);
  f.changeRoot();
  f.respond(request, "accept");
  await until(() => f.errors.length > 0 || f.serviceCalls.some(call => call.method === "clear"), "root-change decision handling");
  await f.rpc("initialize");
  assert.equal(f.serviceCalls.some(call => call.method === "resolve"), false, "a former root must not resolve a ticket");
  assert.equal(f.decision, "pending");
  assert.equal(starts(f).length, 1);
  assert.equal(f.saved.size, 1);
});

test("root ownership changing during approved-state verification blocks continuation", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  await f.observePending();
  const hold = f.holdApprovedRead();
  f.respond(form(f), "accept");
  await hold.entered.promise;
  f.changeRoot();
  hold.release.resolve();
  await until(() => f.errors.length > 0 || f.serviceCalls.some(call => call.method === "clear"), "root-change release handling");
  assert.equal(starts(f).length, 1, "approved state must not release under a changed root owner");
  assert.equal(f.injected.length, 0);
  assert.equal(f.saved.size, 1);
});

test("native approval forwards completed evidence before interrupt and consumes the form reply privately", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const completion = await f.observePending();
  const request = form(f);
  const completionIndex = f.timeline.findIndex(event => event.side === "native" && event.message.method === "item/completed");
  const interruptIndex = f.timeline.findIndex(event => event.side === "upstream" && event.message.method === "turn/interrupt");
  assert.ok(completionIndex >= 0 && interruptIndex > completionIndex);
  assert.deepEqual(f.visible.find(message => message.method === "item/completed"), completion);
  assert.equal(request.params.mode, "form");
  assert.equal(request.params.threadId, threadId);
  assert.match(request.params.message, /Fixture Reviewer/);
  assert.match(request.params.message, /https:\/\/example.invalid\/fixture-evidence/);
  assert.equal(starts(f).length, 1, "no inference continuation while pending");
  f.send(completion);
  f.send(completion);
  await f.rpc("initialize");
  assert.equal(f.visible.filter(message => message.method === formMethod).length, 1, "duplicate observations must not duplicate native waiters");
  assert.equal(f.serviceCalls.filter(call => call.method === "park").length, 1);
  f.respond(request, "accept");
  await until(() => f.serviceCalls.some(call => call.method === "clear"), "approval release completion");
  await f.rpc("initialize");
  assert.equal(f.calls.some(message => message.id === request.id), false, "native reply must not reach upstream");
  const resolutions = f.serviceCalls.filter(call => call.method === "resolve");
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].decision, "approved");
  assert.equal(resolutions[0].ticket.run_session_id, pending.run_session_id);
  assert.ok(resolved(f, request));
  assert.equal(starts(f).length, 2);
  const continuation = starts(f)[1];
  assert.equal(continuation.params.model, "fixture-destination-model");
  assert.equal(continuation.params.effort, destination.thinking_level);
  assert.match(continuation.params.input[0].text, /entered 'implement'/);
  assert.equal(f.injected[0].route.state, destination.state);
  assert.equal(f.saved.size, 0);
  assert.deepEqual(f.errors, []);
});

test("cold native thread resume reopens the saved pending gate without a new tool completion", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  await f.observePending();
  const oldForm = form(f);
  const closed = once(f.client, "close");
  f.client.close();
  await closed;
  await until(() => f.errors.some(error => /connection closed/i.test(error.message)), "old approval wait cancellation");
  assert.equal(f.saved.get(threadId).pending_approval.approval_id, pending.pending_approval.approval_id);
  await f.reconnect();
  await f.rpc("thread/resume", { threadId });
  await until(() => form(f), "reopened native form");
  const reopened = form(f);
  assert.notEqual(reopened.id, oldForm.id);
  assert.equal(f.visible.some(message => message.method === "item/completed"), false);
  assert.equal(starts(f).length, 1);
  f.respond(reopened, "accept");
  await until(() => f.saved.size === 0, "cold-resume approval release");
  assert.equal(starts(f).length, 2);
  assert.equal(starts(f)[1].params.model, "fixture-destination-model");
  assert.equal(f.serviceCalls.filter(call => call.method === "resolve").length, 1);
});

test("native cancellation consumes the reply but leaves the authoritative approval and checkpoint pending", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  await f.observePending();
  const request = form(f);
  f.respond(request, "cancel");
  await until(() => resolved(f, request) && f.errors.some(error => /dismissed/.test(error.message)), "cancelled approval wait");
  await f.rpc("initialize");
  assert.equal(f.decision, "pending");
  assert.deepEqual(f.state, pending);
  assert.deepEqual(f.saved.get(threadId), pending);
  assert.equal(starts(f).length, 1);
  assert.equal(f.serviceCalls.some(call => ["resolve", "clear"].includes(call.method)), false);
  assert.equal(f.calls.some(message => message.id === request.id), false);
});

test("newer native user input prevents an approved but stale continuation", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  await f.observePending();
  const hold = f.holdApprovedRead();
  f.respond(form(f), "accept");
  await hold.entered.promise;
  const steerId = f.request("turn/steer", { threadId, expectedTurnId: "fixture-turn-1",
    input: [{ type: "text", text: "Newer user request takes ownership" }] });
  const steerResponse = await f.response(steerId, { allowError: true });
  assertParkedSteerRefusal(steerResponse);
  hold.release.resolve();
  await until(() => f.errors.some(error => /superseded by user activity/.test(error.message)), "stale continuation rejection");
  await f.rpc("initialize");
  assert.equal(f.decision, "approved", "the authoritative decision can remain valid");
  assert.deepEqual(f.state, destination);
  assert.equal(starts(f).length, 1, "old approval must not create a new turn");
  assert.equal(f.calls.some(message => message.id === steerId), false, "steer cannot restart the parked prior turn");
  assert.equal(f.injected.length, 0);
  assert.equal(f.serviceCalls.some(call => call.method === "clear"), false);
});

test("approved continuation rejects a pending route that disagrees with the authoritative destination", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  await f.observePending();
  f.setRoute({ session_id: threadId, run_id: destination.run_id, state: "stale-phase",
    model: destination.model, effort: destination.thinking_level });
  f.respond(form(f), "accept");
  await until(() => f.errors.some(error => /authoritative destination route/.test(error.message)), "stale route rejection");
  await f.rpc("initialize");
  assert.equal(starts(f).length, 1);
  assert.equal(f.injected.length, 0);
  assert.equal(f.saved.size, 1);
});

test("fast native acceptance waits for the interrupted turn to become idle before applying the destination", { timeout: 8000 }, async t => {
  const f = await fixture(t, { delayedIdle: true });
  await f.observePending();
  f.respond(form(f), "accept");
  await until(() => f.readStatuses.some(read => read.decision === "approved" && read.status === "active"), "approved continuation idle check");
  assert.equal(starts(f).length, 1, "interrupt acknowledgement alone must not release inference");
  assert.equal(f.injected.length, 0);
  assert.deepEqual(f.errors, []);
  f.setNativeIdle();
  await until(() => f.saved.size === 0, "release after native idle");
  assert.equal(starts(f).length, 2);
  assert.equal(starts(f)[1].params.model, "fixture-destination-model");
  assert.equal(starts(f)[1].params.effort, destination.thinking_level);
  assert.ok(f.readStatuses.some(read => read.decision === "approved" && read.status === "idle"));
  assert.deepEqual(f.errors, []);
});

test("newer user input invalidates the approval epoch during the native idle retry", { timeout: 8000 }, async t => {
  const f = await fixture(t, { delayedIdle: true });
  await f.observePending();
  f.respond(form(f), "accept");
  await until(() => f.readStatuses.some(read => read.decision === "approved" && read.status === "active"), "idle retry entered");
  const steerId = f.request("turn/steer", { threadId, expectedTurnId: "fixture-turn-1",
    input: [{ type: "text", text: "Newer request during idle retry" }] });
  const steerResponse = await f.response(steerId, { allowError: true });
  assertParkedSteerRefusal(steerResponse);
  f.setNativeIdle();
  await until(() => f.errors.some(error => /superseded by user activity/.test(error.message)), "idle retry epoch rejection");
  await f.rpc("initialize");
  assert.equal(f.decision, "approved");
  assert.equal(starts(f).length, 1);
  assert.equal(f.injected.length, 0);
  assert.equal(f.calls.some(message => message.id === steerId), false);
  assert.equal(f.serviceCalls.some(call => call.method === "clear"), false);
});

test("late old-turn terminal neither reaches the native transcript nor clears the new turn's activity", { timeout: 8000 }, async t => {
  const f = await fixture(t, { delayedIdle: true });
  await f.observePending();
  f.respond(form(f), "accept");
  await until(() => f.readStatuses.some(read => read.decision === "approved" && read.status === "active"), "approved idle retry");
  f.setNativeIdle();
  await until(() => f.saved.size === 0 && f.visible.some(message => message.method === "turn/started"
    && message.params.turn.id === "fixture-turn-2"), "new approved turn");
  const oldTerminal = { method: "turn/completed", params: { threadId,
    turn: { id: "fixture-turn-1", status: "interrupted", items: [] } } };
  f.send(oldTerminal);
  await until(() => f.errors.some(error => /superseded native turn/.test(error.message)), "stale terminal discarded");
  const delta = { method: "item/agentMessage/delta", params: { threadId, turnId: "fixture-turn-2",
    itemId: "fixture-new-answer", delta: "The new turn is still running" } };
  f.send(delta);
  await f.rpc("initialize");
  assert.equal(f.visible.some(message => message.method === "turn/completed" && message.params.turn.id === "fixture-turn-1"), false);
  assert.deepEqual(f.visible.find(message => message.method === delta.method), delta);
  const closed = once(f.client, "close");
  f.client.close();
  await closed;
  // A retained upstream connection proves activity was not cleared by the old terminal.
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(f.idleEvents.length, 0, "resident must stay active for the new turn after native disconnect");
  f.send({ method: "turn/completed", params: { threadId,
    turn: { id: "fixture-turn-2", status: "completed", items: [] } } });
  await until(() => f.idleEvents.length === 1, "only the current terminal releases resident activity");
});

test("without an approval service normal traffic and native server-request replies pass through", { timeout: 8000 }, async t => {
  const f = await fixture(t, { withService: false });
  await f.rpc("thread/start");
  const { turn } = await f.rpc("turn/start", { threadId, input: [{ type: "text", text: "Ordinary user input" }] });
  const completion = { method: "item/completed", params: { threadId, turnId: turn.id,
    item: { id: "ungated-fixture", type: "mcpToolCall", server: "statewright", tool: "statewright_transition",
      result: { structuredContent: pending } } } };
  f.send(completion);
  const nativeRequest = { id: "native-fixture-form", method: formMethod,
    params: { threadId, serverName: "fixture-server", mode: "form", requestedSchema: { type: "object", properties: {} } } };
  f.send(nativeRequest);
  await until(() => form(f), "ordinary native form");
  f.respond(nativeRequest, "accept");
  await f.rpc("initialize");
  assert.deepEqual(f.visible.find(message => message.method === "item/completed"), completion);
  assert.deepEqual(f.visible.find(message => message.method === formMethod), nativeRequest);
  assert.deepEqual(f.calls.find(message => message.id === nativeRequest.id), { id: nativeRequest.id, result: { action: "accept" } });
  assert.equal(starts(f).length, 1);
  assert.equal(starts(f)[0].params.input[0].text, "Ordinary user input");
  assert.equal(f.calls.some(message => ["turn/interrupt", "thread/goal/get"].includes(message.method)), false);
  assert.deepEqual(f.serviceCalls, []);
  assert.deepEqual(f.errors, []);
});
