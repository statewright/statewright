import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { desktopDoctor, disableDesktop, enableDesktop, launchDesktop, provisionDesktop, withDesktopLock } from "../scripts/statewright-desktop-setup.mjs";

const execFile = promisify(execFileCallback);
async function executable(path) { await writeFile(path, "#!/bin/sh\nexit 0\n"); await chmod(path, 0o700); }
async function moduleFile(path) { await writeFile(path, "export {};\n"); }
function launchctlHarness(initialValue = null) {
  let value = initialValue;
  const calls = [];
  const paths = [];
  return { calls, paths, get value() { return value; }, async exec(path, args) { paths.push(path); calls.push(args); if (args[0] === "getenv") return { stdout: value == null ? "" : `${value}\n`, stderr: "" }; if (args[0] === "setenv") { value = args[2]; return { stdout: "", stderr: "" }; } if (args[0] === "unsetenv") { value = null; return { stdout: "", stderr: "" }; } throw new Error(`unexpected launchctl args: ${args.join(" ")}`); } };
}
async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const state = join(root, "state", "desktop.json");
  const vendor = join(root, "vendor-codex");
  const app = join(root, "ChatGPT");
  const applications = join(root, "Applications");
  const wrapper = join(root, "plugin-wrapper.mjs");
  const desktopRuntime = join(root, "lib", "desktop-runtime", "codex-desktop-app-server-launcher.mjs");
  await mkdir(dirname(desktopRuntime), { recursive: true });
  await mkdir(dirname(state), { recursive: true });
  await Promise.all([
    executable(vendor),
    executable(app),
    moduleFile(wrapper),
    writeFile(join(dirname(state), "api_key"), "test-production-key\n", { mode: 0o600 }),
    writeFile(join(dirname(state), "staging_api_key"), "test-staging-key\n", { mode: 0o600 }),
    writeFile(join(dirname(state), "dev_api_key"), "test-development-key\n", { mode: 0o600 }),
    writeFile(desktopRuntime, `export async function startDesktopMcpBridge({ environment }) { return { url: "http://127.0.0.1:43123", token: \`${"${environment.STATEWRIGHT_GATEWAY_URL}"}|${"${environment.STATEWRIGHT_API_KEY}"}\`, close: async () => {} }; }\n`),
  ]);
  return { root, state, vendor, app, applications, wrapper };
}

test("Desktop setup CLI executes through an installed-plugin symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-desktop-symlink-entrypoint-"));
  const link = join(root, "statewright-desktop-setup.mjs");
  const state = join(root, "missing-state.json");
  try {
    await symlink(fileURLToPath(new URL("../scripts/statewright-desktop-setup.mjs", import.meta.url)), link);
    let failure;
    try { await execFile(process.execPath, [link, "doctor", "--state", state]); }
    catch (error) { failure = error; }
    assert.ok(failure, "doctor should execute and report an unconfigured state");
    assert.deepEqual(JSON.parse(failure.stdout), { ok: false, reason: "not_configured", state_path: state });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Desktop setup CLI forwards the explicit staging gateway", async () => {
  const { root, state, vendor, app, wrapper } = await fixture("statewright-desktop-staging-cli-");
  const script = fileURLToPath(new URL("../scripts/statewright-desktop-setup.mjs", import.meta.url));
  try {
    const { stdout } = await execFile(process.execPath, [
      script,
      "enable",
      "--state", state,
      "--profile", "staging",
      "--gateway-url", "https://staging.example.test",
      "--original", vendor,
      "--wrapper", wrapper,
      "--app", app,
    ], { env: { ...process.env, HOME: root } });
    const record = JSON.parse(stdout);
    assert.equal(record.gateway_url, "https://staging.example.test");
    assert.equal(record.profile, "staging");
    assert.equal(record.launcher_app_path, join(root, "Applications", "ChatGPT + Statewright Staging.app"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Desktop setup CLI accepts the development profile with an explicit gateway", async () => {
  const { root, state, vendor, app, wrapper } = await fixture("statewright-desktop-development-cli-");
  const script = fileURLToPath(new URL("../scripts/statewright-desktop-setup.mjs", import.meta.url));
  try {
    const { stdout } = await execFile(process.execPath, [
      script,
      "enable",
      "--state", state,
      "--profile", "development",
      "--gateway-url", "https://development.example.test",
      "--original", vendor,
      "--wrapper", wrapper,
      "--app", app,
    ], { env: { ...process.env, HOME: root } });
    const record = JSON.parse(stdout);
    assert.equal(record.gateway_url, "https://development.example.test");
    assert.equal(record.profile, "development");
    assert.equal(record.launcher_app_path, join(root, "Applications", "ChatGPT + Statewright Dev.app"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Desktop setup creates an explicit-launch shim without mutating launchd", async () => {
  const { root, state, vendor, app, applications, wrapper } = await fixture("statewright-desktop-setup-");
  const launchctl = launchctlHarness("/prior/codex");
  try {
    const record = await enableDesktop({ statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath, launchctlExecFile: launchctl.exec });
    assert.equal(record.version, 3);
    assert.equal(record.desktop_executable, app);
    assert.equal(record.profile, "production");
    assert.equal(record.gateway_url, "https://mcp.statewright.ai");
    assert.equal(record.api_key_path, join(dirname(state), "api_key"));
    assert.match(record.client_id, /^swc_[a-f0-9]{32}$/);
    assert.equal(launchctl.value, "/prior/codex");
    assert.equal(launchctl.calls.length, 0);
    assert.equal(record.launcher_app_path, join(applications, "ChatGPT + Statewright.app"));
    assert.match(await readFile(join(record.launcher_app_path, "Contents", "MacOS", "ChatGPT + Statewright"), "utf8"), /statewright-desktop-launch[.]mjs/);
    assert.match(await readFile(join(record.launcher_app_path, "Contents", "MacOS", "ChatGPT + Statewright"), "utf8"), new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(await readFile(join(record.launcher_app_path, "Contents", "MacOS", "ChatGPT + Statewright"), "utf8"), /\/usr\/bin\/env node/);
    assert.doesNotMatch(await readFile(join(record.launcher_app_path, "Contents", "MacOS", "ChatGPT + Statewright"), "utf8"), new RegExp(wrapper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(await readFile(record.shim_path, "utf8"), new RegExp(wrapper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal((await desktopDoctor({ statePath: state })).ok, true);
    const disabled = await disableDesktop({ statePath: state, launchctlExecFile: launchctl.exec });
    assert.equal(disabled.app_removed, true);
    assert.equal(disabled.launcher_removed, true);
    await assert.rejects(() => readFile(state, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(record.launcher_path, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(join(record.launcher_app_path, "Contents", "Info.plist"), "utf8"), { code: "ENOENT" });
    assert.equal((await provisionDesktop({ statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath })).skipped, "disabled");
    const reenabled = await enableDesktop({ statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath });
    assert.match(reenabled.client_id, /^swc_[a-f0-9]{32}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Concurrent automatic provisioning converges on one durable client identity", async () => {
  const { root, state, vendor, app, applications, wrapper } = await fixture("statewright-desktop-concurrent-");
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => provisionDesktop({ statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath })));
    assert.equal(new Set(results.map(result => result.client_id)).size, 1);
    const recorded = JSON.parse(await readFile(state, "utf8"));
    assert.equal(recorded.client_id, results[0].client_id);
    assert.equal((await desktopDoctor({ statePath: state })).ok, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Automatic provisioning follows a moved bundled Codex binary without changing client identity", async () => {
  const { root, state, app, applications, wrapper } = await fixture("statewright-desktop-vendor-move-");
  const oldVendor = join(root, "ChatGPT.app", "Contents", "Resources", "codex");
  const newVendor = join(root, "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex");
  try {
    await mkdir(dirname(oldVendor), { recursive: true });
    await executable(oldVendor);
    const original = await enableDesktop({ statePath: state, app, applicationsDirectory: applications, wrapper, node: process.execPath, vendorCandidates: [newVendor, oldVendor] });
    assert.equal(original.original_codex, oldVendor);

    await rm(oldVendor);
    await mkdir(dirname(newVendor), { recursive: true });
    await executable(newVendor);
    const migrated = await provisionDesktop({ statePath: state, app, applicationsDirectory: applications, wrapper, node: process.execPath, vendorCandidates: [newVendor, oldVendor] });

    assert.equal(migrated.original_codex, newVendor);
    assert.equal(migrated.client_id, original.client_id);
    assert.equal((await desktopDoctor({ statePath: state })).ok, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Automatic provisioning does not replace a missing custom Codex binary", async () => {
  const { root, state, vendor, app, applications, wrapper } = await fixture("statewright-desktop-custom-vendor-");
  const bundledVendor = join(root, "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex");
  try {
    const original = await enableDesktop({ statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath });
    await rm(vendor);
    await mkdir(dirname(bundledVendor), { recursive: true });
    await executable(bundledVendor);
    await assert.rejects(
      () => provisionDesktop({ statePath: state, app, applicationsDirectory: applications, wrapper, node: process.execPath, vendorCandidates: [bundledVendor] }),
      /different Statewright Desktop setup/,
    );
    assert.equal(JSON.parse(await readFile(state, "utf8")).client_id, original.client_id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("A later ticket cannot preempt an active ticket with a lexically earlier ID", async () => {
  const { root, state } = await fixture("statewright-desktop-bakery-lock-");
  let enterFirst;
  let releaseFirst;
  const firstEntered = new Promise(resolve => { enterFirst = resolve; });
  const firstReleased = new Promise(resolve => { releaseFirst = resolve; });
  let secondEntered = false;
  try {
    const first = withDesktopLock(state, async () => { enterFirst(); await firstReleased; }, { ticketName: "zzz-active" });
    await firstEntered;
    const second = withDesktopLock(state, async () => { secondEntered = true; }, { ticketName: "aaa-later" });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(secondEntered, false);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(secondEntered, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("A competing setup preserves a live ticket paused before owner publication", async () => {
  const { root, state } = await fixture("statewright-desktop-paused-publisher-");
  let publisherPaused;
  let releasePublisher;
  let releaseFirst;
  let releaseSecond;
  const paused = new Promise(resolve => { publisherPaused = resolve; });
  const publishGate = new Promise(resolve => { releasePublisher = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  let firstEntered = false;
  let secondEntered = false;
  try {
    const first = withDesktopLock(state, async () => { firstEntered = true; await firstGate; }, { ticketName: `${process.pid}-paused`, beforeOwnerPublish: async () => { publisherPaused(); await publishGate; } });
    await paused;
    const second = withDesktopLock(state, async () => { secondEntered = true; await secondGate; }, { ticketName: `${process.pid}-competitor` });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(secondEntered, false);
    releasePublisher();
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(secondEntered, true);
    assert.equal(firstEntered, false);
    releaseSecond();
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(firstEntered, true);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(secondEntered, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Independent setup processes converge after recovering a shared stale ticket", async () => {
  const { root, state, vendor, app, applications, wrapper } = await fixture("statewright-desktop-multiprocess-");
  const options = { statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath };
  const moduleUrl = new URL("../scripts/statewright-desktop-setup.mjs", import.meta.url).href;
  const worker = `import { provisionDesktop } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(await provisionDesktop(JSON.parse(process.env.STATEWRIGHT_TEST_OPTIONS))));`;
  const staleTicket = join(`${state}.lock`, "queue", "0000000000000000-dead-ticket");
  try {
    await mkdir(staleTicket, { recursive: true, mode: 0o700 });
    await writeFile(join(staleTicket, "owner.json"), `${JSON.stringify({ pid: 2147483647, created_at: "2000-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
    const runs = await Promise.all(Array.from({ length: 4 }, () => execFile(process.execPath, ["--input-type=module", "--eval", worker], { env: { ...process.env, STATEWRIGHT_TEST_OPTIONS: JSON.stringify(options) } })));
    const results = runs.map(({ stdout }) => JSON.parse(stdout));
    assert.equal(new Set(results.map(result => result.client_id)).size, 1);
    const recorded = JSON.parse(await readFile(state, "utf8"));
    assert.equal(recorded.client_id, results[0].client_id);
    assert.equal((await desktopDoctor({ statePath: state })).ok, true);
    await assert.rejects(() => readFile(join(staleTicket, "owner.json"), "utf8"), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Automatic provisioning reclaims a lock left by a dead setup process", async () => {
  const { root, state, vendor, app, applications, wrapper } = await fixture("statewright-desktop-stale-lock-");
  const ticket = join(`${state}.lock`, "queue", "0000000000000000-dead-ticket");
  try {
    await mkdir(ticket, { recursive: true, mode: 0o700 });
    await writeFile(join(ticket, "owner.json"), `${JSON.stringify({ pid: 2147483647, created_at: "2000-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
    const record = await provisionDesktop({ statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath });
    assert.match(record.client_id, /^swc_[a-f0-9]{32}$/);
    await assert.rejects(() => readFile(join(ticket, "owner.json"), "utf8"), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Automatic provisioning recovers an ownerless ticket left before ownership publication", async () => {
  const { root, state, vendor, app, applications, wrapper } = await fixture("statewright-desktop-ownerless-lock-");
  const ticket = join(`${state}.lock`, "queue", "2147483647-ownerless-ticket");
  try {
    await mkdir(ticket, { recursive: true, mode: 0o700 });
    const record = await provisionDesktop({ statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath });
    assert.match(record.client_id, /^swc_[a-f0-9]{32}$/);
    await assert.rejects(() => readFile(ticket, "utf8"), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Desktop setup retires only a verified prior Statewright launcher", async () => {
  const { root, state, vendor, app, applications, wrapper } = await fixture("statewright-desktop-legacy-app-");
  const legacyApp = join(applications, "Statewright ChatGPT.app");
  const legacyInfo = join(legacyApp, "Contents", "Info.plist");
  const legacyExecutable = join(legacyApp, "Contents", "MacOS", "Statewright ChatGPT");
  try {
    await mkdir(join(legacyApp, "Contents", "MacOS"), { recursive: true });
    await writeFile(legacyInfo, '<plist><dict><key>CFBundleIdentifier</key><string>ai.statewright.chatgpt</string></dict></plist>');
    await executable(legacyExecutable);
    await enableDesktop({ statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath });
    await assert.rejects(() => readFile(legacyInfo, "utf8"), { code: "ENOENT" });
    assert.ok(await readFile(join(applications, "ChatGPT + Statewright.app", "Contents", "Info.plist"), "utf8"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Desktop setup preserves an unverified similarly named application", async () => {
  const { root, state, vendor, app, applications, wrapper } = await fixture("statewright-desktop-unverified-app-");
  const legacyApp = join(applications, "Statewright ChatGPT.app");
  const legacyInfo = join(legacyApp, "Contents", "Info.plist");
  try {
    await mkdir(join(legacyApp, "Contents"), { recursive: true });
    await writeFile(legacyInfo, '<plist><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>');
    await enableDesktop({ statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath });
    assert.equal(await readFile(legacyInfo, "utf8"), '<plist><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Desktop launch starts the generated profile app", async () => {
  const { root, state, vendor, app, applications, wrapper } = await fixture("statewright-desktop-launch-");
  try {
    const record = await enableDesktop({ statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath });
    const calls = [];
    const result = await launchDesktop({ statePath: state, environment: { HOME: "/test/home", KEEP: "yes", CODEX_CLI_PATH: "/wrong/codex" }, spawn(command, args, options) { calls.push({ command, args, options }); const child = new EventEmitter(); child.pid = 4242; child.unref = () => { calls[0].unref = true; }; queueMicrotask(() => child.emit("spawn")); return child; } });
    assert.deepEqual(calls[0], { command: join(record.launcher_app_path, "Contents", "MacOS", "ChatGPT + Statewright"), args: [], unref: true, options: { detached: true, stdio: "ignore", env: { HOME: "/test/home", KEEP: "yes", CODEX_CLI_PATH: "/wrong/codex" } } });
    assert.equal(result.pid, 4242);
    assert.equal(result.started, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Generated ChatGPT + Statewright app runs with a minimal GUI-like PATH", async () => {
  const { root, state, vendor, app, applications, wrapper } = await fixture("statewright-desktop-generated-app-");
  const recordPath = join(root, "recorded-codex-cli-path");
  try {
    await writeFile(app, `#!/bin/sh\nprintf '%s|%s|%s' "$CODEX_CLI_PATH" "$STATEWRIGHT_DESKTOP_MCP_URL" "$STATEWRIGHT_DESKTOP_MCP_TOKEN" > "$RECORD_PATH"\nsleep 1\n`);
    await chmod(app, 0o700);
    const record = await enableDesktop({ statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath });
    const launcher = join(record.launcher_app_path, "Contents", "MacOS", "ChatGPT + Statewright");
    await execFile(launcher, [], { env: { PATH: "/usr/bin:/bin", RECORD_PATH: recordPath } });
    assert.equal(await readFile(recordPath, "utf8"), `${record.shim_path}|http://127.0.0.1:43123|https://mcp.statewright.ai|test-production-key`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Production, staging, and development Desktop profiles install independently", async () => {
  const { root, state, vendor, app, applications, wrapper } = await fixture("statewright-desktop-profiles-");
  const stagingState = join(dirname(state), "codex-desktop-staging.json");
  const developmentState = join(dirname(state), "codex-desktop-development.json");
  try {
    const production = await enableDesktop({ statePath: state, profile: "production", original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath });
    await assert.rejects(
      () => enableDesktop({ statePath: stagingState, profile: "staging", original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath }),
      /requires an explicit --gateway-url/,
    );
    const staging = await enableDesktop({ statePath: stagingState, profile: "staging", gatewayUrl: "https://staging.example.test", original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath });
    await assert.rejects(
      () => enableDesktop({ statePath: developmentState, profile: "development", original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath }),
      /requires an explicit --gateway-url/,
    );
    const development = await enableDesktop({ statePath: developmentState, profile: "development", gatewayUrl: "https://development.example.test", original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath });
    assert.equal(production.gateway_url, "https://mcp.statewright.ai");
    assert.equal(staging.gateway_url, "https://staging.example.test");
    assert.equal(development.gateway_url, "https://development.example.test");
    assert.notEqual(production.client_id, staging.client_id);
    assert.notEqual(production.client_id, development.client_id);
    assert.notEqual(staging.client_id, development.client_id);
    assert.equal(production.launcher_app_path, join(applications, "ChatGPT + Statewright.app"));
    assert.equal(staging.launcher_app_path, join(applications, "ChatGPT + Statewright Staging.app"));
    assert.equal(development.launcher_app_path, join(applications, "ChatGPT + Statewright Dev.app"));
    assert.equal(staging.api_key_path, join(dirname(state), "staging_api_key"));
    assert.equal(development.api_key_path, join(dirname(state), "dev_api_key"));
    assert.equal((await desktopDoctor({ statePath: state, profile: "production" })).ok, true);
    assert.equal((await desktopDoctor({ statePath: stagingState, profile: "staging" })).ok, true);
    assert.equal((await desktopDoctor({ statePath: developmentState, profile: "development" })).ok, true);
    const developmentDisabled = await disableDesktop({ statePath: developmentState, profile: "development" });
    assert.equal(developmentDisabled.app_removed, true);
    assert.equal((await desktopDoctor({ statePath: state, profile: "production" })).ok, true);
    assert.equal((await desktopDoctor({ statePath: stagingState, profile: "staging" })).ok, true);
    const disabled = await disableDesktop({ statePath: stagingState, profile: "staging" });
    assert.equal(disabled.app_removed, true);
    assert.equal((await desktopDoctor({ statePath: state, profile: "production" })).ok, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Desktop launch rejects spawn errors and early exits instead of claiming startup", async () => {
  const { root, state, vendor, app, applications, wrapper } = await fixture("statewright-desktop-launch-failure-");
  try {
    await enableDesktop({ statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath });
    await assert.rejects(() => launchDesktop({ statePath: state, spawn() { const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("not executable"))); return child; } }), /failed to start: not executable/);
    await assert.rejects(() => launchDesktop({ statePath: state, spawn() { const child = new EventEmitter(); queueMicrotask(() => { child.emit("spawn"); child.emit("exit", 0, null); }); return child; } }), /exited during startup/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Desktop setup migrates only a matching legacy override", async () => {
  const { root, state, vendor, app, applications, wrapper } = await fixture("statewright-desktop-migrate-");
  const legacyShim = join(root, "state", "bin", "statewright-desktop-codex");
  const launchctl = launchctlHarness(legacyShim);
  try {
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(state, `${JSON.stringify({ version: 2, environment_key: "CODEX_CLI_PATH", launchctl_path: "/bin/launchctl", previous_launchd_value: "/prior/codex", original_codex: vendor, wrapper, shim_path: legacyShim, client_id: "swc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })}\n`);
    const record = await enableDesktop({ statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath, launchctlExecFile: launchctl.exec });
    assert.equal(record.version, 3);
    assert.equal(record.client_id, "swc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(launchctl.value, "/prior/codex");
    assert.deepEqual(launchctl.calls, [["getenv", "CODEX_CLI_PATH"], ["setenv", "CODEX_CLI_PATH", "/prior/codex"]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Desktop migration uses the legacy record's custom launchctl path and rolls back on state-write failure", async () => {
  const { root, state, vendor, app, applications, wrapper } = await fixture("statewright-desktop-migrate-atomic-");
  const legacyShim = join(root, "state", "bin", "statewright-desktop-codex");
  const launchctl = launchctlHarness(legacyShim);
  try {
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(state, `${JSON.stringify({ version: 2, environment_key: "CODEX_CLI_PATH", launchctl_path: "/custom/launchctl", previous_launchd_value: "/prior/codex", original_codex: vendor, wrapper, shim_path: legacyShim, client_id: "swc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })}\n`);
    await assert.rejects(() => enableDesktop({ statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath, launchctlExecFile: launchctl.exec, writeAtomicFn: async (path, contents) => { if (path === state) throw new Error("state write failed"); await writeFile(path, contents); } }), /state write failed/);
    assert.equal(launchctl.value, legacyShim);
    assert.deepEqual(launchctl.paths, ["/custom/launchctl", "/custom/launchctl", "/custom/launchctl"]);
    assert.deepEqual(launchctl.calls, [["getenv", "CODEX_CLI_PATH"], ["setenv", "CODEX_CLI_PATH", "/prior/codex"], ["setenv", "CODEX_CLI_PATH", legacyShim]]);
    assert.equal(JSON.parse(await readFile(state, "utf8")).version, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Desktop setup refuses to overwrite a changed legacy launchd value", async () => {
  const { root, state, vendor, app, applications, wrapper } = await fixture("statewright-desktop-migrate-diverge-");
  const legacyShim = join(root, "state", "bin", "statewright-desktop-codex");
  const launchctl = launchctlHarness("/other/codex");
  try {
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(state, `${JSON.stringify({ version: 2, environment_key: "CODEX_CLI_PATH", launchctl_path: "/bin/launchctl", previous_launchd_value: null, original_codex: vendor, wrapper, shim_path: legacyShim, client_id: "swc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })}\n`);
    await assert.rejects(() => enableDesktop({ statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath, launchctlExecFile: launchctl.exec }), /changed since legacy setup/);
    assert.equal(launchctl.value, "/other/codex");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Desktop shim binds the explicit state record it created", async () => {
  const { root, state, vendor, app, applications } = await fixture("statewright-desktop-shim-");
  const wrapper = join(root, "capture-state.mjs");
  try {
    await writeFile(wrapper, 'import { readFile } from "node:fs/promises";\nconst state = JSON.parse(await readFile(process.env.STATEWRIGHT_DESKTOP_STATE_PATH, "utf8"));\nprocess.stdout.write(JSON.stringify({ path: process.env.STATEWRIGHT_DESKTOP_STATE_PATH, original: state.original_codex, client: state.client_id }));\n');
    const record = await enableDesktop({ statePath: state, original: vendor, app, applicationsDirectory: applications, wrapper, node: process.execPath });
    const { stdout } = await execFile(record.shim_path, [], { env: { ...process.env, STATEWRIGHT_DESKTOP_STATE_PATH: join(root, "wrong.json") } });
    assert.deepEqual(JSON.parse(stdout), { path: state, original: vendor, client: record.client_id });
  } finally { await rm(root, { recursive: true, force: true }); }
});
