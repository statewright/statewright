#!/usr/bin/env node

import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "@iarna/toml";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_VENDOR_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";

export function defaultDesktopStatePath(home = homedir()) {
  return join(home, ".statewright", "codex-desktop.json");
}

function escapeToml(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function parsedToml(contents) {
  try { return parseToml(contents); } catch (error) {
    throw new Error(`Refusing invalid TOML configuration: ${error.message}`);
  }
}

function validateTomlChange(before, candidate, key, value) {
  const after = parsedToml(candidate);
  if (after[key] !== value) throw new Error(`Candidate does not set root ${key}.`);
  const { [key]: _beforeValue, ...beforeRest } = before;
  const { [key]: _afterValue, ...afterRest } = after;
  if (!isDeepStrictEqual(beforeRest, afterRest)) throw new Error(`Candidate changes TOML outside root ${key}.`);
}

export function tomlValue(contents, key) {
  const value = parsedToml(contents)[key];
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`Root ${key} must be a string.`);
  return value;
}

export function replaceTomlValue(contents, key, value) {
  const before = parsedToml(contents);
  const line = `${key} = "${escapeToml(value)}"`;
  if (!Object.hasOwn(before, key)) {
    const candidate = `${line}\n${contents}`;
    validateTomlChange(before, candidate, key, value);
    return candidate;
  }
  const assignment = new RegExp(`^(\\s*(?:${key}|"${key}")\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*")(\\s*(?:#.*)?)$`, "gm");
  const candidates = [];
  for (const match of contents.matchAll(assignment)) {
    const candidate = `${contents.slice(0, match.index)}${line}${match[3]}${contents.slice(match.index + match[0].length)}`;
    try {
      validateTomlChange(before, candidate, key, value);
      candidates.push(candidate);
    } catch { /* an equivalent-looking nested or unsupported declaration */ }
  }
  if (candidates.length !== 1) throw new Error(`Cannot safely replace root ${key}; configuration text is unsupported.`);
  return candidates[0];
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

export function parseDesktopArgs(argv) {
  const [command = "doctor", ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    if (!["config", "state", "original", "wrapper"].includes(key)) throw new Error(`Unknown option: ${value}`);
    options[key] = rest[++index];
    if (!options[key]) throw new Error(`${value} requires a value.`);
  }
  return options;
}

export async function enableDesktop({ configPath, statePath, original, wrapper = resolve(SCRIPT_ROOT, "statewright-desktop-codex.mjs"), node = process.execPath } = {}) {
  const home = homedir();
  const resolvedConfig = resolve(configPath ?? join(home, ".codex", "config.toml"));
  const resolvedState = resolve(statePath ?? defaultDesktopStatePath(home));
  const current = await readFile(resolvedConfig, "utf8");
  const previous = tomlValue(current, "CODEX_CLI_PATH");
  const existing = await readOptionalJson(resolvedState);
  const vendor = resolve(original ?? previous ?? DEFAULT_VENDOR_CODEX);
  const runtime = resolve(wrapper);
  const shim = join(dirname(resolvedState), "bin", "statewright-desktop-codex");
  if (!await executable(vendor)) throw new Error(`Desktop vendor executable is not executable: ${vendor}`);
  if (!await executable(node)) throw new Error(`Node executable is not executable: ${node}`);
  if (!await readable(runtime)) throw new Error(`Desktop broker module is not readable: ${runtime}`);
  if (previous === shim && !existing) throw new Error("CODEX_CLI_PATH already points at the Statewright Desktop shim, but no rollback record exists.");
  if (existing && (existing.config_path !== resolvedConfig || existing.shim_path !== shim)) {
    throw new Error("A different Statewright Desktop setup is already recorded; disable it before replacing its control boundary.");
  }
  if (existing && previous !== existing.shim_path) {
    throw new Error("CODEX_CLI_PATH changed since setup; refusing to overwrite the user's current setting.");
  }
  const updatedConfig = replaceTomlValue(current, "CODEX_CLI_PATH", shim);
  const state = existing ? { ...existing, wrapper: runtime } : {
    version: 1,
    config_path: resolvedConfig,
    original_codex: vendor,
    wrapper: runtime,
    shim_path: shim,
    client_id: `swc_${randomBytes(16).toString("hex")}`,
  };
  await mkdir(dirname(shim), { recursive: true, mode: 0o700 });
  await writeAtomic(shim, `#!/bin/sh\nSTATEWRIGHT_DESKTOP_STATE_PATH=${shellQuote(resolvedState)} exec ${shellQuote(node)} ${shellQuote(runtime)} "$@"\n`, 0o700);
  await writeAtomic(resolvedState, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  await writeAtomic(resolvedConfig, updatedConfig, 0o600);
  return state;
}

export async function disableDesktop({ configPath, statePath } = {}) {
  const home = homedir();
  const resolvedState = resolve(statePath ?? defaultDesktopStatePath(home));
  const state = await readOptionalJson(resolvedState);
  if (!state) throw new Error("No Statewright Desktop setup is recorded.");
  const resolvedConfig = resolve(configPath ?? state.config_path);
  if (resolvedConfig !== state.config_path) throw new Error("Refusing to disable against a different config path than the recorded setup.");
  const current = await readFile(resolvedConfig, "utf8");
  if (tomlValue(current, "CODEX_CLI_PATH") !== state.shim_path) {
    throw new Error("CODEX_CLI_PATH changed since setup; refusing to overwrite the user's current setting.");
  }
  await writeAtomic(resolvedConfig, replaceTomlValue(current, "CODEX_CLI_PATH", state.original_codex), 0o600);
  await rm(state.shim_path, { force: true });
  await rm(resolvedState, { force: true });
  return state;
}

export async function desktopDoctor({ configPath, statePath } = {}) {
  const home = homedir();
  const resolvedState = resolve(statePath ?? defaultDesktopStatePath(home));
  const state = await readOptionalJson(resolvedState);
  if (!state) return { ok: false, reason: "not_configured", state_path: resolvedState };
  const resolvedConfig = resolve(configPath ?? state.config_path);
  const config = await readFile(resolvedConfig, "utf8");
  const result = {
    ok: tomlValue(config, "CODEX_CLI_PATH") === state.shim_path
      && await executable(state.original_codex)
      && await executable(state.shim_path)
      && await readable(state.wrapper),
    config_path: resolvedConfig,
    state_path: resolvedState,
    shim_path: state.shim_path,
    original_codex: state.original_codex,
    client_id: state.client_id,
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
  if (options.command === "enable") result = await enableDesktop({ configPath: options.config, statePath: options.state, original: options.original, wrapper: options.wrapper });
  else if (options.command === "disable") result = await disableDesktop({ configPath: options.config, statePath: options.state });
  else if (options.command === "doctor") result = await desktopDoctor({ configPath: options.config, statePath: options.state });
  else throw new Error(`Unknown Desktop command: ${options.command}`);
  console.log(JSON.stringify(result));
  if (options.command === "doctor" && !result.ok) process.exitCode = 1;
}
