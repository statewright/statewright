import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

function completeCheckpoint(state) {
  return [state?.run_id, state?.run_session_id, state?.pending_approval?.approval_id]
    .every(value => typeof value === "string" && value.length > 0);
}

export function approvalJournal(root, clientId, { fileOps = {} } = {}) {
  const io = { mkdir, open, readFile, rename, unlink, ...fileOps };
  const path = threadId => join(root, createHash("sha256").update(JSON.stringify([clientId, threadId])).digest("hex") + ".json");

  async function syncDirectory() {
    // Windows does not support opening directories via fs.open. File sync
    // and atomic rename still apply there; POSIX also persists the directory.
    if (process.platform === "win32") return;
    const directory = await io.open(root, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async function withLock(threadId, operation) {
    await io.mkdir(root, { recursive: true, mode: 0o700 });
    const lockPath = path(threadId) + ".lock";
    let lock;
    try { lock = await io.open(lockPath, "wx", 0o600); } catch (error) {
      if (error.code === "EEXIST") throw new Error("Approval journal is locked; work remains parked");
      throw error;
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, clientId, threadId }));
      return await operation();
    } finally {
      await lock.close();
      await io.unlink(lockPath);
    }
  }

  async function load(threadId) {
    let raw;
    try { raw = await io.readFile(path(threadId), "utf8"); } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const value = JSON.parse(raw);
    if (value?.version !== 1 || value.threadId !== threadId || value.clientId !== clientId
        || !completeCheckpoint(value.state)) {
      throw new Error("Invalid approval checkpoint; resume denied");
    }
    return value.state;
  }

  return {
    async save(threadId, state) {
      if (!completeCheckpoint(state)) throw new Error("Incomplete approval checkpoint");
      const checkpoint = {
        run_id: state.run_id, run_session_id: state.run_session_id, state: state.state, pending_approval: state.pending_approval,
      };
      // Serialize mutations across both journal instances and processes. An
      // unresolved ticket is immutable; a late park cannot replace it.
      await withLock(threadId, async () => {
        const existing = await load(threadId);
        if (existing) {
          if (!isDeepStrictEqual(existing, JSON.parse(JSON.stringify(checkpoint)))) {
            throw new Error("Approval checkpoint changed; work remains parked");
          }
          const file = await io.open(path(threadId), "r");
          try { await file.sync(); } finally { await file.close(); }
          await syncDirectory();
          return;
        }
        const temporary = path(threadId) + "." + randomUUID();
        let file;
        try {
          file = await io.open(temporary, "wx", 0o600);
          await file.writeFile(JSON.stringify({ version: 1, clientId, threadId, state: checkpoint }));
          await file.sync();
          await file.close();
          file = null;
          await io.rename(temporary, path(threadId));
          await syncDirectory();
        } finally {
          await file?.close();
          await io.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
        }
      });
    },
    load,
    async clear(threadId, approvalId) {
      await withLock(threadId, async () => {
        const state = await load(threadId);
        if (!state) return;
        if (state.pending_approval.approval_id !== approvalId) throw new Error("Approval checkpoint changed");
        await io.unlink(path(threadId));
        await syncDirectory();
      });
    },
  };
}
