import test from "node:test";
import assert from "node:assert/strict";
import {HandoffPresentation} from "../lib/app-server-handoff.mjs";

const start = (id = "next", threadId = "t1") => ({method: "turn/started", params: {threadId, turn: {id, status: "inProgress", items: []}}});
const end = (status = "interrupted", id = "next") => ({method: "turn/completed", params: {threadId: "t1", turn: {id, status, error: null, items: []}}});
const details = {runId: "run1", state: "intake", model: "gpt-6-astra", effort: "high"};
const advisory = (from = "previous", to = "gpt-6-astra", threadId = "t1") => ({method: "warning", params: {threadId,
  message: `This session was recorded with model \`${from}\` but is resuming with \`${to}\`. Consider switching back to \`${from}\` as it may affect Codex performance.`}});
function fixture(options = {}) {
  const events = [];
  const p = new HandoffPresentation({onStatus: event => events.push(event), ...options});
  const receive = message => {p.observe(message); return p.present(message);};
  p.prepare("t1", "request1", details);
  return {p, receive, events};
}

for (const order of ["response-first", "notification-first"]) test(`correlated status: ${order}`, () => {
  const {p, receive, events} = fixture();
  const raw = start(), original = structuredClone(raw);
  let statuses;
  if (order === "response-first") {
    assert.deepEqual(p.accept("t1", "request1", "next"), []);
    const visible = receive(raw);
    assert.deepEqual(visible[0], raw);
    statuses = visible.slice(1);
  } else {
    assert.deepEqual(receive(raw), [raw]);
    statuses = p.accept("t1", "request1", "next");
  }
  assert.deepEqual(raw, original);
  assert.equal(statuses.length, 2);
  assert.match(statuses[1].params.item.text, /^Statewright supervisor: intake · gpt-6-astra \/ high · running$/);
  assert(Number.isSafeInteger(statuses[0].params.startedAtMs));
  assert(Number.isSafeInteger(statuses[1].params.completedAtMs));
  assert.equal(events[0].schema, "statewright/app-server-handoff/v1");
  assert.equal(events[0].run_id, "run1");
  assert.equal(events[0].turn_id, "next");
  assert.deepEqual(p.accept("t1", "request1", "next"), [], "no duplicate status");
});

for (const status of ["interrupted", "failed", "completed"]) test(`${status} lifecycle is always preserved`, () => {
  const {p, receive} = fixture();
  receive(start());
  const terminal = end(status), original = structuredClone(terminal);
  assert.deepEqual(receive(terminal), [terminal]);
  assert.deepEqual(terminal, original);
  assert.deepEqual(p.accept("t1", "request1", "next"), [], "no running status after terminal");
});

test("no status for another writer or stale request", () => {
  const {p, receive, events} = fixture();
  assert.deepEqual(receive(start("foreign")), [start("foreign")]);
  assert.deepEqual(p.accept("t1", "other-request", "foreign"), []);
  assert.deepEqual(p.accept("other-thread", "request1", "foreign"), []);
  assert.deepEqual(p.accept("t1", "request1", "next"), []);
  assert.deepEqual(receive(start("another-writer")), [start("another-writer")]);
  assert.deepEqual(receive(start()), [start()], "superseded scope never decorates a late start");
  assert.equal(events.length, 0);
});

test("operator activity cancels attribution without changing lifecycle", () => {
  const {p, receive} = fixture();
  p.accept("t1", "request1", "next");
  assert.deepEqual(p.userActivity("t1"), []);
  assert.deepEqual(receive(start()), [start()]);
  assert.deepEqual(receive(end()), [end()]);
});

test("late failure from an older request cannot cancel the current route", () => {
  const {p, receive, events} = fixture();
  p.prepare("t1", "request2", {...details, state: "validate"});
  p.cancel("t1", "request1");
  p.accept("t1", "request2", "next");
  assert.equal(receive(start()).length, 3);
  assert.equal(events[0].state, "validate");
});

test("late acceptance reports structured status without splicing an active native stream", () => {
  const {p, receive, events} = fixture();
  receive(start());
  const delta = {method: "item/agentMessage/delta", params: {threadId: "t1", turnId: "next", itemId: "answer", delta: "partial answer"}};
  assert.deepEqual(receive(delta), [delta]);
  assert.deepEqual(p.accept("t1", "request1", "next"), []);
  assert.equal(events.length, 1);
  assert.equal(events[0].state, "intake");
});

test("input, tool failures and unrelated errors remain byte-structurally unchanged", () => {
  const {receive} = fixture();
  for (const raw of [
    {method: "turn/completed", params: {threadId: "t1"}},
    {method: "item/completed", params: {threadId: "t1", turnId: "next", item: {id: "input", type: "userMessage", content: [{type: "text", text: "continue"}]}}},
    {method: "item/completed", params: {threadId: "t1", turnId: "next", item: {id: "tool", type: "mcpToolCall", status: "failed"}}},
    {method: "error", params: {threadId: "t1", turnId: "next", error: {message: "failed"}}},
  ]) assert.deepEqual(receive(raw), [raw]);
});

test("verified switch suppresses only exact expected advisory", () => {
  const {p, receive} = fixture();
  p.beginSwitch("t1", "previous", "gpt-6-astra");
  assert.deepEqual(receive(advisory()), []);
  for (const other of [advisory("other"), advisory(undefined, undefined, "t2"),
    {method: "warning", params: {threadId: "t1", message: "Authentication failed"}}]) assert.deepEqual(receive(other), [other]);
  assert.deepEqual(p.finishSwitch("t1", true), []);
  assert.deepEqual(receive(advisory()), [advisory()], "no lingering filter");
});

for (const reason of ["failure", "cancel", "replaced"]) test(`switch ${reason} replays advisory`, () => {
  const {p, receive} = fixture();
  p.beginSwitch("t1", "previous", "gpt-6-astra");
  receive(advisory());
  if (reason === "cancel") p.cancel("t1");
  if (reason === "replaced") p.prepare("t1", "request2", details);
  assert.deepEqual(p.finishSwitch("t1", reason !== "failure"), [advisory()]);
  assert.deepEqual(p.finishSwitch("t1", false), []);
});

test("status sink failure cannot interrupt protocol delivery", () => {
  const {p, receive} = fixture({onStatus: () => {throw new Error("unavailable");}});
  p.accept("t1", "request1", "next");
  assert.equal(receive(start()).length, 3);
});
