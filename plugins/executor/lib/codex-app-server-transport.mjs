import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmod, cp, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startCodexAppServerRouteProxy } from "./codex-app-server-route-proxy.mjs";

const DEFAULT_READY_TIMEOUT_MS = 10_000;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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
  appServer.stderr.on("data", (chunk) => stderr.write(chunk));
  appServer.stdout.resume();

  let routeProxy;
  let tui;
  let pendingRoute = null;
  try {
    await waitForReady(url, appServer);
    routeProxy = await startCodexAppServerRouteProxy({
      upstreamUrl: url,
      takePendingRoute: async () => {
        const route = pendingRoute;
        pendingRoute = null;
        return route;
      },
      onRouteInjected: async (receipt) => {
        await telemetry("app_server_route_injected", { client_id: clientId, ...receipt });
        stderr.write(`[statewright] injected next-turn route ${receipt.effectiveModel}${receipt.effectiveEffort ? ` (${receipt.effectiveEffort})` : ""}.\n`);
      },
      onRouteConfirmed: async (receipt) => {
        await telemetry(receipt.confirmed ? "app_server_route_confirmed" : "app_server_route_mismatch", { client_id: clientId, ...receipt });
        stderr.write(`[statewright] App Server ${receipt.confirmed ? "confirmed" : "reported a mismatch for"} ${receipt.actualModel}${receipt.actualEffort ? ` (${receipt.actualEffort})` : ""}.\n`);
      },
    });

    tui = spawn(command, [...stripRemoteArgs(args), "--remote", routeProxy.url], {
      cwd,
      env: environment,
      stdio: "inherit",
    });
    const tuiExit = new Promise((resolveExit, rejectExit) => {
      tui.once("error", rejectExit);
      tui.once("exit", (code) => resolveExit(code ?? 1));
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
    return await tuiExit;
  } finally {
    await routeProxy?.close();
    if (tui && tui.exitCode === null) tui.kill("SIGTERM");
    if (appServer.exitCode === null) appServer.kill("SIGTERM");
    await rm(appServerHome, { recursive: true, force: true });
  }
}
