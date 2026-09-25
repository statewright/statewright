#!/usr/bin/env node

import { execFile as execFileCallback, spawn as spawnCallback } from "node:child_process";
import { access, chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_VENDOR_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";
const DEFAULT_DESKTOP_EXECUTABLE = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const DESKTOP_APP_NAME = "ChatGPT + Statewright.app";
const DESKTOP_APP_EXECUTABLE = "ChatGPT + Statewright";
const LEGACY_DESKTOP_APP_NAME = "Statewright ChatGPT.app";
const LEGACY_DESKTOP_APP_EXECUTABLE = "Statewright ChatGPT";
const DEFAULT_LAUNCHCTL = "/bin/launchctl";
const DESKTOP_ENVIRONMENT_KEY = "CODEX_CLI_PATH";
const DESKTOP_LOCK_TIMEOUT_MS = 5_000;
const execFile = promisify(execFileCallback);

export function defaultDesktopStatePath(home = homedir()) { return join(home, ".statewright", "codex-desktop.json"); }
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
  for (const entry of await readdir(queuePath, { withFileTypes: true })) {
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
  const child = spawn(state.desktop_executable, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CODEX_CLI_PATH: state.shim_path },
  });
  await waitForStartup(child);
  child.unref();
} catch (error) {
  process.stderr.write(\`ChatGPT + Statewright could not start: \${error.message}\\n\`);
  process.exitCode = 1;
}
`;
}
function desktopAppContents(launcherPath, nodeExecutable) {
  return `#!/bin/sh\nif ! ${shellQuote(nodeExecutable)} ${shellQuote(launcherPath)}; then\n  /usr/bin/osascript -e 'display alert "ChatGPT + Statewright could not start" message "Quit ChatGPT completely, then open ChatGPT + Statewright again."' >/dev/null 2>&1 || true\n  exit 1\nfi\n`;
}
async function installDesktopApp({ statePath, applicationsDirectory, nodeExecutable, writeAtomicFn }) {
  const launcherPath = join(dirname(statePath), "bin", "statewright-desktop-launch.mjs");
  const appPath = join(applicationsDirectory, DESKTOP_APP_NAME);
  await writeAtomicFn(launcherPath, desktopLauncherContents(statePath), 0o700);
  await writeAtomicFn(join(appPath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleDisplayName</key><string>ChatGPT + Statewright</string><key>CFBundleExecutable</key><string>${DESKTOP_APP_EXECUTABLE}</string><key>CFBundleIdentifier</key><string>ai.statewright.chatgpt</string><key>CFBundleName</key><string>ChatGPT + Statewright</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`, 0o600);
  await writeAtomicFn(join(appPath, "Contents", "MacOS", DESKTOP_APP_EXECUTABLE), desktopAppContents(launcherPath, nodeExecutable), 0o700);
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
async function removeVerifiedDesktopApp(appPath) {
  if (!appPath) return false;
  const infoPath = join(appPath, "Contents", "Info.plist");
  const executablePath = join(appPath, "Contents", "MacOS", DESKTOP_APP_EXECUTABLE);
  let info;
  try { info = await readFile(infoPath, "utf8"); } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (!info.includes("<string>ai.statewright.chatgpt</string>") || !await executable(executablePath)) return false;
  await rm(appPath, { recursive: true, force: true });
  return true;
}
async function removeVerifiedDesktopLauncher(statePath) {
  const launcherPath = join(dirname(statePath), "bin", "statewright-desktop-launch.mjs");
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
    if (!["state", "original", "wrapper", "app"].includes(key)) throw new Error(`Unknown option: ${value}`);
    options[key] = rest[++index];
    if (!options[key]) throw new Error(`${value} requires a value.`);
  }
  return options;
}

async function enableDesktopUnlocked({ statePath, original, wrapper = resolve(SCRIPT_ROOT, "statewright-desktop-codex.mjs"), app = DEFAULT_DESKTOP_EXECUTABLE, applicationsDirectory, node = process.execPath, launchctlPath, launchctlExecFile = execFile, writeAtomicFn = writeAtomic } = {}) {
  const resolvedState = resolve(statePath);
  const existing = await readOptionalJson(resolvedState);
  const vendor = resolve(original ?? DEFAULT_VENDOR_CODEX);
  const runtime = resolve(wrapper);
  const nodeExecutable = resolve(node);
  const desktopExecutable = resolve(app);
  const desktopApplicationsDirectory = resolve(applicationsDirectory ?? defaultDesktopApplicationsDirectory(homedir()));
  const launcherAppPath = join(desktopApplicationsDirectory, DESKTOP_APP_NAME);
  const shim = join(dirname(resolvedState), "bin", "statewright-desktop-codex");
  if (!await executable(vendor)) throw new Error(`Desktop vendor executable is not executable: ${vendor}`);
  if (!await executable(desktopExecutable)) throw new Error(`ChatGPT Desktop executable is not executable: ${desktopExecutable}`);
  if (!await executable(nodeExecutable)) throw new Error(`Node executable is not executable: ${nodeExecutable}`);
  if (!await readable(runtime)) throw new Error(`Desktop broker module is not readable: ${runtime}`);
  if (existing && existing.version !== 2 && (existing.version !== 3 || existing.shim_path !== shim || existing.original_codex !== vendor || existing.desktop_executable !== desktopExecutable)) throw new Error("A different Statewright Desktop setup is already recorded; disable it before replacing its control boundary.");
  const legacyPath = await legacyLaunchdPath(existing, { launchctlExecFile, launchctlPath });
  const state = existing?.version === 3 ? { ...existing, wrapper: runtime, node_executable: nodeExecutable, launcher_app_path: launcherAppPath } : { version: 3, environment_key: DESKTOP_ENVIRONMENT_KEY, original_codex: vendor, desktop_executable: desktopExecutable, wrapper: runtime, shim_path: shim, node_executable: nodeExecutable, launcher_app_path: launcherAppPath, client_id: existing?.client_id ?? `swc_${randomBytes(16).toString("hex")}` };
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
  const desktopApp = await installDesktopApp({ statePath: resolvedState, applicationsDirectory: desktopApplicationsDirectory, nodeExecutable, writeAtomicFn });
  await removeVerifiedLegacyDesktopApp(desktopApplicationsDirectory);
  return { ...state, launcher_app_path: desktopApp.appPath, launcher_path: desktopApp.launcherPath };
}

export async function enableDesktop(options = {}) {
  const resolvedState = resolve(options.statePath ?? defaultDesktopStatePath(homedir()));
  return withDesktopLock(resolvedState, async () => {
    await rm(desktopDisabledPath(resolvedState), { force: true });
    return enableDesktopUnlocked({ ...options, statePath: resolvedState });
  });
}

export async function provisionDesktop(options = {}) {
  const resolvedState = resolve(options.statePath ?? defaultDesktopStatePath(homedir()));
  if (await readable(desktopDisabledPath(resolvedState))) return { skipped: "disabled", state_path: resolvedState };
  return withDesktopLock(resolvedState, async () => {
    if (await readable(desktopDisabledPath(resolvedState))) return { skipped: "disabled", state_path: resolvedState };
    return enableDesktopUnlocked({ ...options, statePath: resolvedState });
  });
}

export async function launchDesktop({ statePath, spawn = spawnCallback, environment = process.env } = {}) {
  const resolvedState = resolve(statePath ?? defaultDesktopStatePath(homedir()));
  const state = await readDesktopState(resolvedState);
  if (!state.desktop_executable || !await executable(state.desktop_executable)) throw new Error("ChatGPT Desktop executable is unavailable; rerun enable with --app after installing ChatGPT.app.");
  if (!await executable(state.shim_path)) throw new Error("Statewright Desktop shim is unavailable; rerun enable first.");
  const child = spawn(state.desktop_executable, [], { detached: true, stdio: "ignore", env: { ...environment, [DESKTOP_ENVIRONMENT_KEY]: state.shim_path } });
  await waitForDesktopStartup(child);
  child.unref?.();
  return { started: true, desktop_executable: state.desktop_executable, shim_path: state.shim_path, client_id: state.client_id, pid: child.pid ?? null, note: "Process startup is confirmed only; verify direct MCP tools and route receipt in a fresh Desktop code chat." };
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

export async function disableDesktop({ statePath, launchctlExecFile = execFile, launchctlPath } = {}) {
  const resolvedState = resolve(statePath ?? defaultDesktopStatePath(homedir()));
  return withDesktopLock(resolvedState, async () => {
    await writeAtomic(desktopDisabledPath(resolvedState), "disabled\n", 0o600);
    const state = await readOptionalJson(resolvedState);
    if (!state) return { disabled: true, state_path: resolvedState, app_removed: false, launcher_removed: false };
    await removeLegacyLaunchdOverride(state, { launchctlExecFile, launchctlPath });
    const appRemoved = await removeVerifiedDesktopApp(state.launcher_app_path);
    const launcherRemoved = await removeVerifiedDesktopLauncher(resolvedState);
    await rm(state.shim_path, { force: true });
    await rm(resolvedState, { force: true });
    return { ...state, disabled: true, app_removed: appRemoved, launcher_removed: launcherRemoved };
  });
}

export async function desktopDoctor({ statePath } = {}) {
  const resolvedState = resolve(statePath ?? defaultDesktopStatePath(homedir()));
  if (await readable(desktopDisabledPath(resolvedState))) return { ok: false, reason: "disabled", state_path: resolvedState };
  const state = await readOptionalJson(resolvedState);
  if (!state) return { ok: false, reason: "not_configured", state_path: resolvedState };
  if (state.version !== 3) return { ok: false, reason: "legacy_setup_requires_enable", state_path: resolvedState };
  const launcherPath = state.launcher_app_path && join(state.launcher_app_path, "Contents", "MacOS", DESKTOP_APP_EXECUTABLE);
  return { ok: await executable(state.original_codex) && await executable(state.desktop_executable) && await executable(state.node_executable) && await executable(state.shim_path) && await readable(state.wrapper) && Boolean(launcherPath) && await executable(launcherPath), state_path: resolvedState, shim_path: state.shim_path, original_codex: state.original_codex, desktop_executable: state.desktop_executable, node_executable: state.node_executable, launcher_app_path: state.launcher_app_path ?? null, client_id: state.client_id, launch_mode: "explicit_process_environment" };
}

export async function readDesktopState(path = defaultDesktopStatePath()) {
  const state = await readOptionalJson(path);
  if (!state?.original_codex || !state?.client_id) throw new Error("Statewright Desktop routing is not configured. Run statewright-desktop-setup.mjs enable first.");
  return state;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseDesktopArgs(process.argv.slice(2));
  let result;
  if (options.command === "enable") result = await enableDesktop({ statePath: options.state, original: options.original, wrapper: options.wrapper, app: options.app });
  else if (options.command === "provision") result = await provisionDesktop({ statePath: options.state, original: options.original, wrapper: options.wrapper, app: options.app });
  else if (options.command === "launch") result = await launchDesktop({ statePath: options.state });
  else if (options.command === "disable") result = await disableDesktop({ statePath: options.state });
  else if (options.command === "doctor") result = await desktopDoctor({ statePath: options.state });
  else throw new Error(`Unknown Desktop command: ${options.command}`);
  console.log(JSON.stringify(result));
  if (options.command === "doctor" && !result.ok) process.exitCode = 1;
}
