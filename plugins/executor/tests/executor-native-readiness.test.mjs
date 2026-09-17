import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { AdapterBridge } from "../lib/adapter-bridge.mjs";
import { createExecutorNativeReadiness } from "../lib/executor-native-readiness.mjs";
import { fixture } from "./fixtures/owned-request.mjs";

function ownedChild() {
  return Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, killed: false });
}
async function readyFixture(t) {
  let bridge;
  const f = await fixture({ after: callback => t.after(async () => { try { await bridge?.close(); } finally { await callback(); } }) });
  const effects = [];
  const readiness = createExecutorNativeReadiness({ owner: f.owner, requestController: f.controller });
  const child = ownedChild();
  readiness.bindChild(child);
  bridge = await new AdapterBridge({ call: name => {
    if (name === "statewright_get_state") return f.getState();
    effects.push(name);
    return { decision: "allow" };
  }, request: () => { effects.push("mcp"); return {}; } }, {
    host: "pi", sessionOwner: f.owner, requestController: f.controller, nativeReadiness: readiness,
  }).start();
  const post = (path, body, token = bridge.token) => fetch(`${bridge.url}${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const receipt = { ...readiness.challenge, schema: "statewright/pi-native-ready/v1" };
  return { ...f, readiness, child, bridge, post, receipt, effects };
}

test("native readiness holds request delivery before a private acknowledgement", async t => {
  const f = await readyFixture(t);
  const response = await f.post("/hooks/request/begin", f.body(1));
  assert.equal(response.status, 502);
  assert.equal(f.owner.record.request_epoch, 0);
});

test("adapter identity cannot attest native readiness or unblock bridge effects", async t => {
  const f = await readyFixture(t);
  assert.deepEqual(await (await f.post("/hooks/ready", { plugin_name: "pi", plugin_version: "fixture" })).json(), { ready: false });
  assert.equal(await f.bridge.waitForReady({ timeoutMs: 1, pollMs: 1 }), false);
  for (const path of ["pre-tool", "post-tool", "stop"]) assert.equal((await f.post(`/hooks/${path}`, {})).status, 502);
  const mcp = await (await f.post("/mcp", { method: "tools/call", params: { name: "fixture" } })).json();
  assert.ok(mcp.error);
  assert.deepEqual(f.effects, []);
});

test("private acknowledgement requires token and exact once-only lifetime/descriptor fields", async t => {
  const f = await readyFixture(t);
  assert.equal((await f.post("/hooks/request/ready", f.receipt, "foreign")).status, 401);
  for (const key of Object.keys(f.receipt)) {
    const omitted = { ...f.receipt }; delete omitted[key];
    assert.equal((await f.post("/hooks/request/ready", omitted)).status, 502);
    assert.equal((await f.post("/hooks/request/ready", { ...f.receipt, [key]: randomUUID() })).status, 502);
  }
  assert.equal((await f.post("/hooks/request/ready", { ...f.receipt, decision: "approved" })).status, 502);
  assert.equal(f.readiness.ready, false);
  const acknowledgement = await (await f.post("/hooks/request/ready", f.receipt)).json();
  assert.deepEqual(acknowledgement, { ...f.readiness.challenge, schema: "statewright/native-readiness-ack/v1", ready: true });
  assert.equal(await f.bridge.waitForReady({ timeoutMs: 10 }), true);
  assert.equal((await f.post("/hooks/request/ready", f.receipt)).status, 502);
  assert.equal((await f.post("/hooks/request/begin", f.body(1))).status, 200);
  assert.equal(f.owner.record.request_epoch, 1);
});

test("two concurrent native receipts produce only one acknowledgement", async t => {
  const f = await readyFixture(t);
  const results = await Promise.allSettled([f.readiness.accept(f.receipt), f.readiness.accept(f.receipt)]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(results.filter(value => value.status === "rejected").length, 1);
});

test("readiness requires one exact owned child handle and the same bridge owner/controller", async t => {
  const f = await fixture(t);
  const readiness = createExecutorNativeReadiness({ owner: f.owner, requestController: f.controller });
  await assert.rejects(readiness.accept({ ...readiness.challenge, schema: "statewright/pi-native-ready/v1" }), /unavailable/);
  assert.throws(() => readiness.bindChild(ownedChild()), /fresh owned child/);
  assert.throws(() => new AdapterBridge({}, { host: "pi", sessionOwner: f.owner, requestController: f.controller,
    nativeReadiness: { isBoundTo: () => false } }), /same owned Pi/);
  const fresh = createExecutorNativeReadiness({ owner: f.owner, requestController: f.controller });
  fresh.bindChild(ownedChild());
  assert.throws(() => fresh.bindChild(ownedChild()), /fresh owned child/);
  await fresh.close();
});

for (const event of ["exit", "error"]) test(`owned child ${event} revokes readiness and cancels current request durably`, async t => {
  const f = await readyFixture(t);
  await f.readiness.accept(f.receipt);
  await f.controller.begin(f.body(1));
  f.child.emit(event, event === "error" ? new Error("synthetic child failure") : 0);
  assert.equal(f.readiness.ready, false);
  await f.readiness.close();
  assert.equal(f.owner.record.request.phase, "cancelled");
  assert.equal(f.owner.record.request.reason, "disconnected");
  assert.equal((await f.post("/hooks/request/begin", f.body(2))).status, 502);
});

test("parent close during awaited owner verification cannot restore readiness", async t => {
  const f = await fixture(t);
  let arrived; let release;
  const arrival = new Promise(resolve => { arrived = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const proxyOwner = { get record() { return f.owner.record; }, assertOwner: async () => { arrived(); await barrier; } };
  const readiness = createExecutorNativeReadiness({ owner: proxyOwner, requestController: f.controller });
  readiness.bindChild(ownedChild());
  const accepting = readiness.accept({ ...readiness.challenge, schema: "statewright/pi-native-ready/v1" });
  await arrival; await readiness.close(); release();
  await assert.rejects(accepting, /unavailable/);
  assert.equal(readiness.ready, false);
});

test("owned-child exit at the final admission microtask cannot restore readiness", async t => {
  const f = await fixture(t);
  const child = ownedChild();
  const proxyOwner = { get record() { return f.owner.record; }, assertOwner: async () => {
    queueMicrotask(() => queueMicrotask(() => child.emit("exit", 0)));
  } };
  const readiness = createExecutorNativeReadiness({ owner: proxyOwner, requestController: f.controller });
  readiness.bindChild(child);
  await assert.rejects(readiness.accept({ ...readiness.challenge, schema: "statewright/pi-native-ready/v1" }), /unavailable/);
  await readiness.close();
  assert.equal(readiness.ready, false);
});

test("native descriptor drift after acknowledgement invalidates the parent monotonically", async t => {
  const f = await fixture(t);
  let drift = false;
  const proxyOwner = { get record() { return { ...f.owner.record,
    ...(drift ? { host_session_file: "/foreign/native.jsonl" } : {}) }; }, assertOwner: () => f.owner.assertOwner() };
  const readiness = createExecutorNativeReadiness({ owner: proxyOwner, requestController: f.controller });
  readiness.bindChild(ownedChild());
  await readiness.accept({ ...readiness.challenge, schema: "statewright/pi-native-ready/v1" });
  drift = true;
  assert.equal(readiness.ready, false);
  drift = false;
  await assert.rejects(readiness.assertReady(), /unavailable/);
  await readiness.close();
});

test("child exit while bridge telemetry awaits denies the completed callback response", async t => {
  const f = await readyFixture(t);
  await f.readiness.accept(f.receipt);
  const begun = await (await f.post("/hooks/request/begin", f.body(1))).json();
  f.bridge.telemetry = async event => { if (event === "executor_adapter_post_tool") f.child.emit("exit", 0); };
  assert.equal((await f.post("/hooks/post-tool", { request_reference: begun.reference })).status, 502);
  assert.deepEqual(f.effects, ["statewright_adapter_post_tool"]);
  await f.readiness.close();
  assert.equal(f.owner.record.request.phase, "cancelled");
});

test("bridge server closes even when parent request cancellation fails", async t => {
  const f = await fixture(t);
  const controller = { close: async () => { throw new Error("synthetic cancellation failure"); } };
  const readiness = createExecutorNativeReadiness({ owner: f.owner, requestController: controller });
  readiness.bindChild(ownedChild());
  const bridge = await new AdapterBridge({}, { host: "pi", sessionOwner: f.owner, requestController: controller, nativeReadiness: readiness }).start();
  await assert.rejects(bridge.close(), /synthetic cancellation failure/);
  assert.equal(bridge.server, null);
});

test("waitForReady cannot report success after revocation at its final await boundary", async () => {
  const owner = {}; const controller = {};
  let ready = true;
  const nativeReadiness = { isBoundTo: (a, b) => a === owner && b === controller,
    get ready() { return ready; }, assertReady: async () => { queueMicrotask(() => { ready = false; }); } };
  const bridge = new AdapterBridge({}, { host: "pi", sessionOwner: owner, requestController: controller, nativeReadiness });
  assert.equal(await bridge.waitForReady({ timeoutMs: 10 }), false);
  assert.equal(nativeReadiness.ready, false);
});

test("actual native readiness close at final waitForReady microtask cannot produce startup success", async t => {
  const f = await fixture(t);
  let armed = false; let closeCalls = 0; let readiness;
  const proxyOwner = { get record() { return f.owner.record; }, assertOwner: async () => {
    await f.owner.assertOwner();
    if (armed) queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => { void readiness.close(); })));
  } };
  const controller = { close: async () => { closeCalls += 1; await f.controller.close(); } };
  readiness = createExecutorNativeReadiness({ owner: proxyOwner, requestController: controller });
  readiness.bindChild(ownedChild());
  await readiness.accept({ ...readiness.challenge, schema: "statewright/pi-native-ready/v1" });
  const bridge = new AdapterBridge({}, { host: "pi", sessionOwner: proxyOwner, requestController: controller, nativeReadiness: readiness });
  armed = true;
  assert.equal(await bridge.waitForReady({ timeoutMs: 100 }), false);
  assert.equal(readiness.ready, false);
  await readiness.close();
  assert.equal(closeCalls, 1);
});

test("same durable native descriptor gets fresh parent/child lifetimes after explicit reopen", async t => {
  const f = await readyFixture(t);
  await f.readiness.accept(f.receipt);
  await f.bridge.close();
  await f.reopen();
  const fresh = createExecutorNativeReadiness({ owner: f.owner, requestController: f.controller });
  fresh.bindChild(ownedChild());
  assert.notEqual(fresh.challenge.parent_lifetime_id, f.readiness.challenge.parent_lifetime_id);
  assert.notEqual(fresh.challenge.child_lifetime_id, f.readiness.challenge.child_lifetime_id);
  assert.equal(fresh.challenge.native_session_id, f.readiness.challenge.native_session_id);
  await assert.rejects(fresh.accept(f.receipt), /Invalid or replayed/);
  assert.equal(fresh.ready, false);
  await fresh.close();
});

test("an actual task-owned child exit revokes readiness without signalling any foreign child", async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  await once(child, "spawn");
  const exit = once(child, "exit");
  t.after(async () => { child.stdin.end(); await exit; });
  const readiness = createExecutorNativeReadiness({ owner: f.owner, requestController: f.controller });
  readiness.bindChild(child);
  await readiness.accept({ ...readiness.challenge, schema: "statewright/pi-native-ready/v1" });
  assert.equal(readiness.ready, true);
  child.stdin.end(); await exit; await readiness.close();
  assert.equal(readiness.ready, false);
});
