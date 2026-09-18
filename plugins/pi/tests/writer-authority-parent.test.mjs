import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createExecutorWriterAuthority } from "../../executor/lib/executor-writer-authority.mjs";
import { createExecutorSessionStore } from "../../executor/lib/executor-session-ownership.mjs";
import { createPiNativeSession } from "../../executor/lib/host-adapters.mjs";
import { parentWriterPort, writerRelaySelection } from "./fixtures/owned-writer-relay.mjs";

const parentSchema = "statewright/pi-writer-parent-fixture/v1";
const sdkSchema = "statewright/pi-process-fixture/v1";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const live = { run_id: "run", run_session_id: "session", workflow: "fixture", state: "review",
  pending_approval: { approval_id: "approval", event: "ACCEPT", from_state: "review", to_state: "work" } };

function controls(port, schema) {
  const inbox = [], waiting = new Set();
  const rejectWaiters = error => { for (const waiter of waiting) waiter.reject(error); };
  const ended = () => rejectWaiters(new Error("Owned port actually exited"));
  port.once("exit", ended);
  const detachMessage = port.onMessage(message => {
    if (message?.schema !== schema || message.pid !== port.pid) return;
    for (const waiter of waiting) {
      if (message.type === "failure") waiter.reject(new Error(message.error));
      else if (message.type === waiter.type) { waiter.resolve(message); return; }
    }
    inbox.push(message);
  });
  return { send: (type, value = {}) => port.send({ schema, type, ...value }),
    detach() { detachMessage(); port.removeListener("exit", ended); rejectWaiters(new Error("Control detached")); },
    wait: type => new Promise((resolve, reject) => {
      const failure = inbox.find(message => message.type === "failure");
      if (failure) { reject(new Error(failure.error)); return; }
      const index = inbox.findIndex(message => message.type === type);
      if (index >= 0) { resolve(inbox.splice(index, 1)[0]); return; }
      if (port.exited) { reject(new Error("Owned port already exited")); return; }
      const waiter = { type, resolve: message => { clearTimeout(timer); waiting.delete(waiter); resolve(message); },
        reject: error => { clearTimeout(timer); waiting.delete(waiter); reject(error); } };
      const timer = setTimeout(() => waiter.reject(new Error(`Private ${type} timeout`)), 15_000);
      waiting.add(waiter);
    }) };
}

test("test-only parent relay rejects foreign, malformed and replayed events; it is not root exit authority", () => {
  const selection = writerRelaySelection({ executor_session_id: randomUUID(), native_session_id: randomUUID(),
    native_session_file: "/synthetic/native", broker_lifetime_id: randomUUID(), parent_lifetime_id: randomUUID(),
    child_lifetime_id: randomUUID(), writer_lease_id: randomUUID(), writer_lease_generation: 1 }, 11, 12);
  const port = parentWriterPort(selection);
  const message = { type: "writer-exit", selection, receipt: { code: 0, signal: null } };
  for (const candidate of [ { ...message, selection: { ...selection, writer_pid: 13 } },
    { ...message, selection: { ...selection, writer_lease_id: randomUUID() } },
    { ...message, selection: { ...selection, child_lifetime_id: randomUUID() } },
    { ...message, extra: true }, { ...message, receipt: { code: 0, signal: "SIGKILL" } },
    { ...message, receipt: { code: null, signal: null } } ]) {
    assert.throws(() => port.receive(candidate), /Invalid or replayed/); assert.equal(port.exited, false);
  }
  let count = 0; port.once("exit", () => { count++; });
  port.receive(message); assert.equal(count, 1); assert.equal(port.exited, true);
  assert.throws(() => port.receive(message), /replayed/);
  // A fixture proxy deliberately trusts creator IPC. It cannot be adopted by
  // createExecutorWriterAuthority, whose startNode has no supplied-handle option.
  assert.equal(typeof port.emit, "undefined");
});

for (const order of ["parent-first", "writer-first"]) test(`root-owned real executor-parent/SDK pair preserves pending state after ${order} SIGKILL`,
  { timeout: 50_000 }, async t => {
    const cleanup = [];
    t.after(async () => {
      const errors = [];
      while (cleanup.length) try { await cleanup.pop()(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Real parent authority cleanup failed");
    });
    const root = await mkdtemp(join(tmpdir(), "pi-writer-parent-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    let inference = 0;
    const server = createServer((request, response) => {
      if (["/state", "/receipt"].includes(request.url)) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(request.url === "/state" ? live : {
          run_id: live.run_id, run_session_id: live.run_session_id,
          approval_id: live.pending_approval.approval_id, status: "pending" })); return;
      }
      inference++; response.writeHead(500); response.end();
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const authorityUrl = `http://127.0.0.1:${server.address().port}`;
    const store = createExecutorSessionStore({ root: join(root, "owners"), cwd: root, host: "pi",
      workflow: "fixture", apiKey: "synthetic-private-key", gatewayUrl: authorityUrl });
    const prepared = await store.open();
    let preparedReleased = false;
    cleanup.push(async () => { if (!preparedReleased) await prepared.release(); });
    await prepared.bindGateway(live);
    const nativeFile = await createPiNativeSession({ pluginsRoot: fileURLToPath(new URL("../../", import.meta.url)),
      cwd: root, sessionDir: prepared.nativeRoot, sessionId: prepared.record.host_session_id });
    await prepared.bindHost({ sessionId: prepared.record.host_session_id, sessionFile: nativeFile });
    const saved = prepared.record, ownerPath = prepared.path;
    const nativeBefore = await readFile(nativeFile);
    const authority = createExecutorWriterAuthority(); cleanup.push(() => authority.close());
    const birth = { parent_lifetime_id: randomUUID(), child_lifetime_id: randomUUID(), broker_lifetime_id: authority.lifetimeId,
      writer_lease_id: randomUUID(), writer_lease_generation: 1, intent_id: randomUUID() };
    async function snapshot(checkpointFile = null) {
      const ownerBytes = await readFile(ownerPath), lockBytes = await readFile(ownerPath + ".lock");
      if (!checkpointFile) await assert.rejects(access(join(root, "approvals")), { code: "ENOENT" });
      return { schema: "statewright/native-writer-recovery-binding/v1", executor_session_id: saved.executor_session_id,
        scope_id: prepared.scopeId, transport_client_id: saved.transport_client_id, transport_session_id: saved.transport_session_id,
        run_id: saved.run_id, native_session_id: saved.host_session_id, native_session_file: nativeFile,
        owner_token: JSON.parse(lockBytes).owner_token, owner_sha256: hash(ownerBytes), lock_sha256: hash(lockBytes),
        native_sha256: hash(await readFile(nativeFile)), checkpoint_sha256: checkpointFile ? hash(await readFile(checkpointFile)) : null,
        request_epoch: JSON.parse(ownerBytes).request_epoch, ...birth, intent_id: randomUUID() };
    }
    const initial = await snapshot(); const lease = authority.reserve(initial);
    await prepared.release(); // Setup only; parent must claim its own PID/token.
    preparedReleased = true;
    function owned(role, fixture) {
      const port = authority.startNode(lease, role, { cwd: root,
        args: [fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url))] });
      cleanup.push(async () => {
        if (!port.exited) {
          port.signal("SIGTERM");
          try { await port.waitForExit(500); } catch { port.signal("SIGKILL"); await port.waitForExit(2_000); }
        }
        await port.waitForClose();
      }); return port;
    }
    const parent = owned("parent", "owned-writer-parent.mjs"), p = controls(parent, parentSchema); cleanup.push(p.detach);
    await p.send("initialize", { options: { root, authorityUrl, selected: initial } });
    const descriptor = await p.wait("descriptor");
    assert.deepEqual(descriptor.owner, saved);
    assert.equal(descriptor.ownerPath, ownerPath);
    assert.equal(JSON.parse(await readFile(ownerPath + ".lock", "utf8")).pid, parent.pid);
    assert.notEqual(parent.pid, process.pid);
    assert.notEqual(descriptor.challenge.parent_lifetime_id, birth.parent_lifetime_id);
    assert.notEqual(descriptor.challenge.child_lifetime_id, birth.child_lifetime_id);
    const writer = owned("writer", "owned-sdk-process.mjs"), w = controls(writer, sdkSchema); cleanup.push(w.detach);
    const selection = writerRelaySelection(initial, parent.pid, writer.pid);
    // Root sends only actual hidden-handle-derived events to the separate parent
    // IPC channel. SDK fixture data messages cannot route a lifecycle assertion.
    const relay = async (code, signal) => {
      if (!parent.exited) await p.send("writer-exit", { selection, receipt: { code, signal } });
    };
    let relayResult;
    writer.once("exit", (code, signal) => { relayResult = relay(code, signal); relayResult.catch(() => {}); });
    await p.send("attach-writer", { selection }); assert.deepEqual((await p.wait("writer-bound")).selection, selection);
    assert.deepEqual(descriptor.environmentKeys, process.platform === "darwin" ? ["PATH", "__CF_USER_TEXT_ENCODING"] : ["PATH"]);
    await w.send("initialize", { options: { challenge: descriptor.challenge, cwd: root, nativeRoot: prepared.nativeRoot,
      bridge: descriptor.bridge, providerUrl: authorityUrl + "/v1" } });
    const ready = await w.wait("ready"); assert.equal(ready.nativeSessionId, saved.host_session_id);
    assert.equal(ready.nativeSessionFile, nativeFile);
    assert.deepEqual(ready.environmentKeys, descriptor.environmentKeys);
    await w.send("prompt", { text: "same pending private input" }); await w.wait("parked");
    await p.send("snapshot"); const parked = await p.wait("snapshot");
    assert.equal(parked.ready, true); assert.equal(parked.owner.request.phase, "parked");
    assert.deepEqual(parked.checkpoint, { run_id: live.run_id, run_session_id: live.run_session_id, state: live.state, pending_approval: live.pending_approval });
    const checkpointFile = join(root, "approvals", `${hash(JSON.stringify([descriptor.journalClientId, "fixture"]))}.json`);
    const checkpointBefore = await readFile(checkpointFile);
    const parkedBinding = await snapshot(checkpointFile);
    assert.equal(inference, 0); assert.deepEqual(await readFile(nativeFile), nativeBefore);
    if (order === "parent-first") {
      parent.signal("SIGKILL"); assert.deepEqual(await parent.waitForExit(), { code: null, signal: "SIGKILL" });
      assert.equal(writer.exited, false);
      assert.throws(() => authority.seal(lease, parkedBinding, parkedBinding), /observed exits/);
      await assert.rejects(writer.waitForExit(20), /timed out/);
      const stillAlive = await w.wait("prompt-settled"); // Bridge death aborts, not writer exit.
      assert.equal(stillAlive.finalResponse, null); assert.equal(writer.exited, false);
      const assertedExit = parentWriterPort(selection);
      assertedExit.receive({ type: "writer-exit", selection, receipt: { code: 0, signal: null } });
      assert.equal(assertedExit.exited, true); // Trusted fixture assertion, not a kernel event.
      assert.throws(() => authority.consume(assertedExit, parkedBinding), /Unknown private/);
      assert.throws(() => authority.seal(lease, parkedBinding, parkedBinding), /observed exits/);
    } else {
      const observed = p.wait("writer-exit-observed");
      writer.signal("SIGKILL"); assert.deepEqual(await writer.waitForExit(), { code: null, signal: "SIGKILL" });
      await relayResult; const stopped = await observed;
      assert.equal(stopped.ready, false); assert.equal(stopped.owner.request.phase, "cancelled");
      assert.equal(stopped.owner.request.reason, "disconnected");
      assert.equal(parent.exited, false);
      const writerStopped = await snapshot(checkpointFile);
      assert.throws(() => authority.seal(lease, writerStopped, writerStopped), /observed exits/);
      parent.signal("SIGKILL"); assert.deepEqual(await parent.waitForExit(), { code: null, signal: "SIGKILL" });
    }
    const ownerAfterParent = await readFile(ownerPath), lockAfterParent = await readFile(ownerPath + ".lock");
    const ownerInventory = (await readdir(dirname(ownerPath))).sort(), journalInventory = (await readdir(join(root, "approvals"))).sort();
    assert.equal(JSON.parse(lockAfterParent).pid, parent.pid);
    assert.equal(JSON.parse(ownerAfterParent).request.phase, order === "parent-first" ? "parked" : "cancelled");
    await assert.rejects(store.open({ sessionId: saved.executor_session_id, resume: true }), /native-writer verification/);
    if (!writer.exited) { writer.signal("SIGKILL"); assert.deepEqual(await writer.waitForExit(), { code: null, signal: "SIGKILL" }); }
    await relayResult;
    const final = await snapshot(checkpointFile);
    assert.notEqual(final.owner_token, initial.owner_token); assert.equal(final.request_epoch, 1);
    assert.throws(() => authority.seal(lease, initial, final), /metadata mismatch/);
    assert.throws(() => authority.seal(lease, { ...final, parent_lifetime_id: randomUUID() }, final), /metadata mismatch/);
    assert.throws(() => authority.consume({ ...final, exited: true }, final), /Unknown private/);
    const witness = authority.seal(lease, final, final); assert.deepEqual(authority.consume(witness, final), final);
    assert.throws(() => authority.consume(witness, final), /consumed/);
    assert.throws(() => authority.reserve(final), /reserved/);
    await assert.rejects(store.open({ sessionId: saved.executor_session_id, resume: true }), /native-writer verification/);
    assert.deepEqual(await readFile(ownerPath), ownerAfterParent); assert.deepEqual(await readFile(ownerPath + ".lock"), lockAfterParent);
    assert.deepEqual((await readdir(dirname(ownerPath))).sort(), ownerInventory);
    assert.deepEqual((await readdir(join(root, "approvals"))).sort(), journalInventory);
    assert.deepEqual(await readFile(nativeFile), nativeBefore); assert.deepEqual(await readFile(checkpointFile), checkpointBefore);
    assert.equal(inference, 0);
  });
