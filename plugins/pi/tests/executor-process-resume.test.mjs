import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { approvalJournal } from "../../executor/lib/approval-journal.mjs";
import { assertPiNativeSession } from "../../executor/lib/host-adapters.mjs";
import { ownedProcessDriver } from "./fixtures/owned-process-driver.mjs";

const schema = "statewright/pi-executor-process-fixture/v1";
const base = { run_id: "run", run_session_id: "session", workflow: "fixture", state: "review", model: "synthetic/model" };
const ticket = { approval_id: "approval", event: "ACCEPT", from_state: "review", to_state: "work" };
const checkpoint = { run_id: base.run_id, run_session_id: base.run_session_id, state: base.state, pending_approval: ticket };
const environmentKeys = process.platform === "darwin" ? ["PATH", "__CF_USER_TEXT_ENCODING"] : ["PATH"];

async function denied(bridge, action, body, expected) {
  const response = await fetch(bridge.url + "/hooks/request/" + action, { method: "POST",
    headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.ok, false);
  assert.match((await response.json()).error, expected);
}

for (const dropBeginResponse of [false, true]) test(`full executor-parent process reopen preserves approval after ${dropBeginResponse ? "actual dropped HTTP begin response" : "normal parked exit"}`,
  { timeout: 60_000 }, async t => {
    const cleanup = [];
    t.after(async () => {
      const errors = [];
      while (cleanup.length) { try { await cleanup.pop()(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, "Full parent fixture cleanup failed");
    });
    const root = await mkdtemp(join(tmpdir(), "pi-parent-process-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    let live = { ...base, pending_approval: ticket };
    let decision = "pending";
    const requests = [];
    const server = createServer(async (request, response) => {
      if (request.url === "/state" || request.url === "/receipt") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(request.url === "/state" ? live : {
          run_id: base.run_id, run_session_id: base.run_session_id, approval_id: ticket.approval_id, status: decision }));
        return;
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

    async function launch(resumeSessionId, drop = false) {
      const child = fork(new URL("./fixtures/owned-executor-process.mjs", import.meta.url), [], {
        cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const control = ownedProcessDriver(child, { schema, timeoutMs: 20_000 });
      cleanup.push(async () => {
        try { await control.close(); }
        finally { if (!control.exited) await control.terminate(); }
      });
      control.send("initialize", { options: { root, authorityUrl, providerUrl: authorityUrl + "/v1", resumeSessionId, dropBeginResponse: drop } });
      const ready = await control.wait("ready");
      assert.deepEqual(ready.environmentKeys, environmentKeys);
      assert.deepEqual(ready.sdkEnvironmentKeys, environmentKeys);
      assert.equal(JSON.parse(await readFile(ready.ownerPath + ".lock", "utf8")).pid, child.pid);
      return { ...control, ready };
    }
    const first = await launch(undefined, dropBeginResponse);
    const saved = first.ready.owner;
    const journal = approvalJournal(join(root, "approvals"), first.ready.journalClientId);
    assert.deepEqual(await journal.load("fixture"), checkpoint);
    const before = await readFile(saved.host_session_file, "utf8");
    assert.equal(createHash("sha256").update(before).digest("hex"), first.ready.nativeBeforeHash, "SDK startup cannot append pending native history");
    assert.equal(requests.length, 0);
    first.send("prompt", { text: "pending owned task" });
    const parked = await first.wait(dropBeginResponse ? "begin-dropped" : "sdk-parked");
    first.send("snapshot");
    const old = await first.wait("snapshot");
    assert.equal(old.owner.request.phase, "parked");
    assert.equal(old.owner.request_epoch, 1);
    assert.deepEqual(old.checkpoint, checkpoint);
    const reference = parked.reference ?? { schema: "statewright/executor-request-ref/v1", native_session_id: saved.host_session_id,
      request_id: old.owner.request.request_id, request_epoch: old.owner.request_epoch };
    assert.equal(requests.length, 0);
    assert.equal(await readFile(saved.host_session_file, "utf8"), before);
    const settled = first.wait("sdk-prompt-settled"); settled.catch(() => {});
    const closed = first.wait("closed"); closed.catch(() => {});
    assert.deepEqual(await first.close(), { code: 0, signal: null });
    assert.equal((await settled).finalResponse, null);
    const oldClosed = await closed;
    assert.deepEqual({ code: oldClosed.sdkResult.code, signal: oldClosed.sdkResult.signal }, { code: 0, signal: null });
    assert.equal(oldClosed.owner.request.reason, "disconnected");
    await assert.rejects(access(first.ready.ownerPath + ".lock"), { code: "ENOENT" });
    assert.deepEqual(await journal.load("fixture"), checkpoint);
    assert.equal(await readFile(saved.host_session_file, "utf8"), before);

    const second = await launch(saved.executor_session_id);
    assert.notEqual(second.child.pid, first.child.pid);
    assert.notEqual(second.ready.sdkPid, first.ready.sdkPid);
    assert.deepEqual(second.ready.owner, oldClosed.owner, "full process reopen preserves the entire durable owner");
    assert.equal(second.ready.journalClientId, first.ready.journalClientId);
    assert.equal(second.ready.nativeBeforeHash, first.ready.nativeBeforeHash);
    assert.equal(await readFile(saved.host_session_file, "utf8"), before);
    assert.notEqual(second.ready.challenge.parent_lifetime_id, first.ready.challenge.parent_lifetime_id);
    assert.notEqual(second.ready.challenge.child_lifetime_id, first.ready.challenge.child_lifetime_id);
    await denied(second.ready.bridge, "ready", { ...first.ready.challenge, schema: "statewright/pi-native-ready/v1" }, /Invalid or replayed/);
    assert.deepEqual(await journal.load("fixture"), checkpoint);
    assert.equal(requests.length, 0);
    second.send("prompt", { text: "pending owned task" });
    await second.wait("sdk-parked");
    await denied(second.ready.bridge, "status", { reference }, /replaced/);
    await denied(second.ready.bridge, "cancel", { reference, reason: "cancelled" }, /replaced/);
    second.send("snapshot");
    const fresh = await second.wait("snapshot");
    assert.equal(fresh.owner.request_epoch, 2);
    assert.equal(fresh.owner.request.phase, "parked");
    assert.deepEqual(fresh.checkpoint, checkpoint);
    assert.equal(requests.length, 0);
    assert.equal(await readFile(saved.host_session_file, "utf8"), before);
    decision = "approved"; live = { ...base, state: "work" }; // External synthetic authority only.
    const response = await second.wait("sdk-prompt-settled");
    assert.deepEqual(response.finalResponse.content, [{ type: "text", text: "synthetic response" }]);
    second.send("snapshot");
    const consumed = await second.wait("snapshot");
    assert.equal(requests.length, 1);
    assert.equal(consumed.successfulConsumes.length, 1);
    assert.deepEqual(consumed.owner.request.consumed_approval_ids, ["approval"]);
    assert.equal(consumed.checkpoint, null);
    assert.equal(await journal.load("fixture"), null);
    await denied(second.ready.bridge, "consume", consumed.successfulConsumes[0], /Stale or consumed/);
    await assertPiNativeSession({ sessionFile: saved.host_session_file, sessionId: saved.host_session_id, cwd: root });
    const messages = (await readFile(saved.host_session_file, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type === "message");
    assert.deepEqual(messages.map(entry => entry.message.role), ["user", "assistant"]);
    assert.deepEqual(await second.close(), { code: 0, signal: null });
    await assert.rejects(access(second.ready.ownerPath + ".lock"), { code: "ENOENT" });
    assert.equal(requests.length, 1);
  });
