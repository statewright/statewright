import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createExecutorNativeReadiness } from "../../executor/lib/executor-native-readiness.mjs";
import { AdapterBridge } from "../../executor/lib/adapter-bridge.mjs";
import { assertPiNativeSession } from "../../executor/lib/host-adapters.mjs";
import { fixture, pending } from "../../executor/tests/fixtures/owned-request.mjs";
import { ownedProcessDriver } from "./fixtures/owned-process-driver.mjs";

const schema = "statewright/pi-process-fixture/v1";

async function denied(bridge, action, body, expected) {
  const response = await fetch(`${bridge.url}/hooks/request/${action}`, {
    method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.ok, false, `Stale ${action} must fail at the actual private HTTP bridge`);
  assert.match(result.error, expected);
}

for (const withholdBegin of [false, true]) test(`actual SDK process resume preserves pending gate after ${withholdBegin ? "lost begin acknowledgement" : "normal parked close"}`,
  { timeout: 45_000 }, async t => {
    const cleanup = [];
    // LIFO: close children/bridges before the underlying owner/root cleanup.
    t.after(async () => {
      const errors = [];
      while (cleanup.length) { try { await cleanup.pop()(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, "Owned process fixture cleanup failed");
    });
    const f = await fixture({ after: callback => cleanup.push(callback) }, { parked: true, nativeFile: true });
    const requests = [];
    const successfulConsumes = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const chunk = (delta, finish_reason) => JSON.stringify({ id: "synthetic", object: "chat.completion.chunk",
        model: "synthetic-chat", choices: [{ index: 0, delta, finish_reason }] });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${chunk({ role: "assistant", content: "synthetic response" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const providerUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const descriptor = { nativeSessionId: f.owner.record.host_session_id, nativeSessionFile: f.owner.record.host_session_file,
      executorSessionId: f.owner.record.executor_session_id, transportClientId: f.owner.record.transport_client_id };
    const before = await readFile(descriptor.nativeSessionFile, "utf8");

    async function launch(lostAcknowledgement = false) {
      // Observe the successful real controller call without changing admission.
      const consume = f.controller.consume.bind(f.controller);
      f.controller.consume = async body => {
        const result = await consume(body);
        successfulConsumes.push(structuredClone(body));
        return result;
      };
      const readiness = createExecutorNativeReadiness({ owner: f.owner, requestController: f.controller });
      const bridge = await new AdapterBridge({ call: async name => {
        if (name !== "statewright_get_state") throw new Error("Unexpected synthetic authority call");
        return f.getState();
      } }, { host: "pi", sessionOwner: f.owner, requestController: f.controller, nativeReadiness: readiness }).start();
      cleanup.push(() => bridge.close());
      // Explicit allowlist: no ambient provider credentials or session routing.
      const childEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
      const child = fork(new URL("./fixtures/owned-sdk-process.mjs", import.meta.url), [], {
        cwd: f.owner.record.scope.cwd, env: childEnv, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const control = ownedProcessDriver(child, { schema });
      readiness.bindChild(child);
      cleanup.push(async () => {
        try { await control.close(); } finally {
          // Exact fixture child only; emergency cleanup is not successful exit evidence.
          if (!control.exited) await control.terminate();
        }
      });
      control.send("initialize", { options: { challenge: readiness.challenge, cwd: f.owner.record.scope.cwd,
        nativeRoot: f.owner.nativeRoot, bridge: { url: bridge.url, token: bridge.token }, providerUrl, withholdBegin: lostAcknowledgement } });
      assert.deepEqual(await control.wait("ready"), { schema, type: "ready", pid: child.pid,
        nativeSessionId: descriptor.nativeSessionId, nativeSessionFile: descriptor.nativeSessionFile,
        // A bare PATH-only Node launch also adds this Darwin runtime key.
        environmentKeys: process.platform === "darwin" ? ["PATH", "__CF_USER_TEXT_ENCODING"] : ["PATH"] });
      assert.equal(readiness.ready, true);
      return { ...control, readiness, bridge };
    }

    const first = await launch(withholdBegin);
    assert.equal(requests.length, 0, "startup cannot infer");
    first.send("prompt", { text: "same owned pending input" });
    const parked = await first.wait(withholdBegin ? "begin-withheld" : "parked");
    const oldReference = parked.reference ?? {
      schema: "statewright/executor-request-ref/v1", native_session_id: descriptor.nativeSessionId,
      request_id: f.owner.record.request.request_id, request_epoch: f.owner.record.request_epoch };
    assert.equal(f.owner.record.request.phase, "parked");
    const checkpoint = await f.mirror.loadCheckpoint();
    assert.deepEqual(checkpoint, { run_id: pending.run_id, run_session_id: pending.run_session_id,
      state: pending.state, pending_approval: pending.pending_approval });
    assert.equal(requests.length, 0, "pending input cannot infer");
    assert.equal(await readFile(descriptor.nativeSessionFile, "utf8"), before, "parked SDK cannot append native history");
    const oldSettled = first.wait("prompt-settled");
    oldSettled.catch(() => {});
    assert.deepEqual(await first.close(), { code: 0, signal: null });
    assert.equal((await oldSettled).finalResponse, null);
    await first.readiness.close();
    await first.bridge.close();
    assert.equal(first.readiness.ready, false);
    assert.equal(f.owner.record.request.phase, "cancelled");
    assert.equal(f.owner.record.request.reason, "disconnected");
    assert.deepEqual(await f.mirror.loadCheckpoint(), checkpoint);
    assert.equal(await readFile(descriptor.nativeSessionFile, "utf8"), before);

    await f.reopen();
    assert.equal(f.owner.record.executor_session_id, descriptor.executorSessionId);
    assert.equal(f.owner.record.transport_client_id, descriptor.transportClientId);
    assert.equal(f.owner.record.host_session_id, descriptor.nativeSessionId);
    assert.equal(f.owner.record.host_session_file, descriptor.nativeSessionFile);
    const second = await launch();
    assert.notEqual(second.child.pid, first.child.pid);
    assert.notEqual(second.readiness.challenge.parent_lifetime_id, first.readiness.challenge.parent_lifetime_id);
    assert.notEqual(second.readiness.challenge.child_lifetime_id, first.readiness.challenge.child_lifetime_id);
    await denied(second.bridge, "ready", { ...first.readiness.challenge, schema: "statewright/pi-native-ready/v1" }, /Invalid or replayed/);
    assert.equal(requests.length, 0, "cold startup still cannot infer");
    second.send("prompt", { text: "same owned pending input" });
    await second.wait("parked");
    assert.equal(f.owner.record.request_epoch, oldReference.request_epoch + 1);
    assert.equal(f.owner.record.request.phase, "parked");
    assert.deepEqual(await f.mirror.loadCheckpoint(), checkpoint);
    await assert.rejects(f.controller.status(oldReference), /replaced/);
    await denied(second.bridge, "status", { reference: oldReference }, /replaced/);
    await denied(second.bridge, "cancel", { reference: oldReference, reason: "cancelled" }, /replaced/);
    assert.equal(requests.length, 0, "cold pending input still cannot infer");
    assert.equal(await readFile(descriptor.nativeSessionFile, "utf8"), before);
    f.approve(); // Synthetic fixture authority, never a real human/resolver.
    const settled = await second.wait("prompt-settled");
    assert.equal(settled.finalResponse?.role, "assistant");
    assert.equal(settled.finalResponse?.stopReason, "stop");
    assert.deepEqual(settled.finalResponse.content, [{ type: "text", text: "synthetic response" }]);
    assert.equal(requests.length, 1);
    assert.deepEqual(f.owner.record.request.consumed_approval_ids, ["approval"]);
    assert.equal(f.events.filter(value => value === "clear:approval").length, 1);
    assert.equal(await f.mirror.loadCheckpoint(), null);
    await assert.rejects(f.controller.status(oldReference), /replaced/);
    assert.equal(successfulConsumes.length, 1);
    assert.equal(successfulConsumes[0].reference.request_epoch, f.owner.record.request_epoch);
    assert.match(successfulConsumes[0].release_nonce, /^[0-9a-f-]{36}$/);
    await denied(second.bridge, "consume", successfulConsumes[0], /Stale or consumed/);
    assert.equal(successfulConsumes.length, 1, "replaying the actual consumed release cannot consume twice");
    const messages = (await readFile(descriptor.nativeSessionFile, "utf8")).trim().split("\n")
      .map(line => JSON.parse(line)).filter(entry => entry.type === "message");
    assert.deepEqual(messages.map(entry => entry.message.role), ["user", "assistant"]);
    await assertPiNativeSession({ sessionFile: descriptor.nativeSessionFile, sessionId: descriptor.nativeSessionId, cwd: f.owner.record.scope.cwd });
    assert.deepEqual(await second.close(), { code: 0, signal: null });
    assert.equal(requests.length, 1, "close/replay cannot duplicate continuation");
  });
