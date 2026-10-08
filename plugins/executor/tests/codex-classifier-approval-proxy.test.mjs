import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { startCodexAppServerRouteProxy } from "../lib/codex-app-server-route-proxy.mjs";

const threadId = "classifier-fixture-thread";
const token = "classifier-fixture-token";

function approvalRequest(invocation, overrides = {}) {
  return {
    schema: "statewright/classifier-approval-request/v2",
    thread_id: threadId,
    run_id: "run-one",
    run_session_id: "session-one",
    state: "implement",
    state_epoch: 4,
    classifier_receipt: {
      intent_fingerprint: "intent_v1_family",
      invocation_fingerprint: `invocation_v1_${invocation}`,
      final_denial_basis: "semantic_authorization_disabled",
      required_authority: "complete_structural_evidence_or_separate_approval",
      reformulation_allowed: true,
      exact_invocation_retry_allowed: false,
      separate_approval_allowed: true,
    },
    ...overrides,
  };
}

async function until(predicate, label) {
  for (let index = 0; index < 200; index += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function hold() {
  let enter, release;
  return {
    entered: new Promise(resolve => { enter = resolve; }),
    release: new Promise(resolve => { release = resolve; }),
    enter: () => enter(),
    resume: () => release(),
  };
}

async function setup(t) {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  upstream.on("connection", socket => socket.on("message", raw => {
    const request = JSON.parse(String(raw));
    if (request.method === "thread/start" || request.method === "thread/resume") {
      socket.send(JSON.stringify({ id: request.id, result: {
        thread: { id: threadId, status: { type: "idle" }, turns: [] },
        modelProvider: "openai", model: "fixture-model",
      } }));
    } else if (request.method === "turn/start") {
      const turn = { id: "classifier-active-turn", status: "inProgress", items: [] };
      socket.send(JSON.stringify({ id: request.id, result: { turn } }));
      socket.send(JSON.stringify({ method: "turn/started", params: { threadId, turn } }));
    } else if (request.id !== undefined) {
      socket.send(JSON.stringify({ id: request.id, result: {} }));
    }
  }));
  let state = { run_id: "run-one", run_session_id: "session-one", state: "implement", state_epoch: 4 };
  let owned = true;
  let stateHold = null;
  let ownerHold = null;
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`,
    classifierApprovalToken: token,
    classifierApprovalService: {
      ownsThread: async id => {
        if (ownerHold) {
          const pending = ownerHold;
          ownerHold = null;
          pending.enter();
          await pending.release;
        }
        return owned && id === threadId;
      },
      getState: async id => {
        assert.equal(id, threadId);
        if (stateHold) {
          const hold = stateHold;
          stateHold = null;
          hold.enter();
          await hold.release;
        }
        return structuredClone(state);
      },
    },
  });
  const clients = [];
  async function connectAndOwn() {
    const messages = [];
    const client = new WebSocket(proxy.url);
    clients.push(client);
    client.on("message", raw => messages.push(JSON.parse(String(raw))));
    await once(client, "open");
    const initializeId = `initialize-${clients.length}`;
    client.send(JSON.stringify({ id: initializeId, method: "initialize", params: {} }));
    await until(() => messages.find(message => message.id === initializeId), "native initialization response");
    const id = `start-${clients.length}`;
    client.send(JSON.stringify({ id, method: "thread/start", params: {} }));
    await until(() => messages.find(message => message.id === id), "thread ownership response");
    return { client, messages };
  }
  const endpoint = `${proxy.url.replace(/^ws/, "http")}/classifier-approval`;
  async function post(body, headers = {}) {
    return fetch(endpoint, { method: "POST", headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers,
    }, body: JSON.stringify(body) });
  }
  t.after(async () => {
    for (const client of clients) client.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise(resolve => upstream.close(resolve));
  });
  return { connectAndOwn, endpoint, post,
    setState(value) { state = structuredClone(value); },
    setOwned(value) { owned = value; },
    holdStateRead() {
      return stateHold = hold();
    },
    holdOwnerLookup() {
      return ownerHold = hold();
    } };
}

test("classifier uncertainty reaches one exact native approval after two rewrites", async t => {
  const fixture = await setup(t);
  const { client, messages } = await fixture.connectAndOwn();
  for (const invocation of ["one", "two"]) {
    const response = await fixture.post(approvalRequest(invocation));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.action, "rework");
    assert.equal(result.attempts, invocation === "one" ? 1 : 2);
  }

  const pending = fixture.post(approvalRequest("three"));
  const modal = await until(() => messages.find(message => message.method === "mcpServer/elicitation/request"),
    "native classifier approval form");
  assert.equal(modal.params.threadId, threadId);
  assert.match(modal.params.message, /Allow this exact invocation once/);
  client.send(JSON.stringify({ id: modal.id, result: { action: "accept" } }));
  const response = await pending;
  assert.equal(response.status, 200);
  const allowed = await response.json();
  assert.equal(allowed.action, "allow_once");
  assert.equal(allowed.invocation_fingerprint, "invocation_v1_three");
  await until(() => messages.find(message => message.method === "serverRequest/resolved"
    && message.params.requestId === modal.id), "native approval resolution");

  const consumed = await (await fixture.post(approvalRequest("three"))).json();
  assert.equal(consumed.action, "rework", "one approval cannot persist beyond its held invocation");
});

test("classifier approval endpoint authenticates and fails closed without one exact owner", async t => {
  const fixture = await setup(t);
  assert.equal((await fetch(fixture.endpoint, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(fixture.endpoint, { method: "POST", headers: {
    Authorization: `Bearer ${token}`, Origin: "https://example.invalid",
  }, body: "{}" })).status, 401);

  const noOwner = await fixture.post(approvalRequest("ownerless"));
  assert.equal(noOwner.status, 400);
  assert.match((await noOwner.json()).reason, /no owning native connection/);

  await fixture.connectAndOwn();
  fixture.setOwned(false);
  const transferred = await fixture.post(approvalRequest("transferred"));
  assert.equal(transferred.status, 400);
  assert.match((await transferred.json()).reason, /no owning native connection/);

  fixture.setOwned(true);
  await fixture.connectAndOwn();
  const duplicate = await fixture.post(approvalRequest("duplicate"));
  assert.equal(duplicate.status, 400);
  assert.match((await duplicate.json()).reason, /multiple owning native connections/);
});

test("workflow transition approval blocks classifier fallthrough", async t => {
  const fixture = await setup(t);
  await fixture.connectAndOwn();
  fixture.setState({ run_id: "run-one", run_session_id: "session-one", state: "implement", state_epoch: 4,
    pending_approval: { approval_id: "approval-one" } });
  const response = await fixture.post(approvalRequest("workflow-pending"));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.action, "deny");
  assert.equal(result.reason, "workflow_approval_pending");
});

test("ownership loss during accepted-state reread denies the held invocation", async t => {
  const fixture = await setup(t);
  const { client, messages } = await fixture.connectAndOwn();
  await fixture.post(approvalRequest("one"));
  await fixture.post(approvalRequest("two"));
  const pending = fixture.post(approvalRequest("three"));
  const modal = await until(() => messages.find(message => message.method === "mcpServer/elicitation/request"),
    "native classifier approval form");
  const hold = fixture.holdStateRead();
  client.send(JSON.stringify({ id: modal.id, result: { action: "accept" } }));
  await hold.entered;
  fixture.setOwned(false);
  hold.resume();
  const result = await (await pending).json();
  assert.equal(result.action, "deny");
  assert.equal(result.reason, "approval_state_changed");
});

test("a duplicate live native owner appearing during state reread denies release", async t => {
  const fixture = await setup(t);
  const { client, messages } = await fixture.connectAndOwn();
  await fixture.post(approvalRequest("one"));
  await fixture.post(approvalRequest("two"));
  const pending = fixture.post(approvalRequest("three"));
  const modal = await until(() => messages.find(message => message.method === "mcpServer/elicitation/request"),
    "native classifier approval form");
  const stateRead = fixture.holdStateRead();
  client.send(JSON.stringify({ id: modal.id, result: { action: "accept" } }));
  await stateRead.entered;
  await fixture.connectAndOwn();
  stateRead.resume();
  const result = await (await pending).json();
  assert.equal(result.action, "deny");
  assert.equal(result.reason, "approval_state_changed");
});

test("HTTP abort during asynchronous owner lookup cannot orphan a native prompt", async t => {
  const fixture = await setup(t);
  const { messages } = await fixture.connectAndOwn();
  await fixture.post(approvalRequest("one"));
  await fixture.post(approvalRequest("two"));
  const ownerLookup = fixture.holdOwnerLookup();
  const abort = new AbortController();
  const request = fetch(fixture.endpoint, {
    method: "POST",
    headers: {"Content-Type": "application/json", Authorization: `Bearer ${token}`},
    body: JSON.stringify(approvalRequest("three")),
    signal: abort.signal,
  });
  const rejected = assert.rejects(request, /abort/i);
  await ownerLookup.entered;
  abort.abort();
  // Let the server observe the closed response while ownership is still
  // blocked; the regression is losing that already-delivered close event.
  await new Promise(resolve => setTimeout(resolve, 20));
  ownerLookup.resume();
  await rejected;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(messages.some(message => message.method === "mcpServer/elicitation/request"), false);
});

test("native disconnect denies classifier approval even while its turn remains active", async t => {
  const fixture = await setup(t);
  const { client, messages } = await fixture.connectAndOwn();
  client.send(JSON.stringify({ id: "active-turn", method: "turn/start", params: { threadId, input: [] } }));
  await until(() => messages.find(message => message.method === "turn/started"), "active turn notification");
  await fixture.post(approvalRequest("one"));
  await fixture.post(approvalRequest("two"));
  const pending = fixture.post(approvalRequest("three"));
  await until(() => messages.find(message => message.method === "mcpServer/elicitation/request"),
    "native classifier approval form");
  client.close();
  await once(client, "close");
  const result = await (await pending).json();
  assert.equal(result.action, "deny");
  assert.equal(result.reason, "native_connection_closed");
});
