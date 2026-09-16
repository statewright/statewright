import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createRuntimeApprovalService } from "../lib/runtime-approval-service.mjs";

const ticket = { approval_id: "apr_test", run_id: "run1", run_session_id: "session1", from_state: "review", to_state: "release", threadId: "thread1" };
const receipt = { ...ticket, status: "pending", can_decide: false, record_id: "record/id" };
const state = { run_id: "run1", run_session_id: "session1", state: "review", pending_approval: { approval_id: "apr_test" } };
const noWorkflow = "No active workflow. Load a workflow before requesting state.";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "runtime-approval-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  let response = { ok: true, status: 200, json: async () => structuredClone(receipt) };
  const service = createRuntimeApprovalService({ root, apiKey: "private-key", clientId: "client1",
    gatewayUrl: "https://gateway.invalid/mcp///", pbUrl: "https://reviews.invalid/", cwd: root,
    fetchImpl: async (url, init) => { calls.push({ url, ...init, body: JSON.parse(init.body) }); return response; },
    openReview: async () => {}, ...options,
  });
  return { service, calls, respond: value => { response = { ok: true, status: 200, json: async () => structuredClone(value) }; },
    response: value => { response = value; } };
}

test("private read endpoint uses exact identity whitelist and host client header", async t => {
  const f = await fixture(t);
  const result = await f.service.read({ ...ticket, client_id: "untrusted", decision: "approved", message: "ignore", arbitrary: true });
  assert.equal(result.status, "pending");
  assert.equal(result.can_decide, false);
  assert.equal(result.review_url, "https://reviews.invalid/approvals/record%2Fid");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://gateway.invalid/api/runtime-approval");
  assert.equal(f.calls[0].method, "POST");
  assert.deepEqual(f.calls[0].headers, { "Content-Type": "application/json", Authorization: "Bearer private-key", "x-statewright-client-id": "client1" });
  assert.deepEqual(f.calls[0].body, { approval_id: "apr_test", run_id: "run1", run_session_id: "session1" });
  assert(f.calls[0].signal instanceof AbortSignal);
});

for (const decision of ["approved", "rejected"]) test(`private ${decision} request has exactly the permitted fields`, async t => {
  const f = await fixture(t);
  f.respond({ ...receipt, status: decision });
  assert.equal((await f.service.resolve({ ...ticket, client_id: "foreign", extra: "ignored" }, decision)).status, decision);
  assert.equal(f.calls[0].url, "https://gateway.invalid/api/runtime-approval");
  assert.deepEqual(f.calls[0].body, { approval_id: "apr_test", run_id: "run1", run_session_id: "session1", decision });
  assert.equal(f.calls[0].headers["x-statewright-client-id"], "client1");
});

test("state lookup calls only the read-only workflow tool with exact arguments", async t => {
  const f = await fixture(t);
  f.respond({ result: { structuredContent: state } });
  assert.deepEqual(await f.service.getState("thread1"), state);
  assert.equal(f.calls[0].url, "https://gateway.invalid/mcp");
  assert.deepEqual(f.calls[0].body, { jsonrpc: "2.0", id: "statewright-approval-state", method: "tools/call", params: { name: "statewright_get_state", arguments: {} } });
  assert.deepEqual(f.calls[0].headers, { "Content-Type": "application/json", Authorization: "Bearer private-key", "x-statewright-client-id": "client1" });
});

test("only the exact no-workflow error is treated as absence", async t => {
  const f = await fixture(t);
  f.respond({ result: { isError: true, content: [{ type: "text", text: noWorkflow }] } });
  assert.equal(await f.service.getState(), null);
  for (const result of [
    { result: { isError: true, content: [{ type: "text", text: noWorkflow + " " }] } },
    { result: { isError: true, content: [{ type: "text", text: noWorkflow }, { type: "text", text: "offline" }] } },
    { result: { isError: true, content: [{ type: "image", text: noWorkflow }] } },
    { result: { isError: true, content: [{ type: "text", text: "Gateway unavailable" }] } },
    { error: { code: -32000, message: noWorkflow } },
  ]) {
    f.respond(result);
    await assert.rejects(f.service.getState(), /unavailable/);
  }
});

test("a JSON-RPC error cannot be hidden by an exact no-workflow tool result", async t => {
  const f = await fixture(t);
  f.respond({ error: { code: -32000, message: "Gateway offline" }, result: { isError: true, content: [{ type: "text", text: noWorkflow }] } });
  await assert.rejects(f.service.getState(), /unavailable/);
});

test("state text snapshots parse while missing or malformed results fail closed", async t => {
  const f = await fixture(t);
  f.respond({ result: { content: [{ type: "image" }, { type: "text", text: JSON.stringify(state) }] } });
  assert.deepEqual(await f.service.getState(), state);
  for (const value of [{}, { result: { content: [] } }, { result: { content: [{ type: "text", text: "null" }] } }, { result: { content: [{ type: "text", text: "not JSON" }] } }]) {
    f.respond(value);
    await assert.rejects(f.service.getState());
  }
});

test("HTTP and response-read outages propagate instead of returning no workflow", async t => {
  const f = await fixture(t);
  f.response({ ok: false, status: 503, json: async () => { assert.fail("must not parse failed HTTP response"); } });
  await assert.rejects(f.service.getState(), /HTTP 503/);
  await assert.rejects(f.service.read(ticket), /HTTP 503/);
  f.response({ ok: true, status: 200, json: async () => { throw new Error("read offline"); } });
  await assert.rejects(f.service.getState(), /read offline/);
  await assert.rejects(f.service.read(ticket), /read offline/);
});

test("network rejection fails closed for state and receipt reads", async t => {
  const f = await fixture(t, { fetchImpl: async () => { throw new Error("network offline"); } });
  await assert.rejects(f.service.getState(), /network offline/);
  await assert.rejects(f.service.read(ticket), /network offline/);
});

for (const [key, value] of [["approval_id", "foreign"], ["run_id", "foreign"], ["from_state", "foreign"], ["to_state", "foreign"], ["status", "unknown"]]) {
  test(`foreign or malformed receipt ${key} is refused on read and resolve`, async t => {
    const f = await fixture(t);
    f.respond({ ...receipt, [key]: value });
    await assert.rejects(f.service.read(ticket), /foreign or malformed/);
    await assert.rejects(f.service.resolve(ticket, "approved"), /foreign or malformed/);
  });
}

test("receipt without optional session remains compatible", async t => {
  const f = await fixture(t);
  const { run_session_id, ...legacy } = receipt;
  f.respond(legacy);
  assert.equal((await f.service.read(ticket)).approval_id, ticket.approval_id);
});

test("foreign receipt session is refused when supplied on read and resolve", async t => {
  const f = await fixture(t);
  f.respond({ ...receipt, run_session_id: "foreign" });
  await assert.rejects(f.service.read(ticket), /foreign or malformed/);
  await assert.rejects(f.service.resolve(ticket, "approved"), /foreign or malformed/);
});

test("missing gateway session refuses requests before network access", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.read({ ...ticket, run_session_id: undefined }), /session identity/);
  await assert.rejects(f.service.resolve({ ...ticket, run_session_id: "" }, "approved"), /session identity/);
  assert.deepEqual(f.calls, []);
});

test("checkpoint restore and clear are client/thread isolated and require the exact approval", async t => {
  const f = await fixture(t);
  await f.service.park("thread1", state);
  assert.deepEqual(await f.service.restore("thread1"), state);
  assert.equal(await f.service.restore("foreign"), null);
  await assert.rejects(f.service.clear("thread1", "foreign"), /changed/);
  assert.deepEqual(await f.service.restore("thread1"), state);
  await f.service.clear("thread1", "apr_test");
  assert.equal(await f.service.restore("thread1"), null);
  assert.deepEqual(f.calls, []);
});

test("async review opening is injected and awaited without implicit browser opening on read", async t => {
  const opened = [];
  const f = await fixture(t, { openReview: async url => { await Promise.resolve(); opened.push(url); return "opened"; } });
  const result = await f.service.read(ticket);
  assert.deepEqual(opened, []);
  const opening = f.service.openReview(result.review_url);
  assert.equal(typeof opening.then, "function");
  await opening;
  assert.deepEqual(opened, [result.review_url]);
});

test("service normalizes child-process-style review opener to the controller Promise contract", async t => {
  const opened = [];
  const f = await fixture(t, { openReview: url => { opened.push(url); return { unref() {} }; } });
  const opening = f.service.openReview("https://reviews.invalid/approvals/record");
  assert.equal(typeof opening?.then, "function", "controller requires openReview(...).catch(...)");
  await opening;
  assert.equal(opened.length, 1);
});

test("disabled presentation is explicit and does not bypass the durable journal", async t => {
  const f = await fixture(t, { presentationEnabled: false });
  assert.equal(f.service.presentationEnabled, false);
  await f.service.park("thread1", state);
  assert.deepEqual(await f.service.restore("thread1"), state);
  assert.deepEqual(f.calls, []);
});

for (const decision of ["approved", "rejected"]) test(`ownership changed before ${decision} refuses HTTP submission`, async t => {
  let owns = true;
  const checked = [];
  const f = await fixture(t, { ownsThread: async id => { checked.push(id); return owns && id === ticket.threadId; } });
  await f.service.read(ticket);
  const priorCalls = f.calls.length;
  owns = false;
  f.respond({ ...receipt, status: decision });
  await assert.rejects(f.service.resolve(ticket, decision), /root|own|foreign/i);
  assert.equal(f.calls.length, priorCalls, "lost ownership must be refused before fetch");
  assert.equal(checked.at(-1), ticket.threadId);
});

test("EventEmitter review child errors reject the normalized Promise without escaping", async t => {
  const child = new EventEmitter();
  const f = await fixture(t, { openReview: () => child });
  const opening = f.service.openReview("https://reviews.invalid/approvals/record");
  assert.equal(typeof opening?.then, "function");
  await Promise.resolve();
  assert(child.listenerCount("error") > 0, "normalization must handle a child-process error event");
  const rejected = assert.rejects(opening, /ENOENT/);
  child.emit("error", new Error("ENOENT: review opener unavailable"));
  await rejected;
});

test("EventEmitter review child opening remains pending until spawn", async t => {
  const child = new EventEmitter();
  const f = await fixture(t, { openReview: () => child });
  let settled = false;
  const opening = f.service.openReview("https://reviews.invalid/approvals/record");
  opening.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false, "returning a child is not proof that its opener spawned");
  assert(child.listenerCount("spawn") > 0);
  child.emit("spawn");
  await opening;
  assert.equal(settled, true);
});

for (const cause of ["disconnect", "new input"]) {
  for (const operation of ["read", "resolve"]) {
    test(`${cause} during service ${operation} ownership check prevents decision fetch`, async t => {
      let releaseOwner, enteredOwner;
      const ownership = new Promise(resolve => { releaseOwner = resolve; });
      const entered = new Promise(resolve => { enteredOwner = resolve; });
      const f = await fixture(t, { ownsThread: async id => {
        assert.equal(id, ticket.threadId);
        enteredOwner();
        return ownership;
      } });
      const abort = new AbortController();
      const waiting = operation === "read"
        ? f.service.read(ticket, { signal: abort.signal })
        : f.service.resolve(ticket, "approved", { signal: abort.signal });
      const cancelled = assert.rejects(waiting, new RegExp(cause));
      await entered;
      abort.abort(new Error(cause));
      releaseOwner(true);
      await cancelled;
      assert.deepEqual(f.calls, [], "an aborted wait must not POST after an awaited ownership check");
    });
  }
}

test("service composes the original wait signal with its HTTP timeout", async t => {
  const abort = new AbortController();
  let captured, enteredFetch;
  const entered = new Promise(resolve => { enteredFetch = resolve; });
  const f = await fixture(t, {
    ownsThread: async () => true,
    fetchImpl: async (_url, options) => {
      captured = options.signal;
      enteredFetch();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    },
  });
  const waiting = f.service.resolve(ticket, "approved", { signal: abort.signal });
  const cancelled = assert.rejects(waiting, /disconnect/);
  await entered;
  assert(captured instanceof AbortSignal);
  assert.notEqual(captured, abort.signal);
  assert.equal(captured.aborted, false);
  const reason = new Error("disconnect");
  abort.abort(reason);
  assert.equal(captured.aborted, true);
  assert.equal(captured.reason, reason);
  await cancelled;
});
