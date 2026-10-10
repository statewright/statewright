import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopThreadDispatcher } from "../lib/desktop-thread-dispatcher.mjs";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { bindings = new Map(), autoInitialize = () => true, sendInitialized = true, ...options } = {}) {
  const opened = [];
  const output = [];
  const reads = [];
  const saved = [];
  const dispatcher = createDesktopThreadDispatcher({
    openLane: async ({ key, threadId, discovery, emit, onClose }) => {
      const lane = { key, threadId, discovery, emit, onClose, sent: [], closeCount: 0 };
      opened.push(lane);
      return {
        send(message) {
          lane.sent.push(message);
          if (message.method === "initialize" && autoInitialize(lane)) {
            emit({ id: message.id, result: { initialized: true } });
          }
        },
        close() { lane.closeCount++; },
      };
    },
    readBinding: async id => { reads.push(id); return bindings.get(id); },
    saveBinding: async (id, key) => { saved.push([id, key]); bindings.set(id, key); },
    emit: message => output.push(message),
    initializeTimeoutMs: 100,
    ...options,
  });
  t.after(() => dispatcher.close());
  await dispatcher.handle({ id: "initialize", method: "initialize", params: { clientInfo: { name: "fixture" } } });
  if (sendInitialized) await dispatcher.handle({ method: "initialized" });
  await settle();
  output.length = 0;
  return {
    dispatcher, opened, output, reads, saved, bindings,
    laneFor: id => opened.findLast(lane => lane.threadId === id),
    async resume(id, requestId, cwd = "/fixture/project-a") {
      await dispatcher.handle({ id: requestId, method: "thread/resume", params: { threadId: id, cwd } });
      const lane = opened.findLast(item => item.threadId === id);
      assert.ok(lane, "resume opened its native lane");
      lane.emit({ id: requestId, result: { thread: { id } } });
      await settle();
      return lane;
    },
  };
}

test("Desktop can resume after native initialize succeeds without sending initialized", async t => {
  const f = await fixture(t, { sendInitialized: false });
  await f.resume(FIRST, "desktop-resume");
  assert.equal(f.output.at(-1).result.thread.id, FIRST);
  assert.equal(f.opened[0].sent.filter(message => message.method === "initialized").length, 1);
  await f.dispatcher.handle({ method: "initialized" });
  await f.dispatcher.handle({ method: "initialized" });
  assert.equal(f.opened[0].sent.filter(message => message.method === "initialized").length, 1);
});

for (const [label, response] of [
  ["pending", null],
  ["failed", { error: { code: -32000, message: "Native initialize failed" } }],
  ["malformed", {}],
]) {
  test(`client initialized notification cannot unlock ${label} native initialization`, async t => {
    const f = await fixture(t, { autoInitialize: () => false });
    if (response) { f.opened[0].emit({ id: "initialize", ...response }); await settle(); }
    await f.dispatcher.handle({ method: "initialized" });
    await f.dispatcher.handle({ id: "early-resume", method: "thread/resume", params: { threadId: FIRST } });
    assert.match(f.output.at(-1).error.message, /initialization has not completed/);
    assert.equal(f.opened.length, 1);
    assert.equal(f.saved.length, 0);
    assert.equal(f.opened[0].sent.filter(message => message.method === "initialized").length, 0);
  });
}

test("historical chats from distinct projects get isolated owners and mutations", async t => {
  const f = await fixture(t);
  const first = await f.resume(FIRST, 1, "/fixture/project-a");
  const second = await f.resume(SECOND, 2, "/fixture/project-b");
  assert.equal(first.key, `thread:${FIRST}`);
  assert.equal(second.key, `thread:${SECOND}`);
  assert.notEqual(first.key, second.key);
  assert.deepEqual(f.saved, [[FIRST, first.key], [SECOND, second.key]]);
  for (const lane of [first, second]) {
    assert.equal(lane.discovery, false);
    assert.deepEqual(lane.sent.map(message => message.method), ["initialize", "initialized", "thread/resume"]);
  }
  const turn = { id: 3, method: "turn/start", params: { threadId: FIRST, input: [] } };
  await f.dispatcher.handle(turn);
  assert.deepEqual(first.sent.at(-1), turn);
  assert.equal(second.sent.some(message => message.id === 3), false);
});

test("thread reads use discovery without creating a binding or granting mutation access", async t => {
  const f = await fixture(t);
  for (const [index, method] of ["thread/read", "thread/attachment/list", "thread/goal/get"].entries()) {
    await f.dispatcher.handle({ id: index, method, params: { threadId: FIRST } });
    f.opened[0].emit({ id: index, result: {} });
  }
  await settle();
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].key, "discovery");
  assert.equal(f.opened[0].discovery, true);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.saved, []);
  await f.dispatcher.handle({ id: "mutation", method: "turn/start", params: { threadId: FIRST } });
  assert.match(f.output.at(-1).error.message, /Resume this chat/);
  assert.equal(f.opened[0].sent.some(message => message.id === "mutation"), false);
});

for (const [label, reply] of [
  ["wrong thread ID", { result: { thread: { id: SECOND } } }],
  ["malformed thread ID", { result: { thread: { id: "not-a-thread" } } }],
  ["native error", { error: { code: -32000, message: "Resume failed" } }],
]) {
  test(`resume ${label} does not persist or attach a thread`, async t => {
    const f = await fixture(t);
    await f.dispatcher.handle({ id: 10, method: "thread/resume", params: { threadId: FIRST } });
    const lane = f.laneFor(FIRST);
    lane.emit({ id: 10, ...reply });
    await settle();
    assert.deepEqual(f.saved, []);
    assert.equal(f.bindings.size, 0);
    assert.equal(f.output.filter(message => message.id === 10).length, 1);
    assert.ok(f.output.find(message => message.id === 10).error);
    assert.equal(lane.closeCount, 1);
    await f.dispatcher.handle({ id: 11, method: "turn/start", params: { threadId: FIRST } });
    assert.match(f.output.at(-1).error.message, /Resume this chat/);
  });
}

test("a newly started thread keeps its provisional owner across dispatcher restart", async t => {
  const bindings = new Map();
  const first = await fixture(t, { bindings });
  await first.dispatcher.handle({ id: 1, method: "thread/start", params: { cwd: "/fixture/project-a" } });
  const lane = first.opened.at(-1);
  assert.match(lane.key, /^new:[a-f0-9-]{36}$/);
  assert.deepEqual(first.saved, []);
  lane.emit({ id: 1, result: { thread: { id: FIRST } } });
  await settle();
  assert.equal(bindings.get(FIRST), lane.key);
  await first.dispatcher.close();
  const restarted = await fixture(t, { bindings });
  const resumed = await restarted.resume(FIRST, 2);
  assert.equal(resumed.key, lane.key);
  assert.deepEqual(restarted.reads, [FIRST]);
  assert.deepEqual(restarted.saved, [[FIRST, lane.key]]);
});

test("colliding server request IDs are rewritten and each reply restores its exact ID type", async t => {
  const f = await fixture(t);
  const first = await f.resume(FIRST, 1);
  const second = await f.resume(SECOND, 2);
  f.output.length = 0;
  const expected = [];
  for (const lane of [first, second]) for (const id of [42, "42"]) {
    lane.emit({ id, method: "item/commandExecution/requestApproval", params: { owner: lane.key, idType: typeof id } });
    expected.push({ lane, id });
    await settle();
  }
  const forwarded = [...f.output];
  assert.equal(new Set(forwarded.map(message => message.id)).size, 4);
  for (const [index, message] of forwarded.entries()) {
    assert.equal(typeof message.id, "string");
    assert.notEqual(message.id, expected[index].id);
  }
  for (let index = forwarded.length - 1; index >= 0; index--) {
    const reply = { id: forwarded[index].id, result: { decision: `answer-${index}` } };
    await f.dispatcher.handle(reply);
    assert.deepEqual(expected[index].lane.sent.at(-1), { ...reply, id: expected[index].id });
  }
  for (const lane of [first, second]) {
    assert.equal(lane.sent.filter(message => !message.method).length, 2);
  }
});

test("foreign native responses cannot complete another lane's pending request", async t => {
  const f = await fixture(t);
  const first = await f.resume(FIRST, 1);
  const second = await f.resume(SECOND, 2);
  await f.dispatcher.handle({ id: 10, method: "turn/start", params: { threadId: FIRST } });
  await f.dispatcher.handle({ id: 20, method: "turn/start", params: { threadId: SECOND } });
  f.output.length = 0;
  first.emit({ id: 20, result: { foreign: true } });
  await settle();
  assert.equal(first.closeCount, 1);
  assert.equal(second.closeCount, 0);
  assert.equal(f.output.some(message => message.id === 20), false);
  assert.equal(f.output.some(message => message.result?.foreign), false);
  assert.ok(f.output.find(message => message.id === 10).error);
  const legitimate = { id: 20, result: { turn: { id: "second-turn" } } };
  second.emit(legitimate);
  await settle();
  assert.deepEqual(f.output.at(-1), legitimate);
});

test("unmatched or replayed Desktop approval replies never leak to any lane", async t => {
  const f = await fixture(t);
  const lane = await f.resume(FIRST, 1);
  const before = lane.sent.length;
  await f.dispatcher.handle({ id: "foreign-approval", result: { decision: "accept" } });
  assert.equal(lane.sent.length, before);
  lane.emit({ id: 7, method: "approval", params: {} });
  await settle();
  const reply = { id: f.output.at(-1).id, result: { decision: "decline" } };
  await f.dispatcher.handle(reply);
  await f.dispatcher.handle(reply);
  assert.equal(lane.sent.length, before + 1);
  assert.deepEqual(lane.sent.at(-1), { ...reply, id: 7 });
});

test("a failed native attachment leaves an unrelated lane usable", async t => {
  const f = await fixture(t);
  const healthy = await f.resume(FIRST, 1);
  await f.dispatcher.handle({ id: 2, method: "thread/resume", params: { threadId: SECOND } });
  const failed = f.laneFor(SECOND);
  failed.emit({ id: 2, error: { code: -32000, message: "Missing historical thread" } });
  await settle();
  await f.dispatcher.handle({ id: 3, method: "turn/start", params: { threadId: FIRST } });
  healthy.emit({ id: 3, result: { turn: { id: "still-works" } } });
  await settle();
  assert.equal(failed.closeCount, 1);
  assert.equal(healthy.closeCount, 0);
  assert.equal(f.output.at(-1).result.turn.id, "still-works");
  assert.deepEqual(f.saved, [[FIRST, healthy.key]]);
});

test("binding persistence failure does not attach the thread or break another lane", async t => {
  const f = await fixture(t, { saveBinding: async id => {
    if (id === SECOND) throw new Error("Fixture storage unavailable");
  } });
  const healthy = await f.resume(FIRST, 1);
  await f.dispatcher.handle({ id: 2, method: "thread/resume", params: { threadId: SECOND } });
  const failed = f.laneFor(SECOND);
  failed.emit({ id: 2, result: { thread: { id: SECOND } } });
  await settle();
  assert.ok(f.output.find(message => message.id === 2).error);
  assert.equal(failed.closeCount, 1);
  await f.dispatcher.handle({ id: 3, method: "turn/start", params: { threadId: SECOND } });
  assert.match(f.output.at(-1).error.message, /Resume this chat/);
  await f.dispatcher.handle({ id: 4, method: "turn/start", params: { threadId: FIRST } });
  assert.equal(healthy.sent.at(-1).id, 4);
  assert.equal(healthy.closeCount, 0);
});

test("lane cap rejects extra chats and disconnected lanes release their slot", async t => {
  const f = await fixture(t, { maxLanes: 2 });
  const first = await f.resume(FIRST, 1);
  await f.dispatcher.handle({ id: 2, method: "thread/resume", params: { threadId: SECOND } });
  assert.match(f.output.at(-1).error.message, /lane limit reached/);
  assert.equal(f.opened.length, 2);
  assert.equal(first.closeCount, 0);
  first.onClose();
  await settle();
  assert.equal(first.closeCount, 1);
  await f.dispatcher.handle({ id: 3, method: "turn/start", params: { threadId: FIRST } });
  assert.match(f.output.at(-1).error.message, /Resume this chat/);
  const second = await f.resume(SECOND, 4);
  assert.equal(second.key, `thread:${SECOND}`);
  assert.equal(second.closeCount, 0);
});

test("close clears pending requests and approvals, closes once, and ignores late output", async t => {
  const f = await fixture(t);
  const first = await f.resume(FIRST, 1);
  const second = await f.resume(SECOND, 2);
  await f.dispatcher.handle({ id: 10, method: "turn/start", params: { threadId: FIRST } });
  await f.dispatcher.handle({ id: 20, method: "turn/start", params: { threadId: SECOND } });
  first.emit({ id: 7, method: "approval", params: {} });
  await settle();
  const approvalId = f.output.at(-1).id;
  f.output.length = 0;
  await f.dispatcher.close();
  await f.dispatcher.close();
  assert.deepEqual(f.output.map(message => message.id).sort((a, b) => a - b), [10, 20]);
  for (const message of f.output) assert.match(message.error.message, /closed/);
  for (const lane of f.opened) assert.equal(lane.closeCount, 1);
  const sentCounts = f.opened.map(lane => lane.sent.length);
  const outputCount = f.output.length;
  first.emit({ id: 10, result: { late: true } });
  second.emit({ method: "turn/completed", params: { threadId: SECOND } });
  first.onClose();
  await f.dispatcher.handle({ id: approvalId, result: { decision: "accept" } });
  await settle();
  assert.equal(f.output.length, outputCount);
  assert.deepEqual(f.opened.map(lane => lane.sent.length), sentCounts);
  await f.dispatcher.handle({ id: 30, method: "thread/resume", params: { threadId: THIRD } });
  assert.match(f.output.at(-1).error.message, /closing/);
  assert.equal(f.opened.length, 3);
});

test("close suppresses a native attachment response whose binding write finishes later", async t => {
  let entered;
  let release;
  const writing = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { saveBinding: async () => { entered(); await blocked; } });
  t.after(() => release());
  await f.dispatcher.handle({ id: 1, method: "thread/resume", params: { threadId: FIRST } });
  const lane = f.laneFor(FIRST);
  lane.emit({ id: 1, result: { thread: { id: FIRST } } });
  await writing;
  const closing = f.dispatcher.close();
  release();
  await closing;
  await settle();
  assert.equal(lane.closeCount, 1);
  assert.equal(f.output.some(message => message.id === 1 && message.result), false);
});

test("pending new-lane initialization does not block approvals, discovery, or an attached thread", async t => {
  const f = await fixture(t, {
    autoInitialize: lane => !lane.key.startsWith("new:"),
    initializeTimeoutMs: 1000,
  });
  const healthy = await f.resume(FIRST, 1);
  healthy.emit({ id: 7, method: "approval", params: {} });
  await settle();
  const approvalId = f.output.at(-1).id;
  const starting = f.dispatcher.handle({ id: 2, method: "thread/start", params: {} });
  await settle();
  const waiting = f.opened.at(-1);
  assert.match(waiting.key, /^new:/);
  const initId = waiting.sent[0].id;
  const approval = { id: approvalId, result: { decision: "accept" } };
  const read = { id: 3, method: "thread/read", params: { threadId: SECOND } };
  const turn = { id: 4, method: "turn/start", params: { threadId: FIRST } };
  const concurrent = [approval, read, turn].map(message => f.dispatcher.handle(message));
  try {
    await settle();
    assert.deepEqual(waiting.sent.map(message => message.method), ["initialize"]);
    assert.equal(waiting.closeCount, 0);
    assert.deepEqual(healthy.sent.find(message => !message.method), { ...approval, id: 7 });
    assert.deepEqual(f.opened[0].sent.at(-1), read);
    assert.deepEqual(healthy.sent.at(-1), turn);
    assert.equal(f.output.some(message => message.id === 2), false);
  } finally {
    waiting.emit({ id: initId, result: { initialized: true } });
    await Promise.all([starting, ...concurrent]);
  }
  assert.equal(waiting.sent.at(-1).method, "thread/start");
  waiting.emit({ id: 2, result: { thread: { id: SECOND } } });
  await settle();
  assert.equal(f.bindings.get(SECOND), waiting.key);
});

test("a duplicate pending resume is rejected without damaging the first attachment", async t => {
  const f = await fixture(t);
  await Promise.all([
    f.dispatcher.handle({ id: 1, method: "thread/resume", params: { threadId: FIRST } }),
    f.dispatcher.handle({ id: 2, method: "thread/resume", params: { threadId: FIRST } }),
  ]);
  const lane = f.laneFor(FIRST);
  assert.equal(f.opened.filter(item => item.threadId === FIRST).length, 1);
  assert.deepEqual(lane.sent.filter(message => message.method === "thread/resume").map(message => message.id), [1]);
  assert.match(f.output.find(message => message.id === 2).error.message, /resume.*already pending/i);
  assert.equal(lane.closeCount, 0);
  lane.emit({ id: 1, result: { thread: { id: FIRST } } });
  await settle();
  assert.equal(f.output.find(message => message.id === 1).result.thread.id, FIRST);
  assert.deepEqual(f.saved, [[FIRST, lane.key]]);
  const turn = { id: 3, method: "turn/start", params: { threadId: FIRST } };
  await f.dispatcher.handle(turn);
  assert.deepEqual(lane.sent.at(-1), turn);
  lane.emit({ id: 3, result: { turn: { id: "after-duplicate" } } });
  await settle();
  assert.equal(f.output.at(-1).result.turn.id, "after-duplicate");
});

test("profile config writes fail explicitly without forwarding while per-thread settings work", async t => {
  const f = await fixture(t);
  const lane = await f.resume(FIRST, 1);
  const counts = f.opened.map(item => item.sent.length);
  let id = 10;
  for (const method of ["config/value/write", "config/batchWrite"]) {
    for (const params of [{}, { threadId: FIRST }]) {
      await f.dispatcher.handle({ id: id++, method, params });
      const response = f.output.at(-1);
      assert.equal(response.id, id - 1);
      assert.match(response.error.message, /Profile-wide settings writes are not supported/);
    }
  }
  assert.equal(f.opened.length, 2);
  assert.deepEqual(f.opened.map(item => item.sent.length), counts);
  const settings = { id: 20, method: "thread/settings/update", params: { threadId: FIRST, model: "fixture-model" } };
  await f.dispatcher.handle(settings);
  assert.deepEqual(lane.sent.at(-1), settings);
  assert.equal(f.opened[0].sent.length, counts[0]);
  lane.emit({ id: 20, result: { updated: true } });
  await settle();
  assert.deepEqual(f.output.at(-1), { id: 20, result: { updated: true } });
});

test("fork rejects explicitly without forwarding or creating a new thread lane", async t => {
  const f = await fixture(t);
  await f.resume(FIRST, 1);
  const counts = f.opened.map(lane => lane.sent.length);
  await f.dispatcher.handle({ id: 2, method: "thread/fork", params: { threadId: FIRST } });
  assert.equal(f.output.at(-1).id, 2);
  assert.match(f.output.at(-1).error.message, /Forking.*not supported/);
  assert.equal(f.opened.length, 2);
  assert.deepEqual(f.opened.map(lane => lane.sent.length), counts);
  assert.equal(f.saved.length, 1);
});
