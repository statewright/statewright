import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

function completeCheckpoint(state) {
  return [state?.run_id, state?.run_session_id, state?.pending_approval?.approval_id]
    .every(value => typeof value === "string" && value.length > 0);
}

export function approvalJournal(root, clientId) {
  const path = threadId => join(root, createHash("sha256").update(JSON.stringify([clientId, threadId])).digest("hex") + ".json");
  return {
    async save(threadId, state) {
      if (!completeCheckpoint(state)) throw new Error("Incomplete approval checkpoint");
      await mkdir(root, {recursive: true, mode: 0o700});
      const temporary = path(threadId) + "." + randomUUID();
      await writeFile(temporary, JSON.stringify({version: 1, clientId, threadId, state: {
        run_id: state.run_id, run_session_id: state.run_session_id, state: state.state, pending_approval: state.pending_approval,
      }}), {mode: 0o600});
      await rename(temporary, path(threadId));
    },
    async load(threadId) {
      let raw;
      try {raw = await readFile(path(threadId), "utf8");} catch (error) {if (error.code === "ENOENT") return null; throw error;}
      const value = JSON.parse(raw);
      if (value?.version !== 1 || value.threadId !== threadId || value.clientId !== clientId
          || !completeCheckpoint(value.state)) {
        throw new Error("Invalid approval checkpoint; resume denied");
      }
      return value.state;
    },
    async clear(threadId, approvalId) {
      const state = await this.load(threadId);
      if (!state) return;
      if (state.pending_approval.approval_id !== approvalId) throw new Error("Approval checkpoint changed");
      await unlink(path(threadId));
    },
  };
}
