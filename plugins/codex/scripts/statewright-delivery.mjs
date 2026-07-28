#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDeliveryConfigPaths,
  loadDeliveryConfig,
} from "./lib/delivery-config.mjs";
import { WorkspaceSession } from "./lib/workspace-session.mjs";
import {
  driverEnvironment,
  runDriverProcess,
} from "./lib/driver-process.mjs";

function parseArgs(argv) {
  const action = argv[0];
  if (!["discard", "recover"].includes(action)) {
    throw new Error(
      "usage: statewright-delivery <discard|recover> "
      + "--delivery-config PATH --run-id ID",
    );
  }
  const configIndex = argv.indexOf("--delivery-config");
  const runIndex = argv.indexOf("--run-id");
  const configPath = argv[configIndex + 1];
  const runId = argv[runIndex + 1];
  if (configIndex === -1 || !configPath || runIndex === -1 || !runId) {
    throw new Error(`${action} requires --delivery-config PATH and --run-id ID.`);
  }
  return { action, configPath, runId };
}

async function runDriver(session, action, env = {}) {
  const { stdout } = await runDriverProcess(
    process.execPath,
    [session.driverPath(), action, "--manifest", session.manifestPath],
    {
      cwd: session.primaryCwd,
      timeoutMs: session.config.preview.actionTimeoutMs,
      env: driverEnvironment(session, env),
    },
  );
  const result = JSON.parse(stdout.trim());
  if (result.ok !== true || result.action !== action) {
    throw new Error(`delivery driver did not confirm '${action}'.`);
  }
  return result;
}

export async function discardDelivery(configPath, runId, cwd = process.cwd()) {
  const config = await loadDeliveryConfig(configPath, cwd);
  await assertDeliveryConfigPaths(config);
  const manifestPath = resolve(config.workspace.root, runId, "manifest.json");
  const session = await WorkspaceSession.resume(config, manifestPath);
  await session.preflightDiscard(runId);
  const runtime = await runDriver(session, "discard", {
    STATEWRIGHT_DELIVERY_DISCARD_RUN_ID: runId,
  });
  await session.discard(runId);
  return {
    status: "discarded",
    run_id: runId,
    runtime,
    manifest_path: manifestPath,
  };
}

export async function recoverDelivery(configPath, runId, cwd = process.cwd()) {
  const config = await loadDeliveryConfig(configPath, cwd);
  await assertDeliveryConfigPaths(config);
  const manifestPath = resolve(config.workspace.root, runId, "manifest.json");
  const session = await WorkspaceSession.resume(config, manifestPath, {
    allowRecovery: true,
  });
  const promotion = await session.recoverPromotion(runId);
  return {
    status: "recovered",
    run_id: runId,
    promotion,
    manifest_path: manifestPath,
  };
}

function isMainModule() {
  try {
    return Boolean(
      process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url),
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  Promise.resolve(parseArgs(process.argv.slice(2)))
    .then(({ action, configPath, runId }) =>
      action === "recover"
        ? recoverDelivery(configPath, runId)
        : discardDelivery(configPath, runId))
    .then(
      (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
      (error) => {
        process.stderr.write(`[statewright-delivery] ${error.message}\n`);
        process.exitCode = 1;
      },
    );
}

export { parseArgs, runDriver };
