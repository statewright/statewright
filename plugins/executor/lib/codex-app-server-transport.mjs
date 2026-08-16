import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmod, cp, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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

function waitForWebSocket(url, timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
  return new Promise((resolveOpen, rejectOpen) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      rejectOpen(new Error("Timed out connecting to the local Codex App Server."));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolveOpen(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      rejectOpen(new Error("Could not connect to the local Codex App Server."));
    }, { once: true });
  });
}

class AppServerControl {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener("message", (event) => this.accept(event.data));
    socket.addEventListener("close", () => this.rejectAll(new Error("Codex App Server control connection closed.")));
    socket.addEventListener("error", () => this.rejectAll(new Error("Codex App Server control connection failed.")));
  }

  accept(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const request = this.pending.get(String(message.id));
      if (!request) return;
      this.pending.delete(String(message.id));
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else request.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const listener of this.listeners) listener(message);
    }
  }

  rejectAll(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  onNotification(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(method, params = undefined) {
    const id = this.nextId++;
    const payload = { id, method };
    if (params !== undefined) payload.params = params;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        rejectRequest(new Error(`Timed out waiting for Codex App Server '${method}'.`));
      }, 10_000);
      this.pending.set(String(id), { resolve: resolveRequest, reject: rejectRequest, timer });
      this.socket.send(JSON.stringify(payload));
    });
  }

  notify(method, params = undefined) {
    const payload = { method };
    if (params !== undefined) payload.params = params;
    this.socket.send(JSON.stringify(payload));
  }

  close() {
    this.socket.close();
  }
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
 * Runs the native Codex TUI against one local App Server. Routes are applied by
 * hot-reloading a disposable profile only after the current turn completes.
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
}) {
  const codexHome = environment.CODEX_HOME ?? join(home, ".codex");
  const port = await reserveLoopbackPort();
  const url = `ws://127.0.0.1:${port}`;
  const { appServerHome, configPath } = await prepareAppServerHome(codexHome, clientId);

  const appServer = spawn(command, ["app-server", "--listen", url], {
    cwd,
    env: { ...environment, CODEX_HOME: appServerHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  appServer.stderr.on("data", (chunk) => stderr.write(chunk));
  appServer.stdout.resume();

  let control;
  let tui;
  let pendingRoute = null;
  let turnActive = false;
  let applying = false;
  try {
    await waitForReady(url, appServer);
    control = new AppServerControl(await waitForWebSocket(url));
    await control.request("initialize", { clientInfo: { name: "statewright-native-routing", version: "0.1.0" } });
    control.notify("initialized");
    control.onNotification((message) => {
      if (message.method === "turn/started") turnActive = true;
      if (message.method === "turn/completed") turnActive = false;
    });

    async function applyPendingRoute() {
      if (!pendingRoute || turnActive || applying) return;
      applying = true;
      const route = pendingRoute;
      pendingRoute = null;
      try {
        await control.request("config/batchWrite", {
          filePath: configPath,
          reloadUserConfig: true,
          edits: routeConfigEdits(route),
        });
        stderr.write(`[statewright] applied next-turn route ${route.model}${route.effort ? ` (${route.effort})` : ""} without restarting Codex.\n`);
      } catch (error) {
        pendingRoute = route;
        stderr.write(`[statewright] could not apply App Server route: ${error.message}\n`);
      } finally {
        applying = false;
      }
    }

    tui = spawn(command, [...stripRemoteArgs(args), "--remote", url], {
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
      if (request) pendingRoute = request;
      await applyPendingRoute();
      await delay(pollMs);
    }
    return await tuiExit;
  } finally {
    control?.close();
    if (tui && tui.exitCode === null) tui.kill("SIGTERM");
    if (appServer.exitCode === null) appServer.kill("SIGTERM");
    await rm(appServerHome, { recursive: true, force: true });
  }
}
