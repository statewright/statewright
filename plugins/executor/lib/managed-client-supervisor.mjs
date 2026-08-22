import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedMcpBridge } from "./managed-mcp-bridge.mjs";
import { bindManagedClientIdentity, resolveManagedClientIdentity, writeManagedControlIdentity } from "./managed-client-identity.mjs";
import { resolveApiKey } from "./remote-client.mjs";

const CONTINUATION_PROMPT = "Continue the active Statewright workflow in its current state. Use statewright_get_state first.";
const EXECUTOR_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TELEMETRY_AGENT = resolve(EXECUTOR_ROOT, "../../codex/scripts/local-telemetry-agent.mjs");

function telemetryDirectory(environment, home) {
  return environment.STATEWRIGHT_TELEMETRY_DIR ?? join(home, ".statewright", "telemetry", "native-codex");
}

function telemetryPort(environment) {
  const value = Number(environment.STATEWRIGHT_TELEMETRY_PORT ?? 4318);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 4318;
}

function telemetryAgentPath(environment) {
  return environment.STATEWRIGHT_TELEMETRY_AGENT ?? DEFAULT_TELEMETRY_AGENT;
}

function telemetryEnvironment(environment, dataDir) {
  return {
    ...environment,
    STATEWRIGHT_TELEMETRY_DIR: dataDir,
  };
}

async function telemetryHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForTelemetry(port, expectedIdentity, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const health = await telemetryHealth(port);
    if (health?.listener_status === "healthy" && health?.config_identity === expectedIdentity) return health;
    await delay(100);
  }
  return null;
}

async function removeStaleTelemetryLeases(leasesDir) {
  let entries = [];
  try { entries = await readdir(leasesDir); } catch { return; }
  await Promise.all(entries.map(async (entry) => {
    const path = join(leasesDir, entry);
    try {
      const lease = JSON.parse(await readFile(path, "utf8"));
      if (!processAlive(Number(lease?.supervisor_pid))) await unlink(path);
    } catch {
      await unlink(path).catch(() => {});
    }
  }));
}

async function acquireTelemetryLock(lockDir) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(lockDir);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await delay(20);
    }
  }
  throw new Error("Timed out acquiring Statewright telemetry service lock.");
}

async function withTelemetryLock(dataDir, operation) {
  const lockDir = join(dataDir, "managed-service.lock");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await acquireTelemetryLock(lockDir);
  try {
    return await operation();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function localTelemetryIdentity({ agentPath, environment, dataDir }) {
  const result = spawnSync(process.execPath, [agentPath, "--identity"], {
    env: telemetryEnvironment(environment, dataDir),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Statewright telemetry identity failed: ${result.stderr || result.error?.message || "unknown error"}`);
  const identity = JSON.parse(result.stdout);
  if (!identity?.config_identity) throw new Error("Statewright telemetry identity was empty.");
  return identity.config_identity;
}

async function nativeTelemetryEnabled({ environment, home, cwd }) {
  if (environment.STATEWRIGHT_NATIVE_TOKEN_TELEMETRY === "true") return true;
  if (environment.STATEWRIGHT_NATIVE_TOKEN_TELEMETRY === "false") return false;
  for (const path of [join(cwd, ".statewright", "config.json"), join(home, ".statewright", "config.json")]) {
    try {
      const config = JSON.parse(await readFile(path, "utf8"));
      if (config?.telemetry?.codex?.native_tokens === true) return true;
    } catch { /* absent or malformed config is not an opt-in */ }
  }
  return false;
}

export async function acquireManagedTelemetry({ environment = process.env, home = homedir(), cwd = process.cwd(), supervisorId = `${process.pid}-${randomUUID()}`, agentPath = telemetryAgentPath(environment) } = {}) {
  if (!await nativeTelemetryEnabled({ environment, home, cwd })) return null;
  if (environment.STATEWRIGHT_NATIVE_TOKEN_TELEMETRY === "false") return null;
  if (!existsSync(agentPath)) return null;
  const dataDir = telemetryDirectory(environment, home);
  const port = telemetryPort(environment);
  const markerPath = join(dataDir, "managed-service.json");
  const leasesDir = join(dataDir, "managed-service-leases");
  const expectedIdentity = await localTelemetryIdentity({ agentPath, environment, dataDir });
  let leasePath = null;
  await withTelemetryLock(dataDir, async () => {
    await mkdir(leasesDir, { recursive: true, mode: 0o700 });
    await removeStaleTelemetryLeases(leasesDir);
    let health = await telemetryHealth(port);
    if (health?.listener_status === "healthy" && health?.config_identity !== expectedIdentity) {
      throw new Error("Statewright telemetry listener identity conflicts with the managed client configuration. Close the stale managed client and restart it so the listener reloads its configuration; also verify that STATEWRIGHT_API_KEY is current and valid.");
    }
    if (!health) {
      const child = spawn(process.execPath, [agentPath], {
        env: telemetryEnvironment(environment, dataDir),
        stdio: "ignore",
        detached: process.platform !== "win32",
      });
      child.unref();
      health = await waitForTelemetry(port, expectedIdentity);
      if (!health) {
        if (processAlive(child.pid)) child.kill("SIGTERM");
        throw new Error("Statewright managed telemetry listener did not become healthy.");
      }
      await writeFile(markerPath, `${JSON.stringify({ pid: child.pid, config_identity: expectedIdentity })}\n`, { mode: 0o600 });
    }
    leasePath = join(leasesDir, `${supervisorId}.json`);
    await writeFile(leasePath, `${JSON.stringify({ supervisor_pid: process.pid, acquired_at: new Date().toISOString() })}\n`, { mode: 0o600 });
  });
  return {
    dataDir,
    port,
    leasePath,
    async release() {
      await withTelemetryLock(dataDir, async () => {
        if (leasePath) await unlink(leasePath).catch(() => {});
        await removeStaleTelemetryLeases(leasesDir);
        let leases = [];
        try { leases = await readdir(leasesDir); } catch { /* absent is empty */ }
        if (leases.length) return;
        let marker = null;
        try { marker = JSON.parse(await readFile(markerPath, "utf8")); } catch { /* foreign listener */ }
        if (marker?.config_identity === expectedIdentity && processAlive(Number(marker.pid))) {
          process.kill(Number(marker.pid), "SIGTERM");
        }
        await unlink(markerPath).catch(() => {});
      });
    },
  };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function waitForExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function isWindowsCommand(command, platform = process.platform) {
  return windowsPlatform(platform) && /\.(?:cmd|bat)$/i.test(String(command));
}

function signalChildGroup(child, signal, { platform = process.platform, spawnImpl = spawn } = {}) {
  if (!windowsPlatform(platform) && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child exited or the host does not permit process-group signals.
    }
  }
  if (windowsPlatform(platform) && child.pid && signal !== "SIGINT") {
    // A managed .cmd launcher owns a cmd.exe child. Killing only that wrapper
    // leaves the real CLI process behind, so escalate through taskkill's tree
    // semantics after the initial graceful SIGINT attempt.
    const taskkill = spawnImpl("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.once?.("error", () => {});
    taskkill.unref?.();
    return;
  }
  child.kill(signal);
}

function waitForChildExit(exit, milliseconds) {
  return Promise.race([
    exit.then(() => true),
    delay(milliseconds).then(() => false),
  ]);
}

async function restartManagedChild(child, exit, { command, platform = process.platform } = {}) {
  // SIGINT against cmd.exe can terminate the wrapper while leaving its CLI
  // child running. Terminate the tree first and await it before the next
  // routed launch so the old process cannot retain the control directory.
  if (isWindowsCommand(command, platform)) {
    signalChildGroup(child, "SIGTERM", { platform });
    await waitForChildExit(exit, 1_500);
    return;
  }
  signalChildGroup(child, "SIGINT", { platform });
  if (await waitForChildExit(exit, 1_500)) return;
  signalChildGroup(child, "SIGTERM", { platform });
  await waitForChildExit(exit, 1_500);
}

function routeModel(model) {
  return String(model ?? "").replace(/^[^/]+\//, "");
}

export function routeClaudeModel(model) {
  const value = String(model ?? "").trim();
  if (!value) throw new Error("Statewright Claude routing request is missing model.");
  if (/^anthropic\//i.test(value)) return routeModel(value);
  const semantic = value.toLowerCase().match(/(?:^|[-_/])(sol|terra|luna)$/)?.[1];
  if (semantic) return { sol: "opus", terra: "sonnet", luna: "haiku" }[semantic];
  if (/^(?:openai|openai-codex)\//i.test(value)) {
    throw new Error(`Statewright cannot translate OpenAI model '${value}' to Claude; use a sol, terra, or luna route.`);
  }
  return value;
}

export async function createManagedMcpBridge({ environment, clientId, bridgeFactory = (options) => new ManagedMcpBridge(options) }) {
  const apiKey = await resolveApiKey(environment);
  const bridge = await bridgeFactory({
    gatewayUrl: environment.STATEWRIGHT_GATEWAY_URL ?? "https://mcp.statewright.ai",
    apiKey,
    clientId,
  });
  await bridge.start();
  return bridge;
}

function stripRouteArgs(args, host) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    // A routed restart always creates its own `resume <session> <prompt>`
    // invocation. Keeping a prior resume subcommand would leave Codex with
    // two positional session identifiers.
    if (host === "codex" && arg === "resume") break;
    if (arg === "-m" || arg === "--model") {
      index += 1;
      continue;
    }
    if (host === "codex" && arg === "-c" && /(^|\.)model_reasoning_effort\s*=/.test(args[index + 1] ?? "")) {
      index += 1;
      continue;
    }
    if (host === "claude" && (arg === "--resume" || arg === "-r" || arg === "--continue" || arg === "-c" || arg === "--session-id" || arg === "--fork-session")) {
      if (arg !== "--continue" && arg !== "-c" && arg !== "--fork-session") index += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

export function buildRoutedArgs({ host, originalArgs, request }) {
  const base = stripRouteArgs(originalArgs, host);
  const model = host === "claude" ? routeClaudeModel(request.model) : routeModel(request.model);
  if (!request.session_id) throw new Error("Statewright routing request is missing session_id.");
  if (!model) throw new Error("Statewright routing request is missing model.");
  if (host === "codex") {
    const effort = request.effort || "medium";
    return ["-m", model, "-c", `model_reasoning_effort=${JSON.stringify(effort)}`, ...base,
      "resume", request.session_id, CONTINUATION_PROMPT];
  }
  if (host === "claude") {
    // Claude supports an explicit model override while resuming. Preserve the
    // session so its plugin/MCP registration survives a routed model change.
    return [...base, "--resume", request.session_id, "--model", model, CONTINUATION_PROMPT];
  }
  throw new Error(`Unsupported managed client host '${host}'.`);
}

async function nextRouteRequest(controlDir, consumed) {
  const entries = (await readdir(controlDir))
    .filter((name) => name === "route.json" || name.endsWith(".route.json"))
    .sort();
  for (const name of entries) {
    if (consumed.has(name)) continue;
    const request = JSON.parse(await readFile(join(controlDir, name), "utf8"));
    consumed.add(name);
    return request;
  }
  return null;
}

export async function runManagedClient({ host, command, args, environment = process.env, cwd = process.cwd(), home = homedir(), pollMs = 100, bridgeFactory = (options) => new ManagedMcpBridge(options) }) {
  if (!["codex", "claude"].includes(host)) throw new Error(`Unsupported managed client host '${host}'.`);
  const controlDir = await mkdtemp(join(tmpdir(), `statewright-${host}-route-`));
  const consumed = new Set();
  let nextArgs = args;
  // A managed Claude process can spawn native child agents. Those children
  // inherit the bridge identity, but they are not safe restart targets: a
  // process-group signal would tear down the parent/child handoff that Claude
  // owns. Lock routing to the first session that loaded the workflow.
  let claudeRootSessionId = null;
  let bridge = null;
  let telemetry = null;
  try {
    const identity = await resolveManagedClientIdentity({ host, args, home });
    const routedClientId = identity.clientId;
    await writeManagedControlIdentity(controlDir, { host, clientId: routedClientId });
    telemetry = host === "codex"
      ? await acquireManagedTelemetry({ environment, home, cwd, supervisorId: `${host}-${process.pid}-${randomUUID()}` })
      : null;
    if (host === "codex") {
      // Claude receives a compact copy of this shared supervisor. Keep the
      // optional Codex-only transport out of its module-load graph.
      const { codexAppServerTransportEnabled } = await import("./codex-app-server-transport.mjs");
      if (codexAppServerTransportEnabled({
        environment,
        config: await managedClientConfig(home),
      })) {
        const { ensureCodexAppServerResident, residentControlDir } = await import("./codex-app-server-resident.mjs");
        if (identity.sessionId) {
          await bindManagedClientIdentity({ host, sessionId: identity.sessionId, clientId: routedClientId, home });
        }
        const resident = await ensureCodexAppServerResident({ command, cwd, environment, home, clientId: routedClientId });
        const tui = spawn(command, [...args, "--remote", resident.proxyUrl], {
          cwd,
          env: {
            ...environment,
            STATEWRIGHT_ROUTE_CONTROL_DIR: residentControlDir(home, routedClientId),
            STATEWRIGHT_MANAGED_CLIENT_HOST: host,
            STATEWRIGHT_CLIENT_ID: routedClientId,
            STATEWRIGHT_MANAGED_TELEMETRY_OWNER: telemetry ? "supervisor" : "none",
          },
          stdio: "inherit",
        });
        return (await waitForExit(tui)).code ?? 1;
      }
    }
    bridge = await createManagedMcpBridge({ environment, clientId: routedClientId, bridgeFactory });
    while (true) {
      const childEnvironment = {
        ...environment,
        STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir,
        STATEWRIGHT_MANAGED_CLIENT_HOST: host,
        STATEWRIGHT_MANAGED_TELEMETRY_OWNER: telemetry ? "supervisor" : "none",
      };
      if (routedClientId) childEnvironment.STATEWRIGHT_CLIENT_ID = routedClientId;
      if (host === "claude" && claudeRootSessionId) {
        childEnvironment.STATEWRIGHT_MANAGED_CLAUDE_ROOT_SESSION_ID = claudeRootSessionId;
      }
      if (bridge) {
        childEnvironment.STATEWRIGHT_MANAGED_MCP_URL = bridge.url;
        childEnvironment.STATEWRIGHT_MANAGED_MCP_TOKEN = bridge.token;
      }
      const launchViaWindowsShell = isWindowsCommand(command);
      const child = spawn(command, nextArgs, {
        cwd,
        env: childEnvironment,
        stdio: "inherit",
        detached: process.platform !== "win32",
        // Node does not execute .cmd/.bat launchers directly on Windows.
        // This path is only selected for the native launcher discovered during
        // managed-client bootstrap; .exe binaries retain direct spawning.
        shell: launchViaWindowsShell,
        // When a shell launches a .cmd shim, use Node's native Windows
        // argument quoting rather than exposing raw argv to cmd.exe.
        windowsVerbatimArguments: false,
      });
      let exited = false;
      let restart = false;
      child.once("exit", () => { exited = true; });
      const exit = waitForExit(child);
      while (!exited) {
        const request = await nextRouteRequest(controlDir, consumed).catch(() => null);
        if (request) {
          if (request.client_id !== routedClientId) {
            process.stderr.write("[statewright] rejected route request with a mismatched managed client identity.\n");
            continue;
          }
          if (host === "claude") {
            const declaredRoot = String(request.root_session_id ?? "").trim();
            const requestSessionId = String(request.session_id ?? "").trim();
            if (!claudeRootSessionId) claudeRootSessionId = declaredRoot || requestSessionId || null;
            if (!requestSessionId || requestSessionId !== claudeRootSessionId) {
              process.stderr.write("[statewright] deferred Claude model route from a native fork; the parent session remains authoritative.\n");
              continue;
            }
          }
          await bindManagedClientIdentity({
            host,
            sessionId: request.session_id,
            clientId: routedClientId,
            home,
          });
          // An omitted model is an inherited route. The initial unmanaged TUI
          // model is authoritative, so there is no safe or useful restart.
          if (!request.model) continue;
          nextArgs = buildRoutedArgs({ host, originalArgs: args, request });
          restart = true;
          await restartManagedChild(child, exit, { command });
          break;
        }
        await delay(pollMs);
      }
      const result = await exit;
      if (!restart) return result.code ?? 1;
    }
  } finally {
    await telemetry?.release();
    await bridge?.close();
    await rm(controlDir, { recursive: true, force: true });
  }
}

function configPath(home = homedir()) {
  return join(home, ".statewright", "config.json");
}

async function managedClientConfig(home = homedir()) {
  try {
    return JSON.parse(await readFile(configPath(home), "utf8"));
  } catch {
    return {};
  }
}

export async function managedClientEnabled(host, home = homedir()) {
  const config = await managedClientConfig(home);
  const managed = config?.routing?.managed_clients;
  if (managed?.enabled !== true) return false;
  // An omitted hosts object enables every supported managed client. Once a
  // host-specific choice exists, only explicit true values are enabled.
  return !managed.hosts || managed.hosts[host] === true;
}

export async function setManagedClientEnabled(host, enabled, home = homedir()) {
  if (!["codex", "claude"].includes(host)) throw new Error(`Unsupported managed client host '${host}'.`);
  const path = configPath(home);
  let config = {};
  try { config = JSON.parse(await readFile(path, "utf8")); } catch { /* start with an empty user config */ }
  const routing = config.routing && typeof config.routing === "object" ? config.routing : {};
  const managed = routing.managed_clients && typeof routing.managed_clients === "object"
    ? routing.managed_clients : {};
  config.routing = {
    ...routing,
    managed_clients: {
      ...managed,
      // Individual toggles create an explicit host map. Keep the feature
      // globally enabled so disabling Claude cannot silently disable Codex.
      enabled: true,
      hosts: { ...(managed.hosts ?? {}), [host]: Boolean(enabled) },
    },
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function windowsPlatform(platform) {
  return platform === "win32";
}

function samePath(left, right, platform) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return windowsPlatform(platform)
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function commandCandidates(command, platform) {
  if (!windowsPlatform(platform) || extname(command)) return [command];
  // Windows command resolution uses executable extensions. Prefer them over an
  // extensionless sibling left by a POSIX-oriented package installation.
  return [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command];
}

export function resolveRealBinary(command, {
  path = process.env.PATH ?? "",
  shimDirectory,
  platform = process.platform,
  pathSeparator = windowsPlatform(platform) ? ";" : delimiter,
} = {}) {
  if (command.includes("/") || command.includes("\\")) return resolve(command);
  for (const directory of path.split(pathSeparator).filter(Boolean)) {
    if (shimDirectory && samePath(directory, shimDirectory, platform)) continue;
    for (const candidateName of commandCandidates(command, platform)) {
      const candidate = join(directory, candidateName);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Unable to resolve the real '${command}' executable outside the Statewright shim directory.`);
}

export async function installManagedClientShim({ host, launcherPath, home = homedir(), realBinary, platform = process.platform }) {
  if (!["codex", "claude"].includes(host)) throw new Error(`Unsupported managed client host '${host}'.`);
  const shimDirectory = join(home, ".statewright", "bin");
  const binary = realBinary ?? resolveRealBinary(host, { shimDirectory, platform });
  await mkdir(shimDirectory, { recursive: true });
  const shimPath = join(shimDirectory, windowsPlatform(platform) ? `${host}.cmd` : host);
  const contents = windowsPlatform(platform)
    ? `@echo off\r\n\"${process.execPath}\" \"${launcherPath}\" --host \"${host}\" --real-bin \"${binary}\" -- %*\r\n`
    : `#!/usr/bin/env sh\nexec node ${JSON.stringify(launcherPath)} --host ${JSON.stringify(host)} --real-bin ${JSON.stringify(binary)} -- \"$@\"\n`;
  await writeFile(shimPath, contents, { mode: windowsPlatform(platform) ? undefined : 0o755 });
  if (!windowsPlatform(platform)) await chmod(shimPath, 0o755);
  return { shimDirectory, shimPath, realBinary: binary };
}

function shellProfile(shell, home, platform = process.platform) {
  if (windowsPlatform(platform)) {
    return {
      path: join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
      line: '$env:Path = "$HOME\\.statewright\\bin;$env:Path"',
    };
  }
  const name = String(shell ?? "").split("/").at(-1);
  if (name === "zsh") return { path: join(home, ".zshrc"), line: 'export PATH="$HOME/.statewright/bin:$PATH"' };
  if (name === "bash") return { path: join(home, ".bashrc"), line: 'export PATH="$HOME/.statewright/bin:$PATH"' };
  if (name === "fish") return { path: join(home, ".config", "fish", "config.fish"), line: "fish_add_path -m $HOME/.statewright/bin" };
  return null;
}

const SHELL_BLOCK_START = "# >>> statewright managed clients >>>";
const SHELL_BLOCK_END = "# <<< statewright managed clients <<<";

async function installShellPath(shell, home, platform) {
  const profile = shellProfile(shell, home, platform);
  if (!profile) return null;
  let content = "";
  try { content = await readFile(profile.path, "utf8"); } catch { /* create it below */ }
  const block = `${SHELL_BLOCK_START}\n${profile.line}\n${SHELL_BLOCK_END}`;
  const start = SHELL_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const end = SHELL_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`${start}[\\s\\S]*?${end}`, "g");
  const next = expression.test(content)
    ? content.replace(expression, block)
    : `${content}${content && !content.endsWith("\n") ? "\n" : ""}${block}\n`;
  if (next === content) return null;
  await mkdir(dirname(profile.path), { recursive: true });
  await writeFile(profile.path, next, { mode: 0o600 });
  return profile.path;
}

export async function bootstrapManagedClients({
  launcherPath,
  home = homedir(),
  path = process.env.PATH,
  shell = process.env.SHELL,
  platform = process.platform,
  pathSeparator = windowsPlatform(platform) ? ";" : delimiter,
} = {}) {
  const installed = [];
  const shimDirectory = join(home, ".statewright", "bin");
  for (const host of ["codex", "claude"]) {
    let realBinary;
    try { realBinary = resolveRealBinary(host, { path, shimDirectory, platform, pathSeparator }); } catch { continue; }
    installed.push(await installManagedClientShim({ host, launcherPath, home, realBinary, platform }));
    await setManagedClientEnabled(host, true, home);
  }
  const profile = installed.length > 0 ? await installShellPath(shell, home, platform) : null;
  return { installed, profile, restart_required: Boolean(profile) };
}

export async function uninstallManagedClients({ home = homedir(), shell = process.env.SHELL, platform = process.platform } = {}) {
  const config = configPath(home);
  let value = {};
  try { value = JSON.parse(await readFile(config, "utf8")); } catch { /* no Statewright config */ }
  const routing = value.routing && typeof value.routing === "object" ? value.routing : {};
  const managed = routing.managed_clients && typeof routing.managed_clients === "object"
    ? routing.managed_clients : {};
  value.routing = {
    ...routing,
    managed_clients: { ...managed, enabled: false, hosts: { ...(managed.hosts ?? {}), codex: false, claude: false } },
  };
  await mkdir(dirname(config), { recursive: true });
  await writeFile(config, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const removed = [];
  for (const host of ["codex", "claude"]) {
    const path = join(home, ".statewright", "bin", windowsPlatform(platform) ? `${host}.cmd` : host);
    try { await unlink(path); removed.push(path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const profile = shellProfile(shell, home, platform);
  let profileRemoved = false;
  if (profile) {
    try {
      const content = await readFile(profile.path, "utf8");
      const start = SHELL_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const end = SHELL_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const next = content.replace(new RegExp(`${start}[\\s\\S]*?${end}\\n?`, "g"), "");
      if (next !== content) {
        await writeFile(profile.path, next, { mode: 0o600 });
        profileRemoved = true;
      }
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  return { removed, profile: profileRemoved ? profile?.path : null };
}
