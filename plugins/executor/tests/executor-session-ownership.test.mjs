import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createExecutorSessionStore, attachExecutorSession } from "../lib/executor-session-ownership.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "executor-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { root, cwd: root, host: "pi", workflow: "fixture-flow", projectId: "project",
    apiKey: "private-fixture-key", gatewayUrl: "http://127.0.0.1:9" };
  return { options, store: createExecutorSessionStore(options) };
}

test("explicit ownership survives store recreation without changing transport or native thread", async t => {
  const { store, options } = await fixture(t);
  const first = await store.open();
  const id = first.record.executor_session_id;
  await first.bindGateway({ run_id: "run", run_session_id: "canonical-session", workflow: "fixture-flow", state: "review" });
  await first.bindHost({ sessionId: first.record.host_session_id, sessionFile: join(first.nativeRoot, "thread.jsonl") });
  const saved = structuredClone(first.record);
  await first.release();
  const again = await createExecutorSessionStore(options).open({ sessionId: id, resume: true });
  assert.deepEqual(again.record, saved);
  await again.release();
});

test("separate-process resume preserves exact ownership and a dead-owner lock is not stolen", async t => {
  const { store, options } = await fixture(t);
  const owner = await store.open();
  const id = owner.record.executor_session_id;
  const saved = owner.record;
  const runChild = promisify(execFile);
  const moduleUrl = new URL("../lib/executor-session-ownership.mjs", import.meta.url).href;
  const child = `import {createExecutorSessionStore} from ${JSON.stringify(moduleUrl)};
    const options=JSON.parse(process.argv[1]);
    const owner=await createExecutorSessionStore(options).open({sessionId:process.argv[2],resume:true});
    console.log(JSON.stringify(owner.record));
    if(process.argv[3]==='release') await owner.release();`;
  await assert.rejects(runChild(process.execPath, ["--input-type=module", "-e", child, JSON.stringify(options), id, "release"]),
    error => error.stderr.includes("already owned"));
  await owner.release();
  const reopened = await runChild(process.execPath, ["--input-type=module", "-e", child, JSON.stringify(options), id, "release"]);
  assert.deepEqual(JSON.parse(reopened.stdout), saved);
  // A exited child leaves its ownership claim. Age/dead PID is not native-writer proof.
  await runChild(process.execPath, ["--input-type=module", "-e", child, JSON.stringify(options), id, "leave-lock"]);
  const before = await readFile(owner.path, "utf8");
  await assert.rejects(store.open({ sessionId: id, resume: true }), /native-writer verification/);
  assert.equal(await readFile(owner.path, "utf8"), before);
});

test("resume requires an explicit existing session and never creates a replacement", async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.open({ resume: true }), /explicit.*session/i);
  await assert.rejects(store.open({ sessionId: randomUUID(), resume: true }), /not found/i);
  await assert.rejects(store.open({ sessionId: "../escape", resume: true }), /session ID/i);
});

test("concurrent resumptions have one owner and cannot change the durable record", async t => {
  const { store } = await fixture(t);
  const first = await store.open();
  await assert.rejects(store.open({ sessionId: first.record.executor_session_id, resume: true }), /already owned/i);
  await assert.rejects(store.open({ sessionId: first.record.executor_session_id }), /already owned|already exists/i);
  await first.release();
});

test("multiple runs in one project have distinct transport, native and journal ownership", async t => {
  const { store } = await fixture(t);
  const a = await store.open();
  const b = await store.open();
  assert.notEqual(a.record.executor_session_id, b.record.executor_session_id);
  assert.notEqual(a.record.transport_client_id, b.record.transport_client_id);
  assert.notEqual(a.record.host_session_id, b.record.host_session_id);
  assert.notEqual(a.nativeRoot, b.nativeRoot);
  await a.release(); await b.release();
});

test("foreign credential, gateway, host, workflow, project or checkout cannot adopt a session", async t => {
  const { store, options } = await fixture(t);
  const first = await store.open();
  const id = first.record.executor_session_id;
  await first.release();
  for (const change of [{ apiKey: "foreign" }, { gatewayUrl: "http://127.0.0.1:10" }, { host: "claude" },
    { workflow: "other" }, { projectId: "other" }, { cwd: "/foreign-checkout" }]) {
    await assert.rejects(createExecutorSessionStore({ ...options, ...change }).open({ sessionId: id, resume: true }), /not found|foreign/i);
  }
});

test("corrupt records survive denied resume without repair or truncation", async t => {
  const { store } = await fixture(t);
  const first = await store.open();
  const id = first.record.executor_session_id;
  const path = first.path;
  await first.release();
  for (const raw of ["{}", "null", "[]", "invalid-json"]) {
    await writeFile(path, raw);
    await assert.rejects(store.open({ sessionId: id, resume: true }));
    assert.equal(await readFile(path, "utf8"), raw);
  }
});

test("gateway run and transport identity cannot be rebound", async t => {
  const { store } = await fixture(t);
  const owner = await store.open();
  const live = { run_id: "run", run_session_id: "session", workflow: "fixture-flow", state: "review" };
  await owner.bindGateway(live);
  for (const change of [{ run_id: "other" }, { run_session_id: "other" }, { workflow: "other" }]) {
    await assert.rejects(owner.bindGateway({ ...live, ...change }), /ownership|identity/i);
  }
  await owner.release();
});

test("ownership record contains fingerprints rather than the raw credential", async t => {
  const { store, options } = await fixture(t);
  const owner = await store.open();
  const raw = await readFile(owner.path, "utf8");
  assert.equal(raw.includes(options.apiKey), false);
  assert.equal(owner.record.schema, "statewright/executor-session/v1");
  assert.equal((await readdir(join(options.root, owner.scopeId))).filter(name => name.endsWith(".json")).length, 1);
  await owner.release();
});

function fakeClient(state, { inactive = false } = {}) {
  const calls = [];
  let loaded = false;
  return { calls, initialize: async () => calls.push(["initialize"]), supportsExactRunResume: async () => true, call: async (name, args) => {
    calls.push([name, args]);
    if (name === "statewright_get_state" && inactive && !loaded) throw new Error("No active workflow. Load a workflow before requesting state.");
    if (name === "statewright_load_workflow") loaded = true;
    return state;
  } };
}

test("resume reattaches an already-active exact owned run without loading a workflow", async t => {
  const { store } = await fixture(t);
  const owner = await store.open();
  const state = { run_id: "run", run_session_id: "session", workflow: "fixture-flow", state: "review" };
  await owner.bindGateway(state);
  const client = fakeClient(state);
  assert.deepEqual(await attachExecutorSession({ client, owner, resume: true }), state);
  assert.equal(client.calls.some(([name]) => name === "statewright_load_workflow"), false);
  await owner.release();
});

test("inactive resume carries the exact saved run selector, never a new-run fallback", async t => {
  const { store } = await fixture(t);
  const owner = await store.open();
  const state = { run_id: "run", run_session_id: "session", workflow: "fixture-flow", state: "review" };
  await owner.bindGateway(state);
  const client = fakeClient(state, { inactive: true });
  await attachExecutorSession({ client, owner, resume: true });
  assert.deepEqual(client.calls.find(([name]) => name === "statewright_load_workflow"), ["statewright_load_workflow",
    { name: "fixture-flow", resume: true, run_id: "run", project_id: "project" }]);
  await owner.release();
});

test("foreign active snapshot and transient read failure deny without a workflow load", async t => {
  const { store } = await fixture(t);
  const owner = await store.open();
  const state = { run_id: "run", run_session_id: "session", workflow: "fixture-flow", state: "review" };
  await owner.bindGateway(state);
  for (const change of [{ run_id: "other" }, { run_session_id: "other" }, { workflow: "other" }]) {
    const client = fakeClient({ ...state, ...change });
    await assert.rejects(attachExecutorSession({ client, owner, resume: true }), /ownership|identity/i);
    assert.equal(client.calls.some(([name]) => name === "statewright_load_workflow"), false);
  }
  const calls = [];
  await assert.rejects(attachExecutorSession({ owner, resume: true, client: {
    initialize: async () => {}, call: async name => { calls.push(name); throw new Error("gateway unavailable"); },
  } }), /gateway unavailable/);
  assert.deepEqual(calls, ["statewright_get_state"]);
  await owner.release();
});

test("unsupported exact-run resume and malformed active state never trigger a workflow load", async t => {
  const { store } = await fixture(t);
  const owner = await store.open();
  const state = { run_id: "run", run_session_id: "session", workflow: "fixture-flow", state: "review" };
  await owner.bindGateway(state);
  const unsupported = fakeClient(state, { inactive: true });
  unsupported.supportsExactRunResume = async () => false;
  await assert.rejects(attachExecutorSession({ client: unsupported, owner, resume: true }), /does not advertise exact-run/);
  assert.equal(unsupported.calls.some(([name]) => name === "statewright_load_workflow"), false);
  for (const malformed of [null, false, {}, []]) {
    const client = fakeClient(malformed);
    await assert.rejects(attachExecutorSession({ client, owner, resume: true }), /identity mismatch/);
    assert.equal(client.calls.some(([name]) => name === "statewright_load_workflow"), false);
  }
  const foreignHeader = Object.assign(fakeClient(state), { sessionId: "foreign-header", requireNegotiatedSessionId: true });
  await assert.rejects(attachExecutorSession({ client: foreignHeader, owner, resume: true }), /authoritative MCP session/);
  await owner.release();
});

test("changed durable ownership during capability discovery prevents resume mutation", async t => {
  const { store } = await fixture(t);
  const owner = await store.open();
  const state = { run_id: "run", run_session_id: "session", workflow: "fixture-flow", state: "review" };
  await owner.bindGateway(state);
  const before = await readFile(owner.path, "utf8");
  const client = fakeClient(state, { inactive: true });
  client.supportsExactRunResume = async () => {
    await writeFile(owner.path, JSON.stringify({ ...owner.record, run_id: "replacement" }));
    return true;
  };
  await assert.rejects(attachExecutorSession({ client, owner, resume: true }), /ownership record changed/);
  assert.equal(client.calls.some(([name]) => name === "statewright_load_workflow"), false);
  await writeFile(owner.path, before);
  await owner.release();
});
