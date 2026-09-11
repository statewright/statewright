import { open, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_SESSION_META_BYTES = 1024 * 1024;

function validThreadId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(value);
}

async function sessionCwd(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(MAX_SESSION_META_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) return null;
    const row = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
    const cwd = row?.type === "session_meta" ? row.payload?.cwd : null;
    return typeof cwd === "string" && cwd.trim() ? cwd : null;
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}

async function collectThreadCwds(root, pending, resolved) {
  let directory;
  try { directory = await opendir(root); } catch { return; }
  for await (const entry of directory) {
    if (pending.size === 0) return;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectThreadCwds(path, pending, resolved);
      continue;
    }
    if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
    const sessionId = [...pending].find((id) => entry.name.endsWith(`-${id}.jsonl`));
    if (!sessionId) continue;
    const cwd = await sessionCwd(path);
    if (cwd) resolved[sessionId] = cwd;
    pending.delete(sessionId);
  }
}

/**
 * Read each requested Codex rollout's immutable session_meta cwd. This is
 * distinct from app-server thread/list cwd, which can reflect a later resume.
 */
export async function readCodexThreadCwds({ threadIds, home = homedir(), codexHome = join(home, ".codex") } = {}) {
  const pending = new Set((threadIds ?? []).filter(validThreadId));
  const resolved = {};
  if (pending.size === 0) return resolved;
  await collectThreadCwds(join(codexHome, "sessions"), pending, resolved);
  return resolved;
}
