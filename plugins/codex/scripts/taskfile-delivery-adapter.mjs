#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SAFE_ACTION = /^[a-z][a-z-]{0,63}$/;
const SAFE_TASK = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseArgs(argv) {
  const action = argv[0];
  if (!SAFE_ACTION.test(action ?? "")) {
    throw new Error("a safe delivery action is required.");
  }
  const manifestIndex = argv.indexOf("--manifest");
  if (manifestIndex === -1 || !argv[manifestIndex + 1]) {
    throw new Error("--manifest PATH is required.");
  }
  if (process.env.STATEWRIGHT_DELIVERY_ACTION !== action) {
    throw new Error("delivery action argument does not match the trusted environment.");
  }
  return { action, manifestPath: resolve(argv[manifestIndex + 1]) };
}

async function resolveTaskfile(root, configuredPath) {
  if (isAbsolute(configuredPath) || configuredPath.split(/[\\/]/).includes("..")) {
    throw new Error("STATEWRIGHT_DELIVERY_TASKFILE must stay inside the hook bundle.");
  }
  const canonicalRoot = await realpath(root);
  const taskfile = resolve(canonicalRoot, configuredPath);
  if (!taskfile.startsWith(`${canonicalRoot}/`)) {
    throw new Error("delivery taskfile escapes the trusted hook bundle.");
  }
  const info = await lstat(taskfile);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("delivery taskfile must be a regular file.");
  }
  return { canonicalRoot, taskfile };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseHookResult(stdout) {
  const last = stdout.trim().split("\n").at(-1);
  if (!last) return null;
  try {
    const value = JSON.parse(last);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function runTask(taskfile, task, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "task",
      ["--silent", "--taskfile", taskfile, task],
      {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
      else child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(chunk);
      else child.kill("SIGTERM");
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (
        code === 0
        && stdoutBytes <= MAX_OUTPUT_BYTES
        && stderrBytes <= MAX_OUTPUT_BYTES
      ) {
        resolvePromise({
          stdout: output,
          stderr: errorOutput,
          stdoutBytes,
          stderrBytes,
        });
        return;
      }
      const reason = stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES
        ? "exceeded the output limit"
        : `exited ${code ?? signal}`;
      const detail = (errorOutput || output).trim().slice(-2000);
      reject(new Error(`task '${task}' ${reason}${detail ? `: ${detail}` : ""}`));
    });
  });
}

export async function execute(argv = process.argv.slice(2)) {
  const { action, manifestPath } = parseArgs(argv);
  const hookRoot = requiredEnvironment("STATEWRIGHT_DELIVERY_HOOK_ROOT");
  const configuredTaskfile = requiredEnvironment("STATEWRIGHT_DELIVERY_TASKFILE");
  const task = requiredEnvironment("STATEWRIGHT_DELIVERY_TASK");
  if (!SAFE_TASK.test(task)) {
    throw new Error("STATEWRIGHT_DELIVERY_TASK must be a safe Taskfile task name.");
  }
  if (resolve(requiredEnvironment("STATEWRIGHT_DELIVERY_MANIFEST")) !== manifestPath) {
    throw new Error("delivery manifest argument does not match the trusted environment.");
  }
  const { canonicalRoot, taskfile } = await resolveTaskfile(
    hookRoot,
    configuredTaskfile,
  );
  const startedAt = new Date().toISOString();
  const result = await runTask(taskfile, task, {
    cwd: canonicalRoot,
    env: process.env,
  });
  const hookResult = parseHookResult(result.stdout);
  if (hookResult?.ok === false) {
    throw new Error(`task '${task}' returned ok=false.`);
  }
  if (hookResult?.action && hookResult.action !== action) {
    throw new Error(
      `task '${task}' returned action '${hookResult.action}', expected '${action}'.`,
    );
  }
  return {
    ok: true,
    action,
    task,
    taskfile: configuredTaskfile,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    stdout_bytes: result.stdoutBytes,
    stderr_bytes: result.stderrBytes,
    stdout_sha256: digest(result.stdout),
    stderr_sha256: digest(result.stderr),
    hook_result: hookResult,
  };
}

function isMain() {
  try {
    return Boolean(
      process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url),
    );
  } catch {
    return false;
  }
}

if (isMain()) {
  execute().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`[statewright-taskfile-delivery] ${error.message}\n`);
      process.exitCode = 1;
    },
  );
}

export { MAX_OUTPUT_BYTES, parseArgs, parseHookResult, resolveTaskfile, runTask };
