import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmod, cp, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startCodexAppServerRouteProxy } from "./codex-app-server-route-proxy.mjs";
import { createErrorReporter, isExpectedExit, isExpectedTransportClose } from "./error-reporting.mjs";

const DEFAULT_READY_TIMEOUT_MS = 10_000;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function childStopped(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopOwnedAppServer(child, closed, graceMs) {
  if (!childStopped(child)) child.kill("SIGTERM");
  if (await Promise.race([closed.then(() => true), delay(graceMs).then(() => false)])) return;
  if (!childStopped(child)) child.kill("SIGKILL");
  if (await Promise.race([closed.then(() => true), delay(graceMs).then(() => false)])) return;
  throw new Error(`Statewright could not confirm that its owned Codex App Server process ${child.pid ?? "unknown"} stopped.`);
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  if (!address || typeof address === "string") throw new Error("Unable to reserve a loopback App Server port.");
  return address.port;
}

export function codexAppServerTransportEnabled({ environment = process.env, config = {} } = {}) {
  const override = environment.STATEWRIGHT_CODEX_TRANSPORT?.trim();
  if (override) return override === "app-server";
  return config?.routing?.managed_clients?.codex_transport === "app-server";
}

export function appServerHomePrefixForClient(clientId) {
  return `statewright-${String(clientId).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60)}`;
}

export function routeConfigEdits(route) {
  const model = String(route?.model ?? "").replace(/^[^/]+\//, "").trim();
  const effort = String(route?.effort ?? "").trim();
  if (!model) throw new Error("Statewright App Server route is missing a model.");
  const edits = [{ keyPath: "model", mergeStrategy: "upsert", value: model }];
  if (effort) edits.push({ keyPath: "model_reasoning_effort", mergeStrategy: "upsert", value: effort });
  return edits;
}

async function prepareAppServerHome(codexHome, clientId) {
  const appServerHome = await mkdtemp(join(tmpdir(), `${appServerHomePrefixForClient(clientId)}-app-server-`));
  await chmod(appServerHome, 0o700);
  const entries = await readdir(codexHome, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const source = join(codexHome, entry.name);
    const target = join(appServerHome, entry.name);
    // The isolated config must be mutable for config/batchWrite. Everything else,
    // including auth and installed plugins, is shared read-only by path.
    if (entry.name === "config.toml") {
      await cp(source, target);
    } else {
      await symlink(source, target, entry.isDirectory() ? "dir" : "file");
    }
  }
  const configPath = join(appServerHome, "config.toml");
  await writeFile(configPath, "# Statewright ephemeral App Server configuration.\n", { flag: "a", mode: 0o600 });
  return { appServerHome, configPath };
}

function stripRemoteArgs(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--remote" || arg === "--remote-auth-token-env" || arg === "-m" || arg === "--model") {
      index += 1;
      continue;
    }
    if (arg === "-c" && /(^|\.)model_reasoning_effort\s*=/.test(args[index + 1] ?? "")) {
      index += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function resumeHistoryLimit(environment) {
  const configured = Number.parseInt(environment.STATEWRIGHT_CODEX_RESUME_TURN_LIMIT ?? "4", 10);
  return Number.isInteger(configured) && configured > 0 && configured <= 20 ? configured : 4;
}

async function waitForReady(url, appServer) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (appServer.exitCode !== null) throw new Error(`Codex App Server exited before it became ready (${appServer.exitCode}).`);
    try {
      const response = await fetch(`${url.replace(/^ws/, "http")}/readyz`, { signal: AbortSignal.timeout(250) });
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await delay(100);
  }
  throw new Error("Timed out waiting for the local Codex App Server.");
}

/**
 * Runs the native Codex TUI against one local App Server. A loopback proxy
 * applies a pending route directly to the next native turn/start request.
 */
export async function runCodexAppServerTransport({
  command,
  args,
  environment = process.env,
  cwd = process.cwd(),
  home = homedir(),
  clientId,
  controlDir,
  nextRouteRequest,
  pollMs = 100,
  stderr = process.stderr,
  telemetry = async () => {},
  reporter = createErrorReporter({ plugin: "codex", version: "0.3.3", environment }),
}) {
  let pendingRoute = null;
  const runtime = await startCodexAppServerRuntime({
    command,
    environment,
    cwd,
    home,
    clientId,
    nextRouteRequest: async (threadId) => {
      if (pendingRoute?.session_id && pendingRoute.session_id !== threadId) return null;
      const route = pendingRoute;
      pendingRoute = null;
      return route;
    },
    stderr,
    telemetry,
    reporter,
  });
  let tui;
  try {
    tui = spawn(command, [...stripRemoteArgs(args), "--remote", runtime.proxyUrl], {
      cwd,
      env: environment,
      stdio: "inherit",
    });
    const tuiExit = new Promise((resolveExit, rejectExit) => {
      tui.once("error", rejectExit);
      tui.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    let exited = false;
    tui.once("exit", () => { exited = true; });
    while (!exited) {
      const request = await nextRouteRequest(controlDir).catch(() => null);
      if (request) {
        pendingRoute = request;
        await telemetry("app_server_route_requested", { client_id: clientId, route: request });
      }
      await delay(pollMs);
    }
    const result = await tuiExit;
    if (!isExpectedExit(result)) await reporter.report(new Error("Native Codex TUI exited unexpectedly."), {
      mechanism: "child_exit", host: "codex", operation: "native_tui", exit_code: result.code ?? 1, signal: result.signal,
    });
    return result.code ?? 1;
  } finally {
    if (tui && tui.exitCode === null) tui.kill("SIGTERM");
    await runtime.close();
  }
}

/**
 * Starts the App Server and Statewright route proxy without a terminal UI.
 * A resident owner can keep this runtime alive while native Codex clients
 * attach and detach through the same proxy endpoint.
 */
export async function startCodexAppServerRuntime({
  command,
  environment = process.env,
  cwd = process.cwd(),
  home = homedir(),
  clientId,
  nextRouteRequest = async () => null,
  stderr = process.stderr,
  telemetry = async () => {},
  threadListCwd = null,
  threadLabels = {},
  getThreadLabels = async () => threadLabels,
  onThreadResumed = async () => {},
  idleMs = 500,
  shutdownGraceMs = 1_500,
  onIdle = async () => {},
  reporter = createErrorReporter({ plugin: "codex", version: "0.3.3", environment }),
}) {
  const codexHome = environment.CODEX_HOME ?? join(home, ".codex");
  const port = await reserveLoopbackPort();
  const url = `ws://127.0.0.1:${port}`;
  const { appServerHome } = await prepareAppServerHome(codexHome, clientId);

  const appServer = spawn(command, ["app-server", "--listen", url], {
    cwd,
    env: { ...environment, CODEX_HOME: appServerHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const appServerClosed = new Promise((resolveClosed) => appServer.once("close", resolveClosed));
  appServer.stderr.on("data", (chunk) => stderr.write(chunk));
  appServer.stdout.resume();
  let closing = false;
  appServer.once("error", (error) => { void reporter.report(error, { mechanism: "child_spawn", host: "codex", operation: "app_server" }); });
  appServer.once("exit", (code, signal) => {
    if (!isExpectedExit({ code, signal, shuttingDown: closing })) {
      void reporter.report(new Error("Codex App Server exited unexpectedly."), {
        mechanism: "child_exit", host: "codex", operation: "app_server", exit_code: code ?? 1, signal,
      });
    }
  });

  try {
    await waitForReady(url, appServer);
    const routeProxy = await startCodexAppServerRouteProxy({
      upstreamUrl: url,
      compactResume: environment.STATEWRIGHT_CODEX_COMPACT_RESUME !== "false",
      resumeHistoryLimit: resumeHistoryLimit(environment),
      threadListCwd,
      getThreadLabels,
      onThreadResumed,
      idleMs,
      onIdle,
      takePendingRoute: nextRouteRequest,
      onRouteInjected: async (receipt) => {
        await telemetry("app_server_route_injected", { client_id: clientId, ...receipt });
        stderr.write(`[statewright] injected next-turn route ${receipt.effectiveModel}${receipt.effectiveEffort ? ` (${receipt.effectiveEffort})` : ""}.\n`);
      },
      onRouteConfirmed: async (receipt) => {
        await telemetry(receipt.confirmed ? "app_server_route_confirmed" : "app_server_route_mismatch", { client_id: clientId, ...receipt });
        stderr.write(`[statewright] App Server ${receipt.confirmed ? "confirmed" : "reported a mismatch for"} ${receipt.actualModel}${receipt.actualEffort ? ` (${receipt.actualEffort})` : ""}.\n`);
      },
      onConnection: async ({ direction, method, upstreamUrl, bytes, resultKeys }) => {
        if (!direction) stderr.write("[statewright] native Codex connected to the App Server proxy.\n");
        else stderr.write(`[statewright] App Server proxy ${direction}: ${method ?? upstreamUrl ?? "connection"}${bytes ? ` (${bytes} bytes)` : ""}${resultKeys ? ` [${resultKeys.join(",")}]` : ""}.\n`);
      },
      onTransportError: async ({ side, message, code }) => {
        stderr.write(`[statewright] App Server proxy ${side} transport error: ${message}.\n`);
        if (!closing && !isExpectedTransportClose({ side, code })) await reporter.report(new Error(message), {
          mechanism: "transport", host: "codex", operation: "app_server_proxy", transport: "websocket", side, close_code: code,
        });
      },
      onProtocolError: async ({ side, message }) => {
        if (!closing) await reporter.report(new Error(message), {
          mechanism: "protocol", host: "codex", operation: "app_server_proxy", transport: "websocket", side,
        });
      },
    });
    const ready = await fetch(`${routeProxy.url.replace(/^ws/, "http")}/readyz`);
    if (!ready.ok) throw new Error("Statewright App Server proxy did not become ready.");
    stderr.write(`[statewright] App Server ready at ${routeProxy.url}; upstream ${url}.\n`);
    return {
      proxyUrl: routeProxy.url,
      upstreamUrl: url,
      async close() {
        closing = true;
        await routeProxy.close().catch(async (error) => {
          await reporter.report(error, { mechanism: "shutdown", host: "codex", operation: "app_server_proxy" }).catch(() => {});
        });
        await stopOwnedAppServer(appServer, appServerClosed, shutdownGraceMs);
        // Keep the isolated home addressable after shutdown. A native TUI can
        // still be holding the App Server URL while the owned server exits;
        // deleting the projection turns a recoverable disconnect into
        // Codex's misleading `no rollout found` resume error. Its entries are
        // symlinked to the canonical home and can be replaced next launch.
      },
    };
  } catch (error) {
    closing = true;
    await stopOwnedAppServer(appServer, appServerClosed, shutdownGraceMs);
    // Preserve the projection for a TUI that may still be unwinding after a
    // failed startup; see the normal close path above.
    throw error;
  }
}
