// The managed-client passthrough launch and the headless statewright-codex
// orchestrator must both put Statewright's shell_environment_policy override
// on Codex's argv (Dalton post-merge review P6). A fake Codex records argv
// only; every credential here is obviously fake.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PLUGINS = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FAKE_KEY = "FAKE-launch-policy-key";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sw-codex-policy-args-"));
  const home = join(root, "home");
  await mkdir(join(home, ".codex"), { recursive: true });
  const fake = join(root, "fake-codex.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(root, "argv.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(0);
`);
  await chmod(fake, 0o755);
  const run = args => new Promise(resolveRun => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR ?? "/tmp", CODEX_HOME: join(home, ".codex"),
        STATEWRIGHT_API_KEY: FAKE_KEY, STATEWRIGHT_GATEWAY_URL: "http://127.0.0.1:9", STATEWRIGHT_SENTRY_DISABLED: "1" },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("exit", () => { clearTimeout(timer); resolveRun(); });
  });
  const launches = async () => (await readFile(join(root, "argv.log"), "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { root, fake, run, launches, close: () => rm(root, { recursive: true, force: true }) };
}

function assertPolicyArgs(argv, label) {
  const at = argv.findIndex((arg, index) => arg === "-c" && /^shell_environment_policy[.=]/.test(argv[index + 1] ?? ""));
  assert.ok(at >= 0, `${label}: Codex argv must carry the shell_environment_policy override (${JSON.stringify(argv.slice(0, 6))})`);
  const policy = argv[at + 1];
  for (const pattern of ["STATEWRIGHT_*API_KEY*", "STATEWRIGHT_*_TOKEN", "*_TOKEN", "*_KEY"]) {
    assert.ok(policy.includes(JSON.stringify(pattern)), `${label}: policy must exclude ${pattern}`);
  }
  assert.ok(!argv.some(arg => arg.includes(FAKE_KEY)), `${label}: no credential value on argv`);
}

// The Claude Code bundle's copy (claude-code/executor) only launches Claude and
// lacks the Codex guidance module, so it is not a Codex launch path.
const launchers = ["executor/statewright-managed-client.mjs", "codex/scripts/statewright-managed-client.mjs"];
if (process.platform !== "win32") for (const launcher of launchers) test(`unmanaged passthrough Codex launch carries the shell policy (${launcher})`, async () => {
  const f = await fixture();
  try {
    await f.run([join(PLUGINS, launcher), "--host", "codex", "--real-bin", f.fake, "--", "exec", "fixture task"]);
    const launch = (await f.launches()).find(argv => argv.includes("exec"));
    assert.ok(launch, "the passthrough launch must reach Codex");
    assertPolicyArgs(launch, launcher);
    assert.deepEqual(launch.slice(-2), ["exec", "fixture task"], "the user's own args follow the policy");
  } finally { await f.close(); }
});

if (process.platform !== "win32") test("headless statewright-codex App Server launch carries the shell policy", async () => {
  const f = await fixture();
  try {
    await f.run([join(PLUGINS, "codex/scripts/statewright-codex.mjs"), "--workflow", "plan", "--codex-bin", f.fake, "--", "fixture task"]);
    const launch = (await f.launches()).find(argv => argv[0] === "app-server");
    assert.ok(launch, "the orchestrator must launch the Codex App Server");
    assertPolicyArgs(launch, "statewright-codex");
  } finally { await f.close(); }
});
