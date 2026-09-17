import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutorApprovalMirror } from "../lib/executor-approval-mirror.mjs";
import { createRuntimeApprovalService } from "../lib/runtime-approval-service.mjs";

const liveState = {
  run_id: "run_1",
  run_session_id: "gw_1",
  state: "plan",
  pending_approval: { approval_id: "apr_1", event: "approved", from_state: "plan", to_state: "build" },
};

function makeHarness(t, { root, events = [], receiptStatus = "approved", receiptError = null,
  finalState = { ...liveState, state: "build", pending_approval: null } } = {}) {
  const journalRoot = root ?? join(tmpdir(), `statewright-exec-mirror-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const makeService = options => {
    const journal = createRuntimeApprovalService(options);
    return { ...journal, getState: async () => finalState, read: async ticket => {
      if (receiptError) throw receiptError;
      return { ...ticket, status: receiptStatus };
    } };
  };
  const service = createExecutorApprovalMirror({
    workflow: "test-flow",
    cwd: "/tmp/statewright-exec-mirror",
    root: journalRoot,
    apiKey: "test-key",
    gatewayUrl: "http://127.0.0.1:9",
    telemetry: async (event) => events.push(event),
    makeService,
  });
  t.after(async () => {
    if (root === undefined) await rm(journalRoot, { recursive: true, force: true });
  });
  return { service, events, journalRoot, makeService };
}

test("observe parks a newly pending approval in the shared runtime approval journal", async t => {
  const { service, events, journalRoot, makeService } = makeHarness(t);
  const status = await service.observe(liveState);
  assert.equal(status, "parked");
  const [parked] = events;
  assert.deepEqual(parked, { type: "executor_approval_parked", approvalId: "apr_1", toState: "build" });
  // A fresh mirror (new process, same client identity) restores the parked checkpoint.
  const again = createExecutorApprovalMirror({
    workflow: "test-flow",
    cwd: "/tmp/statewright-exec-mirror",
    root: journalRoot,
    apiKey: "test-key",
    gatewayUrl: "http://127.0.0.1:9",
    makeService,
  });
  const restored = await again.restore(liveState);
  assert.equal(restored?.status, "parked");
  assert.equal(restored.saved.pending_approval.approval_id, "apr_1");
});

test("observe is idempotent while the approval stays pending and clears on resolution", async t => {
  const { service, events } = makeHarness(t);
  await service.observe(liveState);
  await service.observe(liveState);
  assert.equal(events.filter(e => e.type === "executor_approval_parked").length, 1);
  const resolved = { run_id: "run_1", run_session_id: "gw_1", state: "build", pending_approval: undefined };
  assert.equal(await service.observe(resolved), "live");
  assert.deepEqual(events.at(-1), { type: "executor_approval_cleared", approvalId: "apr_1", reason: "approved_while_parked" });
});

test("observe preserves a checkpoint whose run was replaced", async t => {
  const { service, events } = makeHarness(t);
  await service.observe(liveState);
  const replaced = { run_id: "run_2", run_session_id: "gw_2", state: "plan", pending_approval: undefined };
  await assert.rejects(service.observe(replaced), /matching live workflow/);
  assert.equal(events.filter(e => e.type === "executor_approval_cleared").length, 0);
  assert.equal((await service.restore(liveState)).status, "parked");
});

test("restore reports approved-while-parked and clears the journal", async t => {
  const root = join(tmpdir(), `statewright-exec-mirror-approved-${Math.random().toString(16).slice(2)}`);
  const first = makeHarness(t, { root });
  await first.service.observe(liveState);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const second = createExecutorApprovalMirror({
    workflow: "test-flow",
    cwd: "/tmp/statewright-exec-mirror",
    root,
    apiKey: "test-key",
    gatewayUrl: "http://127.0.0.1:9",
    telemetry: first.events.push.bind(first.events),
    makeService: first.makeService,
  });
  const approved = { run_id: "run_1", run_session_id: "gw_1", state: "build", pending_approval: undefined };
  const restored = await second.restore(approved);
  assert.equal(restored.status, "cleared");
  assert.equal(restored.saved.pending_approval.approval_id, "apr_1");
  assert.deepEqual(first.events.at(-1), { type: "executor_approval_cleared", approvalId: "apr_1", reason: "approved_while_parked" });
});

test("restore preserves a checkpoint with no matching live workflow", async t => {
  const root = join(tmpdir(), `statewright-exec-mirror-stale-${Math.random().toString(16).slice(2)}`);
  const first = makeHarness(t, { root });
  await first.service.observe(liveState);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const second = createExecutorApprovalMirror({
    workflow: "test-flow",
    cwd: "/tmp/statewright-exec-mirror",
    root,
    apiKey: "test-key",
    gatewayUrl: "http://127.0.0.1:9",
    telemetry: first.events.push.bind(first.events),
    makeService: first.makeService,
  });
  const foreign = { run_id: "run_9", run_session_id: "gw_9", state: "plan" };
  await assert.rejects(second.restore(foreign), /matching live workflow/);
  assert.equal((await second.restore(liveState)).status, "parked");
  assert.equal(first.events.filter(e => e.type === "executor_approval_cleared").length, 0);
});

test("restore returns null when no checkpoint exists", async t => {
  const { service } = makeHarness(t);
  assert.equal(await service.restore(liveState), null);
});

test("pending snapshots without a gateway run identity fail closed", async t => {
  const { service, events } = makeHarness(t);
  await assert.rejects(service.observe({ state: "plan", pending_approval: { approval_id: "apr_1" } }), /Incomplete/);
  await assert.rejects(service.observe({ run_id: "run_1", state: "plan", pending_approval: { approval_id: "apr_1" } }), /Incomplete/);
  assert.equal(events.length, 0);
});

for (const [label, live] of [
  ["missing snapshot", null],
  ["foreign session", { ...liveState, run_session_id: "foreign" }],
  ["changed ticket", { ...liveState, pending_approval: { ...liveState.pending_approval, approval_id: "apr_2" } }],
  ["changed edge", { ...liveState, pending_approval: { ...liveState.pending_approval, to_state: "deploy" } }],
  ["unchanged source without ticket", { ...liveState, pending_approval: null }],
]) test(`restore and observe deny ${label} without losing the checkpoint`, async t => {
  const { service, events } = makeHarness(t);
  await service.observe(liveState);
  await assert.rejects(service.restore(live));
  await assert.rejects(service.observe(live));
  assert.equal((await service.restore(liveState)).status, "parked");
  assert.equal(events.filter(e => e.type === "executor_approval_cleared").length, 0);
});

for (const status of ["pending", "rejected"]) test(`target state alone cannot release a ${status} ticket`, async t => {
  const { service, events } = makeHarness(t, { receiptStatus: status });
  await service.observe(liveState);
  await assert.rejects(service.observe({ ...liveState, state: "build", pending_approval: null }));
  assert.equal((await service.restore(liveState)).status, "parked");
  assert.equal(events.filter(e => e.type === "executor_approval_cleared").length, 0);
});

test("unavailable authority keeps the checkpoint parked", async t => {
  const { service } = makeHarness(t, { receiptError: new Error("authority unavailable") });
  await service.observe(liveState);
  await assert.rejects(service.restore({ ...liveState, state: "build", pending_approval: null }), /authority unavailable/);
  assert.equal((await service.restore(liveState)).status, "parked");
});

for (const [label, finalState] of [
  ["missing workflow", null],
  ["foreign run", { ...liveState, run_id: "other", state: "build", pending_approval: null }],
  ["foreign session", { ...liveState, run_session_id: "other", state: "build", pending_approval: null }],
  ["new gate", { ...liveState, state: "build", pending_approval: { approval_id: "apr_2" } }],
  ["wrong destination", { ...liveState, state: "deploy", pending_approval: null }],
  ...[false, 0, ""].map(value => [`malformed pending ${JSON.stringify(value)}`,
    { ...liveState, state: "build", pending_approval: value }]),
]) test(`post-receipt ${label} prevents checkpoint consumption`, async t => {
  const { service } = makeHarness(t, { finalState });
  await service.observe(liveState);
  await assert.rejects(service.observe({ ...liveState, state: "build", pending_approval: null }), /no longer applied/);
  assert.equal((await service.restore(liveState)).status, "parked");
});

for (const pending_approval of [false, 0, ""]) test(`initial malformed pending ${JSON.stringify(pending_approval)} denies admission`, async t => {
  const { service } = makeHarness(t);
  await assert.rejects(service.observe({ ...liveState, pending_approval }), /Incomplete/);
});

test("journal scope isolates credential, gateway, host, project and checkout", async t => {
  const { service, journalRoot } = makeHarness(t);
  await service.observe(liveState);
  const base = { workflow: "test-flow", cwd: "/tmp/statewright-exec-mirror", root: journalRoot,
    apiKey: "test-key", gatewayUrl: "http://127.0.0.1:9" };
  for (const change of [{ apiKey: "other-key" }, { gatewayUrl: "http://127.0.0.1:10" },
    { host: "pi" }, { projectId: "other-project" }, { cwd: "/other-checkout" }]) {
    const other = createExecutorApprovalMirror({ ...base, ...change });
    assert.notEqual(other.clientId, service.clientId);
    assert.equal(await other.restore(liveState), null);
  }
});
