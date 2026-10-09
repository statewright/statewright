import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
process.env.STATEWRIGHT_QWEN_BASE_URL = 'http://127.0.0.1:1/v1';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  appServerHomePrefixForClient,
  appServerCommandOptions,
  codexAppServerTransportEnabled,
  routeConfigEdits,
  runCodexAppServerTransport,
  startCodexAppServerRuntime,
} from "../lib/codex-app-server-transport.mjs";
import { ensureCodexAppServerResident, nextCodexResidentRouteRequest, residentControlDir, residentMatchesRuntime, residentProfileIdentity, residentRoot, residentRuntimeRevision } from "../lib/codex-app-server-resident.mjs";
import { applyCompactResumeRequest, applyExplicitYoloResumePermissions, applyRestoredResumePermissions, applyRouteToTurnStart, applyThreadListCwd, captureWorkflowOrigin, clarifyActiveWriterResumeError, expandPluginRootHookCommands, hydrateBoundedResumeTurns, labelThreadListResponse, nativeThreadRouteSettings, restoreWorkflowOrigin, settingsConfirmRoute, startCodexAppServerRouteProxy, terminalStatewrightCompletion } from "../lib/codex-app-server-route-proxy.mjs";
import {WorkflowRouteOriginStore} from "../lib/workflow-route-origin.mjs";
import { readCodexResumePermissions, readCodexThreadCwds } from "../lib/codex-session-metadata.mjs";
import { resolveWindowsLaunch } from "../lib/windows-command-resolution.mjs";

function once(socket, event) {
  return new Promise((resolveEvent) => socket.once(event, resolveEvent));
}

test("managed Codex defaults to App Server across gateway profiles and preserves explicit legacy opt-out", () => {
  for (const profile of [undefined, "production", "staging", "dev1", "dev2"]) {
    assert.equal(codexAppServerTransportEnabled({ environment: { STATEWRIGHT_ENV: profile } }), true);
  }
  assert.equal(codexAppServerTransportEnabled({
    environment: {},
    config: { routing: { managed_clients: { codex_transport: "app-server" } } },
  }), true);
  assert.equal(codexAppServerTransportEnabled({
    environment: { STATEWRIGHT_CODEX_TRANSPORT: "restart" },
    config: { routing: { managed_clients: { codex_transport: "app-server" } } },
  }), false);
  assert.equal(codexAppServerTransportEnabled({
    environment: { STATEWRIGHT_CODEX_TRANSPORT: "app-server" },
    config: { routing: { managed_clients: { codex_transport: "restart" } } },
  }), true);
  assert.equal(codexAppServerTransportEnabled({ environment: {}, config: { routing: { managed_clients: { codex_transport: "restart" } } } }), false);
  assert.throws(() => codexAppServerTransportEnabled({ environment: { STATEWRIGHT_CODEX_TRANSPORT: "typo" } }), /Unsupported Codex transport/);
  assert.throws(() => codexAppServerTransportEnabled({ environment: {}, config: { routing: { managed_clients: { codex_transport: "typo" } } } }), /Unsupported Codex transport/);
});

test("App Server runtime uses cmd.exe only for Windows batch launchers", () => {
  assert.deepEqual(appServerCommandOptions("C:\\tools\\codex.cmd", "win32"), { shell: true });
  assert.deepEqual(appServerCommandOptions("C:\\tools\\codex.bat", "win32"), { shell: true });
  assert.deepEqual(appServerCommandOptions("C:\\tools\\codex.exe", "win32"), { shell: false });
  assert.deepEqual(appServerCommandOptions("/usr/local/bin/codex", "darwin"), { shell: false });
});

test("resident reuse requires the same canonical gateway and auth profile, never merely the same thread", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-resident-profile-"));
  try {
    const prod = await residentProfileIdentity({ STATEWRIGHT_GATEWAY_URL: "https://mcp.statewright.ai" }, home);
    assert.equal(prod, await residentProfileIdentity({ STATEWRIGHT_GATEWAY_URL: "https://mcp.statewright.ai/mcp" }, home));
    const staging = await residentProfileIdentity({ STATEWRIGHT_GATEWAY_URL: "https://stage.example", STATEWRIGHT_PB_URL: "https://stage-auth.example" }, home);
    const changedAuth = await residentProfileIdentity({ STATEWRIGHT_GATEWAY_URL: "https://stage.example", STATEWRIGHT_PB_URL: "https://other-auth.example" }, home);
    const manifest = { runtimeRevision: "fixture", profileIdentity: staging, threadListCwd: null };
    assert.equal(residentMatchesRuntime(manifest, "fixture", null, staging), true);
    for (const target of [prod, changedAuth]) assert.equal(residentMatchesRuntime(manifest, "fixture", null, target), false);
    assert.equal(residentMatchesRuntime({ runtimeRevision: "fixture" }, "fixture", null, staging), false);
    await assert.rejects(residentProfileIdentity({ STATEWRIGHT_ENV: "dev1" }, home), /not configured/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Windows npm Codex shims launch Node directly and preserve argv boundaries", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-windows-npm-shim-"));
  const command = join(home, "codex.cmd");
  const entrypoint = join(home, "codex.mjs");
  try {
    await writeFile(entrypoint, "export {};\n");
    await writeFile(command, `@echo off\r\n"${process.execPath}" "%~dp0codex.mjs" %*\r\n`);
    const launch = await resolveWindowsLaunch(command, "win32");
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.prefixArgs, [entrypoint]);
    assert.equal(launch.shell, false);
    const providerToml = '{name="qwen private",base_url="http://127.0.0.1:11434/v1"}';
    assert.deepEqual([...launch.prefixArgs, "-c", `model_providers.qwen_private=${providerToml}`, "app-server", "--listen", "ws://127.0.0.1:41234"], [entrypoint, "-c", `model_providers.qwen_private=${providerToml}`, "app-server", "--listen", "ws://127.0.0.1:41234"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("transport preserves a resolved Windows npm shim entrypoint for its App Server", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-windows-transport-shim-"));
  const command = join(home, "codex.cmd");
  const entrypoint = join(home, "codex.mjs");
  const appServerArgs = join(home, "app-server-args.json");
  try {
    await writeFile(entrypoint, `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "app-server") {
  writeFileSync(${JSON.stringify(appServerArgs)}, JSON.stringify(args));
  const target = new URL(args.at(-1));
  createServer((_request, response) => { response.writeHead(200); response.end("ok"); }).listen(Number(target.port), target.hostname);
} else process.exit(0);
`);
    await writeFile(command, `@echo off\r\n"${process.execPath}" "%~dp0codex.mjs" %*\r\n`);
    const result = await runCodexAppServerTransport({
      command,
      args: [],
      platform: "win32",
      home,
      cwd: home,
      clientId: "swc_windows_transport_shim",
      controlDir: home,
      pollMs: 1,
      environment: { ...process.env, CODEX_HOME: join(home, ".codex"), STATEWRIGHT_QWEN_ENABLED: "false", STATEWRIGHT_SENTRY_DISABLED: "true" },
      nextRouteRequest: async () => null,
      stderr: { write() {} },
      reporter: { async report() {} },
    });
    assert.equal(result, 0);
    assert.deepEqual(JSON.parse(await readFile(appServerArgs, "utf8")).slice(0, 2), ["app-server", "--listen"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function npmTemplateShim() {
  // Exact template npm's cmd-shim dependency writes for Windows JS bin links.
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    '"%_prog%"  "%dp0%\\node_modules\\@statewright\\codex\\bin\\codex.mjs"  %*',
    "",
  ].join("\r\n");
}

test("Windows npm-template shims resolve to the local Node interpreter and preserve argv", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-windows-npm-template-"));
  const command = join(home, "codex.cmd");
  const entrypoint = join(home, "node_modules/@statewright/codex/bin/codex.mjs");
  const localNode = join(home, "node.exe");
  try {
    await mkdir(join(home, "node_modules/@statewright/codex/bin"), { recursive: true });
    await writeFile(entrypoint, "export {};\n");
    await writeFile(command, npmTemplateShim());
    // A placeholder marks the IF EXIST "%dp0%\node.exe" branch as taken, so
    // the resolver must prefer the local interpreter over the PATH fallback.
    await writeFile(localNode, "");
    const launch = await resolveWindowsLaunch(command, "win32");
    assert.deepEqual(launch, { command: localNode, prefixArgs: [entrypoint], shell: false });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Windows npm-template shims fall back to PATH Node when no local interpreter exists", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-windows-npm-template-fallback-"));
  const command = join(home, "codex.cmd");
  const entrypoint = join(home, "node_modules/@statewright/codex/bin/codex.mjs");
  try {
    await mkdir(join(home, "node_modules/@statewright/codex/bin"), { recursive: true });
    await writeFile(entrypoint, "export {};\n");
    await writeFile(command, npmTemplateShim());
    const launch = await resolveWindowsLaunch(command, "win32");
    assert.deepEqual(launch, { command: "node", prefixArgs: [entrypoint], shell: false });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("transport preserves a resolved npm-template Windows shim entrypoint for its App Server", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-windows-transport-npm-template-"));
  const command = join(home, "codex.cmd");
  const entrypoint = join(home, "node_modules/@statewright/codex/bin/codex.mjs");
  const appServerArgs = join(home, "app-server-args.json");
  try {
    await mkdir(join(home, "node_modules/@statewright/codex/bin"), { recursive: true });
    await writeFile(entrypoint, `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "app-server") {
  writeFileSync(${JSON.stringify(appServerArgs)}, JSON.stringify(args));
  const target = new URL(args.at(-1));
  createServer((_request, response) => { response.writeHead(200); response.end("ok"); }).listen(Number(target.port), target.hostname);
} else process.exit(0);
`);
    await writeFile(command, npmTemplateShim());
    const result = await runCodexAppServerTransport({
      command,
      args: [],
      platform: "win32",
      home,
      cwd: home,
      clientId: "swc_windows_transport_npm_template",
      controlDir: home,
      pollMs: 1,
      environment: { ...process.env, CODEX_HOME: join(home, ".codex"), STATEWRIGHT_QWEN_ENABLED: "false", STATEWRIGHT_SENTRY_DISABLED: "true" },
      nextRouteRequest: async () => null,
      stderr: { write() {} },
      reporter: { async report() {} },
    });
    assert.equal(result, 0);
    const recorded = JSON.parse(await readFile(appServerArgs, "utf8"));
    assert.deepEqual(recorded.slice(0, 2), ["app-server", "--listen"]);
    assert.match(recorded.at(-1), /^ws:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("App Server transport creates bounded, filesystem-safe temporary home names", () => {
  assert.equal(appServerHomePrefixForClient("swc_abc:unsafe/path"), "statewright-swc_abc-unsafe-path");
  assert.match(appServerHomePrefixForClient("x".repeat(100)), /^statewright-x{60}$/);
});

test("App Server runtime confirms its owned child exits before close completes", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-app-server-close-"));
  const codexHome = join(home, ".codex");
  const fake = join(home, "fake-codex.mjs");
  const pidPath = join(home, "app-server.pid");
  try {
    await mkdir(codexHome, { recursive: true });
    await writeFile(fake, `#!/usr/bin/env node\nimport { createServer } from "node:http";\nimport { writeFileSync } from "node:fs";\nconst target = new URL(process.argv.at(-1));\nprocess.on("SIGTERM", () => {});\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\ncreateServer((_request, response) => { response.writeHead(200); response.end("ok\\n"); }).listen(Number(target.port), target.hostname);\n`);
    await chmod(fake, 0o755);
    const runtime = await startCodexAppServerRuntime({
      command: fake,
      environment: { ...process.env, CODEX_HOME: codexHome, STATEWRIGHT_SENTRY_DISABLED: "true" },
      cwd: home,
      home,
      clientId: "swc_shutdown_test",
      shutdownGraceMs: 20,
      reporter: { async report() {} },
    });
    const pid = Number(await readFile(pidPath, "utf8"));
    await runtime.close();
    assert.throws(() => process.kill(pid, 0));
    const retainedHomes = (await readdir(tmpdir())).filter((entry) => entry.startsWith("statewright-swc_shutdown_test-app-server-"));
    assert.ok(retainedHomes.length >= 1, "the isolated home must remain addressable after shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Standalone App Server starts without any local-model configuration", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-app-server-standalone-"));
  const fake = join(home, "fake-codex.mjs");
  const argsPath = join(home, "args.json");
  const environment = { ...process.env, CODEX_HOME: join(home, ".codex"), STATEWRIGHT_SENTRY_DISABLED: "true" };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("STATEWRIGHT_QWEN_")) delete environment[key];
  }
  let runtime;
  try {
    await mkdir(environment.CODEX_HOME, { recursive: true });
    await writeFile(fake, `#!/usr/bin/env node
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
const url = new URL(process.argv.at(-1));
createServer((_req, res) => { res.writeHead(200); res.end("ok"); }).listen(Number(url.port), url.hostname);
`);
    await chmod(fake, 0o755);
    runtime = await startCodexAppServerRuntime({ command: fake, environment, cwd: home,
      home, clientId: "swc_standalone_test", reporter: { async report() {} } });
    const args = await readFile(argsPath, "utf8");
    assert.doesNotMatch(args, /qwen|casa|local-models/);
  } finally {
    await runtime?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("App Server starts with the installed Casa Qwen provider and merged catalog", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-app-server-qwen-"));
  const codexHome = join(home, ".codex");
  const fake = join(home, "fake-codex.mjs");
  const argsPath = join(home, "app-server-args.json");
  const qwenCatalog = join(home, "qwen.models.json");
  try {
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-5.6-terra" }] }));
    await writeFile(qwenCatalog, JSON.stringify({ models: [{ slug: "qwen3.8-27b" }] }));
    await writeFile(fake, `#!/usr/bin/env node
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const target = new URL(process.argv.at(-1));
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
createServer((_request, response) => { response.writeHead(200); response.end("ok\\n"); }).listen(Number(target.port), target.hostname);
`);
    await chmod(fake, 0o755);
    const runtime = await startCodexAppServerRuntime({
      command: fake,
      environment: {
        ...process.env,
        CODEX_HOME: codexHome,
        STATEWRIGHT_QWEN_MODEL_CATALOG: qwenCatalog,
        STATEWRIGHT_QWEN_BASE_URL: "https://qwen.example.test/v1",
        STATEWRIGHT_SENTRY_DISABLED: "true",
      },
      cwd: home,
      home,
      clientId: "swc_qwen_startup_test",
      reporter: { async report() {} },
    });
    try {
      const args = JSON.parse(await readFile(argsPath, "utf8"));
      assert.ok(args.some((value) => value.startsWith("model_catalog_json=")));
      assert.ok(args.some((value) => value.includes("model_providers.qwen_private=") && value.includes("https://qwen.example.test/v1")));
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("resident App Server state is stable per managed client and keeps routes outside the transient launcher", () => {
  const home = "/tmp/statewright-home";
  const root = residentRoot(home, "swc_abc:unsafe/path");
  assert.equal(root, "/tmp/statewright-home/.statewright/codex-app-server/swc_abc-unsafe-path");
  assert.equal(residentControlDir(home, "swc_abc:unsafe/path"), `${root}/routes`);
});

test("resident App Server accepts routes only for the attached root session", async () => {
  const control = await mkdtemp(join(tmpdir(), "statewright-resident-routes-"));
  const clientId = "swc_0123456789abcdef0123456789abcdef";
  try {
    await writeFile(join(control, "codex-root-session.json"), JSON.stringify({ version: 1, session_id: "root-thread", client_id: clientId }));
    const routePath = join(control, "01-root.route.json");
    await writeFile(routePath, JSON.stringify({ session_id: "root-thread", root_session_id: "root-thread", client_id: clientId, model: "gpt-5.6-terra" }));
    assert.equal(await nextCodexResidentRouteRequest(control, clientId, "child-thread"), null);
    const candidates = await Promise.all([
      nextCodexResidentRouteRequest(control, clientId, "root-thread"),
      nextCodexResidentRouteRequest(control, clientId, "root-thread"),
    ]);
    const pending = candidates.find(Boolean);
    assert.equal(candidates.filter(Boolean).length, 1);
    assert.deepEqual(pending.route, {
      session_id: "root-thread", root_session_id: "root-thread", client_id: clientId, model: "gpt-5.6-terra",
    });
    assert.equal((await readdir(control)).filter((name) => name.endsWith(".route.json")).length, 0);
    await pending.release();
    const retry = await nextCodexResidentRouteRequest(control, clientId, "root-thread", {
      unlinkImpl: async () => { const error = new Error("synthetic acknowledgement failure"); error.code = "EACCES"; throw error; },
    });
    await assert.rejects(retry.ack(), { code: "EACCES" });
    assert.equal((await readdir(control)).filter((name) => name.endsWith(".route.json")).length, 0);
    await retry.release();
    const finalAttempt = await nextCodexResidentRouteRequest(control, clientId, "root-thread");
    await finalAttempt.ack();
    await finalAttempt.ack();
  } finally { await rm(control, { recursive: true, force: true }); }
});

test("resident App Server keeps retry route filenames bounded across repeated releases", async () => {
  const control = await mkdtemp(join(tmpdir(), "statewright-resident-bounded-retries-"));
  const clientId = "swc_0123456789abcdef0123456789abcdef";
  const sessionId = "bounded-retry-thread";
  try {
    await writeFile(join(control, "codex-root-session.json"), JSON.stringify({ version: 1, session_id: sessionId, client_id: clientId }));
    await writeFile(join(control, "01-root.route.json"), JSON.stringify({ session_id: sessionId, root_session_id: sessionId, client_id: clientId, model: "gpt-5.6-terra" }));
    const reservationNames = [];
    const renameImpl = async (source, destination) => {
      if (destination.endsWith(".inflight")) reservationNames.push(basename(destination));
      await rename(source, destination);
    };

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pending = await nextCodexResidentRouteRequest(control, clientId, sessionId, { renameImpl });
      assert.ok(pending);
      await pending.release();
      const queued = (await readdir(control)).filter((name) => name.endsWith(".route.json"));
      assert.equal(queued.length, 1);
      assert.ok(basename(queued[0]).length <= 160, `retry filename exceeded bound: ${queued[0]}`);
    }
    assert.equal(reservationNames.length, 20);
    assert.ok(reservationNames.every((name) => name.length <= 80));

    const pending = await nextCodexResidentRouteRequest(control, clientId, sessionId, { renameImpl });
    await pending.ack();
    assert.equal((await readdir(control)).filter((name) => name.endsWith(".route.json")).length, 0);
  } finally {
    await rm(control, { recursive: true, force: true });
  }
});

test("resident App Server recovers a legacy near-limit route filename", async () => {
  const control = await mkdtemp(join(tmpdir(), "statewright-resident-legacy-route-"));
  const clientId = "swc_0123456789abcdef0123456789abcdef";
  const sessionId = "legacy-route-thread";
  try {
    await writeFile(join(control, "codex-root-session.json"), JSON.stringify({ version: 1, session_id: sessionId, client_id: clientId }));
    const legacyName = `${"x".repeat(220)}.route.json`;
    await writeFile(join(control, legacyName), JSON.stringify({ session_id: sessionId, root_session_id: sessionId, client_id: clientId, model: "gpt-5.6-terra" }));

    const pending = await nextCodexResidentRouteRequest(control, clientId, sessionId);
    assert.ok(pending);
    await pending.release();
    const queued = (await readdir(control)).filter((name) => name.endsWith(".route.json"));
    assert.equal(queued.length, 1);
    assert.ok(basename(queued[0]).length <= 160, `retry filename exceeded bound: ${queued[0]}`);

    const retry = await nextCodexResidentRouteRequest(control, clientId, sessionId);
    await retry.ack();
    assert.equal((await readdir(control)).filter((name) => name.endsWith(".route.json")).length, 0);
  } finally {
    await rm(control, { recursive: true, force: true });
  }
});

test("resident App Server keeps a fresh current route ahead of its released retry", async () => {
  const control = await mkdtemp(join(tmpdir(), "statewright-resident-retry-order-"));
  const clientId = "swc_0123456789abcdef0123456789abcdef";
  const sessionId = "retry-order-thread";
  const routePath = join(control, "current.route.json");
  try {
    await writeFile(join(control, "codex-root-session.json"), JSON.stringify({ version: 1, session_id: sessionId, client_id: clientId }));
    await writeFile(routePath, JSON.stringify({ session_id: sessionId, root_session_id: sessionId, client_id: clientId, turn_id: "retry" }));
    const first = await nextCodexResidentRouteRequest(control, clientId, sessionId);
    await first.release();

    await writeFile(routePath, JSON.stringify({ session_id: sessionId, root_session_id: sessionId, client_id: clientId, turn_id: "fresh" }));
    const fresh = await nextCodexResidentRouteRequest(control, clientId, sessionId);
    assert.equal(fresh.route.turn_id, "fresh");
    await fresh.ack();

    const retry = await nextCodexResidentRouteRequest(control, clientId, sessionId);
    assert.equal(retry.route.turn_id, "retry");
    await retry.ack();
  } finally {
    await rm(control, { recursive: true, force: true });
  }
});

test("resident runtime revision changes reuse only when the loaded transport bundle matches", async () => {
  const revision = await residentRuntimeRevision();
  assert.match(revision, /^[a-f0-9]{16}$/);
  assert.equal(residentMatchesRuntime({ runtimeRevision: revision }, revision), true);
  assert.equal(residentMatchesRuntime({ runtimeRevision: revision, threadListCwd: "/repo" }, revision, "/repo"), true);
  assert.equal(residentMatchesRuntime({ runtimeRevision: revision, threadListCwd: "/repo" }, revision, null), false);
  assert.equal(residentMatchesRuntime({ runtimeRevision: revision, threadListCwd: null }, revision, "/repo"), false);
  assert.equal(residentMatchesRuntime({ runtimeRevision: "stale" }, revision), false);
  assert.equal(residentMatchesRuntime({}, revision), false);
});

test("a mismatched launch never retires a live resident that may own detached work", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-resident-mismatch-"));
  const clientId = "swc_scope_mismatch";
  const root = residentRoot(home, clientId);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      pid: child.pid,
      proxyUrl: "ws://127.0.0.1:1",
      runtimeRevision: await residentRuntimeRevision(),
      threadListCwd: "/repo-a",
    }));
    await assert.rejects(
      ensureCodexAppServerResident({ command: "codex", cwd: "/repo-b", home, clientId, threadListCwd: "/repo-b" }),
      /may be preserving detached work/i,
    );
    assert.doesNotThrow(() => process.kill(child.pid, 0));
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    await rm(home, { recursive: true, force: true });
  }
});

test("App Server transport writes only next-turn model and effort config overrides", () => {
  assert.deepEqual(routeConfigEdits({
    model: "openai-codex/gpt-5.6-sol",
    effort: "high",
  }), [
    { keyPath: "model", mergeStrategy: "upsert", value: "gpt-5.6-sol" },
    { keyPath: "model_reasoning_effort", mergeStrategy: "upsert", value: "high" },
  ]);
  assert.deepEqual(routeConfigEdits({ model: "gpt-5.6-terra" }), [
    { keyPath: "model", mergeStrategy: "upsert", value: "gpt-5.6-terra" },
  ]);
  assert.throws(() => routeConfigEdits({ effort: "high" }), /missing a model/);
});

test("App Server routing overrides the native next turn and requires a settings receipt", () => {
  const { message, receipt } = applyRouteToTurnStart({
    id: 12,
    method: "turn/start",
    params: { threadId: "thread-1", input: [] },
  }, { session_id: "thread-1", model: "openai-codex/gpt-5.6-sol", effort: "high" });
  assert.equal(message.params.model, "gpt-5.6-sol");
  assert.equal(message.params.effort, "high");
  assert.deepEqual(settingsConfirmRoute(receipt, {
    method: "thread/settings/updated",
    params: { threadId: "thread-1", threadSettings: { model: "gpt-5.6-sol", modelProvider: "openai", effort: "high" } },
  }), {
    ...receipt,
    actualModel: "gpt-5.6-sol",
    actualProvider: "openai",
    actualEffort: "high",
    confirmed: true,
  });
  assert.equal(settingsConfirmRoute(receipt, {
    method: "thread/settings/updated",
    params: { threadId: "thread-1", threadSettings: { model: "gpt-5.6-terra", effort: "high" } },
  }).confirmed, false);
  assert.deepEqual(applyRouteToTurnStart({
    method: "turn/start", params: { threadId: "different-thread" },
  }, { session_id: "thread-1", model: "gpt-5.6-sol" }), {
    message: { method: "turn/start", params: { threadId: "different-thread" } }, receipt: null,
  });
});

test("App Server routing captures and restores the pre-workflow model, effort, and service tier", () => {
  const origin = captureWorkflowOrigin({
    method: "turn/start",
    params: {
      threadId: "thread-return",
      model: "gpt-6-astra",
      effort: "high",
      serviceTier: "priority",
      collaborationMode: {
        mode: "default",
        settings: { model: "gpt-6-astra", reasoning_effort: "high" },
      },
    },
  }, { provider: "openai" });
  assert.deepEqual(origin, {
    provider: "openai",
    model: "openai-codex/gpt-6-astra",
    effort: "high",
    service_tier: "priority",
  });
  const restored = restoreWorkflowOrigin({
    session_id: "thread-return",
    run_id: "run-return",
    state: "complete",
    restore_original: true,
  }, { ...origin, run_id: "run-return" });
  const { message, receipt } = applyRouteToTurnStart({
    method: "turn/start",
    params: { threadId: "thread-return", model: "gpt-5.6-terra", effort: "medium", serviceTier: "default" },
  }, restored);
  assert.equal(message.params.model, "gpt-6-astra");
  assert.equal(message.params.effort, "high");
  assert.equal(message.params.serviceTier, "priority");
  assert.equal(receipt.route.restored_original, true);
  assert.equal(receipt.effectiveServiceTier, "priority");
  assert.equal(settingsConfirmRoute(receipt, {
    method: "thread/settings/updated",
    params: { threadId: "thread-return", threadSettings: {
      model: "gpt-6-astra", modelProvider: "openai", effort: "high", serviceTier: "priority",
    } },
  }).confirmed, true);
  assert.equal(restoreWorkflowOrigin({ restore_original: true, run_id: "foreign" }, {
    ...origin, run_id: "run-return",
  }), null);
});

test("native thread start and resume settings preserve reasoningEffort presence and explicit null", () => {
  for (const method of ["thread/start", "thread/resume"]) {
    const native = nativeThreadRouteSettings({
      thread: { id: "thread-native", effort: "legacy-thread" },
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      reasoningEffort: "high",
      effort: "legacy-top-level",
      serviceTier: "priority",
    });
    assert.deepEqual(native, {
      model: "gpt-5.6-sol", modelProvider: "openai", effort: "high", serviceTier: "priority",
    }, method);

    const explicitNull = nativeThreadRouteSettings({
      thread: { id: "thread-native", reasoningEffort: "legacy-thread" },
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      reasoningEffort: null,
      effort: "legacy-top-level",
      serviceTier: null,
    });
    assert.equal(Object.hasOwn(explicitNull, "effort"), true, method);
    assert.equal(explicitNull.effort, null, method);
    assert.equal(Object.hasOwn(explicitNull, "serviceTier"), true, method);
    assert.equal(explicitNull.serviceTier, null, method);

    const unavailable = nativeThreadRouteSettings({
      thread: { id: "thread-native" }, model: "gpt-5.6-sol", modelProvider: "openai",
    });
    assert.equal(Object.hasOwn(unavailable, "effort"), false, method);
    assert.equal(Object.hasOwn(unavailable, "serviceTier"), false, method);
  }
});

test("workflow origin capture keeps explicit null distinct from unavailable native evidence", () => {
  const message = { method: "turn/start", params: { threadId: "thread-native" } };
  const explicitNull = captureWorkflowOrigin(message, {
    provider: "openai", model: "gpt-5.6-sol", effort: null, service_tier: null,
  });
  assert.equal(Object.hasOwn(explicitNull, "effort"), true);
  assert.equal(explicitNull.effort, null);
  assert.equal(Object.hasOwn(explicitNull, "service_tier"), true);
  assert.equal(explicitNull.service_tier, null);
  const unavailable = captureWorkflowOrigin(message, { provider: "openai", model: "gpt-5.6-sol" });
  assert.equal(Object.hasOwn(unavailable, "effort"), false);
  assert.equal(Object.hasOwn(unavailable, "service_tier"), false);
});

test("only successful terminal or deactivate Statewright completions request restoration", () => {
  const item = (tool, structuredContent, overrides = {}) => ({
    id: `item-${tool}`, type: "mcpToolCall", status: "completed", tool, server: "statewright",
    result: { structuredContent }, ...overrides,
  });
  for (const state of ["complete", "blocked", "failed", "cancelled"]) {
    assert.equal(terminalStatewrightCompletion(item("statewright_transition", {
      state_snapshot: { state, is_final: true },
    })).kind, "terminal");
  }
  assert.equal(terminalStatewrightCompletion(item("statewright_deactivate", { deactivated: true })).kind, "deactivated");
  assert.equal(terminalStatewrightCompletion(item("statewright_pause", { paused: true })), null);
  for (const type of ["mcpToolCall", "McpToolCall"]) {
    const compact = {transitioned: true, from: "localize", to: "blocked", requires_approval: false,
      approval_message: null, transition_count: 2, usage: null};
    const parsed = terminalStatewrightCompletion(item("statewright_transition", compact, {type}));
    assert.equal(parsed.kind, "transition", "compact success is a hint, never proof of finality");
    assert.equal(parsed.state, null);
    for (const status of ["failed", "aborted", "inProgress"]) {
      assert.equal(terminalStatewrightCompletion(item("statewright_transition", compact, {type, status})), null);
    }
  }
  assert.equal(terminalStatewrightCompletion(item("statewright_transition", {
    state_snapshot: { state: "implement", is_final: false },
  })), null);
  assert.equal(terminalStatewrightCompletion(item("statewright_deactivate", { deactivated: false })), null);
  assert.equal(terminalStatewrightCompletion({
    ...item("statewright_deactivate", { deactivated: true }), server: undefined,
  }), null, "an unscoped bare tool name is not local lifecycle authority");
  assert.equal(terminalStatewrightCompletion({
    ...item("mcp__statewright__statewright_deactivate", { deactivated: true }), server: undefined,
  }).kind, "deactivated");
  assert.equal(terminalStatewrightCompletion(item("mcp__codex_apps__statewright_staging_statewright_deactivate", {
    deactivated: true,
  })), null);
  assert.equal(terminalStatewrightCompletion({
    ...item("statewright_deactivate", { deactivated: true }), server: "statewright_staging",
  }), null);
  assert.equal(terminalStatewrightCompletion(item("statewright_deactivate", { deactivated: true }, {
    result: { isError: true },
  })), null);
});

test("an unspecified original effort is explicitly cleared and must be confirmed as null", () => {
  const route = {session_id: "thread-default-effort", model: "openai-codex/gpt-5.6-sol",
    effort: null, service_tier: "priority", restore_original: true};
  const applied = applyRouteToTurnStart({method: "turn/start", params: {
    threadId: route.session_id, effort: "medium",
    collaborationMode: {mode: "default", settings: {model: "gpt-5.6-terra", reasoning_effort: "medium"}},
  }}, route);
  assert.equal(Object.hasOwn(applied.message.params, "effort"), true);
  assert.equal(applied.message.params.effort, null);
  assert.equal(applied.message.params.collaborationMode.settings.reasoning_effort, null);
  assert.equal(settingsConfirmRoute(applied.receipt, {method: "thread/settings/updated", params: {
    threadId: route.session_id, threadSettings: {model: "gpt-5.6-sol", modelProvider: "openai",
      effort: null, serviceTier: "priority", collaborationMode: {settings: {model: "gpt-5.6-sol", reasoning_effort: null}}},
  }}).confirmed, true);
  const missing = settingsConfirmRoute(applied.receipt, {method: "thread/settings/updated", params: {
    threadId: route.session_id, threadSettings: {model: "gpt-5.6-sol", modelProvider: "openai",
      serviceTier: "priority", collaborationMode: {settings: {model: "gpt-5.6-sol"}}},
  }});
  assert.equal(missing.confirmed, false);
  assert.equal(Object.hasOwn(missing, "actualEffort"), false);
  assert.equal(Object.hasOwn(missing, "actualCollaborationEffort"), false);
});

test("App Server proxy restores the captured route after the authoritative workflow becomes terminal", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  let upstreamSocket;
  const connected = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  let state = {
    run_id: "run-return",
    state: "intake",
    model: "openai-codex/gpt-5.6-terra",
    thinking_level: "medium",
    is_final: false,
  };
  const pending = [{
    session_id: "thread-return",
    root_session_id: "thread-return",
    client_id: "client-return",
    run_id: "run-return",
    state: "intake",
    model: "openai-codex/gpt-5.6-terra",
    effort: "medium",
    service_tier: "default",
  }];
  const injected = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`,
    approvalService: {
      getState: async () => state,
      restore: async () => null,
    },
    takePendingRoute: async () => {
      const route = pending.shift();
      return route ? { route, ack: async () => {} } : null;
    },
    onRouteInjected: async (receipt) => injected.push(receipt),
    routeOwner: async () => ({ root_session_id: "thread-return", client_id: "client-return" }),
  });
  let client = new WebSocket(proxy.url);
  await once(client, "open");
  await connected;
  try {
    const nextForwardedTurn = async () => {
      for (;;) {
        const request = JSON.parse(String(await once(upstreamSocket, "message")));
        if (request.method !== "thread/read") return request;
        upstreamSocket.send(JSON.stringify({ id: request.id, result: {
          thread: { id: "thread-return", status: { type: "idle" } },
        } }));
      }
    };
    const initialThread = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
    client.send(JSON.stringify({ id: 1, method: "thread/start", params: {} }));
    assert.equal((await initialThread).method, "thread/start");
    upstreamSocket.send(JSON.stringify({ id: 1, result: {
      thread: { id: "thread-return" }, modelProvider: "openai", model: "gpt-6-astra",
    } }));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));

    client.send(JSON.stringify({ id: 2, method: "turn/start", params: {
      threadId: "thread-return", input: [], model: "gpt-6-astra", effort: "high", serviceTier: "priority",
    } }));
    const routed = await nextForwardedTurn();
    assert.equal(routed.params.model, "gpt-5.6-terra");
    assert.equal(routed.params.effort, "medium");
    assert.equal(routed.params.serviceTier, "default");
    upstreamSocket.send(JSON.stringify({ id: 2, result: { turn: { id: "workflow-turn" } } }));
    upstreamSocket.send(JSON.stringify({ method: "thread/settings/updated", params: {
      threadId: "thread-return", threadSettings: {
        model: "gpt-5.6-terra", modelProvider: "openai", effort: "medium", serviceTier: "default",
      },
    } }));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));

    const disconnected = once(client, "close");
    client.close();
    await disconnected;
    const reconnectedUpstream = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
      upstreamSocket = socket;
      resolveConnection();
    }));
    client = new WebSocket(proxy.url);
    await once(client, "open");
    await reconnectedUpstream;

    const manualSettingsForwarded = new Promise((resolveMessage) => upstreamSocket.once("message", raw => resolveMessage(JSON.parse(String(raw)))));
    client.send(JSON.stringify({ id: 20, method: "thread/settings/update", params: {
      threadId: "thread-return", model: "gpt-5.5",
    } }));
    assert.equal((await manualSettingsForwarded).params.model, "gpt-5.5");
    upstreamSocket.send(JSON.stringify({ id: 20, result: {} }));
    upstreamSocket.send(JSON.stringify({ method: "thread/settings/updated", params: {
      threadId: "thread-return", threadSettings: {
        model: "gpt-5.5", modelProvider: "openai", effort: "medium", serviceTier: "default",
      },
    } }));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));

    state = { ...state, state: "complete", is_final: true };
    pending.push({
      session_id: "thread-return",
      root_session_id: "thread-return",
      client_id: "client-return",
      run_id: "run-return",
      state: "complete",
      model: "",
      effort: "",
      restore_original: true,
    });
    client.send(JSON.stringify({ id: 3, method: "turn/start", params: {
      threadId: "thread-return", input: [], model: "gpt-5.5", effort: "medium", serviceTier: "default",
    } }));
    const restored = await nextForwardedTurn();
    assert.equal(restored.params.model, "gpt-5.5", "a confirmed manual model override must survive restoration");
    assert.equal(restored.params.effort, "medium");
    assert.equal(restored.params.serviceTier, "default");
    assert.equal(injected.length, 2);
    assert.equal(injected[0].route.restored_original, undefined);
    assert.equal(injected[1].route.restored_original, true);
    upstreamSocket.send(JSON.stringify({ id: 3, result: { turn: { id: "restored-turn" } } }));
    upstreamSocket.send(JSON.stringify({ method: "turn/started", params: {
      threadId: "thread-return", turn: { id: "restored-turn", status: "inProgress", items: [] },
    } }));
    upstreamSocket.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "thread-return", turn: { id: "restored-turn", status: "completed", items: [] },
    } }));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  } finally {
    client.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

for (const scenario of [
  "snapshot", "compact", "bare-model", "inherited-tier", "inherited-effort", "native-null-effort",
  "native-canary", "native-canary-deactivate", "missing-provider", "missing-effort", "missing-tier",
  "saved-capitalized", "no-item", "later-turn", "nonterminal", "foreign-server", "foreign-turn",
  "wrong-run", "wrong-session", "unavailable", "manual", "manual-effort", "manual-tier",
  "observed-provider-change", "late-manual", "deactivate", "failed-deactivate",
])
test(`App Server restores the original native settings at turn end: ${scenario}`, async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  let upstreamSocket;
  const connected = new Promise(resolveConnection => upstream.once("connection", socket => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  const route = {
    session_id: "thread-immediate", root_session_id: "thread-immediate", client_id: "client-immediate",
    run_id: "run-immediate", run_session_id: "run-session-immediate", state: "implement",
    model: "openai-codex/gpt-5.6-terra", effort: "medium", service_tier: "default",
  };
  // Production routes can be bare model IDs and leave the native tier alone.
  // Keep these inputs distinct from the actual provider-qualified observation.
  if (["bare-model", "native-canary", "native-canary-deactivate", "missing-provider"].includes(scenario)) route.model = "gpt-5.6-terra";
  if (["inherited-tier", "native-canary", "native-canary-deactivate"].includes(scenario)) delete route.service_tier;
  if (["inherited-effort", "native-null-effort"].includes(scenario)) delete route.effort;
  const actualTier = route.service_tier ?? "priority";
  const actualEffort = scenario === "native-null-effort" ? null : "medium";
  const originalEffort = scenario.startsWith("native-canary") || scenario === "native-null-effort" ? "high" : null;
  const deactivation = ["deactivate", "native-canary-deactivate", "failed-deactivate", "foreign-server"].includes(scenario);
  const originStore = new WorkflowRouteOriginStore();
  let pending = route;
  let state = { ...route, thinking_level: route.effort, is_final: false };
  const injected = [], confirmed = [], errors = [];
  const proxy = await startCodexAppServerRouteProxy({
    workflowOriginStore: originStore,
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`,
    approvalService: {
      getState: async () => { if (state === "unavailable") throw new Error("fixture gateway unavailable"); return state; },
      restore: async () => null,
    },
    takePendingRoute: async () => {
      if (!pending) return null;
      const selected = pending;
      pending = null;
      return { route: selected, ack: async () => {} };
    },
    routeOwner: async () => ({ root_session_id: route.root_session_id, client_id: route.client_id }),
    onRouteInjected: async receipt => injected.push(receipt),
    onRouteConfirmed: async receipt => confirmed.push(receipt),
    onProtocolError: async error => errors.push(error),
  });
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  await connected;
  try {
    const receive = async label => JSON.parse(String(await Promise.race([
      once(upstreamSocket, "message"),
      new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error(`timed out waiting for ${label}`)), 500)),
    ])));
    client.send(JSON.stringify({ id: 1, method: "thread/start", params: {} }));
    assert.equal((await receive("thread/start")).method, "thread/start");
    upstreamSocket.send(JSON.stringify({ id: 1, result: {
      thread: { id: route.session_id }, modelProvider: "openai", model: "gpt-5.6-sol",
      reasoningEffort: originalEffort, serviceTier: "priority",
    } }));
    await new Promise(resolveDelay => setTimeout(resolveDelay, 5));

    client.send(JSON.stringify({ id: 2, method: "turn/start", params: {
      threadId: route.session_id, input: [], model: "gpt-5.6-sol",
    } }));
    const routed = await receive("routed turn").catch(error => {
      assert.fail(`${error.message}; protocol=${JSON.stringify(errors)}`);
    });
    assert.equal(routed.params.model, "gpt-5.6-terra");
    upstreamSocket.send(JSON.stringify({ id: 2, result: { turn: { id: "turn-immediate" } } }));
    const nativeSettings = {
        model: "gpt-5.6-terra", modelProvider: "openai", effort: actualEffort, serviceTier: actualTier,
        collaborationMode: {
          mode: "default",
          settings: { model: "gpt-5.6-terra", reasoning_effort: actualEffort, developer_instructions: "keep this" },
        },
    };
    if (scenario === "missing-provider") delete nativeSettings.modelProvider;
    if (scenario === "missing-effort") delete nativeSettings.effort;
    if (scenario === "missing-tier") delete nativeSettings.serviceTier;
    upstreamSocket.send(JSON.stringify({ method: "thread/settings/updated", params: {
      threadId: route.session_id, threadSettings: nativeSettings,
    } }));
    await new Promise(resolveDelay => setTimeout(resolveDelay, 5));

    let ownedTurnId = "turn-immediate";
    if (scenario.startsWith("missing-")) {
      assert.equal(confirmed.at(-1)?.confirmed, false, "missing native evidence is not confirmation");
      if (scenario === "missing-provider") assert.equal(confirmed.at(-1).reason, "confirmed_route_provider_unknown");
      const retained = await originStore.inspect(route.session_id);
      assert.equal(retained.status, "captured");
      assert.equal(retained.routed, null, "never manufacture a confirmed route from requested settings");
      return;
    }
    assert.equal(confirmed.at(-1)?.confirmed, true);
    assert.deepEqual((await originStore.inspect(route.session_id)).routed, {
      model: "openai-codex/gpt-5.6-terra", effort: actualEffort, service_tier: actualTier,
    }, "persist the settings-confirmed native route, not the requested route");
    if (scenario === "later-turn") {
      upstreamSocket.send(JSON.stringify({method: "turn/completed", params: {threadId: route.session_id,
        turn: {id: ownedTurnId, status: "completed", items: []}}}));
      await new Promise(resolve => setTimeout(resolve, 20));
      client.send(JSON.stringify({id: 4, method: "turn/start", params: {
        threadId: route.session_id, model: "gpt-5.6-terra", effort: "medium", input: [],
      }}));
      assert.equal((await receive("later native turn without route marker").catch(error => {
        assert.fail(`${error.message}; protocol=${JSON.stringify(errors)}`);
      })).method, "turn/start");
      ownedTurnId = "turn-later";
      upstreamSocket.send(JSON.stringify({id: 4, result: {turn: {id: ownedTurnId}}}));
    }
    state = { ...state, state: "complete", is_final: true };
    if (scenario === "nonterminal") state = {...state, state: "validate", is_final: false};
    if (deactivation) state = null;
    if (scenario === "wrong-run") state = {...state, run_id: "another-run"};
    if (scenario === "wrong-session") state = {...state, run_session_id: "another-session"};
    if (scenario === "unavailable") state = "unavailable";
    if (["manual", "manual-effort", "manual-tier"].includes(scenario)) {
      const change = scenario === "manual-effort" ? {effort: "high"}
        : scenario === "manual-tier" ? {serviceTier: "flex"} : {model: "gpt-6-astra", effort: "high"};
      client.send(JSON.stringify({id: 3, method: "thread/settings/update", params: {
        threadId: route.session_id, ...change,
      }}));
      assert.equal((await receive("manual settings")).method, "thread/settings/update");
      upstreamSocket.send(JSON.stringify({id: 3, result: {}}));
      upstreamSocket.send(JSON.stringify({method: "thread/settings/updated", params: {
        threadId: route.session_id, threadSettings: {...nativeSettings, ...change},
      }}));
    }
    if (scenario === "observed-provider-change") upstreamSocket.send(JSON.stringify({
      method: "thread/settings/updated", params: {threadId: route.session_id,
        threadSettings: {...nativeSettings, modelProvider: "other-provider"}},
    }));
    if (scenario === "snapshot") upstreamSocket.send(JSON.stringify({ method: "item/started", params: {
      threadId: route.session_id, turnId: "turn-immediate", item: {
        id: "terminal-item", type: "mcpToolCall", status: "inProgress", server: "statewright",
        tool: "statewright_transition",
      },
    } }));
    const result = scenario === "snapshot" ? {state_snapshot: state}
      : deactivation ? {deactivated: true}
      : {transitioned: true, from: "implement", to: "complete", requires_approval: false,
          approval_message: null, transition_count: 1, usage: null};
    const completedTurnId = scenario === "foreign-turn" ? "unseen-turn" : ownedTurnId;
    if (scenario !== "no-item") upstreamSocket.send(JSON.stringify({ method: "item/completed", params: {
      threadId: route.session_id, turnId: completedTurnId, item: {
        id: "terminal-item", type: scenario === "saved-capitalized" ? "McpToolCall" : "mcpToolCall",
        status: scenario === "failed-deactivate" ? "failed" : "completed",
        server: scenario === "foreign-server" ? "other-server" : "statewright",
        tool: deactivation ? "statewright_deactivate" : "statewright_transition",
        result: {structuredContent: result},
      },
    } }));
    upstreamSocket.send(JSON.stringify({method: "turn/completed", params: {threadId: route.session_id,
      turn: {id: completedTurnId, status: "completed", items: []}}}));
    if (["nonterminal", "foreign-server", "foreign-turn", "wrong-run", "wrong-session", "unavailable", "manual", "manual-effort", "manual-tier", "observed-provider-change", "failed-deactivate"].includes(scenario)) {
      const unexpected = [];
      const record = raw => unexpected.push(JSON.parse(String(raw)));
      upstreamSocket.on("message", record);
      await new Promise(resolve => setTimeout(resolve, 75));
      upstreamSocket.off("message", record);
      assert(!unexpected.some(request => request.method === "thread/settings/update"), JSON.stringify(unexpected));
      assert(!injected.some(receipt => receipt.route?.restored_original));
      if (["wrong-run", "wrong-session", "unavailable"].includes(scenario)) {
        assert(errors.some(error => /authoritative final run|fixture gateway unavailable/.test(error.message)), JSON.stringify(errors));
      }
      return;
    }
    let restoration = null;
    for (let attempt = 0; attempt < 20 && !restoration; attempt++) {
      const request = await receive("terminal restoration activity");
      if (request.method === "thread/read") {
        upstreamSocket.send(JSON.stringify({ id: request.id, result: {
          thread: { id: route.session_id, status: { type: "idle" } },
        } }));
      } else if (request.method === "thread/settings/update") restoration = request;
    }
    assert.ok(restoration, `terminal restoration request missing: ${JSON.stringify(errors)}`);
    assert.equal(restoration.method, "thread/settings/update");
    assert.deepEqual(restoration.params, {
      threadId: route.session_id, model: "gpt-5.6-sol", effort: originalEffort, serviceTier: "priority",
      collaborationMode: {
        mode: "default",
        settings: { model: "gpt-5.6-sol", reasoning_effort: originalEffort, developer_instructions: "keep this" },
      },
    });
    upstreamSocket.send(JSON.stringify({ id: restoration.id, result: {} }));
    if (scenario === "late-manual") {
      client.send(JSON.stringify({id: 8, method: "thread/settings/update", params: {
        threadId: route.session_id, model: "gpt-6-astra", effort: "high",
      }}));
      assert.equal((await receive("new manual settings during restore confirmation")).method, "thread/settings/update");
      upstreamSocket.send(JSON.stringify({id: 8, result: {}}));
    }
    upstreamSocket.send(JSON.stringify({ method: "thread/settings/updated", params: {
      threadId: route.session_id, threadSettings: {
        model: "gpt-5.6-sol", modelProvider: "openai", effort: originalEffort, serviceTier: "priority",
        collaborationMode: {
          mode: "default",
          settings: { model: "gpt-5.6-sol", reasoning_effort: originalEffort, developer_instructions: "keep this" },
        },
      },
    } }));
    for (let attempt = 0; attempt < 50 && confirmed.length < 2; attempt++) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
    }
    if (scenario === "late-manual") {
      assert.equal(confirmed.at(-1).confirmed, false);
      assert.equal(confirmed.at(-1).reason, "restoration_owner_changed");
      return;
    }
    assert.equal(injected.at(-1).route.restored_original, true);
    assert.equal(confirmed.at(-1).confirmed, true);
    assert.deepEqual(errors, []);
    const restoredCount = confirmed.length;
    upstreamSocket.send(JSON.stringify({method: "turn/completed", params: {threadId: route.session_id,
      turn: {id: completedTurnId, status: "completed", items: []}}}));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(confirmed.length, restoredCount, "a replay cannot consume restoration twice");
  } finally {
    client.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise(resolveClose => upstream.close(resolveClose));
  }
});

for (const scenario of ["final", "pending-inactive", "partial-inactive", "paused", "manual", "wrong-run", "unavailable", "unknown-effort"])
test(`App Server reconciles a persisted origin on resume: ${scenario}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-origin-resume-"));
  const binding = {thread_id: "thread-resume", root_session_id: "thread-resume", client_id: "client-resume",
    run_id: "run-resume", run_session_id: "session-resume"};
  const origin = {model: "openai-codex/gpt-5.6-sol", effort: null, service_tier: "priority"};
  const routed = {model: "openai-codex/gpt-5.6-terra", effort: "medium", service_tier: "priority"};
  const first = new WorkflowRouteOriginStore({root, clientId: binding.client_id});
  await first.capture(binding, origin);
  await first.confirmRoute(binding, routed);
  if (["pending-inactive", "partial-inactive", "manual"].includes(scenario)) await first.prepareRestore(binding, routed);
  if (scenario === "manual") await first.relinquish(binding.thread_id, ["model"], {model: origin.model});
  const store = new WorkflowRouteOriginStore({root, clientId: binding.client_id});
  const state = ["pending-inactive", "partial-inactive", "paused", "manual"].includes(scenario) ? null
    : {run_id: scenario === "wrong-run" ? "foreign-run" : binding.run_id,
        run_session_id: binding.run_session_id, state: "complete", is_final: true};
  const upstream = new WebSocketServer({host: "127.0.0.1", port: 0});
  await once(upstream, "listening");
  const requests = [], confirmed = [], errors = [];
  upstream.on("connection", socket => socket.on("message", raw => {
    const request = JSON.parse(String(raw));
    requests.push(request);
    let result = {};
    if (request.method === "thread/resume") result = {thread: {id: binding.thread_id}, modelProvider: "openai",
      model: ["partial-inactive", "manual"].includes(scenario) ? "gpt-5.6-sol" : "gpt-5.6-terra",
      ...(scenario === "unknown-effort" ? {} : {reasoningEffort: "medium"}), serviceTier: "priority"};
    if (request.method === "thread/read") result = {thread: {id: binding.thread_id, status: {type: "idle"}}};
    socket.send(JSON.stringify({id: request.id, result}));
    if (request.method === "thread/settings/update") socket.send(JSON.stringify({method: "thread/settings/updated",
      params: {threadId: binding.thread_id, threadSettings: {model: request.params.model,
        modelProvider: "openai", effort: request.params.effort, serviceTier: request.params.serviceTier}}}));
  }));
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`, workflowOriginStore: store,
    approvalService: {restore: async () => null, getState: async () => {
      if (scenario === "unavailable") throw new Error("fixture gateway unavailable");
      return state;
    }},
    onRouteConfirmed: async receipt => confirmed.push(receipt), onProtocolError: async error => errors.push(error),
  });
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  try {
    client.send(JSON.stringify({id: 1, method: "thread/resume", params: {threadId: binding.thread_id}}));
    const response = JSON.parse(String(await once(client, "message")));
    assert(!response.error);
    const restores = () => requests.filter(request => request.method === "thread/settings/update");
    if (["final", "pending-inactive", "partial-inactive"].includes(scenario)) {
      for (let attempt = 0; attempt < 100 && !confirmed.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(confirmed.length, 1, JSON.stringify(errors));
      assert.equal(confirmed[0].confirmed, true);
      assert.equal(restores().length, 1);
      assert.equal(restores()[0].params.model, "gpt-5.6-sol");
      assert(Object.hasOwn(restores()[0].params, "effort"));
      assert.equal(restores()[0].params.effort, null);
      assert.equal(await store.inspect(binding.thread_id), null);
    } else {
      await new Promise(resolve => setTimeout(resolve, 75));
      assert.equal(restores().length, 0, JSON.stringify(errors));
      assert.equal(Boolean(await store.inspect(binding.thread_id)), scenario !== "manual");
    }
  } finally {
    client.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise(resolve => upstream.close(resolve));
    await rm(root, {recursive: true, force: true});
  }
});

test("a terminal marker without matching provenance is a receipt-backed no-op", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  let upstreamSocket;
  const connected = new Promise(resolveConnection => upstream.once("connection", socket => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  let pending = {
    session_id: "thread-missing-origin", root_session_id: "thread-missing-origin", client_id: "client-missing-origin",
    run_id: "run-missing-origin", state: "complete", restore_original: true,
  };
  const injected = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`,
    takePendingRoute: async () => {
      if (!pending) return null;
      const selected = pending;
      pending = null;
      return { route: selected, ack: async () => {} };
    },
    routeOwner: async () => ({ root_session_id: "thread-missing-origin", client_id: "client-missing-origin" }),
    onRouteInjected: async receipt => injected.push(receipt),
  });
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  await connected;
  try {
    const forwarded = new Promise(resolveMessage => upstreamSocket.once("message", raw => resolveMessage(JSON.parse(String(raw)))));
    client.send(JSON.stringify({ id: 1, method: "turn/start", params: {
      threadId: "thread-missing-origin", model: "gpt-6-astra", effort: "high", input: [],
    } }));
    const request = await forwarded;
    assert.equal(request.params.model, "gpt-6-astra");
    assert.equal(request.params.effort, "high");
    assert.deepEqual(injected[0].restoration, { status: "skipped", reason: "missing_provenance" });
  } finally {
    client.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise(resolveClose => upstream.close(resolveClose));
  }
});

test("App Server routing synchronizes Desktop collaboration mode without crossing threads", () => {
  const request = {
    id: 13,
    method: "turn/start",
    params: {
      threadId: "desktop-thread",
      input: [],
      model: "gpt-5.6-terra",
      effort: "medium",
      collaborationMode: {
        mode: "default",
        settings: { model: "gpt-5.6-terra", reasoning_effort: "medium", developer_instructions: "keep this" },
      },
    },
  };
  const route = { session_id: "desktop-thread", model: "openai-codex/gpt-6-astra", effort: "xhigh" };
  const { message, receipt } = applyRouteToTurnStart(request, route);
  assert.equal(message.params.model, "gpt-6-astra");
  assert.equal(message.params.effort, "xhigh");
  assert.deepEqual(message.params.collaborationMode, {
    mode: "default",
    settings: { model: "gpt-6-astra", reasoning_effort: "xhigh", developer_instructions: "keep this" },
  });
  assert.equal(receipt.collaborationModeApplied, true);
  assert.equal(settingsConfirmRoute(receipt, {
    method: "thread/settings/updated",
    params: { threadId: "desktop-thread", threadSettings: {
      model: "gpt-6-astra", modelProvider: "openai", effort: "xhigh",
      collaborationMode: { settings: { model: "gpt-6-astra", reasoning_effort: "xhigh" } },
    } },
  }).confirmed, true);
  const untouched = applyRouteToTurnStart({ ...request, params: { ...request.params, threadId: "other-thread" } }, route);
  assert.equal(untouched.receipt, null);
  assert.equal(untouched.message.params.collaborationMode.settings.model, "gpt-5.6-terra");
});

test("App Server routing preserves the Statewright-selected provider route", () => {
  const route = {
    session_id: "thread-1",
    model: "local_compatible/local-code-model",
    effort: "low",
    model_ladder: [
      { model: "local_compatible/local-code-model", thinking_level: "low" },
      { model: "openai-codex/gpt-5.6-luna", thinking_level: "low" },
    ],
  };
  const local = applyRouteToTurnStart({
    id: 12, method: "turn/start", params: { threadId: "thread-1", input: [] },
  }, route, "local_compatible");
  assert.equal(local.message.params.model, "local-code-model");
  assert.equal(local.message.params.effort, "low");
  const cloud = applyRouteToTurnStart({
    id: 13, method: "turn/start", params: { threadId: "thread-1", input: [] },
  }, route, "openai");
  assert.equal(cloud.message.params.model, "local-code-model");
  assert.equal(cloud.message.params.effort, "low");
});

test("App Server routing converts the Casa workflow route into the installed Qwen provider", () => {
  const { message, receipt } = applyRouteToTurnStart({
    id: 14, method: "turn/start", params: { threadId: "thread-1", input: [] },
  }, {
      session_id: "thread-1",
      model: "casa/qwen3.8-27b",
      model_ladder: [
        { model: "casa/qwen3.8-27b", requires_provider_switch: true },
        { model: "openai-codex/gpt-5.6-terra" },
      ],
  });
  assert.equal(message.params.model, "qwen3.8-27b");
  assert.equal(receipt.effectiveProvider, "qwen_private");
  assert.equal(receipt.providerConfig["model_providers.qwen_private"].wire_api, "responses");
});

test("App Server expands the plugin root only for trusted plugin hook commands", () => {
  const sourcePath = "/tmp/codex-home/plugins/cache/personal/statewright/0.3.3/hooks/hooks.json";
  const result = expandPluginRootHookCommands({
    result: {
      data: [{ hooks: [{ command: "bash \"$PLUGIN_ROOT/hook.sh\" stop", sourcePath }] }],
    },
  });
  assert.equal(result.result.data[0].hooks[0].command, "bash \"/tmp/codex-home/plugins/cache/personal/statewright/0.3.3/hook.sh\" stop");
});

test("App Server preserves an explicit thread/list cwd but global discovery passes no scope", () => {
  assert.deepEqual(applyThreadListCwd({ id: 0, method: "thread/list", params: { limit: 20 } }, null), {
    id: 0,
    method: "thread/list",
    params: { limit: 20 },
  });
  assert.deepEqual(applyThreadListCwd({ id: 1, method: "thread/list", params: { limit: 20 } }, "/repo"), {
    id: 1,
    method: "thread/list",
    params: { limit: 20, cwd: "/repo" },
  });
  assert.deepEqual(applyThreadListCwd({ id: 2, method: "thread/list", params: { cwd: ["/other"] } }, "/repo"), {
    id: 2,
    method: "thread/list",
    params: { cwd: ["/other"] },
  });
  assert.deepEqual(applyThreadListCwd({ id: 3, method: "model/list", params: {} }, "/repo"), {
    id: 3,
    method: "model/list",
    params: {},
  });
});

test("resume rows replace stale titles with only the original directory and last submitted input", () => {
  const source = {
    id: 1,
    result: {
      data: [
        { id: "auldwyrm", cwd: "/home/tester/dev/auldwyrm", name: "auldwyrm", status: { type: "active" } },
        { id: "resume", cwd: "/home/tester/dev/resume", name: "Frame faith alignment", status: { type: "notLoaded" } },
        { id: "legacy", cwd: null, preview: "Untouched legacy entry" },
        { id: "fallback", cwd: "/home/tester/dev/nomad", name: null, preview: "What is next?" },
      ],
    },
  };
  const metadata = {
    auldwyrm: { cwd: "/home/tester/dev/auldwyrm", lastUserMessage: "fix statewright_get_state please" },
    resume: { cwd: "/home/tester/dev/resume", lastUserMessage: "My latest\nmessage" },
    fallback: { cwd: "/home/tester/dev/nomad", lastUserMessage: "Read-only validation, please" },
  };
  const labelled = labelThreadListResponse(source, "/home/tester", {}, metadata);
  assert.equal(labelled.result.data.length, 3, "omit sessions without submitted input, never use stale titles");
  assert.equal(labelled.result.data[0].name, "[~/dev/auldwyrm] fix statewright_get_state please");
  assert.equal(labelled.result.data[1].name, "[~/dev/resume] My latest message");
  assert.equal(labelled.result.data[2].preview, "[~/dev/nomad] Read-only validation, please");
  assert.equal(labelled.result.data[0].id, "auldwyrm");
  assert.equal(labelled.result.data[0].status.type, "active");
  assert.equal(labelThreadListResponse(labelled, "/home/tester", {}, metadata), labelled);
  assert.equal(labelThreadListResponse(source, "/home/tester", { "codex:auldwyrm": { label: "adv" } }, metadata).result.data[0].name, labelled.result.data[0].name);
  assert.equal(source.result.data[0].name, "auldwyrm", "display changes must not mutate saved metadata");
  const onlyFork = {result: {data: [source.result.data[0]], nextCursor: "page-2"}};
  const hidden = labelThreadListResponse(onlyFork, "/home/tester", {}, {auldwyrm: {...metadata.auldwyrm, threadSource: "subagent"}});
  assert.deepEqual(hidden.result, {data: [], nextCursor: "page-2"});
});

test("Codex rollout metadata provides each session's launch checkout", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-rollout-cwd-"));
  try {
    const sessionId = "01a062c6-560d-70d1-8d39-40db71875a69";
    const sessions = join(home, ".codex", "sessions", "2026", "09", "02");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, `rollout-2026-09-02T11-39-20-${sessionId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: "/home/tester/dev/resume" } })}\n{"type":"event_msg"}\n`);
    const metadataCache = new Map();
    const read = () => readCodexThreadCwds({ home, threadIds: [sessionId], metadataCache });
    assert.deepEqual(await read(), { [sessionId]: { cwd: "/home/tester/dev/resume", lastUserMessage: null, threadSource: null } });
    const history = join(home, ".codex", "history.jsonl");
    await writeFile(history, JSON.stringify({session_id: sessionId, ts: 1, text: "First prompt"}) + "\n");
    assert.equal((await read())[sessionId].lastUserMessage, "First prompt");
    await writeFile(history, JSON.stringify({session_id: sessionId, ts: 2, text: "Please use statewright_get_state"}) + "\n{partial", {flag: "a"});
    assert.equal((await read())[sessionId].lastUserMessage, "Please use statewright_get_state", "cached cwd must not freeze the latest submitted input");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Codex rollout metadata restores the latest effective resume permissions", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-rollout-permissions-"));
  try {
    const sessionId = "01a062c6-560d-70d1-8d39-40db71875a69";
    const sessions = join(home, ".codex", "sessions", "2026", "09", "02");
    await mkdir(sessions, { recursive: true });
    const records = [
      { type: "session_meta", payload: { id: sessionId, cwd: "/workspace/original" } },
      { type: "turn_context", payload: { approval_policy: "on-request", approvals_reviewer: "user", sandbox_policy: { type: "read-only" }, cwd: "/workspace/original", workspace_roots: ["/workspace/original"] } },
      { type: "event_msg", payload: { type: "thread_settings_applied", thread_id: sessionId, thread_settings: { approval_policy: "never", approvals_reviewer: "user", permission_profile: { type: "disabled" }, cwd: "/workspace/current", runtime_workspace_roots: ["/workspace/current", "/workspace/shared"] } } },
    ];
    await writeFile(join(sessions, `rollout-2026-09-02T11-39-20-${sessionId}.jsonl`), `${records.map(JSON.stringify).join("\n")}\n`);
    assert.deepEqual(await readCodexResumePermissions({ home, threadId: sessionId }), {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      cwd: "/workspace/current",
      runtimeWorkspaceRoots: ["/workspace/current", "/workspace/shared"],
      sandbox: "danger-full-access",
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Codex rollout permission restore uses named profiles and rejects lossy legacy projection", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-rollout-profile-"));
  const sessionId = "01a062c6-560d-70d1-8d39-40db71875a69";
  const path = join(home, ".codex", "sessions", "2026", "09", "02", `rollout-2026-09-02T11-39-20-${sessionId}.jsonl`);
  try {
    await mkdir(join(path, ".."), { recursive: true });
    const write = settings => writeFile(path, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: "/workspace/project" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_id: sessionId, thread_settings: settings } })}\n`);
    await write({ approval_policy: "on-request", active_permission_profile: { id: ":workspace" }, permission_profile: { type: "managed" }, cwd: "/workspace/project" });
    assert.deepEqual(await readCodexResumePermissions({ home, threadId: sessionId }), {
      approvalPolicy: "on-request", cwd: "/workspace/project", permissions: ":workspace",
    });
    await write({ approval_policy: "on-request", permission_profile: { type: "managed", network: "restricted", file_system: { type: "restricted", entries: [] } }, sandbox_policy: { type: "workspace-write" }, cwd: "/workspace/project" });
    await assert.rejects(readCodexResumePermissions({ home, threadId: sessionId }), /cannot losslessly restore this legacy Codex permission profile/);
    await write({ approval_policy: "on-request", sandbox_policy: { type: "external-sandbox", network_access: true }, cwd: "/workspace/project" });
    await assert.rejects(readCodexResumePermissions({ home, threadId: sessionId }), /cannot losslessly restore this legacy Codex permission profile/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("restored resume permissions fill only omitted native request fields", () => {
  const request = { id: 4, method: "thread/resume", params: {
    threadId: "thread-1", approvalPolicy: null, approvalsReviewer: null,
    permissions: null, sandbox: null, cwd: null, runtimeWorkspaceRoots: null,
  } };
  assert.deepEqual(applyRestoredResumePermissions(request, {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "danger-full-access",
    cwd: "/workspace/project",
    runtimeWorkspaceRoots: ["/workspace/project"],
  }), {
    id: 4,
    method: "thread/resume",
    params: {
      threadId: "thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      permissions: null,
      sandbox: "danger-full-access",
      cwd: "/workspace/project",
      runtimeWorkspaceRoots: ["/workspace/project"],
    },
  });
  assert.deepEqual(applyRestoredResumePermissions({
    id: 5, method: "thread/resume", params: {
      threadId: "thread-1", approvalPolicy: "on-request", permissions: ":read-only",
      sandbox: null, cwd: "/workspace/new", runtimeWorkspaceRoots: null,
    },
  }, {
    approvalPolicy: "never", permissions: ":workspace", sandbox: "danger-full-access",
    cwd: "/workspace/old", runtimeWorkspaceRoots: ["/workspace/old"],
  }).params, {
    threadId: "thread-1", approvalPolicy: "on-request", permissions: ":read-only",
    sandbox: null, cwd: "/workspace/new", runtimeWorkspaceRoots: null,
  });
  assert.deepEqual(applyRestoredResumePermissions({
    id: 6, method: "thread/resume", params: { threadId: "thread-1", permissions: null, sandbox: "read-only" },
  }, { permissions: ":workspace" }).params, {
    threadId: "thread-1", permissions: null, sandbox: "read-only",
  });
  const other = { id: 5, method: "thread/read", params: { threadId: "thread-1" } };
  assert.equal(applyRestoredResumePermissions(other, { sandbox: "read-only" }), other);
});

test("explicit Yolo resume permissions override saved settings only for the bound thread", async () => {
  const source = { id: 1, method: "thread/resume", params: { threadId: "thread-yolo", approvalPolicy: "on-request", permissions: ":read-only" } };
  assert.deepEqual(applyExplicitYoloResumePermissions(source, "thread-yolo").params, {
    threadId: "thread-yolo", approvalPolicy: "never", permissions: null, sandbox: "danger-full-access",
  });
  assert.equal(source.params.approvalPolicy, "on-request", "the native input remains unchanged");
  assert.throws(() => applyExplicitYoloResumePermissions(source, "foreign-thread"), /different thread/);
  assert.equal(applyExplicitYoloResumePermissions({ method: "thread/start", params: {} }, "thread-yolo").params.sandbox,
    "danger-full-access", "the original global CLI flag applies to new threads in this TUI");

  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(upstream, "listening");
  const connected = new Promise(resolveConnection => upstream.once("connection", resolveConnection));
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`,
    compactResume: false,
    resolveResumePermissions: async () => { throw new Error("saved profile is unrepresentable"); },
  });
  const client = new WebSocket(`${proxy.url}/?statewright_resume_yolo_thread=thread-yolo`);
  try {
    await once(client, "open");
    const upstreamSocket = await connected;
    const forwarded = new Promise(resolveMessage => upstreamSocket.once("message", raw => resolveMessage(JSON.parse(String(raw)))));
    client.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "thread-yolo" } }));
    assert.deepEqual((await forwarded).params, {
      threadId: "thread-yolo", approvalPolicy: "never", permissions: null, sandbox: "danger-full-access",
    });
  } finally {
    client.terminate();
    await proxy.close();
    await new Promise(resolveClose => upstream.close(resolveClose));
  }
});

test("Codex resume location ignores copied parent turn contexts", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-rollout-fork-location-"));
  const sessionId = "01a062c6-560d-70d1-8d39-40db71875a69";
  const path = join(home, ".codex", "sessions", "2026", "09", "02", `rollout-2026-09-02T11-39-20-${sessionId}.jsonl`);
  try {
    await mkdir(join(path, ".."), { recursive: true });
    const records = [
      { type: "session_meta", payload: { id: sessionId, cwd: "/workspace/child", runtime_workspace_roots: ["/workspace/child"] } },
      { type: "turn_context", payload: { approval_policy: "on-request", sandbox_policy: { type: "read-only" }, cwd: "/workspace/parent", workspace_roots: ["/workspace/parent"] } },
    ];
    await writeFile(path, `${records.map(JSON.stringify).join("\n")}\n`);
    assert.deepEqual(await readCodexResumePermissions({ home, threadId: sessionId }), {
      approvalPolicy: "on-request", sandbox: "read-only", cwd: "/workspace/child",
      runtimeWorkspaceRoots: ["/workspace/child"],
    });
    records.push(
      { type: "event_msg", payload: { type: "thread_settings_applied", thread_id: sessionId, thread_settings: { approval_policy: "never", permission_profile: { type: "disabled" }, cwd: "/workspace/child-next", runtime_workspace_roots: ["/workspace/child-next"] } } },
      { type: "turn_context", payload: { approval_policy: "on-request", sandbox_policy: { type: "read-only" }, cwd: "/workspace/parent-next", workspace_roots: ["/workspace/parent-next"] } },
    );
    await writeFile(path, `${records.map(JSON.stringify).join("\n")}\n`);
    assert.deepEqual(await readCodexResumePermissions({ home, threadId: sessionId }), {
      approvalPolicy: "on-request", sandbox: "read-only", cwd: "/workspace/child-next",
      runtimeWorkspaceRoots: ["/workspace/child-next"],
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("App Server proxy restores saved permissions before forwarding resume", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  let socket;
  const connected = new Promise(resolve => upstream.once("connection", value => { socket = value; resolve(); }));
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`,
    resolveResumePermissions: async threadId => {
      assert.equal(threadId, "historical-thread");
      return { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" };
    },
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    await connected;
    const forwarded = once(socket, "message");
    client.send(JSON.stringify({ id: 1, method: "thread/resume", params: {
      threadId: "historical-thread", approvalPolicy: null, approvalsReviewer: null,
      permissions: null, sandbox: null, cwd: null, runtimeWorkspaceRoots: null,
    } }));
    assert.deepEqual(JSON.parse(String(await forwarded)).params, {
      threadId: "historical-thread",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      permissions: null,
      sandbox: "danger-full-access",
      cwd: null,
      runtimeWorkspaceRoots: null,
      excludeTurns: true,
      initialTurnsPage: { limit: 4, sortDirection: "desc", itemsView: "summary" },
    });
  } finally {
    client.close();
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test("resident proxy retires after its last idle TUI disconnects", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let idleCalls = 0;
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
    idleMs: 10,
    onIdle: async () => { idleCalls += 1; resolveIdle(); },
  });
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  client.close();
  await idle;
  assert.equal(idleCalls, 1);
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("resident proxy preserves a detached active turn until it completes", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let upstreamSocket;
  const upstreamConnection = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  let idleCalls = 0;
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
    idleMs: 10,
    onIdle: async () => { idleCalls += 1; resolveIdle(); },
  });
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  await upstreamConnection;
  const active = once(client, "message");
  upstreamSocket.send(JSON.stringify({ method: "thread/status/changed", params: { threadId: "thread-1", status: { type: "active" } } }));
  await active;
  client.close();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  assert.equal(idleCalls, 0);
  upstreamSocket.send(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1" } }));
  await idle;
  assert.equal(idleCalls, 1);
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("resident proxy preserves a submitted turn before its activity acknowledgement", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let upstreamSocket;
  const upstreamConnection = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  let idleCalls = 0;
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
    idleMs: 10,
    onIdle: async () => { idleCalls += 1; resolveIdle(); },
  });
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  await upstreamConnection;
  const submitted = once(upstreamSocket, "message");
  client.send(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-1", input: [] } }));
  await submitted;
  client.terminate();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  assert.equal(idleCalls, 0);
  assert.equal(upstreamSocket.readyState, WebSocket.OPEN);
  upstreamSocket.send(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1" } }));
  await idle;
  assert.equal(idleCalls, 1);
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("resident proxy clears provisional activity when turn submission is rejected", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let upstreamSocket;
  const upstreamConnection = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
    idleMs: 10,
    onIdle: async () => resolveIdle(),
  });
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  await upstreamConnection;
  const submitted = once(upstreamSocket, "message");
  client.send(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-1", input: [] } }));
  await submitted;
  const rejected = once(client, "message");
  upstreamSocket.send(JSON.stringify({ id: 1, error: { code: -32600, message: "rejected" } }));
  await rejected;
  client.close();
  await idle;
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("resident proxy cancels pending idle retirement when a TUI reconnects", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let idleCalls = 0;
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
    idleMs: 30,
    onIdle: async () => { idleCalls += 1; resolveIdle(); },
  });
  const first = new WebSocket(proxy.url);
  await once(first, "open");
  first.close();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  const second = new WebSocket(proxy.url);
  await once(second, "open");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
  assert.equal(idleCalls, 0);
  second.close();
  await idle;
  assert.equal(idleCalls, 1);
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("resident proxy keeps JSON-RPC request correlation local to each TUI", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  const upstreamSockets = [];
  upstream.on("connection", (socket) => upstreamSockets.push(socket));
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => null,
  });
  const first = new WebSocket(proxy.url);
  await once(first, "open");
  while (upstreamSockets.length < 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
  const second = new WebSocket(proxy.url);
  await once(second, "open");
  while (upstreamSockets.length < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
  const forwardedRequests = upstreamSockets.map((socket) => once(socket, "message"));
  first.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "thread-a" } }));
  second.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "thread-b" } }));
  await Promise.all(forwardedRequests);
  const firstResponse = once(first, "message");
  const secondResponse = once(second, "message");
  upstreamSockets[0].send(JSON.stringify({ id: 1, result: { thread: { id: "thread-a", turns: [] }, initialTurnsPage: { data: [{ id: "a" }] } } }));
  upstreamSockets[1].send(JSON.stringify({ id: 1, result: { thread: { id: "thread-b", turns: [] }, initialTurnsPage: { data: [{ id: "b" }] } } }));
  assert.deepEqual(JSON.parse(String(await firstResponse)).result.thread.turns, [{ id: "a" }]);
  assert.deepEqual(JSON.parse(String(await secondResponse)).result.thread.turns, [{ id: "b" }]);
  first.close();
  second.close();
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("compact resume requests server-supported metadata and bounded recent history", () => {
  const request = { id: 4, method: "thread/resume", params: { threadId: "thread-1", initialTurnsPage: { limit: 200 } } };
  assert.deepEqual(applyCompactResumeRequest(request), {
    id: 4,
    method: "thread/resume",
    params: { threadId: "thread-1", excludeTurns: true, initialTurnsPage: { limit: 4, sortDirection: "desc", itemsView: "summary" } },
  });
  assert.deepEqual(applyCompactResumeRequest(request, true, 2).params.initialTurnsPage, { limit: 2, sortDirection: "desc", itemsView: "summary" });
  assert.equal(applyCompactResumeRequest(request, false), request);
  const readRequest = { id: 4, method: "thread/read", params: {} };
  assert.equal(applyCompactResumeRequest(readRequest), readRequest);
});

test("bounded resume pages are normalized for the native Codex transcript surface", () => {
  const response = {
    id: 4,
    result: {
      thread: { id: "thread-1", turns: [] },
      initialTurnsPage: { data: [{ id: "newest" }, { id: "older" }] },
    },
  };
  assert.deepEqual(hydrateBoundedResumeTurns(response).result.thread.turns, [{ id: "older" }, { id: "newest" }]);
  assert.equal(hydrateBoundedResumeTurns({ result: { thread: { turns: [{ id: "existing" }] } } }).result.thread.turns[0].id, "existing");
});

test("active-writer resume errors preserve the native refusal and explain when to retry", () => {
  const response = {
    id: 4,
    error: {
      code: -32600,
      message: "thread thread-1 already has an active writer",
      data: { threadId: "thread-1" },
    },
  };
  const clarified = clarifyActiveWriterResumeError(response);
  assert.equal(clarified.error.code, -32600);
  assert.deepEqual(clarified.error.data, { threadId: "thread-1" });
  assert.match(clarified.error.message, /^thread thread-1 already has an active writer\b/);
  assert.match(clarified.error.message, /wait a minute or two for the current turn to finish, then try again/i);
  assert.match(clarified.error.message, /if it still fails, close the other Codex client or recover the stale managed session/i);
  assert.equal(clarifyActiveWriterResumeError(clarified), clarified);
  const unrelated = { id: 5, error: { code: -32600, message: "thread not found" } };
  assert.equal(clarifyActiveWriterResumeError(unrelated), unrelated);
});

test("App Server route proxy keeps a pending route when upstream forwarding fails", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  let acknowledged = 0;
  const protocolErrors = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
    takePendingRoute: async () => ({
      route: { session_id: "thread-send-failure", model: "openai-codex/gpt-5.6-sol" },
      ack: async () => { acknowledged += 1; },
    }),
    forwardPayload: async () => { throw new Error("synthetic upstream send failure"); },
    onProtocolError: async (error) => protocolErrors.push(error),
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    const closed = once(client, "close");
    client.send(JSON.stringify({
      id: 1,
      method: "turn/start",
      params: { threadId: "thread-send-failure", input: [] },
    }));
    await closed;
    assert.equal(acknowledged, 0);
    assert.match(protocolErrors[0].message, /synthetic upstream send failure/);
  } finally {
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("App Server route proxy reserves a pending route until forwarding acknowledges it", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  let pending = { session_id: "thread-race", model: "openai-codex/gpt-5.6-sol" };
  let releaseFirstForward;
  const firstForwardBlocked = new Promise((resolveForward) => { releaseFirstForward = resolveForward; });
  let firstForwardStarted;
  const firstForwarding = new Promise((resolveStarted) => { firstForwardStarted = resolveStarted; });
  const forwarded = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
    takePendingRoute: async (threadId) => pending?.session_id === threadId ? {
      route: pending,
      ack: async () => { pending = null; },
    } : null,
    forwardPayload: async (_socket, payload) => {
      forwarded.push(JSON.parse(payload));
      if (forwarded.length === 1) {
        firstForwardStarted();
        await firstForwardBlocked;
      }
    },
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    client.send(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-race", input: [] } }));
    await firstForwarding;
    client.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thread-race", input: [] } }));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    assert.equal(forwarded.length, 1);
    releaseFirstForward();
    for (let attempt = 0; attempt < 100 && forwarded.length < 2; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    assert.equal(forwarded.length, 2);
    assert.equal(forwarded[0].params.model, "gpt-5.6-sol");
    assert.equal(forwarded[1].params.model, undefined);
  } finally {
    releaseFirstForward?.();
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("App Server route proxy quarantines a route after post-forward acknowledgement failure", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  let reserved = false;
  let releaseCount = 0;
  let releaseFirstForward;
  const firstForwardBlocked = new Promise((resolveForward) => { releaseFirstForward = resolveForward; });
  let firstForwardStarted;
  const firstForwarding = new Promise((resolveStarted) => { firstForwardStarted = resolveStarted; });
  const forwarded = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
    takePendingRoute: async () => {
      if (reserved) return null;
      reserved = true;
      return {
        route: { session_id: "thread-ack-failure", model: "openai-codex/gpt-5.6-sol" },
        ack: async () => { throw new Error("synthetic acknowledgement failure"); },
        release: async () => { reserved = false; releaseCount += 1; },
      };
    },
    forwardPayload: async (_socket, payload) => {
      forwarded.push(JSON.parse(payload));
      if (forwarded.length === 1) {
        firstForwardStarted();
        await firstForwardBlocked;
      }
    },
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    const closed = once(client, "close");
    client.send(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-ack-failure", input: [] } }));
    await firstForwarding;
    client.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thread-ack-failure", input: [] } }));
    releaseFirstForward();
    await closed;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].params.model, "gpt-5.6-sol");
    assert.equal(releaseCount, 0);
  } finally {
    releaseFirstForward?.();
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("App Server route proxy injects one pending route and records the server receipt", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  const injected = [];
  const confirmed = [];
  let acknowledged = 0;
  let pending = { session_id: "thread-proxy", model: "openai-codex/gpt-5.6-sol", effort: "high" };
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
    getThreadCwds: async () => ({ "thread-proxy": {cwd: "/repo", lastUserMessage: "Latest input"} }),
    takePendingRoute: async (threadId) => {
      if (pending?.session_id !== threadId) return null;
      const route = pending;
      pending = null;
      return { route, ack: async () => { acknowledged += 1; } };
    },
    onRouteInjected: async (receipt) => injected.push(receipt),
    onRouteConfirmed: async (receipt) => confirmed.push(receipt),
  });
  let upstreamSocket;
  const upstreamConnection = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  await upstreamConnection;
  assert.equal((await fetch(`${proxy.url.replace("ws:", "http:")}/readyz`)).status, 200);
  assert.equal((await fetch(`${proxy.url.replace("ws:", "http:")}/healthz`)).status, 200);
  const listForwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: -1, method: "thread/list", params: { limit: 20 } }));
  assert.deepEqual(await listForwarded, { id: -1, method: "thread/list", params: { limit: 20 } });
  const labelledList = new Promise((resolveMessage) => client.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  upstreamSocket.send(JSON.stringify({
    id: -1,
    result: { data: [{ id: "thread-proxy", cwd: "/repo", name: "Project session", status: { type: "notLoaded" } }] },
  }));
  assert.deepEqual(await labelledList, {
    id: -1,
    result: { data: [{ id: "thread-proxy", cwd: "/repo", name: "[/repo] Latest input", preview: "[/repo] Latest input", status: { type: "notLoaded" } }] },
  });
  const childForwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 0, method: "turn/start", params: { threadId: "child-thread", input: [] } }));
  const childRequest = await childForwarded;
  assert.equal(childRequest.params.model, undefined);
  assert.equal(injected.length, 0);
  const forwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-proxy", input: [] } }));
  const request = await forwarded;
  assert.equal(request.params.model, "gpt-5.6-sol");
  assert.equal(request.params.effort, "high");
  assert.equal(injected.length, 1);
  assert.equal(acknowledged, 1);
  upstreamSocket.send(JSON.stringify({
    method: "thread/settings/updated",
    params: { threadId: "thread-proxy", threadSettings: { model: "gpt-5.6-sol", modelProvider: "openai", effort: "high" } },
  }));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  assert.deepEqual(confirmed.map(({ confirmed: value }) => value), [true]);
  const nativeResponse = new Promise((resolveMessage) => client.once("message", (raw, isBinary) => {
    resolveMessage({ message: JSON.parse(String(raw)), isBinary });
  }));
  upstreamSocket.send(JSON.stringify({ id: 1, result: { ok: true } }));
  assert.deepEqual(await nativeResponse, { message: { id: 1, result: { ok: true } }, isBinary: false });
  const forwardedResume = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "thread-proxy", initialTurnsPage: { limit: 100 } } }));
  assert.deepEqual(await forwardedResume, {
    id: 2,
    method: "thread/resume",
    params: { threadId: "thread-proxy", excludeTurns: true, initialTurnsPage: { limit: 4, sortDirection: "desc", itemsView: "summary" } },
  });
  const compactResumeResponse = new Promise((resolveMessage) => client.once("message", (raw, isBinary) => {
    resolveMessage({ message: JSON.parse(String(raw)), isBinary });
  }));
  upstreamSocket.send(JSON.stringify({ id: 2, result: { thread: { id: "thread-proxy", turns: [] }, initialTurnsPage: { data: [{ id: "newest" }, { id: "older" }] } } }));
  assert.deepEqual(await compactResumeResponse, {
    message: { id: 2, result: { thread: { id: "thread-proxy", turns: [{ id: "older" }, { id: "newest" }] }, initialTurnsPage: { data: [{ id: "newest" }, { id: "older" }] } } },
    isBinary: false,
  });
  const rejectedResumeForwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 3, method: "thread/resume", params: { threadId: "thread-proxy" } }));
  assert.equal((await rejectedResumeForwarded).method, "thread/resume");
  const rejectedResumeResponse = new Promise((resolveMessage) => client.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  upstreamSocket.send(JSON.stringify({ id: 3, error: { code: -32600, message: "thread thread-proxy already has an active writer" } }));
  const rejected = await rejectedResumeResponse;
  assert.equal(rejected.error.code, -32600);
  assert.match(rejected.error.message, /wait a minute or two for the current turn to finish, then try again/i);
  const nonResumeForwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 4, method: "thread/read", params: { threadId: "thread-proxy" } }));
  assert.equal((await nonResumeForwarded).method, "thread/read");
  const nonResumeResponse = new Promise((resolveMessage) => client.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  const nativeNonResumeError = { id: 4, error: { code: -32600, message: "thread thread-proxy already has an active writer" } };
  upstreamSocket.send(JSON.stringify(nativeNonResumeError));
  assert.deepEqual(await nonResumeResponse, nativeNonResumeError);
  client.close();
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("App Server route proxy switches an idle OpenAI thread to Casa Qwen before forwarding the next turn", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let pending = { session_id: "thread-qwen", model: "casa/qwen3.8-27b", effort: "low" };
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async (threadId) => {
      if (pending?.session_id !== threadId) return null;
      const route = pending;
      pending = null;
      return { route, ack: async () => {} };
    },
  });
  let socket;
  const connected = new Promise((resolveConnected) => upstream.once("connection", (value) => { socket = value; resolveConnected(); }));
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  await connected;
  try {
    const resumed = new Promise((resolveMessage) => socket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
    client.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "thread-qwen" } }));
    const resumeRequest = await resumed;
    socket.send(JSON.stringify({ id: 1, result: { modelProvider: "openai", model: "gpt-5.6-terra", thread: { id: "thread-qwen", modelProvider: "openai", model: "gpt-5.6-terra", turns: [] } } }));
    await once(client, "message");
    const unsubscribe = new Promise((resolveMessage) => socket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
    client.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thread-qwen", input: [] } }));
    assert.equal(resumeRequest.method, "thread/resume");
    assert.deepEqual(await unsubscribe, { jsonrpc: "2.0", id: "statewright-provider-switch-1", method: "thread/unsubscribe", params: { threadId: "thread-qwen" } });
    socket.send(JSON.stringify({ id: "statewright-provider-switch-1", result: {} }));
    const localResume = await new Promise((resolveMessage) => socket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
    assert.equal(localResume.method, "thread/resume");
    assert.equal(localResume.params.modelProvider, "qwen_private");
    assert.equal(localResume.params.model, "qwen3.8-27b");
    assert.equal(localResume.params.config["model_providers.qwen_private"].wire_api, "responses");
    socket.send(JSON.stringify({ id: "statewright-provider-switch-2", result: { modelProvider: "qwen_private", model: "qwen3.8-27b", thread: { id: "thread-qwen" } } }));
    const routedTurn = await new Promise((resolveMessage) => socket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
    assert.equal(routedTurn.method, "turn/start");
    assert.equal(routedTurn.params.model, "qwen3.8-27b");
    assert.equal(routedTurn.params.effort, "low");
  } finally {
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("App Server route rejection keeps the native connection usable", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    takePendingRoute: async () => ({ route: { session_id: "thread-retry", model: "casa/qwen3.8-27b" }, release: async () => {} }),
  });
  let socket;
  const connected = new Promise((resolveConnected) => upstream.once("connection", (value) => { socket = value; resolveConnected(); }));
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  await connected;
  try {
    client.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "thread-retry" } }));
    await new Promise((resolveMessage) => socket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
    socket.send(JSON.stringify({ id: 1, result: { modelProvider: "openai", model: "gpt-5.6-terra", thread: { id: "thread-retry" } } }));
    await once(client, "message");
    const reply = new Promise((resolveMessage) => client.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
    client.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "thread-retry", input: [] } }));
    await new Promise((resolveMessage) => socket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
    socket.send(JSON.stringify({ id: "statewright-provider-switch-1", result: {} }));
    await new Promise((resolveMessage) => socket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
    socket.send(JSON.stringify({ id: "statewright-provider-switch-2", result: { modelProvider: "openai", model: "gpt-5.6-terra", thread: { id: "thread-retry" } } }));
    await new Promise((resolveMessage) => socket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
    socket.send(JSON.stringify({ id: "statewright-provider-switch-3", result: { modelProvider: "openai", model: "gpt-5.6-terra", thread: { id: "thread-retry" } } }));
    const rejected = await reply;
    assert.equal(rejected.id, 2);
    assert.match(rejected.error.message, /route was not applied/i);
    assert.equal(client.readyState, WebSocket.OPEN);
    const forwarded = new Promise((resolveMessage) => socket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
    client.send(JSON.stringify({ id: 3, method: "thread/list", params: {} }));
    assert.equal((await forwarded).method, "thread/list");
  } finally {
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("App Server route proxy binds a bare-picker selection and refreshes labels on subsequent lists", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  const labels = {};
  const resumed = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
    getThreadLabels: async () => labels,
    getThreadCwds: async () => ({ "picker-thread": {cwd: "/repo", lastUserMessage: "My latest input"} }),
    onThreadResumed: async ({ threadId }) => {
      resumed.push(threadId);
      labels[`codex:${threadId}`] = { label: "adv" };
    },
  });
  const upstreamConnection = new Promise((resolveConnection) => upstream.once("connection", resolveConnection));
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  const upstreamSocket = await upstreamConnection;
  const resumeForwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "picker-thread" } }));
  assert.equal((await resumeForwarded).method, "thread/resume");
  const resumeResult = new Promise((resolveMessage) => client.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  upstreamSocket.send(JSON.stringify({ id: 1, result: { thread: { id: "picker-thread" } } }));
  await resumeResult;
  assert.deepEqual(resumed, ["picker-thread"]);
  const listForwarded = new Promise((resolveMessage) => upstreamSocket.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  client.send(JSON.stringify({ id: 2, method: "thread/list", params: {} }));
  await listForwarded;
  const listResult = new Promise((resolveMessage) => client.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  upstreamSocket.send(JSON.stringify({ id: 2, result: { data: [{ id: "picker-thread", cwd: "/repo", name: "Selected session" }] } }));
  assert.equal((await listResult).result.data[0].name, "[/repo] My latest input");
  client.close();
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});

test("App Server thread/start binds ownership before reporting native success and fails closed on conflict", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const started = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`,
    onThreadStarted: async ({ threadId }) => {
      started.push(threadId);
      if (threadId === "foreign-root") throw new Error("managed identity conflict");
    },
  });
  const connection = new Promise((resolveConnection) => upstream.once("connection", resolveConnection));
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    const socket = await connection;
    for (const [id, threadId] of [[1, "new-root"], [2, "foreign-root"]]) {
      const forwarded = new Promise((resolveMessage) => socket.once("message", raw => resolveMessage(JSON.parse(String(raw)))));
      client.send(JSON.stringify({ id, method: "thread/start", params: {} }));
      assert.equal((await forwarded).method, "thread/start");
      const response = new Promise((resolveMessage) => client.once("message", raw => resolveMessage(JSON.parse(String(raw)))));
      socket.send(JSON.stringify({ id, result: { thread: { id: threadId } } }));
      const received = await response;
      if (id === 1) assert.equal(received.result.thread.id, threadId);
      else assert.match(received.error.message, /managed identity conflict/);
    }
    assert.deepEqual(started, ["new-root", "foreign-root"]);
  } finally {
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("Desktop ownership authorization refuses a second thread before upstream RPC effects", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const forwarded = [];
  upstream.on("connection", socket => socket.on("message", raw => forwarded.push(JSON.parse(String(raw)))));
  const root = "desktop-root";
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`,
    authorizeThread: async ({ method, threadId }) => {
      if (method === "thread/start" || threadId !== root) {
        const error = new Error("single-thread Desktop broker");
        error.code = "STATEWRIGHT_THREAD_OWNERSHIP";
        throw error;
      }
    },
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    const rejected = once(client, "message");
    client.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "other-thread" } }));
    const reply = JSON.parse(String(await rejected));
    assert.match(reply.error.message, /single-thread Desktop broker/);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(forwarded.length, 0, "rejected thread never reached vendor App Server");
    const rejectedTurn = once(client, "message");
    client.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "other-thread", input: [] } }));
    assert.match(JSON.parse(String(await rejectedTurn)).error.message, /single-thread Desktop broker/);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(forwarded.length, 0, "foreign turn did not reach vendor App Server");
    client.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: root } }));
    while (forwarded.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(forwarded[0].params.threadId, root);
  } finally {
    client.close();
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test("Desktop historical adoption commits only after the matching successful native resume", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  let socket;
  const connected = new Promise(resolve => upstream.once("connection", value => { socket = value; resolve(); }));
  let root = "current-thread";
  let prepared = 0;
  let committed = 0;
  let cancelled = 0;
  let adoptionPending = false;
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`,
    authorizeThread: async ({ method, threadId }) => {
      if (adoptionPending) {
        const error = new Error("historical thread adoption is still pending");
        error.code = "STATEWRIGHT_THREAD_OWNERSHIP";
        throw error;
      }
      if (method === "thread/resume" && threadId === "historical-thread" && root === "current-thread") {
        prepared += 1;
        adoptionPending = true;
        let settled = false;
        return {
          version: 1, kind: "statewright_thread_adoption", method, threadId,
          commit: async () => { if (!settled) { settled = true; adoptionPending = false; committed += 1; root = threadId; } },
          cancel: async () => { if (!settled) { settled = true; adoptionPending = false; cancelled += 1; } },
        };
      }
      if (threadId && threadId !== root) {
        const error = new Error("registered Desktop thread required");
        error.code = "STATEWRIGHT_THREAD_OWNERSHIP";
        throw error;
      }
    },
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    await connected;

    let forwarded = once(socket, "message");
    client.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "historical-thread" } }));
    assert.equal(JSON.parse(String(await forwarded)).method, "thread/resume");
    let reply = once(client, "message");
    socket.send(JSON.stringify({ id: 1, error: { code: -32603, message: "synthetic native refusal" } }));
    assert.match(JSON.parse(String(await reply)).error.message, /synthetic native refusal/);
    assert.deepEqual({ root, prepared, committed, cancelled }, {
      root: "current-thread", prepared: 1, committed: 0, cancelled: 1,
    });

    forwarded = once(socket, "message");
    client.send(JSON.stringify({ id: 5, method: "thread/resume", params: { threadId: "historical-thread" } }));
    await forwarded;
    reply = once(client, "message");
    socket.send(JSON.stringify({ id: 5, result: { thread: { id: "wrong-thread" } } }));
    assert.match(JSON.parse(String(await reply)).error.message, /different thread/);
    assert.deepEqual({ root, prepared, committed, cancelled }, {
      root: "current-thread", prepared: 2, committed: 0, cancelled: 2,
    });

    forwarded = once(socket, "message");
    client.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "historical-thread" } }));
    await forwarded;
    reply = once(client, "message");
    client.send(JSON.stringify({ id: 4, method: "turn/start", params: { threadId: "current-thread", input: [] } }));
    assert.match(JSON.parse(String(await reply)).error.message, /adoption is still pending/);
    reply = once(client, "message");
    socket.send(JSON.stringify({ id: 2, result: { thread: { id: "historical-thread" } } }));
    assert.equal(JSON.parse(String(await reply)).result.thread.id, "historical-thread");
    assert.deepEqual({ root, prepared, committed, cancelled }, {
      root: "historical-thread", prepared: 3, committed: 1, cancelled: 2,
    });

    reply = once(client, "message");
    socket.send(JSON.stringify({ id: 2, result: { thread: { id: "historical-thread" } } }));
    assert.equal(JSON.parse(String(await reply)).result.thread.id, "historical-thread");
    assert.equal(committed, 1, "a duplicate matching response cannot recommit adoption");

    reply = once(client, "message");
    client.send(JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "current-thread", input: [] } }));
    assert.match(JSON.parse(String(await reply)).error.message, /registered Desktop thread required/);

    const preparedBeforeUpstreamReplay = prepared;
    reply = once(client, "message");
    socket.send(JSON.stringify({ method: "thread/resume", params: { threadId: "current-thread" } }));
    assert.equal(JSON.parse(String(await reply)).method, "thread/resume");
    assert.equal(prepared, preparedBeforeUpstreamReplay, "upstream/internal resume traffic cannot prepare adoption");
  } finally {
    client.close();
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test("Desktop pending adoption cancels on duplicate request ID and connection close", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  let socket;
  const connected = new Promise(resolve => upstream.once("connection", value => { socket = value; resolve(); }));
  let cancelled = 0;
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`,
    authorizeThread: async ({ method, threadId }) => method === "thread/resume" ? {
      version: 1, kind: "statewright_thread_adoption", method, threadId,
      commit: async () => {},
      cancel: async () => { cancelled += 1; },
    } : null,
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    await connected;
    const forwarded = once(socket, "message");
    client.send(JSON.stringify({ id: 9, method: "thread/resume", params: { threadId: "historical-thread" } }));
    await forwarded;
    const closed = once(client, "close");
    client.send(JSON.stringify({ id: 9, method: "thread/resume", params: { threadId: "historical-thread" } }));
    await closed;
    while (cancelled === 0) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(cancelled, 1);
  } finally {
    client.close();
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test("Desktop MCP readiness gate holds turn/start until Statewright tools are visible", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const forwarded = [];
  let statusCalls = 0;
  upstream.on("connection", socket => socket.on("message", raw => {
    const message = JSON.parse(String(raw));
    forwarded.push(message);
    if (message.method !== "mcpServerStatus/list") return;
    statusCalls += 1;
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
      data: [{ name: "statewright", tools: statusCalls >= 2 ? { statewright_get_state: {} } : {} }],
      nextCursor: null,
    } }));
  }));
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`,
    requiredMcpToolSuffix: "statewright_get_state",
    requiredMcpReadyTimeoutMs: 2_000,
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    client.send(JSON.stringify({ id: 41, method: "turn/start", params: { threadId: "desktop-thread", input: [] } }));
    const deadline = Date.now() + 2_000;
    while (!forwarded.some(message => message.method === "turn/start")) {
      if (Date.now() >= deadline) throw new Error("turn/start was not released after MCP readiness");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(statusCalls, 2);
    assert.deepEqual(forwarded.map(message => message.method), ["mcpServerStatus/list", "mcpServerStatus/list", "turn/start"]);
  } finally {
    client.close();
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test("App Server route proxy fails open when optional picker-label callbacks fail", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
    getThreadLabels: async () => { throw new Error("label store unavailable"); },
    onThreadResumed: async () => { throw new Error("label write unavailable"); },
  });
  const upstreamConnection = new Promise((resolveConnection) => upstream.once("connection", resolveConnection));
  const client = new WebSocket(proxy.url);
  await once(client, "open");
  const upstreamSocket = await upstreamConnection;
  client.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "still-resumes" } }));
  await new Promise((resolveMessage) => upstreamSocket.once("message", resolveMessage));
  const result = new Promise((resolveMessage) => client.once("message", (raw) => resolveMessage(JSON.parse(String(raw)))));
  upstreamSocket.send(JSON.stringify({ id: 1, result: { thread: { id: "still-resumes" } } }));
  assert.equal((await result).result.thread.id, "still-resumes");
  client.close();
  await proxy.close();
  await new Promise((resolveClose) => upstream.close(resolveClose));
});
