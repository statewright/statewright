import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { approvalJournal } from "../../executor/lib/approval-journal.mjs";
import { assertPiNativeSession } from "../../executor/lib/host-adapters.mjs";
import { ownedProcessDriver } from "./fixtures/owned-process-driver.mjs";

const schema = "statewright/pi-executor-process-fixture/v1";
const base = { run_id: "run", run_session_id: "session", workflow: "fixture", state: "review", model: "synthetic/model" };
const ticket = { approval_id: "approval", event: "ACCEPT", from_state: "review", to_state: "work" };
const checkpoint = { run_id: base.run_id, run_session_id: base.run_session_id, state: base.state, pending_approval: ticket };
const environmentKeys = process.platform === "darwin" ? ["PATH", "__CF_USER_TEXT_ENCODING"] : ["PATH"];
const hash = value => createHash("sha256").update(value).digest("hex");

async function denied(bridge, action, body, expected) {
  const response = await fetch(bridge.url + "/hooks/request/" + action, { method: "POST",
    headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(3_000) });
  assert.equal(response.ok, false);
  assert.match((await response.json()).error, expected);
}

async function fixture(t) {
  const cleanup = [];
  t.after(async () => {
    const errors = [];
    while (cleanup.length) { try { await cleanup.pop()(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "Parent failure fixture cleanup failed");
  });
  const root = await mkdtemp(join(tmpdir(), "pi-parent-failure-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const authority = { live: { ...base, pending_approval: ticket }, decision: "pending" };
  const requests = [];
  const unexpected = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/state" || request.url === "/receipt") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(request.url === "/state" ? authority.live : {
        run_id: base.run_id, run_session_id: base.run_session_id, approval_id: ticket.approval_id, status: authority.decision }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      unexpected.push({ method: request.method, url: request.url });
      response.writeHead(404); response.end(); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const chunk = (delta, finish_reason) => JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", model: "synthetic-chat",
      choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${chunk({ role: "assistant", content: "synthetic response" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const authorityUrl = `http://127.0.0.1:${server.address().port}`;
  async function launch(options = {}, { expectReady = true } = {}) {
    const child = fork(new URL("./fixtures/owned-executor-process.mjs", import.meta.url), [], {
      cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const control = ownedProcessDriver(child, { schema, timeoutMs: 20_000 });
    cleanup.push(async () => {
      if (control.exited) return;
      try { await control.close(); }
      finally { if (!control.exited) await control.terminate(); }
    });
    control.send("initialize", { options: { ...options, root, authorityUrl, providerUrl: authorityUrl + "/v1" } });
    if (expectReady) {
      control.ready = await control.wait("ready");
      assert.deepEqual(control.ready.environmentKeys, environmentKeys);
      assert.deepEqual(control.ready.sdkEnvironmentKeys, environmentKeys);
      assert.equal(JSON.parse(await readFile(control.ready.ownerPath + ".lock", "utf8")).pid, child.pid);
      assert.equal(hash(await readFile(control.ready.owner.host_session_file)), control.ready.nativeBeforeHash,
        "SDK startup cannot append native history");
    }
    return control;
  }
  const snapshot = async control => { control.send("snapshot"); return control.wait("snapshot"); };
  const journal = control => approvalJournal(join(root, "approvals"), control.ready.journalClientId);
  return { root, authority, requests, unexpected, launch, snapshot, journal };
}

test("forced SDK and parent exits preserve pending gate and deny dead-owner resume",
  { timeout: 60_000, skip: process.platform === "win32" ? "POSIX forced-signal exit evidence only" : false }, async t => {
    const f = await fixture(t);
    const first = await f.launch();
    const saved = first.ready.owner;
    const before = await readFile(saved.host_session_file);
    first.send("prompt", { text: "pending crash task" });
    await first.wait("sdk-parked");
    const parked = await f.snapshot(first);
    assert.equal(parked.owner.request.phase, "parked");
    assert.equal(parked.owner.request_epoch, 1);
    assert.deepEqual(parked.checkpoint, checkpoint);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await readFile(saved.host_session_file), before);
    first.send("reap-sdk");
    const reaped = await first.wait("sdk-reaped");
    assert.equal(reaped.sdkPid, first.ready.sdkPid);
    assert.equal(reaped.sdkExit.code, null);
    assert.ok(["SIGTERM", "SIGKILL"].includes(reaped.sdkExit.signal));
    assert.deepEqual({ code: reaped.result.code, signal: reaped.result.signal }, reaped.sdkExit);
    assert.equal(reaped.owner.request.phase, "cancelled");
    assert.equal(reaped.owner.request.reason, "disconnected");
    const ownerBytes = await readFile(first.ready.ownerPath);
    assert.deepEqual(JSON.parse(ownerBytes), reaped.owner);
    const lockBytes = await readFile(first.ready.ownerPath + ".lock");
    const files = (await readdir(dirname(first.ready.ownerPath))).sort();
    assert.deepEqual(await f.journal(first).load("fixture"), checkpoint);
    assert.deepEqual(await readFile(saved.host_session_file), before);
    assert.equal(first.child.kill("SIGKILL"), true); // Exact owned parent, SDK already reaped.
    assert.deepEqual(await first.awaitExit(5_000), { code: null, signal: "SIGKILL" });
    assert.equal(first.exited, true);
    assert.deepEqual(await readFile(first.ready.ownerPath), ownerBytes);
    assert.deepEqual(await readFile(first.ready.ownerPath + ".lock"), lockBytes);
    const rejected = await f.launch({ resumeSessionId: saved.executor_session_id }, { expectReady: false });
    await assert.rejects(rejected.wait("ready"), /already owned; dead-owner recovery requires native-writer verification/);
    assert.deepEqual(await rejected.awaitExit(5_000), { code: 1, signal: null });
    assert.deepEqual(await readFile(first.ready.ownerPath), ownerBytes);
    assert.deepEqual(await readFile(first.ready.ownerPath + ".lock"), lockBytes);
    assert.deepEqual((await readdir(dirname(first.ready.ownerPath))).sort(), files);
    assert.deepEqual(await f.journal(first).load("fixture"), checkpoint);
    assert.deepEqual(await readFile(saved.host_session_file), before);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.unexpected, []);
  });

test("lost consume HTTP response holds inference and tombstone until fresh explicit SDK input",
  { timeout: 60_000 }, async t => {
    const f = await fixture(t);
    const first = await f.launch({ dropConsumeResponse: true });
    const saved = first.ready.owner;
    const before = await readFile(saved.host_session_file);
    first.send("prompt", { text: "old ambiguous delivery task" });
    await first.wait("sdk-parked");
    const pending = await f.snapshot(first);
    assert.equal(pending.owner.request.phase, "parked");
    assert.deepEqual(pending.checkpoint, checkpoint);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await readFile(saved.host_session_file), before);
    f.authority.decision = "approved"; f.authority.live = { ...base, state: "work" }; // External synthetic decision.
    const dropped = await first.wait("consume-dropped");
    assert.equal((await first.wait("sdk-prompt-settled")).finalResponse, null);
    const ambiguous = await f.snapshot(first);
    assert.equal(ambiguous.owner.request_epoch, 1);
    assert.equal(ambiguous.owner.request.phase, "cancelled");
    assert.equal(ambiguous.owner.request.reason, "disconnected");
    assert.equal(ambiguous.owner.request.release_nonce, null);
    assert.deepEqual(ambiguous.owner.request.consumed_approval_ids, [ticket.approval_id]);
    assert.deepEqual(ambiguous.successfulConsumes, [dropped.consumeBody]);
    assert.equal(ambiguous.checkpoint, null);
    assert.equal(await f.journal(first).load("fixture"), null);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await readFile(saved.host_session_file), before);
    await denied(first.ready.bridge, "consume", dropped.consumeBody, /replaced/);
    await denied(first.ready.bridge, "status", { reference: dropped.consumeBody.reference }, /replaced/);
    await denied(first.ready.bridge, "cancel", { reference: dropped.consumeBody.reference, reason: "cancelled" }, /replaced/);
    assert.deepEqual((await f.snapshot(first)).owner, ambiguous.owner);
    first.send("prompt", { text: "fresh explicit delivery task" });
    assert.deepEqual((await first.wait("sdk-prompt-settled")).finalResponse.content, [{ type: "text", text: "synthetic response" }]);
    const fresh = await f.snapshot(first);
    assert.equal(fresh.owner.request_epoch, 2);
    assert.notEqual(fresh.owner.request.request_id, ambiguous.owner.request.request_id);
    assert.deepEqual(fresh.owner.request.consumed_approval_ids, [ticket.approval_id]);
    assert.deepEqual(fresh.successfulConsumes, [dropped.consumeBody]);
    assert.equal(f.requests.length, 1);
    await denied(first.ready.bridge, "consume", dropped.consumeBody, /replaced/);
    await assertPiNativeSession({ sessionFile: saved.host_session_file, sessionId: saved.host_session_id, cwd: f.root });
    const after = await readFile(saved.host_session_file);
    const messages = after.toString("utf8").trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type === "message");
    assert.deepEqual(messages.map(entry => entry.message.role), ["user", "assistant"]);
    assert.deepEqual(messages[0].message.content, [{ type: "text", text: "fresh explicit delivery task" }]);
    const closing = first.wait("closed"); closing.catch(() => {});
    assert.deepEqual(await first.close(), { code: 0, signal: null });
    const oldClosed = await closing;
    assert.deepEqual({ code: oldClosed.sdkResult.code, signal: oldClosed.sdkResult.signal }, { code: 0, signal: null });
    await assert.rejects(access(first.ready.ownerPath + ".lock"), { code: "ENOENT" });
    const second = await f.launch({ resumeSessionId: saved.executor_session_id });
    assert.notEqual(second.child.pid, first.child.pid);
    assert.notEqual(second.ready.sdkPid, first.ready.sdkPid);
    assert.notEqual(second.ready.challenge.parent_lifetime_id, first.ready.challenge.parent_lifetime_id);
    assert.notEqual(second.ready.challenge.child_lifetime_id, first.ready.challenge.child_lifetime_id);
    assert.deepEqual(second.ready.owner, oldClosed.owner);
    assert.equal(second.ready.journalClientId, first.ready.journalClientId);
    assert.deepEqual(second.ready.owner.request.consumed_approval_ids, [ticket.approval_id]);
    assert.deepEqual(await readFile(saved.host_session_file), after);
    assert.equal(await f.journal(second).load("fixture"), null);
    await denied(second.ready.bridge, "consume", dropped.consumeBody, /replaced/);
    await denied(second.ready.bridge, "status", { reference: dropped.consumeBody.reference }, /replaced/);
    assert.equal(f.requests.length, 1, "cold reopen cannot redeliver the lost continuation");
    assert.deepEqual(await second.close(), { code: 0, signal: null });
    await assert.rejects(access(second.ready.ownerPath + ".lock"), { code: "ENOENT" });
    assert.deepEqual(await readFile(saved.host_session_file), after);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.unexpected, []);
  });
