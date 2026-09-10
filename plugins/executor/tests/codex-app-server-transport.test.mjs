import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  appServerHomePrefixForClient,
  codexAppServerTransportEnabled,
  discoverCodexProviderProfiles,
  routeConfigEdits,
  startCodexAppServerRuntime,
  stopOwnedAppServer,
} from "../lib/codex-app-server-transport.mjs";
import { clearResidentThreadAttachment, ensureCodexAppServerResident, nextCodexResidentRouteRequest, readResidentThreadAttachment, residentControlDir, residentMatchesRuntime, residentRoot, residentRuntimeRevision, stageResidentProviderHandoff, takeResidentProviderHandoff, writeResidentProviderHandoff } from "../lib/codex-app-server-resident.mjs";
import { applyCompactResumeRequest, applyProviderResumeRequest, applyRouteToTurnStart, applyThreadListCwd, clarifyActiveWriterResumeError, hydrateBoundedResumeTurns, mergeProviderModelList, normalizeProviderMessage, providerHandoffForRoute, providerHandoffForSettingsUpdate, settingsConfirmRoute, startCodexAppServerRouteProxy } from "../lib/codex-app-server-route-proxy.mjs";

function once(socket, event) {
  return new Promise((resolveEvent) => socket.once(event, resolveEvent));
}

test("Codex App Server transport remains opt-in and supports an explicit environment override", () => {
  assert.equal(codexAppServerTransportEnabled({ environment: {} }), false);
  assert.equal(codexAppServerTransportEnabled({
    config: { routing: { managed_clients: { codex_transport: "app-server" } } },
  }), true);
  assert.equal(codexAppServerTransportEnabled({
    environment: { STATEWRIGHT_CODEX_TRANSPORT: "restart" },
    config: { routing: { managed_clients: { codex_transport: "app-server" } } },
  }), false);
  assert.equal(codexAppServerTransportEnabled({
    environment: { STATEWRIGHT_CODEX_TRANSPORT: "app-server" },
  }), true);
});

test("App Server transport creates bounded, filesystem-safe temporary home names", () => {
  assert.equal(appServerHomePrefixForClient("swc_abc:unsafe/path"), "statewright-swc_abc-unsafe-path");
  assert.match(appServerHomePrefixForClient("x".repeat(100)), /^statewright-x{60}$/);
});

test("Codex profile-v2 discovery exposes only provider catalogs without leaking endpoint config", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "statewright-provider-profiles-"));
  try {
    await writeFile(join(codexHome, "config.toml"), 'model = "cloud-model"\n');
    await writeFile(join(codexHome, "local.config.toml"), [
      'model = "local-model"',
      'model_provider = "local_compatible"',
      'model_catalog_json = "catalog.json"',
      'web_search = "disabled"',
      '',
    ].join("\n"));
    await writeFile(join(codexHome, "ignored.config.toml"), 'model = "another-cloud-model"\n');
    await writeFile(join(codexHome, "catalog.json"), JSON.stringify({ models: [{
      slug: "local-model",
      display_name: "Local Model",
      description: "Local low-tier work",
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low", description: "Fast" }],
      input_modalities: ["text"],
      visibility: "list",
      multi_agent_version: "disabled",
    }] }));
    assert.deepEqual(await discoverCodexProviderProfiles(codexHome), [{
      profile: "local",
      provider: "local_compatible",
      model: "local-model",
      webSearch: "disabled",
      appServerConfig: {
        model: "local-model",
        model_provider: "local_compatible",
        model_catalog_json: join(codexHome, "catalog.json"),
        web_search: "disabled",
      },
      models: [{
        id: "local-model",
        model: "local-model",
        displayName: "Local Model",
        description: "Local low-tier work",
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }],
        defaultReasoningEffort: "low",
        inputModalities: ["text"],
        supportsPersonality: false,
        multiAgentVersion: "disabled",
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: false,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        modelSpecialty: null,
      }],
    }]);
  } finally { await rm(codexHome, { recursive: true, force: true }); }
});

test("Codex profile-v2 discovery rejects ambiguous duplicate providers", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "statewright-provider-duplicates-"));
  try {
    await writeFile(join(codexHome, "catalog-a.json"), JSON.stringify({ models: [{ slug: "local-a" }] }));
    await writeFile(join(codexHome, "catalog-b.json"), JSON.stringify({ models: [{ slug: "local-b" }] }));
    await writeFile(join(codexHome, "a.config.toml"), [
      'model_provider = "local_compatible"',
      'model_catalog_json = "catalog-a.json"',
      "",
    ].join("\n"));
    await writeFile(join(codexHome, "b.config.toml"), [
      'model_provider = "local_compatible"',
      'model_catalog_json = "catalog-b.json"',
      "",
    ].join("\n"));
    await assert.rejects(discoverCodexProviderProfiles(codexHome), /one profile-v2 catalog per provider/i);
  } finally { await rm(codexHome, { recursive: true, force: true }); }
});

test("App Server runtime applies a provider profile through supported config overrides", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-profile-runtime-"));
  const codexHome = join(home, ".codex");
  const fake = join(home, "fake-codex.mjs");
  const argvPath = join(home, "argv.json");
  try {
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), 'model = "cloud-model"\n');
    await writeFile(join(codexHome, "local.config.toml"), [
      'model = "local-model"',
      'model_provider = "local_compatible"',
      'model_catalog_json = "catalog.json"',
      'web_search = "disabled"',
      '',
    ].join("\n"));
    await writeFile(join(codexHome, "catalog.json"), JSON.stringify({ models: [{ slug: "local-model" }] }));
    await writeFile(fake, `#!/usr/bin/env node\nimport { createServer } from "node:http";\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));\nconst target = new URL(process.argv.at(-1));\ncreateServer((_request, response) => { response.writeHead(200); response.end("ok\\n"); }).listen(Number(target.port), target.hostname);\n`);
    await chmod(fake, 0o755);
    const runtime = await startCodexAppServerRuntime({
      command: fake,
      commandArgs: ["shim-entry"],
      environment: { ...process.env, CODEX_HOME: codexHome, STATEWRIGHT_SENTRY_DISABLED: "true" },
      cwd: home,
      home,
      clientId: "swc_profile_runtime",
      profile: "local",
      resumeRoute: { provider: "local_compatible", model: "local-model", effort: "low" },
      reporter: { async report() {} },
    });
    const argv = JSON.parse(await readFile(argvPath, "utf8"));
    assert.deepEqual(argv.slice(0, 2), ["shim-entry", "app-server"]);
    assert.ok(argv.includes('model_provider="local_compatible"'));
    assert.ok(argv.includes('model_catalog_json=' + JSON.stringify(join(codexHome, "catalog.json"))));
    assert.ok(argv.includes('model_reasoning_effort="low"'));
    assert.ok(argv.includes('web_search="disabled"'));
    assert.ok(!argv.includes("--profile"));
    await runtime.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("mixed-provider catalogs keep active models native and qualify only alternate providers", () => {
  const response = {
    id: 3,
    result: {
      data: [{ id: "cloud-model", model: "cloud-model", displayName: "Cloud Model", isDefault: true }],
      nextCursor: null,
    },
  };
  const merged = mergeProviderModelList(response, {
    activeProvider: "openai",
    profiles: [{
      provider: "local_compatible",
      profile: "local",
      models: [{ id: "local-model", model: "local-model", displayName: "Local Model", isDefault: false }],
    }],
  });
  assert.deepEqual(merged.result.data.map(({ id, model, displayName }) => ({ id, model, displayName })), [
    { id: "cloud-model", model: "cloud-model", displayName: "Cloud Model" },
    { id: "local_compatible/local-model", model: "local_compatible/local-model", displayName: "Local Model" },
  ]);
  const switched = mergeProviderModelList({
    id: 4,
    result: {
      data: [{ id: "local-model", model: "local-model", displayName: "Local Model", isDefault: true }],
      nextCursor: null,
    },
  }, {
    activeProvider: "local_compatible",
    profiles: [{
      provider: "openai",
      models: [{ id: "cloud-model", model: "cloud-model", displayName: "Cloud Model", isDefault: false }],
    }],
  });
  assert.deepEqual(switched.result.data.map(({ id, model }) => ({ id, model })), [
    { id: "local-model", model: "local-model" },
    { id: "openai/cloud-model", model: "openai/cloud-model" },
  ]);
});

test("active-provider thread state remains native at the proxy boundary", () => {
  const response = {
    id: 4,
    result: { thread: { id: "thread-1", model: "openai/gpt-5.6-sol", modelProvider: "openai" }, model: "openai/gpt-5.6-sol", modelProvider: "openai" },
  };
  const normalized = normalizeProviderMessage(response);
  assert.equal(normalized.result.model, "gpt-5.6-sol");
  assert.equal(normalized.result.thread.model, "gpt-5.6-sol");
  const notification = normalizeProviderMessage({
    method: "thread/settings/updated",
    params: { threadId: "thread-1", threadSettings: { model: "openai/gpt-5.6-sol", modelProvider: "openai" } },
  });
  assert.equal(notification.params.threadSettings.model, "gpt-5.6-sol");
});

test("manual picker selection requests an idle provider handoff and same-provider updates stay in place", () => {
  const profiles = [{ provider: "local_compatible", profile: "local", model: "local-model" }];
  assert.deepEqual(providerHandoffForSettingsUpdate({
    id: 5,
    method: "thread/settings/update",
    params: { threadId: "thread-1", model: "local_compatible/local-model", effort: "low" },
  }, { activeProvider: "openai", profiles, threadActive: false }), {
    threadId: "thread-1",
    provider: "local_compatible",
    profile: "local",
    model: "local-model",
    effort: "low",
    resume: true,
    source: "manual_model_picker",
  });
  assert.equal(providerHandoffForSettingsUpdate({
    method: "thread/settings/update",
    params: { threadId: "thread-1", model: "local_compatible/local-model" },
  }, { activeProvider: "local_compatible", profiles, threadActive: false }), null);
  assert.throws(() => providerHandoffForSettingsUpdate({
    method: "thread/settings/update",
    params: { threadId: "thread-1", model: "local_compatible/local-model" },
  }, { activeProvider: "openai", profiles, threadActive: true }), /wait for the current turn to finish/i);
});

test("a provider handoff resumes the same thread with explicit provider and model", () => {
  assert.deepEqual(applyProviderResumeRequest({
    id: 6,
    method: "thread/resume",
    params: { threadId: "thread-1" },
  }, { provider: "local_compatible", model: "local-model", effort: "low" }), {
    id: 6,
    method: "thread/resume",
    params: { threadId: "thread-1", modelProvider: "local_compatible", model: "local-model" },
  });
});

test("a Statewright ladder route can cross providers without changing thread identity", () => {
  assert.deepEqual(providerHandoffForRoute({
    session_id: "thread-1",
    root_session_id: "thread-1",
    client_id: "client-1",
    model: "local_compatible/local-model",
    effort: "low",
  }, {
    activeProvider: "openai",
    profiles: [{ provider: "local_compatible", profile: "local" }],
  }), {
    threadId: "thread-1",
    provider: "local_compatible",
    profile: "local",
    model: "local-model",
    effort: "low",
    resume: true,
    source: "statewright_model_ladder",
  });
  assert.equal(providerHandoffForRoute({ session_id: "thread-1", model: "openai/gpt-cloud" }, {
    activeProvider: "openai",
  }), null);
});

test("App Server runtime confirms its owned child exits before close completes", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-app-server-close-"));
  const codexHome = join(home, ".codex");
  const fake = join(home, "fake-codex.mjs");
  const pidPath = join(home, "app-server.pid");
  const descendantPidPath = join(home, "app-server-descendant.pid");
  try {
    await mkdir(codexHome, { recursive: true });
    await writeFile(fake, `#!/usr/bin/env node\nimport { spawn } from "node:child_process";\nimport { createServer } from "node:http";\nimport { writeFileSync } from "node:fs";\nconst target = new URL(process.argv.at(-1));\nconst descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\nprocess.on("SIGTERM", () => {});\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nwriteFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));\ncreateServer((_request, response) => { response.writeHead(200); response.end("ok\\n"); }).listen(Number(target.port), target.hostname);\n`);
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
    const descendantPid = Number(await readFile(descendantPidPath, "utf8"));
    await runtime.close();
    assert.throws(() => process.kill(pid, 0));
    assert.throws(() => process.kill(descendantPid, 0));
    const retainedHomes = (await readdir(tmpdir())).filter((entry) => entry.startsWith("statewright-swc_shutdown_test-app-server-"));
    assert.ok(retainedHomes.length >= 1, "the isolated home must remain addressable after shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("App Server runtime uses descendant-aware cleanup on Windows", async () => {
  const child = { pid: 4242, exitCode: null, signalCode: null };
  let cleanupCalls = 0;
  await stopOwnedAppServer(child, Promise.resolve(), 20, {
    platform: "win32",
    environment: { Path: "C:\\Windows\\System32", STATEWRIGHT_API_KEY: "secret" },
    cleanupWindowsTree: async (actual, options) => {
      cleanupCalls += 1;
      assert.equal(actual, child);
      assert.equal(options.environment.STATEWRIGHT_API_KEY, "secret");
      child.exitCode = 0;
      return { status: "success" };
    },
  });
  assert.equal(cleanupCalls, 1);
});

test("App Server runtime treats an already-stopped Windows child as closed", async () => {
  const child = { pid: 4242, exitCode: 0, signalCode: null };
  let cleanupCalls = 0;
  await stopOwnedAppServer(child, Promise.resolve(), 20, {
    platform: "win32",
    cleanupWindowsTree: async () => { cleanupCalls += 1; return { status: "nonzero" }; },
  });
  assert.equal(cleanupCalls, 0);
});

test("resident App Server state is stable per managed client and keeps routes outside the transient launcher", () => {
  const home = "/tmp/statewright-home";
  const root = residentRoot(home, "swc_abc:unsafe/path");
  assert.equal(root, "/tmp/statewright-home/.statewright/codex-app-server/swc_abc-unsafe-path");
  assert.equal(residentControlDir(home, "swc_abc:unsafe/path"), `${root}/routes`);
});

test("resident provider handoffs are atomic, scoped, and one-shot", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-resident-handoff-"));
  const clientId = "swc_handoff";
  try {
    const staged = await stageResidentProviderHandoff(home, clientId, {
      threadId: "thread-1",
      provider: "local_compatible",
      profile: "local",
      model: "local-model",
      effort: "low",
      source: "manual_model_picker",
    });
    assert.equal(await takeResidentProviderHandoff(home, clientId), null);
    await staged.publish();
    const reservation = await takeResidentProviderHandoff(home, clientId);
    const handoff = reservation.handoff;
    assert.equal(handoff.clientId, clientId);
    assert.equal(handoff.threadId, "thread-1");
    assert.equal(handoff.provider, "local_compatible");
    assert.equal(handoff.profile, "local");
    assert.match(handoff.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(await takeResidentProviderHandoff(home, clientId), null);
    await reservation.release();
    const retry = await takeResidentProviderHandoff(home, clientId);
    assert.deepEqual(retry.handoff, handoff);
    await retry.ack();
    assert.equal(await takeResidentProviderHandoff(home, clientId), null);
    const discarded = await stageResidentProviderHandoff(home, clientId, handoff);
    await discarded.discard();
    assert.equal(await takeResidentProviderHandoff(home, clientId), null);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("resident provider handoffs queue concurrent publications without overwrite", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-resident-handoff-queue-"));
  const clientId = "swc_handoff_queue";
  try {
    const first = await stageResidentProviderHandoff(home, clientId, { threadId: "thread-1", provider: "local_compatible", model: "model-a" });
    const second = await stageResidentProviderHandoff(home, clientId, { threadId: "thread-1", provider: "openai", model: "model-b" });
    await Promise.all([first.publish(), second.publish()]);
    const queued = (await readdir(residentRoot(home, clientId))).filter((name) => name.endsWith(".provider-handoff.json"));
    assert.equal(queued.length, 2);
    const observed = [];
    for (let index = 0; index < 2; index += 1) {
      const reservation = await takeResidentProviderHandoff(home, clientId);
      observed.push(reservation.handoff.model);
      await reservation.ack();
    }
    assert.deepEqual(new Set(observed), new Set(["model-a", "model-b"]));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("resident provider handoffs recover an orphaned durable claim", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-resident-handoff-recovery-"));
  const clientId = "swc_handoff_recovery";
  try {
    await writeResidentProviderHandoff(home, clientId, {
      threadId: "thread-1",
      provider: "local_compatible",
      model: "local-model",
    });
    const root = residentRoot(home, clientId);
    const queued = (await readdir(root)).find((name) => name.endsWith(".provider-handoff.json"));
    const path = join(root, queued);
    await rename(path, `${path}.99999999.synthetic.inflight`);
    const candidates = await Promise.all([
      takeResidentProviderHandoff(home, clientId),
      takeResidentProviderHandoff(home, clientId),
    ]);
    assert.equal(candidates.filter(Boolean).length, 1);
    const recovered = candidates.find(Boolean);
    assert.equal(recovered.handoff.threadId, "thread-1");
    await recovered.ack();
    assert.equal(await takeResidentProviderHandoff(home, clientId), null);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("resident provider handoffs recover a staged transaction after its writer exits", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-resident-handoff-pending-"));
  const clientId = "swc_handoff_pending";
  try {
    await stageResidentProviderHandoff(home, clientId, {
      threadId: "thread-1",
      provider: "local_compatible",
      model: "local-model",
    });
    const root = residentRoot(home, clientId);
    const pending = (await readdir(root)).find((name) => name.endsWith(".pending"));
    const orphan = pending.replace(/provider-handoff\.json\.\d+\./, "provider-handoff.json.99999999.");
    await rename(join(root, pending), join(root, orphan));
    const recovered = await takeResidentProviderHandoff(home, clientId);
    assert.equal(recovered.handoff.threadId, "thread-1");
    await recovered.ack();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("resident thread attachment markers are scoped to the current resident", async () => {
  const home = await mkdtemp(join(tmpdir(), "statewright-resident-attachment-"));
  const clientId = "swc_attachment";
  const path = join(residentRoot(home, clientId), "thread-attachment.json");
  try {
    await mkdir(residentRoot(home, clientId), { recursive: true });
    await writeFile(path, JSON.stringify({
      version: 1,
      residentPid: 1234,
      threadId: "thread-1",
      provider: "local_compatible",
    }));
    assert.equal(await readResidentThreadAttachment(home, clientId, 4321), null);
    assert.equal((await readResidentThreadAttachment(home, clientId, 1234)).threadId, "thread-1");
    await clearResidentThreadAttachment(home, clientId);
    assert.equal(await readResidentThreadAttachment(home, clientId, 1234), null);
    const noncePath = join(residentRoot(home, clientId), "thread-attachment.launch-a.json");
    await writeFile(noncePath, JSON.stringify({ version: 1, residentPid: 1234, launchNonce: "launch-a", threadId: "thread-2" }));
    assert.equal(await readResidentThreadAttachment(home, clientId, 1234, "launch-b"), null);
    assert.equal((await readResidentThreadAttachment(home, clientId, 1234, "launch-a")).threadId, "thread-2");
    await clearResidentThreadAttachment(home, clientId, "launch-a");
  } finally { await rm(home, { recursive: true, force: true }); }
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

test("resident App Server recovers a source route claimed by a dead resident", async () => {
  const control = await mkdtemp(join(tmpdir(), "statewright-resident-route-recovery-"));
  const clientId = "swc_abcdefabcdefabcdefabcdefabcdefab";
  try {
    await writeFile(join(control, "codex-root-session.json"), JSON.stringify({ version: 1, session_id: "thread-1", client_id: clientId }));
    await writeFile(join(control, "01.route.json"), JSON.stringify({ session_id: "thread-1", root_session_id: "thread-1", client_id: clientId, model: "local_compatible/local-model" }));
    await nextCodexResidentRouteRequest(control, clientId, "thread-1");
    const inflight = (await readdir(control)).find((name) => name.endsWith(".inflight"));
    const orphan = inflight.replace(/\.\d+\.([^.]+)\.inflight$/, ".99999999.$1.inflight");
    await rename(join(control, inflight), join(control, orphan));
    const candidates = await Promise.all([
      nextCodexResidentRouteRequest(control, clientId, "thread-1"),
      nextCodexResidentRouteRequest(control, clientId, "thread-1"),
    ]);
    assert.equal(candidates.filter(Boolean).length, 1);
    const recovered = candidates.find(Boolean);
    assert.equal(recovered.route.model, "local_compatible/local-model");
    await recovered.ack();
  } finally { await rm(control, { recursive: true, force: true }); }
});

test("resident runtime revision changes reuse only when the loaded transport bundle and provider profile match", async () => {
  const revision = await residentRuntimeRevision();
  assert.match(revision, /^[a-f0-9]{16}$/);
  assert.equal(residentMatchesRuntime({ runtimeRevision: revision }, revision), true);
  assert.equal(residentMatchesRuntime({ runtimeRevision: revision, threadListCwd: "/repo" }, revision, "/repo"), true);
  assert.equal(residentMatchesRuntime({ runtimeRevision: revision, threadListCwd: "/repo", profile: "local" }, revision, "/repo", "local"), true);
  assert.equal(residentMatchesRuntime({ runtimeRevision: revision, threadListCwd: "/repo", profile: "local" }, revision, "/repo", null), false);
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
    params: { threadId: "thread-1", threadSettings: { model: "gpt-5.6-sol", effort: "high" } },
  }), {
    ...receipt,
    actualModel: "gpt-5.6-sol",
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

test("App Server routing selects the ladder entry owned by the persistent thread provider", () => {
  const route = {
    session_id: "thread-1",
    model: "local_compatible/local-code-model",
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
  assert.equal(cloud.message.params.model, "gpt-5.6-luna");
  assert.equal(cloud.message.params.effort, "low");
});

test("App Server resume history is scoped to the managed project unless the client supplied a cwd", () => {
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

test("resident proxy merges provider catalogs and hands manual cross-provider selection to its supervisor", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let upstreamSocket;
  const connected = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  const handoffs = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    activeProvider: "openai",
    profiles: [{
      provider: "local_compatible",
      profile: "local",
      models: [{ id: "local-model", model: "local-model", displayName: "Local Model", isDefault: false }],
    }],
    takePendingRoute: async () => null,
    onProviderHandoff: async (handoff) => handoffs.push(handoff),
    routePollMs: 10_000,
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    await connected;
    const listForwarded = once(upstreamSocket, "message");
    client.send(JSON.stringify({ id: 1, method: "model/list", params: {} }));
    await listForwarded;
    const listResponse = once(client, "message");
    upstreamSocket.send(JSON.stringify({
      id: 1,
      result: { data: [{ id: "cloud-model", model: "cloud-model", displayName: "Cloud Model", isDefault: true }], nextCursor: null },
    }));
    const listed = JSON.parse(String(await listResponse));
    assert.deepEqual(listed.result.data.map((model) => model.model), ["cloud-model", "local_compatible/local-model"]);
    const turnForwarded = once(upstreamSocket, "message");
    client.send(JSON.stringify({
      id: 9,
      method: "turn/start",
      params: { threadId: "thread-1", model: "cloud-model", input: [] },
    }));
    assert.equal(JSON.parse(String(await turnForwarded)).params.model, "cloud-model");
    const turnResponse = once(client, "message");
    upstreamSocket.send(JSON.stringify({ id: 9, error: { code: -32000, message: "synthetic turn rejection" } }));
    await turnResponse;
    const response = once(client, "message");
    const closed = once(client, "close");
    client.send(JSON.stringify({
      id: 2,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "local_compatible/local-model", effort: "high" },
    }));
    assert.deepEqual(JSON.parse(String(await response)), { id: 2, result: {} });
    const effortResponse = once(client, "message");
    client.send(JSON.stringify({
      id: 3,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "local_compatible/local-model", effort: "low" },
    }));
    assert.deepEqual(JSON.parse(String(await effortResponse)), { id: 3, result: {} });
    const configForwarded = once(upstreamSocket, "message");
    client.send(JSON.stringify({ id: 4, method: "config/batchWrite", params: { edits: [] } }));
    assert.equal(JSON.parse(String(await configForwarded)).method, "config/batchWrite");
    const unrelatedForwarded = once(upstreamSocket, "message");
    client.send(JSON.stringify({ id: 5, method: "config/batchWrite", params: { edits: [] } }));
    assert.equal(JSON.parse(String(await unrelatedForwarded)).method, "config/batchWrite");
    const unrelatedResponse = once(client, "message");
    upstreamSocket.send(JSON.stringify({ id: 5, result: { status: "ok" } }));
    assert.deepEqual(JSON.parse(String(await unrelatedResponse)), { id: 5, result: { status: "ok" } });
    const configResponse = once(client, "message");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
    assert.equal(client.readyState, WebSocket.OPEN);
    assert.equal(handoffs.length, 0);
    upstreamSocket.send(JSON.stringify({ id: 4, result: { status: "ok" } }));
    assert.deepEqual(JSON.parse(String(await configResponse)), { id: 4, result: { status: "ok" } });
    await closed;
    assert.equal(handoffs.length, 1);
    assert.deepEqual(handoffs.at(-1), {
      threadId: "thread-1",
      provider: "local_compatible",
      profile: "local",
      model: "local-model",
      effort: "low",
      resume: false,
      source: "manual_model_picker",
    });
  } finally {
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("resident proxy keeps the current provider when picker config persistence fails", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let upstreamSocket;
  const connected = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  const handoffs = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    activeProvider: "openai",
    profiles: [{
      provider: "local_compatible",
      profile: "local",
      models: [{ id: "local-model", model: "local-model", displayName: "Local Model", isDefault: false }],
    }],
    takePendingRoute: async () => null,
    onProviderHandoff: async (handoff) => handoffs.push(handoff),
    routePollMs: 10_000,
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    await connected;
    const staged = once(client, "message");
    client.send(JSON.stringify({
      id: 1,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "local_compatible/local-model", effort: "low" },
    }));
    assert.deepEqual(JSON.parse(String(await staged)), { id: 1, result: {} });

    const configForwarded = once(upstreamSocket, "message");
    client.send(JSON.stringify({ id: 2, method: "config/batchWrite", params: { edits: [] } }));
    assert.equal(JSON.parse(String(await configForwarded)).method, "config/batchWrite");
    const configResponse = once(client, "message");
    upstreamSocket.send(JSON.stringify({ id: 2, error: { code: -32603, message: "synthetic persistence failure" } }));
    assert.deepEqual(JSON.parse(String(await configResponse)), {
      id: 2,
      error: { code: -32603, message: "synthetic persistence failure" },
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    assert.equal(handoffs.length, 0);
    assert.equal(client.readyState, WebSocket.OPEN);

    const sameProviderForwarded = once(upstreamSocket, "message");
    client.send(JSON.stringify({
      id: 3,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "openai/cloud-model", effort: "high" },
    }));
    assert.deepEqual(JSON.parse(String(await sameProviderForwarded)), {
      id: 3,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "cloud-model", effort: "high" },
    });
  } finally {
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("resident proxy retries a manual provider handoff after publication fails", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let upstreamSocket;
  const connected = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  let publishAttempts = 0;
  const handoffs = [];
  const protocolErrors = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    activeProvider: "openai",
    profiles: [{ provider: "local_compatible", profile: "local", models: [] }],
    takePendingRoute: async () => null,
    onProviderHandoff: async (handoff) => {
      publishAttempts += 1;
      if (publishAttempts === 1) throw new Error("synthetic publication failure");
      handoffs.push(handoff);
    },
    onProtocolError: async (error) => protocolErrors.push(error),
    routePollMs: 10_000,
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    await connected;
    const select = async (settingsId, configId) => {
      const selected = once(client, "message");
      client.send(JSON.stringify({
        id: settingsId,
        method: "thread/settings/update",
        params: { threadId: "thread-1", model: "local_compatible/local-model", effort: "low" },
      }));
      assert.deepEqual(JSON.parse(String(await selected)), { id: settingsId, result: {} });
      const configForwarded = once(upstreamSocket, "message");
      client.send(JSON.stringify({ id: configId, method: "config/batchWrite", params: { edits: [] } }));
      await configForwarded;
      const configResponse = once(client, "message");
      upstreamSocket.send(JSON.stringify({ id: configId, result: { status: "ok" } }));
      await configResponse;
    };
    await select(1, 2);
    for (let attempt = 0; attempt < 100 && protocolErrors.length === 0; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    assert.match(protocolErrors[0]?.message ?? "", /synthetic publication failure/);
    assert.equal(client.readyState, WebSocket.OPEN);
    const closed = once(client, "close");
    await select(3, 4);
    await closed;
    assert.equal(publishAttempts, 2);
    assert.equal(handoffs.length, 1);
  } finally {
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("resident proxy preserves a published ladder handoff when source acknowledgement fails", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let upstreamSocket;
  const connected = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  let reserved = false;
  let completed = false;
  let acknowledgementAttempts = 0;
  let releaseCount = 0;
  const handoffs = [];
  const route = { session_id: "thread-1", model: "local_compatible/local-model", effort: "low" };
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    activeProvider: "openai",
    profiles: [{ provider: "local_compatible", profile: "local", models: [] }],
    takePendingRoute: async (threadId) => {
      if (threadId !== route.session_id || reserved || completed) return null;
      reserved = true;
      return {
        route,
        ack: async () => {
          acknowledgementAttempts += 1;
          throw new Error("synthetic acknowledgement failure");
        },
        release: async () => { reserved = false; releaseCount += 1; },
      };
    },
    onProviderHandoff: async (handoff) => handoffs.push(handoff),
    routePollMs: 5,
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    await connected;
    const forwarded = once(upstreamSocket, "message");
    client.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "thread-1" } }));
    await forwarded;
    const response = once(client, "message");
    upstreamSocket.send(JSON.stringify({
      id: 1,
      result: { thread: { id: "thread-1", modelProvider: "openai", turns: [] }, modelProvider: "openai", model: "cloud-model" },
    }));
    await response;
    const closed = once(client, "close");
    await closed;
    assert.equal(acknowledgementAttempts, 1);
    assert.equal(releaseCount, 0);
    assert.equal(handoffs.length, 1);
  } finally {
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("route polling releases a cross-provider reservation when its profile is missing", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let upstreamSocket;
  const connected = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  let released = 0;
  let available = true;
  const protocolErrors = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    activeProvider: "openai",
    profiles: [],
    takePendingRoute: async (threadId) => available && threadId === "thread-1" ? {
      route: { session_id: "thread-1", model: "missing_provider/local-model" },
      release: async () => { available = false; released += 1; },
    } : null,
    onProtocolError: async (error) => protocolErrors.push(error),
    routePollMs: 5,
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    await connected;
    const forwarded = once(upstreamSocket, "message");
    client.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "thread-1" } }));
    await forwarded;
    const response = once(client, "message");
    upstreamSocket.send(JSON.stringify({
      id: 1,
      result: { thread: { id: "thread-1", modelProvider: "openai", turns: [] }, modelProvider: "openai", model: "cloud-model" },
    }));
    await response;
    for (let attempt = 0; attempt < 100 && released === 0; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    assert.equal(released, 1);
    assert.match(protocolErrors[0]?.message ?? "", /no Codex profile for provider 'missing_provider'/i);
    assert.equal(client.readyState, WebSocket.OPEN);
  } finally {
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("turn-boundary routing releases a cross-provider reservation when its profile is missing", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let released = 0;
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    activeProvider: "openai",
    profiles: [],
    takePendingRoute: async () => ({
      route: { session_id: "thread-1", model: "missing_provider/local-model" },
      release: async () => { released += 1; },
    }),
    routePollMs: 10_000,
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    const closed = once(client, "close");
    client.send(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-1", input: [] } }));
    await closed;
    assert.equal(released, 1);
  } finally {
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("turn-boundary handoff publishes only after the retry response is delivered", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let acknowledged = 0;
  let resolveResponseBlocked;
  const responseBlocked = new Promise((resolve) => { resolveResponseBlocked = resolve; });
  let releaseResponse;
  const responseRelease = new Promise((resolve) => { releaseResponse = resolve; });
  const handoffs = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    activeProvider: "openai",
    profiles: [{ provider: "local_compatible", profile: "local", models: [] }],
    takePendingRoute: async () => ({
      route: { session_id: "thread-1", model: "local_compatible/local-model" },
      ack: async () => { acknowledged += 1; },
      release: async () => {},
    }),
    forwardDownstreamPayload: async (socket, payload) => {
      if (JSON.parse(payload)?.error?.code === -32001) {
        resolveResponseBlocked();
        await responseRelease;
        socket.send(payload);
        return;
      }
      return forwardWhenOpen(socket, payload);
    },
    onProviderHandoff: async (handoff) => handoffs.push(handoff),
    routePollMs: 10_000,
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    client.send(JSON.stringify({ id: 1, method: "turn/start", params: { threadId: "thread-1", input: [] } }));
    await Promise.race([
      responseBlocked,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for the retry response")), 1_000)),
    ]);
    assert.equal(acknowledged, 0);
    assert.equal(handoffs.length, 0);
    const response = once(client, "message");
    const closed = once(client, "close");
    releaseResponse();
    assert.equal(JSON.parse(String(await response)).error.code, -32001);
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for handoff close (ack=${acknowledged}, handoffs=${handoffs.length}, readyState=${client.readyState})`)), 1_000)),
    ]);
    assert.equal(acknowledged, 1);
    assert.equal(handoffs.length, 1);
  } finally {
    releaseResponse?.();
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("resident proxy defers a Statewright cross-provider ladder handoff until the active turn completes", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let upstreamSocket;
  const connected = new Promise((resolveConnection) => upstream.once("connection", (socket) => {
    upstreamSocket = socket;
    resolveConnection();
  }));
  let pending = null;
  let acknowledged = 0;
  const handoffs = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    activeProvider: "openai",
    profiles: [{ provider: "local_compatible", profile: "local", models: [] }],
    takePendingRoute: async (threadId) => pending?.session_id === threadId ? {
      route: pending,
      ack: async () => { acknowledged += 1; pending = null; },
      release: async () => {},
    } : null,
    onProviderHandoff: async (handoff) => handoffs.push(handoff),
    routePollMs: 5,
  });
  const client = new WebSocket(proxy.url);
  try {
    await once(client, "open");
    await connected;
    const resumeForwarded = once(upstreamSocket, "message");
    client.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "thread-1" } }));
    await resumeForwarded;
    const resumeResponse = once(client, "message");
    upstreamSocket.send(JSON.stringify({
      id: 1,
      result: { thread: { id: "thread-1", modelProvider: "openai", turns: [] }, model: "cloud-model", modelProvider: "openai" },
    }));
    await resumeResponse;
    const activeForwarded = once(client, "message");
    upstreamSocket.send(JSON.stringify({ method: "thread/status/changed", params: { threadId: "thread-1", status: { type: "active" } } }));
    await activeForwarded;
    pending = {
      session_id: "thread-1",
      root_session_id: "thread-1",
      client_id: "client-1",
      model: "local_compatible/local-model",
      effort: "low",
      model_ladder: [
        { model: "local_compatible/local-model", thinking_level: "low" },
        { model: "openai/cloud-model", thinking_level: "low" },
      ],
    };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    assert.equal(handoffs.length, 0);
    const completedForwarded = once(client, "message");
    const closed = once(client, "close");
    upstreamSocket.send(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1" } }));
    await completedForwarded;
    await closed;
    assert.equal(acknowledged, 1);
    assert.equal(handoffs[0].threadId, "thread-1");
    assert.equal(handoffs[0].provider, "local_compatible");
    assert.equal(handoffs[0].source, "statewright_model_ladder");
  } finally {
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
});

test("resident proxy blocks reconnect handoffs until background completion delivery settles", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  const upstreamSockets = [];
  upstream.on("connection", (socket) => upstreamSockets.push(socket));
  let pending = null;
  let reserved = false;
  let routeTakeCount = 0;
  let resolveCompletionBlocked;
  const completionBlocked = new Promise((resolve) => { resolveCompletionBlocked = resolve; });
  let releaseCompletion;
  const completionRelease = new Promise((resolve) => { releaseCompletion = resolve; });
  const handoffs = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    activeProvider: "openai",
    profiles: [{ provider: "local_compatible", profile: "local", models: [] }],
    takePendingRoute: async (threadId) => {
      if (!pending || reserved || pending.session_id !== threadId) return null;
      routeTakeCount += 1;
      reserved = true;
      return {
        route: pending,
        ack: async () => { pending = null; },
        release: async () => { reserved = false; },
      };
    },
    forwardDownstreamPayload: async (socket, payload) => {
      if (JSON.parse(payload)?.method === "turn/completed") {
        resolveCompletionBlocked();
        await completionRelease;
        return forwardWhenOpen(socket, payload);
      }
      socket.send(payload);
    },
    onProviderHandoff: async (handoff) => handoffs.push(handoff),
    routePollMs: 5,
  });
  const first = new WebSocket(proxy.url);
  let second;
  try {
    await once(first, "open");
    while (upstreamSockets.length < 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
    const firstResume = once(upstreamSockets[0], "message");
    first.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "thread-1" } }));
    await firstResume;
    const firstResponse = once(first, "message");
    upstreamSockets[0].send(JSON.stringify({
      id: 1,
      result: { thread: { id: "thread-1", modelProvider: "openai", turns: [] }, modelProvider: "openai", model: "cloud-model" },
    }));
    await firstResponse;
    const active = once(first, "message");
    upstreamSockets[0].send(JSON.stringify({ method: "thread/status/changed", params: { threadId: "thread-1", status: { type: "active" } } }));
    await active;
    const firstClosed = once(first, "close");
    first.close();
    await firstClosed;

    second = new WebSocket(proxy.url);
    await once(second, "open");
    while (upstreamSockets.length < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
    const secondResume = once(upstreamSockets[1], "message");
    second.send(JSON.stringify({ id: 2, method: "thread/resume", params: { threadId: "thread-1" } }));
    await secondResume;
    const secondResponse = once(second, "message");
    upstreamSockets[1].send(JSON.stringify({
      id: 2,
      result: { thread: { id: "thread-1", modelProvider: "openai", turns: [] }, modelProvider: "openai", model: "cloud-model" },
    }));
    await secondResponse;
    pending = { session_id: "thread-1", model: "local_compatible/local-model", effort: "low" };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    assert.equal(routeTakeCount, 0, "an active background turn must block resident-wide route polling");

    upstreamSockets[0].send(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1" } }));
    await Promise.race([
      completionBlocked,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for blocked completion delivery")), 1_000)),
    ]);
    const rejectedSwitch = once(second, "message");
    second.send(JSON.stringify({
      id: 3,
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "local_compatible/local-model", effort: "low" },
    }));
    const rejection = JSON.parse(String(await rejectedSwitch));
    assert.match(rejection.error?.message ?? "", /wait for the current turn to finish/i);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    assert.equal(routeTakeCount, 0, "completion in delivery must still block route polling");

    const secondClosed = once(second, "close");
    releaseCompletion();
    await Promise.race([
      secondClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for reconnect handoff (takes=${routeTakeCount}, handoffs=${handoffs.length})`)), 1_000)),
    ]);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].provider, "local_compatible");
    assert.ok(routeTakeCount >= 1);
  } finally {
    releaseCompletion?.();
    first.close();
    second?.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
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

test("resident proxy confirms a target thread only after its attach response is delivered", async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const address = upstream.address();
  let upstreamSocket;
  let upstreamAuthorization;
  const connected = new Promise((resolveConnection) => upstream.once("connection", (socket, request) => {
    upstreamSocket = socket;
    upstreamAuthorization = request.headers.authorization;
    resolveConnection();
  }));
  const attachments = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${address.port}`,
    activeProvider: "local_compatible",
    resumeRoute: { provider: "local_compatible", model: "local-model", effort: "low" },
    takePendingRoute: async () => null,
    onThreadAttached: async (attachment) => attachments.push(attachment),
  });
  const client = new WebSocket(proxy.url, { headers: { authorization: "Bearer launch-1" } });
  try {
    await once(client, "open");
    await connected;
    assert.equal(upstreamAuthorization, undefined, "the launch bearer must terminate at the loopback proxy");
    const forwarded = once(upstreamSocket, "message");
    client.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "thread-1" } }));
    await forwarded;
    const delivered = once(client, "message");
    upstreamSocket.send(JSON.stringify({
      id: 1,
      result: { thread: { id: "thread-1", modelProvider: "local_compatible", turns: [] }, modelProvider: "local_compatible", model: "local-model", reasoningEffort: "low" },
    }));
    await delivered;
    for (let attempt = 0; attempt < 100 && attachments.length === 0; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
    }
    assert.deepEqual(attachments, [{
      launchNonce: "launch-1",
      threadId: "thread-1",
      provider: "local_compatible",
      model: "local-model",
      effort: "low",
      method: "thread/resume",
      requestedThreadId: "thread-1",
      requestedProvider: "local_compatible",
      requestedModel: "local-model",
      requestedEffort: "low",
    }]);
  } finally {
    client.close();
    await proxy.close();
    await new Promise((resolveClose) => upstream.close(resolveClose));
  }
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
    takePendingRoute: async (threadId) => {
      if (pending?.session_id !== threadId) return null;
      const route = pending;
      pending = null;
      return { route, ack: async () => { acknowledged += 1; } };
    },
    onRouteInjected: async (receipt) => injected.push(receipt),
    onRouteConfirmed: async (receipt) => confirmed.push(receipt),
    threadListCwd: "/repo",
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
  assert.deepEqual(await listForwarded, { id: -1, method: "thread/list", params: { limit: 20, cwd: "/repo" } });
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
    params: { threadId: "thread-proxy", threadSettings: { model: "gpt-5.6-sol", effort: "high" } },
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
