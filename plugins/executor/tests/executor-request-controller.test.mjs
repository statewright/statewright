import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { base, pending, digest, fixture } from "./fixtures/owned-request.mjs";
import { validateExecutorRequest } from "../lib/executor-request-record.mjs";

test("parent mints durable request epochs without persisting raw input", async t => {
  const f = await fixture(t);
  const first = await f.controller.begin(f.body(1));
  const second = await f.controller.begin(f.body(2));
  assert.equal(first.reference.request_epoch, 1);
  assert.equal(second.reference.request_epoch, 2);
  assert.notEqual(first.reference.request_id, second.reference.request_id);
  await assert.rejects(f.controller.status(first.reference), /replaced|ownership/);
  const disk = JSON.parse(await readFile(f.owner.path, "utf8"));
  assert.equal(disk.request_epoch, 2);
  assert.equal(disk.request.input_digest, digest);
  assert.equal(JSON.stringify(disk).includes("fixture-private-key"), false);
});

test("input cannot supply a decision, checkpoint, epoch, foreign native thread or old sequence", async t => {
  const f = await fixture(t);
  for (const body of [{ ...f.body(1), decision: "approved" }, { ...f.body(1), approval: pending },
    { ...f.body(1), request_epoch: 100 }, { ...f.body(1), native_session_id: "foreign" },
    { ...f.body(1), input_sequence: 0 }, { ...f.body(1), input_digest: "raw input" }]) {
    await assert.rejects(f.controller.begin(body), /Invalid|superseded/);
  }
  assert.equal(f.owner.record.request_epoch, 0);
  await f.controller.begin(f.body(2));
  await assert.rejects(f.controller.begin(f.body(1)), /superseded/);
});

test("projection absence cannot release; private receipt plus applied edge yields a durable grant", async t => {
  const f = await fixture(t, { parked: true });
  const started = await f.controller.begin(f.body(1));
  assert.equal(started.phase, "parked");
  assert.equal(started.release_nonce, null);
  f.setLive({ ...base, state: "work" });
  assert.equal((await f.controller.status(started.reference)).phase, "parked");
  assert.ok(await f.mirror.loadCheckpoint());
  f.approve();
  const ready = await f.controller.status(started.reference);
  assert.equal(ready.phase, "ready");
  assert.ok(ready.release_nonce);
  assert.equal(JSON.parse(await readFile(f.owner.path, "utf8")).request.phase, "ready");
  assert.ok(await f.mirror.loadCheckpoint());
  assert.equal(f.events.some(event => event.startsWith("clear:")), false);
});

test("once-only consumption persists before clearance and duplicate grants deny", async t => {
  const f = await fixture(t, { parked: true });
  const started = await f.controller.begin(f.body(1));
  f.approve();
  const ready = await f.controller.status(started.reference);
  const body = { reference: ready.reference, release_nonce: ready.release_nonce };
  const consumed = await f.controller.consume(body);
  assert.equal(consumed.phase, "active");
  assert.deepEqual(f.owner.record.request.consumed_approval_ids, ["approval"]);
  assert.equal(await f.mirror.loadCheckpoint(), null);
  await assert.rejects(f.controller.consume(body), /consumed|Stale/);
});

test("concurrent consumers have one durable winner", async t => {
  const f = await fixture(t, { parked: true });
  const started = await f.controller.begin(f.body(1));
  f.approve();
  const ready = await f.controller.status(started.reference);
  const results = await Promise.allSettled([f.controller.consume({ reference: ready.reference, release_nonce: ready.release_nonce }),
    f.controller.consume({ reference: ready.reference, release_nonce: ready.release_nonce })]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  assert.deepEqual(f.owner.record.request.consumed_approval_ids, ["approval"]);
});

test("rejection cancels old continuation and retains its durable approval", async t => {
  const f = await fixture(t, { parked: true });
  const started = await f.controller.begin(f.body(1));
  f.reject();
  const rejected = await f.controller.status(started.reference);
  assert.equal(rejected.phase, "cancelled");
  assert.equal(f.owner.record.request.reason, "rejected");
  assert.ok(await f.mirror.loadCheckpoint());
  await assert.rejects(f.controller.status(started.reference), /ended/);
});

for (const reason of ["cancelled", "dismissed", "disconnected", "timeout", "superseded"]) {
  test(`${reason} preserves the gate and denies late approved continuation`, async t => {
    const f = await fixture(t, { parked: true });
    const started = await f.controller.begin(f.body(1));
    await f.controller.cancel({ reference: started.reference, reason });
    f.approve();
    await assert.rejects(f.controller.status(started.reference), /replaced|ended/);
    assert.ok(await f.mirror.loadCheckpoint());
  });
}

test("new input arriving during a private receipt read invalidates the old release", async t => {
  const f = await fixture(t, { parked: true });
  const started = await f.controller.begin(f.body(1));
  f.approve();
  let releaseRead;
  let readStarted;
  const startedRead = new Promise(resolve => { readStarted = resolve; });
  const blockedRead = new Promise(resolve => { releaseRead = resolve; });
  f.setAfterRead(async () => { readStarted(); await blockedRead; });
  const old = f.controller.status(started.reference);
  await startedRead;
  const replacement = f.controller.begin({ ...f.body(2), input_digest: "b".repeat(64) });
  releaseRead();
  await assert.rejects(old, /replaced|ownership/);
  f.setAfterRead(async () => {});
  const latest = await replacement;
  assert.equal(latest.reference.request_epoch, 2);
  assert.equal(f.owner.record.request.input_digest, "b".repeat(64));
  assert.ok(await f.mirror.loadCheckpoint());
});

test("foreign run after private approval cannot issue or consume a grant", async t => {
  const f = await fixture(t, { parked: true });
  const started = await f.controller.begin(f.body(1));
  f.approve();
  f.setAfterRead(async () => f.setLive({ ...base, state: "work", run_id: "foreign" }));
  await assert.rejects(f.controller.status(started.reference), /matching|identity|ownership/);
  assert.equal(f.owner.record.request.phase, "parked");
  assert.ok(await f.mirror.loadCheckpoint());
});

test("crash gap after consumption repairs clearance without reissuing the old grant", async t => {
  const f = await fixture(t, { parked: true });
  const started = await f.controller.begin(f.body(1));
  f.approve();
  const ready = await f.controller.status(started.reference);
  f.setClearFailure(true);
  await assert.rejects(f.controller.consume({ reference: ready.reference, release_nonce: ready.release_nonce }), /clear unavailable/);
  assert.deepEqual(f.owner.record.request.consumed_approval_ids, ["approval"]);
  assert.ok(await f.mirror.loadCheckpoint());
  await assert.rejects(f.controller.status(ready.reference), /replaced|ended/);
  assert.equal(f.owner.record.request.reason, "release_delivery_failed");
  f.setClearFailure(false);
  const latest = await f.controller.begin(f.body(2));
  assert.equal(latest.phase, "active");
  assert.equal(latest.release_nonce, null);
  assert.equal(await f.mirror.loadCheckpoint(), null);
  await assert.rejects(f.controller.consume({ reference: ready.reference, release_nonce: ready.release_nonce }), /replaced|ownership/);
});

test("queued simultaneous inputs have one latest durable epoch", async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.controller.begin(f.body(1)), f.controller.begin(f.body(2))]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[1].value.reference.request_epoch, 2);
  assert.equal(f.owner.record.request_epoch, 2);
  await f.owner.assertOwner();
});

test("cancellation invalidates admission before its durable write can finish", async t => {
  const f = await fixture(t);
  const started = await f.controller.begin(f.body(1));
  const original = f.owner.cancelRequest;
  let arrived;
  let release;
  const arrival = new Promise(resolve => { arrived = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  f.owner.cancelRequest = async (...args) => { arrived(); await barrier; return original(...args); };
  const cancellation = f.controller.cancel({ reference: started.reference, reason: "dismissed" });
  await arrival;
  try { await assert.rejects(f.controller.status(started.reference), /replaced|ended/); }
  finally { release(); await cancellation; }
  assert.equal(f.owner.record.request.reason, "dismissed");
});

test("reopening preserves epochs and consumption but never adopts the old native request", async t => {
  const f = await fixture(t, { parked: true });
  const started = await f.controller.begin(f.body(1));
  f.approve();
  const ready = await f.controller.status(started.reference);
  await f.controller.consume({ reference: ready.reference, release_nonce: ready.release_nonce });
  await f.reopen();
  await assert.rejects(f.controller.status(ready.reference), /replaced/);
  const next = await f.controller.begin(f.body(1));
  assert.equal(next.reference.request_epoch, 2);
  assert.deepEqual(f.owner.record.request.consumed_approval_ids, ["approval"]);
  assert.equal(next.release_nonce, null);
});

test("run replacement after journal clearance cancels delivery without reissuing consumption", async t => {
  const f = await fixture(t, { parked: true });
  const started = await f.controller.begin(f.body(1));
  f.approve();
  const ready = await f.controller.status(started.reference);
  f.setAfterClear(async () => f.setLive({ ...base, state: "work", run_id: "foreign" }));
  await assert.rejects(f.controller.consume({ reference: ready.reference, release_nonce: ready.release_nonce }), /identity|ownership/);
  assert.deepEqual(f.owner.record.request.consumed_approval_ids, ["approval"]);
  assert.equal(f.owner.record.request.phase, "cancelled");
  await assert.rejects(f.controller.status(ready.reference), /replaced|ended/);
});

test("deferred mirror cannot clear a journal without durable-consumption verification", async t => {
  const f = await fixture(t, { parked: true });
  await f.controller.begin(f.body(1));
  f.approve();
  await assert.rejects(f.mirror.clearConsumed(await f.mirror.loadCheckpoint()), /verification/);
  assert.ok(await f.mirror.loadCheckpoint());
});

test("strict ledger rejects malformed identities, orphan epochs and partial phase records", async t => {
  const f = await fixture(t, { parked: true });
  const started = await f.controller.begin(f.body(1));
  f.approve();
  await f.controller.status(started.reference);
  const good = f.owner.record;
  const old = structuredClone(good);
  delete old.request;
  old.request_epoch = 0;
  validateExecutorRequest(old);
  old.request_epoch = 1;
  assert.throws(() => validateExecutorRequest(old), /ledger/);
  const mutations = [
    value => { value.request.request_id = [value.request.request_id]; },
    value => { value.request.input_digest = [digest]; },
    value => { value.request.release_nonce = [value.request.release_nonce]; },
    value => { value.request.request_epoch = 0; },
    value => { value.request.native_session_id = "foreign"; },
    value => { value.request.unknown = true; },
    value => { value.request.phase = "parked"; value.request.approval = null; value.request.release_nonce = null; },
    value => { value.request.phase = "active"; value.request.release_nonce = null; },
    value => { value.request.phase = "cancelled"; value.request.release_nonce = null; },
    value => { value.request.consumed_approval_ids = ["approval"]; },
    value => { value.request.approval.run_id = "foreign"; },
    value => { value.request.approval.extra = true; },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(good);
    mutate(bad);
    assert.throws(() => validateExecutorRequest(bad), /ledger|Foreign|Invalid/);
  }
  assert.deepEqual(f.owner.record, good);
});
