#!/usr/bin/env node

import { execFile as execFileCallback, spawn as spawnCallback } from "node:child_process";
import { access, chmod, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_VENDOR_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";
const DEFAULT_DESKTOP_EXECUTABLE = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const LEGACY_DESKTOP_APP_NAME = "Statewright ChatGPT.app";
const LEGACY_DESKTOP_APP_EXECUTABLE = "Statewright ChatGPT";
const DEFAULT_LAUNCHCTL = "/bin/launchctl";
const DESKTOP_ENVIRONMENT_KEY = "CODEX_CLI_PATH";
const DESKTOP_LOCK_TIMEOUT_MS = 5_000;
const DESKTOP_PROFILES = Object.freeze({
  production: Object.freeze({
    name: "production",
    appName: "ChatGPT + Statewright.app",
    displayName: "ChatGPT + Statewright",
    executableName: "ChatGPT + Statewright",
    bundleId: "ai.statewright.chatgpt",
    stateFile: "codex-desktop.json",
    shimName: "statewright-desktop-codex",
    launcherName: "statewright-desktop-launch.mjs",
    gatewayUrl: "https://mcp.statewright.ai",
    apiKeyFile: "api_key",
  }),
  staging: Object.freeze({
    name: "staging",
    appName: "ChatGPT + Statewright Staging.app",
    displayName: "ChatGPT + Statewright Staging",
    executableName: "ChatGPT + Statewright Staging",
    bundleId: "ai.statewright.chatgpt.staging",
    stateFile: "codex-desktop-staging.json",
    shimName: "statewright-desktop-codex-staging",
    launcherName: "statewright-desktop-staging-launch.mjs",
    gatewayUrl: null,
    apiKeyFile: "staging_api_key",
  }),
});
const execFile = promisify(execFileCallback);

function desktopProfile(name = "production") {
  const profile = DESKTOP_PROFILES[name];
  if (!profile) throw new Error(`Unknown Desktop profile: ${name}. Expected production or staging.`);
  return profile;
}
export function defaultDesktopStatePath(home = homedir(), profile = "production") { return join(home, ".statewright", desktopProfile(profile).stateFile); }
export function defaultDesktopApplicationsDirectory(home = homedir()) { return join(home, "Applications"); }
function desktopDisabledPath(statePath) { return `${statePath}.disabled`; }
function desktopLockPath(statePath) { return `${statePath}.lock`; }
function desktopLockQueuePath(lockPath) { return join(lockPath, "queue"); }
function desktopLockOwnerPath(ticketPath) { return join(ticketPath, "owner.json"); }
async function readOptionalJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error?.code === "ENOENT") return null; throw new Error(`Cannot read Desktop routing state at ${path}: ${error.message}`); } }
async function writeAtomic(path, contents, mode) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, contents, { mode }); await chmod(temporary, mode); await rename(temporary, path); }
async function executable(path) { try { await access(path, constants.X_OK); return true; } catch { return false; } }
async function readable(path) { try { await access(path, constants.R_OK); return true; } catch { return false; } }
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
async function staleDesktopTicket(ticketPath) {
  let pid;
  try {
    const owner = JSON.parse(await readFile(desktopLockOwnerPath(ticketPath), "utf8"));
    pid = owner?.pid;
  } catch {}
  if (!Number.isInteger(pid) || pid <= 0) pid = Number.parseInt(basename(ticketPath).split("-", 1)[0], 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error?.code === "ESRCH"; }
}
async function writeDesktopTicketOwner(ticketPath, owner) {
  const ownerPath = desktopLockOwnerPath(ticketPath);
  const temporary = `${ownerPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, ownerPath);
}
async function readDesktopTicketOwner(ticketPath) {
  try { return JSON.parse(await readFile(desktopLockOwnerPath(ticketPath), "utf8")); }
  catch { return null; }
}
async function activeDesktopTickets(queuePath) {
  const tickets = [];
  let entries;
  try { entries = await readdir(queuePath, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return tickets;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const ticketPath = join(queuePath, entry.name);
    if (await staleDesktopTicket(ticketPath)) { await rm(ticketPath, { recursive: true, force: true }); continue; }
    tickets.push({ name: entry.name, owner: await readDesktopTicketOwner(ticketPath) });
  }
  return tickets;
}
function ticketPrecedes(left, right) { return left.owner.number < right.owner.number || (left.owner.number === right.owner.number && left.name < right.name); }
export async function withDesktopLock(statePath, action, { ticketName = `${process.pid}-${randomBytes(8).toString("hex")}`, beforeOwnerPublish } = {}) {
  const lockPath = desktopLockPath(statePath);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const queuePath = desktopLockQueuePath(lockPath);
  await mkdir(queuePath, { recursive: true, mode: 0o700 });
  const ticketPath = join(queuePath, ticketName);
  await mkdir(ticketPath, { mode: 0o700 });
  try {
    await beforeOwnerPublish?.();
    await writeDesktopTicketOwner(ticketPath, { pid: process.pid, ticket: ticketName, created_at: new Date().toISOString(), choosing: true, number: 0 });
  }
  catch (error) { await rm(ticketPath, { recursive: true, force: true }); throw error; }
  const deadline = Date.now() + DESKTOP_LOCK_TIMEOUT_MS;
  try {
    const initialTickets = await activeDesktopTickets(queuePath);
    const number = 1 + Math.max(0, ...initialTickets.map(ticket => Number.isInteger(ticket.owner?.number) ? ticket.owner.number : 0));
    const owner = { pid: process.pid, ticket: ticketName, created_at: new Date().toISOString(), choosing: false, number };
    await writeDesktopTicketOwner(ticketPath, owner);
    while (true) {
      const tickets = await activeDesktopTickets(queuePath);
      const self = { name: ticketName, owner };
      const selfTicket = tickets.find(ticket => ticket.name === ticketName);
      if (selfTicket?.owner?.pid !== process.pid || selfTicket.owner?.ticket !== ticketName || selfTicket.owner?.number !== number || selfTicket.owner?.choosing) throw new Error("Statewright Desktop setup lost lock ownership; retry setup.");
      const blocked = tickets.some(ticket => ticket.name !== ticketName && (!ticket.owner || ticket.owner.choosing || !Number.isInteger(ticket.owner.number) || ticketPrecedes(ticket, self)));
      if (!blocked) return await action();
      if (Date.now() >= deadline) throw new Error("Statewright Desktop setup is busy; retry after the other setup finishes.");
      await delay(25);
    }
  } finally { await rm(ticketPath, { recursive: true, force: true }); }
}
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function desktopLauncherContents(statePath) {
  return `#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const statePath = ${JSON.stringify(statePath)};
const waitForStartup = child => new Promise((resolve, reject) => {
  let settled = false;
  let spawned = false;
  let graceTimer;
  const startTimer = setTimeout(() => settle(reject, new Error("ChatGPT did not start.")), 1_000);
  const settle = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(startTimer);
    clearTimeout(graceTimer);
    callback(value);
  };
  child.once("error", error => settle(reject, error));
  child.once("exit", (code, signal) => settle(reject, new Error(\`ChatGPT exited \${spawned ? "during startup" : "before startup"} (code \${code ?? "none"}, signal \${signal ?? "none"}).\`)));
  child.once("spawn", () => {
    spawned = true;
    graceTimer = setTimeout(() => settle(resolve), 250);
  });
});

try {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  await access(state.desktop_executable, constants.X_OK);
  await access(state.shim_path, constants.X_OK);
  const apiKey = (await readFile(state.api_key_path, "utf8")).trim();
  if (!apiKey) throw new Error(\`Statewright API key is empty: \${state.api_key_path}\`);
  const runtimeUrl = pathToFileURL(join(dirname(state.wrapper), "lib", "desktop-runtime", "codex-desktop-app-server-launcher.mjs"));
  const { startDesktopMcpBridge } = await import(runtimeUrl);
  const bridgeEnvironment = { ...process.env, STATEWRIGHT_GATEWAY_URL: state.gateway_url, STATEWRIGHT_API_KEY: apiKey };
  const bridge = await startDesktopMcpBridge({ environment: bridgeEnvironment, clientId: state.client_id });
  const child = spawn(state.desktop_executable, [], {
    detached: false,
    stdio: "ignore",
    env: {
      ...process.env,
      CODEX_CLI_PATH: state.shim_path,
      STATEWRIGHT_DESKTOP_MCP_URL: bridge.url,
      STATEWRIGHT_DESKTOP_MCP_TOKEN: bridge.token,
    },
  });
  const childOutcome = new Promise(resolve => {
    child.once("error", error => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    await waitForStartup(child);
    const outcome = await childOutcome;
    if (outcome.error) throw outcome.error;
    if (outcome.code && outcome.code !== 0) throw new Error(\`ChatGPT exited with code \${outcome.code} (signal \${outcome.signal ?? "none"}).\`);
  } finally {
    await bridge.close();
  }
} catch (error) {
  process.stderr.write(\`ChatGPT + Statewright could not start: \${error.message}\\n\`);
  process.exitCode = 1;
}
`;
}
function desktopAppContents(launcherPath, nodeExecutable, displayName) {
  return `#!/bin/sh\nif ! ${shellQuote(nodeExecutable)} ${shellQuote(launcherPath)}; then\n  /usr/bin/osascript -e 'display alert "${displayName} could not start" message "Quit ChatGPT completely, then open ${displayName} again."' >/dev/null 2>&1 || true\n  exit 1\nfi\n`;
}
async function installDesktopApp({ statePath, applicationsDirectory, nodeExecutable, profile, writeAtomicFn }) {
  const launcherPath = join(dirname(statePath), "bin", profile.launcherName);
  const appPath = join(applicationsDirectory, profile.appName);
  await writeAtomicFn(launcherPath, desktopLauncherContents(statePath), 0o700);
  await writeAtomicFn(join(appPath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleDisplayName</key><string>${profile.displayName}</string><key>CFBundleExecutable</key><string>${profile.executableName}</string><key>CFBundleIdentifier</key><string>${profile.bundleId}</string><key>CFBundleName</key><string>${profile.displayName}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`, 0o600);
  await writeAtomicFn(join(appPath, "Contents", "MacOS", profile.executableName), desktopAppContents(launcherPath, nodeExecutable, profile.displayName), 0o700);
  return { appPath, launcherPath };
}
async function removeVerifiedLegacyDesktopApp(applicationsDirectory) {
  const appPath = join(applicationsDirectory, LEGACY_DESKTOP_APP_NAME);
  const infoPath = join(appPath, "Contents", "Info.plist");
  const executablePath = join(appPath, "Contents", "MacOS", LEGACY_DESKTOP_APP_EXECUTABLE);
  let info;
  try { info = await readFile(infoPath, "utf8"); } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (!info.includes("<string>ai.statewright.chatgpt</string>") || !await executable(executablePath)) return false;
  await rm(appPath, { recursive: true, force: true });
  return true;
}
async function removeVerifiedDesktopApp(appPath, profile) {
  if (!appPath) return false;
  const infoPath = join(appPath, "Contents", "Info.plist");
  const executablePath = join(appPath, "Contents", "MacOS", profile.executableName);
  let info;
  try { info = await readFile(infoPath, "utf8"); } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (!info.includes(`<string>${profile.bundleId}</string>`) || !await executable(executablePath)) return false;
  await rm(appPath, { recursive: true, force: true });
  return true;
}
async function removeVerifiedDesktopLauncher(statePath, profile, recordedPath) {
  const launcherPath = recordedPath ?? join(dirname(statePath), "bin", profile.launcherName);
  let contents;
  try { contents = await readFile(launcherPath, "utf8"); } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (!contents.includes(`const statePath = ${JSON.stringify(statePath)};`)) return false;
  await rm(launcherPath, { force: true });
  return true;
}
function launchdValue(stdout) { const value = String(stdout ?? "").replace(/\r?\n$/, ""); return value.length === 0 ? null : value; }
async function readLaunchdEnvironment(exec, path) { const { stdout } = await exec(path, ["getenv", DESKTOP_ENVIRONMENT_KEY]); return launchdValue(stdout); }
async function setLaunchdEnvironment(exec, path, value) { if (value == null) await exec(path, ["unsetenv", DESKTOP_ENVIRONMENT_KEY]); else await exec(path, ["setenv", DESKTOP_ENVIRONMENT_KEY, value]); }

async function legacyLaunchdPath(state, { launchctlExecFile, launchctlPath }) {
  if (state?.version !== 2 || state.environment_key !== DESKTOP_ENVIRONMENT_KEY || !state.launchctl_path) return;
  const path = launchctlPath ?? state.launchctl_path;
  if (await readLaunchdEnvironment(launchctlExecFile, path) !== state.shim_path) throw new Error("launchd CODEX_CLI_PATH changed since legacy setup; refusing to overwrite the user's current setting.");
  return path;
}

async function removeLegacyLaunchdOverride(state, options) {
  const path = await legacyLaunchdPath(state, options);
  if (path) await setLaunchdEnvironment(options.launchctlExecFile, path, state.previous_launchd_value);
}

export function parseDesktopArgs(argv) {
  const [command = "doctor", ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    if (!["state", "original", "wrapper", "app", "profile"].includes(key)) throw new Error(`Unknown option: ${value}`);
    options[key] = rest[++index];
    if (!options[key]) throw new Error(`${value} requires a value.`);
  }
  if (options.profile) desktopProfile(options.profile);
  return options;
}

async function enableDesktopUnlocked({ statePath, profile: profileName = "production", original, wrapper = resolve(SCRIPT_ROOT, "statewright-desktop-codex.mjs"), app = DEFAULT_DESKTOP_EXECUTABLE, applicationsDirectory, node = process.execPath, launchctlPath, launchctlExecFile = execFile, writeAtomicFn = writeAtomic, stagingGatewayUrl = process.env.STATEWRIGHT_DESKTOP_STAGING_GATEWAY_URL } = {}) {
  const profile = desktopProfile(profileName);
  const resolvedState = resolve(statePath);
  const existing = await readOptionalJson(resolvedState);
  const vendor = resolve(original ?? DEFAULT_VENDOR_CODEX);
  const runtime = resolve(wrapper);
  const nodeExecutable = resolve(node);
  const desktopExecutable = resolve(app);
  const desktopApplicationsDirectory = resolve(applicationsDirectory ?? defaultDesktopApplicationsDirectory(homedir()));
  const launcherAppPath = join(desktopApplicationsDirectory, profile.appName);
  const shim = join(dirname(resolvedState), "bin", profile.shimName);
  const gatewayUrl = profile.name === "staging" ? stagingGatewayUrl : profile.gatewayUrl;
  if (!gatewayUrl) throw new Error("Staging Desktop gateway URL is required.");
  const apiKeyPath = join(dirname(resolvedState), profile.apiKeyFile);
  if (!await executable(vendor)) throw new Error(`Desktop vendor executable is not executable: ${vendor}`);
  if (!await executable(desktopExecutable)) throw new Error(`ChatGPT Desktop executable is not executable: ${desktopExecutable}`);
  if (!await executable(nodeExecutable)) throw new Error(`Node executable is not executable: ${nodeExecutable}`);
  if (!await readable(runtime)) throw new Error(`Desktop broker module is not readable: ${runtime}`);
  if (existing && existing.version !== 2 && (existing.version !== 3 || (existing.profile ?? "production") !== profile.name || existing.shim_path !== shim || existing.original_codex !== vendor || existing.desktop_executable !== desktopExecutable)) throw new Error("A different Statewright Desktop setup is already recorded; disable it before replacing its control boundary.");
  const legacyPath = await legacyLaunchdPath(existing, { launchctlExecFile, launchctlPath });
  const state = existing?.version === 3
    ? { ...existing, profile: profile.name, wrapper: runtime, node_executable: nodeExecutable, launcher_app_path: launcherAppPath, gateway_url: gatewayUrl, api_key_path: apiKeyPath }
    : { version: 3, profile: profile.name, environment_key: DESKTOP_ENVIRONMENT_KEY, original_codex: vendor, desktop_executable: desktopExecutable, wrapper: runtime, shim_path: shim, node_executable: nodeExecutable, launcher_app_path: launcherAppPath, gateway_url: gatewayUrl, api_key_path: apiKeyPath, client_id: existing?.client_id ?? `swc_${randomBytes(16).toString("hex")}` };
  await mkdir(dirname(shim), { recursive: true, mode: 0o700 });
  await writeAtomicFn(shim, `#!/bin/sh\nSTATEWRIGHT_DESKTOP_STATE_PATH=${shellQuote(resolvedState)} exec ${shellQuote(nodeExecutable)} ${shellQuote(runtime)} "$@"\n`, 0o700);
  if (legacyPath) {
    await setLaunchdEnvironment(launchctlExecFile, legacyPath, existing.previous_launchd_value);
    try {
      await writeAtomicFn(resolvedState, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    } catch (error) {
      try { await setLaunchdEnvironment(launchctlExecFile, legacyPath, existing.shim_path); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Desktop legacy migration failed and launchd rollback also failed."); }
      throw error;
    }
  } else await writeAtomicFn(resolvedState, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  const desktopApp = await installDesktopApp({ statePath: resolvedState, applicationsDirectory: desktopApplicationsDirectory, nodeExecutable, profile, writeAtomicFn });
  if (profile.name === "production") await removeVerifiedLegacyDesktopApp(desktopApplicationsDirectory);
  return { ...state, launcher_app_path: desktopApp.appPath, launcher_path: desktopApp.launcherPath };
}

export async function enableDesktop(options = {}) {
  const profile = options.profile ?? "production";
  const resolvedState = resolve(options.statePath ?? defaultDesktopStatePath(homedir(), profile));
  return withDesktopLock(resolvedState, async () => {
    await rm(desktopDisabledPath(resolvedState), { force: true });
    return enableDesktopUnlocked({ ...options, statePath: resolvedState });
  });
}

export async function provisionDesktop(options = {}) {
  const profile = options.profile ?? "production";
  const resolvedState = resolve(options.statePath ?? defaultDesktopStatePath(homedir(), profile));
  if (await readable(desktopDisabledPath(resolvedState))) return { skipped: "disabled", state_path: resolvedState };
  return withDesktopLock(resolvedState, async () => {
    if (await readable(desktopDisabledPath(resolvedState))) return { skipped: "disabled", state_path: resolvedState };
    return enableDesktopUnlocked({ ...options, statePath: resolvedState });
  });
}

export async function launchDesktop({ statePath, profile: profileName = "production", spawn = spawnCallback, environment = process.env } = {}) {
  const resolvedState = resolve(statePath ?? defaultDesktopStatePath(homedir(), profileName));
  const state = await readDesktopState(resolvedState);
  const profile = desktopProfile(state.profile ?? profileName);
  const launcherExecutable = state.launcher_app_path && join(state.launcher_app_path, "Contents", "MacOS", profile.executableName);
  if (!launcherExecutable || !await executable(launcherExecutable)) throw new Error(`${profile.displayName} is unavailable; rerun enable first.`);
  const child = spawn(launcherExecutable, [], { detached: true, stdio: "ignore", env: environment });
  await waitForDesktopStartup(child);
  child.unref?.();
  return { started: true, desktop_executable: launcherExecutable, shim_path: state.shim_path, client_id: state.client_id, pid: child.pid ?? null, note: "Process startup is confirmed only; verify direct MCP tools and route receipt in a fresh Desktop code chat." };
}

function waitForDesktopStartup(child, graceMs = 250) {
  if (!child?.once) throw new Error("ChatGPT Desktop launcher did not return an event-capable child process.");
  return new Promise((resolve, reject) => {
    let settled = false;
    let spawned = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      clearTimeout(graceTimer);
      callback(value);
    };
    const startTimer = setTimeout(() => settle(reject, new Error("ChatGPT Desktop did not emit a spawn event.")), graceMs);
    let graceTimer;
    child.once("error", error => settle(reject, new Error(`ChatGPT Desktop failed to start: ${error.message}`)));
    child.once("exit", (code, signal) => settle(reject, new Error(`ChatGPT Desktop exited ${spawned ? "during startup" : "before startup"} (code ${code ?? "none"}, signal ${signal ?? "none"}).`)));
    child.once("spawn", () => {
      spawned = true;
      clearTimeout(startTimer);
      graceTimer = setTimeout(() => settle(resolve), graceMs);
    });
  });
}

export async function disableDesktop({ statePath, profile: profileName = "production", launchctlExecFile = execFile, launchctlPath } = {}) {
  const resolvedState = resolve(statePath ?? defaultDesktopStatePath(homedir(), profileName));
  return withDesktopLock(resolvedState, async () => {
    await writeAtomic(desktopDisabledPath(resolvedState), "disabled\n", 0o600);
    const state = await readOptionalJson(resolvedState);
    if (!state) return { disabled: true, state_path: resolvedState, app_removed: false, launcher_removed: false };
    const profile = desktopProfile(state.profile ?? profileName);
    await removeLegacyLaunchdOverride(state, { launchctlExecFile, launchctlPath });
    const appRemoved = await removeVerifiedDesktopApp(state.launcher_app_path, profile);
    const launcherRemoved = await removeVerifiedDesktopLauncher(resolvedState, profile, state.launcher_path);
    await rm(state.shim_path, { force: true });
    await rm(resolvedState, { force: true });
    return { ...state, disabled: true, app_removed: appRemoved, launcher_removed: launcherRemoved };
  });
}

export async function desktopDoctor({ statePath, profile: profileName = "production" } = {}) {
  const resolvedState = resolve(statePath ?? defaultDesktopStatePath(homedir(), profileName));
  if (await readable(desktopDisabledPath(resolvedState))) return { ok: false, reason: "disabled", state_path: resolvedState };
  const state = await readOptionalJson(resolvedState);
  if (!state) return { ok: false, reason: "not_configured", state_path: resolvedState };
  if (state.version !== 3) return { ok: false, reason: "legacy_setup_requires_enable", state_path: resolvedState };
  const profile = desktopProfile(state.profile ?? profileName);
  const launcherPath = state.launcher_app_path && join(state.launcher_app_path, "Contents", "MacOS", profile.executableName);
  const credentialPresent = Boolean(state.api_key_path) && await readable(state.api_key_path);
  return { ok: await executable(state.original_codex) && await executable(state.desktop_executable) && await executable(state.node_executable) && await executable(state.shim_path) && await readable(state.wrapper) && Boolean(launcherPath) && await executable(launcherPath) && credentialPresent, profile: profile.name, state_path: resolvedState, shim_path: state.shim_path, original_codex: state.original_codex, desktop_executable: state.desktop_executable, node_executable: state.node_executable, launcher_app_path: state.launcher_app_path ?? null, gateway_url: state.gateway_url ?? null, api_key_path: state.api_key_path ?? null, credential_present: credentialPresent, client_id: state.client_id, launch_mode: "explicit_process_environment" };
}

export async function readDesktopState(path = defaultDesktopStatePath()) {
  const state = await readOptionalJson(path);
  if (!state?.original_codex || !state?.client_id) throw new Error("Statewright Desktop routing is not configured. Run statewright-desktop-setup.mjs enable first.");
  return state;
}

async function invokedAsEntryPoint(argument = process.argv[1]) {
  if (!argument) return false;
  try { return await realpath(argument) === await realpath(fileURLToPath(import.meta.url)); }
  catch { return resolve(argument) === fileURLToPath(import.meta.url); }
}

if (await invokedAsEntryPoint()) {
  const options = parseDesktopArgs(process.argv.slice(2));
  let result;
  if (options.command === "enable") result = await enableDesktop({ statePath: options.state, profile: options.profile, original: options.original, wrapper: options.wrapper, app: options.app });
  else if (options.command === "provision") result = await provisionDesktop({ statePath: options.state, profile: options.profile, original: options.original, wrapper: options.wrapper, app: options.app });
  else if (options.command === "launch") result = await launchDesktop({ statePath: options.state, profile: options.profile });
  else if (options.command === "disable") result = await disableDesktop({ statePath: options.state, profile: options.profile });
  else if (options.command === "doctor") result = await desktopDoctor({ statePath: options.state, profile: options.profile });
  else throw new Error(`Unknown Desktop command: ${options.command}`);
  console.log(JSON.stringify(result));
  if (options.command === "doctor" && !result.ok) process.exitCode = 1;
}
