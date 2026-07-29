#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDeliveryConfigPaths,
  loadDeliveryConfig,
} from "./lib/delivery-config.mjs";
import {
  digestHookBundle,
  WorkspaceSession,
} from "./lib/workspace-session.mjs";
import {
  hookEnvironment,
  runHookProcess,
} from "./lib/hook-process.mjs";

function parseArgs(argv) {
  const action = argv[0];
  if (!["digest", "discard", "recover"].includes(action)) {
    throw new Error(
      "usage: statewright-delivery digest --root PATH | "
      + "statewright-delivery <discard|recover> --delivery-config PATH --run-id ID",
    );
  }
  if (action === "digest") {
    const rootIndex = argv.indexOf("--root");
    const root = argv[rootIndex + 1];
    if (rootIndex === -1 || !root) {
      throw new Error("digest requires --root PATH.");
    }
    return { action, root };
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

export async function digestDeliveryHooks(root, cwd = process.cwd()) {
  const path = resolve(cwd, root);
  return {
    root: path,
    sha256: await digestHookBundle(path),
  };
}

async function runHook(session, action, env = {}) {
  const task = session.config.hooks.actions[action];
  if (!task) throw new Error(`no Taskfile hook is configured for '${action}'.`);
  const { stdout } = await runHookProcess(
    process.execPath,
    [session.adapterPath(), action, "--manifest", session.manifestPath],
    {
      cwd: session.primaryCwd,
      timeoutMs: session.config.hooks.actionTimeoutMs,
      env: hookEnvironment(session, {
        STATEWRIGHT_DELIVERY_ACTION: action,
        STATEWRIGHT_DELIVERY_FINGERPRINT: "run",
        STATEWRIGHT_DELIVERY_TASK: task,
        ...env,
      }),
    },
  );
  const result = JSON.parse(stdout.trim().split("\n").at(-1));
  if (result.ok !== true || result.action !== action) {
    throw new Error(`Taskfile delivery adapter did not confirm '${action}'.`);
  }
  return result;
}

export async function discardDelivery(configPath, runId, cwd = process.cwd()) {
  const config = await loadDeliveryConfig(configPath, cwd);
  await assertDeliveryConfigPaths(config);
  const manifestPath = resolve(config.workspace.root, runId, "manifest.json");
  const session = await WorkspaceSession.resume(config, manifestPath);
  await session.preflightDiscard(runId);
  const runtime = await runHook(session, "discard", {
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
    .then(({ action, configPath, runId, root }) => {
      if (action === "digest") return digestDeliveryHooks(root);
      return action === "recover"
        ? recoverDelivery(configPath, runId)
        : discardDelivery(configPath, runId);
    })
    .then(
      (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
      (error) => {
        process.stderr.write(`[statewright-delivery] ${error.message}\n`);
        process.exitCode = 1;
      },
    );
}

export { parseArgs, runHook };
