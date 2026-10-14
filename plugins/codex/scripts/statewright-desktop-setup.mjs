#!/usr/bin/env node

import { execFile as execFileCallback, spawn as spawnCallback } from "node:child_process";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { invokeCredentialHelper } from "./lib/desktop-runtime/credential-store.mjs";
import { canonicalGateway } from "./lib/desktop-runtime/gateway-profile.mjs";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_VENDOR_CODEX_CANDIDATES = Object.freeze([
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex",
]);
const DEFAULT_DESKTOP_EXECUTABLE = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const LEGACY_DESKTOP_APP_NAME = "Statewright ChatGPT.app";
const LEGACY_DESKTOP_APP_EXECUTABLE = "Statewright ChatGPT";
const DEFAULT_LAUNCHCTL = "/bin/launchctl";
const DESKTOP_ENVIRONMENT_KEY = "CODEX_CLI_PATH";
const DESKTOP_LOCK_TIMEOUT_MS = 5_000;
const NATIVE_LAUNCHER_NAME = "statewright-native-desktop-launcher";
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
  }),
  development: Object.freeze({
    name: "development",
    appName: "ChatGPT + Statewright Dev.app",
    displayName: "ChatGPT + Statewright Dev",
    executableName: "ChatGPT + Statewright Dev",
    bundleId: "ai.statewright.chatgpt.development",
    stateFile: "codex-desktop-development.json",
    shimName: "statewright-desktop-codex-development",
    launcherName: "statewright-desktop-development-launch.mjs",
    gatewayUrl: null,
  }),
});
const execFile = promisify(execFileCallback);

function desktopProfile(name = "production") {
  const profile = DESKTOP_PROFILES[name];
  if (!profile) throw new Error(`Unknown Desktop profile: ${name}. Expected production, staging, or development.`);
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
async function sha256(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
function defaultNativeLauncherCandidate(platform = process.platform, arch = process.arch) { return resolve(SCRIPT_ROOT, "..", "native", `${platform}-${arch}`, NATIVE_LAUNCHER_NAME); }
function legacyDesktopShimContents(statePath, nodeExecutable, runtime) { return `#!/bin/sh\nSTATEWRIGHT_DESKTOP_STATE_PATH=${shellQuote(statePath)} exec ${shellQuote(nodeExecutable)} ${shellQuote(runtime)} "$@"\n`; }
function nativeDesktopConfigContents({ statePath, originalCodex, nodeExecutable, runtime }) {
  const values = { original_codex: originalCodex, node_executable: nodeExecutable, broker_script: runtime, state_path: statePath };
  for (const [name, value] of Object.entries(values)) if (!value || /[\r\n]/.test(value)) throw new Error(`Native Desktop launcher ${name} is not a safe single-line path.`);
  return `version=1\noriginal_codex=${originalCodex}\nnode_executable=${nodeExecutable}\nbroker_script=${runtime}\nstate_path=${statePath}\n`;
}
const DESKTOP_PACKAGE_ROOTS = new Set([".codex-plugin", "scripts", "vendor", "bin", "native"]);
async function desktopPackageDigest(root, sourcePackage = false) {
  const hash = createHash("sha256");
  async function visit(directory, prefix = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!prefix && sourcePackage && !DESKTOP_PACKAGE_ROOTS.has(entry.name)) continue;
      const name = prefix + entry.name, path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Desktop runtime package contains a symbolic link: " + name);
      if (entry.isDirectory()) await visit(path, name + "/");
      else if (entry.isFile()) {
        const mode = (await lstat(path)).mode & 0o111;
        const bytes = await readFile(path);
        hash.update(name + "\0" + mode + "\0" + bytes.length + "\0").update(bytes);
      } else throw new Error("Desktop runtime package contains a non-file entry: " + name);
    }
  }
  await visit(root);
  return hash.digest("hex");
}

// Desktop must survive cache eviction without first launching the TUI. Keep
// complete, content-addressed packages; never replace a live runtime in place.
export async function persistDesktopRuntime({ pluginRoot = resolve(SCRIPT_ROOT, ".."), statePath }) {
  const source = await realpath(pluginRoot);
  let storage = resolve(await realpath(dirname(statePath)), "runtime", "codex-desktop");
  const requireOutsidePackage = path => {
    const fromSource = relative(source, path);
    if (!fromSource || (fromSource !== ".." && !fromSource.startsWith(".." + sep) && !isAbsolute(fromSource))) {
      throw new Error("Desktop runtime storage must be outside the plugin package.");
    }
  };
  requireOutsidePackage(storage);
  const manifest = await readOptionalJson(join(source, ".codex-plugin", "plugin.json"));
  if (manifest?.name !== "statewright" || typeof manifest.version !== "string" || !/^[A-Za-z0-9._+-]+$/.test(manifest.version)) {
    throw new Error("Desktop runtime requires a versioned Statewright Codex package.");
  }
  const entry = join("scripts", "statewright-desktop-codex.mjs");
  if (!await readable(join(source, entry))) throw new Error("Desktop runtime package is missing its broker.");
  await mkdir(storage, { recursive: true, mode: 0o700 });
  storage = await realpath(storage);
  requireOutsidePackage(storage);
  const digest = await desktopPackageDigest(source, true);
  const target = join(storage, manifest.version + "-" + digest);
  const verify = async () => {
    if (await desktopPackageDigest(target) !== digest) throw new Error("The durable Desktop runtime differs from its package; refusing to overwrite it.");
  };
  try {
    if (!(await lstat(target)).isDirectory()) throw new Error("The durable Desktop runtime is not a directory.");
    await verify(); return join(target, entry);
  }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const temporary = await mkdtemp(join(storage, ".install-"));
  const staged = join(temporary, "package");
  try {
    await mkdir(staged, { mode: 0o700 });
    for (const name of await readdir(source)) {
      if (DESKTOP_PACKAGE_ROOTS.has(name)) {
        await cp(join(source, name), join(staged, name), { recursive: true, force: false, errorOnExist: true });
      }
    }
    if (await desktopPackageDigest(staged) !== digest) throw new Error("Desktop plugin changed during runtime snapshot; retry with a stable package.");
    try { await rename(staged, target); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
      await verify(); // Another profile can publish the identical snapshot.
    }
    return join(target, entry);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function parseNativeDesktopConfig(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) return null;
    const key = line.slice(0, separator);
    if (!["version", "original_codex", "node_executable", "broker_script", "state_path"].includes(key) || Object.hasOwn(values, key)) return null;
    values[key] = line.slice(separator + 1);
  }
  return values.version === "1" && values.original_codex && values.node_executable && values.broker_script && values.state_path ? values : null;
}
async function readVerifiedNativeInstallation({ state, statePath, shimPath, profile }) {
  const receiptPath = `${shimPath}.receipt.json`;
  const configPath = `${shimPath}.conf`;
  if (state?.native_launcher_receipt && state.native_launcher_receipt !== receiptPath) return null;
  if (state?.native_launcher_config && state.native_launcher_config !== configPath) return null;
  const receipt = await readOptionalJson(receiptPath);
  if (!receipt || receipt.shim_path !== shimPath || receipt.state_path !== statePath || receipt.profile !== profile.name || !/^[a-f0-9]{64}$/.test(receipt.binary_sha256 ?? "")) return null;
  if (!await executable(shimPath) || !await readable(configPath) || await sha256(shimPath) !== receipt.binary_sha256) return null;
  const config = parseNativeDesktopConfig(await readFile(configPath, "utf8"));
  if (!config || config.state_path !== statePath || config.node_executable !== state?.node_executable || config.broker_script !== state?.wrapper || !await executable(config.original_codex)) return null;
  return { receipt, receiptPath, configPath };
}
async function resolveVendorCodex({ original, existing, candidates = DEFAULT_VENDOR_CODEX_CANDIDATES }) {
  if (original) return resolve(original);
  const resolvedCandidates = candidates.map(value => resolve(value));
  if (existing?.version === 3 && existing.original_codex && !resolvedCandidates.includes(resolve(existing.original_codex)) && await executable(existing.original_codex)) return resolve(existing.original_codex);
  for (const candidate of resolvedCandidates) if (await executable(candidate)) return candidate;
  if (existing?.version === 3 && existing.original_codex && await executable(existing.original_codex)) return resolve(existing.original_codex);
  return resolve(candidates[0]);
}
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
import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const statePath = ${JSON.stringify(statePath)};
let diagnosticReporter;
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
  child.once("exit", (code, signal) => {
    const error = new Error(\`ChatGPT exited \${spawned ? "during startup" : "before startup"} (code \${code ?? "none"}, signal \${signal ?? "none"}).\`);
    error.code = "DESKTOP_CHILD_EXITED";
    settle(reject, error);
  });
  child.once("spawn", () => {
    spawned = true;
    graceTimer = setTimeout(() => settle(resolve), 250);
  });
});

try {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  await access(state.desktop_executable, constants.X_OK);
  await access(state.shim_path, constants.X_OK);
  const runtimeUrl = pathToFileURL(join(dirname(state.wrapper), "lib", "desktop-runtime", "codex-desktop-app-server-launcher.mjs"));
  const { connectDesktopProfile, desktopProfileEnvironment, startProfileDesktopMcpBridge } = await import(runtimeUrl);
  const profileEnvironment = await desktopProfileEnvironment(state, process.env);
  // Optional diagnostics must never become a launcher dependency.
  try {
    const { createErrorReporter } = await import(new URL("./error-reporting.mjs", runtimeUrl));
    diagnosticReporter = createErrorReporter({ plugin: "codex", version: "0.3.4", environment: profileEnvironment });
  } catch {}
  const profile = state.profile ?? "production";
  if (!["production", "staging", "development"].includes(profile)) throw new Error("Unknown Desktop profile in launcher state.");
  const laneRoot = join(dirname(statePath), "desktop-lanes", profile);
  const userDataPath = join(laneRoot, "user-data");
  // The broker creates its own private App Server home from this source.
  // Keep the installed Codex auth and plugins visible to that broker.
  const codexHome = profileEnvironment.CODEX_HOME || join(homedir(), ".codex");
  await mkdir(laneRoot, { recursive: true, mode: 0o700 });
  await mkdir(userDataPath, { recursive: true, mode: 0o700 });
  let bridge;
  try { bridge = await startProfileDesktopMcpBridge({ state, environment: profileEnvironment, withLanePool: true }); }
  catch (error) {
    if (error.code !== "CREDENTIAL_MISSING") throw error;
    await connectDesktopProfile({ state, environment: profileEnvironment });
    bridge = await startProfileDesktopMcpBridge({ state, environment: profileEnvironment, withLanePool: true });
  }
  const child = spawn(state.desktop_executable, ["--user-data-dir=" + userDataPath], {
    detached: false,
    stdio: "ignore",
    env: {
      ...profileEnvironment,
      CODEX_HOME: codexHome,
      CODEX_ELECTRON_USER_DATA_PATH: userDataPath,
      CODEX_CLI_PATH: state.shim_path,
      STATEWRIGHT_NODE_BIN: state.node_executable,
      STATEWRIGHT_DESKTOP_MCP_URL: bridge.url,
      STATEWRIGHT_DESKTOP_MCP_TOKEN: bridge.token,
      STATEWRIGHT_DESKTOP_BRIDGE_POOL_URL: bridge.poolUrl,
      STATEWRIGHT_DESKTOP_BRIDGE_POOL_TOKEN: bridge.poolToken,
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
  if (!["DESKTOP_CONNECT_CANCELLED", "CREDENTIAL_UNLOCK_CANCELLED", "DESKTOP_CONNECT_DENIED"].includes(error.code)) {
    try { await diagnosticReporter?.report(error, { operation: "login", mechanism: "entrypoint" }); } catch {}
  }
  process.stderr.write(\`ChatGPT + Statewright could not start: \${error.message}\\n\`);
  process.exitCode = error.code === "CREDENTIAL_MISSING" ? 20
    : ["CREDENTIAL_STORE_UNAVAILABLE", "CREDENTIAL_HELPER_MISSING", "CREDENTIAL_HELPER_FAILED", "CREDENTIAL_HELPER_TIMEOUT"].includes(error.code) ? 21
    : error.code === "DESKTOP_CHILD_EXITED" ? 22
    : error.code === "DESKTOP_CONNECT_CANCELLED" ? 23
    : error.code === "DESKTOP_CONNECT_UNAVAILABLE" ? 24
    : error.code === "DESKTOP_CONNECT_UI" ? 25
    : error.code === "DESKTOP_CONNECT_EXPIRED" ? 26
    : error.code === "DESKTOP_CONNECT_DENIED" ? 27
    : error.code === "DESKTOP_CONNECT_PROTOCOL" ? 28
    : error.code === "DESKTOP_CONNECT_CONFIG" ? 29
    : error.code === "DESKTOP_CONNECT_REJECTED" ? 30
    : error.code === "DESKTOP_CONNECT_STORE" ? 31 : 1;
}
`;
}
function appleScriptQuote(value) { return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`; }
function desktopAppContents(launcherPath, nodeExecutable, profile) {
  const alert = message => shellQuote(`display alert ${appleScriptQuote(`${profile.displayName} could not start`)} message ${appleScriptQuote(message)}`);
  const connectHost = profile.name === "staging" ? "scodex" : profile.name === "production" ? "codex" : null;
  const missingCredential = connectHost
    ? `No ${profile.name} gateway credential is stored in Keychain. Open ${connectHost}, call statewright_connect, approve in your browser, then reopen this app.`
    : "No development gateway credential is stored in Keychain. Connect that gateway from its matching Codex CLI profile, then reopen this app.";
  return `#!/bin/sh
${shellQuote(nodeExecutable)} ${shellQuote(launcherPath)}
status=$?
if [ "$status" -eq 0 ]; then exit 0; fi
case "$status" in
  20) /usr/bin/osascript -e ${alert(missingCredential)} >/dev/null 2>&1 || true ;;
  21) /usr/bin/osascript -e ${alert("Statewright could not read the OS credential store. Check Keychain access, then run the Desktop doctor for this profile.")} >/dev/null 2>&1 || true ;;
  22) /usr/bin/osascript -e ${alert("ChatGPT exited during startup. It may still be running in the background; check Activity Monitor, quit that app only, then retry. Your Codex TUI uses a separate App Server lane.")} >/dev/null 2>&1 || true ;;
  23) exit 0 ;;
  24) /usr/bin/osascript -e ${alert("Statewright sign-in is unreachable. Check your network connection, then reopen this app to retry.")} >/dev/null 2>&1 || true ;;
  25) /usr/bin/osascript -e ${alert("Statewright could not open the connection page or show its dialog. Reopen this app to retry.")} >/dev/null 2>&1 || true ;;
  26) /usr/bin/osascript -e ${alert("The connection code expired before approval. Reopen this app for a fresh code.")} >/dev/null 2>&1 || true ;;
  27) /usr/bin/osascript -e ${alert("The Statewright connection was denied. Reopen this app if you want to try again.")} >/dev/null 2>&1 || true ;;
  28) /usr/bin/osascript -e ${alert("Statewright returned an unexpected sign-in response. Reopen this app to retry or contact support.")} >/dev/null 2>&1 || true ;;
  29) /usr/bin/osascript -e ${alert("This Desktop profile has no matching Statewright sign-in service. Check its gateway configuration.")} >/dev/null 2>&1 || true ;;
  30) /usr/bin/osascript -e ${alert("Statewright did not accept the new connection. Reopen this app to retry.")} >/dev/null 2>&1 || true ;;
  31) /usr/bin/osascript -e ${alert("Statewright could not save the new connection in Keychain. Check Keychain access, then retry.")} >/dev/null 2>&1 || true ;;
  *) /usr/bin/osascript -e ${alert(`Run ${nodeExecutable} ${launcherPath} in Terminal to see the startup error. Your Codex TUI uses a separate App Server lane.`)} >/dev/null 2>&1 || true ;;
esac
exit "$status"
`;
}
async function installDesktopApp({ statePath, applicationsDirectory, nodeExecutable, profile, writeAtomicFn }) {
  const launcherPath = join(dirname(statePath), "bin", profile.launcherName);
  const appPath = join(applicationsDirectory, profile.appName);
  await writeAtomicFn(launcherPath, desktopLauncherContents(statePath), 0o700);
  await writeAtomicFn(join(appPath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleDisplayName</key><string>${profile.displayName}</string><key>CFBundleExecutable</key><string>${profile.executableName}</string><key>CFBundleIdentifier</key><string>${profile.bundleId}</string><key>CFBundleName</key><string>${profile.displayName}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`, 0o600);
  await writeAtomicFn(join(appPath, "Contents", "MacOS", profile.executableName), desktopAppContents(launcherPath, nodeExecutable, profile), 0o700);
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

async function installNativeDesktopDispatcher({ existing, verified, source, statePath, shimPath, launcherAppPath, profile, originalCodex, nodeExecutable, runtime, writeAtomicFn }) {
  if (!source && !verified) throw new Error("Native Desktop routing was previously enabled, but its installed launcher no longer verifies and no replacement launcher is available. Reinstall with --native-launcher; refusing to restore the app-server-only shell shim.");
  if (source && resolve(source) === resolve(shimPath) && !verified) throw new Error("The native launcher source cannot be the unverified destination shim.");

  const receiptPath = `${shimPath}.receipt.json`;
  const configPath = `${shimPath}.conf`;
  const recordedRollbackPath = existing?.rollback_shim_path ?? verified?.receipt?.rollback_path;
  if (recordedRollbackPath && !recordedRollbackPath.startsWith(`${shimPath}.pre-native`)) throw new Error("Recorded native Desktop rollback path is outside the profile launcher boundary.");
  const rollbackPath = recordedRollbackPath ?? `${shimPath}.pre-native`;
  if (!await executable(rollbackPath)) {
    if (await executable(shimPath) && !verified) await writeAtomicFn(rollbackPath, await readFile(shimPath), 0o700);
    else await writeAtomicFn(rollbackPath, legacyDesktopShimContents(statePath, nodeExecutable, runtime), 0o700);
  }

  await writeAtomicFn(configPath, nativeDesktopConfigContents({ statePath, originalCodex, nodeExecutable, runtime }), 0o600);
  if (source && resolve(source) !== resolve(shimPath)) await writeAtomicFn(shimPath, await readFile(source), 0o700);
  const binaryHash = await sha256(shimPath);
  const rollbackHash = await sha256(rollbackPath);
  const receipt = {
    version: 1,
    profile: profile.name,
    launcher_app_path: launcherAppPath,
    state_path: statePath,
    shim_path: shimPath,
    sidecar_path: configPath,
    rollback_path: rollbackPath,
    launcher_source: source ? resolve(source) : (existing?.native_launcher_source ?? null),
    binary_sha256: binaryHash,
    rollback_sha256: rollbackHash,
    installed_at: new Date().toISOString(),
  };
  await writeAtomicFn(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
  return {
    launcher_kind: "native_dispatcher",
    native_launcher_source: receipt.launcher_source,
    native_launcher_config: configPath,
    native_launcher_receipt: receiptPath,
    rollback_shim_path: rollbackPath,
  };
}

export function parseDesktopArgs(argv) {
  const [command = "doctor", ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    if (!["state", "original", "wrapper", "app", "profile", "gateway-url", "native-launcher"].includes(key)) throw new Error(`Unknown option: ${value}`);
    const optionKey = key === "gateway-url" ? "gatewayUrl" : key === "native-launcher" ? "nativeLauncher" : key;
    options[optionKey] = rest[++index];
    if (!options[optionKey]) throw new Error(`${value} requires a value.`);
  }
  if (options.profile) desktopProfile(options.profile);
  return options;
}

async function enableDesktopUnlocked({ statePath, profile: profileName = "production", gatewayUrl: gatewayUrlOverride, preserveGateway = false, original, wrapper, app = DEFAULT_DESKTOP_EXECUTABLE, applicationsDirectory, node = process.execPath, nativeLauncher, nativeLauncherCandidate = defaultNativeLauncherCandidate(), requireNativeLauncher = process.platform === "darwin" && resolve(app) === resolve(DEFAULT_DESKTOP_EXECUTABLE), launchctlPath, launchctlExecFile = execFile, writeAtomicFn = writeAtomic, vendorCandidates = DEFAULT_VENDOR_CODEX_CANDIDATES } = {}) {
  const profile = desktopProfile(profileName);
  const resolvedState = resolve(statePath);
  const existing = await readOptionalJson(resolvedState);
  const vendor = await resolveVendorCodex({ original, existing, candidates: vendorCandidates });
  let runtime = resolve(wrapper ?? join(SCRIPT_ROOT, "statewright-desktop-codex.mjs"));
  const nodeExecutable = resolve(node);
  const desktopExecutable = resolve(app);
  const desktopApplicationsDirectory = resolve(applicationsDirectory ?? defaultDesktopApplicationsDirectory(homedir()));
  const launcherAppPath = join(desktopApplicationsDirectory, profile.appName);
  const shim = join(dirname(resolvedState), "bin", profile.shimName);
  const gatewayUrl = (preserveGateway ? existing?.gateway_url : null) ?? gatewayUrlOverride ?? profile.gatewayUrl;
  if (!gatewayUrl) throw new Error(`Desktop profile ${profile.name} requires an explicit --gateway-url.`);
  canonicalGateway(gatewayUrl); // Reject malformed endpoint metadata before any setup writes.
  if (!await executable(vendor)) throw new Error(`Desktop vendor executable is not executable: ${vendor}`);
  if (!await executable(desktopExecutable)) throw new Error(`ChatGPT Desktop executable is not executable: ${desktopExecutable}`);
  if (!await executable(nodeExecutable)) throw new Error(`Node executable is not executable: ${nodeExecutable}`);
  if (!await readable(runtime)) throw new Error(`Desktop broker module is not readable: ${runtime}`);
  if (nativeLauncher && !await executable(resolve(nativeLauncher))) throw new Error(`Native Desktop launcher is not executable: ${resolve(nativeLauncher)}`);
  const bundledVendorMigration = existing?.version === 3
    && existing.original_codex !== vendor
    && vendorCandidates.map(value => resolve(value)).includes(resolve(existing.original_codex))
    && vendorCandidates.map(value => resolve(value)).includes(vendor);
  if (existing && existing.version !== 2 && (existing.version !== 3 || (existing.profile ?? "production") !== profile.name || existing.shim_path !== shim || (existing.original_codex !== vendor && !bundledVendorMigration) || existing.desktop_executable !== desktopExecutable)) throw new Error("A different Statewright Desktop setup is already recorded; disable it before replacing its control boundary.");
  if (wrapper === undefined) runtime = await persistDesktopRuntime({ statePath: resolvedState });
  const legacyPath = await legacyLaunchdPath(existing, { launchctlExecFile, launchctlPath });
  await mkdir(dirname(shim), { recursive: true, mode: 0o700 });
  const verifiedNative = await readVerifiedNativeInstallation({ state: existing, statePath: resolvedState, shimPath: shim, profile });
  const recordedNative = existing?.launcher_kind === "native_dispatcher";
  const recordedNativeSource = existing?.native_launcher_source && await executable(existing.native_launcher_source) ? resolve(existing.native_launcher_source) : null;
  const packagedNativeSource = nativeLauncherCandidate && await executable(resolve(nativeLauncherCandidate)) ? resolve(nativeLauncherCandidate) : null;
  const nativeSource = nativeLauncher ? resolve(nativeLauncher) : packagedNativeSource ?? recordedNativeSource;
  const useNative = Boolean(nativeSource || verifiedNative || recordedNative);
  if (!useNative && requireNativeLauncher) throw new Error(`The macOS Desktop setup requires the packaged native dispatcher, but it is unavailable at ${resolve(nativeLauncherCandidate)}. Reinstall the Codex plugin or pass --native-launcher from a trusted build; refusing to create the app-server-only shell shim.`);
  const launcherState = useNative
    ? await installNativeDesktopDispatcher({ existing, verified: verifiedNative, source: nativeSource, statePath: resolvedState, shimPath: shim, launcherAppPath, profile, originalCodex: vendor, nodeExecutable, runtime, writeAtomicFn })
    : { launcher_kind: "legacy_app_server_shell" };
  if (!useNative) await writeAtomicFn(shim, legacyDesktopShimContents(resolvedState, nodeExecutable, runtime), 0o700);
  const state = existing?.version === 3
    ? { ...existing, ...launcherState, profile: profile.name, original_codex: vendor, wrapper: runtime, node_executable: nodeExecutable, launcher_app_path: launcherAppPath, gateway_url: gatewayUrl }
    : { version: 3, ...launcherState, profile: profile.name, environment_key: DESKTOP_ENVIRONMENT_KEY, original_codex: vendor, desktop_executable: desktopExecutable, wrapper: runtime, shim_path: shim, node_executable: nodeExecutable, launcher_app_path: launcherAppPath, gateway_url: gatewayUrl, client_id: existing?.client_id ?? `swc_${randomBytes(16).toString("hex")}` };
  delete state.api_key_path; // Leave legacy files untouched; they are not launch credentials.
  state.credential_store = "gateway_keyring";
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

// Refresh every already-configured surface from the same installed package.
// Only production is provisioned on first use; private endpoints are never
// invented, disabled profiles stay disabled, and each profile keeps its owner.
export async function provisionDesktopProfiles({ home = homedir(), ...options } = {}) {
  const results = [];
  for (const profile of Object.keys(DESKTOP_PROFILES)) {
    const statePath = defaultDesktopStatePath(home, profile);
    try {
      const existing = await readOptionalJson(statePath);
      if (profile !== "production" && !existing) continue;
      results.push(await provisionDesktop({ ...options, profile, statePath, preserveGateway: true,
        app: existing?.desktop_executable ?? options.app,
      }));
    } catch {
      results.push({ profile, state_path: statePath, skipped: "setup_requires_attention" });
    }
  }
  return results;
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
    if (state.launcher_kind === "native_dispatcher") {
      await rm(`${state.shim_path}.conf`, { force: true });
      await rm(`${state.shim_path}.receipt.json`, { force: true });
      if (state.rollback_shim_path?.startsWith(`${state.shim_path}.pre-native`)) await rm(state.rollback_shim_path, { force: true });
    }
    await rm(resolvedState, { force: true });
    return { ...state, disabled: true, app_removed: appRemoved, launcher_removed: launcherRemoved };
  });
}

export async function desktopDoctor({ statePath, profile: profileName = "production", credentialStatus = gateway => invokeCredentialHelper({ operation: "status", gateway }) } = {}) {
  const resolvedState = resolve(statePath ?? defaultDesktopStatePath(homedir(), profileName));
  if (await readable(desktopDisabledPath(resolvedState))) return { ok: false, reason: "disabled", state_path: resolvedState };
  const state = await readOptionalJson(resolvedState);
  if (!state) return { ok: false, reason: "not_configured", state_path: resolvedState };
  if (state.version !== 3) return { ok: false, reason: "legacy_setup_requires_enable", state_path: resolvedState };
  const profile = desktopProfile(state.profile ?? profileName);
  const launcherPath = state.launcher_app_path && join(state.launcher_app_path, "Contents", "MacOS", profile.executableName);
  let credentialPresent = false;
  let credentialReason = "missing";
  try {
    const status = await credentialStatus(canonicalGateway(state.gateway_url));
    credentialPresent = status?.ok === true && status?.status === "configured";
    credentialReason = credentialPresent ? "available" : "missing_or_unavailable";
  } catch { credentialReason = "store_unavailable"; }
  const nativeInstallation = state.launcher_kind === "native_dispatcher" ? await readVerifiedNativeInstallation({ state, statePath: resolvedState, shimPath: state.shim_path, profile }) : true;
  return { ok: state.credential_store === "gateway_keyring" && await executable(state.original_codex) && await executable(state.desktop_executable) && await executable(state.node_executable) && await executable(state.shim_path) && await readable(state.wrapper) && Boolean(launcherPath) && await executable(launcherPath) && credentialPresent && Boolean(nativeInstallation), profile: profile.name, state_path: resolvedState, shim_path: state.shim_path, original_codex: state.original_codex, desktop_executable: state.desktop_executable, node_executable: state.node_executable, launcher_app_path: state.launcher_app_path ?? null, gateway_url: state.gateway_url ?? null, credential_store: state.credential_store ?? "legacy_setup_requires_enable", credential_present: credentialPresent, credential_status: credentialReason, client_id: state.client_id, launcher_kind: state.launcher_kind ?? "legacy_app_server_shell", launch_mode: "explicit_process_environment" };
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
  if (options.command === "enable") result = await enableDesktop({ statePath: options.state, profile: options.profile, gatewayUrl: options.gatewayUrl, original: options.original, wrapper: options.wrapper, app: options.app, nativeLauncher: options.nativeLauncher });
  else if (options.command === "provision-all") result = await provisionDesktopProfiles({ app: options.app, nativeLauncher: options.nativeLauncher });
  else if (options.command === "provision") result = await provisionDesktop({ statePath: options.state, profile: options.profile, gatewayUrl: options.gatewayUrl, original: options.original, wrapper: options.wrapper, app: options.app, nativeLauncher: options.nativeLauncher });
  else if (options.command === "launch") result = await launchDesktop({ statePath: options.state, profile: options.profile });
  else if (options.command === "disable") result = await disableDesktop({ statePath: options.state, profile: options.profile });
  else if (options.command === "doctor") result = await desktopDoctor({ statePath: options.state, profile: options.profile });
  else throw new Error(`Unknown Desktop command: ${options.command}`);
  console.log(JSON.stringify(result));
  if (options.command === "doctor" && !result.ok) process.exitCode = 1;
}
