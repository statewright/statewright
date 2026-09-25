#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_VENDOR_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";
const DEFAULT_LAUNCHCTL = "/bin/launchctl";
const DESKTOP_ENVIRONMENT_KEY = "CODEX_CLI_PATH";
const execFile = promisify(execFileCallback);

export function defaultDesktopStatePath(home = homedir()) {
  return join(home, ".statewright", "codex-desktop.json");
}

async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Cannot read Desktop routing state at ${path}: ${error.message}`);
  }
}

async function writeAtomic(path, contents, mode) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

async function executable(path) {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

async function readable(path) {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function launchdValue(stdout) {
  const value = String(stdout ?? "").replace(/\r?\n$/, "");
  return value.length === 0 ? null : value;
}

async function readLaunchdEnvironment(launchctlExecFile, launchctlPath) {
  const { stdout } = await launchctlExecFile(launchctlPath, ["getenv", DESKTOP_ENVIRONMENT_KEY]);
  return launchdValue(stdout);
}

async function setLaunchdEnvironment(launchctlExecFile, launchctlPath, value) {
  if (value == null) await launchctlExecFile(launchctlPath, ["unsetenv", DESKTOP_ENVIRONMENT_KEY]);
  else await launchctlExecFile(launchctlPath, ["setenv", DESKTOP_ENVIRONMENT_KEY, value]);
}

export function parseDesktopArgs(argv) {
  const [command = "doctor", ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    if (!["state", "original", "wrapper"].includes(key)) throw new Error(`Unknown option: ${value}`);
    options[key] = rest[++index];
    if (!options[key]) throw new Error(`${value} requires a value.`);
  }
  return options;
}

export async function enableDesktop({ statePath, original, wrapper = resolve(SCRIPT_ROOT, "statewright-desktop-codex.mjs"), node = process.execPath, launchctlPath = DEFAULT_LAUNCHCTL, launchctlExecFile = execFile } = {}) {
  const home = homedir();
  const resolvedState = resolve(statePath ?? defaultDesktopStatePath(home));
  const existing = await readOptionalJson(resolvedState);
  const previous = await readLaunchdEnvironment(launchctlExecFile, launchctlPath);
  const vendor = resolve(original ?? DEFAULT_VENDOR_CODEX);
  const runtime = resolve(wrapper);
  const shim = join(dirname(resolvedState), "bin", "statewright-desktop-codex");
  if (!await executable(vendor)) throw new Error(`Desktop vendor executable is not executable: ${vendor}`);
  if (!await executable(node)) throw new Error(`Node executable is not executable: ${node}`);
  if (!await readable(runtime)) throw new Error(`Desktop broker module is not readable: ${runtime}`);
  if (previous === shim && !existing) throw new Error("launchd already points CODEX_CLI_PATH at the Statewright Desktop shim, but no rollback record exists.");
  if (existing && (existing.environment_key !== DESKTOP_ENVIRONMENT_KEY || existing.launchctl_path !== launchctlPath || existing.shim_path !== shim)) {
    throw new Error("A different Statewright Desktop setup is already recorded; disable it before replacing its control boundary.");
  }
  if (existing && previous !== existing.shim_path) {
    throw new Error("launchd CODEX_CLI_PATH changed since setup; refusing to overwrite the user's current setting.");
  }
  const state = existing ? { ...existing, wrapper: runtime } : {
    version: 2,
    environment_key: DESKTOP_ENVIRONMENT_KEY,
    launchctl_path: launchctlPath,
    previous_launchd_value: previous,
    original_codex: vendor,
    wrapper: runtime,
    shim_path: shim,
    client_id: `swc_${randomBytes(16).toString("hex")}`,
  };
  await mkdir(dirname(shim), { recursive: true, mode: 0o700 });
  await writeAtomic(shim, `#!/bin/sh\nSTATEWRIGHT_DESKTOP_STATE_PATH=${shellQuote(resolvedState)} exec ${shellQuote(node)} ${shellQuote(runtime)} "$@"\n`, 0o700);
  await writeAtomic(resolvedState, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  if (!existing) {
    try {
      await setLaunchdEnvironment(launchctlExecFile, launchctlPath, shim);
    } catch (error) {
      await Promise.all([rm(shim, { force: true }), rm(resolvedState, { force: true })]);
      throw error;
    }
  }
  return state;
}

export async function disableDesktop({ statePath, launchctlExecFile = execFile } = {}) {
  const home = homedir();
  const resolvedState = resolve(statePath ?? defaultDesktopStatePath(home));
  const state = await readOptionalJson(resolvedState);
  if (!state) throw new Error("No Statewright Desktop setup is recorded.");
  if (state.environment_key !== DESKTOP_ENVIRONMENT_KEY || !state.launchctl_path) {
    throw new Error("Desktop setup record does not own a launchd CODEX_CLI_PATH override; use the installer version that created it to disable safely.");
  }
  const current = await readLaunchdEnvironment(launchctlExecFile, state.launchctl_path);
  if (current !== state.shim_path) {
    throw new Error("launchd CODEX_CLI_PATH changed since setup; refusing to overwrite the user's current setting.");
  }
  await setLaunchdEnvironment(launchctlExecFile, state.launchctl_path, state.previous_launchd_value);
  await rm(state.shim_path, { force: true });
  await rm(resolvedState, { force: true });
  return state;
}

export async function desktopDoctor({ statePath, launchctlExecFile = execFile } = {}) {
  const home = homedir();
  const resolvedState = resolve(statePath ?? defaultDesktopStatePath(home));
  const state = await readOptionalJson(resolvedState);
  if (!state) return { ok: false, reason: "not_configured", state_path: resolvedState };
  if (state.environment_key !== DESKTOP_ENVIRONMENT_KEY || !state.launchctl_path) return { ok: false, reason: "legacy_or_invalid_state", state_path: resolvedState };
  const launchdValue = await readLaunchdEnvironment(launchctlExecFile, state.launchctl_path);
  const result = {
    ok: launchdValue === state.shim_path
      && await executable(state.original_codex)
      && await executable(state.shim_path)
      && await readable(state.wrapper),
    state_path: resolvedState,
    shim_path: state.shim_path,
    original_codex: state.original_codex,
    client_id: state.client_id,
    launchd_value: launchdValue,
  };
  return result;
}

export async function readDesktopState(path = defaultDesktopStatePath()) {
  const state = await readOptionalJson(path);
  if (!state?.original_codex || !state?.client_id) throw new Error("Statewright Desktop routing is not configured. Run statewright-desktop-setup.mjs enable first.");
  return state;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseDesktopArgs(process.argv.slice(2));
  let result;
  if (options.command === "enable") result = await enableDesktop({ statePath: options.state, original: options.original, wrapper: options.wrapper });
  else if (options.command === "disable") result = await disableDesktop({ statePath: options.state });
  else if (options.command === "doctor") result = await desktopDoctor({ statePath: options.state });
  else throw new Error(`Unknown Desktop command: ${options.command}`);
  console.log(JSON.stringify(result));
  if (options.command === "doctor" && !result.ok) process.exitCode = 1;
}
