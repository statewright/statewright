import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmod, cp, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { startCodexAppServerRouteProxy } from "./codex-app-server-route-proxy.mjs";
import { startCodexResponsesCompatibilityProxy } from "./codex-responses-compat-proxy.mjs";
import { createErrorReporter, isExpectedExit, isExpectedTransportClose } from "./error-reporting.mjs";
import { terminateWindowsProcessTree } from "./managed-client-supervisor.mjs";

const DEFAULT_READY_TIMEOUT_MS = 10_000;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function childStopped(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function ownedAppServerGroupAlive(child, platform = process.platform) {
  if (platform === "win32" || !Number.isInteger(child.pid)) return !childStopped(child);
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalOwnedAppServer(child, signal, platform = process.platform) {
  if (platform !== "win32" && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  if (!childStopped(child)) child.kill(signal);
}

async function waitForOwnedAppServerStop(child, graceMs, platform = process.platform) {
  const deadline = Date.now() + graceMs;
  while (ownedAppServerGroupAlive(child, platform)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(25, remaining));
  }
  return true;
}

export async function stopOwnedAppServer(child, closed, graceMs, {
  platform = process.platform,
  environment = process.env,
  cleanupWindowsTree = terminateWindowsProcessTree,
} = {}) {
  if (platform === "win32" && childStopped(child)) {
    await closed;
    return;
  }
  if (platform === "win32") {
    const cleanup = await cleanupWindowsTree(child, { environment });
    if (cleanup.status !== "success") {
      throw new Error(`Statewright could not stop the owned Codex App Server process tree (${cleanup.status}).`);
    }
    if (!await waitForOwnedAppServerStop(child, graceMs, platform)) {
      throw new Error(`Statewright could not confirm that its owned Codex App Server process ${child.pid ?? "unknown"} stopped.`);
    }
    await closed;
    return;
  }
  signalOwnedAppServer(child, "SIGTERM", platform);
  if (await waitForOwnedAppServerStop(child, graceMs, platform)) {
    await closed;
    return;
  }
  signalOwnedAppServer(child, "SIGKILL", platform);
  if (await waitForOwnedAppServerStop(child, graceMs, platform)) {
    await closed;
    return;
  }
  throw new Error(`Statewright could not confirm that its owned Codex App Server process ${child.pid ?? "unknown"} stopped.`);
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  if (!address || typeof address === "string") throw new Error("Unable to reserve a loopback App Server port.");
  return address.port;
}

export function codexAppServerTransportEnabled({ environment = process.env, config = {} } = {}) {
  const override = environment.STATEWRIGHT_CODEX_TRANSPORT?.trim();
  if (override) return override === "app-server";
  return config?.routing?.managed_clients?.codex_transport === "app-server";
}

export function appServerHomePrefixForClient(clientId) {
  return `statewright-${String(clientId).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60)}`;
}

function tomlTopLevelStrings(source) {
  const values = {};
  let inTable = false;
  for (const line of String(source).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      inTable = true;
      continue;
    }
    if (inTable) continue;
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
    if (!match) continue;
    try {
      values[match[1]] = match[2].startsWith('"')
        ? JSON.parse(match[2])
        : match[2].slice(1, -1);
    } catch { /* invalid values are left to Codex's own config diagnostics */ }
  }
  return values;
}

export function codexProviderBaseUrl(source, provider) {
  const expected = String(provider ?? "").trim();
  if (!expected) return null;
  let activeProvider = null;
  for (const line of String(source).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const table = trimmed.match(/^\[model_providers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/);
    if (table) {
      activeProvider = table[1] ?? table[2] ?? table[3];
      continue;
    }
    if (trimmed.startsWith("[")) {
      activeProvider = null;
      continue;
    }
    if (activeProvider !== expected) continue;
    const setting = trimmed.match(/^base_url\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
    if (!setting) continue;
    try {
      return setting[1].startsWith('"') ? JSON.parse(setting[1]) : setting[1].slice(1, -1);
    } catch {
      return null;
    }
  }
  return null;
}

async function statewrightProviderSettings(codexHome, profileName) {
  const path = join(codexHome, `${profileName}.statewright.json`);
  const source = await readFile(path, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "{}";
    throw error;
  });
  const settings = JSON.parse(source);
  const compatibility = settings?.responses_compatibility;
  if (compatibility !== undefined && compatibility !== "replace_encrypted_compaction") {
    throw new Error(`Statewright profile '${profileName}' has an unsupported responses_compatibility value.`);
  }
  return compatibility ? { responsesCompatibility: compatibility } : {};
}

function modelListEntry(model) {
  const id = String(model?.slug ?? "").trim();
  if (!id) return null;
  return {
    id,
    model: id,
    displayName: String(model.display_name ?? id),
    description: String(model.description ?? ""),
    hidden: !["list", "visible"].includes(String(model.visibility ?? "list")),
    supportedReasoningEfforts: Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels.map((entry) => ({
        reasoningEffort: entry.effort,
        description: String(entry.description ?? ""),
      })).filter((entry) => entry.reasoningEffort)
      : [],
    defaultReasoningEffort: model.default_reasoning_level ?? "medium",
    inputModalities: Array.isArray(model.input_modalities) ? model.input_modalities : ["text"],
    supportsPersonality: model.supports_personality === true,
    multiAgentVersion: model.multi_agent_version ?? null,
    additionalSpeedTiers: Array.isArray(model.additional_speed_tiers) ? model.additional_speed_tiers : [],
    serviceTiers: Array.isArray(model.service_tiers) ? model.service_tiers : [],
    defaultServiceTier: model.default_service_tier ?? null,
    isDefault: false,
    upgrade: model.upgrade ?? null,
    upgradeInfo: model.upgrade_info ?? null,
    availabilityNux: model.availability_nux ?? null,
    modelSpecialty: model.model_specialty ?? null,
  };
}

/**
 * Codex profile-v2 files are isolated config layers at
 * `$CODEX_HOME/<name>.config.toml`. Statewright reads only the routing keys
 * needed to expose their model catalogs; provider URLs and credentials remain
 * owned by Codex and are never copied into route state or telemetry.
 */
export async function discoverCodexProviderProfiles(codexHome) {
  const entries = await readdir(codexHome, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const profiles = [];
  const providerProfiles = new Map();
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".config.toml")).sort((a, b) => a.name.localeCompare(b.name))) {
    const configPath = join(codexHome, entry.name);
    const values = tomlTopLevelStrings(await readFile(configPath, "utf8"));
    const provider = String(values.model_provider ?? "").trim();
    const catalogSetting = String(values.model_catalog_json ?? "").trim();
    if (!provider || !catalogSetting) continue;
    const catalogPath = isAbsolute(catalogSetting) ? catalogSetting : resolve(dirname(configPath), catalogSetting);
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    const models = (Array.isArray(catalog?.models) ? catalog.models : []).map(modelListEntry).filter(Boolean);
    if (models.length === 0) continue;
    const existingProfile = providerProfiles.get(provider);
    if (existingProfile) {
      throw new Error(`Codex provider '${provider}' is configured by both '${existingProfile}.config.toml' and '${entry.name}'. Use one profile-v2 catalog per provider so /model selections have an unambiguous launch profile.`);
    }
    const profileName = entry.name.slice(0, -".config.toml".length);
    const statewrightSettings = await statewrightProviderSettings(codexHome, profileName);
    providerProfiles.set(provider, profileName);
    profiles.push({
      profile: profileName,
      provider,
      model: String(values.model ?? models[0].model).trim(),
      webSearch: values.web_search ?? null,
      ...statewrightSettings,
      appServerConfig: {
        model: String(values.model ?? models[0].model).trim(),
        model_provider: provider,
        model_catalog_json: catalogPath,
        ...(values.model_reasoning_effort ? { model_reasoning_effort: values.model_reasoning_effort } : {}),
        ...(values.service_tier ? { service_tier: values.service_tier } : {}),
        ...(values.web_search ? { web_search: values.web_search } : {}),
      },
      models,
    });
  }
  return profiles;
}

export async function discoverCodexBaseProfile(codexHome) {
  const values = tomlTopLevelStrings(await readFile(join(codexHome, "config.toml"), "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  }));
  const provider = String(values.model_provider ?? "openai").trim() || "openai";
  const cache = JSON.parse(await readFile(join(codexHome, "models_cache.json"), "utf8").catch((error) => {
    if (error?.code === "ENOENT") return '{"models":[]}';
    throw error;
  }));
  const selectedModel = String(values.model ?? "").trim();
  const models = (Array.isArray(cache?.models) ? cache.models : []).map(modelListEntry).filter(Boolean)
    .map((entry) => ({ ...entry, isDefault: entry.model === selectedModel }));
  return { profile: null, provider, model: selectedModel || models.find((entry) => entry.isDefault)?.model || models[0]?.model || null, webSearch: values.web_search ?? null, models };
}

function appServerConfigArgs(profile, route = null) {
  const model = String(route?.model ?? "").replace(/^[^/]+\//, "").trim();
  const provider = String(route?.provider ?? "").trim();
  const effort = String(route?.effort ?? "").trim();
  const config = {
    ...(profile?.appServerConfig ?? {}),
    ...(model ? { model } : {}),
    ...(provider ? { model_provider: provider } : {}),
    ...(effort ? { model_reasoning_effort: effort } : {}),
  };
  return Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
}

export function routeConfigEdits(route) {
  const model = String(route?.model ?? "").replace(/^[^/]+\//, "").trim();
  const effort = String(route?.effort ?? "").trim();
  if (!model) throw new Error("Statewright App Server route is missing a model.");
  const edits = [{ keyPath: "model", mergeStrategy: "upsert", value: model }];
  if (effort) edits.push({ keyPath: "model_reasoning_effort", mergeStrategy: "upsert", value: effort });
  return edits;
}

async function prepareAppServerHome(codexHome, clientId) {
  const appServerHome = await mkdtemp(join(tmpdir(), `${appServerHomePrefixForClient(clientId)}-app-server-`));
  await chmod(appServerHome, 0o700);
  const entries = await readdir(codexHome, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const source = join(codexHome, entry.name);
    const target = join(appServerHome, entry.name);
    // The isolated config must be mutable for config/batchWrite. Everything else,
    // including auth and installed plugins, is shared read-only by path.
    if (entry.name === "config.toml") {
      await cp(source, target);
    } else {
      await symlink(source, target, entry.isDirectory() ? "dir" : "file");
    }
  }
  const configPath = join(appServerHome, "config.toml");
  await writeFile(configPath, "# Statewright ephemeral App Server configuration.\n", { flag: "a", mode: 0o600 });
  return { appServerHome, configPath };
}

function stripRemoteArgs(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--remote" || arg === "--remote-auth-token-env" || arg === "-m" || arg === "--model") {
      index += 1;
      continue;
    }
    if (arg === "-c" && /(^|\.)model_reasoning_effort\s*=/.test(args[index + 1] ?? "")) {
      index += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function resumeHistoryLimit(environment) {
  const configured = Number.parseInt(environment.STATEWRIGHT_CODEX_RESUME_TURN_LIMIT ?? "4", 10);
  return Number.isInteger(configured) && configured > 0 && configured <= 20 ? configured : 4;
}

async function waitForReady(url, appServer) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (appServer.exitCode !== null) throw new Error(`Codex App Server exited before it became ready (${appServer.exitCode}).`);
    try {
      const response = await fetch(`${url.replace(/^ws/, "http")}/readyz`, { signal: AbortSignal.timeout(250) });
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await delay(100);
  }
  throw new Error("Timed out waiting for the local Codex App Server.");
}

/**
 * Runs the native Codex TUI against one local App Server. A loopback proxy
 * applies a pending route directly to the next native turn/start request.
 */
export async function runCodexAppServerTransport({
  command,
  args,
  environment = process.env,
  cwd = process.cwd(),
  home = homedir(),
  clientId,
  controlDir,
  nextRouteRequest,
  pollMs = 100,
  stderr = process.stderr,
  telemetry = async () => {},
  reporter = createErrorReporter({ plugin: "codex", version: "0.3.2", environment }),
}) {
  let pendingRoute = null;
  const runtime = await startCodexAppServerRuntime({
    command,
    environment,
    cwd,
    home,
    clientId,
    nextRouteRequest: async (threadId) => {
      if (pendingRoute?.session_id && pendingRoute.session_id !== threadId) return null;
      const route = pendingRoute;
      pendingRoute = null;
      return route;
    },
    stderr,
    telemetry,
    reporter,
  });
  let tui;
  try {
    tui = spawn(command, [...stripRemoteArgs(args), "--remote", runtime.proxyUrl], {
      cwd,
      env: environment,
      stdio: "inherit",
    });
    const tuiExit = new Promise((resolveExit, rejectExit) => {
      tui.once("error", rejectExit);
      tui.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    let exited = false;
    tui.once("exit", () => { exited = true; });
    while (!exited) {
      const request = await nextRouteRequest(controlDir).catch(() => null);
      if (request) {
        pendingRoute = request;
        await telemetry("app_server_route_requested", { client_id: clientId, route: request });
      }
      await delay(pollMs);
    }
    const result = await tuiExit;
    if (!isExpectedExit(result)) await reporter.report(new Error("Native Codex TUI exited unexpectedly."), {
      mechanism: "child_exit", host: "codex", operation: "native_tui", exit_code: result.code ?? 1, signal: result.signal,
    });
    return result.code ?? 1;
  } finally {
    if (tui && tui.exitCode === null) tui.kill("SIGTERM");
    await runtime.close();
  }
}

/**
 * Starts the App Server and Statewright route proxy without a terminal UI.
 * A resident owner can keep this runtime alive while native Codex clients
 * attach and detach through the same proxy endpoint.
 */
export async function startCodexAppServerRuntime({
  command,
  commandArgs = [],
  environment = process.env,
  cwd = process.cwd(),
  home = homedir(),
  clientId,
  nextRouteRequest = async () => null,
  stderr = process.stderr,
  telemetry = async () => {},
  threadListCwd = null,
  profile = null,
  resumeRoute = null,
  onProviderHandoff = async () => {},
  prepareProviderHandoff = null,
  onThreadAttached = async () => {},
  idleMs = 500,
  shutdownGraceMs = 1_500,
  onIdle = async () => {},
  reporter = createErrorReporter({ plugin: "codex", version: "0.3.2", environment }),
}) {
  const codexHome = environment.CODEX_HOME ?? join(home, ".codex");
  const port = await reserveLoopbackPort();
  const url = `ws://127.0.0.1:${port}`;
  const { appServerHome } = await prepareAppServerHome(codexHome, clientId);
  const [baseProfile, providerProfiles] = await Promise.all([
    discoverCodexBaseProfile(codexHome),
    discoverCodexProviderProfiles(codexHome),
  ]);
  const profiles = [baseProfile, ...providerProfiles];
  const selectedProfile = profile
    ? profiles.find((candidate) => candidate.profile === profile)
    : baseProfile;
  if (profile && !selectedProfile) throw new Error(`Statewright could not load Codex profile '${profile}'.`);
  const activeRoute = resumeRoute ?? (selectedProfile?.provider && selectedProfile?.model ? {
    provider: selectedProfile.provider,
    model: selectedProfile.model,
  } : null);

  let compatibilityProxy = null;
  let launchProfile = selectedProfile;
  if (selectedProfile?.responsesCompatibility === "replace_encrypted_compaction") {
    const configSource = await readFile(join(codexHome, "config.toml"), "utf8");
    const upstreamBaseUrl = codexProviderBaseUrl(configSource, selectedProfile.provider);
    if (!upstreamBaseUrl) {
      throw new Error(`Statewright could not find model_providers.${selectedProfile.provider}.base_url for the Responses compatibility adapter.`);
    }
    compatibilityProxy = await startCodexResponsesCompatibilityProxy({
      upstreamBaseUrl,
      onTranslation: async ({ translated }) => {
        await telemetry("app_server_compaction_compatibility_applied", {
          client_id: clientId,
          provider: selectedProfile.provider,
          translated_items: translated,
        });
        stderr.write(`[statewright] translated ${translated} provider-incompatible encrypted compaction item${translated === 1 ? "" : "s"} into an explicit history handoff.\n`);
      },
    });
    launchProfile = {
      ...selectedProfile,
      appServerConfig: {
        ...selectedProfile.appServerConfig,
        [`model_providers.${selectedProfile.provider}.base_url`]: compatibilityProxy.baseUrl,
      },
    };
  }

  const appServer = spawn(command, [...commandArgs, "app-server", ...appServerConfigArgs(launchProfile, activeRoute), "--listen", url], {
    cwd,
    env: { ...environment, CODEX_HOME: appServerHome },
    stdio: ["ignore", "pipe", "pipe"],
    // Own the launcher and its native Codex descendant as one POSIX process
    // group so a provider handoff cannot leave the actual App Server behind.
    detached: process.platform !== "win32",
  });
  const appServerClosed = new Promise((resolveClosed) => appServer.once("close", resolveClosed));
  appServer.stderr.on("data", (chunk) => stderr.write(chunk));
  appServer.stdout.resume();
  let closing = false;
  appServer.once("error", (error) => { void reporter.report(error, { mechanism: "child_spawn", host: "codex", operation: "app_server" }); });
  appServer.once("exit", (code, signal) => {
    if (!isExpectedExit({ code, signal, shuttingDown: closing })) {
      void reporter.report(new Error("Codex App Server exited unexpectedly."), {
        mechanism: "child_exit", host: "codex", operation: "app_server", exit_code: code ?? 1, signal,
      });
    }
  });

  try {
    await waitForReady(url, appServer);
    const routeProxy = await startCodexAppServerRouteProxy({
      upstreamUrl: url,
      compactResume: environment.STATEWRIGHT_CODEX_COMPACT_RESUME !== "false",
      resumeHistoryLimit: resumeHistoryLimit(environment),
      threadListCwd,
      profiles,
      activeProvider: activeRoute?.provider ?? selectedProfile?.provider ?? "openai",
      resumeRoute: activeRoute,
      onProviderHandoff,
      prepareProviderHandoff,
      onThreadAttached,
      idleMs,
      onIdle,
      takePendingRoute: nextRouteRequest,
      onRouteInjected: async (receipt) => {
        await telemetry("app_server_route_injected", { client_id: clientId, ...receipt });
        stderr.write(`[statewright] injected next-turn route ${receipt.effectiveModel}${receipt.effectiveEffort ? ` (${receipt.effectiveEffort})` : ""}.\n`);
      },
      onRouteConfirmed: async (receipt) => {
        await telemetry(receipt.confirmed ? "app_server_route_confirmed" : "app_server_route_mismatch", { client_id: clientId, ...receipt });
        stderr.write(`[statewright] App Server ${receipt.confirmed ? "confirmed" : "reported a mismatch for"} ${receipt.actualModel}${receipt.actualEffort ? ` (${receipt.actualEffort})` : ""}.\n`);
      },
      onConnection: async ({ direction, method, upstreamUrl, bytes, resultKeys }) => {
        if (!direction) stderr.write("[statewright] native Codex connected to the App Server proxy.\n");
        else stderr.write(`[statewright] App Server proxy ${direction}: ${method ?? upstreamUrl ?? "connection"}${bytes ? ` (${bytes} bytes)` : ""}${resultKeys ? ` [${resultKeys.join(",")}]` : ""}.\n`);
      },
      onTransportError: async ({ side, message, code }) => {
        stderr.write(`[statewright] App Server proxy ${side} transport error: ${message}.\n`);
        if (!closing && !isExpectedTransportClose({ side, code })) await reporter.report(new Error(message), {
          mechanism: "transport", host: "codex", operation: "app_server_proxy", transport: "websocket", side, close_code: code,
        });
      },
      onProtocolError: async ({ side, message }) => {
        if (!closing) await reporter.report(new Error(message), {
          mechanism: "protocol", host: "codex", operation: "app_server_proxy", transport: "websocket", side,
        });
      },
    });
    const ready = await fetch(`${routeProxy.url.replace(/^ws/, "http")}/readyz`);
    if (!ready.ok) throw new Error("Statewright App Server proxy did not become ready.");
    stderr.write(`[statewright] App Server ready at ${routeProxy.url}; upstream ${url}.\n`);
    return {
      proxyUrl: routeProxy.url,
      upstreamUrl: url,
      appServerPid: appServer.pid,
      async close() {
        closing = true;
        await routeProxy.close().catch(async (error) => {
          await reporter.report(error, { mechanism: "shutdown", host: "codex", operation: "app_server_proxy" }).catch(() => {});
        });
        await stopOwnedAppServer(appServer, appServerClosed, shutdownGraceMs);
        await compatibilityProxy?.close();
        // Keep the isolated home addressable after shutdown. A native TUI can
        // still be holding the App Server URL while the owned server exits;
        // deleting the projection turns a recoverable disconnect into
        // Codex's misleading `no rollout found` resume error. Its entries are
        // symlinked to the canonical home and can be replaced next launch.
      },
    };
  } catch (error) {
    closing = true;
    await stopOwnedAppServer(appServer, appServerClosed, shutdownGraceMs);
    await compatibilityProxy?.close().catch(() => {});
    // Preserve the projection for a TUI that may still be unwinding after a
    // failed startup; see the normal close path above.
    throw error;
  }
}
