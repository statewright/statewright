import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedMcpBridge } from "./managed-mcp-bridge.mjs";
import { codexHistoryRepairMode, guardCodexResumeHistory } from "./codex-history-integrity.mjs";
import { bindManagedClientIdentity, codexRouteOwnsRoot, readCodexRootSession, resetCodexRootSession, resolveManagedClientIdentity, resumedSessionId, writeManagedControlIdentity } from "./managed-client-identity.mjs";
import { resolveApiKey } from "./remote-client.mjs";
import { createErrorReporter, isExpectedExit } from "./error-reporting.mjs";
import { providerModel, selectAvailableRoute } from "./model-ladder.mjs";

const CONTINUATION_PROMPT = "Continue the active Statewright workflow in its current state. Use statewright_get_state first.";
export const CODEX_REMOTE_AUTH_TOKEN_ENV = "STATEWRIGHT_CODEX_REMOTE_AUTH_TOKEN";
const EXECUTOR_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TELEMETRY_AGENT = resolve(EXECUTOR_ROOT, "../../codex/scripts/local-telemetry-agent.mjs");
const PARENT_MANAGED_IDENTITY_ENV = [
  CODEX_REMOTE_AUTH_TOKEN_ENV,
  "STATEWRIGHT_CLIENT_ID",
  "STATEWRIGHT_MCP_SESSION_ID",
  "STATEWRIGHT_ROUTE_CONTROL_DIR",
  "STATEWRIGHT_MANAGED_CLIENT_HOST",
  "STATEWRIGHT_MANAGED_CLAUDE_ROOT_SESSION_ID",
  "STATEWRIGHT_MANAGED_CODEX_ROOT_SESSION_ID",
  "STATEWRIGHT_MANAGED_MCP_URL",
  "STATEWRIGHT_MANAGED_MCP_SESSION_ID",
  "STATEWRIGHT_MANAGED_MCP_TOKEN",
  "STATEWRIGHT_MANAGED_TELEMETRY_OWNER",
];
const WINDOWS_PROCESS_TREE_ENV = new Set([
  "comspec",
  "path",
  "pathext",
  "systemroot",
  "temp",
  "tmp",
  "windir",
]);

function statewrightEphemeralCodexHome(value) {
  return typeof value === "string"
    && /(?:^|[\\/])statewright-swc_[a-f0-9]{32}-app-server-[^\\/]+$/.test(value);
}

export function managedClientChildEnvironment({ host, environment = process.env, overrides = {} }) {
  const childEnvironment = { ...environment };
  for (const name of PARENT_MANAGED_IDENTITY_ENV) delete childEnvironment[name];
  if (host === "codex") {
    // Codex exposes the active TUI identity to tools. A nested `codex exec`
    // must create its own thread instead of presenting the parent's active
    // writer identity to another Codex process. Explicit resumes carry their
    // target thread in argv and do not need either inherited variable.
    delete childEnvironment.CODEX_SESSION_ID;
    delete childEnvironment.CODEX_THREAD_ID;
    // A managed App Server may leave its temporary CODEX_HOME in the parent
    // environment. Drop only that Statewright-owned path; preserve an
    // explicitly configured tenant/user home so managed clients remain
    // isolated rather than silently collapsing onto the OS user's default.
    if (statewrightEphemeralCodexHome(childEnvironment.CODEX_HOME)) delete childEnvironment.CODEX_HOME;
  }
  return { ...childEnvironment, ...overrides };
}

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

export async function retireCodexResident(pid, timeoutMs = 3_000, { appServerPid = null } = {}) {
  const targets = [...new Set([pid, appServerPid].filter((candidate) => Number.isInteger(candidate) && candidate > 0))];
  if (!targets.some(processAlive)) return;
  const signal = (targetPid, name) => {
    if (process.platform !== "win32") {
      try {
        process.kill(-targetPid, name);
        return;
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    process.kill(targetPid, name);
  };
  try {
    if (processAlive(pid)) signal(pid, "SIGTERM");
    else if (processAlive(appServerPid)) signal(appServerPid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (targets.some(processAlive) && Date.now() < deadline) await delay(25);
  const survivors = targets.filter(processAlive);
  if (survivors.length > 0) {
    if (process.platform === "win32") {
      await Promise.all(survivors.map((targetPid) => terminateWindowsProcessTree({ pid: targetPid })));
    } else {
      for (const targetPid of survivors) {
        try { signal(targetPid, "SIGKILL"); } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
    }
    const killDeadline = Date.now() + 1_000;
    while (targets.some(processAlive) && Date.now() < killDeadline) await delay(25);
    const remaining = targets.filter(processAlive);
    if (remaining.length > 0) throw new Error(`Statewright Codex App Server process(es) ${remaining.join(", ")} did not retire after target-provider failure.`);
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
      throw new Error(`Statewright telemetry listener identity conflicts with the managed client configuration. Close the stale managed client and restart it so the listener reloads its configuration; also verify that STATEWRIGHT_API_KEY is current and valid. If this project has a stale resident App Server, run: statewright-managed-client --kill-app-server (cwd: ${cwd})`);
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

function waitForSpawn(child) {
  return new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
}

export async function waitForCodexProviderHandoff({ takeHandoff, tuiExit, pollMs = 25 }) {
  while (true) {
    const reservation = await takeHandoff();
    if (reservation) return { reservation, handoff: reservation.handoff ?? reservation, result: null };
    const exited = await Promise.race([
      tuiExit.then((result) => ({ result })),
      delay(pollMs).then(() => null),
    ]);
    if (!exited) continue;
    // The TUI and resident can finish at nearly the same time. Check the
    // atomic handoff one final time before treating the exit as ordinary.
    const finalReservation = await takeHandoff();
    return {
      reservation: finalReservation,
      handoff: finalReservation?.handoff ?? finalReservation,
      result: exited.result,
    };
  }
}

export async function waitForCodexThreadAttachment({ readAttachment, tuiExit, pollMs = 25, timeoutMs = 30_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const attachment = await readAttachment();
    if (attachment) return { attachment, result: null, timedOut: false };
    if (Date.now() >= deadline) return { attachment: null, result: null, timedOut: true };
    const exited = await Promise.race([
      tuiExit.then((result) => ({ result })),
      delay(Math.min(pollMs, Math.max(1, deadline - Date.now()))).then(() => null),
    ]);
    if (!exited) continue;
    return { attachment: await readAttachment(), result: exited.result, timedOut: false };
  }
}

function isWindowsCommand(command, platform = process.platform) {
  return windowsPlatform(platform) && /\.(?:cmd|bat)$/i.test(String(command));
}

function expandWindowsCmdShimPath(value, command) {
  const input = String(value);
  const prefix = "%~dp0";
  if (!input.toLowerCase().startsWith(prefix)) return input;
  return join(dirname(command), input.slice(prefix.length).replace(/^[\\/]+/, ""));
}

async function resolveWindowsCmdShim(command, platform = process.platform) {
  if (!isWindowsCommand(command, platform)) return null;
  let source;
  try {
    source = await readFile(command, "utf8");
  } catch {
    return null;
  }

  // npm's Windows shims invoke Node with a JavaScript entrypoint and forward
  // `%*`. Running that entrypoint directly removes cmd.exe's second argument
  // parse, which otherwise corrupts quoted config values and prompt text.
  const match = source.match(/(?:"([^"\r\n]*node(?:\.exe)?)"|([^\s"\r\n]*node(?:\.exe)?))\s+"([^"\r\n]+\.(?:[cm]?js))"\s+%\*/i);
  if (!match) return null;
  const nodeCandidate = expandWindowsCmdShimPath(match[1] ?? match[2], command);
  const entrypoint = expandWindowsCmdShimPath(match[3], command);
  if (!existsSync(entrypoint)) return null;
  return {
    command: existsSync(nodeCandidate) ? nodeCandidate : "node.exe",
    prefixArgs: [entrypoint],
  };
}

export function windowsProcessTreeEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => WINDOWS_PROCESS_TREE_ENV.has(key.toLowerCase())),
  );
}

export async function terminateWindowsProcessTree(child, {
  environment = process.env,
  spawnImpl = spawn,
  timeoutMs = 1_500,
  closeGraceMs = 500,
} = {}) {
  if (!child.pid) return { status: "missing_pid" };
  let taskkill;
  try {
    taskkill = spawnImpl("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      env: windowsProcessTreeEnvironment(environment),
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (error) {
    return { status: "spawn_error", errorCode: error?.code ?? "unknown" };
  }
  const completion = new Promise((resolveCompletion) => {
    taskkill.once?.("error", (error) => resolveCompletion({ status: "spawn_error", errorCode: error?.code ?? "unknown" }));
    taskkill.once?.("close", (code, signal) => resolveCompletion({ status: code === 0 ? "success" : "nonzero", code, signal }));
  });
  if (await waitForChildExit(completion, timeoutMs)) return completion;
  try { taskkill.kill?.(); } catch { /* cleanup process already exited */ }
  const closedAfterKill = await waitForChildExit(completion, closeGraceMs);
  if (!closedAfterKill) taskkill.unref?.();
  return { status: "timeout", closedAfterKill };
}

async function signalChildGroup(child, signal, { platform = process.platform, spawnImpl = spawn, environment = process.env } = {}) {
  if (!windowsPlatform(platform) && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return { status: "group_signal_sent" };
    } catch {
      // The child exited or the host does not permit process-group signals.
    }
  }
  if (windowsPlatform(platform) && child.pid && signal !== "SIGINT") {
    // A managed .cmd launcher owns a cmd.exe child. Killing only that wrapper
    // leaves the real CLI process behind, so escalate through taskkill's tree
    // semantics after the initial graceful SIGINT attempt.
    return terminateWindowsProcessTree(child, { environment, spawnImpl });
  }
  child.kill(signal);
  return { status: "child_signal_sent" };
}

function waitForChildExit(exit, milliseconds) {
  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveWait(result);
    };
    const timer = setTimeout(() => finish(false), milliseconds);
    exit.then(() => finish(true));
  });
}

function processGroupAlive(child, platform) {
  if (windowsPlatform(platform) || !child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitForManagedChildExit(child, exit, milliseconds, platform) {
  const deadline = Date.now() + milliseconds;
  if (!await waitForChildExit(exit, milliseconds)) return false;
  if (windowsPlatform(platform)) return true;
  while (processGroupAlive(child, platform)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(25, remaining)));
  }
  return true;
}

export async function restartManagedChild(child, exit, {
  command,
  platform = process.platform,
  environment = process.env,
  spawnImpl = spawn,
  cleanupProcessTree = terminateWindowsProcessTree,
} = {}) {
  // SIGINT against cmd.exe can terminate the wrapper while leaving its CLI
  // child running. Terminate the tree first and await it before the next
  // routed launch so the old process cannot retain the control directory.
  if (isWindowsCommand(command, platform)) {
    const cleanup = await cleanupProcessTree(child, { environment, spawnImpl });
    if (cleanup.status !== "success") {
      throw new Error(`Windows managed-client process-tree cleanup failed (${cleanup.status}).`);
    }
    if (!await waitForManagedChildExit(child, exit, 1_500, platform)) {
      throw new Error("Windows managed client remained active after successful process-tree cleanup.");
    }
    return;
  }
  await signalChildGroup(child, "SIGINT", { platform, environment });
  if (await waitForManagedChildExit(child, exit, 1_500, platform)) return;
  await signalChildGroup(child, "SIGTERM", { platform, environment });
  if (await waitForManagedChildExit(child, exit, 1_500, platform)) return;
  await signalChildGroup(child, "SIGKILL", { platform, environment });
  if (!await waitForManagedChildExit(child, exit, 1_500, platform)) {
    throw new Error("POSIX managed client remained active after SIGKILL process-group cleanup.");
  }
}

function routeModel(model) {
  return String(model ?? "").replace(/^[^/]+\//, "");
}

export function buildCodexRemoteConnection({ proxyUrl, launchNonce = null }) {
  const args = ["--remote", String(proxyUrl)];
  if (!launchNonce) return { args, environment: {} };
  return {
    args: [...args, "--remote-auth-token-env", CODEX_REMOTE_AUTH_TOKEN_ENV],
    environment: { [CODEX_REMOTE_AUTH_TOKEN_ENV]: launchNonce },
  };
}

export function codexThreadAttachmentMatches(attachment, handoff, launchNonce) {
  if (!attachment || !handoff || !launchNonce) return false;
  const expectedProvider = providerModel(`${handoff.provider}/_`).provider;
  const expectedModel = routeModel(handoff.model).trim();
  const expectedEffort = String(handoff.effort ?? "").trim() || null;
  const expectedMethod = handoff.resume === false ? "thread/start" : "thread/resume";
  return attachment.launchNonce === launchNonce
    && attachment.method === expectedMethod
    && attachment.provider === expectedProvider
    && attachment.requestedProvider === expectedProvider
    && routeModel(attachment.model).trim() === expectedModel
    && routeModel(attachment.requestedModel).trim() === expectedModel
    && (!expectedEffort || (attachment.effort === expectedEffort && attachment.requestedEffort === expectedEffort))
    && (handoff.resume === false || attachment.threadId === handoff.threadId);
}

const CODEX_OPTIONS_WITH_VALUE = new Set([
  "-a", "--ask-for-approval", "-C", "--cd", "-c", "--config",
  "--disable", "--enable", "--local-provider", "-m", "--model", "-p", "--profile", "--remote",
  "--remote-auth-token-env", "-s", "--sandbox", "--add-dir",
]);
const CODEX_TOP_LEVEL_COMMANDS = new Set([
  "agents", "app", "app-server", "apply", "archive", "cloud", "completion", "debug", "delete",
  "doctor", "e", "exec", "exec-server", "features", "fork", "help", "login", "logout", "mcp",
  "mcp-server", "migrate-rollouts", "plugin", "queue", "remote-control", "resume", "review", "sandbox",
  "unarchive", "update",
]);

export function codexOneShotInvocation(host, args) {
  if (host !== "codex") return false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    // `--` ends option/subcommand parsing; any following `exec` is prompt text.
    if (argument === "--") return false;
    if (argument.startsWith("-") && argument.includes("=")) continue;
    if (argument === "-i" || argument === "--image") {
      // Clap accepts one or more image paths. Stop only when the next token is
      // another option or a real top-level Codex command.
      while (index + 1 < args.length) {
        const candidate = args[index + 1];
        if (candidate === "--" || candidate.startsWith("-") || CODEX_TOP_LEVEL_COMMANDS.has(candidate)) break;
        index += 1;
      }
      continue;
    }
    if (CODEX_OPTIONS_WITH_VALUE.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    // Codex advertises `e` as the exec alias and `review` as a separate
    // non-interactive top-level command. Any other first positional token is
    // either an interactive command (including resume) or its prompt.
    return argument === "exec" || argument === "e" || argument === "review";
  }
  return false;
}

function forwardManagedTermination(child, exit, { command, platform = process.platform, environment = process.env } = {}) {
  let termination = null;
  const forward = (signal) => {
    termination ??= (async () => {
      if (isWindowsCommand(command, platform)) {
        await signalChildGroup(child, "SIGTERM", { platform, environment });
      } else {
        await signalChildGroup(child, signal, { platform, environment });
      }
      if (await waitForManagedChildExit(child, exit, 1_500, platform)) return;
      await signalChildGroup(child, "SIGTERM", { platform, environment });
      if (await waitForManagedChildExit(child, exit, 1_500, platform)) return;
      if (isWindowsCommand(command, platform)) {
        throw new Error("Windows managed client remained active after process-tree termination.");
      }
      await signalChildGroup(child, "SIGKILL", { platform, environment });
      if (!await waitForManagedChildExit(child, exit, 1_500, platform)) {
        throw new Error("POSIX managed client remained active after terminal-loss SIGKILL cleanup.");
      }
    })();
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  const onSighup = () => forward("SIGHUP");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  if (!windowsPlatform(platform)) process.once("SIGHUP", onSighup);
  return async () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (!windowsPlatform(platform)) process.off("SIGHUP", onSighup);
    await termination;
  };
}

export function codexAllSessionsRequested(args = []) {
  const boundary = args.indexOf("--");
  return args.slice(0, boundary < 0 ? args.length : boundary).includes("--all");
}

export function codexProfileFromArgs(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;
    if (arg === "-p" || arg === "--profile") return String(args[index + 1] ?? "").trim() || null;
    if (arg.startsWith("--profile=")) return arg.slice("--profile=".length).trim() || null;
    if (arg.startsWith("-p=")) return arg.slice(3).trim() || null;
    if (arg === "resume") break;
  }
  return null;
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
  const isRouteConfigOverride = (value) => {
    const key = String(value ?? "").split("=", 1)[0].trim();
    return /(?:^|\.)\s*(?:["'](?:model|model_reasoning_effort|model_provider)["']|model|model_reasoning_effort|model_provider)\s*$/.test(key);
  };
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
    if (/^(?:-m|--model)=/.test(arg)) continue;
    if (host === "codex" && (arg === "-c" || arg === "--config") && isRouteConfigOverride(args[index + 1])) {
      index += 1;
      continue;
    }
    if (host === "codex" && /^(?:-c|--config)=/.test(arg) && isRouteConfigOverride(arg.slice(arg.indexOf("=") + 1))) continue;
    if (host === "codex" && arg === "--oss") continue;
    if (host === "codex" && arg === "--local-provider") {
      index += 1;
      continue;
    }
    if (host === "codex" && arg.startsWith("--local-provider=")) continue;
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
  const parsed = providerModel(request.model);
  const model = host === "claude" ? routeClaudeModel(request.model) : parsed.model;
  if (!request.session_id) throw new Error("Statewright routing request is missing session_id.");
  if (!model) throw new Error("Statewright routing request is missing model.");
  if (host === "codex") {
    const effort = request.effort || "medium";
    const providerArgs = parsed.provider ? ["-c", `model_provider=${JSON.stringify(parsed.provider)}`] : [];
    return ["-m", model, ...providerArgs, "-c", `model_reasoning_effort=${JSON.stringify(effort)}`, ...base,
      "resume", request.session_id, CONTINUATION_PROMPT];
  }
  if (host === "claude") {
    // Claude supports an explicit model override while resuming. Preserve the
    // session so its plugin/MCP registration survives a routed model change.
    return [...base, "--resume", request.session_id, "--model", model, CONTINUATION_PROMPT];
  }
  throw new Error(`Unsupported managed client host '${host}'.`);
}

export function buildCodexAppServerHandoffArgs({ originalArgs, handoff }) {
  if (!handoff?.threadId) throw new Error("Statewright Codex provider handoff is missing threadId.");
  if (!handoff?.model) throw new Error("Statewright Codex provider handoff is missing model.");
  const routed = stripRouteArgs(originalArgs, "codex");
  const base = [];
  for (let index = 0; index < routed.length; index += 1) {
    const arg = routed[index];
    if (arg === "--" || !arg.startsWith("-")) break;
    if (arg === "-p" || arg === "--profile") {
      index += 1;
      continue;
    }
    if (/^(?:-p|--profile)=/.test(arg)) continue;
    // Images belong to the original prompt payload and must not be replayed
    // when the same thread is relaunched under another provider.
    if (arg === "-i" || arg === "--image") {
      while (index + 1 < routed.length && !routed[index + 1].startsWith("-")) index += 1;
      continue;
    }
    if (/^(?:-i|--image)=/.test(arg)) continue;
    base.push(arg);
    if (CODEX_OPTIONS_WITH_VALUE.has(arg) && index + 1 < routed.length) {
      base.push(routed[++index]);
    }
  }
  const launch = [
    ...(handoff.profile ? ["--profile", handoff.profile] : []),
    "-m", routeModel(handoff.model),
    ...base,
  ];
  return handoff.resume === false ? launch : [...launch, "resume", handoff.threadId];
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

export async function runManagedClient({ host, command, args, environment = process.env, cwd = process.cwd(), home = homedir(), pollMs = 100, bridgeFactory = (options) => new ManagedMcpBridge(options), historyGuard = guardCodexResumeHistory, reporter = createErrorReporter({ plugin: host === "claude" ? "claude-code" : "codex", version: host === "claude" ? "0.3.1" : "0.3.2", environment }) }) {
  if (!["codex", "claude"].includes(host)) throw new Error(`Unsupported managed client host '${host}'.`);
  const cmdShim = await resolveWindowsCmdShim(command);
  const launchCommand = cmdShim?.command ?? command;
  const launchPrefixArgs = cmdShim?.prefixArgs ?? [];
  const oneShotCodexExec = codexOneShotInvocation(host, args);
  const controlDir = await mkdtemp(join(tmpdir(), `statewright-${host}-route-`));
  const consumed = new Set();
  let nextArgs = args;
  // Managed clients can spawn native children. Those children inherit the
  // bridge identity, but are not safe restart targets: a process-group signal
  // would tear down the parent/child handoff. Lock routing to the durable root
  // session rather than trusting the shared client ID alone.
  let claudeRootSessionId = null;
  let codexRootSessionId = null;
  let bridge = null;
  let telemetry = null;
  try {
    const identity = await resolveManagedClientIdentity({ host, args, home, cwd });
    const routedClientId = identity.clientId;
    if (host === "codex") codexRootSessionId = identity.sessionId;
    const config = host === "codex" ? await managedClientConfig(home) : {};
    const preflightCodexHistory = async (launchArgs) => {
      const sessionId = host === "codex" ? resumedSessionId("codex", launchArgs) : null;
      if (!sessionId) return { status: "not_applicable" };
      const historyResult = await historyGuard({
        home,
        cwd,
        args: launchArgs,
        environment,
        sessionId,
        mode: codexHistoryRepairMode({ environment, config }),
      });
      if (historyResult?.status === "repaired") {
        if (historyResult.repairKind === "stale_rollout_pointer") process.stderr.write(`[statewright] backed up the Codex state database and restored this thread's canonical rollout pointer.\n`);
        else process.stderr.write(`[statewright] backed up and repaired ${historyResult.droppedRecords} duplicate Codex restart metadata record(s); rebuilding this thread's derived history projection.\n`);
      }
      return historyResult;
    };
    const isolatedEnvironment = managedClientChildEnvironment({ host, environment });
    await writeManagedControlIdentity(controlDir, { host, clientId: routedClientId });
    if (host === "codex") {
      await resetCodexRootSession(controlDir, { sessionId: codexRootSessionId, clientId: routedClientId });
    }
    telemetry = host === "codex"
      ? await acquireManagedTelemetry({ environment, home, cwd, supervisorId: `${host}-${process.pid}-${randomUUID()}` })
      : null;
    if (host === "codex" && !oneShotCodexExec) {
      // Claude receives a compact copy of this shared supervisor. Keep the
      // optional Codex-only transport out of its module-load graph.
      const { codexAppServerTransportEnabled } = await import("./codex-app-server-transport.mjs");
      if (codexAppServerTransportEnabled({
        environment,
        config,
      })) {
        const {
          clearResidentThreadAttachment,
          ensureCodexAppServerResident,
          readResidentThreadAttachment,
          residentControlDir,
          takeResidentProviderHandoff,
        } = await import("./codex-app-server-resident.mjs");
        if (identity.sessionId) {
          await bindManagedClientIdentity({ host, sessionId: identity.sessionId, clientId: routedClientId, home, cwd });
        }
        const residentRoutes = residentControlDir(home, routedClientId);
        let residentArgsBase = args;
        let residentProfile = codexProfileFromArgs(args);
        let resumeRoute = null;
        let claimedProviderHandoff = null;
        let providerAttachFailures = 0;
        try {
          while (true) {
          await preflightCodexHistory(residentArgsBase);
          const resident = await ensureCodexAppServerResident({
            command: launchCommand,
            commandArgs: launchPrefixArgs,
            cwd,
            environment: isolatedEnvironment,
            home,
            clientId: routedClientId,
            threadListCwd: codexAllSessionsRequested(args) ? null : cwd,
            profile: residentProfile,
            resumeRoute,
          });
          await resetCodexRootSession(residentRoutes, { sessionId: codexRootSessionId, clientId: routedClientId });
          const launchNonce = claimedProviderHandoff ? randomUUID() : null;
          if (claimedProviderHandoff) await clearResidentThreadAttachment(home, routedClientId, launchNonce);
          const remoteConnection = buildCodexRemoteConnection({ proxyUrl: resident.proxyUrl, launchNonce });
          const residentArgs = [...residentArgsBase, ...remoteConnection.args];
          const tuiEnvironment = {
            ...isolatedEnvironment,
            ...remoteConnection.environment,
            STATEWRIGHT_ROUTE_CONTROL_DIR: residentRoutes,
            STATEWRIGHT_MANAGED_CLIENT_HOST: host,
            STATEWRIGHT_CLIENT_ID: routedClientId,
            ...(codexRootSessionId ? { STATEWRIGHT_MANAGED_CODEX_ROOT_SESSION_ID: codexRootSessionId } : {}),
            STATEWRIGHT_MANAGED_TELEMETRY_OWNER: telemetry ? "supervisor" : "none",
          };
          const tui = spawn(launchCommand, [...launchPrefixArgs, ...residentArgs], {
            cwd,
            env: tuiEnvironment,
            stdio: "inherit",
            // A provider handoff must retire the reconnecting TUI and every
            // native descendant before the replacement provider is started.
            detached: process.platform !== "win32",
          });
          const tuiStarted = waitForSpawn(tui);
          const tuiExit = waitForExit(tui);
          const stopForwarding = forwardManagedTermination(tui, tuiExit, { command: launchCommand, environment: tuiEnvironment });
          let result = null;
          let handoff = null;
          let retryProviderTarget = false;
          let releaseProviderTarget = false;
          try {
            await tuiStarted;
            if (claimedProviderHandoff) {
              const expectedHandoff = claimedProviderHandoff.handoff ?? claimedProviderHandoff;
              const attached = await waitForCodexThreadAttachment({
                readAttachment: () => readResidentThreadAttachment(home, routedClientId, resident.pid, launchNonce),
                tuiExit,
              });
              const attachmentMatches = codexThreadAttachmentMatches(attached.attachment, expectedHandoff, launchNonce);
              if (!attachmentMatches) {
                result = attached.result;
                if (!result) {
                  await restartManagedChild(tui, tuiExit, { command: launchCommand, environment: tuiEnvironment });
                  result = await tuiExit;
                }
                if (!attached.attachment && !attached.timedOut && isExpectedExit(result)) {
                  releaseProviderTarget = true;
                } else {
                  providerAttachFailures += 1;
                  await retireCodexResident(resident.pid, 3_000, { appServerPid: resident.appServerPid });
                  if (providerAttachFailures >= 3) {
                    await claimedProviderHandoff.release?.();
                    claimedProviderHandoff = null;
                    throw new Error(
                      `Statewright could not attach Codex to the requested provider after ${providerAttachFailures} attempts. `
                      + `The durable handoff remains queued for managed client '${routedClientId}'; fix the provider configuration before retrying.`,
                    );
                  }
                  retryProviderTarget = true;
                }
              } else {
                try {
                  await claimedProviderHandoff.ack?.();
                  claimedProviderHandoff = null;
                  providerAttachFailures = 0;
                } catch (error) {
                  await restartManagedChild(tui, tuiExit, { command: launchCommand, environment: tuiEnvironment });
                  throw error;
                }
              }
              await clearResidentThreadAttachment(home, routedClientId, launchNonce);
            }
            if (!retryProviderTarget && !releaseProviderTarget) {
              const outcome = await waitForCodexProviderHandoff({
                takeHandoff: () => takeResidentProviderHandoff(home, routedClientId),
                tuiExit,
              });
              claimedProviderHandoff = outcome.reservation;
              handoff = outcome.handoff;
              result = outcome.result;
              if (handoff && !result) {
                await restartManagedChild(tui, tuiExit, { command: launchCommand, environment: tuiEnvironment });
                result = await tuiExit;
              }
            }
          } catch (error) {
            if (claimedProviderHandoff) await retireCodexResident(resident.pid, 3_000, { appServerPid: resident.appServerPid });
            throw error;
          } finally {
            await stopForwarding();
          }
          if (releaseProviderTarget) {
            await retireCodexResident(resident.pid, 3_000, { appServerPid: resident.appServerPid });
            await claimedProviderHandoff?.release?.();
            claimedProviderHandoff = null;
            process.stderr.write("[statewright] preserved the pending Codex provider handoff after the target TUI exited before attachment.\n");
            return result?.code ?? 0;
          }
          if (retryProviderTarget) {
            process.stderr.write("[statewright] target Codex provider did not attach successfully; preserving the provider handoff and retrying.\n");
            await delay(250 * (2 ** (providerAttachFailures - 1)));
            continue;
          }
          if (!handoff) {
            claimedProviderHandoff = await takeResidentProviderHandoff(home, routedClientId);
            handoff = claimedProviderHandoff?.handoff ?? claimedProviderHandoff;
          }
          if (!handoff) {
            if (!isExpectedExit(result)) await reporter.report(new Error("Native Codex connected to its resident App Server exited unexpectedly."), {
              mechanism: "child_exit", host, operation: "resident_tui", exit_code: result.code ?? 1, signal: result.signal,
            });
            return result.code ?? 1;
          }
          if (!handoff.threadId || !handoff.model || !handoff.provider) {
            throw new Error("Statewright rejected an incomplete Codex provider handoff.");
          }
          codexRootSessionId = handoff.resume === false ? null : handoff.threadId;
          if (codexRootSessionId) {
            await bindManagedClientIdentity({ host, sessionId: codexRootSessionId, clientId: routedClientId, home, cwd });
          } else {
            await resetCodexRootSession(residentRoutes, { clientId: routedClientId });
          }
          for (let attempt = 0; attempt < 100 && processAlive(resident.pid); attempt += 1) await delay(25);
          if (processAlive(resident.pid)) {
            await retireCodexResident(resident.pid, 3_000, { appServerPid: resident.appServerPid });
          }
          residentArgsBase = buildCodexAppServerHandoffArgs({ originalArgs: args, handoff });
          residentProfile = handoff.profile ?? null;
          resumeRoute = handoff;
          }
        } finally {
          await claimedProviderHandoff?.release?.();
        }
      }
    }
    bridge = await createManagedMcpBridge({ environment, clientId: routedClientId, bridgeFactory });
    while (true) {
      await preflightCodexHistory(nextArgs);
      const childEnvironment = {
        ...isolatedEnvironment,
        STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir,
        STATEWRIGHT_MANAGED_CLIENT_HOST: host,
        STATEWRIGHT_MANAGED_TELEMETRY_OWNER: telemetry ? "supervisor" : "none",
      };
      if (routedClientId) childEnvironment.STATEWRIGHT_CLIENT_ID = routedClientId;
      if (host === "claude" && claudeRootSessionId) {
        childEnvironment.STATEWRIGHT_MANAGED_CLAUDE_ROOT_SESSION_ID = claudeRootSessionId;
      }
      if (host === "codex" && codexRootSessionId) {
        childEnvironment.STATEWRIGHT_MANAGED_CODEX_ROOT_SESSION_ID = codexRootSessionId;
      }
      if (bridge) {
        childEnvironment.STATEWRIGHT_MANAGED_MCP_URL = bridge.url;
        childEnvironment.STATEWRIGHT_MANAGED_MCP_TOKEN = bridge.token;
      }
      const launchViaWindowsShell = isWindowsCommand(launchCommand);
      const child = spawn(launchCommand, [...launchPrefixArgs, ...nextArgs], {
        cwd,
        env: childEnvironment,
        stdio: "inherit",
        // POSIX process-group ownership lets cancellation terminate every
        // descendant the CLI starts. Scoped forwarding above prevents that
        // detached group from outliving its managed supervisor.
        detached: process.platform !== "win32",
        // Non-npm .cmd/.bat launchers still need cmd.exe. npm-generated shims
        // are resolved to their Node entrypoint above, preserving argv exactly.
        shell: launchViaWindowsShell,
      });
      let exited = false;
      let restart = false;
      child.once("exit", () => { exited = true; });
      const exit = waitForExit(child);
      const stopForwarding = forwardManagedTermination(child, exit, { command: launchCommand, environment: childEnvironment });
      try {
        if (oneShotCodexExec) {
          const result = await exit;
          if (!isExpectedExit(result)) await reporter.report(new Error("Managed codex exec exited unexpectedly."), {
            mechanism: "child_exit", host, operation: "managed_exec", exit_code: result.code ?? 1, signal: result.signal,
          });
          return result.code ?? 1;
        }
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
            if (host === "codex") {
              const registration = await readCodexRootSession(controlDir, routedClientId);
              if (!codexRouteOwnsRoot(request, registration)) {
                process.stderr.write("[statewright] deferred Codex model route from a nested process; the parent thread remains authoritative.\n");
                continue;
              }
              codexRootSessionId = registration.sessionId;
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
            let selectedRequest = request;
            if (host === "codex") {
              try {
                selectedRequest = await selectAvailableRoute(request);
              } catch (error) {
                // Availability failure is fail-closed: stop the detached child
                // before the supervisor relinquishes its control directory.
                await restartManagedChild(child, exit, { command: launchCommand, environment: childEnvironment });
                throw error;
              }
              if (selectedRequest.session_id !== request.session_id
                  || selectedRequest.client_id !== request.client_id
                  || selectedRequest.root_session_id !== request.root_session_id) {
                await restartManagedChild(child, exit, { command: launchCommand, environment: childEnvironment });
                throw new Error("Statewright model_ladder attempted to alter managed session identity.");
              }
            }
            nextArgs = buildRoutedArgs({ host, originalArgs: args, request: selectedRequest });
            restart = true;
            await restartManagedChild(child, exit, { command: launchCommand, environment: childEnvironment });
            break;
          }
          await delay(pollMs);
        }
        const result = await exit;
        if (!restart) {
          if (!isExpectedExit(result)) await reporter.report(new Error(`Managed ${host} client exited unexpectedly.`), {
            mechanism: "child_exit", host, operation: "managed_client", exit_code: result.code ?? 1, signal: result.signal,
          });
          return result.code ?? 1;
        }
      } finally {
        await stopForwarding();
      }
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
    ? `@echo off\r\nif /I \"%~1\"==\"--kill-app-server\" (\r\n  \"${process.execPath}\" \"${launcherPath}\" %*\r\n  exit /b %ERRORLEVEL%\r\n)\r\n\"${process.execPath}\" \"${launcherPath}\" --host \"${host}\" --real-bin \"${binary}\" -- %*\r\n`
    : `#!/usr/bin/env sh\nif [ \"${host}\" = \"codex\" ] && [ \"\${1:-}\" = \"--kill-app-server\" ]; then\n  exec node ${JSON.stringify(launcherPath)} \"$@\"\nfi\nexec node ${JSON.stringify(launcherPath)} --host ${JSON.stringify(host)} --real-bin ${JSON.stringify(binary)} -- \"$@\"\n`;
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
