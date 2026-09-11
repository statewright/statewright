#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { bootstrapManagedClients, installManagedClientShim, managedClientChildEnvironment, managedClientEnabled, runManagedClient, setManagedClientEnabled, uninstallManagedClients } from "./lib/managed-client-supervisor.mjs";
import { createErrorReporter, isExpectedExit, isExpectedPluginError } from "./lib/error-reporting.mjs";

const launcherPath = fileURLToPath(import.meta.url);

function managedClientVersion(argv = process.argv.slice(2)) {
  const hostIndex = argv.indexOf("--host");
  return hostIndex >= 0 && argv[hostIndex + 1] === "claude" ? "0.3.1" : "0.3.3";
}

function parseArgs(argv) {
  const options = { args: [] };
  let commandArgs = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (commandArgs) { options.args.push(arg); continue; }
    if (arg === "--") { commandArgs = true; continue; }
    if (arg === "--host") options.host = argv[++index];
    else if (arg === "--real-bin") options.realBin = argv[++index];
    else if (arg === "--install") options.install = true;
    else if (arg === "--enable") options.enable = true;
    else if (arg === "--disable") options.disable = true;
    else if (arg === "--shell-init") options.shellInit = true;
    else if (arg === "--bootstrap") options.bootstrap = true;
    else if (arg === "--uninstall") options.uninstall = true;
    else if (arg === "--kill-app-server") options.killAppServer = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--client-id") options.clientId = argv[++index];
    else if (arg === "--thread-id") options.threadId = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return "Usage: statewright-managed-client --host codex|claude --real-bin PATH -- [client args]\n       statewright-managed-client --bootstrap\n       statewright-managed-client --uninstall\n       statewright-managed-client --install --enable --host codex|claude [--real-bin PATH]\n       statewright-managed-client --disable --host codex|claude\n       statewright-managed-client --kill-app-server [--client-id ID|--thread-id ID]";
}

async function residentThread(root, clientId) {
  try {
    const registration = JSON.parse(await readFile(join(root, clientId, "routes", "codex-root-session.json"), "utf8"));
    return typeof registration?.session_id === "string" ? registration.session_id : null;
  } catch { return null; }
}

export async function killProjectAppServers({ cwd = process.cwd(), home = homedir(), clientId = null, threadId = null, input = process.stdin, output = process.stdout, errorOutput = process.stderr, kill = process.kill } = {}) {
  const root = join(home, ".statewright", "codex-app-server");
  const matches = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    try {
      const manifestPath = join(root, entry.name, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if ((manifest.cwd === cwd || manifest.threadListCwd === cwd) && Number.isInteger(manifest.pid)) {
        matches.push({ ...manifest, manifestPath, threadId: await residentThread(root, entry.name) });
      }
    } catch {}
  }
  if (!matches.length) { output.write(`[statewright] no managed App Server found for ${cwd}\n`); return []; }
  let candidates = matches;
  if (clientId) candidates = candidates.filter((item) => item.clientId === clientId);
  if (threadId) candidates = candidates.filter((item) => item.threadId === threadId);
  if (!candidates.length) {
    errorOutput.write("[statewright] no managed App Server matched the requested client or thread; nothing was terminated.\n");
    return [];
  }
  let selected = candidates;
  if (candidates.length > 1 && !(clientId || threadId)) {
    errorOutput.write(`${candidates.map((item, index) => `${index + 1}) pid=${item.pid} thread=${item.threadId ?? "unattached"} client=${item.clientId ?? "unknown"}`).join("\n")}\nSelect one number only (never all): [N] `);
    const answer = await new Promise((resolveAnswer) => input.once("data", (chunk) => resolveAnswer(String(chunk).trim())));
    const index = Number.parseInt(answer, 10) - 1;
    selected = Number.isInteger(index) && candidates[index] ? [candidates[index]] : [];
  }
  if (selected.length !== 1) return [];
  errorOutput.write(`Kill managed App Server pid=${selected[0].pid} thread=${selected[0].threadId ?? "unattached"} client=${selected[0].clientId ?? "unknown"} for ${cwd}? [y/N] `);
  const answer = await new Promise((resolveAnswer) => input.once("data", (chunk) => resolveAnswer(String(chunk).trim().toLowerCase())));
  if (answer !== "y" && answer !== "yes") return [];
  try { kill(selected[0].pid, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  output.write(`${JSON.stringify({ cwd, killed: [selected[0].pid], count: 1, clientId: selected[0].clientId, threadId: selected[0].threadId })}\n`);
  return [selected[0].pid];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const reporter = createErrorReporter({
    plugin: options.host === "claude" ? "claude-code" : "codex",
    version: managedClientVersion(),
  });
  reporter.installProcessHandlers();
  if (options.help) return process.stdout.write(`${usage()}\n`);
  if (options.bootstrap) {
    process.stdout.write(`${JSON.stringify(await bootstrapManagedClients({ launcherPath }))}\n`);
    return;
  }
  if (options.uninstall) {
    process.stdout.write(`${JSON.stringify(await uninstallManagedClients())}\n`);
    return;
  }
  if (options.killAppServer) {
    if (options.all) throw new Error("--all is not supported for managed App Server termination; select one explicit client or thread.");
    await killProjectAppServers({ cwd: process.cwd(), clientId: options.clientId, threadId: options.threadId });
    return;
  }
  if (options.shellInit) {
    process.stdout.write(process.platform === "win32"
      ? '$env:Path = "$HOME\\.statewright\\bin;$env:Path"\n'
      : 'export PATH="$HOME/.statewright/bin:$PATH"\n');
    return;
  }
  if (!["codex", "claude"].includes(options.host)) throw new Error("--host must be codex or claude.");
  if (options.enable && options.disable) throw new Error("Choose either --enable or --disable.");
  if (options.install) {
    const installed = await installManagedClientShim({ host: options.host, launcherPath, realBinary: options.realBin });
    if (options.enable) await setManagedClientEnabled(options.host, true);
    process.stdout.write(`${installed.shimPath}\n`);
    return;
  }
  if (options.enable || options.disable) {
    const path = await setManagedClientEnabled(options.host, options.enable);
    process.stdout.write(`${path}\n`);
    return;
  }
  if (!options.realBin) throw new Error("--real-bin is required when launching a managed client.");
  if (await managedClientEnabled(options.host)) {
    process.exitCode = await runManagedClient({ host: options.host, command: options.realBin, args: options.args, reporter });
    return;
  }
  const child = spawn(options.realBin, options.args, {
    stdio: "inherit",
    env: managedClientChildEnvironment({ host: options.host }),
    cwd: process.cwd(),
    shell: process.platform === "win32",
  });
  const result = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code: code ?? 1, signal }));
  });
  if (!isExpectedExit(result)) await reporter.report(new Error(`Unmanaged ${options.host} client exited unexpectedly.`), {
    mechanism: "child_exit", host: options.host, operation: "unmanaged_client", exit_code: result.code, signal: result.signal,
  });
  process.exitCode = result.code;
}

if (process.argv[1] && resolve(process.argv[1]) === launcherPath) {
  main().catch(async (error) => {
    const reporter = createErrorReporter({ plugin: "managed-client", version: managedClientVersion() });
    if (!isExpectedPluginError(error)) await reporter.report(error, { mechanism: "entrypoint", operation: "managed_client" });
    process.stderr.write(`[statewright] ${error.message}\n`);
    process.exitCode = 2;
  });
}
