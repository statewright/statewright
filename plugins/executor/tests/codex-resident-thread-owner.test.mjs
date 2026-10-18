import assert from "node:assert/strict";
import {once} from "node:events";
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {WebSocket, WebSocketServer} from "ws";
import {residentThreadAuthorizer} from "../lib/codex-resident-thread-owner.mjs";
import {codexWorkflowServices} from "../lib/desktop-workflow-services.mjs";
import {startCodexAppServerRouteProxy} from "../lib/codex-app-server-route-proxy.mjs";
import {bindManagedClientIdentity, claimCodexRootSession, commitCodexRootAttachment,
  readCodexRootSession, resolveManagedClientIdentity} from "../lib/managed-client-identity.mjs";

const clientId = `swc_${"a".repeat(32)}`, otherClient = `swc_${"b".repeat(32)}`;
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail("timed out waiting for native protocol evidence");
}
async function fixture(t, {classifier = false, workflow = null, noAuthorizer = false, manualTurns = false} = {}) {
  const home = await mkdtemp(join(tmpdir(), "statewright-thread-attachment-")), controlDir = join(home, "routes");
  await mkdir(controlDir);
  const options = {home, controlDir, clientId, cwd: home};
  const authorizer = residentThreadAuthorizer(options);
  let rejectCommit = false;
  const stateLookups = [];
  const services = codexWorkflowServices({...options,
    ownsThread: async id => (await readCodexRootSession(controlDir, clientId))?.sessionId === id,
    getState: async id => {stateLookups.push(id); return workflow;}});
  const server = new WebSocketServer({host: "127.0.0.1", port: 0});
  await once(server, "listening");
  let socket, serial = 0;
  const calls = [], replies = [], errors = [];
  server.on("connection", ws => { socket = ws; ws.on("message", raw => {
    const request = JSON.parse(String(raw)); calls.push(request);
    if (request.method === "initialize") ws.send(JSON.stringify({id: request.id, result: {}}));
    if (request.method === "turn/start" && !manualTurns) ws.send(JSON.stringify({id: request.id, result: {turn: {id: "test-turn", status: "inProgress"}}}));
  }); });
  const bindings = [], routes = [], usage = [];
  let idleCount = 0;
  const proxy = await startCodexAppServerRouteProxy({upstreamUrl: `ws://127.0.0.1:${server.address().port}`,
    ...services, onThreadStarted: async value => bindings.push(value),
    idleMs: 5, onIdle: async () => {idleCount++;},
    onRouteInjected: async value => routes.push(value), onNativeUsage: async value => usage.push(value),
    authorizeThread: async request => {
      if (noAuthorizer) return;
      const lifecycle = await authorizer(request);
      if (rejectCommit && lifecycle) lifecycle.commit = async () => {throw Error("fixture persistence failed");};
      return lifecycle;
    },
    ...(classifier ? {classifierApprovalToken: "fixture-token", classifierApprovalService: {
      ownsThread: services.workflowService.ownsThread,
      getState: async () => ({run_id: "fixture-run", run_session_id: "fixture-session", state: "implement", state_epoch: 1}),
    }} : {}),
    onProtocolError: async error => errors.push(error)});
  const client = new WebSocket(proxy.url);
  client.on("message", raw => replies.push(JSON.parse(String(raw))));
  await once(client, "open"); await until(() => socket);
  t.after(async () => {client.terminate(); await proxy.close(); for (const peer of server.clients) peer.terminate();
    await new Promise(r => server.close(r)); services.closeNativeUsage(); await rm(home, {recursive: true, force: true});});
  const send = (method, params = {}) => {const id = ++serial; client.send(JSON.stringify({id, method, params})); return id;};
  const reply = async id => {await until(() => replies.some(r => r.id === id)); return replies.find(r => r.id === id);};
  const attach = async (method, requested, returned, error = null) => {
    const id = send(method, requested ? {threadId: requested} : {});
    await until(() => calls.some(r => r.id === id));
    socket.send(JSON.stringify({id, ...(error ? {error} : {}), ...(returned !== undefined ? {result: {thread: {id: returned}, model: "gpt-6-sol", modelProvider: "openai"}} : {})}));
    return reply(id);
  };
  const turn = id => reply(send("turn/start", {threadId: id, input: [{type: "text", text: "fixture only"}]}));
  return {...options, authorizer, client, calls, replies, errors, send, reply, attach, turn, stateLookups, bindings, routes, usage,
    idleCount: () => idleCount,
    rejectCommit: () => {rejectCommit = true;},
    approval: body => fetch(`${proxy.url.replace(/^ws/, "http")}/classifier-approval`, {method: "POST",
      headers: {Authorization: "Bearer fixture-token", "Content-Type": "application/json"}, body: JSON.stringify(body)}),
    respond: data => socket.send(JSON.stringify(data)), root: () => readCodexRootSession(controlDir)};
}

test("native ephemeral catch-up finishes without stealing the foreground or its next turn", async t => {
  const f = await fixture(t);
  await f.attach("thread/start", null, "foreground");
  assert((await f.turn("foreground")).result);
  const id = f.send("thread/start", {ephemeral: true});
  await until(() => f.calls.some(r => r.id === id));
  f.respond({id, result: {thread: {id: "catch-up", ephemeral: true}}});
  assert((await f.reply(id)).result);
  assert.equal((await f.root()).sessionId, "foreground");
  assert((await f.turn("catch-up")).result);
  f.respond({method: "turn/completed", params: {threadId: "catch-up", turn: {id: "test-turn", status: "completed"}}});
  const unsubscribe = f.send("thread/unsubscribe", {threadId: "catch-up"});
  await until(() => f.calls.some(r => r.id === unsubscribe));
  f.respond({id: unsubscribe, result: {status: "unsubscribed"}});
  await f.reply(unsubscribe);
  assert((await f.turn("foreground")).result);
  assert.deepEqual(f.stateLookups, ["foreground", "foreground"]);
  const identities = await readFile(join(f.home, ".statewright", "managed-client-session-ids.json"), "utf8");
  assert(!identities.includes("catch-up"));
});

test("an ephemeral attachment requires native confirmation and never claims an unbound resident", async t => {
  const f = await fixture(t);
  for (const ephemeral of [false, undefined, true]) {
    const id = f.send("thread/start", {ephemeral: true});
    await until(() => f.calls.some(r => r.id === id));
    f.respond({id, result: {thread: {id: `helper-${ephemeral}`, ephemeral}}});
    const result = await f.reply(id);
    assert.equal(Boolean(result.result), ephemeral === true);
    assert.equal(await f.root(), null);
  }
  assert((await f.turn("helper-true")).result);
  assert((await f.turn("unbound")).error);
});

test("background start cannot block foreground turns while awaiting its native reply", async t => {
  const f = await fixture(t);
  await f.attach("thread/start", null, "foreground");
  const id = f.send("thread/start", {ephemeral: true});
  await until(() => f.calls.some(r => r.id === id));
  assert((await f.turn("foreground")).result);
  f.respond({id, error: {code: -32600, message: "helper failed"}});
  assert((await f.reply(id)).error);
  assert.equal((await f.root()).sessionId, "foreground");
});

test("helpers leave active workflow routing and telemetry on the foreground", async t => {
  const workflow = {run_id: "run", run_session_id: "run-session", state: "baseline", state_epoch: 1,
    model: "openai-codex/gpt-6-sol", thinking_level: "low", service_tier: "priority", is_final: false};
  const f = await fixture(t, {workflow});
  await f.attach("thread/start", null, "foreground");
  assert((await f.turn("foreground")).result);
  const id = f.send("thread/fork", {threadId: "foreground", ephemeral: true});
  await until(() => f.calls.some(r => r.id === id));
  f.respond({id, result: {thread: {id: "helper", forkedFromId: "foreground", ephemeral: true}}});
  assert((await f.reply(id)).result);
  const helperTurn = f.send("turn/start", {threadId: "helper", model: "helper-model", effort: "minimal", input: []});
  assert((await f.reply(helperTurn)).result);
  assert.equal(f.calls.find(r => r.id === helperTurn).params.model, "helper-model");
  assert.equal(f.calls.find(r => r.id === helperTurn).params.effort, "minimal");
  f.respond({method: "thread/tokenUsage/updated", params: {threadId: "helper", turnId: "test-turn", tokenUsage: {}}});
  f.respond({method: "turn/completed", params: {threadId: "helper", turn: {id: "test-turn", status: "completed"}}});
  assert((await f.turn("foreground")).result);
  assert.equal(f.routes.length, 2);
  assert(f.routes.every(r => r.threadId === "foreground"));
  assert(f.stateLookups.every(id => id === "foreground"));
  assert.equal(f.usage.length, 0);
});

test("native-confirmed background start never calls legacy adoption callbacks", async t => {
  const f = await fixture(t, {noAuthorizer: true});
  const id = f.send("thread/start", {ephemeral: true});
  await until(() => f.calls.some(r => r.id === id));
  f.respond({id, result: {thread: {id: "helper", ephemeral: true}}});
  assert((await f.reply(id)).result);
  assert((await f.turn("helper")).result);
  assert.deepEqual(f.bindings, []);
});

test("a client turn flag and unsolicited native ephemeral reply grant no helper membership", async t => {
  const f = await fixture(t);
  await f.attach("thread/start", null, "foreground");
  f.respond({id: "unsolicited", result: {thread: {id: "forged", ephemeral: true}}});
  const result = await f.reply(f.send("turn/start", {threadId: "forged", ephemeral: true, input: []}));
  assert(result.error);
  assert.equal((await f.root()).sessionId, "foreground");
  const id = f.send("thread/start");
  await until(() => f.calls.some(r => r.id === id));
  f.respond({id, result: {thread: {id: "unexpected-helper", ephemeral: true}}});
  assert((await f.reply(id)).error);
  assert((await f.turn("foreground")).result);
});

test("late helper start reply cannot resurrect a completed turn or retain the resident", async t => {
  const f = await fixture(t, {manualTurns: true});
  const attached = f.send("thread/start", {ephemeral: true});
  await until(() => f.calls.some(r => r.id === attached));
  f.respond({id: attached, result: {thread: {id: "helper", ephemeral: true}}});
  await f.reply(attached);
  const turn = f.send("turn/start", {threadId: "helper", input: []});
  await until(() => f.calls.some(r => r.id === turn));
  f.respond({method: "turn/completed", params: {threadId: "helper", turn: {id: "done", status: "completed"}}});
  f.respond({id: turn, result: {turn: {id: "done", status: "inProgress"}}});
  await f.reply(turn);
  f.client.close(); await once(f.client, "close");
  await until(() => f.idleCount() === 1);
});

test("unsubscribe waits for active helper termination and preserves another pending start", async t => {
  const f = await fixture(t, {manualTurns: true});
  const attached = f.send("thread/start", {ephemeral: true});
  await until(() => f.calls.some(r => r.id === attached));
  f.respond({id: attached, result: {thread: {id: "helper", ephemeral: true}}});
  await f.reply(attached);
  const first = f.send("turn/start", {threadId: "helper", input: []});
  await until(() => f.calls.some(r => r.id === first));
  f.respond({id: first, result: {turn: {id: "first", status: "inProgress"}}});
  await f.reply(first);
  const second = f.send("turn/start", {threadId: "helper", input: []});
  await until(() => f.calls.some(r => r.id === second));
  const unsubscribe = f.send("thread/unsubscribe", {threadId: "helper"});
  f.respond({method: "turn/completed", params: {threadId: "helper", turn: {id: "first", status: "completed"}}});
  // A later foreground-safe read acts as a processing barrier.
  const barrier = f.send("thread/read", {threadId: "helper"});
  await until(() => f.calls.some(r => r.id === barrier));
  assert(!f.calls.some(r => r.id === unsubscribe));
  f.respond({id: second, error: {code: -32600, message: "busy"}});
  await f.reply(second);
  await until(() => f.calls.some(r => r.id === unsubscribe));
  f.respond({id: unsubscribe, result: {status: "unsubscribed"}});
  await f.reply(unsubscribe);
  f.client.close(); await once(f.client, "close");
  await until(() => f.idleCount() === 1);
});

test("pipelined foreground and helper attachment cannot reuse an in-flight request ID", async t => {
  const f = await fixture(t);
  const closed = once(f.client, "close");
  f.client.send(JSON.stringify({id: 42, method: "thread/start", params: {}}));
  f.client.send(JSON.stringify({id: 42, method: "thread/start", params: {ephemeral: true}}));
  await closed;
  assert(f.calls.filter(r => r.id === 42).length <= 1);
  assert.equal(await f.root(), null);
});

test("an old helper completion cannot retire a newer acknowledged turn", async t => {
  const f = await fixture(t, {manualTurns: true});
  const attached = f.send("thread/start", {ephemeral: true});
  await until(() => f.calls.some(r => r.id === attached));
  f.respond({id: attached, result: {thread: {id: "helper", ephemeral: true}}});
  await f.reply(attached);
  for (const turnId of ["old", "new"]) {
    const id = f.send("turn/start", {threadId: "helper", input: []});
    await until(() => f.calls.some(r => r.id === id));
    f.respond({id, result: {turn: {id: turnId, status: "inProgress"}}});
    await f.reply(id);
  }
  f.respond({method: "turn/completed", params: {threadId: "helper", turn: {id: "old", status: "completed"}}});
  f.client.close(); await once(f.client, "close");
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.idleCount(), 0);
  f.respond({method: "turn/completed", params: {threadId: "helper", turn: {id: "new", status: "completed"}}});
  await until(() => f.idleCount() === 1);
});

for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
  test(`${method} binds its confirmed thread before the first send`, async t => {
    const f = await fixture(t), target = "confirmed-thread";
    const response = await f.attach(method, method === "thread/fork" ? "source-thread" : method === "thread/resume" ? target : null, target);
    assert.equal(response.result.thread.id, target);
    assert.deepEqual(await f.root(), {sessionId: target, clientId});
    assert.equal((await f.turn(target)).result.turn.id, "test-turn");
    assert.equal(f.errors.length, 0);
  });
}

test("same-resident fork and picker switch bind child/selected thread, not source", async t => {
  const f = await fixture(t);
  await f.attach("thread/start", null, "parent");
  await f.attach("thread/fork", "parent", "child");
  assert.equal((await f.root()).sessionId, "child");
  assert((await f.turn("child")).result);
  await f.attach("thread/resume", "historical", "historical");
  assert.equal((await f.root()).sessionId, "historical");
  assert((await f.turn("historical")).result);
});

for (const scenario of ["active writer", "wrong resume", "same fork", "empty id", "non-string id", "error plus result"]) {
  test(`${scenario} never changes the prior ownership and keeps connection usable`, async t => {
    const f = await fixture(t);
    await f.attach("thread/start", null, "prior");
    const fork = scenario === "same fork";
    const returned = scenario === "empty id" ? "" : scenario === "non-string id" ? 42 : scenario === "wrong resume" ? "foreign" : "requested";
    const error = ["active writer", "error plus result"].includes(scenario) ? {code: -32600, message: "already has an active writer"} : null;
    const result = await f.attach(fork ? "thread/fork" : "thread/resume", "requested", scenario === "active writer" ? undefined : returned, error);
    assert(result.error); assert.equal((await f.root()).sessionId, "prior");
    assert.equal(f.client.readyState, WebSocket.OPEN);
    assert((await f.turn("prior")).result);
  });
}

test("historical managed mapping is preserved while picker gets local ownership", async t => {
  const f = await fixture(t);
  await bindManagedClientIdentity({...f, host: "codex", sessionId: "historical", clientId: otherClient});
  assert((await f.attach("thread/resume", "historical", "historical")).result);
  assert((await f.turn("historical")).result);
  const identity = await resolveManagedClientIdentity({...f, host: "codex", args: ["resume", "historical"]});
  assert.equal(identity.clientId, otherClient);
});

test("concurrent root mutation wins; delayed native reply cannot overwrite it", async t => {
  const f = await fixture(t);
  const id = f.send("thread/resume", {threadId: "requested"});
  await until(() => f.calls.some(r => r.id === id));
  await claimCodexRootSession(f.controlDir, {sessionId: "other", clientId});
  f.respond({id, result: {thread: {id: "requested"}}});
  assert((await f.reply(id)).error); assert.equal((await f.root()).sessionId, "other");
});

test("unbound first send returns a recoverable diagnostic and can then resume", async t => {
  const f = await fixture(t);
  const response = await f.turn("unbound");
  assert.match(response.error.message, /Resume the conversation again/);
  assert.equal(f.client.readyState, WebSocket.OPEN);
  assert.equal(f.calls.filter(r => r.method === "turn/start").length, 0);
  assert.equal(f.errors[0].code, "STATEWRIGHT_THREAD_OWNERSHIP");
  await f.attach("thread/resume", "unbound", "unbound");
  assert((await f.turn("unbound")).result);
});

test("pending attachments serialize; disconnect cancels without adopting", async t => {
  const f = await fixture(t);
  const id = f.send("thread/resume", {threadId: "requested"});
  await until(() => f.calls.some(r => r.id === id));
  assert((await f.reply(f.send("thread/fork", {threadId: "parent"}))).error);
  f.client.close(); await once(f.client, "close");
  assert.equal(await f.root(), null);
  await until(async () => {try {const x = await f.authorizer({method: "thread/resume", threadId: "retry"}); await x.cancel(); return true;} catch {return false;}});
});

test("cancellation during identity persistence prevents atomic root commit", async t => {
  const f = await fixture(t);
  let pending = true;
  await assert.rejects(commitCodexRootAttachment(f.controlDir, {sessionId: "candidate", clientId, expectedRoot: null,
    beforeCommit: async () => {pending = false;}, assertPending: () => {if (!pending) throw Error("cancelled");}}), /cancelled/);
  assert.equal(await f.root(), null);
});

test("corrupt root is not treated as an unclaimed root", async t => {
  const f = await fixture(t);
  await writeFile(join(f.controlDir, "codex-root-session.json"), "corrupt");
  assert((await f.attach("thread/resume", "candidate", "candidate")).error);
  assert.equal(await readFile(join(f.controlDir, "codex-root-session.json"), "utf8"), "corrupt");
});

for (const background of [false, true]) test(`${background ? "background helper" : "failed start persistence"} does not displace a pending classifier prompt`, async t => {
  const f = await fixture(t, {classifier: true});
  await f.reply(f.send("initialize"));
  await f.attach("thread/start", null, "prior");
  const request = invocation => ({schema: "statewright/classifier-approval-request/v2", thread_id: "prior",
    run_id: "fixture-run", run_session_id: "fixture-session", state: "implement", state_epoch: 1,
    classifier_receipt: {intent_fingerprint: "intent_v1_family", invocation_fingerprint: `invocation_v1_${invocation}`,
      final_denial_basis: "semantic_authorization_disabled", required_authority: "complete_structural_evidence_or_separate_approval",
      reformulation_allowed: true, exact_invocation_retry_allowed: false, separate_approval_allowed: true}});
  for (const i of ["one", "two"]) assert.equal((await (await f.approval(request(i))).json()).action, "rework");
  const pending = f.approval(request("three"));
  await until(() => f.replies.some(r => r.method === "mcpServer/elicitation/request"));
  const modal = f.replies.find(r => r.method === "mcpServer/elicitation/request");
  if (background) {
    const id = f.send("thread/start", {ephemeral: true});
    await until(() => f.calls.some(r => r.id === id));
    f.respond({id, result: {thread: {id: "helper", ephemeral: true}}});
    assert((await f.reply(id)).result);
    assert((await f.turn("helper")).result);
  } else {
    f.rejectCommit();
    assert((await f.attach("thread/start", null, "rejected")).error);
  }
  assert.equal((await f.root()).sessionId, "prior");
  f.client.send(JSON.stringify({id: modal.id, result: {action: "accept"}}));
  assert.equal((await (await pending).json()).action, "allow_once");
});

test("the final cancellation check and root replacement do not yield", async t => {
  const f = await fixture(t);
  const original = fs.renameSync;
  let checks = 0, cancelled = false, committedBeforeCancellation = false;
  fs.renameSync = (...args) => {committedBeforeCancellation = !cancelled; return original(...args);};
  syncBuiltinESMExports();
  try {
    await commitCodexRootAttachment(f.controlDir, {sessionId: "candidate", clientId, expectedRoot: null,
      assertPending: () => {
        assert.equal(cancelled, false);
        if (++checks === 3) queueMicrotask(() => {cancelled = true;});
      }});
    assert.equal(committedBeforeCancellation, true);
    assert.equal((await f.root()).sessionId, "candidate");
  } finally {fs.renameSync = original; syncBuiltinESMExports();}
});
