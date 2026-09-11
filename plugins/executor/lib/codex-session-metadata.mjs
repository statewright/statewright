import { open, opendir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_SESSION_META_BYTES = 1024 * 1024;

function validThreadId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(value);
}

function synopsisText(content) {
  const text = Array.isArray(content) ? content.map((item) => item?.text ?? "").join(" ") : "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || /^(<hook_prompt|\[statewright\]|Statewright workflow remains active|Reply exactly |Read-only |Continue the read-only |For the final read-only )/i.test(normalized) || /\bstatewright(?:_|\s)/i.test(normalized)) return null;
  return normalized.slice(0, 96);
}

async function sessionMetadata(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(MAX_SESSION_META_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) return null;
    const row = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
    const cwd = row?.type === "session_meta" ? row.payload?.cwd : null;
    if (typeof cwd !== "string" || !cwd.trim()) return null;
    const rows = (await readFile(path, "utf8")).split("\n").flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const prompts = rows.filter((item) => item?.type === "response_item" && item?.payload?.type === "message" && item.payload.role === "user")
      .map((item) => synopsisText(item.payload.content)).filter(Boolean);
    return { cwd, synopsis: prompts.at(-1) ?? null };
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
    const metadata = await sessionMetadata(path);
    if (metadata) resolved[sessionId] = metadata;
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
