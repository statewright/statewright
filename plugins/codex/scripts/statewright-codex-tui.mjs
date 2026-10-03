#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function usage() {
  return [
    "Usage: statewright-codex-tui --workflow NAME [--model MODEL] [--effort LEVEL] -- PROMPT",
    "",
    "Own an interactive Codex session and restart it at each Statewright route boundary.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { codexBin: "codex", prompt: [], fallbackModel: "gpt-5.6-terra", fallbackEffort: "medium", fallbackServiceTier: "default" };
  let prompt = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (prompt) { options.prompt.push(value); continue; }
    if (value === "--") { prompt = true; continue; }
    if (value === "--workflow") options.workflow = argv[++index];
    else if (value === "--model") options.fallbackModel = argv[++index];
    else if (value === "--effort") options.fallbackEffort = argv[++index];
    else if (value === "--service-tier") options.fallbackServiceTier = argv[++index];
    else if (value === "--codex-bin") options.codexBin = argv[++index];
    else if (value === "-h" || value === "--help") options.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  if (!options.help && (!options.workflow || options.prompt.length === 0)) throw new Error("--workflow and a prompt are required.");
  return options;
}

export function cliModel(model) {
  return String(model ?? "").replace(/^openai-codex\//, "");
}

export function codexArgs({ model, effort, serviceTier, resumeSession, prompt }) {
  const route = ["-m", cliModel(model), "-c", `model_reasoning_effort=${JSON.stringify(effort)}`];
  if (serviceTier) route.push("-c", `service_tier=${JSON.stringify(serviceTier)}`);
  return resumeSession ? [...route, "resume", resumeSession, prompt] : [...route, prompt];
}

function waitForExit(child) {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function signalChild(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child may have already exited or the host may reject group signals.
    }
  }
  child.kill(signal);
}

async function nextRequest(controlDir, consumed) {
  const entries = await (await import("node:fs/promises")).readdir(controlDir);
  for (const entry of entries.filter((name) => name === "route.json" || name.endsWith(".route.json")).sort()) {
    if (consumed.has(entry)) continue;
    const request = JSON.parse(await readFile(join(controlDir, entry), "utf8"));
    consumed.add(entry);
    const registration = await readFile(join(controlDir, "codex-root-session.json"), "utf8").then(JSON.parse).catch(() => null);
    if (!registration || registration.version !== 1) continue;
    if (request.client_id !== registration.client_id) continue;
    if (request.session_id !== registration.session_id || request.root_session_id !== registration.session_id) continue;
    if (typeof request.model !== "string") continue;
    return request;
  }
  return null;
}

export async function run(options) {
  const controlDir = await mkdtemp(join(tmpdir(), "statewright-codex-route-"));
  const consumed = new Set();
  let route = { model: options.fallbackModel, effort: options.fallbackEffort, serviceTier: options.fallbackServiceTier };
  let workflowOrigin = null;
  let resumeSession = null;
  let prompt = `Call statewright_load_workflow with workflow '${options.workflow}', then follow the active Statewright workflow. ${options.prompt.join(" ")}`;
  try {
    while (true) {
      const child = spawn(options.codexBin, codexArgs({ ...route, resumeSession, prompt }), {
        stdio: "inherit",
        detached: process.platform !== "win32",
        env: { ...(options.environment ?? process.env), STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir },
      });
      let restartRequested = false;
      let exited = false;
      child.once("exit", () => { exited = true; });
      const exit = waitForExit(child);
      while (!exited) {
        const request = await nextRequest(controlDir, consumed).catch(() => null);
        if (request) {
          if (request.restore_original === true) {
            const bindingMatches = workflowOrigin
              && workflowOrigin.run_id === request.run_id
              && workflowOrigin.session_id === request.session_id
              && workflowOrigin.client_id === request.client_id
              && workflowOrigin.root_session_id === request.root_session_id;
            if (!bindingMatches) {
              process.stderr.write("[statewright] skipped model restoration because the captured route origin did not match this workflow execution.\n");
              continue;
            }
            route = { ...workflowOrigin.route };
          } else {
            if (request.run_id && !workflowOrigin) {
              workflowOrigin = {
                run_id: request.run_id,
                run_session_id: request.run_session_id ?? null,
                session_id: request.session_id,
                root_session_id: request.root_session_id,
                client_id: request.client_id,
                route: { ...route },
              };
            } else if (workflowOrigin && request.run_id !== workflowOrigin.run_id) {
              process.stderr.write("[statewright] refused a new workflow route until the prior route origin is restored or relinquished.\n");
              continue;
            }
            route = {
              model: request.model || route.model,
              effort: request.effort || route.effort,
              serviceTier: request.service_tier || route.serviceTier,
            };
          }
          process.stderr.write(`[statewright] restarting Codex for ${request.state ?? "next"} on ${route.model}\n`);
          resumeSession = request.session_id;
          restartRequested = true;
          prompt = "Continue the active Statewright workflow in its current state. Use statewright_get_state first.";
          signalChild(child, "SIGINT");
          setTimeout(() => signalChild(child, "SIGTERM"), 1500).unref();
          setTimeout(() => signalChild(child, "SIGKILL"), 3000).unref();
          if (request.restore_original === true) workflowOrigin = null;
          break;
        }
        await delay(100);
      }
      const result = await exit;
      if (!restartRequested) return result.code ?? 1;
    }
  } finally {
    await rm(controlDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log(usage()); process.exit(0); }
    process.exitCode = await run(options);
  } catch (error) {
    console.error(`[statewright] ${error.message}`);
    console.error(usage());
    process.exitCode = 2;
  }
}
