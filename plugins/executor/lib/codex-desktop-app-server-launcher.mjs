import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { nextCodexResidentRouteRequest } from "./codex-app-server-resident.mjs";
import { startCodexAppServerRuntime } from "./codex-app-server-transport.mjs";
import { ManagedMcpBridge } from "./managed-mcp-bridge.mjs";
import { readCodexThreadCwds } from "./codex-session-metadata.mjs";
import { adoptCodexRootSession, claimCodexRootSession, claimManagedControlIdentity, readCodexRootSession } from "./managed-client-identity.mjs";
import { gatewayEndpoint, resolveApiKey } from "./remote-client.mjs";
import { getGatewayCredential } from "./credential-store.mjs";
import { resolveGatewayProfile } from "./gateway-profile.mjs";
import { startDesktopBridgePool } from "./desktop-bridge-pool.mjs";
import { runDesktopMultichatRuntime } from "./desktop-multichat-runtime.mjs";
import { desktopWorkflowServices } from "./desktop-workflow-services.mjs";
export { connectDesktopProfile } from "./desktop-device-connect.mjs";

// The selected Desktop record owns the endpoint. A shell's profile or explicit
// API key must never redirect it or supply a credential from another gateway.
export async function desktopProfileEnvironment(state, environment = process.env, home = homedir()) {
  if (!state?.gateway_url) throw new Error("Desktop profile has no gateway; rerun Desktop setup.");
  const isolated = { ...environment };
  for (const name of ["STATEWRIGHT_ENV", "STATEWRIGHT_GATEWAY_URL", "STATEWRIGHT_PB_URL", "STATEWRIGHT_API_KEY"]) delete isolated[name];
  const profile = await resolveGatewayProfile({ ...isolated, STATEWRIGHT_GATEWAY_URL: state.gateway_url }, home);
  return { ...isolated, STATEWRIGHT_GATEWAY_URL: profile.gatewayUrl, ...(profile.authUrl ? { STATEWRIGHT_PB_URL: profile.authUrl } : {}) };
}

export async function startProfileDesktopMcpBridge({ state, environment = process.env, home = homedir(),
  getCredential = getGatewayCredential, startBridge = startDesktopMcpBridge, withLanePool = false }) {
  const selected = await desktopProfileEnvironment(state, environment, home);
  // Do not trigger legacy migration or interactive OAuth from a GUI launch.
  const apiKey = await getCredential(selected.STATEWRIGHT_GATEWAY_URL, { environment: selected, home });
  const createBridge = clientId => startBridge({ environment: { ...selected, STATEWRIGHT_API_KEY: apiKey }, clientId });
  const bridge = await createBridge(state.client_id);
  if (!withLanePool) return bridge;
  let pool;
  try { pool = await startDesktopBridgePool({ profileClientId: state.client_id, legacyBridge: bridge, createBridge }); }
  catch (error) { await bridge.close(); throw error; }
  return { url: bridge.url, token: bridge.token, poolUrl: pool.url, poolToken: pool.token,
    close: async () => { try { await pool.close(); } finally { await bridge.close(); } } };
}

// A Desktop broker is a separate managed client. These names carry process
// handles owned by a parent TUI/session and must not escape into Desktop.
const PARENT_MANAGED_IDENTITY_ENV = [
  "STATEWRIGHT_CLIENT_ID", "STATEWRIGHT_MCP_SESSION_ID", "STATEWRIGHT_ROUTE_CONTROL_DIR",
  "STATEWRIGHT_MANAGED_CLIENT_HOST", "STATEWRIGHT_MANAGED_CLAUDE_ROOT_SESSION_ID",
  "STATEWRIGHT_MANAGED_CODEX_ROOT_SESSION_ID", "STATEWRIGHT_MANAGED_MCP_URL",
  "STATEWRIGHT_MANAGED_MCP_SESSION_ID", "STATEWRIGHT_MANAGED_MCP_TOKEN",
  "STATEWRIGHT_MANAGED_TELEMETRY_OWNER", "STATEWRIGHT_ADAPTER_URL", "STATEWRIGHT_ADAPTER_TOKEN",
  "STATEWRIGHT_DESKTOP_MCP_URL", "STATEWRIGHT_DESKTOP_MCP_TOKEN",
  "STATEWRIGHT_DESKTOP_BRIDGE_POOL_URL", "STATEWRIGHT_DESKTOP_BRIDGE_POOL_TOKEN",
  "CODEX_SESSION_ID", "CODEX_THREAD_ID", "LOCAL_MODELS_RUN_DIR",
  "STATEWRIGHT_CLASSIFIER_APPROVAL_RECEIPT",
];

export function desktopBrokerEnvironment(environment, { controlDir, clientId }) {
  const isolated = { ...environment };
  for (const name of PARENT_MANAGED_IDENTITY_ENV) delete isolated[name];
  return {
    ...isolated,
    STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir,
    STATEWRIGHT_MANAGED_CLIENT_HOST: "codex",
    STATEWRIGHT_CLIENT_ID: clientId,
  };
}

export async function startDesktopMcpBridge({ environment, clientId, bridgeFactory = options => new ManagedMcpBridge(options) }) {
  const bridge = bridgeFactory({
    gatewayUrl: gatewayEndpoint(environment.STATEWRIGHT_GATEWAY_URL ?? "https://mcp.statewright.ai"),
    apiKey: await resolveApiKey(environment),
    clientId,
  });
  await bridge.start();
  return bridge;
}

export function desktopThreadAuthorizer({ controlDir, clientId, home = homedir(),
  readThreadCwds = options => readCodexThreadCwds(options), adoptThread = adoptCodexRootSession,
  now = () => new Date(), transferTtlMs = 30_000 } = {}) {
  if (!Number.isInteger(transferTtlMs) || transferTtlMs <= 0 || transferTtlMs > 30_000) {
    throw new Error("Statewright Desktop thread adoption TTL must be between 1 and 30000 milliseconds.");
  }
  let startReserved = false;
  let pendingAdoption = null;
  return async ({ method, threadId }) => {
    const reject = (message) => {
      const error = new Error(message);
      error.code = "STATEWRIGHT_THREAD_OWNERSHIP";
      throw error;
    };
    if (pendingAdoption) reject("Statewright Desktop historical thread adoption is still pending native confirmation.");
    const reservation = method === "thread/resume" && threadId ? Symbol("desktop-thread-adoption") : null;
    if (reservation) pendingAdoption = reservation;
    try {
      const root = await readCodexRootSession(controlDir);
      if (root && root.clientId !== clientId) reject("Statewright Desktop thread adoption belongs to another managed session.");
      if (method === "thread/start") {
        if (root || startReserved) reject("Statewright Desktop broker is single-thread experimental; disconnect it before starting another Desktop chat.");
        startReserved = true;
        return;
      }
      if (!threadId || root?.sessionId === threadId) return;
      if (!root) reject("Statewright Desktop broker only permits its registered Desktop thread; this request was not forwarded.");
      if (method !== "thread/resume") reject("Statewright Desktop broker only permits its registered Desktop thread; this request was not forwarded.");

      const metadata = await readThreadCwds({ threadIds: [root.sessionId, threadId], home });
      const fromRoot = metadata[root.sessionId]?.cwd;
      const toRoot = metadata[threadId]?.cwd;
      if (!fromRoot || !toRoot || resolve(fromRoot) !== resolve(toRoot)) {
        reject("Statewright Desktop refused to adopt a historical thread from another or unproven project root.");
      }
      const issuedAt = now();
      const transfer = {
        version: 1,
        kind: "codex_root_session_transfer",
        transfer_id: randomUUID(),
        from_session_id: root.sessionId,
        to_session_id: threadId,
        client_id: clientId,
        root: resolve(fromRoot),
        issued_at: issuedAt.toISOString(),
        expires_at: new Date(issuedAt.getTime() + transferTtlMs).toISOString(),
      };
      let settled = false;
      const lifecycle = {
        version: 1,
        kind: "statewright_thread_adoption",
        method: "thread/resume",
        threadId,
        commit: async () => {
          if (settled) throw new Error("Statewright Desktop thread adoption is stale or already settled.");
          settled = true;
          try { return await adoptThread(controlDir, transfer, { now }); }
          finally { if (pendingAdoption === lifecycle) pendingAdoption = null; }
        },
        cancel: async () => {
          if (settled) return;
          settled = true;
          if (pendingAdoption === lifecycle) pendingAdoption = null;
        },
      };
      pendingAdoption = lifecycle;
      return lifecycle;
    } finally {
      if (pendingAdoption === reservation) pendingAdoption = null;
    }
  };
}

function inheritedDesktopMcpBridge(environment) {
  const url = nonEmpty(environment.STATEWRIGHT_DESKTOP_MCP_URL);
  const token = nonEmpty(environment.STATEWRIGHT_DESKTOP_MCP_TOKEN);
  if (!url && !token) return null;
  if (!url || !token) throw new Error("Statewright Desktop MCP bridge identity is incomplete.");
  return { url, token, close: async () => {} };
}

function nonEmpty(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function isManagedClientId(value) {
  return /^swc_[a-f0-9]{32}$/.test(value ?? "");
}

export async function desktopClassifierState({ bridge, clientId, fetchImpl = fetch }) {
  const response = await fetchImpl(`${bridge.url.replace(/\/+$/, "")}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bridge.token}`,
      "X-Statewright-Client-Id": clientId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "statewright-desktop-classifier-state",
      method: "tools/call",
      params: { name: "statewright_get_state", arguments: {} },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Desktop classifier state HTTP ${response.status}`);
  const rpc = await response.json();
  if (!rpc.error && rpc.result?.isError && rpc.result.content?.length === 1
      && rpc.result.content[0].type === "text"
      && rpc.result.content[0].text === "No active workflow. Load a workflow before requesting state.") return null;
  if (rpc.error || rpc.result?.isError) throw new Error("Desktop classifier state is unavailable");
  if (rpc.result?.structuredContent && typeof rpc.result.structuredContent === "object") {
    return rpc.result.structuredContent;
  }
  for (const block of rpc.result?.content ?? []) {
    if (block.type !== "text") continue;
    try {
      const value = JSON.parse(block.text);
      if (value && typeof value === "object") return value;
    } catch { /* another text block may contain the authoritative snapshot */ }
  }
  throw new Error("Desktop classifier state has no authoritative snapshot");
}

async function writeDesktopRuntimeManifest(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function removeOwnedDesktopRuntimeManifest(path, identity) {
  try {
    const current = JSON.parse(await readFile(path, "utf8"));
    if (current.pid === identity.pid && current.proxyToken === identity.proxyToken) await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
}

export function desktopAppServerLaunchPlan(argv, environment = process.env, home = homedir()) {
  const originalCommand = nonEmpty(environment.STATEWRIGHT_DESKTOP_ORIGINAL_CODEX);
  const clientId = nonEmpty(environment.STATEWRIGHT_DESKTOP_CLIENT_ID);
  if (!originalCommand) throw new Error("STATEWRIGHT_DESKTOP_ORIGINAL_CODEX must name the unmodified Desktop-bundled codex executable.");
  if (!clientId) throw new Error("STATEWRIGHT_DESKTOP_CLIENT_ID is required so Desktop routes stay bound to one managed client.");
  if (!isManagedClientId(clientId)) throw new Error("STATEWRIGHT_DESKTOP_CLIENT_ID must use the canonical swc_<32 lowercase hex> managed-client identity.");
  if (!argv.includes("app-server")) throw new Error("Statewright Desktop broker only supports the Desktop app-server invocation.");
  if (originalCommand === process.argv[1]) throw new Error("STATEWRIGHT_DESKTOP_ORIGINAL_CODEX points to the broker itself.");
  return {
    command: originalCommand,
    clientId,
    // Never inherit a TUI/resident route directory.  Desktop is an explicit,
    // isolated experimental surface with its own durable control boundary.
    controlDir: join(home, ".statewright", "codex-desktop-app-server", clientId, "routes"),
  };
}

export async function runDesktopAppServerBroker({
  argv = process.argv.slice(2), environment = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  startRuntime = startCodexAppServerRuntime, startMcpBridge = startDesktopMcpBridge,
  WebSocketImpl = WebSocket, home = homedir(), setExitCode = code => { process.exitCode = code; },
} = {}) {
  const plan = desktopAppServerLaunchPlan(argv, environment, home);
  if (environment.STATEWRIGHT_DESKTOP_BRIDGE_POOL_URL || environment.STATEWRIGHT_DESKTOP_BRIDGE_POOL_TOKEN) {
    if (!environment.STATEWRIGHT_DESKTOP_BRIDGE_POOL_URL || !environment.STATEWRIGHT_DESKTOP_BRIDGE_POOL_TOKEN) {
      throw new Error("Desktop lane allocator identity is incomplete.");
    }
    return runDesktopMultichatRuntime({ plan, environment, home, stdin, stdout, stderr,
      startRuntime, isolateEnvironment: desktopBrokerEnvironment, classifierState: desktopClassifierState,
      WebSocketImpl, setExitCode });
  }
  // A Desktop install may be the first Statewright client on this machine.
  // Establish the same private control boundary as the resident TUI before a
  // route reader can observe it.
  await mkdir(plan.controlDir, { recursive: true, mode: 0o700 });
  await claimManagedControlIdentity(plan.controlDir, { host: "codex", clientId: plan.clientId });
  const isolatedEnvironment = desktopBrokerEnvironment(environment, plan);
  const codexHome = isolatedEnvironment.CODEX_HOME ?? join(home, ".codex");
  const readThreadMetadata = ({ threadIds }) => readCodexThreadCwds({ threadIds, codexHome });
  const claimThread = ({ threadId }) => claimCodexRootSession(plan.controlDir, { sessionId: threadId, clientId: plan.clientId });
  const authorizeThread = desktopThreadAuthorizer({ controlDir: plan.controlDir, clientId: plan.clientId, home, readThreadCwds: readThreadMetadata });
  const inheritedBridge = inheritedDesktopMcpBridge(environment);
  // The generated launcher starts this bridge before the network-restricted
  // ChatGPT process. Direct CLI callers retain the in-process fallback.
  const bridge = inheritedBridge
    ?? await startMcpBridge({ environment: isolatedEnvironment, clientId: plan.clientId });
  let runtime;
  const manifestPath = join(dirname(plan.controlDir), "manifest.json");
  let manifestIdentity = null;
  try {
    const classifierApprovalService = {
      ownsThread: async threadId => (await readCodexRootSession(plan.controlDir, plan.clientId))?.sessionId === threadId,
      getState: () => desktopClassifierState({ bridge, clientId: plan.clientId }),
    };
    runtime = await startRuntime({
      command: plan.command,
      environment: {
        ...isolatedEnvironment,
        STATEWRIGHT_MANAGED_MCP_URL: bridge.url,
        STATEWRIGHT_MANAGED_MCP_TOKEN: bridge.token,
        STATEWRIGHT_CLASSIFIER_APPROVAL_RECEIPT: manifestPath,
      },
      clientId: plan.clientId,
      classifierApprovalService,
      ...desktopWorkflowServices({home, controlDir: plan.controlDir, clientId: plan.clientId,
        ownsThread: classifierApprovalService.ownsThread, getState: classifierApprovalService.getState}),
      nextRouteRequest: (threadId) => nextCodexResidentRouteRequest(plan.controlDir, plan.clientId, threadId),
      getThreadCwds: (threadIds) => readThreadMetadata({ threadIds }),
      onThreadStarted: claimThread,
      authorizeThread,
      requiredMcpToolSuffix: "statewright_get_state",
      requiredMcpReadyTimeoutMs: 30_000,
      stderr,
    });
    if (!runtime.proxyToken) throw new Error("Desktop App Server runtime did not publish its classifier approval token.");
    manifestIdentity = { pid: process.pid, proxyToken: runtime.proxyToken };
    await writeDesktopRuntimeManifest(manifestPath, {
      version: 3,
      ...manifestIdentity,
      clientId: plan.clientId,
      proxyUrl: runtime.proxyUrl,
      startedAt: new Date().toISOString(),
    });
  } catch (error) {
    await runtime?.close().catch(() => {});
    await bridge.close().catch(() => {});
    throw error;
  }
  const socket = new WebSocketImpl(runtime.proxyUrl);
  let closing = null;
  let buffer = "";
  const onData = chunk => {
    buffer += String(chunk);
    for (;;) {
      const boundary = buffer.indexOf("\n");
      if (boundary < 0) break;
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (line && socket.readyState === WebSocketImpl.OPEN) socket.send(line);
    }
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const signalHandlers = new Map();
  const onEnd = () => { void close(); };
  const close = async ({ abnormal = false } = {}) => {
    if (abnormal) setExitCode(1);
    return closing ??= (async () => {
    stdin.off?.("data", onData);
    stdin.off?.("end", onEnd);
    stdin.pause?.();
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    if (socket.readyState === WebSocketImpl.OPEN || socket.readyState === WebSocketImpl.CONNECTING) socket.close();
    try {
      if (manifestIdentity) await removeOwnedDesktopRuntimeManifest(manifestPath, manifestIdentity);
      await runtime.close();
    } finally {
      await bridge.close();
    }
    })().catch(error => {
      setExitCode(1);
      throw error;
    });
  };
  socket.on("message", raw => stdout.write(`${String(raw)}\n`));
  socket.on("error", error => stderr.write(`[statewright] Desktop broker socket error: ${error.message}\n`));
  socket.on("close", () => {
    if (!closing) void close({ abnormal: true }).catch(error => stderr.write(`[statewright] Desktop broker shutdown failed: ${error.message}\n`));
  });
  for (const signal of signals) {
    const handler = () => { void close().finally(() => process.exit(process.exitCode ?? 0)); };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  stdin.once("end", onEnd);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("Desktop broker socket closed before it became ready.")));
  }).catch(async error => { await close(); throw error; });
  // Do not make the Desktop race proxy connection establishment: stdio is
  // intentionally left unread until WebSocket OPEN, so its initial initialize
  // request stays buffered by Node rather than being sent while CONNECTING.
  stdin.on("data", onData);
  return { close, proxyUrl: runtime.proxyUrl };
}
