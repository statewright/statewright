import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createPiExecutorRuntime } from "../lib/executor-pi-runtime.mjs";
import { observeHost, executorAgentEnvironment } from "../statewright-exec.mjs";
import { fixture } from "./fixtures/owned-request.mjs";

async function parent(t, { parked = false, failClose = false } = {}) {
  let runtime;
  const f = await fixture({ after: callback => t.after(async () => {
    try { await runtime?.adapterBridge.close(); }
    catch (error) { if (!failClose) throw error; assert.match(error.message, /synthetic cancellation failure/); }
    finally { await callback(); }
  }) }, { parked, nativeFile: true });
  const client = { call: async name => { assert.equal(name, "statewright_get_state"); return f.getState(); } };
  runtime = await createPiExecutorRuntime({ client, sessionOwner: f.owner, approvalMirror: f.mirror });
  if (failClose) runtime.requestController.close = async () => { throw new Error("synthetic cancellation failure"); };
  const children = [];
  const options = { ...runtime, host: "pi", piRequestFrontend: true, sessionOwner: f.owner,
    cwd: f.owner.record.scope.cwd, hostSessionId: f.owner.record.host_session_id, hostSessionFile: f.owner.record.host_session_file,
    pluginsRoot: fileURLToPath(new URL("../../", import.meta.url)), piAgentDir: f.owner.nativeRoot,
    prompt: "inert task", initialState: { ...await f.getState(), model: "synthetic/model" }, client,
    approvalMirror: f.mirror, environment: {}, telemetry: async () => {}, pollIntervalMs: 1, nativeReadyTimeoutMs: 5_000,
    spawnHost: () => {
      const child = Object.assign(new EventEmitter(), { pid: 123, killed: false, exitCode: null, signalCode: null, signals: [] });
      child.finish = () => { if (child.exitCode === null) { child.exitCode = 0; child.emit("exit", 0, null); } };
      child.kill = signal => { child.killed = true; child.signals.push(signal); queueMicrotask(child.finish); };
      children.push(child); return child;
    },
  };
  t.after(() => { for (const child of children) child.finish(); });
  return { ...f, ...runtime, options, children,
    acknowledge: () => runtime.nativeReadiness.accept({ ...runtime.nativeReadiness.challenge, schema: "statewright/pi-native-ready/v1" }) };
}

test("owned Pi parent launches a parked descriptor but holds delivery until exact acknowledgement and consumption", async t => {
  const f = await parent(t, { parked: true });
  const observing = observeHost(f.options);
  while (!f.children.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.nativeReadiness.ready, false);
  await f.acknowledge();
  const request = await f.requestController.begin(f.body(1));
  assert.equal(request.phase, "parked");
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(f.children[0].signals, [], "owned parked frontend is not terminated by legacy hold logic");
  f.approve();
  const ready = await f.requestController.status(request.reference);
  assert.equal(ready.phase, "ready");
  assert.ok(await f.mirror.loadCheckpoint(), "approval observation alone cannot clear journal");
  const active = await f.requestController.consume({ reference: ready.reference, release_nonce: ready.release_nonce });
  assert.equal(active.phase, "active");
  assert.equal(await f.mirror.loadCheckpoint(), null);
  f.children[0].finish();
  await observing;
  assert.equal(f.owner.record.request.reason, "disconnected");
  assert.equal(f.nativeReadiness.ready, false);
  await assert.rejects(f.requestController.begin(f.body(2)), /disconnected/);
});

test("fast acknowledged print-child exit is valid but never retains readiness", async t => {
  const f = await parent(t);
  const observing = observeHost(f.options);
  while (!f.children.length) await new Promise(resolve => setImmediate(resolve));
  await f.acknowledge(); f.children[0].finish();
  assert.equal((await observing).code, 0);
  assert.equal(f.nativeReadiness.ready, false);
});

for (const exit of [false, true]) test(`unacknowledged owned child ${exit ? "exit" : "timeout"} fails closed without stock fallback`, async t => {
  const f = await parent(t);
  f.options.nativeReadyTimeoutMs = 20;
  const observing = observeHost(f.options);
  const rejected = assert.rejects(observing, /without exact native acknowledgement/);
  while (!f.children.length) await new Promise(resolve => setImmediate(resolve));
  if (exit) f.children[0].finish();
  await rejected;
  assert.equal(f.children.length, 1);
  assert.equal(f.nativeReadiness.ready, false);
  assert.deepEqual(f.children[0].signals, exit ? [] : ["SIGINT"]);
});

test("parent composition rejects a non-deferred journal before exposing a bridge", async t => {
  const f = await fixture(t, { nativeFile: true });
  await assert.rejects(createPiExecutorRuntime({ client: {}, sessionOwner: f.owner, approvalMirror: { deferClear: false } }), /deferred/);
});

test("observer rejects mismatched private readiness before any child launch", async t => {
  const f = await parent(t);
  await assert.rejects(observeHost({ ...f.options, requestController: {} }), /exact parent/);
  assert.equal(f.children.length, 0);
});

test("readiness cancellation failure cannot skip stopping/reaping the owned unacknowledged child", async t => {
  const f = await parent(t, { failClose: true });
  f.options.nativeReadyTimeoutMs = 20;
  await assert.rejects(observeHost(f.options), /synthetic cancellation failure/);
  assert.deepEqual(f.children[0].signals, ["SIGINT"]);
  assert.equal(f.children[0].exitCode, 0);
  assert.equal(f.nativeReadiness.ready, false);
});

test("startup timeout stops/reaps the child while durable cancellation is still pending", async t => {
  const f = await parent(t);
  f.options.nativeReadyTimeoutMs = 20;
  let arrive; let release;
  const closing = new Promise(resolve => { arrive = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const cancel = f.requestController.close.bind(f.requestController);
  f.requestController.close = async () => { arrive(); await barrier; await cancel(); };
  let settled = false;
  const observing = observeHost(f.options);
  const outcome = observing.then(() => { settled = true; }, error => { settled = true; return error; });
  try {
    await closing;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.nativeReadiness.ready, false);
    assert.deepEqual(f.children[0].signals, ["SIGINT"]);
    assert.equal(f.children[0].exitCode, 0);
    assert.equal(settled, false, "completion still drains durable cancellation");
  } finally { release(); }
  assert.match((await outcome).message, /without exact native acknowledgement/);
});

test("ordinary executor environment cannot inherit an old private launch challenge", () => {
  const env = executorAgentEnvironment({ STATEWRIGHT_PI_REQUEST_LAUNCH: "foreign" }, {
    host: "pi", adapterBridge: { url: "http://127.0.0.1:1", token: "inert" },
  });
  assert.equal(env.STATEWRIGHT_PI_REQUEST_LAUNCH, undefined);
});
