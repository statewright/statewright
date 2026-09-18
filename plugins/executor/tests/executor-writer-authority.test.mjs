import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutorWriterAuthority } from "../lib/executor-writer-authority.mjs";

function binding(authority) {
  return { schema: "statewright/native-writer-recovery-binding/v1", scope_id: "a".repeat(64),
    executor_session_id: randomUUID(), transport_client_id: `br_exec_${randomUUID()}`,
    transport_session_id: "session", run_id: "run", native_session_id: randomUUID(),
    native_session_file: join(tmpdir(), `${randomUUID()}.jsonl`), owner_token: randomUUID(),
    owner_sha256: "b".repeat(64), lock_sha256: "c".repeat(64), native_sha256: "d".repeat(64),
    checkpoint_sha256: null, request_epoch: 0, parent_lifetime_id: randomUUID(), child_lifetime_id: randomUUID(),
    broker_lifetime_id: authority.lifetimeId, writer_lease_id: randomUUID(), writer_lease_generation: 1, intent_id: randomUUID() };
}
const actor = `process.on('message', m => {
  if (m === 'exit') { process.disconnect(); process.exitCode = 0; }
  else if (m === 'ignore-term') { process.on('SIGTERM', () => process.send('term-ignored')); process.send('armed'); }
  else process.send(m);
});`;
const start = (authority, lease, role, cwd = tmpdir()) => authority.startNode(lease, role,
  { args: ["--input-type=module", "-e", actor], cwd });
async function message(port, sent, expected = sent) {
  let timer, detach;
  try {
    const reply = new Promise((resolve, reject) => {
      detach = port.onMessage(value => { if (value === expected) resolve(value); });
      timer = setTimeout(() => reject(new Error("Actor message timeout")), 5_000);
    });
    await port.send(sent);
    return await reply;
  } finally { clearTimeout(timer); detach?.(); }
}
function cleanup(t, authority) {
  const ports = [];
  t.after(async () => {
    const errors = [];
    for (const port of ports) try {
      if (port.pid !== null && !port.exited) {
        port.signal("SIGTERM");
        try { await port.waitForExit(200); }
        catch { port.signal("SIGKILL"); await port.waitForExit(2_000); }
      }
      await port.waitForClose(2_000);
    } catch (error) { errors.push(error); }
    authority.close();
    if (errors.length) throw new AggregateError(errors, "Owned authority cleanup failed");
  });
  return ports;
}

test("missing, copied and foreign leases/metadata cannot claim or spawn registered writers", t => {
  const authority = createExecutorWriterAuthority(); cleanup(t, authority);
  const selected = binding(authority);
  assert.throws(() => authority.reserve({ ...selected, broker_lifetime_id: randomUUID() }), /lifetime/);
  const lease = authority.reserve(selected);
  for (const foreign of [null, {}, selected, Object.assign({}, lease)]) {
    assert.throws(() => start(authority, foreign, "writer"), /lease/);
    assert.throws(() => authority.seal(foreign, selected, selected), /lease/);
  }
  assert.throws(() => authority.seal(lease, selected, selected), /observed exits/);
  assert.throws(() => authority.reserve(selected), /reserved/);
  assert.throws(() => authority.reserve({ ...selected, executor_session_id: randomUUID() }), /reserved/);
  assert.throws(() => authority.startNode(lease, "writer", { args: [], cwd: tmpdir(), pid: 123 }), /options/);
  assert.throws(() => authority.startNode(lease, "writer", { args: [], cwd: tmpdir(), verifyExit: () => true }), /options/);
});

test("parent exit, IPC exit assertion, accepted signal and observation timeout do not prove writer exit",
  { skip: process.platform === "win32" }, async t => {
    const authority = createExecutorWriterAuthority(); const ports = cleanup(t, authority);
    const selected = binding(authority); const lease = authority.reserve(selected);
    const parent = start(authority, lease, "parent"); ports.push(parent);
    const writer = start(authority, lease, "writer"); ports.push(writer);
    assert.equal(Object.hasOwn(writer, "emit"), false);
    assert.throws(() => { writer.exitCode = 0; }, TypeError);
    assert.throws(() => start(authority, lease, "writer"), /registered/);
    await message(writer, "ignore-term", "armed");
    await parent.send("exit"); assert.deepEqual(await parent.waitForExit(), { code: 0, signal: null });
    await message(writer, "writer-exited-assertion");
    assert.throws(() => authority.seal(lease, selected, selected), /observed exits/);
    const ignored = message(writer, "echo-before-term"); await ignored;
    let detach;
    const signalObserved = new Promise(resolve => { detach = writer.onMessage(value => { if (value === "term-ignored") resolve(); }); });
    assert.equal(writer.signal("SIGTERM"), true);
    await Promise.race([signalObserved, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("SIGTERM handler timeout")), 5_000); timer.unref();
      signalObserved.finally(() => clearTimeout(timer));
    })]); detach();
    assert.equal(writer.killed, true); assert.equal(writer.exited, false);
    await assert.rejects(writer.waitForExit(20), /timed out/);
    assert.throws(() => authority.seal(lease, selected, selected), /observed exits/);
    assert.equal(writer.signal("SIGKILL"), true);
    assert.deepEqual(await writer.waitForExit(), { code: null, signal: "SIGKILL" });
    const fresh = { ...selected, owner_sha256: "e".repeat(64), request_epoch: 3, intent_id: randomUUID() };
    assert.throws(() => authority.seal(lease, selected, fresh), /metadata mismatch/);
    const foreign = { ...fresh, native_session_id: randomUUID() };
    assert.throws(() => authority.seal(lease, foreign, foreign), /lineage mismatch/);
    const witness = authority.seal(lease, fresh, fresh);
    assert.throws(() => JSON.stringify(witness), /serialized/);
    assert.throws(() => authority.seal(lease, fresh, fresh), /sealed/);
    assert.throws(() => start(authority, lease, "writer"), /sealed/);
    for (const copied of [{}, fresh, { code: 0, signal: null }, Object.assign({}, witness)]) {
      assert.throws(() => authority.consume(copied, fresh), /witness/);
    }
    assert.throws(() => authority.consume(witness, selected), /metadata mismatch/);
    assert.deepEqual(authority.consume(witness, fresh), fresh);
    assert.throws(() => authority.consume(witness, fresh), /consumed/);
    assert.throws(() => authority.reserve(fresh), /reserved/);
  });

test("new authority or closed authority cannot adopt a serialized earlier lifecycle", async t => {
  const authority = createExecutorWriterAuthority(); const ports = cleanup(t, authority);
  const selected = binding(authority); const lease = authority.reserve(selected);
  for (const role of ["parent", "writer"]) { const port = start(authority, lease, role); ports.push(port); await port.send("exit"); await port.waitForExit(); }
  const witness = authority.seal(lease, selected, selected);
  const other = createExecutorWriterAuthority(); cleanup(t, other);
  assert.notEqual(other.lifetimeId, authority.lifetimeId);
  assert.throws(() => other.reserve(selected), /lifetime/);
  assert.throws(() => other.consume(witness, selected), /witness/);
  authority.close();
  assert.throws(() => authority.consume(witness, selected), /closed/);
  assert.throws(() => authority.reserve(binding(authority)), /closed/);
});

test("spawn error/close without observed exit cannot issue a native-writer witness", async t => {
  const authority = createExecutorWriterAuthority(); const ports = cleanup(t, authority);
  const selected = binding(authority); const lease = authority.reserve(selected);
  const parent = start(authority, lease, "parent"); ports.push(parent); await parent.send("exit"); await parent.waitForExit();
  const failed = start(authority, lease, "writer", join(tmpdir(), `missing-${randomUUID()}`)); ports.push(failed);
  await failed.waitForClose(); assert.equal(failed.pid, null); assert.equal(failed.exited, false);
  assert.throws(() => authority.seal(lease, selected, selected), /observed exits/);
});

test("IPC detachment returns no native handle and callbacks have no native this", async t => {
  const authority = createExecutorWriterAuthority(); const ports = cleanup(t, authority);
  const selected = binding(authority), lease = authority.reserve(selected);
  const writer = start(authority, lease, "writer"); ports.push(writer);
  const detach = writer.onMessage(() => {});
  assert.equal(detach() === undefined, true, "detaching must not reveal the ChildProcess");
  let resolveMessage;
  const received = new Promise(resolve => { resolveMessage = resolve; });
  const stop = writer.onMessage(function (value) { resolveMessage({ value, receiver: this }); });
  await writer.send("echo");
  assert.deepEqual(await Promise.race([received, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Owned callback timeout")), 5_000); timer.unref();
    received.finally(() => clearTimeout(timer));
  })]), { value: "echo", receiver: undefined });
  stop();
  let resolveExit;
  const exitCallback = new Promise(resolve => { resolveExit = resolve; });
  writer.once("exit", function () { resolveExit(this); });
  await writer.send("exit"); await writer.waitForExit();
  assert.equal(await exitCallback, undefined);
});

test("separate registered lineages cannot witness the same recovery intent twice", async t => {
  const authority = createExecutorWriterAuthority(); const ports = cleanup(t, authority);
  const first = binding(authority), second = { ...binding(authority), intent_id: first.intent_id };
  const a = authority.reserve(first), b = authority.reserve(second);
  for (const lease of [a, b]) for (const role of ["parent", "writer"]) {
    const port = start(authority, lease, role); ports.push(port); await port.send("exit"); await port.waitForExit();
  }
  authority.seal(a, first, first);
  assert.throws(() => authority.seal(b, second, second), /already witnessed/);
});
