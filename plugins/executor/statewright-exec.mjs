#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir, tmpdir } from "node:os";
import {
  assertDeliveryConfigPaths,
  DELIVERY_CONFIG_RELATIVE_PATH,
  resolveDeliveryBootstrap,
} from "./lib/delivery-config.mjs";
import { DeliveryController } from "./lib/delivery-controller.mjs";
import { WorkspaceSession } from "./lib/workspace-session.mjs";
import {
  createNullTelemetryWriter,
  createTelemetryWriter,
  defaultTelemetryPath,
} from "./lib/telemetry.mjs";
import { ExecutorLease, validateExecutorLease } from "./lib/executor-lease.mjs";
import { AdapterBridge } from "./lib/adapter-bridge.mjs";
import {
  buildHostLaunch,
  hostRoutingMode,
  hostRequiresTerminalStop,
  hostSupportsLiveRouting,
  prepareHostSession,
  SUPPORTED_HOSTS,
  assertHostOwnershipArgs,
  createPiNativeSession,
  assertPiNativeSession,
} from "./lib/host-adapters.mjs";
import { createExecutorSessionStore, attachExecutorSession } from "./lib/executor-session-ownership.mjs";
import { RemoteStatewrightClient, resolveApiKey } from "./lib/remote-client.mjs";
import { createExecutorApprovalMirror } from "./lib/executor-approval-mirror.mjs";
import { createPiExecutorRuntime } from "./lib/executor-pi-runtime.mjs";
import { createErrorReporter, isExpectedPluginError } from "./lib/error-reporting.mjs";

const EXECUTOR_ROOT = dirname(fileURLToPath(import.meta.url));

const HELP = `Usage:
  statewright-exec --host HOST --workflow NAME [options] -- TASK

Required:
  --host HOST                ${SUPPORTED_HOSTS.join(", ")}
  --workflow NAME            Statewright workflow to load

Session:
  --cwd PATH                 Source repository (default: current directory)
  --project-id ID            Optional Statewright project scope
  --resume-workflow          Resume the workflow's paused run
  --executor-session-id ID   Exact persisted executor session (required for resume)
  --host-bin PATH            Override the host executable
  --host-arg ARG             Pass one argument to the host (repeatable)
  --plugins-root PATH        Statewright plugins directory
                             (default: STATEWRIGHT_PLUGINS_ROOT or repository sibling)
  --fallback-model MODEL     Host startup model when the workflow has no route
  --fallback-effort LEVEL    Host startup effort when the workflow has no route
  --keep-host-on-final       Leave the TUI open after a final workflow state
  --pi-request-frontend     Experimental parent-owned Pi SDK frontend (no fallback)
  --pi-agent-dir PATH       Exact Pi SDK agent/config directory for that path
  --pi-mode MODE            interactive (default), text or json startup task

Delivery:
  ${DELIVERY_CONFIG_RELATIVE_PATH}     Auto-discovered isolated-delivery config
  --delivery-config PATH     Explicit delivery config
  --delivery-run-id ID       Resume or name a delivery run

Telemetry:
  --telemetry-path PATH      JSONL path (default: ${defaultTelemetryPath()})
  --no-telemetry             Disable executor telemetry
`;

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    hostArgs: [],
    promptParts: [],
    exitOnFinal: true,
    telemetryEnabled: true,
    telemetryPath: defaultTelemetryPath(),
  };
  const values = new Map([
    ["--host", "host"],
    ["--workflow", "workflow"],
    ["--cwd", "cwd"],
    ["--project-id", "projectId"],
    ["--executor-session-id", "executorSessionId"],
    ["--host-bin", "hostBin"],
    ["--plugins-root", "pluginsRoot"],
    ["--fallback-model", "fallbackModel"],
    ["--fallback-effort", "fallbackEffort"],
    ["--pi-agent-dir", "piAgentDir"],
    ["--pi-mode", "piMode"],
    ["--delivery-config", "deliveryConfig"],
    ["--delivery-run-id", "deliveryRunId"],
    ["--telemetry-path", "telemetryPath"],
  ]);
  let promptMode = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (promptMode) options.promptParts.push(arg);
    else if (arg === "--") promptMode = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--resume-workflow") options.resumeWorkflow = true;
    else if (arg === "--keep-host-on-final") options.exitOnFinal = false;
    else if (arg === "--no-telemetry") options.telemetryEnabled = false;
    else if (arg === "--pi-request-frontend") options.piRequestFrontend = true;
    else if (arg === "--host-arg") {
      if (!argv[index + 1]) throw new Error("--host-arg requires a value.");
      options.hostArgs.push(argv[++index]);
    } else if (values.has(arg)) {
      if (!argv[index + 1]) throw new Error(`${arg} requires a value.`);
      options[values.get(arg)] = argv[++index];
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else options.promptParts.push(arg);
  }
  options.prompt = options.promptParts.join(" ").trim();
  return options;
}

function validateOptions(options) {
  if (!SUPPORTED_HOSTS.includes(options.host)) {
    throw new Error(`--host must be one of: ${SUPPORTED_HOSTS.join(", ")}.`);
  }
  if (!options.workflow || /[\u0000-\u001f\u007f]/.test(options.workflow)) {
    throw new Error("--workflow must be a printable workflow name.");
  }
  if (!options.prompt) throw new Error("Provide the task after '--'.");
  if (options.resumeWorkflow && !options.executorSessionId) throw new Error("--resume-workflow requires an explicit --executor-session-id");
  if (options.resumeWorkflow && !["pi", "claude", "cursor"].includes(options.host)) {
    throw new Error("Exact native-session resume is not yet supported for this executor host");
  }
  assertHostOwnershipArgs(options);
  if (!options.piRequestFrontend && (options.piAgentDir || options.piMode)) throw new Error("Pi SDK options require --pi-request-frontend");
  if (options.piMode && !["interactive", "text", "json"].includes(options.piMode)) throw new Error("Invalid --pi-mode");
}

export function resolvePluginsRoot(options) {
  const requested = options.pluginsRoot
    ?? process.env.STATEWRIGHT_PLUGINS_ROOT
    ?? resolve(EXECUTOR_ROOT, "..");
  let root;
  try {
    root = realpathSync(resolve(requested));
  } catch {
    throw new Error(`Statewright plugins root does not exist: ${resolve(requested)}`);
  }
  const adapterDirectory = options.host === "claude" ? "claude-code" : options.host;
  const adapterPath = join(root, adapterDirectory);
  try {
    if (!statSync(adapterPath).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(
      `Statewright ${options.host} adapter was not found under plugins root: ${adapterPath}`,
    );
  }
  return root;
}

function sanitizedAgentEnvironment(environment) {
  const safe = { ...environment };
  delete safe.STATEWRIGHT_PI_REQUEST_LAUNCH;
  for (const name of Object.keys(safe)) {
    if (
      /^(KUBECONFIG|KUBE_|KUBERNETES_|DOCKER_CONFIG$|REGISTRY_|GH_TOKEN$|GITHUB_TOKEN$|NPM_TOKEN$|CARGO_REGISTRY_TOKEN$|STATEWRIGHT_API_KEY$|STRIPE_|SMTP_|SENTRY_)/.test(name)
    ) delete safe[name];
  }
  safe.KUBECONFIG = "/dev/null";
  return safe;
}

function opencodeIsolationRoot(executorId) {
  return join(tmpdir(), `statewright-opencode-${executorId}`);
}

function opencodeEnvironment(environment, session) {
  const pluginUrl = pathToFileURL(
    resolve(session.pluginsRoot, "opencode", "src", "index.ts"),
  ).href;
  const proxyPath = resolve(EXECUTOR_ROOT, "mcp-proxy.sh");
  let inline = {};
  if (environment.OPENCODE_CONFIG_CONTENT) {
    try {
      inline = JSON.parse(environment.OPENCODE_CONFIG_CONTENT);
    } catch {
      throw new Error("OPENCODE_CONFIG_CONTENT must contain valid JSON.");
    }
  }

  // Executor-owned runs must not inherit user/project agents, plugins, prompts,
  // or routes. Provider and permission settings remain available when callers
  // deliberately supply them through OPENCODE_CONFIG_CONTENT.
  const {
    plugin: _plugin,
    plugins: _plugins,
    mcp: _mcp,
    agent: _agent,
    mode: _mode,
    command: _command,
    instructions: _instructions,
    default_agent: _defaultAgent,
    model: _model,
    small_model: _smallModel,
    share: _share,
    autoshare: _autoshare,
    ...inlineRuntimeConfig
  } = inline;
  const isolationRoot = opencodeIsolationRoot(session.executorId);
  const result = { ...environment };
  delete result.OPENCODE_CONFIG;
  delete result.OPENCODE_CONFIG_DIR;
  delete result.OPENCODE_PURE;
  // OpenCode's built-in OpenAI auth plugin reads the separate auth store, so
  // keep default plugins enabled while isolating external config directories.
  delete result.OPENCODE_DISABLE_DEFAULT_PLUGINS;

  return {
    ...result,
    XDG_CONFIG_HOME: join(isolationRoot, "xdg-config"),
    OPENCODE_TEST_HOME: join(isolationRoot, "home"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_AUTO_SHARE: "false",
    STATEWRIGHT_OPENCODE_ISOLATION_ROOT: isolationRoot,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...inlineRuntimeConfig,
      share: "disabled",
      autoshare: false,
      plugin: [pluginUrl],
      mcp: {
        statewright: {
          type: "local",
          command: ["bash", proxyPath],
          enabled: true,
        },
      },
    }),
  };
}

export function executorAgentEnvironment(environment, session) {
  let result = sanitizedAgentEnvironment(environment);
  result = {
    ...result,
    STATEWRIGHT_WORKFLOW: session.workflow,
    STATEWRIGHT_CLIENT_ID: session.transportClientId ?? session.transportSessionId,
    STATEWRIGHT_MCP_SESSION_ID: session.transportSessionId,
    STATEWRIGHT_BRANCH_SESSION_ID: session.transportSessionId,
    STATEWRIGHT_EXECUTOR_ID: session.executorId,
    STATEWRIGHT_ADAPTER_URL: session.adapterBridge.url,
    STATEWRIGHT_ADAPTER_TOKEN: session.adapterBridge.token,
  };
  if (session.workspaceSession) {
    result.STATEWRIGHT_DELIVERY_ACTIVE = "1";
    result.STATEWRIGHT_DELIVERY_MANIFEST = session.workspaceSession.manifestPath;
    result.STATEWRIGHT_EXECUTOR_LEASE = session.leasePath;
  }
  if (session.host === "opencode") result = opencodeEnvironment(result, session);
  return result;
}

async function waitForChild(child) {
  return new Promise((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("exit", (code, signal) => resolveChild({ code, signal }));
  });
}

export function assertHostAdapterContract(options) {
  if (options.piRequestFrontend && (!options.approvalMirror?.deferClear || !options.nativeReadiness
    || !options.nativeReadiness.isBoundTo(options.sessionOwner, options.requestController)
    || options.adapterBridge?.nativeReadiness !== options.nativeReadiness
    || options.adapterBridge?.requestController !== options.requestController
    || options.adapterBridge?.sessionOwner !== options.sessionOwner)) {
    throw new Error("Owned Pi execution requires one exact parent readiness/controller/bridge and deferred journal");
  }
  if (
    options.host === "opencode"
    && typeof options.adapterBridge?.waitForReady !== "function"
  ) {
    throw new Error("OpenCode execution requires an adapter bridge readiness contract.");
  }
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  const timer = setTimeout(() => child.kill("SIGTERM"), 5_000);
  timer.unref?.();
}

function stopOwnedChild(options, child) {
  // Revoke synchronously before SIGINT can be interpreted as a fresh input.
  // The owning observer's finally awaits and reports any cancellation failure.
  if (options.piRequestFrontend) void options.nativeReadiness.close().catch(() => {});
  stopChild(child);
}

export async function observeHost(options) {
  try { return await observeHostLifetime(options); }
  finally { if (options.piRequestFrontend) await options.nativeReadiness?.close(); }
}

async function observeHostLifetime(options) {
  assertHostAdapterContract(options);
  const {
    client,
    deliveryController,
    telemetry,
    approvalMirror,
  } = options;
  if (!approvalMirror) throw new Error("Host observation requires approval journal ownership.");
  await options.sessionOwner?.assertOwner();
  options.sessionOwner?.assertGateway(options.initialState);
  const initialApprovalStatus = await approvalMirror.observe(options.initialState);
  await options.sessionOwner?.assertOwner();
  if (options.host === "pi" && !options.piRequestFrontend && (initialApprovalStatus === "parked" || options.initialState.pending_approval != null)) {
    await telemetry("executor_pi_approval_launch_held", { host: "pi", state: options.initialState.state });
    return { status: "approval_parked", code: 0, signal: null, state: options.initialState, finalSeen: false };
  }
  let state = options.initialState;
  let stateKey = `${state.state}:${state.iteration ?? 0}`;
  let finalSeen = Boolean(state.is_final);
  let continuation = false;

  while (true) {
    await options.sessionOwner?.assertOwner();
    if (options.host === "pi") await assertPiNativeSession({ sessionFile: options.hostSessionFile, sessionId: options.hostSessionId, cwd: options.cwd });
    const launch = buildHostLaunch(options, state, continuation);
    await telemetry("executor_host_started", {
      host: options.host,
      state: state.state,
      routing_mode: hostRoutingMode(options.host),
      live_routing: hostSupportsLiveRouting(options.host),
      continuation,
      command: launch.command,
    });
    const child = (options.spawnHost ?? spawn)(launch.command, launch.args, {
      cwd: options.cwd,
      env: launch.environment ?? options.environment,
      stdio: "inherit",
    });
    const childResult = waitForChild(child);

    if (options.piRequestFrontend) {
      try {
        options.nativeReadiness.bindChild(child);
        if (!await options.nativeReadiness.waitForAcknowledgement({ timeoutMs: options.nativeReadyTimeoutMs ?? 5_000 })) {
          throw new Error("Owned Pi exited or timed out without exact native acknowledgement");
        }
      } catch (error) {
        const revocation = options.nativeReadiness.close();
        stopChild(child);
        // Start shutdown before durable cancellation can stall, but do not
        // return on cancellation failure until the owned child is reaped.
        const [revoked] = await Promise.allSettled([revocation, childResult]);
        if (revoked.status === "rejected") throw revoked.reason;
        throw error;
      }
    }

    if (options.host === "opencode") {
      const ready = await Promise.race([
        options.adapterBridge.waitForReady({ timeoutMs: 5_000 }),
        childResult.then(() => false),
      ]);
      if (!ready) {
        await telemetry("executor_adapter_ready_timeout", {
          host: options.host,
          state: state.state,
        });
        stopChild(child);
        await childResult;
        throw new Error(
          "OpenCode started without attesting that the Statewright native-tool adapter loaded.",
        );
      }
    }

    let observerError = null;
    let pollPromise = null;
    let rerouteRequested = false;
    let piApprovalHeld = false;
    const poll = () => {
      if (pollPromise) return pollPromise;
      if (observerError || finalSeen) return Promise.resolve();
      pollPromise = (async () => {
        try {
          const next = await client.call("statewright_get_state");
          await options.sessionOwner?.assertOwner();
          options.sessionOwner?.assertGateway(next);
          const approvalStatus = await approvalMirror.observe(next);
          await options.sessionOwner?.assertOwner();
          if (options.host === "pi" && !options.piRequestFrontend && (approvalStatus === "parked" || next.pending_approval != null) && !piApprovalHeld) {
            piApprovalHeld = true;
            // Hold-only intermediate behavior: terminate our owned native Pi,
            // rather than let SIGINT become an interactive retry/next prompt.
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            await telemetry("executor_pi_approval_host_held", { host: "pi", state: next.state });
          }
          const nextKey = `${next.state}:${next.iteration ?? 0}`;
          const previous = state;
          state = next;
          if (nextKey !== stateKey) {
            const changedState = next.state !== previous.state;
            const changedRoute = (next.model ?? next.default_model ?? null)
              !== (previous.model ?? previous.default_model ?? null)
              || (next.thinking_level ?? null) !== (previous.thinking_level ?? null);
            stateKey = nextKey;
            if (changedState) {
              await deliveryController?.observeState(next);
              await telemetry("executor_state_observed", {
                host: options.host,
                state: next.state,
                model: next.model ?? null,
                thinking_level: next.thinking_level ?? null,
              });
            }
            if (changedRoute && !next.pending_approval && hostRoutingMode(options.host) === "restart") {
              rerouteRequested = true;
              stopOwnedChild(options, child);
            }
          }
          if (next.is_final) {
            finalSeen = true;
            if (options.exitOnFinal) stopOwnedChild(options, child);
          }
        } catch (error) {
          observerError = error;
          stopOwnedChild(options, child);
        } finally {
          pollPromise = null;
        }
      })();
      return pollPromise;
    };
    const timer = setInterval(() => poll(), options.pollIntervalMs ?? 500);
    let result;
    try {
      result = await childResult;
    } finally {
      clearInterval(timer);
      await pollPromise;
    }
    await poll();
    if (observerError) throw observerError;
    if (rerouteRequested && !piApprovalHeld && !finalSeen && !state.pending_approval) {
      continuation = true;
      await telemetry("executor_host_reroute", {
        host: options.host,
        state: state.state,
        model: state.model ?? state.default_model ?? null,
        thinking_level: state.thinking_level ?? null,
      });
      continue;
    }
    return { ...result, ...(piApprovalHeld ? { status: "approval_parked" } : {}), state, finalSeen };
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return { status: "help" };
  }
  validateOptions(options);
  options.pluginsRoot = resolvePluginsRoot(options);

  const requestedCwd = resolve(options.cwd);
  const deliveryBootstrap = await resolveDeliveryBootstrap({
    cwd: requestedCwd,
    explicitPath: options.deliveryConfig,
  });
  let workspaceSession = null;
  if (deliveryBootstrap.enabled) {
    await assertDeliveryConfigPaths(deliveryBootstrap.config);
    workspaceSession = await WorkspaceSession.prepare(deliveryBootstrap.config, {
      runId: options.deliveryRunId,
    });
  } else if (options.deliveryRunId) {
    throw new Error("--delivery-run-id requires enabled isolated delivery.");
  }

  const cwd = workspaceSession?.primaryCwd ?? requestedCwd;
  const apiKey = await resolveApiKey();
  const executorId = randomUUID();
  const gatewayUrl = process.env.STATEWRIGHT_GATEWAY_URL ?? "https://mcp.statewright.ai";
  const telemetry = options.telemetryEnabled
    ? createTelemetryWriter(resolve(options.telemetryPath), {
        endpoint: process.env.STATEWRIGHT_TELEMETRY_URL ?? null,
        apiKey,
      })
    : createNullTelemetryWriter();
  const deliveryController = workspaceSession
    ? await new DeliveryController(workspaceSession, { telemetry }).initialize()
    : null;
  const leasePath = workspaceSession
    ? join(workspaceSession.runRoot, "executor-lease.json")
    : join(tmpdir(), `statewright-executor-${executorId}.json`);
  let lease = null;
  let sessionOwner = null;
  let adapterBridge = null;
  let piRuntime = null;

  try {
    sessionOwner = await createExecutorSessionStore({ root: join(homedir(), ".statewright", "executor-sessions"),
      workflow: options.workflow, projectId: options.projectId, host: options.host, cwd, apiKey, gatewayUrl,
    }).open({ sessionId: options.executorSessionId, resume: Boolean(options.resumeWorkflow) });
    const savedOwner = sessionOwner.record;
    process.stderr.write(`[statewright] Executor session: ${savedOwner.executor_session_id}\n`);
    if (options.resumeWorkflow) {
      if (!savedOwner.host_ready) throw new Error("Native session ownership is incomplete; explicit recovery required");
      if (options.host === "pi") await assertPiNativeSession({ sessionFile: savedOwner.host_session_file,
        sessionId: savedOwner.host_session_id, cwd });
    }
    const transportClientId = savedOwner.transport_client_id;
    const client = new RemoteStatewrightClient({ gatewayUrl, apiKey, clientId: transportClientId,
      sessionId: savedOwner.transport_session_id ?? transportClientId, requireNegotiatedSessionId: true,
      ...(options.resumeWorkflow ? { expectedSessionId: savedOwner.transport_session_id } : {}),
    });
    const approvalMirror = createExecutorApprovalMirror({
      workflow: options.workflow,
      projectId: options.projectId,
      host: options.host,
      cwd,
      root: join(homedir(), ".statewright", "exec-approvals"),
      apiKey,
      gatewayUrl,
      transportClientId,
      executorSessionId: savedOwner.executor_session_id,
      deferClear: Boolean(options.piRequestFrontend),
      getState: async () => {
        await sessionOwner.assertOwner();
        const snapshot = await client.call("statewright_get_state");
        await sessionOwner.assertOwner();
        sessionOwner.assertGateway(snapshot);
        return snapshot;
      },
      telemetry: (event) => telemetry(event.type, {
        approval_id: event.approvalId ?? null,
        to_state: event.toState ?? null,
        reason: event.reason ?? null,
      }),
    });
    await approvalMirror.assertNoLegacyCheckpoint();
    const initialState = await attachExecutorSession({ client, owner: sessionOwner, resume: Boolean(options.resumeWorkflow) });
    await telemetry("executor_gateway_connected", { gateway_origin: client.gatewayOrigin });
    process.stderr.write(`[statewright] Gateway: ${client.gatewayOrigin}\n`);
    const transportSessionId = sessionOwner.record.transport_session_id;
    if (workspaceSession) lease = await new ExecutorLease(leasePath, {
      executor_id: executorId, host: options.host, manifest_path: workspaceSession.manifestPath,
      manifest_digest: workspaceSession.manifest.manifest_digest, transport_session_id: transportSessionId,
    }).start();
    const restored = await approvalMirror.restore(initialState);
    if (restored?.status === "parked") {
      process.stderr.write(
        `[statewright-exec] Resumed while approval ${restored.saved.pending_approval.approval_id} is pending; `
        + (options.host === "pi" && !options.piRequestFrontend ? "native Pi launch remains held.\n" : "approval checkpoint remains parked.\n"),
      );
    }
    await approvalMirror.observe(initialState);
    const deliveryRequired = Boolean(
      initialState.meta?.workspace?.required
      || initialState.meta?.preview?.required
      || initialState.meta?.promotion?.required
    );
    if (deliveryRequired && !workspaceSession) {
      throw new Error(
        `Workflow '${options.workflow}' requires isolated delivery, but no enabled `
        + `${DELIVERY_CONFIG_RELATIVE_PATH} was found.`,
      );
    }
    await deliveryController?.observeState(initialState);
    let verifiedDeliveryOwner = false;
    if (workspaceSession) {
      const leaseCheck = await validateExecutorLease({
        STATEWRIGHT_DELIVERY_ACTIVE: "1",
        STATEWRIGHT_EXECUTOR_ID: executorId,
        STATEWRIGHT_EXECUTOR_LEASE: leasePath,
        STATEWRIGHT_DELIVERY_MANIFEST: workspaceSession.manifestPath,
      });
      if (!leaseCheck.valid) {
        throw new Error(`Statewright executor delivery lease is invalid: ${leaseCheck.reason}`);
      }
      verifiedDeliveryOwner = true;
    }
    // Pi SDK readiness must describe the native file BEFORE bridge construction.
    let hostSessionId;
    let hostSessionFile;
    if (options.piRequestFrontend) {
      hostSessionId = savedOwner.host_session_id;
      hostSessionFile = options.resumeWorkflow ? savedOwner.host_session_file : await createPiNativeSession({
        pluginsRoot: options.pluginsRoot, cwd, sessionDir: sessionOwner.nativeRoot, sessionId: hostSessionId });
      await sessionOwner.bindHost({ sessionId: hostSessionId, sessionFile: hostSessionFile });
      piRuntime = await createPiExecutorRuntime({ client, sessionOwner, approvalMirror, executorId,
        deliveryActive: verifiedDeliveryOwner, telemetry });
      adapterBridge = piRuntime.adapterBridge;
    } else adapterBridge = await new AdapterBridge(client, {
      executorId,
      deliveryActive: verifiedDeliveryOwner,
      host: options.host,
      telemetry,
    }).start();
    const session = {
      workflow: options.workflow,
      host: options.host,
      executorId,
      transportSessionId,
      transportClientId,
      workspaceSession,
      leasePath,
      adapterBridge,
      pluginsRoot: options.pluginsRoot,
    };
    const environment = executorAgentEnvironment(process.env, session);
    if (!options.piRequestFrontend) {
      hostSessionId = await prepareHostSession({
        ...options,
        cwd,
        environment,
      }, savedOwner.host_session_id);
      hostSessionFile = options.host === "pi"
        ? options.resumeWorkflow ? savedOwner.host_session_file : await createPiNativeSession({ pluginsRoot: options.pluginsRoot,
          cwd, sessionDir: sessionOwner.nativeRoot, sessionId: hostSessionId })
        : null;
      await sessionOwner.bindHost({ sessionId: hostSessionId, sessionFile: hostSessionFile });
    }
    const result = await observeHost({
      ...options,
      ...piRuntime,
      cwd,
      ...(options.piRequestFrontend ? { piAgentDir: resolve(options.piAgentDir ?? environment.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")) } : {}),
      hostSessionId,
      hostSessionFile,
      sessionOwner,
      initialState,
      client,
      approvalMirror,
      adapterBridge,
      deliveryController,
      telemetry,
      environment,
    });
    if (result.status !== "approval_parked") await deliveryController?.finalizeAfterClientClose();
    if (result.code && !result.finalSeen) process.exitCode = result.code;
    return result;
  } finally {
    try {
      await piRuntime?.nativeReadiness.close();
      if (adapterBridge) {
        const requireTerminalStop = hostRequiresTerminalStop(options.host);
        const drained = await adapterBridge.waitForShutdown({ requireTerminalStop });
        if (!drained) {
          await telemetry("executor_adapter_drain_timeout", {
            active_requests: adapterBridge.activeRequests,
            require_terminal_stop: requireTerminalStop,
            terminal_stop_observed: adapterBridge.terminalStopObserved,
          });
        } else {
          await telemetry("executor_adapter_drained", {
            require_terminal_stop: requireTerminalStop,
            terminal_stop_observed: adapterBridge.terminalStopObserved,
          });
        }
      }
    } finally {
      try { await adapterBridge?.close(); }
      finally {
        lease?.stop();
        if (!workspaceSession) await rm(leasePath, { force: true }).catch(() => {});
        if (options.host === "opencode") {
          await rm(opencodeIsolationRoot(executorId), { recursive: true, force: true }).catch(() => {});
        }
        await sessionOwner?.release();
      }
    }
  }
}

function isMainModule() {
  try {
    return Boolean(process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const reporter = createErrorReporter({ plugin: "executor", version: "0.3.1" });
  reporter.installProcessHandlers();
  main().catch(async (error) => {
    if (!isExpectedPluginError(error)) await reporter.report(error, { mechanism: "entrypoint", operation: "statewright_exec" });
    process.stderr.write(`[statewright] ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
