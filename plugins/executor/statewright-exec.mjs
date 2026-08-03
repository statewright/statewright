#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
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
  hostSupportsLiveRouting,
  prepareHostSession,
  SUPPORTED_HOSTS,
} from "./lib/host-adapters.mjs";
import { RemoteStatewrightClient, resolveApiKey } from "./lib/remote-client.mjs";

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
  --host-bin PATH            Override the host executable
  --host-arg ARG             Pass one argument to the host (repeatable)
  --plugins-root PATH        Statewright plugins directory
                             (default: STATEWRIGHT_PLUGINS_ROOT or repository sibling)
  --fallback-model MODEL     Host startup model when the workflow has no route
  --fallback-effort LEVEL    Host startup effort when the workflow has no route
  --keep-host-on-final       Leave the TUI open after a final workflow state

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
    ["--host-bin", "hostBin"],
    ["--plugins-root", "pluginsRoot"],
    ["--fallback-model", "fallbackModel"],
    ["--fallback-effort", "fallbackEffort"],
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
  for (const name of Object.keys(safe)) {
    if (
      /^(KUBECONFIG|KUBE_|KUBERNETES_|DOCKER_CONFIG$|REGISTRY_|GH_TOKEN$|GITHUB_TOKEN$|NPM_TOKEN$|CARGO_REGISTRY_TOKEN$|STATEWRIGHT_API_KEY$|STRIPE_|SMTP_|SENTRY_)/.test(name)
    ) delete safe[name];
  }
  safe.KUBECONFIG = "/dev/null";
  return safe;
}

function opencodeEnvironment(environment, pluginsRoot) {
  const pluginUrl = pathToFileURL(resolve(pluginsRoot, "opencode", "src", "index.ts")).href;
  const proxyPath = resolve(EXECUTOR_ROOT, "mcp-proxy.sh");
  let inline = {};
  if (environment.OPENCODE_CONFIG_CONTENT) {
    try {
      inline = JSON.parse(environment.OPENCODE_CONFIG_CONTENT);
    } catch {
      throw new Error("OPENCODE_CONFIG_CONTENT must contain valid JSON.");
    }
  }
  const plugins = Array.isArray(inline.plugin) ? inline.plugin : [];
  return {
    ...environment,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...inline,
      plugin: [...new Set([...plugins, pluginUrl])],
      mcp: {
        ...(inline.mcp ?? {}),
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
    STATEWRIGHT_CLIENT_ID: session.transportSessionId,
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
  if (session.host === "opencode") result = opencodeEnvironment(result, session.pluginsRoot);
  return result;
}

async function waitForChild(child) {
  return new Promise((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("exit", (code, signal) => resolveChild({ code, signal }));
  });
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  const timer = setTimeout(() => child.kill("SIGTERM"), 5_000);
  timer.unref?.();
}

async function observeHost(options) {
  const {
    client,
    deliveryController,
    telemetry,
  } = options;
  let state = options.initialState;
  let stateKey = `${state.state}:${state.iteration ?? 0}`;
  let finalSeen = Boolean(state.is_final);
  let continuation = false;

  while (true) {
    const launch = buildHostLaunch(options, state, continuation);
    await telemetry("executor_host_started", {
      host: options.host,
      state: state.state,
      routing_mode: hostRoutingMode(options.host),
      live_routing: hostSupportsLiveRouting(options.host),
      continuation,
      command: launch.command,
    });
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: options.environment,
      stdio: "inherit",
    });

    let observerError = null;
    let polling = false;
    let rerouteRequested = false;
    const poll = async () => {
      if (polling || observerError || finalSeen) return;
      polling = true;
      try {
        const next = await client.call("statewright_get_state");
        const nextKey = `${next.state}:${next.iteration ?? 0}`;
        if (nextKey !== stateKey) {
          const changedState = next.state !== state.state;
          const changedRoute = (next.model ?? next.default_model ?? null)
            !== (state.model ?? state.default_model ?? null)
            || (next.thinking_level ?? null) !== (state.thinking_level ?? null);
          state = next;
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
          if (changedRoute && hostRoutingMode(options.host) === "restart") {
            rerouteRequested = true;
            stopChild(child);
          }
        }
        if (next.is_final) {
          finalSeen = true;
          if (options.exitOnFinal) stopChild(child);
        }
      } catch (error) {
        observerError = error;
        stopChild(child);
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => poll(), 500);
    const result = await waitForChild(child);
    clearInterval(timer);
    await poll();
    if (observerError) throw observerError;
    if (rerouteRequested && !finalSeen) {
      continuation = true;
      await telemetry("executor_host_reroute", {
        host: options.host,
        state: state.state,
        model: state.model ?? state.default_model ?? null,
        thinking_level: state.thinking_level ?? null,
      });
      continue;
    }
    return { ...result, state, finalSeen };
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
  const transportSessionId = `br_exec_${randomUUID()}`;
  const fallbackHostSessionId = randomUUID();
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
  const lease = workspaceSession
    ? await new ExecutorLease(leasePath, {
        executor_id: executorId,
        host: options.host,
        manifest_path: workspaceSession.manifestPath,
        manifest_digest: workspaceSession.manifest.manifest_digest,
        transport_session_id: transportSessionId,
      }).start()
    : null;
  const client = new RemoteStatewrightClient({
    gatewayUrl: process.env.STATEWRIGHT_GATEWAY_URL ?? "https://mcp.statewright.ai",
    apiKey,
    clientId: transportSessionId,
    sessionId: transportSessionId,
  });
  let adapterBridge = null;

  try {
    await client.initialize();
    await client.call("statewright_load_workflow", {
      name: options.workflow,
      resume: Boolean(options.resumeWorkflow),
      ...(options.projectId ? { project_id: options.projectId } : {}),
    });
    const initialState = await client.call("statewright_get_state");
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
    adapterBridge = await new AdapterBridge(client, {
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
      workspaceSession,
      leasePath,
      adapterBridge,
      pluginsRoot: options.pluginsRoot,
    };
    const environment = executorAgentEnvironment(process.env, session);
    const hostSessionId = await prepareHostSession({
      ...options,
      cwd,
      environment,
    }, fallbackHostSessionId);
    const result = await observeHost({
      ...options,
      cwd,
      hostSessionId,
      initialState,
      client,
      deliveryController,
      telemetry,
      environment,
    });
    await deliveryController?.finalizeAfterClientClose();
    if (result.code && !result.finalSeen) process.exitCode = result.code;
    return result;
  } finally {
    if (adapterBridge) {
      const drained = await adapterBridge.waitForIdle();
      if (!drained) {
        await telemetry("executor_adapter_drain_timeout", {
          active_requests: adapterBridge.activeRequests,
        });
      }
    }
    await adapterBridge?.close();
    lease?.stop();
    if (!workspaceSession) await rm(leasePath, { force: true }).catch(() => {});
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
  main().catch((error) => {
    process.stderr.write(`[statewright] ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
