import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { ManagedMcpBridge } from "./managed-mcp-bridge.mjs";
import { bindManagedClientIdentity, resolveManagedClientIdentity, writeManagedControlIdentity } from "./managed-client-identity.mjs";
import { resolveApiKey } from "./remote-client.mjs";

const CONTINUATION_PROMPT = "Continue the active Statewright workflow in its current state. Use statewright_get_state first.";

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function waitForExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function signalChildGroup(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child exited or the host does not permit process-group signals.
    }
  }
  child.kill(signal);
}

function routeModel(model) {
  return String(model ?? "").replace(/^[^/]+\//, "");
}

async function createManagedMcpBridge({ environment, clientId, bridgeFactory }) {
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
  const model = routeModel(request.model);
  if (!request.session_id) throw new Error("Statewright routing request is missing session_id.");
  if (!model) throw new Error("Statewright routing request is missing model.");
  if (host === "codex") {
    const effort = request.effort || "medium";
    return ["-m", model, "-c", `model_reasoning_effort=${JSON.stringify(effort)}`, ...base,
      "resume", request.session_id, CONTINUATION_PROMPT];
  }
  if (host === "claude") {
    // Plain --resume retains the previous model. A fork retains history but
    // starts a fresh session, so its explicit --model is authoritative.
    return [...base, "--resume", request.session_id, "--fork-session", "--model", model, CONTINUATION_PROMPT];
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
  let bridge = null;
  try {
    const identity = await resolveManagedClientIdentity({ host, args, home });
    const routedClientId = identity.clientId;
    await writeManagedControlIdentity(controlDir, { host, clientId: routedClientId });
    bridge = await createManagedMcpBridge({ environment, clientId: routedClientId, bridgeFactory });
    while (true) {
      const childEnvironment = {
        ...environment,
        STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir,
        STATEWRIGHT_MANAGED_CLIENT_HOST: host,
      };
      if (routedClientId) childEnvironment.STATEWRIGHT_CLIENT_ID = routedClientId;
      if (bridge) {
        childEnvironment.STATEWRIGHT_MANAGED_MCP_URL = bridge.url;
        childEnvironment.STATEWRIGHT_MANAGED_MCP_TOKEN = bridge.token;
      }
      const child = spawn(command, nextArgs, {
        cwd,
        env: childEnvironment,
        stdio: "inherit",
        detached: process.platform !== "win32",
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
          signalChildGroup(child, "SIGINT");
          setTimeout(() => signalChildGroup(child, "SIGTERM"), 1_500).unref();
          setTimeout(() => signalChildGroup(child, "SIGKILL"), 3_000).unref();
          break;
        }
        await delay(pollMs);
      }
      const result = await exit;
      if (!restart) return result.code ?? 1;
    }
  } finally {
    await bridge?.close();
    await rm(controlDir, { recursive: true, force: true });
  }
}

function configPath(home = homedir()) {
  return join(home, ".statewright", "config.json");
}

export async function managedClientEnabled(host, home = homedir()) {
  try {
    const config = JSON.parse(await readFile(configPath(home), "utf8"));
    const managed = config?.routing?.managed_clients;
    if (managed?.enabled !== true) return false;
    // An omitted hosts object enables every supported managed client. Once a
    // host-specific choice exists, only explicit true values are enabled.
    return !managed.hosts || managed.hosts[host] === true;
  } catch {
    return false;
  }
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

export function resolveRealBinary(command, { path = process.env.PATH ?? "", shimDirectory } = {}) {
  if (command.includes("/")) return resolve(command);
  for (const directory of path.split(delimiter).filter(Boolean)) {
    if (shimDirectory && resolve(directory) === resolve(shimDirectory)) continue;
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Unable to resolve the real '${command}' executable outside the Statewright shim directory.`);
}

export async function installManagedClientShim({ host, launcherPath, home = homedir(), realBinary }) {
  if (!["codex", "claude"].includes(host)) throw new Error(`Unsupported managed client host '${host}'.`);
  const shimDirectory = join(home, ".statewright", "bin");
  const binary = realBinary ?? resolveRealBinary(host, { shimDirectory });
  await mkdir(shimDirectory, { recursive: true });
  const shimPath = join(shimDirectory, host);
  await writeFile(shimPath, `#!/usr/bin/env sh\nexec node ${JSON.stringify(launcherPath)} --host ${JSON.stringify(host)} --real-bin ${JSON.stringify(binary)} -- \"$@\"\n`, { mode: 0o755 });
  await chmod(shimPath, 0o755);
  return { shimDirectory, shimPath, realBinary: binary };
}

function shellProfile(shell, home) {
  const name = String(shell ?? "").split("/").at(-1);
  if (name === "zsh") return { path: join(home, ".zshrc"), line: 'export PATH="$HOME/.statewright/bin:$PATH"' };
  if (name === "bash") return { path: join(home, ".bashrc"), line: 'export PATH="$HOME/.statewright/bin:$PATH"' };
  if (name === "fish") return { path: join(home, ".config", "fish", "config.fish"), line: "fish_add_path -m $HOME/.statewright/bin" };
  return null;
}

const SHELL_BLOCK_START = "# >>> statewright managed clients >>>";
const SHELL_BLOCK_END = "# <<< statewright managed clients <<<";

async function installShellPath(shell, home) {
  const profile = shellProfile(shell, home);
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

export async function bootstrapManagedClients({ launcherPath, home = homedir(), path = process.env.PATH, shell = process.env.SHELL } = {}) {
  const installed = [];
  const shimDirectory = join(home, ".statewright", "bin");
  for (const host of ["codex", "claude"]) {
    let realBinary;
    try { realBinary = resolveRealBinary(host, { path, shimDirectory }); } catch { continue; }
    installed.push(await installManagedClientShim({ host, launcherPath, home, realBinary }));
    await setManagedClientEnabled(host, true, home);
  }
  const profile = installed.length > 0 ? await installShellPath(shell, home) : null;
  return { installed, profile, restart_required: Boolean(profile) };
}

export async function uninstallManagedClients({ home = homedir(), shell = process.env.SHELL } = {}) {
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
    const path = join(home, ".statewright", "bin", host);
    try { await unlink(path); removed.push(path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const profile = shellProfile(shell, home);
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
