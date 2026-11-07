import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readCodexResumePermissions } from "../lib/codex-session-metadata.mjs";
import {
  guardCodexResumeHistory,
  inspectCodexHistory,
  resolveCodexHistoryStorage,
  withCodexWriterLock,
} from "../lib/codex-history-integrity.mjs";

const SESSION_ID = "01a0531f-2295-7852-b575-f9d4c2c1201b";

function codexTestEnvironment(overrides = {}) {
  const environment = { ...process.env };
  delete environment.CODEX_HOME;
  delete environment.CODEX_SQLITE_HOME;
  return { ...environment, ...overrides };
}

function record(ordinal, type, payload) {
  return JSON.stringify({ timestamp: "2026-08-30T00:00:00.000Z", ordinal, type, payload });
}

function legacyRecord(type, payload) {
  return JSON.stringify({ timestamp: "2026-08-30T00:00:00.000Z", type, payload });
}

async function writeRollout(home, lines, sessionId = SESSION_ID) {
  const path = join(home, ".codex", "sessions", "2026", "08", "30", `rollout-2026-08-30T00-00-00-${sessionId}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  return path;
}

async function writeCompressedRollout(home, lines) {
  const canonical = await writeRollout(home, lines);
  const { zstdCompressSync } = await import("node:zlib");
  await writeFile(`${canonical}.zst`, zstdCompressSync(await readFile(canonical)), { mode: 0o600 });
  await rm(canonical);
  return { archive: `${canonical}.zst`, canonical };
}

function createProjectionAt(path) {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE thread_history_projection_state (
      thread_id TEXT PRIMARY KEY,
      next_rollout_byte_offset INTEGER NOT NULL,
      next_rollout_ordinal INTEGER NOT NULL
    );
    CREATE TABLE thread_items (thread_id TEXT NOT NULL, item_id TEXT NOT NULL);
    CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL);
    CREATE TABLE thread_realtime_items (thread_id TEXT NOT NULL, item_id TEXT NOT NULL);
    CREATE TRIGGER thread_realtime_items_projection_cleanup
      AFTER DELETE ON thread_history_projection_state
      BEGIN DELETE FROM thread_realtime_items WHERE thread_id = OLD.thread_id; END;
  `);
  const ids = [SESSION_ID, "other-thread"];
  for (const id of ids) {
    database.prepare("INSERT INTO thread_history_projection_state VALUES (?, 100, 2)").run(id);
    database.prepare("INSERT INTO thread_items VALUES (?, ?)").run(id, `${id}-item`);
    database.prepare("INSERT INTO thread_turns VALUES (?, ?)").run(id, `${id}-turn`);
    database.prepare("INSERT INTO thread_realtime_items VALUES (?, ?)").run(id, `${id}-realtime`);
  }
  database.close();
  return path;
}

function createProjection(home) {
  return createProjectionAt(join(home, ".codex", "thread_history_1.sqlite"));
}

function waitForLine(child, expected) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${expected}`)), 2_000);
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes(`${expected}\n`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

const duplicateSettingsRollout = () => [
  record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" }),
  record(1, "event_msg", { type: "token_count" }),
  record(1, "event_msg", { type: "thread_settings_applied", thread_settings: { model: "gpt-test" } }),
  record(2, "event_msg", { type: "task_complete" }),
];

const PARENT_ID = "01a0531f-2295-7852-b575-f9d4c2c1201c";

test("JSONL Unicode separators are content, including across UTF-8 stream boundaries", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-unicode-"));
  try {
    const root = record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated", cwd: "/fixture/project" });
    const empty = record(1, "event_msg", { text: "" });
    const textOffset = Buffer.byteLength(`${root}\n${empty.slice(0, empty.indexOf('"text":"') + 8)}`);
    for (const separator of ["\u2028", "\u2029"]) {
      for (const boundaryOffset of [-1, -2, 0]) {
        const text = "x".repeat(65536 + boundaryOffset - textOffset) + separator + "é😀".repeat(20000) + separator;
        const path = await writeRollout(home, [root, record(1, "event_msg", { text }),
          record(2, "turn_context", { approval_policy: "never", sandbox_policy: { type: "danger-full-access" } }),
          record(3, "event_msg", { type: "thread_settings_applied", thread_id: SESSION_ID, thread_settings: {
            approval_policy: "on-request", approvals_reviewer: "user", sandbox_policy: { type: "read-only" }, cwd: "/fixture/project",
          } }),
        ]);
        const before = await readFile(path);
        assert.equal(before.indexOf(Buffer.from(separator)), 65536 + boundaryOffset);
        const inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
        assert.equal(inspection.status, "healthy");
        assert.equal(inspection.lineCount, 4);
        assert.equal(inspection.sourceSha256, inspection.repairedSha256);
        assert.deepEqual(await guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "guard", environment: codexTestEnvironment() }), { status: "healthy", finalOrdinal: 3 });
        assert.deepEqual(await readCodexResumePermissions({ home, threadId: SESSION_ID }), {
          sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user", cwd: "/fixture/project",
        });
        assert.deepEqual(await readFile(path), before);
        await assert.rejects(access(join(home, ".codex", "backups")));
      }
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("JSONL rejects noncanonical separators and malformed records without loosening framing", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-framing-"));
  try {
    const rows = [record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" }), record(1, "event_msg", { text: "safe" })];
    const path = await writeRollout(home, rows);
    for (const content of [rows.join("\r\n") + "\r\n", rows.join("\r") + "\r", rows.join("\u2028") + "\n", rows.join("\u2029") + "\n", rows.join("\n"), rows.join("\n\n") + "\n", rows.join("\n") + "\n{broken}\n"]) {
      await writeFile(path, content);
      assert.equal((await inspectCodexHistory({ home, sessionId: SESSION_ID })).status, "unsafe");
      assert.equal(await readFile(path, "utf8"), content);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("duplicate-settings repair preserves Unicode content byte-for-byte", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-unicode-repair-"));
  try {
    const rows = duplicateSettingsRollout();
    rows[1] = record(1, "event_msg", { text: "before\u2028between\u2029after" });
    const path = await writeRollout(home, rows);
    createProjection(home);
    assert.equal((await guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "repair", environment: codexTestEnvironment() })).status, "repaired");
    assert.equal(await readFile(path, "utf8"), `${[rows[0], rows[1], rows[3]].join("\n")}\n`);
  } finally { await rm(home, { recursive: true, force: true }); }
});

async function writeFork(home, overrides = {}, parentLines = null) {
  const lines = parentLines ?? [
    record(0, "session_meta", { id: PARENT_ID, history_mode: "paginated" }),
    record(1, "event_msg", { type: "task_complete", text: "inherited\u2028content\u2029" }),
  ];
  const parent = await writeRollout(home, lines, PARENT_ID);
  const base = { thread_id: PARENT_ID, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(`${lines.join("\n")}\n`) };
  const metadata = { id: SESSION_ID, history_mode: "paginated", forked_from_id: PARENT_ID, forked_from_ordinal_exclusive: 2, history_base: base, ...overrides };
  const child = await writeRollout(home, [record(2, "session_meta", metadata), record(3, "event_msg", { type: "task_complete" })]);
  return { parent, child, base };
}

async function compressExistingRollout(path) {
  const { zstdCompressSync } = await import("node:zlib");
  const bytes = await readFile(path);
  await writeFile(`${path}.zst`, zstdCompressSync(bytes), { mode: 0o600 });
  await rm(path);
  return bytes;
}

for (const compressedChild of [false, true]) {
  test(`fork resume recovers a compressed parent with ${compressedChild ? "compressed" : "uncompressed"} child history`, async () => {
    const home = await mkdtemp(join(tmpdir(), "statewright-history-archived-parent-"));
    try {
      const { parent, child } = await writeFork(home);
      const parentBefore = await compressExistingRollout(parent);
      const archiveBefore = await readFile(`${parent}.zst`);
      const childBefore = compressedChild ? await compressExistingRollout(child) : await readFile(child);
      const locks = [];
      const result = await guardCodexResumeHistory({
        home, sessionId: SESSION_ID, mode: "auto", environment: codexTestEnvironment(),
        withWriterLock: async ({ sessionId }, operation) => { locks.push(sessionId); return operation(); },
      });
      assert.deepEqual(result, { status: "healthy", finalOrdinal: 3 });
      assert(locks.includes(SESSION_ID));
      assert(locks.includes(PARENT_ID));
      assert.deepEqual(await readFile(child), childBefore);
      assert.deepEqual(await readFile(parent), parentBefore);
      assert.deepEqual(await readFile(`${parent}.zst`), archiveBefore);
      assert.equal((await inspectCodexHistory({ home, sessionId: SESSION_ID })).status, "healthy");
      await assert.rejects(access(join(home, ".codex", "backups")));
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test("compressed parent recovery respects guard mode and declined consent", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-archived-parent-consent-"));
  try {
    const { parent, child } = await writeFork(home);
    await compressExistingRollout(parent);
    const before = await readFile(child);
    await assert.rejects(guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "guard", environment: codexTestEnvironment() }),
      error => error.code === "CODEX_HISTORY_ARCHIVE_MATERIALIZATION_REQUIRED");
    let prompts = 0;
    await assert.rejects(guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "prompt", environment: codexTestEnvironment(),
      confirmRepair: async ({ message }) => { prompts++; assert.match(message, /parent|ancestor/i); return false; },
    }), error => error.code === "CODEX_HISTORY_REPAIR_DECLINED");
    assert.equal(prompts, 1);
    assert.deepEqual(await readFile(child), before);
    await assert.rejects(access(parent));
    await access(`${parent}.zst`);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("compressed ancestor chains recover with real writer locks and preserve projection rows", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-archived-chain-"));
  const grandparentId = "01a0531f-2295-7852-b575-f9d4c2c1201d";
  try {
    const root = record(0, "session_meta", { id: grandparentId, history_mode: "paginated" });
    const grandparent = await writeRollout(home, [root], grandparentId);
    const history_base = { thread_id: grandparentId, end_ordinal_exclusive: 1, end_byte_offset: Buffer.byteLength(root + "\n") };
    const { parent, child } = await writeFork(home, {}, [record(1, "session_meta", { id: PARENT_ID, history_mode: "paginated", history_base })]);
    const before = await Promise.all([readFile(child), compressExistingRollout(parent), compressExistingRollout(grandparent)]);
    const projection = createProjection(home);
    const prompts = [];
    const result = await guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "prompt", environment: codexTestEnvironment(),
      confirmRepair: async ({ inspection }) => { prompts.push(inspection.compressedHistoryBase.thread_id); return true; },
    });
    assert.deepEqual(result, { status: "healthy", finalOrdinal: 3 });
    assert.equal(prompts.length, 2);
    assert.deepEqual(prompts, [PARENT_ID, grandparentId]);
    assert.deepEqual(await Promise.all([readFile(child), readFile(parent), readFile(grandparent)]), before);
    const database = new DatabaseSync(projection, { readOnly: true });
    try { assert.equal(database.prepare("SELECT count(*) AS count FROM thread_history_projection_state").get().count, 2); }
    finally { database.close(); }
    await Promise.all([access(`${parent}.zst`), access(`${grandparent}.zst`)]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("compressed parent recovery rejects malformed, foreign, ambiguous and mismatched archives", async () => {
  for (const scenario of ["malformed", "foreign", "ambiguous", "truncated", "prefix boundary", "unsafe child"]) {
    const home = await mkdtemp(join(tmpdir(), "statewright-history-archived-parent-invalid-"));
    try {
      const { parent, child } = await writeFork(home);
      if (scenario === "malformed") await appendFile(parent, "{broken}\n");
      if (scenario === "foreign") await writeFile(parent, (await readFile(parent, "utf8")).replace(PARENT_ID, SESSION_ID));
      if (scenario === "prefix boundary") {
        const rows = (await readFile(child, "utf8")).trimEnd().split("\n");
        const root = JSON.parse(rows[0]);
        root.payload.history_base.end_byte_offset--;
        rows[0] = JSON.stringify(root);
        await writeFile(child, rows.join("\n") + "\n");
      }
      if (scenario === "unsafe child") await writeFile(child, (await readFile(child, "utf8")).replace('"ordinal":3', '"ordinal":5'));
      await compressExistingRollout(parent);
      if (scenario === "truncated") {
        const bytes = await readFile(`${parent}.zst`);
        await writeFile(`${parent}.zst`, bytes.subarray(0, bytes.length - 1));
      }
      if (scenario === "ambiguous") {
        const other = join(dirname(parent), "other", basename(parent) + ".zst");
        await mkdir(dirname(other));
        await writeFile(other, await readFile(`${parent}.zst`));
      }
      const before = await Promise.all([readFile(child), readFile(`${parent}.zst`)]);
      await assert.rejects(guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "auto", environment: codexTestEnvironment(),
        withWriterLock: async (_options, operation) => operation(),
      }), error => ["CODEX_HISTORY_UNSAFE", "CODEX_HISTORY_AMBIGUOUS", "CODEX_HISTORY_ARCHIVE_MATERIALIZATION_FAILED"].includes(error.code), scenario);
      assert.deepEqual(await Promise.all([readFile(child), readFile(`${parent}.zst`)]), before, scenario);
      await assert.rejects(access(parent), scenario);
      assert(!(await readdir(dirname(parent))).some(name => name.includes("statewright-hydrate")), scenario);
    } finally { await rm(home, { recursive: true, force: true }); }
  }
});

test("compressed parent recovery rejects requested history changes during consent or installation", async () => {
  for (const changeAt of ["consent", "install"]) {
    const home = await mkdtemp(join(tmpdir(), "statewright-history-archived-parent-race-"));
    try {
      const { parent, child } = await writeFork(home);
      await compressExistingRollout(parent);
      const archive = await readFile(`${parent}.zst`);
      const change = () => appendFile(child, record(4, "event_msg", { type: "task_complete" }) + "\n");
      await assert.rejects(guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "prompt", environment: codexTestEnvironment(),
        confirmRepair: async () => { if (changeAt === "consent") await change(); return true; },
        withWriterLock: async (_options, operation) => operation(),
        repairOperations: { beforeArchiveInstall: async () => { if (changeAt === "install") await change(); } },
      }), error => error.code === "CODEX_HISTORY_SOURCE_CHANGED");
      await assert.rejects(access(parent));
      assert.deepEqual(await readFile(`${parent}.zst`), archive);
    } finally { await rm(home, { recursive: true, force: true }); }
  }
});

test("compressed parent recovery refuses an active ancestor writer", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-archived-parent-writer-"));
  try {
    const { parent, child } = await writeFork(home);
    await compressExistingRollout(parent);
    const before = await readFile(child);
    await withCodexWriterLock({ home, sessionId: PARENT_ID }, async () => {
      await assert.rejects(guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "auto", environment: codexTestEnvironment() }),
        error => error.code === "CODEX_HISTORY_ACTIVE_WRITER");
    });
    await withCodexWriterLock({ home, sessionId: SESSION_ID }, async () => {});
    assert.deepEqual(await readFile(child), before);
    await assert.rejects(access(parent));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("compressed ancestor recovery rechecks an existing inherited prefix before publishing", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-archived-prefix-race-"));
  const grandparentId = "01a0531f-2295-7852-b575-f9d4c2c1201d";
  try {
    const root = record(0, "session_meta", { id: grandparentId, history_mode: "paginated" });
    const grandparent = await writeRollout(home, [root], grandparentId);
    const history_base = { thread_id: grandparentId, end_ordinal_exclusive: 1, end_byte_offset: Buffer.byteLength(root + "\n") };
    const { parent, child } = await writeFork(home, {}, [record(1, "session_meta", { id: PARENT_ID, history_mode: "paginated", history_base })]);
    await compressExistingRollout(grandparent);
    const childBefore = await readFile(child);
    await assert.rejects(guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "auto", environment: codexTestEnvironment(),
      withWriterLock: async (_options, operation) => operation(),
      repairOperations: { beforeArchiveInstall: async () => {
        await writeFile(parent, (await readFile(parent, "utf8")).replace(PARENT_ID, SESSION_ID));
      } },
    }), error => error.code === "CODEX_HISTORY_SOURCE_CHANGED");
    assert.deepEqual(await readFile(child), childBefore);
    await assert.rejects(access(grandparent));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("fork resume validates the inherited prefix and preserves both histories byte-for-byte", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-fork-"));
  try {
    const { parent, child } = await writeFork(home);
    // A later parent tail is not part of this fork's immutable prefix.
    await appendFile(parent, "not part of the inherited prefix\n");
    const before = await Promise.all([readFile(parent), readFile(child)]);
    const inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "healthy");
    assert.equal(inspection.finalOrdinal, 3);
    assert.equal(inspection.historyBase.end_ordinal_exclusive, 2);
    assert.deepEqual(await guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "guard", environment: codexTestEnvironment() }), { status: "healthy", finalOrdinal: 3 });
    assert.deepEqual(await Promise.all([readFile(parent), readFile(child)]), before);
    await assert.rejects(access(join(home, ".codex", "backups")));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("fork history rejects malformed, mismatched, missing and cyclic ancestry without repair", async () => {
  const variants = [
    ["wrong parent", { forked_from_id: SESSION_ID }],
    ["wrong fork ordinal", { forked_from_ordinal_exclusive: 1 }],
    ["invalid base", { history_base: "not a base" }],
    ["negative offset", { history_base: { thread_id: PARENT_ID, end_ordinal_exclusive: 2, end_byte_offset: -1 } }],
    ["mid-record offset", { history_base: { thread_id: PARENT_ID, end_ordinal_exclusive: 2, end_byte_offset: 10 } }],
    ["beyond parent EOF", { history_base: { thread_id: PARENT_ID, end_ordinal_exclusive: 2, end_byte_offset: 99999 } }],
    ["wrong start", { history_base: { thread_id: PARENT_ID, end_ordinal_exclusive: 3, end_byte_offset: 100 }, forked_from_ordinal_exclusive: 3 }],
    ["missing parent", null],
    ["parent identity mismatch", null],
    ["parent ordinal gap", null],
    ["cycle", null],
  ];
  for (const [name, overrides] of variants) {
    const home = await mkdtemp(join(tmpdir(), "statewright-history-fork-invalid-"));
    try {
      const { parent, child } = await writeFork(home, overrides ?? {});
      if (name === "missing parent") await rm(parent);
      if (name === "parent identity mismatch") await writeFile(parent, (await readFile(parent, "utf8")).replace(PARENT_ID, SESSION_ID));
      if (name === "parent ordinal gap") await writeFile(parent, (await readFile(parent, "utf8")).replace('"ordinal":1', '"ordinal":5'));
      if (name === "cycle") await writeFork(home, { history_base: { thread_id: SESSION_ID, end_ordinal_exclusive: 2, end_byte_offset: 100 }, forked_from_id: SESSION_ID });
      const before = await readFile(child);
      assert.equal((await inspectCodexHistory({ home, sessionId: SESSION_ID })).status, "unsafe", name);
      await assert.rejects(guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "auto", environment: codexTestEnvironment() }), /not safe for automatic repair/, name);
      assert.deepEqual(await readFile(child), before, name);
      await assert.rejects(access(join(home, ".codex", "backups")));
    } finally { await rm(home, { recursive: true, force: true }); }
  }
});

test("nested forks validate every referenced prefix and reject a foreign ancestor", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-fork-chain-"));
  const grandparentId = "01a0531f-2295-7852-b575-f9d4c2c1201d";
  try {
    const grandparentRows = [record(0, "session_meta", { id: grandparentId, history_mode: "paginated" })];
    const grandparent = await writeRollout(home, grandparentRows, grandparentId);
    const ancestorBase = { thread_id: grandparentId, end_ordinal_exclusive: 1, end_byte_offset: Buffer.byteLength(`${grandparentRows[0]}\n`) };
    await writeFork(home, {}, [record(1, "session_meta", { id: PARENT_ID, history_mode: "paginated", history_base: ancestorBase })]);
    assert.equal((await inspectCodexHistory({ home, sessionId: SESSION_ID })).status, "healthy");
    await writeFile(grandparent, (await readFile(grandparent, "utf8")).replace(grandparentId, PARENT_ID));
    const invalid = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(invalid.status, "unsafe");
    assert.equal(invalid.unknownAnomalies.at(-1).kind, "history_base_prefix_invalid");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("fork local suffix gaps still fail closed and known duplicate repair retains base metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-fork-repair-"));
  try {
    const { parent, child } = await writeFork(home);
    const parentBefore = await readFile(parent);
    const original = await readFile(child, "utf8");
    await writeFile(child, original.replace('"ordinal":3', '"ordinal":5'));
    assert.equal((await inspectCodexHistory({ home, sessionId: SESSION_ID })).status, "unsafe");
    await writeFile(child, `${original}${record(3, "event_msg", { type: "thread_settings_applied" })}\n`);
    createProjection(home);
    const result = await guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "repair", environment: codexTestEnvironment() });
    assert.equal(result.status, "repaired");
    assert.equal(result.finalOrdinal, 3);
    assert.equal(await readFile(child, "utf8"), original);
    assert.deepEqual(await readFile(parent), parentBefore);
    assert.equal((await inspectCodexHistory({ home, sessionId: SESSION_ID })).status, "healthy");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("fork repair rechecks inherited prefixes before child replacement", async () => {
  for (const changePrefix of [true, false]) {
    const home = await mkdtemp(join(tmpdir(), "statewright-history-fork-cas-"));
    try {
      const { parent, child } = await writeFork(home);
      await appendFile(child, `${record(3, "event_msg", { type: "thread_settings_applied" })}\n`);
      const before = await readFile(child);
      const projection = createProjection(home);
      const repair = guardCodexResumeHistory({
        home, sessionId: SESSION_ID, mode: "repair", environment: codexTestEnvironment(),
        repairOperations: { beforeCompareAndSwap: async () => {
          if (changePrefix) await writeFile(parent, (await readFile(parent, "utf8")).replace(PARENT_ID, SESSION_ID));
          else await appendFile(parent, `${record(2, "event_msg", { type: "task_complete" })}\n`);
        } },
      });
      if (changePrefix) {
        await assert.rejects(repair, /Inherited Codex history changed/);
        assert.deepEqual(await readFile(child), before);
        const database = new DatabaseSync(projection);
        try { assert.equal(database.prepare("SELECT count(*) AS count FROM thread_history_projection_state WHERE thread_id = ?").get(SESSION_ID).count, 1); }
        finally { database.close(); }
      } else assert.equal((await repair).status, "repaired");
    } finally { await rm(home, { recursive: true, force: true }); }
  }
});

test("malformed fork records never enter standalone partial-write repair", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-fork-partial-"));
  try {
    const { child } = await writeFork(home, { history_base: { thread_id: PARENT_ID, end_ordinal_exclusive: 0, end_byte_offset: 100 }, forked_from_ordinal_exclusive: 0 });
    await writeFile(child, `${record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated", history_base: { thread_id: PARENT_ID, end_ordinal_exclusive: 0, end_byte_offset: 100 } })}\n${record(1, "event_msg", { type: "task_complete" }).replace('"event_msg"', '"event_\nmsg"')}\n`);
    const before = await readFile(child);
    await assert.rejects(guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "auto", environment: codexTestEnvironment() }), /not safe for automatic repair/);
    assert.deepEqual(await readFile(child), before);
    await assert.rejects(access(join(home, ".codex", "backups")));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("inspection classifies only repeated restart settings as safely repairable", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-inspect-"));
  try {
    await writeRollout(home, duplicateSettingsRollout());
    const inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "repairable");
    assert.equal(inspection.duplicateSettingsCount, 1);
    assert.equal(inspection.unknownAnomalies.length, 0);
    assert.equal(inspection.finalOrdinal, 2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("repair mode validates and materializes one compressed canonical rollout without deleting its archive", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-zstd-"));
  try {
    const { archive, canonical } = await writeCompressedRollout(home, [
      record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" }),
      record(1, "event_msg", { type: "task_complete" }),
    ]);
    const result = await guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "repair", environment: codexTestEnvironment() });
    assert.equal(result.status, "healthy");
    assert.equal((await inspectCodexHistory({ home, sessionId: SESSION_ID })).status, "healthy");
    assert.equal(await readFile(canonical, "utf8"), `${record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" })}\n${record(1, "event_msg", { type: "task_complete" })}\n`);
    assert.ok(await stat(archive));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("guard mode refuses compressed history without materializing it", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-zstd-guard-"));
  try {
    const { canonical } = await writeCompressedRollout(home, [
      record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" }),
    ]);
    await assert.rejects(
      guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "guard", environment: codexTestEnvironment() }),
      error => error?.code === "CODEX_HISTORY_ARCHIVE_MATERIALIZATION_REQUIRED",
    );
    await assert.rejects(stat(canonical));
  } finally { await rm(home, { recursive: true, force: true }); }
});

for (const scenario of ["corrupt", "truncated", "wrong-thread", "bad-ordinal", "oversize", "expansion", "source-changed", "no-clobber", "cancelled"]) {
  test(`compressed history refuses ${scenario} and retains the archive`, async () => {
    const home = await mkdtemp(join(tmpdir(), "statewright-history-archive-refusal-"));
    try {
      const lines = [
        record(0, "session_meta", { id: scenario === "wrong-thread" ? "foreign" : SESSION_ID, history_mode: "paginated" }),
        record(scenario === "bad-ordinal" ? 4 : 1, "event_msg", { type: "task_complete" }),
      ];
      const { archive, canonical } = await writeCompressedRollout(home, lines);
      if (scenario === "corrupt") await writeFile(archive, "not zstd");
      if (scenario === "truncated") {
        const bytes = await readFile(archive);
        await writeFile(archive, bytes.subarray(0, bytes.length - 4));
      }
      const original = await readFile(archive);
      let cancelled = false;
      const repairOperations = {
        ...(scenario === "oversize" ? { maxCompressedBytes: 1 } : {}),
        ...(scenario === "expansion" ? { maxMaterializedBytes: 1 } : {}),
        beforeArchiveInstall: async () => {
          if (scenario === "source-changed") await appendFile(archive, "changed");
          if (scenario === "no-clobber") await writeFile(canonical, "other writer");
          if (scenario === "cancelled") cancelled = true;
        },
      };
      const codes = {
        corrupt: "CODEX_HISTORY_ARCHIVE_MATERIALIZATION_FAILED", truncated: "CODEX_HISTORY_ARCHIVE_MATERIALIZATION_FAILED",
        "wrong-thread": "CODEX_HISTORY_UNSAFE", "bad-ordinal": "CODEX_HISTORY_UNSAFE",
        oversize: "CODEX_HISTORY_ARCHIVE_TOO_LARGE", expansion: "CODEX_HISTORY_ARCHIVE_EXPANSION_LIMIT",
        "source-changed": "CODEX_HISTORY_SOURCE_CHANGED", "no-clobber": "CODEX_HISTORY_SOURCE_CHANGED", cancelled: "STATEWRIGHT_SUPERSEDED",
      };
      await assert.rejects(guardCodexResumeHistory({
        home, sessionId: SESSION_ID, mode: "repair", environment: codexTestEnvironment(), repairOperations,
        checkCurrentRequest: () => { if (cancelled) throw Object.assign(new Error("request disconnected"), { code: "STATEWRIGHT_SUPERSEDED" }); },
      }), error => error.code === codes[scenario]);
      if (scenario === "no-clobber") assert.equal(await readFile(canonical, "utf8"), "other writer");
      else await assert.rejects(stat(canonical));
      if (scenario !== "source-changed") assert.deepEqual(await readFile(archive), original);
      assert.ok(!(await readdir(dirname(canonical))).some(name => name.includes(".statewright-hydrate-")));
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test("archive selection is rechecked under the writer lock and ambiguous candidates are refused", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-archive-race-"));
  try {
    const { archive, canonical } = await writeCompressedRollout(home, [record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" })]);
    const options = { home, sessionId: SESSION_ID, mode: "repair", environment: codexTestEnvironment() };
    const second = join(dirname(archive), `rollout-2026-08-30T01-00-00-${SESSION_ID}.jsonl.zst`);
    await assert.rejects(guardCodexResumeHistory({ ...options,
      withWriterLock: async (_options, action) => { await writeFile(second, await readFile(archive)); return action(); },
    }), error => error.code === "CODEX_HISTORY_SOURCE_CHANGED");
    await assert.rejects(guardCodexResumeHistory(options), error => error.code === "CODEX_HISTORY_AMBIGUOUS");
    await assert.rejects(stat(canonical));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("archive recovery honors declined consent and a disconnected requester before acquiring the writer", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-archive-consent-"));
  try {
    const { canonical } = await writeCompressedRollout(home, [record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" })]);
    await assert.rejects(guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "prompt", environment: codexTestEnvironment(), confirmRepair: async () => false }), error => error.code === "CODEX_HISTORY_REPAIR_DECLINED");
    let cancelled = false;
    await assert.rejects(guardCodexResumeHistory({
      home, sessionId: SESSION_ID, mode: "repair", environment: codexTestEnvironment(),
      checkCurrentRequest: () => { if (cancelled) throw Object.assign(new Error("disconnected"), { code: "STATEWRIGHT_SUPERSEDED" }); },
      withWriterLock: async (_options, action) => { cancelled = true; return action(); },
    }), error => error.code === "STATEWRIGHT_SUPERSEDED");
    await assert.rejects(stat(canonical));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("legacy history retains native resume behavior without mutation or backup", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-legacy-"));
  const backupRoot = join(home, "backups");
  try {
    const rollout = await writeRollout(home, [
      legacyRecord("session_meta", { id: SESSION_ID, history_mode: "legacy" }),
      legacyRecord("event_msg", { type: "task_complete" }),
    ]);
    const before = await readFile(rollout, "utf8");
    const inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "healthy");
    assert.equal(inspection.historyMode, "legacy");
    assert.equal(inspection.finalOrdinal, null);
    assert.deepEqual(inspection.unknownAnomalies, []);

    const result = await guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "guard", backupRoot, environment: codexTestEnvironment() });
    assert.deepEqual(result, { status: "not_applicable", historyMode: "legacy" });
    assert.equal(await readFile(rollout, "utf8"), before);
    await assert.rejects(access(backupRoot));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("legacy history still fails closed on identity or mixed-schema anomalies", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-legacy-unsafe-"));
  try {
    const rollout = await writeRollout(home, [
      legacyRecord("session_meta", { id: "01a0531f-2295-7852-b575-f9d4c2c1201c", history_mode: "legacy" }),
      legacyRecord("event_msg", { type: "task_complete" }),
    ]);
    let inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "unsafe");
    assert.equal(inspection.unknownAnomalies.some((item) => item.kind === "session_identity_mismatch"), true);

    await writeFile(rollout, `${[
      legacyRecord("session_meta", { id: SESSION_ID, history_mode: "legacy" }),
      record(1, "event_msg", { type: "task_complete" }),
    ].join("\n")}\n`);
    inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "unsafe");
    assert.equal(inspection.unknownAnomalies.some((item) => item.kind === "unexpected_ordinal"), true);
    await assert.rejects(
      guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "guard", environment: codexTestEnvironment() }),
      /canonical identity or ordinal contract/i,
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("legacy history rejects non-record JSON and conflicting mode aliases", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-legacy-shape-"));
  try {
    const rollout = await writeRollout(home, []);
    for (const invalidRecord of [{}, [], "corrupt", null]) {
      await writeFile(rollout, `${[
        legacyRecord("session_meta", { id: SESSION_ID, history_mode: "legacy" }),
        JSON.stringify(invalidRecord),
      ].join("\n")}\n`);
      const inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
      assert.equal(inspection.status, "unsafe");
      assert.equal(inspection.unknownAnomalies.some((item) => item.kind === "invalid_record_shape"), true);
    }

    await writeFile(rollout, `${[
      legacyRecord("session_meta", { id: SESSION_ID, history_mode: "legacy", historyMode: "paginated" }),
      legacyRecord("event_msg", { type: "task_complete" }),
    ].join("\n")}\n`);
    const inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "unsafe");
    assert.equal(inspection.unknownAnomalies.some((item) => item.kind === "conflicting_history_mode"), true);
    await assert.rejects(
      guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "guard", environment: codexTestEnvironment() }),
      /canonical identity or ordinal contract/i,
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("guard mode refuses a stale Codex resume without changing history", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-guard-"));
  const backupRoot = join(home, "backups");
  try {
    const rollout = await writeRollout(home, duplicateSettingsRollout());
    const before = await readFile(rollout, "utf8");
    await assert.rejects(
      guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "guard", backupRoot, environment: codexTestEnvironment() }),
      /refusing to resume from a stale paginated projection/i,
    );
    assert.equal(await readFile(rollout, "utf8"), before);
    await assert.rejects(access(backupRoot));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("prompt mode declines duplicate-metadata repair without backup or mutation", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-prompt-decline-"));
  const backupRoot = join(home, "backups");
  try {
    const rollout = await writeRollout(home, duplicateSettingsRollout());
    const before = await readFile(rollout, "utf8");
    await assert.rejects(
      guardCodexResumeHistory({
        home, sessionId: SESSION_ID, mode: "prompt", backupRoot,
        environment: codexTestEnvironment(), confirmRepair: async () => false,
      }),
      /repair was not approved/i,
    );
    assert.equal(await readFile(rollout, "utf8"), before);
    await assert.rejects(access(backupRoot));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("non-interactive prompt mode never repairs duplicate metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-prompt-required-"));
  const backupRoot = join(home, "backups");
  try {
    const rollout = await writeRollout(home, duplicateSettingsRollout());
    const before = await readFile(rollout, "utf8");
    await assert.rejects(
      guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "prompt", backupRoot, environment: codexTestEnvironment() }),
      (error) => error?.code === "CODEX_HISTORY_REPAIR_PROMPT_REQUIRED",
    );
    assert.equal(await readFile(rollout, "utf8"), before);
    await assert.rejects(access(backupRoot));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("approved partial-write repair runs under the writer lock and validates the complete candidate", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-partial-"));
  const backupRoot = join(home, "backups");
  try {
    const complete = record(1, "event_msg", { type: "token_count" });
    const rollout = await writeRollout(home, [
      record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" }),
      complete.slice(0, 35),
      complete.slice(35),
      record(2, "event_msg", { type: "task_complete" }),
    ]);
    const original = await readFile(rollout, "utf8");
    let locked = false;
    const result = await guardCodexResumeHistory({
      home, sessionId: SESSION_ID, mode: "prompt", backupRoot,
      environment: codexTestEnvironment(), confirmRepair: async () => true,
      withWriterLock: async (_options, operation) => { locked = true; return operation(); },
    });
    assert.equal(locked, true);
    assert.equal(result.status, "repaired");
    assert.equal(result.repairKind, "partial_write");
    const inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "healthy");
    assert.equal(inspection.finalOrdinal, 2);
    const backupDirs = await readdir(backupRoot);
    assert.equal(backupDirs.length, 1);
    const backupDir = join(backupRoot, backupDirs[0]);
    assert.equal(await readFile(join(backupDir, basename(rollout)), "utf8"), original);
    assert.equal(JSON.parse(await readFile(join(backupDir, "manifest.json"), "utf8")).state, "completed");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("partial-write repair declines and fails concurrent-change checks without replacing history", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-partial-cas-"));
  const backupRoot = join(home, "backups");
  try {
    const complete = record(1, "event_msg", { type: "token_count" });
    const rollout = await writeRollout(home, [
      record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" }),
      complete.slice(0, 35), complete.slice(35),
      record(2, "event_msg", { type: "task_complete" }),
    ]);
    const original = await readFile(rollout, "utf8");
    await assert.rejects(
      guardCodexResumeHistory({
        home, sessionId: SESSION_ID, mode: "prompt", backupRoot,
        environment: codexTestEnvironment(), confirmRepair: async () => false,
      }),
      /repair was not approved/i,
    );
    assert.equal(await readFile(rollout, "utf8"), original);
    await assert.rejects(access(backupRoot));

    await assert.rejects(
      guardCodexResumeHistory({
        home, sessionId: SESSION_ID, mode: "repair", backupRoot,
        environment: codexTestEnvironment(),
        withWriterLock: async (_options, operation) => operation(),
        repairOperations: {
          beforePartialCompareAndSwap: async () => appendFile(rollout, `${record(3, "event_msg", { type: "task_complete" })}\n`),
        },
      }),
      /changed while Statewright prepared the partial-write repair/i,
    );
    assert.equal(await readFile(rollout, "utf8"), `${original}${record(3, "event_msg", { type: "task_complete" })}\n`);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("partial-write repair rejects a non-canonical rollout filename before mutation", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-partial-name-"));
  const backupRoot = join(home, "backups");
  try {
    const complete = record(1, "event_msg", { type: "token_count" });
    const canonical = await writeRollout(home, [
      record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" }),
      complete.slice(0, 35), complete.slice(35),
    ]);
    const rollout = join(dirname(canonical), `unexpected-${SESSION_ID}.jsonl`);
    await rename(canonical, rollout);
    const before = await readFile(rollout, "utf8");
    await assert.rejects(
      guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "repair", backupRoot, environment: codexTestEnvironment() }),
      /not safe for automatic repair/i,
    );
    assert.equal(await readFile(rollout, "utf8"), before);
    assert.equal((await readdir(dirname(rollout))).some((name) => name.includes(".repair-")), false);
    await assert.rejects(access(backupRoot));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("partial-write repair rechecks the canonical filename after consent", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-partial-name-race-"));
  const backupRoot = join(home, "backups");
  try {
    const complete = record(1, "event_msg", { type: "token_count" });
    const canonical = await writeRollout(home, [
      record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" }),
      complete.slice(0, 35), complete.slice(35),
    ]);
    const unexpected = join(dirname(canonical), `unexpected-${SESSION_ID}.jsonl`);
    const before = await readFile(canonical, "utf8");
    await assert.rejects(
      guardCodexResumeHistory({
        home, sessionId: SESSION_ID, mode: "prompt", backupRoot, environment: codexTestEnvironment(),
        confirmRepair: async () => { await rename(canonical, unexpected); return true; },
        withWriterLock: async (_options, operation) => operation(),
      }),
      /not safe for automatic repair/i,
    );
    assert.equal(await readFile(unexpected, "utf8"), before);
    assert.equal((await readdir(dirname(unexpected))).some((name) => name.includes(".repair-")), false);
    await assert.rejects(access(backupRoot));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("partial-write repair removes its candidate when backup preparation fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-partial-cleanup-"));
  try {
    const complete = record(1, "event_msg", { type: "token_count" });
    const rollout = await writeRollout(home, [
      record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" }),
      complete.slice(0, 35), complete.slice(35),
    ]);
    const before = await readFile(rollout, "utf8");
    const blocker = join(home, "not-a-directory");
    await writeFile(blocker, "block backup creation");
    await assert.rejects(
      guardCodexResumeHistory({
        home, sessionId: SESSION_ID, mode: "repair", backupRoot: join(blocker, "backups"),
        environment: codexTestEnvironment(), withWriterLock: async (_options, operation) => operation(),
      }),
      /could not inspect or repair Codex history safely/i,
    );
    assert.equal(await readFile(rollout, "utf8"), before);
    assert.equal((await readdir(dirname(rollout))).some((name) => name.includes(".repair-")), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("partial-write repair removes a partially created candidate when writing it fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-partial-write-failure-"));
  try {
    const complete = record(1, "event_msg", { type: "token_count" });
    const rollout = await writeRollout(home, [
      record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" }),
      complete.slice(0, 35), complete.slice(35),
    ]);
    const before = await readFile(rollout, "utf8");
    await assert.rejects(
      guardCodexResumeHistory({
        home, sessionId: SESSION_ID, mode: "repair", environment: codexTestEnvironment(),
        withWriterLock: async (_options, operation) => operation(),
        repairOperations: {
          writePartialCandidate: async (path, value, options) => {
            await writeFile(path, value.slice(0, 20), options);
            throw Object.assign(new Error("injected candidate write failure"), { code: "ENOSPC" });
          },
        },
      }),
      /could not inspect or repair Codex history safely/i,
    );
    assert.equal(await readFile(rollout, "utf8"), before);
    assert.equal((await readdir(dirname(rollout))).some((name) => name.includes(".repair-")), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("repair mode backs up history, removes only redundant settings, and clears only the target projection", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-repair-"));
  const backupRoot = join(home, "backups");
  try {
    const rollout = await writeRollout(home, duplicateSettingsRollout());
    const projection = createProjection(home);
    const original = await readFile(rollout, "utf8");
    const result = await guardCodexResumeHistory({
      home, sessionId: SESSION_ID, mode: "repair", backupRoot,
      environment: codexTestEnvironment(),
      withWriterLock: async (_options, operation) => operation(),
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.droppedRecords, 1);
    const repaired = (await readFile(rollout, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(repaired.map((row) => row.ordinal), [0, 1, 2]);
    assert.equal(repaired.some((row) => row.payload?.type === "thread_settings_applied"), false);

    const backupDirs = await readdir(backupRoot);
    assert.equal(backupDirs.length, 1);
    const backupDir = join(backupRoot, backupDirs[0]);
    assert.equal(await readFile(join(backupDir, "rollout.jsonl"), "utf8"), original);
    await access(join(backupDir, "thread_history_1.sqlite"));
    const manifest = JSON.parse(await readFile(join(backupDir, "manifest.json"), "utf8"));
    assert.equal(manifest.version, 2);
    assert.equal(manifest.thread_id, SESSION_ID);
    assert.equal(manifest.dropped_records, 1);
    assert.match(manifest.rollback, /stop every Codex writer/i);
    assert.match(manifest.rollback, /rewinds every thread/i);
    assert.doesNotMatch(manifest.target_scoped_projection_restore_sql, /other-thread/);

    const database = new DatabaseSync(projection);
    for (const table of ["thread_history_projection_state", "thread_items", "thread_turns", "thread_realtime_items"]) {
      assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table} WHERE thread_id = ?`).get(SESSION_ID).count, 0);
      assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table} WHERE thread_id = ?`).get("other-thread").count, 1);
    }
    database.close();

    const healthy = await guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "guard", backupRoot, environment: codexTestEnvironment() });
    assert.equal(healthy.status, "healthy");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("inspection rejects filename or embedded identity mismatch and a nonzero root ordinal", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-identity-"));
  try {
    const path = await writeRollout(home, [
      record(0, "session_meta", { id: "01a0531f-2295-7852-b575-f9d4c2c1201c", history_mode: "paginated" }),
      record(1, "event_msg", { type: "task_complete" }),
    ]);
    let inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "unsafe");
    assert.equal(inspection.unknownAnomalies.some((item) => item.kind === "session_identity_mismatch"), true);

    const misnamed = join(dirname(path), `not-a-rollout-${SESSION_ID}.jsonl`);
    await rename(path, misnamed);
    inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.unknownAnomalies.some((item) => item.kind === "unrecognized_rollout_filename"), true);
    await rename(misnamed, path);

    await writeFile(path, `${record(100, "session_meta", { id: SESSION_ID, history_mode: "paginated" })}\n`);
    inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "unsafe");
    assert.equal(inspection.unknownAnomalies.some((item) => item.kind === "invalid_root_record"), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("unsafe history without a trustworthy mode fails closed instead of bypassing the guard", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-unknown-mode-"));
  try {
    await writeRollout(home, [
      record(0, "session_meta", { id: SESSION_ID }),
      record(2, "event_msg", { type: "task_complete" }),
    ]);
    await assert.rejects(
      guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "guard", environment: codexTestEnvironment() }),
      /canonical identity or ordinal contract/i,
    );
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a rollout without its canonical final newline fails closed", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-truncated-"));
  try {
    const path = await writeRollout(home, [
      record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" }),
      record(1, "event_msg", { type: "task_complete" }),
    ]);
    const content = await readFile(path, "utf8");
    await writeFile(path, content.trimEnd());
    const inspection = await inspectCodexHistory({ home, sessionId: SESSION_ID });
    assert.equal(inspection.status, "unsafe");
    assert.equal(inspection.unknownAnomalies.some((item) => item.kind === "noncanonical_line_endings_or_final_newline"), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("source compare-and-swap refuses a concurrent append before replacement", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-cas-"));
  const backupRoot = join(home, "backups");
  try {
    const rollout = await writeRollout(home, duplicateSettingsRollout());
    const projection = createProjection(home);
    await assert.rejects(
      guardCodexResumeHistory({
        home, sessionId: SESSION_ID, mode: "repair", backupRoot,
        environment: codexTestEnvironment(),
        withWriterLock: async (_options, operation) => operation(),
        repairOperations: {
          beforeCompareAndSwap: async () => appendFile(rollout, `${record(3, "event_msg", { type: "task_complete" })}\n`),
        },
      }),
      /changed while Statewright prepared the repair/i,
    );
    const rows = (await readFile(rollout, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.map((row) => row.ordinal), [0, 1, 1, 2, 3]);
    const database = new DatabaseSync(projection);
    assert.equal(database.prepare("SELECT count(*) AS count FROM thread_history_projection_state WHERE thread_id = ?").get(SESSION_ID).count, 1);
    database.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a post-commit manifest failure retains the repaired rollout and cleared target projection", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-post-commit-"));
  const backupRoot = join(home, "backups");
  try {
    const rollout = await writeRollout(home, duplicateSettingsRollout());
    const projection = createProjection(home);
    await assert.rejects(
      guardCodexResumeHistory({
        home, sessionId: SESSION_ID, mode: "repair", backupRoot,
        environment: codexTestEnvironment(),
        withWriterLock: async (_options, operation) => operation(),
        repairOperations: {
          writeManifest: async (path, value) => {
            if (value.state === "completed") throw new Error("injected final manifest failure");
            await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
          },
        },
      }),
      /applied the safe history repair/i,
    );
    const rows = (await readFile(rollout, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows.map((row) => row.ordinal), [0, 1, 2]);
    const database = new DatabaseSync(projection);
    assert.equal(database.prepare("SELECT count(*) AS count FROM thread_history_projection_state WHERE thread_id = ?").get(SESSION_ID).count, 0);
    database.close();
    const backupDirs = await readdir(backupRoot);
    const manifest = JSON.parse(await readFile(join(backupRoot, backupDirs[0], "manifest.json"), "utf8"));
    assert.equal(manifest.state, "repair_applied_manifest_incomplete");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("native writer-lock contention fails closed", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-writer-lock-"));
  try {
    await withCodexWriterLock({ home, sessionId: SESSION_ID }, async () => {
      await assert.rejects(
        withCodexWriterLock({ home, sessionId: SESSION_ID }, async () => {}),
        /active writer/i,
      );
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("writer-lock acquisition waits for coordinated native cleanup before entering", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-writer-aba-"));
  const lockRoot = join(home, ".codex", "thread-writer-locks");
  const threadLock = join(lockRoot, `${SESSION_ID}.lock`);
  const coordinationLock = join(lockRoot, ".coordination.lock");
  await mkdir(lockRoot, { recursive: true });
  const oldWriter = spawn("perl", ["-MFcntl=:flock", "-e", String.raw`
use Fcntl qw(:flock);
my ($coord_path, $thread_path) = @ARGV;
open(my $thread, "+>>", $thread_path) or exit 1;
flock($thread, LOCK_EX) or exit 2;
select(STDOUT); $| = 1; print "HELD\n";
<STDIN>;
open(my $coord, "+>>", $coord_path) or exit 3;
flock($coord, LOCK_EX) or exit 4;
print "COORDINATED\n";
<STDIN>;
close($thread) or exit 5;
unlink($thread_path) unless !-e $thread_path;
close($coord) or exit 6;
`, coordinationLock, threadLock], { env: { ...process.env, LC_ALL: "C", LANG: "C" }, stdio: ["pipe", "pipe", "ignore"] });
  try {
    await waitForLine(oldWriter, "HELD");
    oldWriter.stdin.write("release\n");
    await waitForLine(oldWriter, "COORDINATED");
    let entered = false;
    const acquired = withCodexWriterLock({ home, sessionId: SESSION_ID }, async () => {
      entered = true;
      assert.equal((await stat(threadLock)).isFile(), true);
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    assert.equal(entered, false);
    oldWriter.stdin.end("finish\n");
    await acquired;
    assert.equal(entered, true);
  } finally {
    if (oldWriter.exitCode === null) oldWriter.kill("SIGTERM");
    await rm(home, { recursive: true, force: true });
  }
});

test("environment storage overrides repair the effective Codex home and SQLite projection", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-env-storage-"));
  const codexHome = join(home, "custom-codex");
  const effectiveCwd = join(home, "effective-cwd");
  const sqliteHome = join(effectiveCwd, "custom-sqlite");
  try {
    await mkdir(sqliteHome, { recursive: true });
    const customRollout = join(codexHome, "sessions", "2026", "08", "30", `rollout-2026-08-30T00-00-00-${SESSION_ID}.jsonl`);
    await mkdir(dirname(customRollout), { recursive: true });
    await writeFile(customRollout, `${duplicateSettingsRollout().join("\n")}\n`, { mode: 0o600 });
    const projection = createProjectionAt(join(sqliteHome, "thread_history_1.sqlite"));
    let lockOptions = null;
    const result = await guardCodexResumeHistory({
      home, cwd: home, args: ["-C", "effective-cwd", "resume", SESSION_ID], sessionId: SESSION_ID, mode: "repair",
      environment: codexTestEnvironment({ CODEX_HOME: codexHome, CODEX_SQLITE_HOME: "custom-sqlite" }),
      withWriterLock: async (options, operation) => { lockOptions = options; return operation(); },
    });
    assert.equal(result.status, "repaired");
    const canonicalCodexHome = await realpath(codexHome);
    assert.equal(lockOptions.codexHome, canonicalCodexHome);
    assert.equal(lockOptions.writerLockRoot, join(canonicalCodexHome, "thread-writer-locks"));
    assert.deepEqual((await readFile(customRollout, "utf8")).trim().split("\n").map((line) => JSON.parse(line).ordinal), [0, 1, 2]);
    const database = new DatabaseSync(projection);
    assert.equal(database.prepare("SELECT count(*) AS count FROM thread_history_projection_state WHERE thread_id = ?").get(SESSION_ID).count, 0);
    database.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("top-level TOML sqlite_home takes precedence over the environment and durability sync precedes replacement", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-toml-storage-"));
  const codexHome = join(home, ".codex");
  const configuredSqliteHome = join(codexHome, "configured-sqlite");
  const envSqliteHome = join(home, "environment-sqlite");
  const events = [];
  try {
    await mkdir(codexHome, { recursive: true });
    await mkdir(configuredSqliteHome, { recursive: true });
    await mkdir(envSqliteHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), 'sqlite_home = "configured-sqlite"\n');
    await writeRollout(home, duplicateSettingsRollout());
    const configuredProjection = createProjectionAt(join(configuredSqliteHome, "thread_history_1.sqlite"));
    const environmentProjection = createProjectionAt(join(envSqliteHome, "thread_history_1.sqlite"));
    const result = await guardCodexResumeHistory({
      home, sessionId: SESSION_ID, mode: "repair",
      environment: codexTestEnvironment({ CODEX_SQLITE_HOME: envSqliteHome }),
      withWriterLock: async (_options, operation) => operation(),
      repairOperations: { onDurabilityEvent: async (event) => events.push(event) },
    });
    assert.equal(result.status, "repaired");
    assert.deepEqual(events.slice(0, 5), ["backup_root_created", "backup_parent_synced", "backup_dir_created", "backup_root_synced", "canonical_replaced"]);
    assert.ok(events.indexOf("backup_root_synced") < events.indexOf("canonical_replaced"));
    const configuredDatabase = new DatabaseSync(configuredProjection);
    assert.equal(configuredDatabase.prepare("SELECT count(*) AS count FROM thread_history_projection_state WHERE thread_id = ?").get(SESSION_ID).count, 0);
    configuredDatabase.close();
    const environmentDatabase = new DatabaseSync(environmentProjection);
    assert.equal(environmentDatabase.prepare("SELECT count(*) AS count FROM thread_history_projection_state WHERE thread_id = ?").get(SESSION_ID).count, 1);
    environmentDatabase.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("every Codex config option spelling selects the same SQLite home", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-cli-storage-"));
  const sqliteHome = join(home, "cli-sqlite");
  try {
    await mkdir(sqliteHome, { recursive: true });
    const override = `sqlite_home=${JSON.stringify(sqliteHome)}`;
    const forms = [
      ["-c", override],
      ["--config", override],
      [`--config=${override}`],
      [`-c=${override}`],
      [`-c${override}`],
    ];
    for (const args of forms) {
      const storage = await resolveCodexHistoryStorage({ home, cwd: home, environment: {}, args });
      assert.equal(storage.sqliteHome, await realpath(sqliteHome), args.join(" "));
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("every Codex cwd option spelling anchors a relative environment SQLite home", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-cli-cwd-"));
  const effectiveCwd = join(home, "effective");
  const sqliteHome = join(effectiveCwd, "sqlite");
  try {
    await mkdir(sqliteHome, { recursive: true });
    const forms = [
      ["-C", "effective"],
      ["--cd", "effective"],
      ["--cd=effective"],
      ["-C=effective"],
      ["-Ceffective"],
    ];
    for (const args of forms) {
      const storage = await resolveCodexHistoryStorage({ home, cwd: home, environment: { CODEX_SQLITE_HOME: "sqlite" }, args });
      assert.equal(storage.effectiveCwd, await realpath(effectiveCwd), args.join(" "));
      assert.equal(storage.sqliteHome, await realpath(sqliteHome), args.join(" "));
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("repair aborts before backup or mutation for any unknown ordinal anomaly", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-unknown-"));
  const backupRoot = join(home, "backups");
  try {
    const rollout = await writeRollout(home, [
      record(0, "session_meta", { id: SESSION_ID, history_mode: "paginated" }),
      record(2, "event_msg", { type: "task_complete" }),
    ]);
    const before = await readFile(rollout, "utf8");
    await assert.rejects(
      guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "repair", backupRoot, environment: codexTestEnvironment() }),
      /not safe for automatic repair/i,
    );
    assert.equal(await readFile(rollout, "utf8"), before);
    await assert.rejects(access(backupRoot));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("repair relinks an exact stale managed App Server pointer after backing up Codex state", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-pointer-"));
  try {
    const canonical = await writeRollout(home, [
      legacyRecord("session_meta", { id: SESSION_ID, history_mode: "legacy" }),
      legacyRecord("event_msg", { type: "task_complete" }),
    ]);
    const databasePath = join(home, ".codex", "state_5.sqlite");
    const stale = join(tmpdir(), `statewright-swc_${"a".repeat(32)}-app-server-dead`, "sessions", "2026", "08", "30", `rollout-2026-08-30T00-00-00-${SESSION_ID}.jsonl`);
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    database.prepare("INSERT INTO threads VALUES (?, ?)").run(SESSION_ID, stale);
    database.close();
    const result = await guardCodexResumeHistory({
      home, sessionId: SESSION_ID, mode: "repair", environment: codexTestEnvironment(),
    });
    assert.equal(result.repairKind, "stale_rollout_pointer");
    const repaired = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(repaired.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(SESSION_ID).rollout_path, await realpath(canonical));
    repaired.close();
    const backups = await readdir(join(home, ".codex", "backups"));
    assert.equal(backups.length, 1);
    assert.ok((await readdir(join(home, ".codex", "backups", backups[0]))).includes("state_5.sqlite"));
    const manifest = JSON.parse(await readFile(join(home, ".codex", "backups", backups[0], "manifest.json"), "utf8"));
    assert.match(manifest.target_scoped_rollback_sql, /UPDATE threads SET rollout_path/);
    assert.match(manifest.rollback, /whole database is disaster recovery only/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("stale pointer repair recognizes the current state database when staging exposes it by symlink", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-pointer-symlink-"));
  try {
    const { canonical, archive } = await writeCompressedRollout(home, [
      legacyRecord("session_meta", { id: SESSION_ID, history_mode: "legacy" }),
      legacyRecord("event_msg", { type: "task_complete" }),
    ]);
    const durable = join(home, "durable-state_5.sqlite");
    const stale = join(tmpdir(), `statewright-swc_${"c".repeat(32)}-app-server-dead`, "sessions", "2026", "08", "30", `rollout-2026-08-30T00-00-00-${SESSION_ID}.jsonl`);
    const database = new DatabaseSync(durable);
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    database.prepare("INSERT INTO threads VALUES (?, ?)").run(SESSION_ID, stale);
    database.prepare("INSERT INTO threads VALUES (?, ?)").run("other-thread", "unrelated history");
    database.close();
    await symlink(durable, join(home, ".codex", "state_5.sqlite"));
    const result = await guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "repair", environment: codexTestEnvironment() });
    assert.equal(result.repairKind, "stale_rollout_pointer");
    const repaired = new DatabaseSync(durable, { readOnly: true });
    assert.equal(repaired.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(SESSION_ID).rollout_path, await realpath(canonical));
    assert.equal(repaired.prepare("SELECT rollout_path FROM threads WHERE id = ?").get("other-thread").rollout_path, "unrelated history");
    assert.ok(await stat(archive));
    repaired.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("stale pointer repair never falls through to an obsolete Codex state database", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-history-pointer-version-"));
  try {
    await writeRollout(home, [
      legacyRecord("session_meta", { id: SESSION_ID, history_mode: "legacy" }),
      legacyRecord("event_msg", { type: "task_complete" }),
    ]);
    const stale = join(tmpdir(), `statewright-swc_${"b".repeat(32)}-app-server-dead`, "sessions", "2026", "08", "30", `rollout-2026-08-30T00-00-00-${SESSION_ID}.jsonl`);
    const oldDatabase = new DatabaseSync(join(home, ".codex", "state_4.sqlite"));
    oldDatabase.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    oldDatabase.prepare("INSERT INTO threads VALUES (?, ?)").run(SESSION_ID, stale);
    oldDatabase.close();
    const currentDatabase = new DatabaseSync(join(home, ".codex", "state_5.sqlite"));
    currentDatabase.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    currentDatabase.close();
    const result = await guardCodexResumeHistory({ home, sessionId: SESSION_ID, mode: "repair", environment: codexTestEnvironment() });
    assert.notEqual(result.repairKind, "stale_rollout_pointer");
    const unchanged = new DatabaseSync(join(home, ".codex", "state_4.sqlite"), { readOnly: true });
    assert.equal(unchanged.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(SESSION_ID).rollout_path, stale);
    unchanged.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

for (const scenario of ["broken-newest-link", "cancelled", "changed-row"]) {
  test(`stale pointer recovery refuses ${scenario} without rewinding another writer`, async () => {
    const home = await mkdtemp(join(tmpdir(), "statewright-history-pointer-safety-"));
    try {
      const canonical = await writeRollout(home, [legacyRecord("session_meta", { id: SESSION_ID, history_mode: "legacy" })]);
      const databasePath = join(home, ".codex", "state_5.sqlite");
      const stale = join(tmpdir(), `statewright-swc_${"d".repeat(32)}-app-server-dead`, "sessions", basename(canonical));
      const database = new DatabaseSync(databasePath);
      database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
      database.prepare("INSERT INTO threads VALUES (?, ?)").run(SESSION_ID, stale);
      database.close();
      if (scenario === "broken-newest-link") await symlink(join(home, "missing.sqlite"), join(home, ".codex", "state_6.sqlite"));
      let cancelled = false;
      await assert.rejects(guardCodexResumeHistory({
        home, sessionId: SESSION_ID, mode: "repair", environment: codexTestEnvironment(),
        checkCurrentRequest: () => { if (cancelled) throw Object.assign(new Error("disconnected"), { code: "STATEWRIGHT_SUPERSEDED" }); },
        repairOperations: { beforePointerCompareAndSwap: async () => {
          if (scenario === "cancelled") cancelled = true;
          if (scenario === "changed-row") {
            const writer = new DatabaseSync(databasePath);
            writer.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run("new writer path", SESSION_ID);
            writer.close();
          }
        } },
      }), error => error.code === ({ "broken-newest-link": "CODEX_HISTORY_STATE_UNAVAILABLE", cancelled: "STATEWRIGHT_SUPERSEDED", "changed-row": "CODEX_HISTORY_OPERATION_FAILED" })[scenario]);
      const result = new DatabaseSync(databasePath, { readOnly: true });
      assert.equal(result.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(SESSION_ID).rollout_path, scenario === "changed-row" ? "new writer path" : stale);
      result.close();
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}
