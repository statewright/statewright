import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { renameSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";

const STORE_FILE = "managed-client-session-ids.json";
const LEASE_DIRECTORY = "managed-client-leases";
export const CODEX_ROOT_SESSION_FILE = "codex-root-session.json";
const CODEX_ROOT_TRANSFER_LOCK = "codex-root-session-transfer.lock";
const CODEX_OPTIONS_WITH_VALUE = new Set([
  "-a", "--ask-for-approval", "-C", "--cd", "-c", "--config",
  "--disable", "--enable", "--local-provider", "-m", "--model",
  "-p", "--profile", "--remote", "--remote-auth-token-env",
  "-s", "--sandbox", "--add-dir",
]);
const CODEX_TOP_LEVEL_COMMANDS = new Set([
  "agents", "app", "app-server", "apply", "archive", "cloud", "completion", "debug", "delete",
  "doctor", "e", "exec", "exec-server", "features", "fork", "help", "login", "logout", "mcp",
  "mcp-server", "migrate-rollouts", "plugin", "queue", "remote-control", "resume", "review", "sandbox",
  "unarchive", "update",
]);

function codexTopLevelCommandIndex(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") return -1;
    if (argument.startsWith("-") && argument.includes("=")) continue;
    if (argument === "-i" || argument === "--image") {
      while (index + 1 < args.length) {
        const candidate = args[index + 1];
        if (candidate === "--" || candidate.startsWith("-") || CODEX_TOP_LEVEL_COMMANDS.has(candidate)) break;
        index += 1;
      }
      continue;
    }
    if (CODEX_OPTIONS_WITH_VALUE.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    return CODEX_TOP_LEVEL_COMMANDS.has(argument) ? index : -1;
  }
  return -1;
}

function opaqueId() {
  return `swc_${randomUUID().replaceAll("-", "")}`;
}

function validId(value) {
  return typeof value === "string" && /^swc_[a-f0-9]{32}$/.test(value);
}

export function resumedSessionId(host, args) {
  if (host === "codex") {
    const index = codexTopLevelCommandIndex(args);
    if (index < 0) return null;
    if (args[index] !== "resume") return null;
    for (let argumentIndex = index + 1; argumentIndex < args.length; argumentIndex += 1) {
      const argument = args[argumentIndex];
      if (argument === "--last") return null;
      if (argument === "--") return args[argumentIndex + 1] ?? null;
      if (argument.startsWith("-") && argument.includes("=")) continue;
      if (CODEX_OPTIONS_WITH_VALUE.has(argument)) {
        argumentIndex += 1;
        continue;
      }
      if (argument.startsWith("-")) continue;
      return argument;
    }
    return null;
  }
  if (host === "claude") {
    for (let index = 0; index < args.length; index += 1) {
      if (["--resume", "-r", "--session-id"].includes(args[index])) return args[index + 1] ?? null;
    }
  }
  return null;
}

export async function readCodexRootSession(controlDir, expectedClientId = null) {
  try {
    const registration = JSON.parse(await readFile(join(controlDir, CODEX_ROOT_SESSION_FILE), "utf8"));
    if (![1, 2].includes(registration?.version) || typeof registration.session_id !== "string" || !registration.session_id.trim()) return null;
    if (!validId(registration.client_id)) return null;
    if (expectedClientId && registration.client_id !== expectedClientId) return null;
    return { sessionId: registration.session_id.trim(), clientId: registration.client_id };
  } catch {
    return null;
  }
}

async function withCodexRootMutationLock(controlDir, action) {
  const lockPath = join(controlDir, CODEX_ROOT_TRANSFER_LOCK);
  const ownerId = randomUUID();
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(`${JSON.stringify({ version: 1, owner_id: ownerId, pid: process.pid,
      created_at: new Date().toISOString() })}\n`);
  } catch (error) {
    await lock?.close().catch(() => {});
    if (error?.code === "EEXIST") {
      throw new Error("Statewright Codex root ownership changed or is already being updated.");
    }
    throw error;
  }
  await lock.close();
  try { return await action(); }
  finally {
    let existing = null;
    try { existing = JSON.parse(await readFile(lockPath, "utf8")); } catch { /* missing/replaced lock */ }
    if (existing?.owner_id === ownerId) {
      // Ownership is already committed when action returns. A cleanup failure
      // must leave a recoverable stale lock, not turn success into a false
      // native resume error after the durable root has changed.
      await unlink(lockPath).catch(() => {});
    }
  }
}

/**
 * Compare-and-swap a Desktop root registration after the caller has proved
 * that both threads belong to the same immutable project root. The versioned
 * transfer remains in the root record so historical attachment is auditable.
 */
export async function adoptCodexRootSession(controlDir, transfer, {
  now = () => new Date(), renameFile = rename,
} = {}) {
  const required = ["transfer_id", "from_session_id", "to_session_id", "client_id", "root", "issued_at", "expires_at"];
  const allowed = new Set(["version", "kind", ...required]);
  if (transfer?.version !== 1 || transfer?.kind !== "codex_root_session_transfer"
      || required.some(key => typeof transfer[key] !== "string" || !transfer[key].trim())
      || Object.keys(transfer).some(key => !allowed.has(key))
      || !/^[a-f0-9-]{36}$/.test(transfer.transfer_id)
      || !validId(transfer.client_id) || transfer.from_session_id === transfer.to_session_id) {
    throw new Error("Statewright Desktop thread adoption requires a valid typed ownership transfer.");
  }
  const issuedAt = new Date(transfer.issued_at);
  const expiresAt = new Date(transfer.expires_at);
  const lifetimeMs = expiresAt.getTime() - issuedAt.getTime();
  const insideWindow = currentTime => currentTime >= issuedAt && currentTime <= expiresAt;
  if (!Number.isFinite(issuedAt.getTime()) || !Number.isFinite(expiresAt.getTime())
      || lifetimeMs <= 0 || lifetimeMs > 30_000
      || !insideWindow(now())) {
    throw new Error("Statewright Desktop thread adoption transfer is stale.");
  }
  return withCodexRootMutationLock(controlDir, async () => {
    const existing = await readCodexRootSession(controlDir);
    if (existing?.clientId !== transfer.client_id || existing?.sessionId !== transfer.from_session_id) {
      throw new Error("Statewright Desktop thread adoption transfer is stale or belongs to another session.");
    }
    const registration = {
      version: 2,
      session_id: transfer.to_session_id,
      client_id: transfer.client_id,
      ownership_transfer: {
        ...transfer,
        root: resolvePath(transfer.root),
        adopted_at: null,
      },
    };
    const path = join(controlDir, CODEX_ROOT_SESSION_FILE);
    const temporary = `${path}.${process.pid}.${transfer.transfer_id}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(registration)}\n`, { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      const commitTime = now();
      if (!insideWindow(commitTime)) throw new Error("Statewright Desktop thread adoption transfer is stale.");
      registration.ownership_transfer.adopted_at = commitTime.toISOString();
      await writeFile(temporary, `${JSON.stringify(registration)}\n`, { mode: 0o600, flag: "w" });
      if (!insideWindow(now())) throw new Error("Statewright Desktop thread adoption transfer is stale.");
      await renameFile(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(unlinkError => { if (unlinkError?.code !== "ENOENT") throw unlinkError; });
      throw error;
    }
    return registration;
  });
}

export async function resetCodexRootSession(controlDir, { sessionId = null, clientId } = {}) {
  if (sessionId && !validId(clientId)) throw new Error("Statewright Codex root registration requires a valid managed client identity.");
  return withCodexRootMutationLock(controlDir, async () => {
    const path = join(controlDir, CODEX_ROOT_SESSION_FILE);
    await unlink(path).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    if (!sessionId) return null;
    const registration = { version: 1, session_id: sessionId, client_id: clientId };
    await writeFile(path, `${JSON.stringify(registration)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
    return registration;
  });
}

// A new native thread must acquire its root registration without replacing a
// different thread's registration (including one written concurrently by a hook).
export async function claimCodexRootSession(controlDir, { sessionId, clientId }) {
  if (!sessionId || !validId(clientId)) throw new Error("Statewright Codex root registration requires a valid thread and client identity.");
  return withCodexRootMutationLock(controlDir, async () => {
    const path = join(controlDir, CODEX_ROOT_SESSION_FILE);
    const registration = { version: 1, session_id: sessionId, client_id: clientId };
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(registration)}\n`); } finally { await handle.close(); }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readCodexRootSession(controlDir);
      if (existing?.sessionId !== sessionId || existing.clientId !== clientId) {
        throw new Error(`Statewright refused to bind Codex thread '${sessionId}' to a different root session.`);
      }
    }
    return registration;
  });
}

// Native-confirmed TUI attachment, not a Desktop cross-project transfer.
// The caller captures expectedRoot before issuing the native RPC. Hooks or a
// competing attachment must not be overwritten while that RPC is in flight.
export async function commitCodexRootAttachment(controlDir, { sessionId, clientId,
  expectedRoot, assertPending = () => {}, beforeCommit = async () => {} }) {
  const reject = () => { throw Object.assign(new Error("Statewright thread ownership changed during attachment. Resume the conversation again."), {code: "STATEWRIGHT_THREAD_OWNERSHIP"}); };
  if (typeof sessionId !== "string" || !sessionId.trim() || !validId(clientId)) reject();
  return withCodexRootMutationLock(controlDir, async () => {
    assertPending();
    const path = join(controlDir, CODEX_ROOT_SESSION_FILE);
    const existing = await readCodexRootSession(controlDir);
    const present = await readFile(path).then(() => true, error => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (present && !existing || existing?.clientId && existing.clientId !== clientId
        || (existing?.sessionId ?? null) !== (expectedRoot?.sessionId ?? null)
        || (existing?.clientId ?? null) !== (expectedRoot?.clientId ?? null)) reject();
    await beforeCommit();
    assertPending();
    const registration = {version: 1, session_id: sessionId, client_id: clientId};
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(registration)}\n`, {mode: 0o600, flag: "wx"});
      assertPending();
      // Linearization point: cancellation cannot run between the final check
      // and replacement. An awaited rename would reopen that race window.
      renameSync(temporary, path);
      return registration;
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  });
}

export function codexRouteOwnsRoot(request, registration) {
  if (!registration) return false;
  const requestSessionId = String(request?.session_id ?? "").trim();
  const declaredRoot = String(request?.root_session_id ?? "").trim();
  return request?.client_id === registration.clientId
    && requestSessionId === registration.sessionId
    && (!declaredRoot || declaredRoot === registration.sessionId);
}

function storePath(home) {
  return join(home, ".statewright", STORE_FILE);
}

function leasePath(home, host, sessionId) {
  const digest = createHash("sha256").update(`${host}-thread:${sessionId}`).digest("hex").slice(0, 32);
  return join(home, ".statewright", LEASE_DIRECTORY, `${host}-${digest}.json`);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Claim exclusive ownership of a resumed managed session while its native TUI
 * is attached. The durable client ID intentionally survives restarts, but it
 * must never allow a second live supervisor to overwrite the resident's root
 * thread registration.
 */
export async function claimManagedSessionOwner({ host, sessionId, clientId, home = homedir(), cwd = process.cwd(), pid = process.pid }) {
  if (!sessionId || !validId(clientId)) return null;
  const path = leasePath(home, host, sessionId);
  const ownerId = randomUUID();
  const record = {
    version: 1,
    owner_id: ownerId,
    host,
    session_id: sessionId,
    client_id: clientId,
    cwd: resolvePath(cwd),
    pid,
    started_at: new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(record)}\n`); } finally { await handle.close(); }
      await chmod(path, 0o600);
      return record;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let existing = null;
      try { existing = JSON.parse(await readFile(path, "utf8")); } catch { /* retry stale/corrupt lease once */ }
      if (Number.isInteger(existing?.pid) && processAlive(existing.pid)) {
        throw new Error(
          `Statewright refused to attach a second managed writer to Codex thread '${sessionId}' in ${resolvePath(cwd)}. `
          + `The existing owner is pid ${existing.pid}; close that session before resuming this exact thread.`,
        );
      }
      await unlink(path).catch((unlinkError) => { if (unlinkError?.code !== "ENOENT") throw unlinkError; });
    }
  }
  throw new Error(`Statewright could not claim managed ownership for Codex thread '${sessionId}'.`);
}

export async function releaseManagedSessionOwner({ host, sessionId, ownerId, home = homedir() }) {
  if (!host || !sessionId || !ownerId) return false;
  const path = leasePath(home, host, sessionId);
  try {
    const existing = JSON.parse(await readFile(path, "utf8"));
    if (existing?.owner_id !== ownerId) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function loadStore(home) {
  try {
    const parsed = JSON.parse(await readFile(storePath(home), "utf8"));
    return parsed && typeof parsed === "object" && typeof parsed.bindings === "object"
      ? parsed
      : { version: 1, bindings: {} };
  } catch {
    return { version: 1, bindings: {} };
  }
}

async function saveStore(home, store) {
  const path = storePath(home);
  await mkdir(join(home, ".statewright"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function withStoreLock(home, action) {
  const lockPath = `${storePath(home)}.lock`;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  let handle;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { handle = await open(lockPath, "wx", 0o600); break; }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
    }
  }
  if (!handle) throw new Error("Statewright managed identity store is locked; identity change refused.");
  try { return await action(); }
  finally { await handle.close(); await unlink(lockPath); }
}

function bindingKey(host, sessionId, cwd) {
  return `${host}:${sessionId}:${resolvePath(cwd || process.cwd())}`;
}

export function tmuxWindowLabel(environment = process.env, exec = execFileSync) {
  // TMUX_PANE alone may survive into a detached child. Require the live tmux
  // socket marker as well, and treat every probe failure as absent metadata.
  if (!String(environment.TMUX ?? "").trim()) return null;
  const pane = String(environment.TMUX_PANE ?? "").trim();
  if (!pane) return null;
  try {
    exec("tmux", ["has-session", "-t", pane], { stdio: "ignore" });
    const label = exec("tmux", ["display-message", "-p", "-t", pane, "#{window_name}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return label && label.length <= 80 && !/[\r\n\0]/.test(label) ? label : null;
  } catch { return null; }
}

export async function bindManagedSessionLabel({ host, sessionId, label, cwd, home = homedir() }) {
  if (!sessionId || !label) return false;
  return withStoreLock(home, async () => {
    const store = await loadStore(home);
    store.labels = store.labels && typeof store.labels === "object" ? store.labels : {};
    store.labels[`${host}:${sessionId}`] = { label, cwd: resolvePath(cwd), recorded_at: new Date().toISOString() };
    await saveStore(home, store);
    return true;
  });
}

export async function readManagedSessionLabels(home = homedir()) {
  const store = await loadStore(home);
  return store.labels && typeof store.labels === "object" ? store.labels : {};
}

export async function resolveManagedClientIdentity({ host, args, home = homedir(), cwd = process.cwd() }) {
  const sessionId = resumedSessionId(host, args);
  if (!sessionId) return { clientId: opaqueId(), sessionId: null, restored: false };
  return withStoreLock(home, async () => {
    const store = await loadStore(home);
    const key = bindingKey(host, sessionId, cwd);
    const restored = store.bindings[key];
    if (validId(restored)) return { clientId: restored, sessionId, restored: true };
    // Scope resumed identities by project. A thread may be resumed from a
    // different checkout; reusing the old client ID could attach it to the
    // wrong resident app-server and cross project boundaries.
    const scopedClientId = opaqueId();
    store.bindings[key] = scopedClientId;
    await saveStore(home, store);
    return { clientId: scopedClientId, sessionId, restored: false };
  });
}

export async function bindManagedClientIdentity({ host, sessionId, clientId, home = homedir(), cwd = process.cwd(), preserveExisting = false }) {
  if (!sessionId || !validId(clientId)) return false;
  return withStoreLock(home, async () => {
    const store = await loadStore(home);
    const key = bindingKey(host, sessionId, cwd);
    if (store.bindings[key] === clientId) return true;
    if (store.bindings[key] && store.bindings[key] !== clientId) {
      // A native picker can attach a historical thread through a new resident.
      // Keep its original durable client mapping and approval continuity.
      if (preserveExisting) return false;
      throw new Error(`Statewright managed identity conflict for ${host} session '${sessionId}'.`);
    }
    store.bindings[key] = clientId;
    await saveStore(home, store);
    return true;
  });
}

/** Recover only an operator-verified approved thread whose initial identity
 * was not persisted. Never overwrite a live writer or a foreign checkpoint. */
export async function recoverApprovedCodexIdentity({ sessionId, originalClientId, detachedClientId,
  home = homedir(), cwd = process.cwd(), verifyApproval }) {
  if (!sessionId || !validId(originalClientId) || !validId(detachedClientId)
      || originalClientId === detachedClientId || typeof verifyApproval !== "function") {
    throw new Error("Statewright approved identity recovery requires exact, distinct client IDs and live verification.");
  }
  const root = clientId => join(home, ".statewright", "codex-app-server", clientId);
  for (const clientId of [originalClientId, detachedClientId]) {
    const registration = await readCodexRootSession(join(root(clientId), "routes"), clientId);
    if (registration?.sessionId !== sessionId) throw new Error("Statewright approved identity recovery root mismatch.");
    try {
      const manifest = JSON.parse(await readFile(join(root(clientId), "manifest.json"), "utf8"));
      if (Number.isInteger(manifest?.pid) && processAlive(manifest.pid)) {
        throw new Error("Statewright approved identity recovery refused a live resident.");
      }
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  try {
    const lease = JSON.parse(await readFile(leasePath(home, "codex", sessionId), "utf8"));
    if (Number.isInteger(lease?.pid) && processAlive(lease.pid)) {
      throw new Error("Statewright approved identity recovery refused a live owner.");
    }
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const journalName = createHash("sha256").update(JSON.stringify([originalClientId, sessionId])).digest("hex") + ".json";
  const journal = JSON.parse(await readFile(join(root(originalClientId), "approvals", journalName), "utf8"));
  const checkpoint = journal?.state;
  const ticket = checkpoint?.pending_approval;
  if (journal.version !== 1 || journal.threadId !== sessionId || journal.clientId !== originalClientId
      || !checkpoint?.run_id || !checkpoint.run_session_id || !ticket?.approval_id
      || ticket.from_state !== checkpoint.state || !ticket.to_state) {
    throw new Error("Statewright approved identity recovery checkpoint mismatch.");
  }
  const { receipt, state } = await verifyApproval({ threadId: sessionId, clientId: originalClientId, checkpoint });
  if (receipt?.status !== "approved" || receipt.approval_id !== ticket.approval_id
      || receipt.run_id !== checkpoint.run_id
      || receipt.run_session_id !== undefined && receipt.run_session_id !== checkpoint.run_session_id
      || receipt.from_state !== ticket.from_state || receipt.to_state !== ticket.to_state
      || state?.run_id !== checkpoint.run_id || state.run_session_id !== checkpoint.run_session_id
      || state.state !== ticket.to_state || state.pending_approval) {
    throw new Error("Statewright approved identity recovery lacks an authoritative approved destination.");
  }
  return withStoreLock(home, async () => {
    const store = await loadStore(home);
    const key = bindingKey("codex", sessionId, cwd);
    if (store.bindings[key] !== detachedClientId) throw new Error("Statewright approved identity recovery binding changed.");
    store.bindings[key] = originalClientId;
    await saveStore(home, store);
    return { clientId: originalClientId, sessionId, runId: checkpoint.run_id };
  });
}

export async function writeManagedControlIdentity(controlDir, { host, clientId }) {
  const path = join(controlDir, "identity.json");
  await writeFile(path, `${JSON.stringify({ version: 1, host, client_id: clientId })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

// A broker must never replace an identity owned by another managed client.
// `writeManagedControlIdentity` remains for established resident migration
// paths; new isolated launchers use this compare-or-create boundary.
export async function claimManagedControlIdentity(controlDir, { host, clientId }) {
  const path = join(controlDir, "identity.json");
  const desired = { version: 1, host, client_id: clientId };
  try {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(desired)}\n`); } finally { await handle.close(); }
    await chmod(path, 0o600);
    return path;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let existing = null;
    try { existing = JSON.parse(await readFile(path, "utf8")); } catch { /* treated as a conflict */ }
    if (existing?.version !== desired.version || existing?.host !== host || existing?.client_id !== clientId) {
      throw new Error("Statewright Desktop broker refused to replace an existing managed control identity.");
    }
    return path;
  }
}
