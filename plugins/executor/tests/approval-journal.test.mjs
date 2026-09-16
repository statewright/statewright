import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalJournal } from "../lib/approval-journal.mjs";

test("approval journal survives supervisor restart and isolates client and thread", async t => {
  const root = await mkdtemp(join(tmpdir(), "approval-test-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const state = {run_id: "run", run_session_id: "gateway", state: "review", pending_approval: {approval_id: "apr_test"}};
  await approvalJournal(root, "client").save("thread", state);
  assert.deepEqual(await approvalJournal(root, "client").load("thread"), state);
  assert.equal(await approvalJournal(root, "other").load("thread"), null);
  assert.equal(await approvalJournal(root, "client").load("other"), null);
  assert.equal((await stat(join(root, (await readdir(root))[0]))).mode & 0o777, 0o600);
  await assert.rejects(approvalJournal(root, "client").clear("thread", "wrong"));
  await approvalJournal(root, "client").clear("thread", "apr_test");
  assert.equal(await approvalJournal(root, "client").load("thread"), null);
});

test("corrupt approval journal fails closed", async t => {
  const root = await mkdtemp(join(tmpdir(), "approval-test-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const journal = approvalJournal(root, "client");
  await journal.save("thread", {run_id: "run", run_session_id: "gateway", pending_approval: {approval_id: "apr_test"}});
  await writeFile(join(root, (await readdir(root))[0]), "{}");
  await assert.rejects(journal.load("thread"), /Invalid approval checkpoint/);
});

for (const [label, mutate] of [
  ["foreign client", value => ({ ...value, clientId: "foreign" })],
  ["foreign thread", value => ({ ...value, threadId: "foreign" })],
  ["foreign version", value => ({ ...value, version: 2 })],
  ["non-string run", value => ({ ...value, state: { ...value.state, run_id: 1 } })],
  ["non-string session", value => ({ ...value, state: { ...value.state, run_session_id: {} } })],
  ["non-string approval", value => ({ ...value, state: { ...value.state, pending_approval: { approval_id: [] } } })],
  ["null checkpoint", () => null],
]) test(`journal denies ${label} on load and clear without deleting the checkpoint`, async t => {
  const root = await mkdtemp(join(tmpdir(), "approval-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = approvalJournal(root, "client");
  await journal.save("thread", { run_id: "run", run_session_id: "gateway", pending_approval: { approval_id: "apr_test" } });
  const file = join(root, (await readdir(root))[0]);
  const raw = JSON.stringify(mutate(JSON.parse(await readFile(file, "utf8"))));
  await writeFile(file, raw);
  await assert.rejects(journal.load("thread"), /Invalid approval checkpoint/);
  await assert.rejects(journal.clear("thread", "apr_test"), /Invalid approval checkpoint/);
  assert.equal(await readFile(file, "utf8"), raw);
});

test("invalid JSON fails closed without deleting the journal", async t => {
  const root = await mkdtemp(join(tmpdir(), "approval-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = approvalJournal(root, "client");
  await journal.save("thread", { run_id: "run", run_session_id: "gateway", pending_approval: { approval_id: "apr_test" } });
  const file = join(root, (await readdir(root))[0]);
  await writeFile(file, "{broken");
  await assert.rejects(journal.load("thread"), SyntaxError);
  await assert.rejects(journal.clear("thread", "apr_test"), SyntaxError);
  assert.equal(await readFile(file, "utf8"), "{broken");
});

test("save rejects incomplete or malformed checkpoint identities", async t => {
  const root = await mkdtemp(join(tmpdir(), "approval-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = approvalJournal(root, "client");
  const state = { run_id: "run", run_session_id: "gateway", pending_approval: { approval_id: "apr_test" } };
  for (const key of ["run_id", "run_session_id"]) {
    for (const value of [undefined, "", null, 1, {}]) {
      await assert.rejects(journal.save("thread", { ...state, [key]: value }), /Incomplete approval checkpoint/);
    }
  }
  for (const approval_id of [undefined, "", null, 1, {}]) {
    await assert.rejects(journal.save("thread", { ...state, pending_approval: { approval_id } }), /Incomplete approval checkpoint/);
  }
  assert.deepEqual(await readdir(root), []);
});
