import { createReadStream } from "node:fs";
import { open, opendir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { findCodexRollout } from "./codex-history-integrity.mjs";

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

function restoredSandbox(settings) {
  const unrepresentable = () => {
    const error = new Error("Statewright cannot losslessly restore this legacy Codex permission profile; resume with an explicit permission profile or sandbox override.");
    error.code = "STATEWRIGHT_SAVED_PERMISSIONS_UNREPRESENTABLE";
    throw error;
  };
  const activeProfile = settings?.active_permission_profile?.id;
  if (typeof activeProfile === "string" && activeProfile.trim()) return { permissions: activeProfile.trim() };
  if (settings?.permission_profile?.type === "disabled") return { sandbox: "danger-full-access" };
  if (settings?.permission_profile != null) unrepresentable();
  const policy = settings?.sandbox_policy;
  if (policy == null) return {};
  const sandbox = policy?.type;
  if (["read-only", "workspace-write", "danger-full-access"].includes(sandbox)
      && Object.keys(policy).every(key => key === "type")) return { sandbox };
  unrepresentable();
  return {};
}

function absolutePaths(value, field) {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.some(path => typeof path !== "string" || !isAbsolute(path))) {
    const error = new Error(`Statewright found invalid saved Codex ${field}; the thread was not resumed.`);
    error.code = "STATEWRIGHT_SAVED_PERMISSIONS_INVALID";
    throw error;
  }
  return [...value];
}

function resumePermissionParams(permissionSettings, locationSettings) {
  const result = { ...restoredSandbox(permissionSettings) };
  if (permissionSettings?.approval_policy != null) result.approvalPolicy = structuredClone(permissionSettings.approval_policy);
  if (typeof permissionSettings?.approvals_reviewer === "string") result.approvalsReviewer = permissionSettings.approvals_reviewer;
  if (locationSettings?.cwd != null) {
    if (typeof locationSettings.cwd !== "string" || !isAbsolute(locationSettings.cwd)) {
      const error = new Error("Statewright found an invalid saved Codex working directory; the thread was not resumed.");
      error.code = "STATEWRIGHT_SAVED_PERMISSIONS_INVALID";
      throw error;
    }
    result.cwd = locationSettings.cwd;
  }
  const roots = absolutePaths(locationSettings?.runtime_workspace_roots ?? locationSettings?.workspace_roots, "workspace roots");
  if (roots) result.runtimeWorkspaceRoots = roots;
  return Object.keys(result).length ? result : null;
}

/**
 * Recover the last effective permission settings recorded by Codex itself.
 * Legacy rollouts may not retain a named profile, so the most recent
 * thread_settings_applied event must win over an older turn_context.
 */
export async function readCodexResumePermissions({ threadId, home = homedir(), codexHome = join(home, ".codex") } = {}) {
  if (!validThreadId(threadId)) throw new Error("Statewright cannot restore permissions without a valid Codex thread id.");
  const path = await findCodexRollout({ home, codexHome, sessionId: threadId });
  if (!path) return null;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let lineNumber = 0;
  let permissionSettings = null;
  let locationSettings = null;
  for await (const line of lines) {
    lineNumber += 1;
    let row;
    try { row = JSON.parse(line); }
    catch {
      const error = new Error(`Statewright found malformed Codex history at line ${lineNumber}; saved permissions were not guessed.`);
      error.code = "STATEWRIGHT_SAVED_PERMISSIONS_INVALID";
      throw error;
    }
    if (lineNumber === 1 && (row?.type !== "session_meta" || row?.payload?.id !== threadId)) {
      const error = new Error("Statewright found a Codex rollout whose embedded thread identity does not match its requested resume id.");
      error.code = "STATEWRIGHT_SAVED_PERMISSIONS_INVALID";
      throw error;
    }
    if (lineNumber === 1) locationSettings = row.payload;
    // A fork rollout may copy its parent's turn_context verbatim. That is an
    // effective permission snapshot, but its cwd and workspace roots still
    // belong to the parent thread. Only this rollout's session_meta and
    // thread-owned settings events may determine the resumed location.
    if (row?.type === "turn_context") permissionSettings = row.payload;
    if (row?.type === "event_msg" && row?.payload?.type === "thread_settings_applied"
        && row.payload.thread_id === threadId && row.payload.thread_settings) {
      permissionSettings = row.payload.thread_settings;
      locationSettings = row.payload.thread_settings;
    }
  }
  return resumePermissionParams(permissionSettings, locationSettings);
}
