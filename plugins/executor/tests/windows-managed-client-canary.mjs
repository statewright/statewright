import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("The Windows managed-client canary must run on a Windows runner.");
}

const launcher = new URL("../statewright-managed-client.mjs", import.meta.url);
const cleanupTimeoutMs = 5_000;
const cleanupCloseGraceMs = 1_000;
const childCloseGraceMs = 2_000;

function parseCommandTimeout(rawValue) {
  const value = rawValue ?? "30000";
  if (!/^\d+$/.test(value)) {
    throw new Error("STATEWRIGHT_WINDOWS_CANARY_COMMAND_TIMEOUT_MS must be a complete decimal integer.");
  }
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1_000 || milliseconds > 60_000) {
    throw new Error("STATEWRIGHT_WINDOWS_CANARY_COMMAND_TIMEOUT_MS must be between 1000 and 60000.");
  }
  return milliseconds;
}

const commandTimeoutMs = parseCommandTimeout(process.env.STATEWRIGHT_WINDOWS_CANARY_COMMAND_TIMEOUT_MS);

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function terminateProcessTree(child, environment) {
  return new Promise((resolveResult) => {
    if (!child.pid) {
      resolveResult({ status: "missing_pid" });
      return;
    }
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      env: sanitizedRuntimeEnvironment(environment),
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const killerClosed = new Promise((resolveClosed) => {
      killer.once("close", (code, signal) => resolveClosed({ code, signal }));
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const timer = setTimeout(async () => {
      try { killer.kill(); } catch { /* cleanup process already exited */ }
      const killerClosedInTime = await Promise.race([
        killerClosed.then(() => true),
        delay(cleanupCloseGraceMs).then(() => false),
      ]);
      if (!killerClosedInTime) killer.unref();
      finish({ status: "timeout", killerClosedInTime });
    }, cleanupTimeoutMs);
    killer.once("error", (error) => {
      finish({ status: "spawn_error", errorCode: error?.code ?? "unknown" });
    });
    killer.once("close", (code, signal) => {
      finish({ status: code === 0 ? "success" : "nonzero", code, signal });
    });
  });
}

function runProcess(command, args, environment, label) {
  const startedAt = Date.now();
  console.log(`[windows-canary] START ${label}`);
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, args, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer = null;
    const childClosed = new Promise((resolveClosed) => {
      child.once("close", (code, signal) => resolveClosed({ code, signal }));
    });
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      if (!timedOut) finish(() => rejectResult(error));
    });
    child.once("close", (code, signal) => {
      if (timedOut) return;
      finish(() => {
        console.log(`[windows-canary] END ${label} code=${code ?? "null"} signal=${signal ?? "none"} duration_ms=${Date.now() - startedAt}`);
        resolveResult({ code, signal, stdout, stderr });
      });
    });
    timer = setTimeout(async () => {
      timedOut = true;
      const cleanup = await terminateProcessTree(child, environment);
      let childClosedInTime = await Promise.race([
        childClosed.then(() => true),
        delay(childCloseGraceMs).then(() => false),
      ]);
      if (!childClosedInTime) {
        try { child.kill(); } catch { /* process already exited */ }
        childClosedInTime = await Promise.race([
          childClosed.then(() => true),
          delay(1_000).then(() => false),
        ]);
      }
      if (!childClosedInTime) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      const cleanupCode = cleanup.code == null ? "none" : cleanup.code;
      finish(() => rejectResult(new Error(
        `${label} timed out after ${commandTimeoutMs}ms; process_tree_cleanup=${cleanup.status}; cleanup_code=${cleanupCode}; child_closed=${childClosedInTime}.`,
      )));
    }, commandTimeoutMs);
  });
}

function runNode(args, environment, label) {
  return runProcess(process.execPath, args, environment, label);
}

function runPowerShell(script, environment, label) {
  return runProcess("pwsh.exe", ["-NoLogo", "-NonInteractive", "-Command", script], environment, label);
}

function runCmd(command, environment, label) {
  return runProcess("cmd.exe", ["/d", "/s", "/c", command], environment, label);
}

function withWindowsPath(environment, entries) {
  const next = Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== "path"));
  return { ...next, Path: entries.filter(Boolean).join(";") };
}

const allowedRuntimeEnvironment = new Set([
  "appdata",
  "ci",
  "comspec",
  "github_actions",
  "localappdata",
  "number_of_processors",
  "os",
  "path",
  "pathext",
  "processor_architecture",
  "processor_identifier",
  "programfiles",
  "programfiles(x86)",
  "programw6432",
  "psmodulepath",
  "systemroot",
  "temp",
  "tmp",
  "windir",
]);

function sanitizedRuntimeEnvironment(source) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => allowedRuntimeEnvironment.has(key.toLowerCase())),
  );
}

async function cmdSource(host, environment) {
  const result = await runCmd(`where ${host}`, environment, `resolve ${host} from cmd.exe`);
  assert.equal(result.code, 0, `cmd.exe could not resolve ${host}: ${result.stderr || result.stdout}`);
  const source = result.stdout.split(/\r?\n/).find(Boolean);
  assert.ok(source, `cmd.exe did not report a source for ${host}`);
  return source.trim();
}

async function cmdVersion(host, environment) {
  const result = await runCmd(`${host} --version`, environment, `run ${host} --version from cmd.exe`);
  assert.equal(result.code, 0, `${host} --version from cmd.exe failed: ${result.stderr || result.stdout}`);
  assert.notEqual(result.stdout.trim(), "", `${host} --version from cmd.exe emitted no version output`);
}

async function shellVersion(host, environment) {
  const result = await runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    `$command = @(Get-Command ${host} -CommandType Application -ErrorAction Stop)[0]`,
    "& $command.Source --version",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    '[Console]::WriteLine("STATEWRIGHT_SOURCE=" + $command.Source)',
  ].join("; "), environment, `run ${host} --version from PowerShell`);
  assert.equal(result.code, 0, `${host} --version from a fresh PowerShell session failed: ${result.stderr || result.stdout}`);
  const match = result.stdout.match(/^STATEWRIGHT_SOURCE=(.+)$/m);
  assert.ok(match, `${host} PowerShell probe did not report its resolved command source: ${result.stdout}`);
  return match[1].trim();
}

const root = await mkdtemp(join(tmpdir(), "statewright-windows-managed-client-"));
const home = join(root, "home");
const environment = {
  ...sanitizedRuntimeEnvironment(process.env),
  HOME: home,
  USERPROFILE: home,
  HOMEDRIVE: home.slice(0, 2),
  HOMEPATH: home.slice(2),
  STATEWRIGHT_API_KEY: "windows-canary",
  STATEWRIGHT_NO_UPDATE_CHECK: "1",
  STATEWRIGHT_SENTRY_DISABLED: "true",
};
const nativePath = Object.entries(environment).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
const managedPath = withWindowsPath(environment, [join(home, ".statewright", "bin"), nativePath]);

try {
  const result = await runNode([fileURLToPath(launcher), "--bootstrap"], environment, "bootstrap managed shims");
  assert.equal(result.code, 0, result.stderr);
  assert.notEqual(
    result.stdout.trim(),
    "",
    "managed-client CLI emitted no bootstrap result on Windows; its module entrypoint guard did not invoke main()",
  );

  const bootstrap = JSON.parse(result.stdout);
  assert.equal(bootstrap.installed.length, 2, "bootstrap must discover the installed codex.cmd and claude.cmd launchers");
  assert.equal(bootstrap.restart_required, true, "bootstrap must persist a Windows shell PATH change");

  for (const host of ["codex", "claude"]) {
    const installed = bootstrap.installed.find((entry) => entry.realBinary.toLowerCase().endsWith(`${host}.cmd`));
    assert.ok(installed, `${host}.cmd must be the real executable selected by the Windows bootstrap`);
    assert.equal(win32.basename(installed.shimPath).toLowerCase(), `${host}.cmd`);
    const shim = await readFile(installed.shimPath, "utf8");
    assert.match(shim, /statewright-managed-client\.mjs/i);
  }

  const config = JSON.parse(await readFile(join(home, ".statewright", "config.json"), "utf8"));
  assert.deepEqual(config.routing.managed_clients.hosts, { codex: true, claude: true });

  for (const host of ["codex", "claude"]) {
    const installed = bootstrap.installed.find((entry) => entry.realBinary.toLowerCase().endsWith(`${host}.cmd`));
    const managedVersion = await runNode([
      fileURLToPath(launcher),
      "--host", host,
      "--real-bin", installed.realBinary,
      "--",
      "--version",
    ], environment, `run managed ${host}.cmd --version`);
    assert.equal(
      managedVersion.code,
      0,
      `managed ${host}.cmd --version failed: ${managedVersion.stderr || managedVersion.stdout}`,
    );
    assert.notEqual(managedVersion.stdout.trim(), "", `managed ${host}.cmd --version emitted no version output`);

    const source = await shellVersion(host, environment);
    assert.equal(win32.basename(source).toLowerCase(), `${host}.cmd`);
    assert.match(source.toLowerCase(), /[\\/]\.statewright[\\/]bin[\\/]/i, "PowerShell must resolve the managed shim directory");

    const cmdResolvedSource = await cmdSource(host, managedPath);
    assert.equal(win32.basename(cmdResolvedSource).toLowerCase(), `${host}.cmd`);
    assert.match(cmdResolvedSource.toLowerCase(), /[\\/]\.statewright[\\/]bin[\\/]/i, "cmd.exe must resolve the managed shim directory");
    await cmdVersion(host, managedPath);
  }

  const shellInit = await runNode([fileURLToPath(launcher), "--shell-init"], environment, "render PowerShell shell-init");
  assert.equal(shellInit.code, 0, shellInit.stderr);
  assert.match(shellInit.stdout, /\$env:Path.*\.statewright\\bin/i);

  const uninstall = await runNode([fileURLToPath(launcher), "--uninstall"], environment, "uninstall managed shims");
  assert.equal(uninstall.code, 0, uninstall.stderr);
  const removed = JSON.parse(uninstall.stdout);
  const expectedRemoved = ["codex.cmd", "claude.cmd", "statewright-git-closeout.cmd"]
    .map((name) => join(home, ".statewright", "bin", name));
  assert.deepEqual(
    [...removed.removed].sort(), expectedRemoved.sort(),
    "uninstall must remove both managed Windows shims and the Git closeout helper",
  );
  for (const path of expectedRemoved) {
    await assert.rejects(access(path), { code: "ENOENT" }, `uninstall left ${path} on disk`);
  }
  for (const host of ["codex", "claude"]) {
    const source = await shellVersion(host, environment);
    assert.doesNotMatch(
      source.toLowerCase(),
      /[\\/]\.statewright[\\/]bin[\\/]/i,
      "PowerShell must stop resolving the managed shim directory after uninstall",
    );
    assert.doesNotMatch(
      (await cmdSource(host, managedPath)).toLowerCase(),
      /[\\/]\.statewright[\\/]bin[\\/]/i,
      "cmd.exe must stop resolving the managed shim directory after uninstall",
    );
  }
  console.log("Windows managed-client bootstrap canary passed for Codex and Claude.");
} finally {
  await rm(root, { recursive: true, force: true });
}
