#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "./lib/app-server-client.mjs";
import { StatewrightCodexOrchestrator } from "./lib/orchestrator.mjs";
import {
  createNullTelemetryWriter,
  createTelemetryWriter,
  defaultTelemetryPath,
} from "./lib/telemetry.mjs";

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
  const cwd = resolve(options.cwd);
  const telemetry = options.telemetryEnabled
    ? createTelemetryWriter(resolve(options.telemetryPath), {
        endpoint: process.env.STATEWRIGHT_TELEMETRY_URL ?? null,
        apiKey: process.env.STATEWRIGHT_API_KEY ?? null,
      })
    : createNullTelemetryWriter();
  const transportSessionId =
    process.env.STATEWRIGHT_MCP_SESSION_ID ?? `br_codex_${randomUUID()}`;
  const client = new AppServerClient({
    command: options.codexBin,
    args: buildAppServerArgs(transportSessionId),
    cwd,
    env: { ...process.env, STATEWRIGHT_MCP_SESSION_ID: transportSessionId },
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
  });

  try {
    return await orchestrator.run();
  } finally {
    await client.close();
  }
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
