import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STORE_FILE = "managed-client-session-ids.json";

function opaqueId() {
  return `swc_${randomUUID().replaceAll("-", "")}`;
}

function deterministicResumeId(host, sessionId) {
  const digest = createHash("sha256")
    .update(`${host}-thread:${sessionId}`)
    .digest("hex")
    .slice(0, 32);
  return `swc_${digest}`;
}

function validId(value) {
  return typeof value === "string" && /^swc_[a-f0-9]{32}$/.test(value);
}

export function resumedSessionId(host, args) {
  if (host === "codex") {
    const index = args.indexOf("resume");
    return index >= 0 ? args[index + 1] ?? null : null;
  }
  if (host === "claude") {
    for (let index = 0; index < args.length; index += 1) {
      if (["--resume", "-r", "--session-id"].includes(args[index])) return args[index + 1] ?? null;
    }
  }
  return null;
}

function storePath(home) {
  return join(home, ".statewright", STORE_FILE);
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

function bindingKey(host, sessionId) {
  return `${host}:${sessionId}`;
}

export async function resolveManagedClientIdentity({ host, args, home = homedir() }) {
  const sessionId = resumedSessionId(host, args);
  if (!sessionId) return { clientId: opaqueId(), sessionId: null, restored: false };
  const store = await loadStore(home);
  const restored = store.bindings[bindingKey(host, sessionId)];
  if (validId(restored)) return { clientId: restored, sessionId, restored: true };
  const clientId = deterministicResumeId(host, sessionId);
  store.bindings[bindingKey(host, sessionId)] = clientId;
  await saveStore(home, store);
  return { clientId, sessionId, restored: false };
}

export async function bindManagedClientIdentity({ host, sessionId, clientId, home = homedir() }) {
  if (!sessionId || !validId(clientId)) return false;
  const store = await loadStore(home);
  const key = bindingKey(host, sessionId);
  if (store.bindings[key] === clientId) return true;
  if (store.bindings[key] && store.bindings[key] !== clientId) {
    throw new Error(`Statewright managed identity conflict for ${host} session '${sessionId}'.`);
  }
  store.bindings[key] = clientId;
  await saveStore(home, store);
  return true;
}

export async function writeManagedControlIdentity(controlDir, { host, clientId }) {
  const path = join(controlDir, "identity.json");
  await writeFile(path, `${JSON.stringify({ version: 1, host, client_id: clientId })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
