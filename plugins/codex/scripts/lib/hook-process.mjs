import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TERMINATION_GRACE_MS = 10_000;

function terminateTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export function hookEnvironment(session, extra = {}) {
  const env = {};
  for (const name of session.config.hooks.environmentAllowlist) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return {
    ...env,
    STATEWRIGHT_DELIVERY_MANIFEST: session.manifestPath,
    STATEWRIGHT_DELIVERY_RUN_ID: session.manifest.run_id,
    STATEWRIGHT_DELIVERY_PRIMARY_WORKTREE: session.primaryCwd,
    STATEWRIGHT_DELIVERY_EVIDENCE_PATH: session.manifest.evidence_path,
    STATEWRIGHT_DELIVERY_HOOK_ROOT: session.manifest.hook_bundle_path,
    STATEWRIGHT_DELIVERY_TASKFILE: session.config.hooks.taskfile,
    ...extra,
  };
}

export function runHookProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let forceTimer = null;
    const requestTermination = () => {
      if (!child.pid) return;
      terminateTree(child, "SIGTERM");
      forceTimer ??= setTimeout(
        () => terminateTree(child, "SIGKILL"),
        TERMINATION_GRACE_MS,
      );
      forceTimer.unref();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateTree(child, "SIGTERM");
      reject(error);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
      else requestTermination();
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(chunk);
      else requestTermination();
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (
        code === 0
        && !timedOut
        && stdoutBytes <= MAX_OUTPUT_BYTES
        && stderrBytes <= MAX_OUTPUT_BYTES
      ) {
        resolve({ stdout: output, stderr: errorOutput });
        return;
      }
      const reason = timedOut
        ? `timed out after ${options.timeoutMs}ms`
        : stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES
          ? "exceeded the output limit"
          : `exited ${code ?? signal}`;
      reject(new Error(`${command} ${reason}: ${errorOutput.trim().slice(0, 1000)}`));
    });
  });
}

export { MAX_OUTPUT_BYTES, TERMINATION_GRACE_MS };
