import { open, opendir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_SESSION_META_BYTES = 1024 * 1024;

function validThreadId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(value);
}

// Native input history records submitted composer text; rollout user-role
// messages also contain environment, plugin, and hook injections. Never infer
// human provenance from message wording or fall back to the model transcript.
async function lastSubmittedInputs(codexHome, threadIds) {
  const inputs = new Map();
  const history = await readFile(join(codexHome, "history.jsonl"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  for (const line of history.split("\n")) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (threadIds.has(row.session_id) && typeof row.text === "string" && row.text.trim()) {
      inputs.set(row.session_id, row.text);
    }
  }
  return inputs;
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
    return { cwd, threadSource: row.payload?.thread_source ?? null };
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
export async function readCodexThreadCwds({ threadIds, home = homedir(), codexHome = join(home, ".codex"), metadataCache = new Map() } = {}) {
  const requested = new Set((threadIds ?? []).filter(validThreadId));
  const pending = new Set([...requested].filter((id) => !metadataCache.has(id)));
  const resolved = {};
  if (requested.size === 0) return resolved;
  if (pending.size) await collectThreadCwds(join(codexHome, "sessions"), pending, resolved);
  for (const [id, metadata] of Object.entries(resolved)) metadataCache.set(id, metadata);
  // Only immutable rollout metadata is cached. Refresh inputs for every picker
  // request so a resident server displays messages submitted since its launch.
  const inputs = await lastSubmittedInputs(codexHome, requested);
  return Object.fromEntries([...requested].map((id) => [id, {
    ...metadataCache.get(id), lastUserMessage: inputs.get(id) ?? null,
  }]));
}
