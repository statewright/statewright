import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { WebSocket } from "ws";
import { nextCodexResidentRouteRequest } from "./codex-app-server-resident.mjs";
import { startCodexAppServerRuntime } from "./codex-app-server-transport.mjs";
import { ManagedMcpBridge } from "./managed-mcp-bridge.mjs";
import { claimCodexRootSession, claimManagedControlIdentity, readCodexRootSession } from "./managed-client-identity.mjs";
import { gatewayEndpoint, resolveApiKey } from "./remote-client.mjs";

// A Desktop broker is a separate managed client. These names carry process
// handles owned by a parent TUI/session and must not escape into Desktop.
const PARENT_MANAGED_IDENTITY_ENV = [
  "STATEWRIGHT_CLIENT_ID", "STATEWRIGHT_MCP_SESSION_ID", "STATEWRIGHT_ROUTE_CONTROL_DIR",
  "STATEWRIGHT_MANAGED_CLIENT_HOST", "STATEWRIGHT_MANAGED_CLAUDE_ROOT_SESSION_ID",
  "STATEWRIGHT_MANAGED_CODEX_ROOT_SESSION_ID", "STATEWRIGHT_MANAGED_MCP_URL",
  "STATEWRIGHT_MANAGED_MCP_SESSION_ID", "STATEWRIGHT_MANAGED_MCP_TOKEN",
  "STATEWRIGHT_MANAGED_TELEMETRY_OWNER", "STATEWRIGHT_ADAPTER_URL", "STATEWRIGHT_ADAPTER_TOKEN",
  "STATEWRIGHT_DESKTOP_MCP_URL", "STATEWRIGHT_DESKTOP_MCP_TOKEN",
  "CODEX_SESSION_ID", "CODEX_THREAD_ID",
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
  // A Desktop install may be the first Statewright client on this machine.
  // Establish the same private control boundary as the resident TUI before a
  // route reader can observe it.
  await mkdir(plan.controlDir, { recursive: true, mode: 0o700 });
  await claimManagedControlIdentity(plan.controlDir, { host: "codex", clientId: plan.clientId });
  const claimThread = ({ threadId }) => claimCodexRootSession(plan.controlDir, { sessionId: threadId, clientId: plan.clientId });
  let startReserved = false;
  const authorizeThread = async ({ method, threadId }) => {
    const root = await readCodexRootSession(plan.controlDir, plan.clientId);
    const reject = (message) => {
      const error = new Error(message);
      error.code = "STATEWRIGHT_THREAD_OWNERSHIP";
      throw error;
    };
    if (method === "thread/start") {
      if (root || startReserved) reject("Statewright Desktop broker is single-thread experimental; disconnect it before starting another Desktop chat.");
      // The native server chooses the thread id in its response. Reserve the
      // one allowed creation slot before forwarding, so two concurrent starts
      // cannot create a second unbound Desktop thread. A failed start remains
      // fail-closed; restart the explicit experimental broker to retry.
      startReserved = true;
      return;
    }
    if (threadId && (!root || root.sessionId !== threadId)) {
      reject("Statewright Desktop broker only permits its registered Desktop thread; this request was not forwarded.");
    }
  };
  const inheritedBridge = inheritedDesktopMcpBridge(environment);
  const isolatedEnvironment = desktopBrokerEnvironment(environment, plan);
  // The generated launcher starts this bridge before the network-restricted
  // ChatGPT process. Direct CLI callers retain the in-process fallback.
  const bridge = inheritedBridge
    ?? await startMcpBridge({ environment: isolatedEnvironment, clientId: plan.clientId });
  let runtime;
  try {
    runtime = await startRuntime({
      command: plan.command,
      environment: {
        ...isolatedEnvironment,
        STATEWRIGHT_MANAGED_MCP_URL: bridge.url,
        STATEWRIGHT_MANAGED_MCP_TOKEN: bridge.token,
      },
      clientId: plan.clientId,
      nextRouteRequest: (threadId) => nextCodexResidentRouteRequest(plan.controlDir, plan.clientId, threadId),
      onThreadStarted: claimThread,
      authorizeThread,
      requiredMcpToolSuffix: "statewright_get_state",
      requiredMcpReadyTimeoutMs: 30_000,
      stderr,
    });
  } catch (error) {
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
