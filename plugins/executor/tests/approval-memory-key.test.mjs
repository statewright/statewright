import test from "node:test";
import assert from "node:assert/strict";
import {createHmac, randomUUID} from "node:crypto";
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ApprovalMemory} from "../lib/approval-memory.mjs";

const binding = {
  policy_sha256: "a".repeat(64),
  grant_policy_v2_sha256: "d".repeat(64),
  invocation_sha256: "b".repeat(64),
  dependency_sha256: "c".repeat(64),
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "statewright-approval-memory-key-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  let now = Date.now();
  return {
    root,
    make: () => new ApprovalMemory({root, namespace: "ns", now: () => now}),
    setNow: value => { now = value; },
    now: () => now,
  };
}

function forgedGrant(key, now) {
  const id = createHmac("sha256", key).update(JSON.stringify([
    binding.grant_policy_v2_sha256, binding.invocation_sha256, binding.dependency_sha256,
  ])).digest("hex");
  const grant = {
    schema: "statewright/approval-memory-grant/v1", id, binding_sha256: id,
    generation: "00000000-0000-4000-8000-000000000000", duration: "always",
    issued_at: now, last_used_at: now, expires_at: null,
  };
  return {grant, mac: createHmac("sha256", key).update(JSON.stringify(grant)).digest("hex")};
}

test("the owner never writes a key and ignores guessed-key grants", async t => {
  const f = await fixture(t), memory = f.make();
  assert.deepEqual(await memory.list(), []);
  assert(!(await readdir(memory.root)).includes("key"));

  const guess = Buffer.alloc(32, 0x5a), forged = forgedGrant(guess, f.now());
  await writeFile(join(memory.root, `${forged.grant.id}.json`), JSON.stringify(forged), {mode: 0o600});
  assert.equal(await memory.lookup(binding), null);
  assert.deepEqual(await memory.list(), []);

  // Even a known real grant ID is useless without the private owner key.
  const valid = await memory.remember(binding, "2h");
  const replacement = {...forged.grant, id: valid.id, binding_sha256: valid.id};
  await writeFile(join(memory.root, `${valid.id}.json`), JSON.stringify({
    grant: replacement,
    mac: createHmac("sha256", guess).update(JSON.stringify(replacement)).digest("hex"),
  }), {mode: 0o600});
  assert.equal(await memory.lookup(binding), null);
  assert.deepEqual(await memory.list(), []);
});

test("a legacy disk key is removed and cannot authenticate a grant", async t => {
  const f = await fixture(t), memory = f.make();
  await mkdir(memory.root, {recursive: true, mode: 0o700});
  const legacyKey = Buffer.alloc(32, 0x31), forged = forgedGrant(legacyKey, f.now());
  await writeFile(join(memory.root, "key"), legacyKey, {mode: 0o600});
  await writeFile(join(memory.root, `${forged.grant.id}.json`), JSON.stringify(forged), {mode: 0o600});

  assert.equal(await memory.lookup(binding), null);
  assert.deepEqual(await memory.list(), []);
  await assert.rejects(stat(join(memory.root, "key")), {code: "ENOENT"});
});

test("instances in one process share grants, but a new module owner cannot reuse them", async t => {
  const f = await fixture(t), first = f.make(), second = f.make();
  const grant = await first.remember(binding, "always");
  assert.equal((await second.lookup(binding)).id, grant.id);

  // A fresh module has a new private key, as a restarted owner process would.
  const {ApprovalMemory: FreshApprovalMemory} = await import(`../lib/approval-memory.mjs?fresh=${randomUUID()}`);
  const fresh = new FreshApprovalMemory({root: f.root, namespace: "ns", now: f.now});
  assert.equal(await fresh.lookup(binding), null);
  assert.deepEqual(await fresh.list(), []);
  assert.equal((await first.lookup(binding)).id, grant.id);
});

test("expired owner grants are swept", async t => {
  const f = await fixture(t), memory = f.make(), grant = await memory.remember(binding, "2h");
  const path = join(memory.root, `${grant.id}.json`);
  assert.equal((await readFile(path, "utf8")).length > 0, true);
  f.setNow(f.now() + 2 * 3600_000);
  assert.deepEqual(await memory.list(), []);
  await assert.rejects(stat(path), {code: "ENOENT"});
});

test("an unrelated malformed queue entry does not wedge the lock", async t => {
  const f = await fixture(t), memory = f.make();
  await mkdir(join(memory.root, "queue", "not-a-ticket"), {recursive: true, mode: 0o700});
  assert.deepEqual(await memory.list(), []);
  assert.equal((await memory.remember(binding, "2h")).duration, "2h");
});

test("list skips unverifiable records and stays bounded above 4096 files", {timeout: 30_000}, async t => {
  const f = await fixture(t), memory = f.make(), valid = await memory.remember(binding, "always");
  await writeFile(join(memory.root, `${"f".repeat(64)}.json`), "{invalid", {mode: 0o600});
  assert.deepEqual((await memory.list()).map(grant => grant.id), [valid.id]);

  for (let start = 0; start < 4098; start += 64) {
    await Promise.all(Array.from({length: Math.min(64, 4098 - start)}, (_, offset) => {
      const name = (start + offset).toString(16).padStart(64, "0");
      return writeFile(join(memory.root, `${name}.json`), "{}", {mode: 0o600});
    }));
  }
  // 4098 planted files sort before the genuine grant; it must still be listed.
  assert.deepEqual((await memory.list()).map(grant => grant.id), [valid.id]);
});

test("planted files cannot hide a genuine grant from list or revoke", {timeout: 30_000}, async t => {
  const f = await fixture(t), memory = f.make(), valid = await memory.remember(binding, "always");
  for (let start = 0; start < 5000; start += 100) {
    await Promise.all(Array.from({length: 100}, (_, offset) => {
      const name = (start + offset).toString(16).padStart(64, "0");
      return writeFile(join(memory.root, `${name}.json`), JSON.stringify({grant: {}, mac: "0".repeat(64)}), {mode: 0o600});
    }));
  }
  assert.deepEqual((await memory.list()).map(grant => grant.id), [valid.id]);
  await memory.revoke(valid.id);
  assert.deepEqual(await memory.list(), []);
  assert.equal(await memory.lookup(binding), null);
});

test("remember fails closed with a clear error when the live index is full", async t => {
  const f = await fixture(t), cap = 8;
  const {ApprovalMemory: Fresh, MAX_INDEXED_GRANTS} = await import(`../lib/approval-memory.mjs?full=${randomUUID()}`);
  assert.equal(MAX_INDEXED_GRANTS, 4096);
  assert.throws(() => new Fresh({root: f.root, namespace: "ns", maxGrants: MAX_INDEXED_GRANTS + 1}), /capacity_invalid/);
  const memory = new Fresh({root: f.root, namespace: "ns", now: f.now, maxGrants: cap});
  const bindingFor = n => ({...binding, invocation_sha256: n.toString(16).padStart(64, "0")});
  for (let n = 0; n < cap; n++) await memory.remember(bindingFor(n), n === 0 ? "always" : "2h");
  await assert.rejects(memory.remember(bindingFor(cap), "2h"), /approval_memory_full: 8 remembered approvals/);
  // Re-remembering an existing binding is not a new entry.
  assert.equal((await memory.remember(bindingFor(1), "2h")).duration, "2h");
  // Expired grants free capacity; the live "always" grant is never evicted.
  f.setNow(f.now() + 2 * 3600_000);
  assert.equal((await memory.remember(bindingFor(cap), "2h")).duration, "2h");
  assert.equal((await memory.lookup(bindingFor(0))).duration, "always");
});
