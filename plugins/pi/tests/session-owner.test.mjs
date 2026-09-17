import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { createPiNativeSession, assertPiNativeSession } from "../../executor/lib/host-adapters.mjs";

test("installed public Pi SDK preserves exact ownership through its first-turn flush and reopen", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-sdk-reopen-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = randomUUID();
  const pluginsRoot = fileURLToPath(new URL("../../", import.meta.url));
  const sessionFile = await createPiNativeSession({ pluginsRoot, cwd: root, sessionDir: root, sessionId });
  await assertPiNativeSession({ sessionFile, sessionId, cwd: root });
  const before = await readFile(sessionFile, "utf8");
  const manager = SessionManager.open(sessionFile, root, root);
  assert.equal(manager.getSessionFile(), sessionFile);
  assert.equal(manager.getHeader().id, sessionId);
  assert.equal(manager.getHeader().cwd, root);
  assert.equal(await readFile(sessionFile, "utf8"), before);
  assert.deepEqual(manager.buildSessionContext().messages, []);
  // Synthetic public-SDK fixture messages only; no provider or inference.
  const userId = manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [], timestamp: 2, provider: "fixture", model: "fixture",
    api: "openai-responses", stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  await assertPiNativeSession({ sessionFile, sessionId, cwd: root });
  const resumed = SessionManager.open(sessionFile, root, root);
  assert.equal(resumed.getHeader().id, sessionId);
  assert.equal(resumed.buildSessionContext().messages.length, 2);
  const after = await readFile(sessionFile, "utf8");
  await writeFile(sessionFile, after.slice(0, -1));
  await assert.rejects(assertPiNativeSession({ sessionFile, sessionId, cwd: root }), /Incomplete/);
  assert.equal(await readFile(sessionFile, "utf8"), after.slice(0, -1));
  await writeFile(sessionFile, after);
  resumed.appendThinkingLevelChange("off");
  await assertPiNativeSession({ sessionFile, sessionId, cwd: root });
  assert.equal(SessionManager.open(sessionFile, root, root).buildSessionContext().messages.length, 2);
  resumed.appendModelChange("fixture", "fixture");
  resumed.appendCustomEntry("fixture-metadata", { fixture: true });
  resumed.appendSessionInfo("fixture-name");
  resumed.appendLabelChange(userId, "fixture-label");
  resumed.appendCustomMessageEntry("fixture-message", "fixture content", false);
  resumed.appendCompaction("fixture summary", userId, 0);
  resumed.branchWithSummary(userId, "fixture branch summary");
  await assertPiNativeSession({ sessionFile, sessionId, cwd: root });
  assert.doesNotThrow(() => SessionManager.open(sessionFile, root, root).buildSessionContext());
});

test("native admission denies absent and off-branch compaction boundaries without changing bytes", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-compaction-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = randomUUID();
  const pluginsRoot = fileURLToPath(new URL("../../", import.meta.url));
  const sessionFile = await createPiNativeSession({ pluginsRoot, cwd: root, sessionDir: root, sessionId });
  const manager = SessionManager.open(sessionFile, root, root);
  const user = manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
  const assistant = manager.appendMessage({ role: "assistant", content: [], timestamp: 2, provider: "fixture", model: "fixture",
    api: "openai-responses", stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  manager.branch(user);
  manager.appendCustomEntry("other-branch", { fixture: true });
  const normal = await readFile(sessionFile, "utf8");
  for (const boundary of ["absent-from-history", assistant]) {
    await writeFile(sessionFile, normal);
    SessionManager.open(sessionFile, root, root).appendCompaction("fixture summary", boundary, 0);
    const corrupt = await readFile(sessionFile, "utf8");
    await assert.rejects(assertPiNativeSession({ sessionFile, sessionId, cwd: root }), /compaction boundary/);
    assert.equal(await readFile(sessionFile, "utf8"), corrupt);
  }
});
