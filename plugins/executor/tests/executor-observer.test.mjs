import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { observeHost } from "../statewright-exec.mjs";

const initialState = { run_id: "run", run_session_id: "gateway", state: "review", iteration: 1 };

function fixture(t, changes = {}) {
  const children = [];
  const observed = [];
  const options = {
    host: "claude", cwd: "/fixture", hostSessionId: "native-thread", prompt: "fixture only",
    initialState, environment: {}, pollIntervalMs: 1, exitOnFinal: true,
    telemetry: async () => {}, client: { call: async () => initialState },
    approvalMirror: { observe: async state => { observed.push(state); return "live"; } },
    spawnHost: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.signals = [];
      child.finish = () => { child.exitCode = 0; child.emit("exit", 0, null); };
      child.kill = signal => { child.signals.push(signal); queueMicrotask(child.finish); };
      children.push(child);
      return child;
    }, ...changes,
  };
  t.after(() => { for (const child of children) if (child.exitCode === null) child.finish(); });
  return { options, children, observed };
}

test("initial journal failure denies host launch", async t => {
  const f = fixture(t, { approvalMirror: { observe: async () => { throw new Error("journal corrupt"); } } });
  await assert.rejects(observeHost(f.options), /journal corrupt/);
  assert.equal(f.children.length, 0);
});

test("observer requires explicit journal ownership before spawning", async t => {
  const f = fixture(t, { approvalMirror: null });
  await assert.rejects(observeHost(f.options), /journal ownership/);
  assert.equal(f.children.length, 0);
});

test("poll-time journal failure stops the owned host and propagates", async t => {
  const f = fixture(t, {
    approvalMirror: { observe: async state => { if (state !== initialState) throw new Error("journal write failed"); } },
    client: { call: async name => { assert.equal(name, "statewright_get_state"); return { ...initialState }; } },
  });
  await assert.rejects(observeHost(f.options), /journal write failed/);
  assert.deepEqual(f.children[0].signals, ["SIGINT"]);
});

test("host exit cannot outrun an in-flight approval reconciliation", async t => {
  let beginRead;
  const reading = new Promise(resolve => { beginRead = resolve; });
  let releaseRead;
  const read = new Promise(resolve => { releaseRead = resolve; });
  const f = fixture(t, {
    client: { call: async () => { beginRead(); return read; } },
    approvalMirror: { observe: async state => {
      if (state !== initialState) throw new Error("approval mismatch after exit");
    } },
  });
  let settled = false;
  const result = observeHost(f.options).finally(() => { settled = true; });
  await reading;
  f.children[0].finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  releaseRead({ ...initialState });
  await assert.rejects(result, /approval mismatch after exit/);
});

test("pending approval cannot trigger a routed host restart", async t => {
  const pending = { ...initialState, state: "gate", model: "route-changed",
    pending_approval: { approval_id: "apr" } };
  const f = fixture(t, { client: { call: async () => pending } });
  const result = observeHost(f.options);
  while (f.observed.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.children[0].signals, []);
  f.children[0].finish();
  assert.equal((await result).state.pending_approval.approval_id, "apr");
});

test("a gate arriving after reroute is requested suppresses the latched restart", async t => {
  let calls = 0;
  const routed = { ...initialState, state: "build", model: "route-changed" };
  const pending = { ...routed, pending_approval: { approval_id: "apr-late" } };
  const f = fixture(t, { client: { call: async () => ++calls === 1 ? routed : pending } });
  const spawn = f.options.spawnHost;
  f.options.spawnHost = (...args) => {
    if (f.children.length) throw new Error("pending gate restarted");
    return spawn(...args);
  };
  const result = await observeHost(f.options);
  assert.equal(f.children.length, 1);
  assert.equal(result.state.pending_approval.approval_id, "apr-late");
});
