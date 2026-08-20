import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startCodexAppServerRuntime } from "./codex-app-server-transport.mjs";
import { writeManagedControlIdentity } from "./managed-client-identity.mjs";
import { ManagedMcpBridge } from "./managed-mcp-bridge.mjs";
import { resolveApiKey } from "./remote-client.mjs";
import { createTelemetryWriter } from "./telemetry.mjs";

const EXECUTOR_ROOT = dirname(fileURLToPath(import.meta.url));
const RESIDENT_ENTRYPOINT = join(EXECUTOR_ROOT, "codex-app-server-resident.mjs");
const RESIDENT_RUNTIME_FILES = [
  RESIDENT_ENTRYPOINT,
  join(EXECUTOR_ROOT, "codex-app-server-transport.mjs"),
  join(EXECUTOR_ROOT, "codex-app-server-route-proxy.mjs"),
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

export function residentMatchesRuntime(manifest, runtimeRevision) {
  return manifest?.runtimeRevision === runtimeRevision;
}

async function ready(manifest, runtimeRevision) {
  if (!residentMatchesRuntime(manifest, runtimeRevision) || !manifest?.pid || !processAlive(manifest.pid) || !manifest.proxyUrl) return false;
  try {
    return (await fetch(`${manifest.proxyUrl.replace(/^ws/, "http")}/readyz`, { signal: AbortSignal.timeout(400) })).ok;
  } catch { return false; }
}

async function retireResident(manifest, manifestPath) {
  if (manifest?.pid && processAlive(manifest.pid)) {
    process.kill(manifest.pid, "SIGTERM");
    for (let attempt = 0; attempt < 40 && processAlive(manifest.pid); attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    if (processAlive(manifest.pid)) {
      throw new Error(`Statewright Codex App Server resident ${manifest.pid} did not stop for a runtime update.`);
    }
  }
  await unlink(manifestPath).catch(() => {});
}

async function writeManifest(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function nextRouteRequest(controlDir, clientId) {
  const { readdir } = await import("node:fs/promises");
  const entries = (await readdir(controlDir)).filter((name) => name === "route.json" || name.endsWith(".route.json")).sort();
  for (const name of entries) {
    const path = join(controlDir, name);
    const request = JSON.parse(await readFile(path, "utf8"));
    await unlink(path).catch(() => {});
    if (request.client_id === clientId) return request;
    process.stderr.write("[statewright] discarded route request with a mismatched managed client identity.\n");
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

export async function ensureCodexAppServerResident({ command, cwd, environment = process.env, home = homedir(), clientId }) {
  const root = residentRoot(home, clientId);
  const manifestPath = join(root, "manifest.json");
  const runtimeRevision = await residentRuntimeRevision();
  const existing = await readManifest(manifestPath);
  if (await ready(existing, runtimeRevision)) return existing;
  if (existing?.pid && processAlive(existing.pid)) {
    await retireResident(existing, manifestPath);
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const logHandle = await open(join(root, "resident.log"), "a", 0o600);
  const child = spawn(process.execPath, [RESIDENT_ENTRYPOINT, "--client-id", clientId, "--command", command, "--cwd", cwd, "--home", home], {
    cwd,
    env: { ...environment, STATEWRIGHT_CODEX_RESIDENT_ROOT: root },
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  });
  await logHandle.close();
  child.unref();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const manifest = await readManifest(manifestPath);
    if (await ready(manifest, runtimeRevision)) return manifest;
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
  if (!clientId || !command || !cwd) throw new Error("resident requires client-id, command, and cwd");
  const root = process.env.STATEWRIGHT_CODEX_RESIDENT_ROOT ?? residentRoot(home, clientId);
  const controlDir = residentControlDir(home, clientId);
  const manifestPath = join(root, "manifest.json");
  await mkdir(controlDir, { recursive: true, mode: 0o700 });
  await writeManagedControlIdentity(controlDir, { host: "codex", clientId });
  const bridge = await createManagedMcpBridge({ environment: process.env, clientId });
  const runtime = await startCodexAppServerRuntime({
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
    nextRouteRequest: () => nextRouteRequest(controlDir, clientId),
    telemetry: telemetryWriter(process.env),
  });
  await writeManifest(manifestPath, {
    version: 2,
    pid: process.pid,
    clientId,
    proxyUrl: runtime.proxyUrl,
    runtimeRevision: await residentRuntimeRevision(),
    startedAt: new Date().toISOString(),
  });
  const stop = async () => {
    await runtime.close();
    await bridge.close();
    await unlink(manifestPath).catch(() => {});
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === RESIDENT_ENTRYPOINT) {
  main().catch((error) => { process.stderr.write(`[statewright] resident App Server failed: ${error.message}\n`); process.exitCode = 2; });
}
