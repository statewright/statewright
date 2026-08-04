import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindManagedClientIdentity, resolveManagedClientIdentity } from "../lib/managed-client-identity.mjs";
import { bootstrapManagedClients, buildRoutedArgs, managedClientEnabled, runManagedClient, setManagedClientEnabled, uninstallManagedClients } from "../lib/managed-client-supervisor.mjs";

function fakeBridgeFactory() {
  return {
    url: "http://127.0.0.1:9999",
    token: "test-bridge-token",
    async start() { return this; },
    async close() {},
  };
}

test("managed identity persists a fresh session for a later Codex resume", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-managed-identity-"));
  try {
    const fresh = await resolveManagedClientIdentity({ host: "codex", args: [], home });
    assert.match(fresh.clientId, /^swc_[a-f0-9]{32}$/);
    await bindManagedClientIdentity({ host: "codex", sessionId: "durable-thread", clientId: fresh.clientId, home });
    const resumed = await resolveManagedClientIdentity({ host: "codex", args: ["resume", "durable-thread"], home });
    assert.equal(resumed.clientId, fresh.clientId);
    assert.equal(resumed.restored, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Codex restart preserves non-route args and applies the requested route", () => {
  assert.deepEqual(buildRoutedArgs({ host: "codex", originalArgs: ["--full-auto", "-m", "gpt-5.6-terra", "-c", 'model_reasoning_effort="low"'], request: { session_id: "session-1", model: "openai-codex/gpt-5.6-sol", effort: "high" } }), ["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="high"', "--full-auto", "resume", "session-1", "Continue the active Statewright workflow in its current state. Use statewright_get_state first."]);
});

test("Codex restart replaces an existing resume invocation", () => {
  const args = buildRoutedArgs({
    host: "codex",
    originalArgs: ["--full-auto", "resume", "old-session", "continue from yesterday"],
    request: { session_id: "new-session", model: "openai-codex/gpt-5.6-terra", effort: "medium" },
  });
  assert.deepEqual(args, [
    "-m", "gpt-5.6-terra", "-c", 'model_reasoning_effort="medium"', "--full-auto",
    "resume", "new-session", "Continue the active Statewright workflow in its current state. Use statewright_get_state first.",
  ]);
});

test("Claude restart forks history because plain resume preserves its old model", () => {
  const args = buildRoutedArgs({ host: "claude", originalArgs: ["--permission-mode", "auto", "--model", "sonnet"], request: { session_id: "session-2", model: "anthropic/claude-opus-4-6", effort: "high" } });
  assert.deepEqual(args.slice(0, 8), ["--permission-mode", "auto", "--resume", "session-2", "--fork-session", "--model", "claude-opus-4-6", "Continue the active Statewright workflow in its current state. Use statewright_get_state first."]);
  assert.ok(!args.includes("--effort"));
});

test("managed supervisor consumes Claude route requests and restarts the same child only", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-claude-"));
  const fake = join(root, "fake-claude.mjs");
  const calls = join(root, "calls.log");
  try {
    await writeFile(fake, `#!/usr/bin/env node\nimport { appendFileSync, existsSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");\nconst marker = join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "once");\nif (!existsSync(marker)) { writeFileSync(marker, ""); writeFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "claude.route.json"), JSON.stringify({session_id:"claude-session-3",client_id:process.env.STATEWRIGHT_CLIENT_ID,model:"anthropic/claude-opus-4-6",effort:"high"})); process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1000); }\n`);
    await chmod(fake, 0o755);
    assert.equal(await runManagedClient({
      host: "claude", command: fake, args: ["--permission-mode", "auto"], environment: { PATH: process.env.PATH, STATEWRIGHT_API_KEY: "test" }, home: root, pollMs: 5, bridgeFactory: fakeBridgeFactory,
    }), 0);
    const callsText = await readFile(calls, "utf8");
    assert.match(callsText, /^--permission-mode auto/m);
    assert.match(callsText, /--permission-mode auto --resume claude-session-3 --fork-session --model claude-opus-4-6/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed supervisor only restarts its own child after a route request", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-client-"));
  const fake = join(root, "fake-codex.mjs");
  const calls = join(root, "calls.log");
  try {
    await writeFile(fake, `#!/usr/bin/env node\nimport { appendFileSync, existsSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + " " + process.env.STATEWRIGHT_MANAGED_MCP_URL + "\\n");\nconst marker = join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "once");\nif (!existsSync(marker)) { writeFileSync(marker, ""); writeFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "route.json"), JSON.stringify({session_id:"session-3",client_id:process.env.STATEWRIGHT_CLIENT_ID,model:"openai-codex/gpt-5.6-sol",effort:"high"})); process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1000); }\n`);
    await chmod(fake, 0o755);
    assert.equal(await runManagedClient({ host: "codex", command: fake, args: ["--full-auto"], environment: { PATH: process.env.PATH, STATEWRIGHT_API_KEY: "test" }, home: root, pollMs: 5, bridgeFactory: fakeBridgeFactory }), 0);
    const callsText = await readFile(calls, "utf8");
    assert.match(callsText, /^--full-auto/m);
    assert.match(callsText, /-m gpt-5\.6-sol -c model_reasoning_effort="high" --full-auto resume session-3/);
    assert.match(callsText, /http:\/\/127\.0\.0\.1:9999/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed supervisor preserves its own identity across a routed restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-client-identity-"));
  const fake = join(root, "fake-codex.mjs");
  const calls = join(root, "calls.log");
  try {
    await writeFile(fake, `#!/usr/bin/env node\nimport { appendFileSync, existsSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nappendFileSync(${JSON.stringify(calls)}, process.env.STATEWRIGHT_CLIENT_ID + "\\n");\nconst marker = join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "once");\nif (!existsSync(marker)) { writeFileSync(marker, ""); writeFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "route.json"), JSON.stringify({session_id:"session-4",client_id:process.env.STATEWRIGHT_CLIENT_ID,model:"openai-codex/gpt-5.6-sol",effort:"high"})); process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1000); }\n`);
    await chmod(fake, 0o755);
    assert.equal(await runManagedClient({
      host: "codex", command: fake, args: [], environment: { PATH: process.env.PATH, STATEWRIGHT_API_KEY: "test" }, home: root, pollMs: 5, bridgeFactory: fakeBridgeFactory,
    }), 0);
    const identities = (await readFile(calls, "utf8")).trim().split("\n");
    assert.equal(identities.length, 2);
    assert.equal(identities[0], identities[1]);
    assert.match(identities[0], /^swc_[a-f0-9]{32}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed supervisor rejects a route that attempts to rebind its identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-client-mismatch-"));
  const fake = join(root, "fake-codex.mjs");
  const calls = join(root, "calls.log");
  try {
    await writeFile(fake, `#!/usr/bin/env node\nimport { appendFileSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nappendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");\nwriteFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "mismatch.route.json"), JSON.stringify({session_id:"session-5",client_id:"swc_ffffffffffffffffffffffffffffffff",model:"openai-codex/gpt-5.6-sol",effort:"high"}));\nsetTimeout(() => process.exit(0), 80);\n`);
    await chmod(fake, 0o755);
    assert.equal(await runManagedClient({
      host: "codex", command: fake, args: [], environment: { PATH: process.env.PATH, STATEWRIGHT_API_KEY: "test" }, home: root, pollMs: 5, bridgeFactory: fakeBridgeFactory,
    }), 0);
    assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent managed supervisors allocate isolated bridge identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-client-isolation-"));
  const fake = join(root, "fake-codex.mjs");
  const bridgeOptions = [];
  let bridgeNumber = 0;
  const recordingFactory = (options) => {
    bridgeOptions.push(options);
    bridgeNumber += 1;
    return {
      url: `http://127.0.0.1:${9000 + bridgeNumber}`,
      token: `token-${bridgeNumber}`,
      async start() { return this; },
      async close() {},
    };
  };
  try {
    await writeFile(fake, "#!/usr/bin/env node\nprocess.exit(0)\n");
    await chmod(fake, 0o755);
    await Promise.all(["first", "second"].map((name) => runManagedClient({
      host: "codex", command: fake, args: [name], environment: { PATH: process.env.PATH, STATEWRIGHT_API_KEY: "test" }, home: root, pollMs: 5, bridgeFactory: recordingFactory,
    })));
    assert.equal(bridgeOptions.length, 2);
    assert.notEqual(bridgeOptions[0].clientId, bridgeOptions[1].clientId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed clients are explicitly opt-in", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-managed-config-"));
  try {
    assert.equal(await managedClientEnabled("codex", home), false);
    await setManagedClientEnabled("codex", true, home);
    assert.equal(await managedClientEnabled("codex", home), true);
    assert.equal(await managedClientEnabled("claude", home), false);
    await setManagedClientEnabled("claude", true, home);
    assert.equal(await managedClientEnabled("codex", home), true);
    assert.equal(await managedClientEnabled("claude", home), true);
    await setManagedClientEnabled("codex", false, home);
    assert.equal(await managedClientEnabled("codex", home), false);
    assert.equal(await managedClientEnabled("claude", home), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("plugin bootstrap installs available shims and one marked shell path block", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-managed-bootstrap-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const launcher = join(root, "launcher.mjs");
  try {
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "codex"), "#!/usr/bin/env sh\nexit 0\n");
    await chmod(join(bin, "codex"), 0o755);
    await writeFile(launcher, "");
    const first = await bootstrapManagedClients({ launcherPath: launcher, home, path: bin, shell: "/bin/zsh" });
    assert.equal(first.installed.length, 1);
    assert.equal(await managedClientEnabled("codex", home), true);
    assert.equal(await managedClientEnabled("claude", home), false);
    const profile = await readFile(join(home, ".zshrc"), "utf8");
    assert.equal((profile.match(/statewright managed clients/g) ?? []).length, 2);
    const second = await bootstrapManagedClients({ launcherPath: launcher, home, path: bin, shell: "/bin/zsh" });
    assert.equal(second.profile, null);
    const removed = await uninstallManagedClients({ home, shell: "/bin/zsh" });
    assert.equal(removed.removed.length, 1);
    assert.equal(removed.profile, join(home, ".zshrc"));
    assert.doesNotMatch(await readFile(join(home, ".zshrc"), "utf8"), /statewright managed clients/);
    assert.equal(await managedClientEnabled("codex", home), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
