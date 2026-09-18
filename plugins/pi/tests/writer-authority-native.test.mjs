import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "node:http";
import { createExecutorWriterAuthority } from "../../executor/lib/executor-writer-authority.mjs";
import { createExecutorNativeReadiness } from "../../executor/lib/executor-native-readiness.mjs";
import { AdapterBridge } from "../../executor/lib/adapter-bridge.mjs";
import { fixture } from "../../executor/tests/fixtures/owned-request.mjs";

const schema = "statewright/pi-process-fixture/v1";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function controls(port) {
  const inbox = [], pending = new Set();
  const detach = port.onMessage(message => {
    if (message?.schema !== schema || message.pid !== port.pid) return;
    for (const waiter of pending) {
      if (message.type === "failure") waiter.reject(new Error(message.error));
      else if (message.type === waiter.type) { waiter.resolve(message); return; }
    }
    inbox.push(message);
  });
  return { detach, send: (type, value = {}) => port.send({ schema, type, ...value }),
    wait: type => new Promise((resolve, reject) => {
      const error = inbox.find(value => value.type === "failure");
      if (error) { reject(new Error(error.error)); return; }
      const index = inbox.findIndex(value => value.type === type);
      if (index >= 0) { resolve(inbox.splice(index, 1)[0]); return; }
      const waiter = { type, resolve: message => { clearTimeout(timer); pending.delete(waiter); resolve(message); },
        reject: error => { clearTimeout(timer); pending.delete(waiter); reject(error); } };
      const timer = setTimeout(() => waiter.reject(new Error(`Owned SDK ${type} timeout`)), 15_000);
      pending.add(waiter);
    }) };
}

test("private authority observes an actual pending SDK writer exit, not parent-role exit or readiness closure",
  { timeout: 40_000 }, async t => {
    const cleanup = [];
    t.after(async () => {
      const errors = [];
      while (cleanup.length) try { await cleanup.pop()(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Native authority fixture cleanup failed");
    });
    const f = await fixture({ after: callback => cleanup.push(callback) }, { parked: true, nativeFile: true });
    const authority = createExecutorWriterAuthority(); cleanup.push(() => authority.close());
    const readiness = createExecutorNativeReadiness({ owner: f.owner, requestController: f.controller });
    const bridge = await new AdapterBridge({ call: async name => {
      if (name !== "statewright_get_state") throw new Error("Unexpected synthetic authority call");
      return f.getState();
    } }, { host: "pi", sessionOwner: f.owner, requestController: f.controller, nativeReadiness: readiness }).start();
    cleanup.push(() => bridge.close());
    let inference = 0;
    const server = createServer((_, response) => { inference++; response.writeHead(500); response.end(); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const nativeFile = f.owner.record.host_session_file;
    const nativeBefore = await readFile(nativeFile);
    const checkpointFile = join(f.owner.record.scope.cwd, "approvals",
      `${hash(JSON.stringify([f.mirror.clientId, f.mirror.threadId]))}.json`);
    async function snapshot(seed = {}) {
      const ownerBytes = await readFile(f.owner.path), lockBytes = await readFile(`${f.owner.path}.lock`);
      const checkpoint = await f.mirror.loadCheckpoint();
      return { schema: "statewright/native-writer-recovery-binding/v1", executor_session_id: f.owner.record.executor_session_id,
        scope_id: f.owner.scopeId, transport_client_id: f.owner.record.transport_client_id,
        transport_session_id: f.owner.record.transport_session_id, run_id: f.owner.record.run_id,
        native_session_id: f.owner.record.host_session_id, native_session_file: nativeFile,
        owner_token: JSON.parse(lockBytes).owner_token, owner_sha256: hash(ownerBytes), lock_sha256: hash(lockBytes),
        native_sha256: hash(await readFile(nativeFile)), checkpoint_sha256: checkpoint === null ? null : hash(await readFile(checkpointFile)),
        request_epoch: f.owner.record.request_epoch, ...readiness.challenge,
        // Strip readiness schema override and retain its exact lifetime/descriptor fields.
        ...seed, schema: "statewright/native-writer-recovery-binding/v1" };
    }
    const seed = { broker_lifetime_id: authority.lifetimeId, writer_lease_id: randomUUID(), writer_lease_generation: 1, intent_id: randomUUID() };
    const initial = await snapshot(seed); const lease = authority.reserve(initial);
    function owned(role, args) {
      const port = authority.startNode(lease, role, { args, cwd: f.owner.record.scope.cwd });
      cleanup.push(async () => {
        if (!port.exited) {
          port.signal("SIGTERM");
          try { await port.waitForExit(500); } catch { port.signal("SIGKILL"); await port.waitForExit(2_000); }
        }
        await port.waitForClose();
      });
      return port;
    }
    // Inert registered role actor, not the real executor owner/controller process.
    const parent = owned("parent", ["--input-type=module", "-e", "process.on('message', () => { process.disconnect(); process.exitCode = 0; });"]);
    const writer = owned("writer", [fileURLToPath(new URL("./fixtures/owned-sdk-process.mjs", import.meta.url))]);
    const control = controls(writer); cleanup.push(control.detach);
    readiness.bindChild(writer); // Private read-only port derives events from the actual hidden handle.
    await control.send("initialize", { options: { challenge: readiness.challenge, cwd: f.owner.record.scope.cwd,
      nativeRoot: f.owner.nativeRoot, bridge: { url: bridge.url, token: bridge.token },
      providerUrl: `http://127.0.0.1:${server.address().port}/v1` } });
    const ready = await control.wait("ready");
    assert.equal(ready.nativeSessionId, initial.native_session_id);
    assert.equal(ready.nativeSessionFile, nativeFile);
    assert.deepEqual(ready.environmentKeys, process.platform === "darwin" ? ["PATH", "__CF_USER_TEXT_ENCODING"] : ["PATH"]);
    await control.send("prompt", { text: "same owned pending input" }); await control.wait("parked");
    const checkpoint = await f.mirror.loadCheckpoint(); assert.ok(checkpoint?.pending_approval);
    const checkpointBytes = await readFile(checkpointFile);
    assert.equal(inference, 0); assert.deepEqual(await readFile(nativeFile), nativeBefore);
    await parent.send("exit"); assert.deepEqual(await parent.waitForExit(), { code: 0, signal: null });
    const parked = await snapshot({ ...seed, intent_id: randomUUID() });
    assert.throws(() => authority.seal(lease, parked, parked), /observed exits/);
    await readiness.close(); assert.equal(readiness.ready, false);
    assert.equal(writer.exited, false);
    assert.throws(() => authority.seal(lease, parked, parked), /observed exits/);
    const settled = control.wait("prompt-settled"); await control.send("close");
    assert.deepEqual(await writer.waitForExit(15_000), { code: 0, signal: null });
    assert.equal((await settled).finalResponse, null);
    const final = await snapshot({ ...seed, intent_id: randomUUID() });
    assert.notEqual(final.owner_sha256, initial.owner_sha256);
    assert.equal(final.request_epoch, initial.request_epoch + 1);
    const witness = authority.seal(lease, final, final);
    assert.deepEqual(authority.consume(witness, final), final);
    assert.throws(() => authority.consume(witness, final), /consumed/);
    assert.throws(() => authority.reserve(final), /reserved/);
    assert.equal(inference, 0); assert.deepEqual(await readFile(nativeFile), nativeBefore);
    assert.deepEqual(await f.mirror.loadCheckpoint(), checkpoint);
    assert.deepEqual(await readFile(checkpointFile), checkpointBytes);
    assert.equal(f.events.some(value => value.startsWith("clear:")), false);
    const ownerBefore = await readFile(f.owner.path), lockBefore = await readFile(`${f.owner.path}.lock`);
    await assert.rejects(f.store.open({ sessionId: f.owner.record.executor_session_id, resume: true }), /native-writer verification/);
    assert.deepEqual(await readFile(f.owner.path), ownerBefore); assert.deepEqual(await readFile(`${f.owner.path}.lock`), lockBefore);
  });
