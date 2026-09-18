import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchExecutorRecoveryBinding } from "../lib/executor-recovery-contract.mjs";
import { createExecutorSessionStore } from "../lib/executor-session-ownership.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function binding() {
  return { schema: "statewright/native-writer-recovery-binding/v1",
    executor_session_id: randomUUID(), scope_id: hash("scope"),
    transport_client_id: `br_exec_${randomUUID()}`, transport_session_id: "transport-session", run_id: "run",
    native_session_id: randomUUID(), native_session_file: join(tmpdir(), "recovery-contract", "thread.jsonl"),
    owner_token: randomUUID(), owner_sha256: hash("owner"), lock_sha256: hash("lock"),
    native_sha256: hash(""), checkpoint_sha256: hash("pending"), request_epoch: 1,
    parent_lifetime_id: randomUUID(), child_lifetime_id: randomUUID(), broker_lifetime_id: randomUUID(),
    writer_lease_id: randomUUID(), writer_lease_generation: 1, intent_id: randomUUID() };
}

test("matching JSON returns a detached frozen scalar copy without mutating either input", () => {
  const expected = binding();
  const candidate = JSON.parse(JSON.stringify(expected));
  const before = JSON.stringify([candidate, expected]);
  const result = matchExecutorRecoveryBinding(candidate, expected);
  assert.deepEqual(result, expected);
  assert.notEqual(result, candidate);
  assert.notEqual(result, expected);
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => { result.intent_id = randomUUID(); }, TypeError);
  assert.equal(JSON.stringify([candidate, expected]), before);
  candidate.run_id = "changed-later";
  assert.equal(result.run_id, "run");
});

test("absence is explicit metadata, not approval or one-use authority", () => {
  const expected = { ...binding(), checkpoint_sha256: null, request_epoch: 0 };
  const candidate = Object.assign(Object.create(null), expected);
  assert.deepEqual(matchExecutorRecoveryBinding(candidate, expected), expected);
  // Data comparison is deliberately repeatable; no witness is consumed/minted.
  assert.deepEqual(matchExecutorRecoveryBinding(candidate, expected), expected);
  assert.equal(Object.hasOwn(expected, "approved"), false);
});

for (const field of Object.keys(binding()).filter(field => field !== "schema")) {
  test(`foreign or stale ${field} cannot match the selected recovery intent`, () => {
    const expected = binding();
    const old = expected[field];
    const different = typeof old === "number" ? old + 1 : field === "native_session_file" ? join(tmpdir(), "foreign.jsonl")
      : field === "transport_client_id" ? `br_exec_${randomUUID()}` : field.endsWith("sha256") || field === "scope_id"
        ? hash("foreign") : (field.endsWith("_id") && /^[0-9a-f-]{36}$/i.test(old)) || field === "owner_token"
          ? randomUUID() : `${old}-foreign`;
    assert.throws(() => matchExecutorRecoveryBinding({ ...expected, [field]: different }, expected), /metadata mismatch/);
  });
}

test("closed schema rejects malformed candidates AND malformed expected intents without coercion", () => {
  const good = binding();
  const missing = { ...good }; delete missing.owner_token;
  const malformed = [null, false, [], "JSON", {}, missing, { ...good, extra: true },
    { ...good, schema: "statewright/native-writer-recovery-binding/v2" },
    { ...good, executor_session_id: "../escape" }, { ...good, owner_token: 123 },
    { ...good, scope_id: good.scope_id.toUpperCase() }, { ...good, native_sha256: "sha256:abc" },
    { ...good, checkpoint_sha256: undefined }, { ...good, checkpoint_sha256: {} },
    { ...good, transport_client_id: `other_${randomUUID()}` }, { ...good, transport_client_id: "br_exec_not-uuid" },
    { ...good, transport_session_id: "" }, { ...good, run_id: "run\nforeign" }, { ...good, run_id: "x".repeat(1025) },
    { ...good, native_session_file: "thread.jsonl" }, { ...good, native_session_file: join(tmpdir(), "native") + "/../thread.jsonl" },
    { ...good, native_session_file: "\0" }, { ...good, request_epoch: -1 }, { ...good, request_epoch: "1" },
    { ...good, request_epoch: 1.5 }, { ...good, request_epoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...good, writer_lease_generation: 0 }, { ...good, writer_lease_generation: Infinity },
    { ...good, writer_lease_generation: "1" }, Object.assign(Object.create({ inherited: true }), good)];
  for (const value of malformed) {
    assert.throws(() => matchExecutorRecoveryBinding(value, good), /Invalid.*metadata/);
    assert.throws(() => matchExecutorRecoveryBinding(good, value), /Invalid.*metadata/);
  }
});

test("accessors, nonenumerable fields and symbol extras cannot hide executable or extra metadata", () => {
  const expected = binding();
  let getterCalls = 0;
  const accessor = { ...expected };
  Object.defineProperty(accessor, "owner_token", { enumerable: true, get() { getterCalls++; return expected.owner_token; } });
  const hidden = { ...expected };
  Object.defineProperty(hidden, "owner_token", { value: expected.owner_token, enumerable: false });
  for (const value of [accessor, hidden, { ...expected, [Symbol("extra")]: true }]) {
    assert.throws(() => matchExecutorRecoveryBinding(value, expected), /Invalid.*metadata/);
    assert.throws(() => matchExecutorRecoveryBinding(expected, value), /Invalid.*metadata/);
  }
  assert.equal(getterCalls, 0);
});

test("UUID case and snapshot aliases are exact comparisons, not identity normalization", () => {
  const expected = binding();
  expected.executor_session_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  assert.throws(() => matchExecutorRecoveryBinding({ ...expected,
    executor_session_id: expected.executor_session_id.toUpperCase() }, expected), /metadata mismatch/);
  assert.throws(() => matchExecutorRecoveryBinding({ ...expected,
    checkpoint_sha256: null }, expected), /metadata mismatch/);
});

test("matched and replayed metadata cannot bypass a real lock or alter a consumed tombstone", async t => {
  const root = await mkdtemp(join(tmpdir(), "executor-recovery-contract-"));
  let owner;
  t.after(async () => {
    try { if (owner) await owner.release(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const store = createExecutorSessionStore({ root, cwd: root, host: "pi", workflow: "fixture-flow",
    projectId: "project", apiKey: "private-fixture-key", gatewayUrl: "http://127.0.0.1:9" });
  owner = await store.open();
  const live = { run_id: "run", run_session_id: "transport-session", workflow: "fixture-flow", state: "review",
    pending_approval: { approval_id: "approval", event: "approve", from_state: "review", to_state: "work" } };
  await owner.bindGateway(live);
  const nativeFile = join(owner.nativeRoot, "thread.jsonl");
  await mkdir(owner.nativeRoot);
  await writeFile(nativeFile, "");
  await owner.bindHost({ sessionId: owner.record.host_session_id, sessionFile: nativeFile });
  const reference = await owner.beginRequest({ nativeSessionId: owner.record.host_session_id, inputDigest: hash("input") });
  await owner.parkRequest(reference, live);
  await owner.readyRequest(reference);
  await owner.consumeRequest(reference, owner.record.request.release_nonce);
  const lockPath = `${owner.path}.lock`;
  const before = await Promise.all([readFile(owner.path), readFile(lockPath), readFile(nativeFile)]);
  const inventory = await readdir(join(root, store.scopeId), { recursive: true });
  const expected = { ...binding(), executor_session_id: owner.record.executor_session_id, scope_id: store.scopeId,
    transport_client_id: owner.record.transport_client_id, transport_session_id: owner.record.transport_session_id,
    run_id: owner.record.run_id, native_session_id: owner.record.host_session_id, native_session_file: nativeFile,
    owner_token: JSON.parse(before[1]).owner_token, owner_sha256: hash(before[0]), lock_sha256: hash(before[1]),
    native_sha256: hash(before[2]), request_epoch: owner.record.request_epoch };
  // Lifetime/lease/intent IDs here are synthetic metadata, NOT registered writer proof.
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(matchExecutorRecoveryBinding(JSON.parse(JSON.stringify(expected)), expected), expected);
    await assert.rejects(store.open({ sessionId: owner.record.executor_session_id, resume: true }), /native-writer verification/);
    assert.deepEqual(await Promise.all([readFile(owner.path), readFile(lockPath), readFile(nativeFile)]), before);
    assert.deepEqual(await readdir(join(root, store.scopeId), { recursive: true }), inventory);
    assert.deepEqual(owner.record.request.consumed_approval_ids, ["approval"]);
    assert.equal(owner.record.request.release_nonce, null);
  }
});
