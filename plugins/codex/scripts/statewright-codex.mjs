#!/usr/bin/env node

import * as Sentry from "@sentry/node";

const PLUGIN_NAME = "codex";
const PLUGIN_VERSION = "0.3.0";

Sentry.init({
  dsn: "https://3c30b803a5b44d74bf9657db7a89f033@glitch.enhasa.cloud/12",
  release: `statewright-${PLUGIN_NAME}@${PLUGIN_VERSION}`,
  environment: process.env.NODE_ENV || "production",
});
Sentry.setTag("plugin", PLUGIN_NAME);
Sentry.setTag("platform", `${process.platform}-${process.arch}`);

import { readFile, readFile as readFileAsync } from "node:fs/promises";
import { realpathSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { AppServerClient } from "./lib/app-server-client.mjs";
import { StatewrightCodexOrchestrator } from "./lib/orchestrator.mjs";
import {
  createNullTelemetryWriter,
  createTelemetryWriter,
  defaultTelemetryPath,
} from "./lib/telemetry.mjs";
import {
  assertDeliveryConfigPaths,
  loadDeliveryConfig,
} from "./lib/delivery-config.mjs";
import { DeliveryController } from "./lib/delivery-controller.mjs";
import { WorkspaceSession } from "./lib/workspace-session.mjs";

const HELP = `Usage:
  statewright-codex --workflow NAME [options] -- TASK

Required:
  --workflow NAME             Statewright workflow to load

Routing:
  --fallback-model MODEL      Route for bootstrap and states without a model (default: luna)
  --fallback-effort EFFORT    Effort for bootstrap and unrouted states (default: medium)
  --allow-reroute             Accept a Codex provider-side model reroute (default: fail closed)

Session:
  --cwd PATH                  Working directory (default: current directory)
  --thread-id ID              Resume an existing Codex app-server thread
  --resume-workflow           Resume the workflow's last paused Statewright run
  --project-id ID             Optional Statewright project scope
  --max-idle-turns N          Continuations allowed without a transition (default: 3)

Delivery:
  --delivery-config PATH      Trusted worktree/preview delivery config
  --delivery-run-id ID        Resume or name a delivery run (safe slug)

Permissions:
  --approval-policy POLICY    untrusted, on-request, or never (default: on-request)
  --approvals-reviewer WHO    auto_review or user (default: auto_review)
  --sandbox MODE              read-only, workspace-write, danger-full-access

Telemetry:
  --telemetry-path PATH       JSONL path (default: ${defaultTelemetryPath()})
  --no-telemetry              Disable routing/token telemetry

Runtime:
  --codex-bin PATH            Codex executable (default: codex)
  -h, --help                  Show this help

The adapter starts one cheap bootstrap turn to activate Statewright through the normal MCP tool.
At every successful state transition it interrupts the current turn, resolves the new state's
model and thinking_level against model/list, and starts the next turn with explicit overrides.
`;

export function buildAppServerArgs(transportSessionId) {
  if (!/^br_[a-zA-Z0-9_-]+$/.test(transportSessionId)) {
    throw new Error("STATEWRIGHT_MCP_SESSION_ID must start with br_ and contain only letters, digits, '_' or '-'.");
  }
  return [
    "app-server",
    "--stdio",
    "-c",
    `mcp_servers.statewright.env.STATEWRIGHT_MCP_SESSION_ID=${JSON.stringify(transportSessionId)}`,
  ];
}

export function validateWorkflowName(workflow) {
  if (!workflow) throw new Error("--workflow is required.");
  if (workflow.length > 200 || /[\u0000-\u001f\u007f]/.test(workflow)) {
    throw new Error("--workflow must be at most 200 printable characters.");
  }
}

export function deliveryAgentEnvironment(environment, transportSessionId) {
  const safe = { ...environment };
  for (const name of Object.keys(safe)) {
    if (
      /^(KUBECONFIG|KUBE_|KUBERNETES_|AWS_|GOOGLE_|GCP_|AZURE_|DOCKER_CONFIG$|REGISTRY_|GH_TOKEN$|GITHUB_TOKEN$|NPM_TOKEN$|CARGO_REGISTRY_TOKEN$|STRIPE_|SMTP_|SENTRY_)/
        .test(name)
    ) {
      delete safe[name];
    }
  }
  return {
    ...safe,
    KUBECONFIG: "/dev/null",
    STATEWRIGHT_DELIVERY_ACTIVE: "1",
    STATEWRIGHT_MCP_SESSION_ID: transportSessionId,
  };
}

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    fallbackModel: process.env.STATEWRIGHT_CODEX_FALLBACK_MODEL ?? "luna",
    fallbackEffort: process.env.STATEWRIGHT_CODEX_FALLBACK_EFFORT ?? "medium",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
    allowReroute: false,
    maxIdleTurns: 3,
    telemetryPath: defaultTelemetryPath(),
    telemetryEnabled: true,
    codexBin: "codex",
    promptParts: [],
  };
  const valueFlags = new Map([
    ["--workflow", "workflow"],
    ["--cwd", "cwd"],
    ["--thread-id", "threadId"],
    ["--project-id", "projectId"],
    ["--fallback-model", "fallbackModel"],
    ["--fallback-effort", "fallbackEffort"],
    ["--approval-policy", "approvalPolicy"],
    ["--approvals-reviewer", "approvalsReviewer"],
    ["--sandbox", "sandbox"],
    ["--telemetry-path", "telemetryPath"],
    ["--codex-bin", "codexBin"],
    ["--max-idle-turns", "maxIdleTurns"],
    ["--delivery-config", "deliveryConfig"],
    ["--delivery-run-id", "deliveryRunId"],
  ]);

  let promptMode = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (promptMode) {
      options.promptParts.push(arg);
      continue;
    }
    if (arg === "--") {
      promptMode = true;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--resume-workflow") {
      options.resumeWorkflow = true;
    } else if (arg === "--allow-reroute") {
      options.allowReroute = true;
    } else if (arg === "--no-telemetry") {
      options.telemetryEnabled = false;
    } else if (valueFlags.has(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value.`);
      options[valueFlags.get(arg)] = value;
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.promptParts.push(arg);
    }
  }
  options.maxIdleTurns = Number.parseInt(options.maxIdleTurns, 10);
  return options;
}

async function readPrompt(parts) {
  if (parts.length > 0) return parts.join(" ").trim();
  if (!process.stdin.isTTY) return (await readFile(0, "utf8")).trim();
  return "";
}

function validate(options, prompt) {
  validateWorkflowName(options.workflow);
  if (!prompt) throw new Error("Provide the task after '--' or on stdin.");
  if (!Number.isInteger(options.maxIdleTurns) || options.maxIdleTurns < 0) {
    throw new Error("--max-idle-turns must be a non-negative integer.");
  }
  if (!["untrusted", "on-request", "never"].includes(options.approvalPolicy)) {
    throw new Error("--approval-policy must be untrusted, on-request, or never.");
  }
  if (!["auto_review", "user"].includes(options.approvalsReviewer)) {
    throw new Error("--approvals-reviewer must be auto_review or user.");
  }
  if (!["read-only", "workspace-write", "danger-full-access"].includes(options.sandbox)) {
    throw new Error("--sandbox must be read-only, workspace-write, or danger-full-access.");
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return { status: "help" };
  }
  const prompt = await readPrompt(options.promptParts);
  validate(options, prompt);
  const requestedCwd = resolve(options.cwd);
  let workspaceSession = null;
  if (options.deliveryConfig) {
    const deliveryConfig = await loadDeliveryConfig(options.deliveryConfig, requestedCwd);
    await assertDeliveryConfigPaths(deliveryConfig);
    workspaceSession = await WorkspaceSession.prepare(deliveryConfig, {
      runId: options.deliveryRunId,
    });
  } else if (options.deliveryRunId) {
    throw new Error("--delivery-run-id requires --delivery-config.");
  }
  const cwd = workspaceSession?.primaryCwd ?? requestedCwd;
  const telemetry = options.telemetryEnabled
    ? createTelemetryWriter(resolve(options.telemetryPath), {
        endpoint: process.env.STATEWRIGHT_TELEMETRY_URL ?? null,
        apiKey: process.env.STATEWRIGHT_API_KEY ?? null,
      })
    : createNullTelemetryWriter();
  const deliveryController = workspaceSession
    ? await new DeliveryController(workspaceSession, { telemetry }).initialize()
    : null;
  const transportSessionId =
    process.env.STATEWRIGHT_MCP_SESSION_ID ?? `br_codex_${randomUUID()}`;
  const client = new AppServerClient({
    command: options.codexBin,
    args: buildAppServerArgs(transportSessionId),
    cwd,
    env: workspaceSession
      ? deliveryAgentEnvironment(process.env, transportSessionId)
      : { ...process.env, STATEWRIGHT_MCP_SESSION_ID: transportSessionId },
  });
  const orchestrator = new StatewrightCodexOrchestrator({
    client,
    workflow: options.workflow,
    prompt,
    cwd,
    threadId: options.threadId,
    resumeWorkflow: options.resumeWorkflow,
    projectId: options.projectId,
    fallbackModel: options.fallbackModel,
    fallbackEffort: options.fallbackEffort,
    approvalPolicy: options.approvalPolicy,
    approvalsReviewer: options.approvalsReviewer,
    sandbox: options.sandbox,
    allowReroute: options.allowReroute,
    maxIdleTurns: options.maxIdleTurns,
    transportSessionId,
    telemetry,
    deliveryController,
  });

  // Plugin telemetry + update check — fire and forget
  if (!process.env.STATEWRIGHT_NO_UPDATE_CHECK) {
    try {
      const apiKey = process.env.STATEWRIGHT_API_KEY ?? readFileSync(join(homedir(), ".statewright", "api_key"), "utf8").trim()
      const pbUrl = process.env.STATEWRIGHT_PB_URL || "https://statewright.ai"
      Sentry.setUser({ id: apiKey.slice(0, 8) })
      fetch(`${pbUrl}/api/telemetry/plugin-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plugin: PLUGIN_NAME, event: "connect", version: PLUGIN_VERSION, api_key: apiKey, platform: `${process.platform}-${process.arch}` }),
        signal: AbortSignal.timeout(5000),
      }).then(r => r.json()).then(data => {
        if (data.latest_version && data.latest_version !== PLUGIN_VERSION) {
          process.stderr.write(`[statewright] Update available: v${PLUGIN_VERSION} → v${data.latest_version}. Set STATEWRIGHT_NO_UPDATE_CHECK=1 to suppress.\n`)
        }
      }).catch(() => {})
    } catch {}
  }

  let result;
  try {
    result = await orchestrator.run();
  } finally {
    await client.close();
  }
  await deliveryController?.finalizeAfterClientClose();
  return result;
}

function isMainModule() {
  try {
    return Boolean(
      process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url),
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().then(
    (result) => {
      if (result?.status === "approval_required") process.exitCode = 3;
    },
    (error) => {
      process.stderr.write(`[statewright] ${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    },
  );
}
