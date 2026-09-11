import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startCodexAppServerRuntime } from "./codex-app-server-transport.mjs";
import { createErrorReporter, isExpectedPluginError } from "./error-reporting.mjs";
import { codexRouteOwnsRoot, readCodexRootSession, writeManagedControlIdentity } from "./managed-client-identity.mjs";
import { ManagedMcpBridge } from "./managed-mcp-bridge.mjs";
import { resolveApiKey } from "./remote-client.mjs";
import { createTelemetryWriter } from "./telemetry.mjs";

const EXECUTOR_ROOT = dirname(fileURLToPath(import.meta.url));
const RESIDENT_ENTRYPOINT = join(EXECUTOR_ROOT, "codex-app-server-resident.mjs");
const RESIDENT_RUNTIME_FILES = [
  RESIDENT_ENTRYPOINT,
  join(EXECUTOR_ROOT, "codex-app-server-transport.mjs"),
  join(EXECUTOR_ROOT, "codex-app-server-route-proxy.mjs"),
  join(EXECUTOR_ROOT, "model-ladder.mjs"),
  join(EXECUTOR_ROOT, "error-reporting.mjs"),
  join(EXECUTOR_ROOT, "managed-client-identity.mjs"),
];

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 96);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function residentRoot(home, clientId) {
  return join(home, ".statewright", "codex-app-server", safeName(clientId));
}

export function residentControlDir(home, clientId) {
  return join(residentRoot(home, clientId), "routes");
}

async function readManifest(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

export async function residentRuntimeRevision() {
  const sources = await Promise.all(RESIDENT_RUNTIME_FILES.map((path) => readFile(path, "utf8")));
  return createHash("sha256").update(sources.join("\n--- statewright resident module ---\n")).digest("hex").slice(0, 16);
}

export function residentMatchesRuntime(manifest, runtimeRevision, threadListCwd = undefined) {
  if (manifest?.runtimeRevision !== runtimeRevision) return false;
  return threadListCwd === undefined || (manifest.threadListCwd ?? null) === threadListCwd;
}

async function ready(manifest, runtimeRevision, threadListCwd) {
  if (!residentMatchesRuntime(manifest, runtimeRevision, threadListCwd) || !manifest?.pid || !processAlive(manifest.pid) || !manifest.proxyUrl) return false;
  try {
    return (await fetch(`${manifest.proxyUrl.replace(/^ws/, "http")}/readyz`, { signal: AbortSignal.timeout(400) })).ok;
  } catch { return false; }
}

async function writeManifest(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function nextCodexResidentRouteRequest(controlDir, clientId, threadId = null, {
  renameImpl = rename,
  unlinkImpl = unlink,
} = {}) {
  const { readdir } = await import("node:fs/promises");
  const entries = (await readdir(controlDir)).filter((name) => name === "route.json" || name.endsWith(".route.json")).sort();
  for (const name of entries) {
    const path = join(controlDir, name);
    const reservationPath = `${path}.${process.pid}.${randomUUID()}.inflight`;
    try {
      await renameImpl(path, reservationPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const retryPath = `${path}.${randomUUID()}.retry.route.json`;
    let settled = false;
    const ack = async () => {
      if (settled) return;
      try {
        await unlinkImpl(reservationPath);
        settled = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        settled = true;
      }
    };
    const release = async () => {
      if (settled) return;
      try {
        await renameImpl(reservationPath, retryPath);
        settled = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        settled = true;
      }
    };
    try {
      const request = JSON.parse(await readFile(reservationPath, "utf8"));
      const registration = await readCodexRootSession(controlDir, clientId);
      if (codexRouteOwnsRoot(request, registration)) {
        if (threadId && request.session_id !== threadId) {
          await release();
          return null;
        }
        return { route: request, ack, release };
      }
      await ack();
      process.stderr.write("[statewright] discarded route request outside the attached Codex root session.\n");
    } catch (error) {
      await release().catch(() => {});
      throw error;
    }
  }
  return null;
}

function telemetryWriter(environment) {
  const explicit = environment.STATEWRIGHT_TELEMETRY_URL?.trim();
  const pocketbase = environment.STATEWRIGHT_PB_URL?.replace(/\/$/, "");
  return createTelemetryWriter(undefined, {
    endpoint: explicit || (pocketbase ? `${pocketbase}/api/gateway/telemetry/events` : null),
    apiKey: environment.STATEWRIGHT_API_KEY ?? null,
  });
}

async function createManagedMcpBridge({ environment, clientId }) {
  const bridge = new ManagedMcpBridge({
    gatewayUrl: environment.STATEWRIGHT_GATEWAY_URL ?? "https://mcp.statewright.ai",
    apiKey: await resolveApiKey(environment),
    clientId,
  });
  await bridge.start();
  return bridge;
}

export async function ensureCodexAppServerResident({ command, cwd, environment = process.env, home = homedir(), clientId, threadListCwd = null }) {
  const root = residentRoot(home, clientId);
  const manifestPath = join(root, "manifest.json");
  const runtimeRevision = await residentRuntimeRevision();
  const existing = await readManifest(manifestPath);
  if (await ready(existing, runtimeRevision, threadListCwd)) return existing;
  if (existing?.pid && processAlive(existing.pid)) {
    throw new Error(
      `Statewright Codex App Server resident ${existing.pid} is still running with a different runtime or resume scope. `
      + "It may be preserving detached work; exit it or wait for it to become idle, then retry.",
    );
  }
  await unlink(manifestPath).catch(() => {});
  await mkdir(root, { recursive: true, mode: 0o700 });
  const logHandle = await open(join(root, "resident.log"), "a", 0o600);
  const child = spawn(process.execPath, [
    RESIDENT_ENTRYPOINT,
    "--client-id", clientId,
    "--command", command,
    "--cwd", cwd,
    "--home", home,
    "--thread-list-cwd", threadListCwd ?? "",
  ], {
    cwd,
    env: { ...environment, STATEWRIGHT_CODEX_RESIDENT_ROOT: root },
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  });
  await logHandle.close();
  child.unref();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const manifest = await readManifest(manifestPath);
    if (await ready(manifest, runtimeRevision, threadListCwd)) return manifest;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  const log = await readFile(join(root, "resident.log"), "utf8").catch(() => "");
  throw new Error(`Timed out waiting for the resident Statewright Codex App Server. ${log.slice(-1200).trim()}`);
}

async function main() {
  const values = Object.fromEntries(process.argv.slice(2).filter((_, index) => index % 2 === 0).map((key, index) => [key.replace(/^--/, ""), process.argv[(index * 2) + 3]]));
  const clientId = values["client-id"];
  const command = values.command;
  const cwd = values.cwd;
  const home = values.home ?? homedir();
  const threadListCwd = values["thread-list-cwd"] || null;
  const reporter = createErrorReporter({ plugin: "codex", version: "0.3.3" });
  reporter.installProcessHandlers();
  if (!clientId || !command || !cwd) throw new Error("resident requires client-id, command, and cwd");
  const root = process.env.STATEWRIGHT_CODEX_RESIDENT_ROOT ?? residentRoot(home, clientId);
  const controlDir = residentControlDir(home, clientId);
  const manifestPath = join(root, "manifest.json");
  await mkdir(controlDir, { recursive: true, mode: 0o700 });
  await writeManagedControlIdentity(controlDir, { host: "codex", clientId });
  const bridge = await createManagedMcpBridge({ environment: process.env, clientId });
  let runtime = null;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runtime?.close();
    await bridge.close();
    await unlink(manifestPath).catch(() => {});
    process.exit(0);
  };
  runtime = await startCodexAppServerRuntime({
    command,
    cwd,
    home,
    clientId,
    environment: {
      ...process.env,
      STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir,
      STATEWRIGHT_MANAGED_CLIENT_HOST: "codex",
      STATEWRIGHT_CLIENT_ID: clientId,
      STATEWRIGHT_MANAGED_MCP_URL: bridge.url,
      STATEWRIGHT_MANAGED_MCP_TOKEN: bridge.token,
    },
    nextRouteRequest: (threadId) => nextCodexResidentRouteRequest(controlDir, clientId, threadId),
    threadListCwd,
    onIdle: stop,
    telemetry: telemetryWriter(process.env),
    reporter,
  });
  await writeManifest(manifestPath, {
    version: 2,
    pid: process.pid,
    clientId,
    proxyUrl: runtime.proxyUrl,
    runtimeRevision: await residentRuntimeRevision(),
    threadListCwd,
    startedAt: new Date().toISOString(),
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === RESIDENT_ENTRYPOINT) {
  main().catch(async (error) => {
    const reporter = createErrorReporter({ plugin: "codex", version: "0.3.3" });
    if (!isExpectedPluginError(error)) await reporter.report(error, { mechanism: "entrypoint", operation: "resident_app_server" });
    process.stderr.write(`[statewright] resident App Server failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
