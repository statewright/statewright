import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexApprovalGate } from "../lib/codex-approval-gate.mjs";
import { approvalJournal } from "../lib/approval-journal.mjs";

const threadId = "thread1";
const snapshot = {
  run_id: "run1", run_session_id: "session1", state: "review",
  pending_approval: { approval_id: "apr_test", from_state: "review", to_state: "release", message: "Review evidence" },
};
const approved = { run_id: "run1", run_session_id: "session1", state: "release", is_final: false };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("Timed out waiting for mocked approval activity");
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-approval-gate-"));
  const journal = approvalJournal(root, "client1");
  const events = [], sent = [], decisions = [], continuations = [], gates = [];
  let state = structuredClone(snapshot);
  let receipt = { ...snapshot.pending_approval, run_id: "run1", run_session_id: "session1", status: "pending", can_decide: true };
  let goal = { status: "active", objective: "Ship reviewed work", createdAt: 123 };
  const service = {
    pollMs: 5,
    ownsThread: async id => id === threadId,
    park: async (id, value) => { events.push("checkpoint"); await journal.save(id, value); },
    restore: id => journal.load(id),
    clear: async (id, approvalId) => { events.push("clear"); await journal.clear(id, approvalId); },
    getState: async () => state,
    read: async () => receipt,
    resolve: async (_ticket, decision) => {
      decisions.push(decision);
      receipt = { ...receipt, status: decision };
      state = decision === "approved" ? structuredClone(approved) : { ...snapshot, pending_approval: null };
      return receipt;
    },
    openReview: async () => {},
  };
  const rpc = async (method, params) => {
    assert.equal(params.threadId, threadId);
    events.push(method);
    if (method === "thread/goal/get") return { goal };
    if (method === "thread/goal/set") { goal = { ...goal, status: params.status }; return { goal }; }
    if (method === "thread/read") return { thread: { id: threadId, status: { type: "active" } } };
    if (method === "turn/interrupt") { assert.equal(params.turnId, "turn1"); return {}; }
    assert.fail(`Unexpected host RPC ${method}`);
  };
  const makeGate = () => {
    const gate = new CodexApprovalGate({ service, rpc,
      send: item => { sent.push(item); events.push(item.method); },
      record: async event => events.push(event.type),
      continueApproved: async value => {
        value.check();
        continuations.push(value);
        events.push("continue");
        goal = { ...goal, status: "active" };
      },
    });
    gates.push(gate);
    return gate;
  };
  const gate = makeGate();
  t.after(async () => {
    for (const instance of gates) instance.close();
    await delay(0);
    await rm(root, { recursive: true, force: true });
  });
  return { gate, makeGate, service, journal, sent, events, decisions, continuations,
    goal: () => goal, setGoal: value => { goal = value; }, setState: value => { state = value; }, setReceipt: value => { receipt = value; },
    dialog: () => sent.findLast(item => item.method === "mcpServer/elicitation/request"),
  };
}

test("approval checkpoints and pauses before interruption, then releases only after applied approval", async t => {
  const f = await fixture(t);
  const waiting = f.gate.observe(threadId, snapshot, "turn1");
  await until(() => f.dialog());
  assert.deepEqual(f.events.slice(0, 6), ["checkpoint", "thread/goal/get", "thread/goal/set", "thread/read", "turn/interrupt", "human_approval_parked"]);
  assert.equal(f.goal().status, "paused");
  assert.deepEqual(await f.journal.load(threadId), snapshot);
  assert.equal(f.continuations.length, 0);
  f.gate.handleReply({ id: f.dialog().id, result: { action: "accept" } });
  await waiting;
  assert.deepEqual(f.decisions, ["approved"]);
  assert.equal(f.continuations.length, 1);
  assert.deepEqual(f.continuations[0].state, approved);
  assert.equal(f.continuations[0].goal.status, "paused");
  assert.equal(f.goal().status, "active");
  assert.equal(await f.journal.load(threadId), null);
  assert(f.events.indexOf("continue") < f.events.indexOf("clear"));
});

test("beforeTurn waits for approval without creating a second autonomous continuation", async t => {
  const f = await fixture(t);
  const waiting = f.gate.beforeTurn(threadId);
  await until(() => f.dialog());
  f.gate.handleReply({ id: f.dialog().id, result: { action: "accept" } });
  assert.deepEqual(await waiting, { state: approved, approvalId: snapshot.pending_approval.approval_id });
  assert.equal(f.continuations.length, 0);
  assert.deepEqual(await f.journal.load(threadId), snapshot);
  assert.equal(f.events.includes("clear"), false);
});

for (const can_decide of [false, undefined]) test(`unauthorized capability ${can_decide} stays pending without inference`, async t => {
  const f = await fixture(t);
  f.setReceipt({ ...snapshot.pending_approval, run_id: "run1", run_session_id: "session1", status: "pending", can_decide });
  const waiting = f.gate.reopen(threadId);
  const rejected = assert.rejects(waiting, /closed/);
  await until(() => f.sent.some(item => item.method === "warning"));
  assert.equal(f.dialog(), undefined);
  f.gate.handleReply({ id: "statewright-approval-forged", result: { action: "accept" } });
  await delay(15);
  assert.equal(f.gate.pending.size, 1);
  assert.equal(f.goal().status, "paused");
  assert.deepEqual(f.decisions, []);
  assert.deepEqual(f.continuations, []);
  assert.deepEqual(await f.journal.load(threadId), snapshot);
  f.gate.close();
  await rejected;
});

for (const cause of ["dismissal", "disconnect"]) test(`${cause} retains checkpoint and a cold gate reopens it`, async t => {
  const f = await fixture(t);
  const waiting = f.gate.reopen(threadId);
  const rejected = assert.rejects(waiting, /dismissed|closed/);
  await until(() => f.dialog());
  const oldId = f.dialog().id;
  if (cause === "dismissal") f.gate.handleReply({ id: oldId, result: { action: "cancel" } });
  else f.gate.close();
  await rejected;
  f.gate.close();
  assert.deepEqual(await f.journal.load(threadId), snapshot);
  assert.equal(f.goal().status, "paused");
  assert.deepEqual(f.decisions, []);
  const cold = f.makeGate();
  const reopened = cold.reopen(threadId);
  await until(() => f.dialog()?.id !== oldId);
  cold.handleReply({ id: f.dialog().id, result: { action: "accept" } });
  await reopened;
  assert.deepEqual(f.decisions, ["approved"]);
  assert.equal(f.continuations.length, 1);
  assert.equal(await f.journal.load(threadId), null);
});

test("newer input after a receipt but before live-state confirmation prevents continuation", async t => {
  const f = await fixture(t);
  const live = deferred();
  let confirming = false;
  const waiting = f.gate.reopen(threadId);
  const rejected = assert.rejects(waiting, /superseded/);
  await until(() => f.dialog());
  f.service.getState = () => { confirming = true; return live.promise; };
  f.gate.handleReply({ id: f.dialog().id, result: { action: "accept" } });
  await until(() => confirming);
  f.gate.userActivity(threadId);
  live.resolve(approved);
  await rejected;
  assert.equal(f.continuations.length, 0);
  assert.equal(f.goal().status, "paused");
  assert.deepEqual(await f.journal.load(threadId), snapshot);
});

test("newer input during initial lookup prevents parking or continuation", async t => {
  const f = await fixture(t);
  const live = deferred();
  let reading = false;
  f.service.getState = () => { reading = true; return live.promise; };
  const waiting = f.gate.beforeTurn(threadId);
  const rejected = assert.rejects(waiting, /newer input/);
  await until(() => reading);
  f.gate.userActivity(threadId);
  live.resolve(snapshot);
  await rejected;
  assert.deepEqual(f.events, []);
  assert.equal(await f.journal.load(threadId), null);
});

test("foreign live session cannot reopen a saved checkpoint", async t => {
  const f = await fixture(t);
  await f.journal.save(threadId, snapshot);
  f.setState({ ...snapshot, run_session_id: "foreign" });
  await assert.rejects(f.gate.reopen(threadId), /matching live workflow/);
  assert.deepEqual(f.decisions, []);
  assert.deepEqual(f.continuations, []);
  assert.deepEqual(await f.journal.load(threadId), snapshot);
  assert.equal(f.dialog(), undefined);
});

test("foreign root thread refuses a checkpoint", async t => {
  const f = await fixture(t);
  await f.journal.save("foreign-thread", snapshot);
  await assert.rejects(f.gate.reopen("foreign-thread"), /different root thread/);
  assert.deepEqual(await f.journal.load("foreign-thread"), snapshot);
  assert.deepEqual(f.events, []);
});

test("rejection clears its checkpoint but leaves the native goal paused", async t => {
  const f = await fixture(t);
  const waiting = f.gate.reopen(threadId);
  const rejected = assert.rejects(waiting, /Human rejected/);
  await until(() => f.dialog());
  f.gate.handleReply({ id: f.dialog().id, result: { action: "decline" } });
  await rejected;
  assert.deepEqual(f.decisions, ["rejected"]);
  assert.equal(f.goal().status, "paused");
  assert.deepEqual(f.continuations, []);
  assert.equal(await f.journal.load(threadId), null);
});

test("receipt read outage keeps the checkpoint and paused goal without inferring a decision", async t => {
  const f = await fixture(t);
  f.service.read = async () => { throw new Error("offline"); };
  const gate = f.makeGate();
  const waiting = gate.reopen(threadId);
  const rejected = assert.rejects(waiting, /closed/);
  await until(() => f.events.includes("approval_read_unavailable"));
  await delay(15);
  assert.equal(f.events.filter(event => event === "approval_read_unavailable").length, 1);
  assert.equal(f.dialog(), undefined);
  assert.equal(f.goal().status, "paused");
  assert.deepEqual(f.decisions, []);
  assert.deepEqual(f.continuations, []);
  assert.deepEqual(await f.journal.load(threadId), snapshot);
  gate.close();
  await rejected;
});

test("state read outage fails closed and retains the saved checkpoint", async t => {
  const f = await fixture(t);
  await f.journal.save(threadId, snapshot);
  f.service.getState = async () => { throw new Error("state offline"); };
  await assert.rejects(f.gate.beforeTurn(threadId), /state offline/);
  assert.deepEqual(await f.journal.load(threadId), snapshot);
  assert.deepEqual(f.decisions, []);
  assert.deepEqual(f.continuations, []);
});

test("approved receipt without an applied matching workflow cannot release or clear", async t => {
  const f = await fixture(t);
  f.service.resolve = async () => ({ ...snapshot.pending_approval, run_id: "run1", run_session_id: "session1", status: "approved" });
  const gate = f.makeGate();
  const waiting = gate.reopen(threadId);
  const rejected = assert.rejects(waiting, /has not been applied/);
  await until(() => f.dialog());
  gate.handleReply({ id: f.dialog().id, result: { action: "accept" } });
  await rejected;
  assert.equal(f.goal().status, "paused");
  assert.deepEqual(f.continuations, []);
  assert.deepEqual(await f.journal.load(threadId), snapshot);
});

test("external website approval before observation still pauses and releases the exact hinted destination", async t => {
  const f = await fixture(t);
  f.setState(approved);
  f.setReceipt({ ...snapshot.pending_approval, run_id: "run1", run_session_id: "session1", status: "approved" });
  await f.gate.observe(threadId, snapshot, "turn1");
  assert.equal(f.dialog(), undefined);
  assert.deepEqual(f.decisions, []);
  assert.equal(f.continuations.length, 1);
  assert.deepEqual(f.continuations[0].state, approved);
  assert.deepEqual(f.events.slice(0, 6), ["checkpoint", "thread/goal/get", "thread/goal/set", "thread/read", "turn/interrupt", "human_approval_parked"]);
  assert.equal(await f.journal.load(threadId), null);
});

for (const [label, live] of [
  ["foreign session", { ...approved, run_session_id: "foreign" }],
  ["foreign run", { ...approved, run_id: "foreign" }],
  ["wrong destination", { ...approved, state: "other" }],
  ["different pending approval", { ...snapshot, pending_approval: { ...snapshot.pending_approval, approval_id: "foreign" } }],
]) test(`external website hint with ${label} stays fail closed`, async t => {
  const f = await fixture(t);
  f.setState(live);
  await assert.rejects(f.gate.observe(threadId, snapshot, "turn1"), /matching live workflow|identity changed/);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.decisions, []);
  assert.deepEqual(f.continuations, []);
});

test("checkpoint exists before the first goal RPC and survives its outage", async t => {
  const f = await fixture(t);
  f.gate.rpc = async (method, params) => {
    assert.equal(method, "thread/goal/get");
    assert.equal(params.threadId, threadId);
    assert.deepEqual(await f.journal.load(threadId), snapshot);
    throw new Error("goal RPC offline");
  };
  await assert.rejects(f.gate.reopen(threadId), /goal RPC offline/);
  assert.deepEqual(await f.journal.load(threadId), snapshot);
  assert.equal(f.dialog(), undefined);
  assert.deepEqual(f.decisions, []);
  assert.deepEqual(f.continuations, []);
});

for (const entryPoint of ["beforeTurn", "observe"]) test(`disabled native presentation still blocks ${entryPoint} after durable parking`, async t => {
  const f = await fixture(t);
  f.service.presentationEnabled = false;
  f.service.read = async () => { assert.fail("disabled presentation must not read or infer a decision"); };
  f.service.resolve = async () => { assert.fail("disabled presentation must not decide"); };
  const gate = f.makeGate();
  await assert.rejects(entryPoint === "beforeTurn"
    ? gate.beforeTurn(threadId)
    : gate.observe(threadId, snapshot, "turn1"), /presentation is disabled.*remains parked/);
  assert.deepEqual(await f.journal.load(threadId), snapshot);
  assert.equal(f.goal().status, "paused");
  assert.equal(f.dialog(), undefined);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.decisions, []);
  assert.deepEqual(f.continuations, []);
  assert.equal(f.events.includes("clear"), false);
  assert.equal(f.events.includes("turn/interrupt"), entryPoint === "observe");
  assert.equal(f.events[0], "checkpoint");
  assert(f.events.indexOf("thread/goal/set") < f.events.indexOf("human_approval_parked"));
});

for (const stage of ["checkpoint", "thread/goal/get", "thread/goal/set", "thread/read"]) {
  test(`user activity during ${stage} still completes goal pause and turn interruption`, async t => {
    const f = await fixture(t);
    const release = deferred();
    let reached = false;
    if (stage === "checkpoint") {
      const save = f.service.park;
      f.service.park = async (...args) => {
        await save(...args);
        reached = true;
        await release.promise;
      };
    } else {
      const rpc = f.gate.rpc;
      f.gate.rpc = async (method, params) => {
        const result = await rpc(method, params);
        if (method === stage) {
          reached = true;
          await release.promise;
        }
        return result;
      };
    }
    const waiting = f.gate.observe(threadId, snapshot, "turn1");
    const rejected = assert.rejects(waiting, /superseded|user activity/);
    await until(() => reached);
    assert.deepEqual(await f.journal.load(threadId), snapshot);
    f.gate.userActivity(threadId);
    release.resolve();
    await rejected;
    assert.equal(f.goal().status, "paused", "aborting the wait must not skip native goal pause");
    assert.equal(f.events.includes("turn/interrupt"), true, "aborting the wait must not skip native turn interruption");
    assert(f.events.indexOf("thread/goal/set") < f.events.indexOf("turn/interrupt"));
    assert.deepEqual(await f.journal.load(threadId), snapshot);
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.decisions, []);
    assert.deepEqual(f.continuations, []);
    assert.equal(f.events.includes("clear"), false);
  });
}

for (const entryPoint of ["beforeTurn", "reopen"]) {
  test(`owning root changed during live confirmation cannot release ${entryPoint}`, async t => {
    const f = await fixture(t);
    const live = deferred();
    let confirming = false, owns = true;
    f.service.ownsThread = async id => owns && id === threadId;
    const waiting = f.gate[entryPoint](threadId);
    const rejected = assert.rejects(waiting, /root|own|foreign/i);
    await until(() => f.dialog());
    f.service.getState = () => { confirming = true; return live.promise; };
    f.gate.handleReply({ id: f.dialog().id, result: { action: "accept" } });
    await until(() => confirming);
    owns = false;
    live.resolve(approved);
    await rejected;
    assert.equal(f.goal().status, "paused");
    assert.deepEqual(f.continuations, []);
    assert.deepEqual(await f.journal.load(threadId), snapshot);
    assert.equal(f.events.includes("clear"), false);
  });
}

for (const stage of ["before reply read", "during reply read"]) {
  test(`gate ownership loss ${stage} blocks an injected resolver`, async t => {
    const f = await fixture(t);
    let owns = true, loseOnRead = false, reads = 0, resolves = 0;
    const read = f.service.read;
    f.service.ownsThread = async id => owns && id === threadId;
    f.service.read = async (...args) => {
      reads++;
      const result = await read(...args);
      if (loseOnRead) owns = false;
      return result;
    };
    f.service.resolve = async () => { resolves++; return { ...snapshot.pending_approval, run_id: "run1", run_session_id: "session1", status: "approved" }; };
    const waiting = f.gate.reopen(threadId);
    const rejected = assert.rejects(waiting, /resolution failed.*parked/);
    await until(() => f.dialog());
    const priorReads = reads;
    if (stage === "before reply read") owns = false;
    else loseOnRead = true;
    f.gate.handleReply({ id: f.dialog().id, result: { action: "accept" } });
    await rejected;
    if (stage === "before reply read") assert.equal(reads, priorReads);
    else assert(reads > priorReads);
    assert.equal(resolves, 0, "the gate must enforce ownership even if its injected resolver does not");
    assert.equal(f.goal().status, "paused");
    assert.deepEqual(f.continuations, []);
    assert.deepEqual(await f.journal.load(threadId), snapshot);
    assert.equal(f.events.includes("clear"), false);
  });
}

for (const stage of ["thread/goal/get", "thread/goal/set", "turn/interrupt"]) {
  test(`successor cannot release before predecessor delayed ${stage} finishes safety parking`, async t => {
    const f = await fixture(t);
    const release = deferred();
    let held = false;
    const rpc = f.gate.rpc;
    f.gate.rpc = async (method, params) => {
      if (method === stage && !held) {
        held = true;
        await release.promise;
      }
      return rpc(method, params);
    };
    const continueApproved = f.gate.continueApproved;
    const replacementGoal = { status: "active", objective: "Replacement goal", createdAt: 456 };
    f.gate.continueApproved = async value => {
      await continueApproved(value);
      f.setGoal(replacementGoal);
    };
    const predecessor = f.gate.park(threadId, snapshot, { turnId: "turn1", autoContinue: true });
    const cancelled = assert.rejects(predecessor, /superseded/);
    await until(() => held);
    f.gate.userActivity(threadId);
    const successor = f.gate.park(threadId, snapshot, { turnId: "turn1", autoContinue: true });
    // Give an incorrectly unqueued successor enough time to park and present.
    await delay(20);
    assert.equal(f.dialog(), undefined);
    assert.equal(f.events.filter(event => event === "checkpoint").length, 1);
    assert.deepEqual(f.decisions, []);
    assert.deepEqual(f.continuations, []);
    release.resolve();
    await cancelled;
    await until(() => f.dialog());
    assert.equal(f.events.filter(event => event === "checkpoint").length, 2);
    assert.equal(f.events.filter(event => event === "turn/interrupt").length, 2);
    f.gate.handleReply({ id: f.dialog().id, result: { action: "accept" } });
    await successor;
    await delay(15);
    assert.deepEqual(f.decisions, ["approved"]);
    assert.equal(f.continuations.length, 1);
    assert.deepEqual(f.goal(), replacementGoal);
    assert.equal(f.events.slice(f.events.indexOf("continue") + 1).includes("thread/goal/set"), false);
    assert.equal(await f.journal.load(threadId), null);
  });
}

for (const cause of ["disconnect", "new input"]) {
  for (const phase of ["read", "resolve"]) {
    test(`${cause} during gate ${phase} ownership check blocks the injected backend`, async t => {
      const f = await fixture(t);
      const release = deferred();
      let blockOwner = false, armResolve = false, entered = 0, completed = 0, resolves = 0;
      const read = f.service.read;
      const readSignals = [];
      f.service.ownsThread = async id => {
        if (blockOwner) {
          entered++;
          await release.promise;
          completed++;
        }
        return id === threadId;
      };
      f.service.read = async (value, options) => {
        readSignals.push(options?.signal);
        const result = await read(value, options);
        if (armResolve) blockOwner = true;
        return result;
      };
      f.service.resolve = async () => { resolves++; assert.fail("aborted ownership check must not reach injected resolve"); };
      const waiting = f.gate.reopen(threadId);
      const cancelled = assert.rejects(waiting, /closed|superseded/);
      await until(() => f.dialog());
      const originalSignal = f.gate.pending.get(threadId).abort.signal;
      assert.equal(readSignals[0], originalSignal);
      const priorReads = readSignals.length;
      if (phase === "read") blockOwner = true;
      else armResolve = true;
      f.gate.handleReply({ id: f.dialog().id, result: { action: "accept" } });
      await until(() => entered > 0);
      if (cause === "disconnect") f.gate.close();
      else f.gate.userActivity(threadId);
      assert.equal(originalSignal.aborted, true);
      release.resolve();
      await cancelled;
      await until(() => completed === entered);
      await delay(0);
      if (phase === "read") assert.equal(readSignals.length, priorReads);
      else assert(readSignals.length > priorReads);
      assert(readSignals.every(signal => signal === originalSignal));
      assert.equal(resolves, 0);
      assert.equal(f.goal().status, "paused");
      assert.deepEqual(f.continuations, []);
      assert.deepEqual(await f.journal.load(threadId), snapshot);
      assert.equal(f.events.includes("clear"), false);
    });
  }
}
