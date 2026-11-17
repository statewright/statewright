// The managed-client passthrough launch and the headless statewright-codex
// orchestrator must both put Statewright's shell_environment_policy override
// on Codex's argv (Dalton post-merge review P6). A fake Codex records argv
// only; every credential here is obviously fake.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PLUGINS = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Fake credentials, random per run so no window of one can collide with an
// ordinary argument. Every credential a managed launch can hold is seeded.
const fake = label => `FAKE${label}${randomBytes(18).toString("hex")}`;
const SECRETS = { STATEWRIGHT_API_KEY: fake("key"), STATEWRIGHT_MANAGED_MCP_TOKEN: fake("managed"),
  STATEWRIGHT_REFRESH_TOKEN: fake("refresh"), GH_TOKEN: fake("gh") };

// Windows of each value and of its base64/base64url/hex encodings, so an
// encoded or split credential on argv is still found.
function leakWindows(value) {
  const windows = [];
  const slide = (text, size) => { for (let i = 0; i + size <= text.length; i++) windows.push(text.slice(i, i + size)); };
  slide(value, 8);
  for (let offset = 0; offset < 3; offset++) {
    const tail = Buffer.from(value.slice(offset));
    slide(tail.toString("base64").replace(/=+$/, "").slice(0, -2), 12);
    slide(tail.toString("base64url").slice(0, -2), 12);
  }
  slide(Buffer.from(value).toString("hex"), 16);
  return windows;
}

function assertNoCredential(argv, label) {
  const joined = [argv.join(""), argv.join(" "), argv.join("\n")].join("\u0000");
  for (const [name, value] of Object.entries(SECRETS)) {
    const leaked = leakWindows(value).find(window => joined.includes(window) || joined.toLowerCase().includes(window.toLowerCase()) && /^[0-9a-f]+$/.test(window));
    assert.equal(leaked, undefined, `${label}: ${name} (or an encoding or piece of it) must not reach argv`);
  }
}

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
        ...SECRETS, STATEWRIGHT_GATEWAY_URL: "http://127.0.0.1:9", STATEWRIGHT_SENTRY_DISABLED: "1" },
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
  assertNoCredential(argv, label);
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
