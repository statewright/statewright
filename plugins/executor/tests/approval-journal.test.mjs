import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, writeFile, stat, open, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const checkpoint = { run_id: "run", run_session_id: "gateway", state: "review",
  pending_approval: { approval_id: "apr_test", from_state: "review", to_state: "build" } };

test("unconsumed checkpoint cannot be replaced by a new run, session or ticket", async t => {
  const root = await mkdtemp(join(tmpdir(), "approval-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = approvalJournal(root, "client");
  await journal.save("thread", checkpoint);
  for (const change of [{ run_id: "other" }, { run_session_id: "other" },
    { pending_approval: { ...checkpoint.pending_approval, approval_id: "other" } },
    { pending_approval: { ...checkpoint.pending_approval, to_state: "deploy" } }]) {
    await assert.rejects(journal.save("thread", { ...checkpoint, ...change }), /checkpoint changed/);
    assert.deepEqual(await journal.load("thread"), checkpoint);
  }
  await journal.save("thread", checkpoint);
  await journal.clear("thread", "apr_test");
  await journal.save("thread", { ...checkpoint, run_id: "next" });
});

test("save never overwrites a corrupt checkpoint", async t => {
  const root = await mkdtemp(join(tmpdir(), "approval-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = approvalJournal(root, "client");
  await journal.save("thread", checkpoint);
  const path = join(root, (await readdir(root))[0]);
  await writeFile(path, "{}");
  await assert.rejects(journal.save("thread", checkpoint), /Invalid/);
  assert.equal(await readFile(path, "utf8"), "{}");
});

test("checkpoint bytes are synced before atomic publication and acknowledgement", async t => {
  const root = await mkdtemp(join(tmpdir(), "approval-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  const journal = approvalJournal(root, "client", { fileOps: {
    open: async (path, ...args) => {
      const file = await open(path, ...args);
      const kind = path === root ? "directory" : path.endsWith(".lock") ? "lock" : "checkpoint";
      return { writeFile: async data => { events.push(`${kind}:write`); await file.writeFile(data); },
        sync: async () => { events.push(`${kind}:sync`); await file.sync(); },
        close: async () => { events.push(`${kind}:close`); await file.close(); } };
    },
    rename: async (...args) => { events.push("publish"); await rename(...args); },
  } });
  await journal.save("thread", checkpoint);
  assert.ok(events.indexOf("checkpoint:sync") < events.indexOf("publish"));
  if (process.platform !== "win32") assert.ok(events.indexOf("directory:sync") > events.indexOf("publish"));
  events.length = 0;
  await journal.save("thread", checkpoint);
  assert.ok(events.includes("checkpoint:sync"));
  assert.deepEqual(await journal.load("thread"), checkpoint);
});

for (const phase of ["sync", "publish"]) test(`${phase} failure is not an acknowledged park and leaves no temporary files`, async t => {
  const root = await mkdtemp(join(tmpdir(), "approval-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = approvalJournal(root, "client", { fileOps: {
    open: async (path, ...args) => {
      const file = await open(path, ...args);
      return { writeFile: data => file.writeFile(data), close: () => file.close(),
        sync: async () => { if (phase === "sync") throw new Error("disk sync failed"); await file.sync(); } };
    },
    rename: async (...args) => { if (phase === "publish") throw new Error("disk publish failed"); await rename(...args); },
  } });
  await assert.rejects(journal.save("thread", checkpoint), /disk/);
  assert.deepEqual(await readdir(root), []);
});

test("competing park and clear cannot delete or replace an in-flight checkpoint", async t => {
  const root = await mkdtemp(join(tmpdir(), "approval-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let publishStarted;
  const started = new Promise(resolve => { publishStarted = resolve; });
  let releasePublish;
  const release = new Promise(resolve => { releasePublish = resolve; });
  const first = approvalJournal(root, "client", { fileOps: {
    rename: async (...args) => { publishStarted(); await release; await rename(...args); },
  } });
  const saving = first.save("thread", checkpoint);
  await started;
  const second = approvalJournal(root, "client");
  try {
    await assert.rejects(second.clear("thread", "apr_test"), /locked/);
    await assert.rejects(second.save("thread", { ...checkpoint, run_id: "other" }), /locked/);
  } finally { releasePublish(); await saving; }
  assert.deepEqual(await second.load("thread"), checkpoint);
});

test("late clear cannot delete a new park during the old clear's critical section", async t => {
  const root = await mkdtemp(join(tmpdir(), "approval-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let deleteStarted;
  const started = new Promise(resolve => { deleteStarted = resolve; });
  let releaseDelete;
  const release = new Promise(resolve => { releaseDelete = resolve; });
  const first = approvalJournal(root, "client", { fileOps: {
    unlink: async path => { await unlink(path); if (path.endsWith(".json")) { deleteStarted(); await release; } },
  } });
  await first.save("thread", checkpoint);
  const clearing = first.clear("thread", "apr_test");
  await started;
  const second = approvalJournal(root, "client");
  try {
    await assert.rejects(second.save("thread", { ...checkpoint, run_id: "next" }), /locked/);
    await assert.rejects(second.clear("thread", "apr_test"), /locked/);
  } finally { releaseDelete(); await clearing; }
  await second.save("thread", { ...checkpoint, run_id: "next" });
  assert.equal((await second.load("thread")).run_id, "next");
});

test("a separate process cannot mutate a checkpoint while publication holds the lock", async t => {
  const root = await mkdtemp(join(tmpdir(), "approval-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let publishStarted;
  const started = new Promise(resolve => { publishStarted = resolve; });
  let releasePublish;
  const release = new Promise(resolve => { releasePublish = resolve; });
  const journal = approvalJournal(root, "client", { fileOps: {
    rename: async (...args) => { publishStarted(); await release; await rename(...args); },
  } });
  const saving = journal.save("thread", checkpoint);
  await started;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
      const { approvalJournal } = await import(process.argv[2]);
      const journal = approvalJournal(process.argv[1], "client");
      let denied = 0;
      for (const operation of [() => journal.clear("thread", "apr_test"),
        () => journal.save("thread", { run_id: "other", run_session_id: "gateway",
          pending_approval: { approval_id: "other" } })]) {
        try { await operation(); throw new Error("unexpected mutation"); }
        catch (error) { if (!/journal is locked/.test(error.message)) throw error; denied++; }
      }
      console.log(JSON.stringify({ denied }));
    `, root, new URL("../lib/approval-journal.mjs", import.meta.url).href], { timeout: 10_000 });
    assert.deepEqual(JSON.parse(stdout), { denied: 2 });
  } finally { releasePublish(); await saving; }
  assert.deepEqual(await journal.load("thread"), checkpoint);
});
