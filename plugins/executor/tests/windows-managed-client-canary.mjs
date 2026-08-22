import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("The Windows managed-client canary must run on a Windows runner.");
}

const launcher = new URL("../statewright-managed-client.mjs", import.meta.url);

function runNode(args, environment) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, args, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectResult);
    child.once("exit", (code) => resolveResult({ code, stdout, stderr }));
  });
}

const root = await mkdtemp(join(tmpdir(), "statewright-windows-managed-client-"));
const home = join(root, "home");
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  HOMEDRIVE: home.slice(0, 2),
  HOMEPATH: home.slice(2),
};

try {
  const result = await runNode([fileURLToPath(launcher), "--bootstrap"], environment);
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

  const shellInit = await runNode([fileURLToPath(launcher), "--shell-init"], environment);
  assert.equal(shellInit.code, 0, shellInit.stderr);
  assert.match(shellInit.stdout, /\$env:Path.*\.statewright\\bin/i);

  const uninstall = await runNode([fileURLToPath(launcher), "--uninstall"], environment);
  assert.equal(uninstall.code, 0, uninstall.stderr);
  const removed = JSON.parse(uninstall.stdout);
  assert.equal(removed.removed.length, 2, "uninstall must remove both managed Windows shims");
  console.log("Windows managed-client bootstrap canary passed for Codex and Claude.");
} finally {
  await rm(root, { recursive: true, force: true });
}
