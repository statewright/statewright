#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { bootstrapManagedClients, installManagedClientShim, managedClientEnabled, runManagedClient, setManagedClientEnabled, uninstallManagedClients } from "./lib/managed-client-supervisor.mjs";

const launcherPath = fileURLToPath(import.meta.url);

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
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return "Usage: statewright-managed-client --host codex|claude --real-bin PATH -- [client args]\n       statewright-managed-client --bootstrap\n       statewright-managed-client --uninstall\n       statewright-managed-client --install --enable --host codex|claude [--real-bin PATH]\n       statewright-managed-client --disable --host codex|claude";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return process.stdout.write(`${usage()}\n`);
  if (options.bootstrap) {
    process.stdout.write(`${JSON.stringify(await bootstrapManagedClients({ launcherPath }))}\n`);
    return;
  }
  if (options.uninstall) {
    process.stdout.write(`${JSON.stringify(await uninstallManagedClients())}\n`);
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
    process.exitCode = await runManagedClient({ host: options.host, command: options.realBin, args: options.args });
    return;
  }
  const child = spawn(options.realBin, options.args, {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
    shell: process.platform === "win32",
  });
  process.exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === launcherPath) {
  main().catch((error) => { process.stderr.write(`[statewright] ${error.message}\n`); process.exitCode = 2; });
}
