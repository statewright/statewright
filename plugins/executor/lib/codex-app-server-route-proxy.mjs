import { WebSocket, WebSocketServer } from "ws";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DesktopNativeUsage } from "./desktop-native-usage.mjs";
import { HandoffPresentation, hardInterruptNotice } from "./app-server-handoff.mjs";
import { summarizeStatewrightToolCompletion, summarizeStatewrightToolStart } from "./statewright-tool-summary.mjs";
import { CodexApprovalGate } from "./codex-approval-gate.mjs";
import { ClassifierApprovalController, classifierApprovalRequest } from "./classifier-approval-controller.mjs";
import { ApprovalOutcome, ApprovalPipeline, approvalDeny, approvalError,
  approvalNotHandled } from "./approval-pipeline.mjs";
import { pendingApprovalSnapshot } from "./human-approval.mjs";
import { prepareQueuedHumanInput } from "./queued-human-input.mjs";
import { WorkflowRouteOriginStore, sameWorkflowRouteBinding, workflowRouteBinding } from "./workflow-route-origin.mjs";

const WORKFLOW_APPROVAL_PRIORITY = 100;
const CLASSIFIER_APPROVAL_PRIORITY = 200;

function localClassifierApprovalPipeline({controller, getState}) {
  return new ApprovalPipeline([
    {
      name: "workflow-transition-barrier",
      priority: WORKFLOW_APPROVAL_PRIORITY,
      async handle(value) {
        if (value?.schema !== "statewright/classifier-approval-request/v2") {
          return approvalNotHandled();
        }
        const request = classifierApprovalRequest(value);
        if (!request) return approvalNotHandled();
        let state;
        try {
          if (typeof getState !== "function") return approvalError("approval_state_unavailable");
          state = await getState(request.threadId);
        } catch {
          return approvalError("approval_state_unavailable");
        }
        if (!state || state.is_final === true
            || state.run_id !== request.runId
            || state.run_session_id !== request.runSessionId
            || state.state !== request.state
            || state.state_epoch !== request.stateEpoch) {
          return approvalDeny(controller.result(request, "deny",
            {reason: "approval_state_changed"}));
        }
        if (state.pending_approval) {
          return approvalDeny(controller.result(request, "deny",
            {reason: "workflow_approval_pending"}));
        }
        return approvalNotHandled();
      },
    },
    {
      name: "classifier-invocation",
      priority: CLASSIFIER_APPROVAL_PRIORITY,
      handle: (value, options) => controller.begin(value, options),
    },
  ]);
}
function routeModel(model) {
  return String(model ?? "").replace(/^[^/]+\//, "").trim();
}

function rpcIdKey(id) {
  return JSON.stringify([typeof id, id]);
}

function structuredToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result?.content?.find?.(entry => entry?.type === "text")?.text;
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

export function localStatewrightLifecycle(item) {
  if (String(item?.type ?? "").toLowerCase() !== "mcptoolcall") return null;
  const rawTool = String(item.tool ?? "");
  const server = String(item.server ?? "");
  const namespacedLocalTool = rawTool.startsWith("mcp__statewright__statewright_")
    || rawTool.startsWith("mcp__plugin_statewright_statewright__statewright_");
  const bareLocalTool = rawTool.startsWith("statewright_")
    && (server === "statewright" || server === "plugin_statewright_statewright");
  const localTool = namespacedLocalTool || bareLocalTool;
  const localServer = !server && namespacedLocalTool
    || server === "statewright" || server === "plugin_statewright_statewright";
  if (!localTool || !localServer) return null;
  const tool = rawTool.slice(rawTool.lastIndexOf("statewright_"));
  if (!["statewright_load_workflow", "statewright_start", "statewright_deactivate", "statewright_stop", "statewright_transition", "statewright_force_state"].includes(tool)) return null;
  return { tool, server: server || rawTool.slice(0, rawTool.lastIndexOf("__statewright_")) };
}

export function terminalStatewrightCompletion(item) {
  const lifecycle = localStatewrightLifecycle(item);
  if (!lifecycle || item.status !== "completed" || item.error || item.result?.isError === true) return null;
  const { tool } = lifecycle;
  const value = structuredToolResult(item.result);
  if (["statewright_deactivate", "statewright_stop"].includes(tool)
      && (value?.deactivated === true || value?.stopped === true)) {
    return { kind: "deactivated", ...lifecycle };
  }
  if (["statewright_transition", "statewright_force_state"].includes(tool)) {
    const state = value?.state_snapshot ?? value?.state ?? value;
    if (state?.is_final === true) return { kind: "terminal", ...lifecycle, state };
    if (value?.transitioned === true && typeof value?.to === "string") {
      return { kind: "transition", ...lifecycle, state: null };
    }
  }
  return null;
}

/**
 * Statewright workflow identifiers are portable (for example
 * `casa/qwen3.8-27b`), while Codex needs the installed provider identity and
 * bare model slug.  Do not send the workflow namespace to Codex as a model.
 */
export function routeIdentity(model, environment = process.env) {
  const requested = String(model ?? "").trim();
  const slash = requested.indexOf("/");
  const namespace = slash > 0 ? requested.slice(0, slash) : null;
  const bareModel = routeModel(requested);
  if (!bareModel) throw new Error("Statewright App Server route is missing a model.");
  if (namespace === "casa" || namespace === "qwen_private") {
    if (!environment.STATEWRIGHT_QWEN_BASE_URL) {
      throw new Error('Qwen routing requires the codex-local-models companion compatibility endpoint; launch through the companion or explicitly configure STATEWRIGHT_QWEN_BASE_URL. Direct-backend fallback is disabled.');
    }
    return {
      provider: "qwen_private",
      model: bareModel,
      config: {
        "model_providers.qwen_private": {
          name: "Private Qwen through local Ollama compatibility wrapper",
          base_url: environment.STATEWRIGHT_QWEN_BASE_URL,
          wire_api: "responses",
          requires_openai_auth: false,
        },
        model_catalog_json: environment.STATEWRIGHT_QWEN_MODEL_CATALOG ?? `${homedir()}/.codex/qwen-private.models.json`,
        model_context_window: Number(environment.STATEWRIGHT_QWEN_CONTEXT_WINDOW ?? 171648),
        service_tier: "default",
        web_search: "disabled",
      },
    };
  }
  return { provider: namespace === "openai-codex" ? "openai" : namespace, model: bareModel, config: {} };
}

function qualifiedRouteModel(model, provider) {
  const value = String(model ?? "").trim();
  if (!value || value.includes("/")) return value;
  const namespace = provider === "openai" ? "openai-codex" : String(provider ?? "").trim();
  return namespace ? `${namespace}/${value}` : value;
}

function firstOwn(...candidates) {
  for (const [source, key] of candidates) {
    if (source && Object.hasOwn(source, key)) return { available: true, value: source[key] ?? null };
  }
  return { available: false, value: undefined };
}

export function nativeThreadRouteSettings(result) {
  const response = result ?? {};
  const thread = response.thread ?? {};
  const effort = firstOwn([response, "reasoningEffort"], [thread, "reasoningEffort"],
    [response, "effort"], [thread, "effort"]);
  const serviceTier = firstOwn([response, "serviceTier"], [thread, "serviceTier"]);
  return {
    model: routeModel(response.model ?? thread.model),
    modelProvider: String(response.modelProvider ?? thread.modelProvider ?? "").trim(),
    ...(effort.available ? { effort: effort.value } : {}),
    ...(serviceTier.available ? { serviceTier: serviceTier.value } : {}),
  };
}

export function captureWorkflowOrigin(message, fallback = {}) {
  if (message?.method !== "turn/start") return null;
  const params = message.params ?? {};
  const collaboration = params.collaborationMode?.settings;
  const provider = fallback.provider ?? null;
  const selectedModel = collaboration?.model ?? params.model ?? fallback.model;
  const qualifiedModel = qualifiedRouteModel(selectedModel, provider);
  if (!qualifiedModel) return null;
  const declaredProvider = qualifiedModel.includes("/") ? qualifiedModel.slice(0, qualifiedModel.indexOf("/")) : null;
  const effort = firstOwn([collaboration, "reasoning_effort"], [params, "effort"], [fallback, "effort"]);
  const serviceTier = firstOwn([params, "serviceTier"], [fallback, "service_tier"]);
  return {
    provider: String(provider ?? (declaredProvider === "openai-codex" ? "openai" : declaredProvider) ?? "").trim() || null,
    model: qualifiedModel,
    ...(effort.available ? { effort: effort.value } : {}),
    ...(serviceTier.available ? { service_tier: serviceTier.value } : {}),
  };
}

export function restoreWorkflowOrigin(marker, origin) {
  if (marker?.restore_original !== true || !origin?.model) return null;
  if (marker.run_id && origin.run_id && marker.run_id !== origin.run_id) return null;
  return {
    ...marker,
    model: origin.model,
    ...(Object.hasOwn(origin, "effort") ? { effort: origin.effort } : {}),
    ...(Object.hasOwn(origin, "service_tier") ? { service_tier: origin.service_tier } : {}),
    restored_original: true,
  };
}

function sameRouteValue(actual, expected) {
  return String(actual ?? "").trim() === String(expected ?? "").trim();
}

export function applyRouteToTurnStart(message, route, environment = process.env) {
  if (message?.method !== "turn/start" || !route) return { message, receipt: null };
  const threadId = String(message.params?.threadId ?? "");
  const routeSessionId = String(route.session_id ?? "");
  if (!threadId || !routeSessionId || threadId !== routeSessionId) return { message, receipt: null };
  // Selection has already happened at the Statewright workflow boundary.  A
  // persistent Codex connection must honor that selected provider instead of
  // replacing it with an OpenAI same-provider fallback.
  const selectedRoute = route;
  const identity = routeIdentity(selectedRoute.model, environment);
  const params = { ...(message.params ?? {}), model: identity.model };
  const effortSpecified = Object.hasOwn(selectedRoute, "effort");
  if (effortSpecified) params.effort = selectedRoute.effort ?? null;
  const selectedServiceTier = selectedRoute.service_tier ?? selectedRoute.serviceTier;
  if (selectedServiceTier) params.serviceTier = selectedServiceTier;
  // Desktop's collaborationMode.settings takes precedence over the top-level
  // turn fields. Keep its unrelated mode/instructions intact, but make the
  // model selection atomic across both representations.
  const collaborationMode = params.collaborationMode;
  const collaborationSettings = collaborationMode?.settings;
  const collaborationModeApplied = Boolean(collaborationSettings && typeof collaborationSettings === "object" && !Array.isArray(collaborationSettings));
  if (collaborationModeApplied) {
    params.collaborationMode = {
      ...collaborationMode,
      settings: {
        ...collaborationSettings,
        model: identity.model,
        ...(effortSpecified ? { reasoning_effort: selectedRoute.effort ?? null } : {}),
      },
    };
  }
  const routed = { ...message, params };
  return {
    message: routed,
    receipt: {
      route: selectedRoute,
      threadId,
      requestedModel: String(selectedRoute.model),
      effectiveProvider: identity.provider,
      effectiveModel: identity.model,
      effectiveEffort: selectedRoute.effort ?? null,
      effortSpecified,
      effectiveServiceTier: selectedServiceTier ?? null,
      collaborationModeApplied,
      providerConfig: identity.config,
    },
  };
}

export function settingsConfirmRoute(receipt, notification) {
  if (!receipt || notification?.method !== "thread/settings/updated") return null;
  const params = notification.params ?? {};
  if (String(params.threadId ?? "") !== receipt.threadId) return null;
  return nativeSettingsReceipt(receipt, params.threadSettings);
}

function nativeSettingsReceipt(receipt, settings = {}) {
  settings ??= {};
  const actualModel = routeModel(settings.model);
  const actualProvider = String(settings.modelProvider ?? "").trim() || null;
  const actualEffort = firstOwn([settings, "effort"]);
  const actualServiceTier = firstOwn([settings, "serviceTier"]);
  const collaborationSettings = settings.collaborationMode?.settings ?? null;
  const actualCollaborationModel = firstOwn([collaborationSettings, "model"]);
  const actualCollaborationEffort = firstOwn([collaborationSettings, "reasoning_effort"]);
  const collaborationReceipt = receipt.collaborationModeApplied ? {
    ...(actualCollaborationModel.available ? { actualCollaborationModel: routeModel(actualCollaborationModel.value) } : {}),
    ...(actualCollaborationEffort.available ? { actualCollaborationEffort: actualCollaborationEffort.value } : {}),
  } : {};
  return {
    ...receipt,
    actualModel,
    actualProvider,
    ...(actualEffort.available ? { actualEffort: actualEffort.value } : {}),
    ...(actualServiceTier.available ? { actualServiceTier: actualServiceTier.value } : {}),
    ...collaborationReceipt,
    confirmed: sameRouteValue(actualModel, receipt.effectiveModel)
      && (!receipt.effectiveProvider || sameRouteValue(actualProvider, receipt.effectiveProvider))
      && (!receipt.effortSpecified || actualEffort.available
        && sameRouteValue(actualEffort.value, receipt.effectiveEffort))
      && (!receipt.effectiveServiceTier || actualServiceTier.available
        && sameRouteValue(actualServiceTier.value, receipt.effectiveServiceTier))
      && (!receipt.collaborationModeApplied || (
        actualCollaborationModel.available
        && sameRouteValue(actualCollaborationModel.value, receipt.effectiveModel)
        && (!receipt.effortSpecified || actualCollaborationEffort.available
          && sameRouteValue(actualCollaborationEffort.value, receipt.effectiveEffort))
      )),
  };
}

/**
 * Codex expands $PLUGIN_ROOT for its direct TUI hook runner. The App Server
 * exposes the raw command instead, then executes it in its own process where
 * that per-plugin environment variable does not exist. `sourcePath` is
 * supplied by Codex's trusted plugin registry, so derive the owning plugin
 * root from it before returning the hook list to a remote TUI.
 */
export function expandPluginRootHookCommands(message) {
  if (!Array.isArray(message?.result?.data)) return message;
  let changed = false;
  const data = message.result.data.map((entry) => {
    if (!Array.isArray(entry?.hooks)) return entry;
    const hooks = entry.hooks.map((hook) => {
      if (typeof hook?.command !== "string" || !hook.command.includes("$PLUGIN_ROOT") || typeof hook.sourcePath !== "string") return hook;
      const pluginRoot = dirname(dirname(hook.sourcePath));
      if (!pluginRoot || pluginRoot === ".") return hook;
      changed = true;
      return { ...hook, command: hook.command.replaceAll("$PLUGIN_ROOT", pluginRoot) };
    });
    return hooks === entry.hooks ? entry : { ...entry, hooks };
  });
  return changed ? { ...message, result: { ...message.result, data } } : message;
}

export function applyCompactResumeRequest(message, enabled = true, historyLimit = 4) {
  if (!enabled || message?.method !== "thread/resume") return message;
  const limit = Number.isInteger(historyLimit) && historyLimit > 0 ? historyLimit : 4;
  const params = {
    ...(message.params ?? {}),
    excludeTurns: true,
    // Retain only enough recent completed work to orient the operator. The
    // durable thread still contains the full model-visible history.
    initialTurnsPage: { limit, sortDirection: "desc", itemsView: "summary" },
  };
  return { ...message, params };
}

export function applyRestoredResumePermissions(message, restored) {
  if (message?.method !== "thread/resume" || !restored || typeof restored !== "object") return message;
  const params = { ...(message.params ?? {}) };
  for (const key of ["approvalPolicy", "approvalsReviewer"]) {
    if (params[key] == null && restored[key] != null) params[key] = structuredClone(restored[key]);
  }
  // These fields are mutually exclusive in the native protocol. Preserve an
  // explicit native selector as a group; otherwise restore exactly one saved
  // selector rather than synthesizing an invalid pair.
  if (params.permissions == null && params.sandbox == null) {
    if (restored.permissions != null) params.permissions = structuredClone(restored.permissions);
    else if (restored.sandbox != null) params.sandbox = structuredClone(restored.sandbox);
  }
  // cwd retargets omitted runtime roots inside Codex. Never mix an explicit
  // native cwd/root group with roots recorded for an older cwd.
  if (params.cwd == null && params.runtimeWorkspaceRoots == null) {
    if (restored.cwd != null) params.cwd = structuredClone(restored.cwd);
    if (restored.runtimeWorkspaceRoots != null) {
      params.runtimeWorkspaceRoots = structuredClone(restored.runtimeWorkspaceRoots);
    }
  }
  return { ...message, params };
}

export function applyExplicitYoloResumePermissions(message, expectedThreadId) {
  if (!expectedThreadId || !["thread/resume", "thread/start"].includes(message?.method)) return message;
  if (message.method === "thread/resume" && message.params?.threadId !== expectedThreadId) {
    const error = new Error("Explicit Codex resume permissions belong to a different thread.");
    error.code = "STATEWRIGHT_THREAD_OWNERSHIP";
    throw error;
  }
  // The flag was global to this native CLI invocation. A new thread created
  // within that same TUI inherits Yolo, just as it would without --remote.
  return { ...message, params: { ...(message.params ?? {}),
    approvalPolicy: "never", permissions: null, sandbox: "danger-full-access" } };
}

export function applyThreadListCwd(message, cwd = null) {
  if (message?.method !== "thread/list" || !cwd || message.params?.cwd != null) return message;
  return {
    ...message,
    params: { ...(message.params ?? {}), cwd },
  };
}

function displayCwd(cwd, home = homedir()) {
  if (typeof cwd !== "string" || !cwd.trim()) return null;
  const resolvedCwd = resolve(cwd);
  const relativeToHome = relative(resolve(home), resolvedCwd);
  if (relativeToHome && !relativeToHome.startsWith("..")) return `~/${relativeToHome}`;
  if (!relativeToHome) return "~";
  return resolvedCwd;
}

/**
 * The native resume picker renders `name` when available and falls back to
 * `preview`. Keep the upstream thread identity intact while making project
 * ownership scannable in a list containing sessions from several checkouts.
 */
export function labelThreadListResponse(message, home = homedir(), labels = {}, threadCwds = {}) {
  if (!Array.isArray(message?.result?.data)) return message;
  let changed = false;
  const data = message.result.data.filter((entry) => {
    const metadata = threadCwds[entry?.id];
    return metadata?.threadSource !== "subagent" && typeof metadata?.lastUserMessage === "string" && metadata.lastUserMessage.trim();
  }).map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const metadata = threadCwds[entry.id];
    const cwd = displayCwd(metadata?.cwd ?? entry.cwd, home);
    if (!cwd) return entry;
    const display = `[${cwd}] ${metadata.lastUserMessage.replace(/\s+/g, " ").trim()}`;
    if (entry.name !== display || entry.preview !== display) {
      changed = true;
      return { ...entry, name: display, preview: display };
    }
    return entry;
  });
  return changed || data.length !== message.result.data.length ? { ...message, result: { ...message.result, data } } : message;
}

export function hydrateBoundedResumeTurns(message) {
  if (message?.result?.thread?.turns?.length || !Array.isArray(message?.result?.initialTurnsPage?.data)) return message;
  // Codex 0.144.x resumes from legacy `thread.turns` and does not render the
  // documented `initialTurnsPage`. Expose the bounded page in that legacy
  // surface without rebuilding or mutating the complete stored rollout.
  const turns = [...message.result.initialTurnsPage.data].reverse();
  return {
    ...message,
    result: {
      ...message.result,
      thread: { ...message.result.thread, turns },
    },
  };
}

const ACTIVE_WRITER_RETRY_GUIDANCE = "Another Codex process still owns this session. Wait a minute or two for the current turn to finish, then try again. If it still fails, close the other Codex client or recover the stale managed session before retrying.";

function isActiveGoalSet(message) {
  return message?.method === "thread/goal/set"
    && message.params?.status === "active";
}

function hasGoalObjective(message) {
  return Object.prototype.hasOwnProperty.call(message?.params ?? {}, "objective");
}

export function clarifyActiveWriterResumeError(message) {
  const original = message?.error?.message;
  if (typeof original !== "string" || !/already has an active writer/i.test(original)) return message;
  if (original.includes(ACTIVE_WRITER_RETRY_GUIDANCE)) return message;
  return {
    ...message,
    error: {
      ...message.error,
      message: `${original} ${ACTIVE_WRITER_RETRY_GUIDANCE}`,
    },
  };
}

export function forwardWhenOpen(socket, payload) {
  return new Promise((resolveForward, rejectForward) => {
    const send = () => socket.send(payload, (error) => error ? rejectForward(error) : resolveForward());
    if (socket.readyState === WebSocket.OPEN) {
      send();
      return;
    }
    if (socket.readyState !== WebSocket.CONNECTING) {
      rejectForward(new Error("Codex App Server upstream is not open."));
      return;
    }
    const closed = () => rejectForward(new Error("Codex App Server upstream closed before forwarding."));
    const failed = (error) => rejectForward(error);
    socket.once("close", closed);
    socket.once("error", failed);
    socket.once("open", () => {
      socket.off("close", closed);
      socket.off("error", failed);
      send();
    });
  });
}

export async function startCodexAppServerRouteProxy({
  upstreamUrl,
  takePendingRoute = async () => null,
  approvalService = null,
  workflowService = null,
  classifierApprovalService = approvalService,
  classifierApprovalToken = null,
  classifierApprovalTimeoutMs = 10 * 60_000,
  peekPendingRoute = async () => null,
  onRouteInjected = async () => {},
  onRouteConfirmed = async () => {},
  onNativeUsage = async () => {},
  onHandoffStatus = async () => {},
  onConnection = async () => {},
  onTransportError = async () => {},
  onProtocolError = async () => {},
  workflowOriginStore = new WorkflowRouteOriginStore(),
  routeOwner = async () => ({}),
  compactResume = true,
  resumeHistoryLimit = 4,
  threadListCwd = null,
  threadLabels = {},
  getThreadLabels = async () => threadLabels,
  getThreadCwds = async () => ({}),
  resolveResumePermissions = async () => null,
  onThreadStarted = async () => {},
  onThreadResumed = async () => {},
  // Optional host-specific ownership guard. It may return a typed lifecycle
  // whose commit runs only after the matching original upstream RPC succeeds.
  authorizeThread = async () => {},
  requiredMcpToolSuffix = null,
  requiredMcpServerName = "statewright",
  requiredMcpReadyTimeoutMs = 0,
  forwardPayload = forwardWhenOpen,
  idleMs = 500,
  onIdle = async () => {},
}) {
  const classifierOwners = new Set();
  const classifierAuthorized = request => {
    if (!classifierApprovalToken || request.headers.origin) return false;
    const actual = Buffer.from(String(request.headers.authorization ?? ""));
    const expected = Buffer.from(`Bearer ${classifierApprovalToken}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const healthServer = createServer(async (request, response) => {
    if (request.url === "/readyz" || request.url === "/healthz") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ok\n");
      return;
    }
    if (request.url === "/classifier-approval" && request.method === "POST"
        && classifierApprovalService && classifierApprovalToken) {
      if (!classifierAuthorized(request)) {
        response.writeHead(401).end();
        return;
      }
      let approvalController;
      let abortApproval;
      let closeApproval;
      try {
        approvalController = new AbortController();
        abortApproval = () => approvalController.abort(new Error("Classifier approval request aborted"));
        closeApproval = () => {
          if (!response.writableEnded) abortApproval();
        };
        request.once("aborted", abortApproval);
        response.once("close", closeApproval);
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 32 * 1024) {
            throw new Error("Classifier approval receipt is too large");
          }
        }
        const value = JSON.parse(body);
        const owners = [];
        for (const candidate of classifierOwners) {
          if (!candidate.initialized) continue;
          if (!candidate.threads.has(value?.thread_id)) continue;
          if (await classifierApprovalService.ownsThread?.(value.thread_id)) owners.push(candidate);
        }
        if (owners.length !== 1) throw new Error(owners.length
          ? "Classifier approval has multiple owning native connections"
          : "Classifier approval has no owning native connection");
        const decision = await owners[0].pipeline.service(value,
          {signal: approvalController.signal});
        let result;
        if (decision.outcome === ApprovalOutcome.ASK) result = await decision.completion;
        else if ([ApprovalOutcome.ALLOW, ApprovalOutcome.DENY].includes(decision.outcome)) {
          result = decision.response;
        } else {
          const parsed = classifierApprovalRequest(value);
          result = decision.outcome === ApprovalOutcome.ERROR && parsed
            ? owners[0].controller.result(parsed, "deny", {reason: decision.reason})
            : {schema: "statewright/classifier-approval/v2", action: "deny",
              reason: decision.outcome === ApprovalOutcome.ERROR
                ? decision.reason : "unsupported_approval_request"};
        }
        request.off("aborted", abortApproval);
        response.off("close", closeApproval);
        if (response.destroyed) return;
        response.writeHead(200, {"Content-Type": "application/json"});
        response.end(JSON.stringify(result));
      } catch (error) {
        if (abortApproval) request.off("aborted", abortApproval);
        if (closeApproval) response.off("close", closeApproval);
        if (response.destroyed) return;
        response.writeHead(400, {"Content-Type": "application/json"});
        response.end(JSON.stringify({schema: "statewright/classifier-approval/v2",
          action: "deny", reason: String(error?.message ?? error).slice(0, 256)}));
      }
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const server = new WebSocketServer({ server: healthServer });
  let connectedClients = 0;
  let everConnected = false;
  let closing = false;
  let idleTimer = null;
  let idleGeneration = 0;
  let routeLease = Promise.resolve();
  const acquireRouteLease = async () => {
    const previous = routeLease;
    let release;
    routeLease = new Promise((resolveLease) => { release = resolveLease; });
    await previous;
    return release;
  };
  const takeApprovedRoute = async (threadId, state, fromState, checkOwner) => {
    let retired = 0;
    for (;;) {
      const reservation = await takePendingRoute(threadId);
      try {
        await checkOwner();
        const route = reservation?.route ?? reservation;
        if (!route) return { route: { session_id: threadId, run_id: state.run_id,
          ...(state.run_session_id ? {run_session_id: state.run_session_id} : {}),
          state: state.state, state_epoch: state.state_epoch, workflow: state.workflow,
          model: state.model, effort: state.thinking_level } };
        // A route queued before the human decision cannot override the approved
        // destination. Retire only this exact run's known origin; all other
        // mismatches still fail closed in the caller's identity check.
        if (fromState !== state.state && route.session_id === threadId && route.run_id === state.run_id
            && route.state === fromState) {
          if (typeof reservation?.ack !== "function") {
            throw new Error("Approved origin route cannot be retired safely");
          }
          if (retired >= 32) throw new Error("Approved origin route queue exceeds bounded retirement");
          await reservation.ack();
          await checkOwner();
          retired++;
          continue;
        }
        return { route, ack: reservation?.ack, release: reservation?.release };
      } catch (error) {
        await reservation?.release?.();
        throw error;
      }
    }
  };
  const routeStateService = workflowService ?? approvalService;
  const takeCurrentRoute = async (threadId, checkOwner = async () => {}) => {
    if (!routeStateService?.getState) return takePendingRoute(threadId);
    await checkOwner();
    const authoritative = await routeStateService.getState(threadId);
    await checkOwner();
    for (let retired = 0; retired <= 256; retired += 1) {
      const reservation = await takePendingRoute(threadId);
      if (!reservation) {
        if (!authoritative || authoritative.is_final === true) return null;
        return { route: { session_id: threadId, run_id: authoritative.run_id,
          ...(authoritative.run_session_id ? {run_session_id: authoritative.run_session_id} : {}),
          state: authoritative.state, state_epoch: authoritative.state_epoch, workflow: authoritative.workflow,
          model: authoritative.model, effort: authoritative.thinking_level,
          ...(authoritative.env_overrides?.STATEWRIGHT_CODEX_SERVICE_TIER
            ? {service_tier: authoritative.env_overrides.STATEWRIGHT_CODEX_SERVICE_TIER} : {}),
          ...(Array.isArray(authoritative.model_ladder) ? { model_ladder: authoritative.model_ladder } : {}) } };
      }
      try {
        await checkOwner();
        const route = reservation.route ?? reservation;
        const restoreBinding = route?.restore_original === true
          ? workflowRouteBinding(route, threadId, await routeOwner(threadId))
          : null;
        const storedBinding = restoreBinding
          ? await workflowOriginStore.binding(threadId)
          : null;
        const ownedRestore = Boolean(storedBinding && sameWorkflowRouteBinding(storedBinding, restoreBinding));
        const currentStateRoute = authoritative && authoritative.is_final !== true
          && route?.session_id === threadId
          && route.run_id === authoritative.run_id
          && route.state === authoritative.state
          && route.model === authoritative.model
          && route.effort === authoritative.thinking_level;
        const terminalRestore = authoritative?.is_final === true
          && ownedRestore
          && route?.restore_original === true
          && route.session_id === threadId
          && route.run_id === authoritative.run_id
          && route.state === authoritative.state;
        const inactiveRestore = authoritative === null && ownedRestore;
        const current = currentStateRoute || terminalRestore || inactiveRestore;
        if (current) return reservation;
        if (typeof reservation.ack !== "function") throw new Error("Stale Statewright route cannot be retired safely");
        await reservation.ack();
        await checkOwner();
      } catch (error) {
        await reservation?.release?.();
        throw error;
      }
    }
    throw new Error("Statewright stale route queue exceeds bounded retirement");
  };
  const boundRoute = async (route, threadId) => workflowRouteBinding(
    route,
    threadId,
    await routeOwner(threadId),
  );
  const activeConnections = new Set();
  const approvalGates = new Set();
  const approvalSafety = new Map();
  const idleEligible = () => !closing && everConnected && connectedClients === 0 && activeConnections.size === 0;
  const cancelIdle = () => {
    idleGeneration += 1;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const scheduleIdle = () => {
    cancelIdle();
    if (!idleEligible()) return;
    const generation = idleGeneration;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (generation !== idleGeneration || !idleEligible()) return;
      Promise.resolve(onIdle()).catch((error) => onTransportError({
        side: "resident_idle",
        message: error instanceof Error ? error.message : String(error),
      })).catch(() => {});
    }, idleMs);
    idleTimer.unref?.();
  };
  const listening = new Promise((resolveListening, rejectListening) => {
    healthServer.once("listening", resolveListening);
    healthServer.once("error", rejectListening);
  });
  healthServer.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a Statewright App Server route proxy port.");

  server.on("connection", (downstream, request) => {
    const yoloThreads = new URL(request?.url ?? "/", "ws://127.0.0.1").searchParams.getAll("statewright_resume_yolo_thread");
    if (yoloThreads.length > 1 || (yoloThreads.length === 1 && (!yoloThreads[0] || yoloThreads[0].length > 128))) {
      downstream.close(1008, "Invalid Statewright resume permission binding");
      return;
    }
    const yoloThreadId = yoloThreads[0] ?? null;
    const connection = Symbol("app-server-connection");
    const classifierThreads = new Set();
    let parkingCount = 0;
    const activeThreads = new Map();
    const activeProviders = new Map();
    const activeModels = new Map();
    const activeSettings = new Map();
    const operatorActivity = new Map();
    const explainedTurns = new Map();
    const turnOrigins = new Map();
    const nativeUsage = new DesktopNativeUsage();
    const pendingTurnStarts = new Map();
    const receipts = new Map();
    const requestMethods = new Map();
    const pendingThreadAuthorizations = new Map();
    const pendingApprovalReleases = new Map();
    const pendingManualSettings = new Map();
    const internalRequests = new Map();
    const switchingThreads = new Set();
    const terminalCompletions = new Map();
    const restoreInFlight = new Set();
    const handoffs = new Map();
    const routeConfirmationWaiters = new Map();
    const stateNames = new Map();
    const mcpReadyThreads = new Set();
    let classifierOwner = null;
    const ownsClassifierConnection = threadId => {
      const candidates = [...classifierOwners].filter(candidate => candidate.initialized
        && candidate.threads.has(threadId));
      return classifierOwner !== null && classifierOwners.has(classifierOwner)
        && candidates.length === 1 && candidates[0] === classifierOwner;
    };
    const readClassifierState = async threadId => {
      if (!ownsClassifierConnection(threadId)
          || !await classifierApprovalService?.ownsThread?.(threadId)) return null;
      const state = await classifierApprovalService.getState(threadId);
      if (!await classifierApprovalService?.ownsThread?.(threadId)
          || !ownsClassifierConnection(threadId)) return null;
      return state;
    };
    const classifierController = classifierApprovalService ? new ClassifierApprovalController({
      send: value => {
        if (downstream.readyState !== WebSocket.OPEN) {
          throw new Error("Native Desktop connection is unavailable");
        }
        downstream.send(JSON.stringify(value));
      },
      getState: readClassifierState,
      approvalTimeoutMs: classifierApprovalTimeoutMs,
      record: event => onHandoffStatus({schema: "statewright/classifier-approval-lifecycle/v1", ...event}),
    }) : null;
    classifierOwner = classifierController ? {
      initialized: false,
      threads: classifierThreads,
      controller: classifierController,
      pipeline: localClassifierApprovalPipeline({
        controller: classifierController,
        getState: readClassifierState,
      }),
    } : null;
    let classifierAttachedThreadId = null;
    const bindClassifierThread = threadId => {
      const next = String(threadId);
      if (classifierAttachedThreadId && classifierAttachedThreadId !== next) {
        classifierController?.close("native_owner_transferred");
      }
      classifierThreads.clear();
      classifierThreads.add(next);
      classifierAttachedThreadId = next;
    };
    if (classifierOwner) classifierOwners.add(classifierOwner);
    const presentation = new HandoffPresentation({onStatus: event => {
      if (event.phase === "running") stateNames.set(event.thread_id, event.state);
      return onHandoffStatus(event);
    }});
    const sendPresentation = (messages) => Promise.all(messages.map(message =>
      forwardWhenOpen(downstream, JSON.stringify(message))));
    let internalSequence = 0;
    const internalPrefix = `statewright-internal:${randomUUID()}:`;
    // All positive sequences through internalSequence were issued on this
    // connection. Retain exact ownership after settlement without an unbounded
    // tombstone set. Canonical spelling excludes guessed/unissued/foreign IDs.
    const ownsInternalId = id => {
      if (typeof id !== "string" || !id.startsWith(internalPrefix)) return false;
      const sequence = Number(id.slice(internalPrefix.length));
      return Number.isSafeInteger(sequence) && sequence > 0 && sequence <= internalSequence
        && id === `${internalPrefix}${sequence}`;
    };
    let protocolFailed = false;
    const internalRpc = async (method, params) => {
      if (internalSequence >= Number.MAX_SAFE_INTEGER) throw new Error("Internal RPC identity space exhausted; reconnect this client.");
      const id = `${internalPrefix}${++internalSequence}`;
      const idKey = rpcIdKey(id);
      const response = new Promise((resolveResponse, rejectResponse) => {
        const timer = setTimeout(() => {
          internalRequests.delete(idKey);
          rejectResponse(new Error(`Codex App Server internal request timed out during ${method}.`));
        }, 12_000);
        internalRequests.set(idKey, { resolve: resolveResponse, reject: rejectResponse, timer });
      });
      await forwardPayload(upstream, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return response;
    };
    const bindingKey = binding => JSON.stringify([
      binding?.thread_id, binding?.run_id, binding?.run_session_id,
      binding?.client_id, binding?.root_session_id,
    ]);
    const waitForRouteConfirmation = (threadId, receipt, checkOwner) => new Promise(resolveConfirmation => {
      const existing = routeConfirmationWaiters.get(threadId);
      if (existing) {
        resolveConfirmation({confirmed: false, reason: "settings_confirmation_already_pending"});
        return;
      }
      const timer = setTimeout(() => {
        routeConfirmationWaiters.delete(threadId);
        resolveConfirmation({confirmed: false, reason: "settings_confirmation_timeout"});
      }, 12_000);
      routeConfirmationWaiters.set(threadId, {
        receipt,
        checkOwner,
        resolve: value => { clearTimeout(timer); routeConfirmationWaiters.delete(threadId); resolveConfirmation(value); },
      });
    });
    const recordRouteConfirmation = async (receipt, checkOwner) => {
      if (receipt.confirmed && checkOwner) {
        try { await checkOwner(); }
        catch { receipt.confirmed = false; receipt.reason = "restoration_owner_changed"; }
      }
      if (receipt.confirmed && receipt.origin_binding) {
        if (receipt.route?.restored_original === true) {
          const result = await workflowOriginStore.confirmRestore(receipt.origin_binding);
          receipt.confirmed = result.status === "restored";
        } else if (!receipt.actualProvider) {
          receipt.confirmed = false;
          receipt.reason = "confirmed_route_provider_unknown";
        } else {
          const result = await workflowOriginStore.confirmRoute(receipt.origin_binding, {
            model: qualifiedRouteModel(receipt.actualModel, receipt.actualProvider),
            ...(Object.hasOwn(receipt, "actualEffort") ? {effort: receipt.actualEffort} : {}),
            ...(Object.hasOwn(receipt, "actualServiceTier") ? {service_tier: receipt.actualServiceTier} : {}),
          });
          receipt.confirmed = result.status === "confirmed";
          if (!receipt.confirmed) receipt.reason = result.status;
        }
      }
      await onRouteConfirmed(receipt);
      return receipt;
    };
    const updateAndConfirmSettings = async (threadId, receipt, update, checkOwner) => {
      const isNoop = settings => settings && Object.entries(update).every(([key, value]) =>
        key === "threadId" || value === undefined || Object.hasOwn(settings, key) && isDeepStrictEqual(settings[key], value));
      const observed = activeSettings.get(threadId);
      if (isNoop(observed) && nativeSettingsReceipt(receipt, observed).confirmed) {
        // Native Codex emits settings/updated only on change. An exact no-op
        // needs its successful RPC acknowledgement plus the owning connection's
        // native snapshot, not a fabricated notification or a timeout fallback.
        await checkOwner();
        await internalRpc("thread/settings/update", update);
        await checkOwner();
        // Read after the acknowledgement: this is both fresh model/effort
        // evidence and an ordered barrier behind earlier native notifications.
        const current = (await internalRpc("thread/read", {threadId, includeTurns: false})).thread;
        await checkOwner();
        const confirmed = nativeSettingsReceipt(receipt, activeSettings.get(threadId));
        confirmed.confirmation_source = "native_settings_snapshot_and_update_ack";
        confirmed.native_readback = "thread/read";
        if (!isNoop(activeSettings.get(threadId)) || current?.id !== threadId || current.status?.type !== "idle"
            || !sameRouteValue(current.model, receipt.effectiveModel)
            || !sameRouteValue(current.modelProvider, confirmed.actualProvider)
            || receipt.effortSpecified && (!Object.hasOwn(current, "reasoningEffort")
              || !sameRouteValue(current.reasoningEffort, receipt.effectiveEffort))) {
          confirmed.confirmed = false;
          confirmed.reason = "unchanged_settings_readback_mismatch";
        }
        return recordRouteConfirmation(confirmed, checkOwner);
      }
      receipts.set(threadId, receipt);
      const confirmation = waitForRouteConfirmation(threadId, receipt, checkOwner);
      try {
        await internalRpc("thread/settings/update", update);
        return await confirmation;
      } catch (error) {
        receipts.delete(threadId);
        routeConfirmationWaiters.get(threadId)?.resolve({confirmed: false, reason: "settings_update_failed"});
        await confirmation;
        throw error;
      }
    };
    const waitForRequiredMcpTool = async (threadId, checkCurrentRequest) => {
      if (!requiredMcpToolSuffix || requiredMcpReadyTimeoutMs <= 0 || mcpReadyThreads.has(threadId)) return;
      const deadline = Date.now() + requiredMcpReadyTimeoutMs;
      let lastError = null;
      for (;;) {
        checkCurrentRequest();
        try {
          let cursor = null;
          do {
            const result = await internalRpc("mcpServerStatus/list", {
              threadId, serverName: requiredMcpServerName, cursor, limit: 100, detail: "toolsAndAuthOnly",
            });
            checkCurrentRequest();
            if ((result?.data ?? []).some(server => server.name === requiredMcpServerName && Object.keys(server?.tools ?? {})
              .some(tool => tool.endsWith(requiredMcpToolSuffix)))) {
              mcpReadyThreads.add(threadId);
              return;
            }
            cursor = result?.nextCursor ?? null;
          } while (cursor);
        } catch (error) {
          lastError = error;
        }
        if (Date.now() >= deadline) {
          const error = new Error(`Statewright MCP tools did not become ready before the Desktop turn deadline${lastError ? `: ${lastError.message}` : "."}`);
          error.code = "STATEWRIGHT_MCP_NOT_READY";
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    const switchProvider = async (threadId, receipt) => {
      const desiredProvider = receipt.effectiveProvider;
      if (!desiredProvider || activeProviders.get(threadId) === desiredProvider) return;
      const prior = {
        provider: activeProviders.get(threadId),
        model: activeModels.get(threadId),
      };
      // OpenAI is Codex's native default.  Fixture-only and brand-new
      // connections can legitimately have no observed provider yet; do not
      // invent a handoff in that case.  Local routes, however, must fail
      // closed until the attached provider is known.
      if (!prior.provider && desiredProvider === "openai") return;
      if (!prior.provider || !prior.model) {
        throw new Error(`Statewright cannot safely switch ${threadId} to '${desiredProvider}': the active Codex provider/model is unknown.`);
      }
      const activeReasons = activeThreads.get(threadId) ?? new Set();
      if ([...activeReasons].some((reason) => reason === "server-active")) {
        throw new Error(`Statewright cannot switch ${threadId} to '${desiredProvider}' while a turn is active.`);
      }
      switchingThreads.add(threadId);
      presentation.beginSwitch(threadId, prior.model, receipt.effectiveModel);
      let verifiedSwitch = false;
      try {
        await internalRpc("thread/unsubscribe", { threadId });
        const resumed = await internalRpc("thread/resume", {
          threadId,
          modelProvider: desiredProvider,
          model: receipt.effectiveModel,
          serviceTier: desiredProvider === "qwen_private" ? "default" : undefined,
          config: receipt.providerConfig,
          excludeTurns: true,
        });
        const actualProvider = String(resumed?.modelProvider ?? resumed?.thread?.modelProvider ?? "").trim();
        const actualModel = routeModel(resumed?.model ?? resumed?.thread?.model);
        if (resumed?.thread?.id !== threadId || actualProvider !== desiredProvider || actualModel !== receipt.effectiveModel) {
          throw new Error(`Statewright provider switch was rejected (wanted ${desiredProvider}/${receipt.effectiveModel}, got ${actualProvider || "unknown"}/${actualModel || "unknown"}).`);
        }
        activeProviders.set(threadId, actualProvider);
        activeModels.set(threadId, actualModel);
        verifiedSwitch = true;
      } catch (error) {
        // Restore the attached thread before surfacing the error.  A failed
        // local handoff must never leave a native TUI disconnected.
        await internalRpc("thread/resume", {
          threadId,
          modelProvider: prior.provider,
          model: prior.model,
          excludeTurns: true,
        }).catch(() => {});
        activeProviders.set(threadId, prior.provider);
        activeModels.set(threadId, prior.model);
        throw error;
      } finally {
        switchingThreads.delete(threadId);
        await sendPresentation(presentation.finishSwitch(threadId, verifiedSwitch));
      }
    };
    const restoreTerminalOrigin = async (threadId, terminal, lifecycle) => {
      const originalBinding = lifecycle?.binding;
      const key = bindingKey(originalBinding);
      if (!originalBinding || restoreInFlight.has(key)) return;
      restoreInFlight.add(key);
      const activityEpoch = lifecycle.activityEpoch;
      const release = await acquireRouteLease();
      try {
        // A native turn can end without any projected MCP item. The execution
        // boundary is authoritative; tool result formatting is only a hint.
        if (terminal.kind === "reconcile" || terminal.kind === "reconnect"
            || terminal.kind === "transition" && !terminal.state) {
          const state = await routeStateService?.getState?.(threadId);
          if (state?.is_final) terminal = {kind: "terminal", state};
          else if (terminal.kind === "reconnect" && state === null
              && (await workflowOriginStore.inspect(threadId))?.status === "restore_pending") {
            terminal = {kind: "deactivated"};
          } else return;
        }
        const assertOwner = async () => {
          const currentBinding = await workflowOriginStore.binding(threadId);
          if (!currentBinding || !sameWorkflowRouteBinding(currentBinding, originalBinding)) {
            throw new Error("Statewright terminal restoration no longer owns the captured workflow route.");
          }
          if (operatorActivity.get(threadId) !== activityEpoch) {
            throw new Error("Statewright terminal restoration was superseded by newer native activity.");
          }
          if (lifecycle.turnId ? turnOrigins.get(threadId)?.turnId !== lifecycle.turnId : activeThreads.has(threadId)) {
            throw new Error("Statewright terminal restoration belongs to a superseded native turn.");
          }
          const authoritative = await routeStateService?.getState?.(threadId);
          if (terminal.kind === "terminal" || terminal.kind === "transition") {
            const state = terminal.state;
            if ((state && (!state.is_final || state.run_id !== originalBinding.run_id
                || state.run_session_id && state.run_session_id !== originalBinding.run_session_id))
                || !authoritative?.is_final || authoritative.run_id !== originalBinding.run_id
                || authoritative.run_session_id && authoritative.run_session_id !== originalBinding.run_session_id) {
              throw new Error("Statewright terminal restoration does not match the authoritative final run.");
            }
          } else if (authoritative !== null) {
            throw new Error("Statewright deactivation restoration requires authoritative inactive state.");
          }
        };
        await assertOwner();
        await waitForApprovalIdle(threadId, assertOwner);
        await assertOwner();
        const binding = await workflowOriginStore.binding(threadId);
        if (!binding || !sameWorkflowRouteBinding(binding, originalBinding)) {
          await onRouteInjected({
            threadId,
            route: { session_id: threadId, restore_original: true },
            restoration: { status: "skipped", reason: "missing_provenance", trigger: terminal.kind },
            confirmed: false,
          });
          return;
        }
        const settings = activeSettings.get(threadId) ?? {};
        const current = {
          model: qualifiedRouteModel(settings.model ?? activeModels.get(threadId), settings.modelProvider ?? activeProviders.get(threadId)),
          ...(Object.hasOwn(settings, "effort") ? { effort: settings.effort } : {}),
          ...(Object.hasOwn(settings, "serviceTier") ? { service_tier: settings.serviceTier } : {}),
        };
        const restoration = await workflowOriginStore.prepareRestore(binding, current);
        if (restoration.status === "relinquished") {
          await onRouteInjected({
            threadId,
            origin_binding: binding,
            route: { session_id: threadId, run_id: binding.run_id, restore_original: true },
            restoration: { ...restoration, status: "preserved_manual_override", trigger: terminal.kind },
            confirmed: true,
          });
          return;
        }
        if (restoration.status !== "ready") {
          await onRouteInjected({
            threadId,
            origin_binding: binding,
            route: { session_id: threadId, run_id: binding.run_id, restore_original: true },
            restoration: { status: "skipped", reason: restoration.status, trigger: terminal.kind },
            confirmed: false,
          });
          return;
        }
        const marker = {
          session_id: threadId,
          run_id: binding.run_id,
          run_session_id: binding.run_session_id,
          client_id: binding.client_id,
          root_session_id: binding.root_session_id,
          restore_original: true,
          restored_original: true,
          restored_axes: restoration.restored,
          relinquished_axes: restoration.relinquished,
          restoration_status: restoration.status,
          ...restoration.route,
        };
        const applied = applyRouteToTurnStart({ method: "turn/start", params: {
          threadId,
          ...(settings.collaborationMode ? { collaborationMode: structuredClone(settings.collaborationMode) } : {}),
        } }, marker, process.env);
        if (!applied.receipt) throw new Error("Statewright terminal restoration could not construct a bound native settings update.");
        applied.receipt.origin_binding = binding;
        applied.receipt.restoration = { ...restoration, trigger: terminal.kind };
        applied.receipt.route = marker;
        await assertOwner();
        await switchProvider(threadId, applied.receipt);
        await assertOwner();
        const confirmed = await updateAndConfirmSettings(threadId, applied.receipt, {
            threadId,
            model: applied.message.params.model,
            effort: applied.message.params.effort,
            serviceTier: applied.message.params.serviceTier,
            ...(applied.message.params.collaborationMode
              ? { collaborationMode: applied.message.params.collaborationMode } : {}),
          }, assertOwner);
        if (!confirmed.confirmed) throw new Error("Codex App Server confirmed different model settings; restoration provenance was retained.");
        await onRouteInjected(applied.receipt);
      } catch (error) {
        await onProtocolError({
          side: "terminal_route_restore",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        restoreInFlight.delete(key);
        release();
      }
    };
    const syncActivity = () => {
      if (activeThreads.size > 0 || parkingCount > 0) activeConnections.add(connection);
      else activeConnections.delete(connection);
    };
    const addActivity = (threadId, reason) => {
      if (!threadId) return;
      const reasons = activeThreads.get(threadId) ?? new Set();
      reasons.add(reason);
      activeThreads.set(threadId, reasons);
      syncActivity();
      cancelIdle();
    };
    const removeActivity = (threadId, reason) => {
      const reasons = activeThreads.get(threadId);
      if (!reasons) return;
      reasons.delete(reason);
      if (reasons.size === 0) activeThreads.delete(threadId);
      syncActivity();
    };
    everConnected = true;
    connectedClients += 1;
    cancelIdle();
    const upstream = new WebSocket(upstreamUrl);
    const reportApprovalFailure = error => Promise.resolve(onProtocolError({ side: "approval",
      message: error instanceof Error ? error.message : String(error) })).catch(() => {});
    const reportParkedApprovalFailure = (threadId, error) => {
      if (/approval checkpoint|approval recovery|approval service HTTP 404/i.test(String(error?.message))) {
        void forwardWhenOpen(downstream, JSON.stringify({ method: "warning", params: { threadId,
          message: "Statewright approval remains parked: its authoritative gateway checkpoint is unavailable. No decision or new turn was submitted." } })).catch(reportApprovalFailure);
      }
      void reportApprovalFailure(error);
    };
    const waitForApprovalIdle = async (threadId, check) => {
      const deadline = Date.now() + 10000;
      for (;;) {
        const metadata = (await internalRpc("thread/read", { threadId, includeTurns: false })).thread;
        await check();
        if (metadata?.id !== threadId) throw new Error("Approval continuation requires the owning thread");
        if (metadata.status?.type === "idle") return;
        if (Date.now() >= deadline) throw new Error("Approval continuation requires the owning idle thread");
        await new Promise(resolve => setTimeout(resolve, 50));
        await check();
      }
    };
    // A workflow loaded inside an ordinary Desktop turn needs an execution
    // boundary, not just a route file for the next user message. Only a local,
    // successful lifecycle completion may request this cutover. Revalidate
    // ownership and authoritative state around every asynchronous boundary.
    const handoffWorkflow = async ({threadId, turnId, item}) => {
      const lifecycle = localStatewrightLifecycle(item);
      if (!workflowService || !lifecycle || item.status !== "completed"
          || item.error || item.result?.isError || !item.id) return;
      const result = structuredToolResult(item.result);
      const loaded = ["statewright_load_workflow", "statewright_start"].includes(lifecycle.tool);
      const destination = loaded ? result?.state_snapshot?.state : result?.to;
      if (!destination || (loaded ? !result?.state_snapshot?.run_id : result?.transitioned !== true)) return;
      const origin = turnOrigins.get(threadId);
      if (!origin || origin.turnId !== turnId || origin.completed || handoffs.has(threadId)
          || origin.activityEpoch !== operatorActivity.get(threadId)) return;
      const epoch = operatorActivity.get(threadId);
      const operation = {turnId, itemId: item.id};
      handoffs.set(threadId, operation);
      let release, interrupted = false;
      const check = async () => {
        const owned = await workflowService.ownsThread(threadId);
        if (protocolFailed || downstreamClosed || downstream.readyState !== WebSocket.OPEN
            || handoffs.get(threadId) !== operation || operatorActivity.get(threadId) !== epoch
            || turnOrigins.get(threadId)?.turnId !== turnId
            || !owned) {
          throw new Error("Workflow handoff was superseded or lost its native owner");
        }
      };
      try {
        await check();
        const state = await workflowService.getState(threadId);
        await check();
        if (!state || state.state !== destination || !state.run_id || !state.run_session_id
            || !Number.isInteger(state.state_epoch)
            || loaded && (state.run_id !== result.state_snapshot.run_id
              || state.run_session_id !== result.state_snapshot.run_session_id)
            || origin.binding && (state.run_id !== origin.binding.run_id
              || state.run_session_id !== origin.binding.run_session_id)) {
          throw new Error("Workflow handoff lacks a matching authoritative destination");
        }
        if (state.is_final) return; // Restore after this real turn completes.
        const checkState = async () => {
          await check();
          const current = await workflowService.getState(threadId);
          await check();
          if (!current || current.run_id !== state.run_id || current.run_session_id !== state.run_session_id
              || current.state !== state.state || current.state_epoch !== state.state_epoch
              || current.model !== state.model || current.thinking_level !== state.thinking_level
              || (current.env_overrides?.STATEWRIGHT_CODEX_SERVICE_TIER ?? current.service_tier)
                !== (state.env_overrides?.STATEWRIGHT_CODEX_SERVICE_TIER ?? state.service_tier)
              || current.is_final || current.pending_approval) throw new Error("Workflow handoff state changed or requires approval");
        };
        release = await acquireRouteLease();
        await check();
        await internalRpc("turn/interrupt", {threadId, turnId});
        interrupted = true;
        await waitForApprovalIdle(threadId, check);
        if (state.pending_approval) throw new Error("Workflow approval is pending; no model continuation was started");
        if (!state.model) throw new Error("Workflow destination has no selected model");
        await checkState();
        const route = {session_id: threadId, run_id: state.run_id, run_session_id: state.run_session_id,
          state: state.state, state_epoch: state.state_epoch, model: state.model, effort: state.thinking_level,
          service_tier: state.env_overrides?.STATEWRIGHT_CODEX_SERVICE_TIER ?? state.service_tier};
        const binding = await boundRoute(route, threadId);
        const settings = activeSettings.get(threadId) ?? {};
        const capture = await workflowOriginStore.capture(binding, captureWorkflowOrigin({method: "turn/start", params: {threadId}}, {
          provider: activeProviders.get(threadId), model: activeModels.get(threadId),
          ...(Object.hasOwn(settings, "effort") ? {effort: settings.effort} : {}),
          ...(Object.hasOwn(settings, "serviceTier") ? {service_tier: settings.serviceTier} : {}),
        }));
        if (!["captured", "existing"].includes(capture.status)) throw new Error(`Workflow origin capture failed: ${capture.status}`);
        const applied = applyRouteToTurnStart({method: "turn/start", params: {threadId,
          input: [{type: "text", text: `Statewright entered '${state.state}'. Call the local statewright_get_state tool first, then follow the current phase's tools and transitions.`}],
          ...(settings.collaborationMode ? {collaborationMode: settings.collaborationMode} : {}),
        }}, route);
        applied.receipt.origin_binding = binding;
        await switchProvider(threadId, applied.receipt);
        await checkState();
        const {input, ...update} = applied.message.params;
        const confirmed = await updateAndConfirmSettings(threadId, applied.receipt, update, checkState);
        if (!confirmed.confirmed) throw new Error("Native workflow model settings were not confirmed");
        await checkState();
        activeModels.set(threadId, applied.receipt.effectiveModel);
        nativeUsage.prepare(threadId, route);
        const started = await internalRpc("turn/start", applied.message.params);
        if (!started?.turn?.id) throw new Error("Workflow continuation returned no native turn identity");
        // A user can cancel while the native start RPC is outstanding. Never
        // claim that returned turn or overwrite a newer manual turn's origin.
        const stillOwned = await workflowService.ownsThread(threadId);
        if (!stillOwned || operatorActivity.get(threadId) !== epoch || downstreamClosed || protocolFailed
            || handoffs.get(threadId) !== operation
            || ![turnId, started.turn.id].includes(turnOrigins.get(threadId)?.turnId)) {
          await internalRpc("turn/interrupt", {threadId, turnId: started.turn.id}).catch(() => {});
          throw new Error("Workflow continuation was cancelled during native turn start");
        }
        turnOrigins.set(threadId, {turnId: started.turn.id, binding, activityEpoch: epoch,
          provider: activeProviders.get(threadId), model: applied.receipt.effectiveModel});
        applied.receipt.turnId = started.turn.id;
        applied.receipt.previousTurnId = turnId;
        await onRouteInjected(applied.receipt);
        await sendPresentation(presentation.running(threadId, started.turn.id, {
          state: route.state, model: applied.receipt.effectiveModel, effort: route.effort,
          serviceTier: route.service_tier, runId: route.run_id,
        }));
      } catch (error) {
        // Never silently continue phase work on the previous model after a
        // failed handoff. Do not interrupt a newer/manual user turn.
        try { await check(); if (!interrupted) await internalRpc("turn/interrupt", {threadId, turnId}); } catch {}
        receipts.delete(threadId);
        routeConfirmationWaiters.get(threadId)?.resolve({confirmed: false, reason: "workflow_handoff_failed"});
        await onProtocolError({side: "workflow_handoff", message: error.message});
        await forwardWhenOpen(downstream, JSON.stringify({method: "warning", params: {threadId,
          message: `Statewright Arbiter: model handoff stopped. ${error.message}`}})).catch(() => {});
      } finally {
        if (handoffs.get(threadId) === operation) handoffs.delete(threadId);
        release?.();
      }
    };
    const gate = approvalService ? new CodexApprovalGate({ service: approvalService, safety: approvalSafety,
      onParking: active => {
        parkingCount += active ? 1 : -1;
        syncActivity();
        if (!active && downstreamClosed && activeThreads.size === 0 && parkingCount === 0
            && upstream.readyState === WebSocket.OPEN) upstream.close();
        scheduleIdle();
      },
      rpc: internalRpc,
      send: value => { void forwardWhenOpen(downstream, JSON.stringify(value)).catch(reportApprovalFailure); },
      record: event => onHandoffStatus({ schema: "statewright/approval-lifecycle/v1", ...event }),
      continueApproved: async ({ threadId, state, fromState, goal, check }) => {
        const checkOwner = async () => { check(); await gate.assertOwner(threadId); check(); };
        const release = await acquireRouteLease();
        let reservation, forwarded = false;
        try {
          await checkOwner();
          await waitForApprovalIdle(threadId, checkOwner);
          reservation = await takeApprovedRoute(threadId, state, fromState, checkOwner);
          const route = reservation.route;
          if (route.session_id !== threadId || route.run_id !== state.run_id || route.state !== state.state
              || !route.model || route.model !== state.model
              || route.effort !== state.thinking_level) throw new Error("Approval continuation lacks the authoritative destination route");
          const params = { threadId, input: [{ type: "text", text: `Statewright entered '${state.state}'. Call statewright_get_state first and continue the current phase.` }] };
          const applied = applyRouteToTurnStart({ method: "turn/start", params }, route);
          await switchProvider(threadId, applied.receipt);
          await checkOwner();
          receipts.set(threadId, applied.receipt);
          activeModels.set(threadId, applied.receipt.effectiveModel);
          if (goal) {
            const current = (await internalRpc("thread/goal/get", { threadId })).goal;
            await checkOwner();
            if (current?.status !== "paused" || current.objective !== goal.objective || current.createdAt !== goal.createdAt) throw new Error("Native goal changed during approval");
            await internalRpc("thread/settings/update", { threadId, model: applied.message.params.model,
              effort: applied.message.params.effort });
            await checkOwner();
            const resumed = (await internalRpc("thread/goal/set", { threadId, status: "active" })).goal;
            forwarded = true;
            if (resumed?.status !== "active") throw new Error("Native goal did not resume after approval");
          } else {
            const result = await internalRpc("turn/start", applied.message.params);
            forwarded = true;
            if (!result?.turn?.id) throw new Error("Approval continuation did not return a turn identity");
          }
          await reservation?.ack?.();
          await onRouteInjected(applied.receipt);
        } finally {
          if (!forwarded) await reservation?.release?.();
          release();
        }
      },
    }) : null;
    if (gate) approvalGates.add(gate);
    void onConnection({ upstreamUrl });
    downstream.on("message", async (raw) => {
      if (protocolFailed) return;
      let payload = String(raw);
      let provisionalTurn = null;
      let routeReceipt = null;
      let acknowledgeRoute = null;
      let releasePendingRoute = null;
      let releaseRouteLease = null;
      let routeForwarded = false;
      let providerRouteAttempted = false;
      let message = null;
      let approvedRelease = null;
      let requestEpoch;
      let startsGoalExecution = false;
      let threadAuthorization = null;
      const checkCurrentRequest = () => {
        if (requestEpoch !== undefined && (operatorActivity.get(message.params.threadId) !== requestEpoch
            || downstream.readyState !== WebSocket.OPEN)) {
          const error = new Error("Statewright request superseded by newer user input");
          error.code = "STATEWRIGHT_SUPERSEDED";
          throw error;
        }
      };
      const checkReleaseOwner = async () => {
        checkCurrentRequest();
        if (approvedRelease) await gate.assertOwner(message.params.threadId);
        checkCurrentRequest();
      };
      try {
        message = JSON.parse(payload);
        if (message.method && typeof message.id === "string" && message.id.startsWith(internalPrefix)) {
          throw new Error("Statewright internal RPC identities cannot be used for client requests.");
        }
        if (classifierController?.handleReply(message)) return;
        if (gate?.handleReply(message)) return;
        if (message.id !== undefined && message.method && requestMethods.has(rpcIdKey(message.id))) {
          throw new Error("Statewright rejected a duplicate in-flight native JSON-RPC request ID.");
        }
        if (message.method === "thread/resume" && message.params?.threadId) {
          // An explicit CLI override must win even when the historical profile
          // is unreadable or cannot be represented by the remote protocol.
          if (!yoloThreadId) message = applyRestoredResumePermissions(
            message, await resolveResumePermissions(String(message.params.threadId)));
        }
        message = applyExplicitYoloResumePermissions(message, yoloThreadId);
        if (message.method === "thread/start" || message.params?.threadId) {
          threadAuthorization = await authorizeThread({
            method: message.method,
            threadId: message.params?.threadId ?? null,
          });
          if (threadAuthorization) {
            if (message.id === undefined || threadAuthorization?.version !== 1
                || threadAuthorization?.kind !== "statewright_thread_adoption"
                || threadAuthorization.method !== message.method
                || threadAuthorization.threadId !== message.params?.threadId
                || typeof threadAuthorization.commit !== "function"
                || typeof threadAuthorization.cancel !== "function") {
              await threadAuthorization?.cancel?.();
              const error = new Error("Statewright thread authorization lifecycle is malformed.");
              error.code = "STATEWRIGHT_THREAD_OWNERSHIP";
              throw error;
            }
            pendingThreadAuthorizations.set(rpcIdKey(message.id), threadAuthorization);
          }
        }
        if (isActiveGoalSet(message)) {
          // Goal creation carries an objective only when no native goal exists.
          // An objective-bearing activation of a paused goal must retain the
          // same approval and route gate as the legacy status-only resume. A
          // native creation can then emit its own turn/start, which follows
          // the ordinary execution gate below.
          const currentGoal = hasGoalObjective(message)
            ? (await internalRpc("thread/goal/get", { threadId: message.params.threadId })).goal
            : true;
          startsGoalExecution = Boolean(currentGoal);
        }
        if ((["turn/start", "turn/interrupt", "turn/steer", "thread/goal/clear"].includes(message.method)
            || startsGoalExecution) && message.params?.threadId) {
          gate?.userActivity(message.params.threadId);
          operatorActivity.set(message.params.threadId, (operatorActivity.get(message.params.threadId) ?? 0) + 1);
          requestEpoch = operatorActivity.get(message.params.threadId);
          if (message.method === "turn/interrupt" && message.params.turnId) explainedTurns.set(message.params.threadId, message.params.turnId);
          await sendPresentation(presentation.userActivity(message.params.threadId));
        }
        if (message.method === "turn/start" && message.params?.threadId) {
          await waitForRequiredMcpTool(message.params.threadId, checkCurrentRequest);
        }
        if (message.method === "thread/settings/update" && message.id !== undefined && message.params?.threadId) {
          const settingsThreadId = String(message.params.threadId);
          operatorActivity.set(settingsThreadId, (operatorActivity.get(settingsThreadId) ?? 0) + 1);
          const collaboration = message.params.collaborationMode?.settings;
          const axes = [];
          const changes = {};
          if (Object.hasOwn(message.params, "model") || collaboration && Object.hasOwn(collaboration, "model")) axes.push("model");
          if (Object.hasOwn(message.params, "effort") || collaboration && Object.hasOwn(collaboration, "reasoning_effort")) axes.push("effort");
          if (Object.hasOwn(message.params, "serviceTier")) axes.push("service_tier");
          if (axes.includes("model")) changes.model = qualifiedRouteModel(
            collaboration?.model ?? message.params.model,
            activeProviders.get(String(message.params.threadId)),
          );
          if (axes.includes("effort")) changes.effort = collaboration && Object.hasOwn(collaboration, "reasoning_effort")
            ? collaboration.reasoning_effort : message.params.effort;
          if (axes.includes("service_tier")) changes.service_tier = message.params.serviceTier;
          if (axes.length) pendingManualSettings.set(rpcIdKey(message.id), {
            threadId: String(message.params.threadId), axes, changes,
            binding: await workflowOriginStore.binding(settingsThreadId),
          });
        }
        void onConnection({ direction: "native_to_upstream", method: message.method ?? null });
        if (message.id !== undefined && message.method) requestMethods.set(rpcIdKey(message.id), message.method);
        message = applyThreadListCwd(message, threadListCwd);
        const compacted = compactResume && message.method === "thread/resume";
        message = applyCompactResumeRequest(message, compactResume, resumeHistoryLimit);
        payload = JSON.stringify(message);
        if (compacted) void onConnection({ direction: "native_to_upstream", method: `thread/resume [last ${resumeHistoryLimit} turns]` });
        if (["turn/start", "turn/steer"].includes(message.method) || startsGoalExecution) {
          if (gate) {
            const epoch = operatorActivity.get(message.params?.threadId);
            try {
              approvedRelease = await gate.beforeTurn(message.params?.threadId,
                { turnId: message.params?.turnId ?? turnOrigins.get(message.params?.threadId)?.turnId });
              if (operatorActivity.get(message.params?.threadId) !== epoch) throw new Error("Approval request superseded by newer user input");
              if (approvedRelease && message.method === "turn/steer") {
                throw new Error("Approval parked the prior turn; submit a new turn to continue with the approved route");
              }
            } catch (error) {
              requestMethods.delete(rpcIdKey(message.id));
              await forwardWhenOpen(downstream, JSON.stringify({ id: message.id,
                error: { code: -32603, message: error.message } }));
              await reportApprovalFailure(error);
              return;
            }
          }
        }
        if (message.method === "turn/start" || approvedRelease && startsGoalExecution) {
          releaseRouteLease = await acquireRouteLease();
          await checkReleaseOwner();
          if (protocolFailed || downstream.readyState !== WebSocket.OPEN) {
            releaseRouteLease();
            return;
          }
          const threadId = String(message.params?.threadId ?? "");
          const requestId = message.id === undefined ? null : String(message.id);
          const requestKey = message.id === undefined ? null : rpcIdKey(message.id);
          const reason = requestId === null ? Symbol("turn-start") : `turn-start:${requestId}`;
          if (message.method === "turn/start") {
            provisionalTurn = { requestId, requestKey, reason, threadId };
            addActivity(threadId, reason);
            if (requestKey !== null) pendingTurnStarts.set(requestKey, provisionalTurn);
          }
          const pendingRoute = approvedRelease
            ? await takeApprovedRoute(threadId, approvedRelease.state, approvedRelease.fromState, checkReleaseOwner)
            : await takeCurrentRoute(threadId, checkReleaseOwner);
          releasePendingRoute = pendingRoute?.release ?? null;
          await checkReleaseOwner();
          const state = approvedRelease?.state;
          let route = pendingRoute?.route ?? pendingRoute ?? (state && { session_id: threadId,
            run_id: state.run_id, ...(state.run_session_id ? {run_session_id: state.run_session_id} : {}),
            state: state.state, model: state.model, effort: state.thinking_level });
          if (state && (route?.session_id !== threadId || route.run_id !== state.run_id || route.state !== state.state
              || !route.model || route.model !== state.model || route.effort !== state.thinking_level)) {
            const error = new Error("Approval release lacks the authoritative destination route");
            error.code = "STATEWRIGHT_APPROVAL_ROUTE";
            throw error;
          }
          if (state) await waitForApprovalIdle(threadId, checkReleaseOwner);
          let capturedOrigin = null;
          let originBinding = null;
          let restoration = null;
          if (route?.restore_original === true) {
            originBinding = await boundRoute(route, threadId);
            const active = activeSettings.get(threadId);
            const current = captureWorkflowOrigin(
              message.method === "turn/start" ? message : { method: "turn/start", params: { threadId } },
              { provider: activeProviders.get(threadId), model: activeModels.get(threadId),
                ...(active && Object.hasOwn(active, "effort") ? { effort: active.effort } : {}),
                ...(active && Object.hasOwn(active, "serviceTier") ? { service_tier: active.serviceTier } : {}) },
            );
            restoration = await workflowOriginStore.prepareRestore(originBinding, current ?? {});
            if (["ready", "relinquished"].includes(restoration.status)) {
              route = {
                ...route,
                ...restoration.route,
                restored_original: true,
                restored_axes: restoration.restored,
                relinquished_axes: restoration.relinquished,
                restoration_status: restoration.status,
              };
            } else {
              // Missing or mismatched provenance must never guess a fallback
              // route. Forward the user's turn unchanged and retain any
              // foreign origin record for its real owner.
              route = null;
            }
          } else if (route?.run_id && route?.model) {
            originBinding = await boundRoute(route, threadId);
            const active = activeSettings.get(threadId);
            capturedOrigin = captureWorkflowOrigin(
              message.method === "turn/start" ? message : { method: "turn/start", params: { threadId } },
              { provider: activeProviders.get(threadId), model: activeModels.get(threadId),
                ...(active && Object.hasOwn(active, "effort") ? { effort: active.effort } : {}),
                ...(active && Object.hasOwn(active, "serviceTier") ? { service_tier: active.serviceTier } : {}) },
            );
            const capture = await workflowOriginStore.capture(originBinding, capturedOrigin);
            if (capture.status === "binding_conflict" || capture.status === "unowned_binding") {
              const error = new Error(`Statewright cannot replace a workflow route origin owned by another execution context (${capture.status}).`);
              error.code = "STATEWRIGHT_ROUTE_ORIGIN_OWNER";
              throw error;
            }
            capturedOrigin = capture.record?.origin ?? capturedOrigin;
          }
          const applied = applyRouteToTurnStart(message.method === "turn/start" ? message
            : { method: "turn/start", params: { threadId } }, route, process.env);
          if (applied.receipt) {
            applied.receipt.origin_binding = originBinding;
            if (restoration) applied.receipt.restoration = restoration;
            presentation.prepare(threadId, requestId, {
              state: route.state, fromState: stateNames.get(threadId), runId: route.run_id,
              model: applied.receipt.effectiveModel, effort: applied.receipt.effectiveEffort,
              serviceTier: applied.receipt.effectiveServiceTier,
              returnRoute: capturedOrigin,
              restoredOriginal: route.restored_original === true,
            });
            // Only a provider handoff is recoverable at request scope. A
            // generic upstream send failure still means the transport itself
            // is broken and must close as before.
            providerRouteAttempted = applied.receipt.effectiveProvider !== "openai"
              || (activeProviders.has(threadId) && activeProviders.get(threadId) !== applied.receipt.effectiveProvider);
            await switchProvider(threadId, applied.receipt);
            await checkReleaseOwner();
            if (startsGoalExecution) {
              await internalRpc("thread/settings/update", { threadId, model: applied.message.params.model,
                effort: applied.message.params.effort });
              await checkReleaseOwner();
            }
          } else if (restoration) {
            routeReceipt = {
              route: pendingRoute?.route ?? pendingRoute,
              threadId,
              origin_binding: originBinding,
              restoration: {
                status: "skipped",
                reason: restoration.status,
              },
              confirmed: false,
            };
            acknowledgeRoute = pendingRoute?.ack ?? null;
          }
          payload = JSON.stringify(message.method === "turn/start" ? applied.message : message);
          if (provisionalTurn) {
            nativeUsage.prepare(threadId, route);
            provisionalTurn.model = routeModel(applied.message.params?.model);
            provisionalTurn.binding = originBinding ?? await workflowOriginStore.binding(threadId);
            provisionalTurn.activityEpoch = requestEpoch;
            await checkReleaseOwner();
          }
          if (applied.receipt) {
            routeReceipt = applied.receipt;
            acknowledgeRoute = pendingRoute?.ack ?? null;
          } else {
            await releasePendingRoute?.();
            releasePendingRoute = null;
          }
        }
        await checkReleaseOwner();
        if (approvedRelease && message.id !== undefined) {
          pendingApprovalReleases.set(rpcIdKey(message.id), { ...approvedRelease, threadId: message.params.threadId });
        }
        await forwardPayload(upstream, payload);
        routeForwarded = true;
        if (routeReceipt) {
          receipts.set(routeReceipt.threadId, routeReceipt);
          await acknowledgeRoute?.();
          await onRouteInjected(routeReceipt);
        }
        releaseRouteLease?.();
      } catch (error) {
        if (message?.method === "turn/start" && message.id !== undefined) {
          await sendPresentation(presentation.cancel(message.params?.threadId, String(message.id))).catch(() => {});
        }
        if (!routeForwarded) {
          if (threadAuthorization && message?.id !== undefined) {
            pendingThreadAuthorizations.delete(rpcIdKey(message.id));
            await threadAuthorization.cancel().catch(() => {});
          }
          if (message?.id !== undefined) pendingApprovalReleases.delete(rpcIdKey(message.id));
          try {
            await releasePendingRoute?.();
          } catch (releaseError) {
            error = new AggregateError([error, releaseError], "Statewright route forwarding and reservation release both failed.");
          }
        }
        releaseRouteLease?.();
        if (provisionalTurn) {
          removeActivity(provisionalTurn.threadId, provisionalTurn.reason);
          if (provisionalTurn.requestKey !== null) pendingTurnStarts.delete(provisionalTurn.requestKey);
        }
        void onProtocolError({ side: "native_to_upstream", message: error instanceof Error ? error.message : String(error) });
        // A rejected route is a turn-level failure, not a corrupted transport.
        // Closing the WebSocket here makes native Codex lose its session and
        // defeats retry/recovery after a provider configuration mistake.
        if ((providerRouteAttempted || approvedRelease || error.code === "STATEWRIGHT_SUPERSEDED"
            || error.code === "STATEWRIGHT_THREAD_OWNERSHIP" || error.code === "STATEWRIGHT_MCP_NOT_READY"
            || error.code === "STATEWRIGHT_ROUTE_ORIGIN_OWNER"
            || error.code === "STATEWRIGHT_SAVED_PERMISSIONS_INVALID"
            || error.code === "STATEWRIGHT_SAVED_PERMISSIONS_UNREPRESENTABLE")
            && message.id !== undefined && downstream.readyState === WebSocket.OPEN) {
          void forwardWhenOpen(downstream, JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: `Statewright route was not applied: ${error.message}` },
          })).catch((sendError) => onTransportError({
            side: "native_to_upstream",
            message: sendError instanceof Error ? sendError.message : String(sendError),
          })).catch(() => {});
          return;
        }
        protocolFailed = true;
        downstream.close(1011, `Statewright route proxy failed: ${error.message}`.slice(0, 123));
        return;
      }
    });
    let upstreamDelivery = Promise.resolve();
    const handleUpstream = async (raw) => {
      let payload = String(raw);
      let approvalHint = null;
      let terminalRestoreHint = null;
      let attachedThreadId = null;
      const handoffMessages = [];
      const prefaceMessages = [];
      try {
        let notification = JSON.parse(payload);
        const humanInput = prepareQueuedHumanInput(notification);
        if (humanInput !== notification) {
          notification = humanInput;
          payload = JSON.stringify(notification);
        }
        const terminal = notification.method === "turn/completed" ? notification.params : null;
        const priorTurn = terminal && presentation.turns.get(terminal.threadId);
        if (terminal?.turn?.status === "interrupted" && priorTurn?.active && priorTurn.id === terminal.turn.id && explainedTurns.get(terminal.threadId) !== terminal.turn.id) {
          explainedTurns.set(terminal.threadId, terminal.turn.id);
          const epoch = operatorActivity.get(terminal.threadId);
          let lookupTimer;
          const route = await Promise.race([
            Promise.resolve().then(() => peekPendingRoute(terminal.threadId, terminal.turn.id)),
            new Promise(resolveLookup => { lookupTimer = setTimeout(() => resolveLookup(null), 250); }),
          ]).catch(() => null).finally(() => clearTimeout(lookupTimer));
          if (route?.session_id === terminal.threadId && route.turn_id === terminal.turn.id && route.run_id && route.state
              && operatorActivity.get(terminal.threadId) === epoch) {
            const destination = routeIdentity(route.model);
            const origin = turnOrigins.get(terminal.threadId);
            destination.provider ??= origin?.provider;
            const text = origin?.turnId === terminal.turn.id && hardInterruptNotice(origin, destination);
            if (text) {
              // A warning is a separate native history cell: it cannot splice
              // or finalize a model stream. Preserve the real terminal next.
              prefaceMessages.push({method: "warning", params: {threadId: terminal.threadId, message: text}});
              void Promise.resolve().then(() => onHandoffStatus({schema: "statewright/app-server-handoff/v1", source: "statewright",
                phase: "hard_interrupt", thread_id: terminal.threadId, turn_id: terminal.turn.id,
                run_id: route.run_id, state: route.state, model: destination.model,
                effort: route.effort ?? null, text})).catch(() => {});
            }
          }
        }
        const currentOrigin = terminal && turnOrigins.get(terminal.threadId);
        if (terminal?.turn?.id && currentOrigin && currentOrigin.turnId !== terminal.turn.id) {
          void reportApprovalFailure(new Error("Ignored completion from a superseded native turn"));
          return;
        }
        presentation.observe(notification);
        // JSON-RPC identifiers are scoped independently in each direction.
        // An App Server request can legally reuse the id of a pending native
        // client request. Only a result/error object (never an id-bearing
        // method request) can consume client response correlation state.
        const isResponse = notification?.method === undefined
          && notification?.id !== undefined
          && (Object.prototype.hasOwnProperty.call(notification, "result")
            || Object.prototype.hasOwnProperty.call(notification, "error"));
        const responseId = isResponse ? String(notification.id) : null;
        const responseKey = isResponse ? rpcIdKey(notification.id) : null;
        const internal = responseKey === null ? null : internalRequests.get(responseKey);
        if (internal) {
          internalRequests.delete(responseKey);
          clearTimeout(internal.timer);
          if (notification.error) internal.reject(new Error(notification.error.message ?? "Codex App Server rejected the provider switch."));
          else internal.resolve(notification.result);
          return;
        }
        // Only responses to our exact issued identities are consumed. Reverse-
        // direction requests and unknown replies still follow native routing.
        if (isResponse && ownsInternalId(notification.id)) return;
        const responseTo = responseKey === null ? null : requestMethods.get(responseKey);
        if (responseTo) requestMethods.delete(responseKey);
        if (responseTo === "initialize" && !notification.error && classifierOwner) {
          classifierOwner.initialized = true;
        }
        const manualSettings = responseKey === null ? null : pendingManualSettings.get(responseKey);
        if (manualSettings) {
          pendingManualSettings.delete(responseKey);
          if (!notification.error && sameWorkflowRouteBinding(manualSettings.binding,
              await workflowOriginStore.binding(manualSettings.threadId))) await workflowOriginStore.relinquish(
            manualSettings.threadId,
            manualSettings.axes,
            manualSettings.changes,
          );
        }
        const threadAuthorization = responseKey === null ? null : pendingThreadAuthorizations.get(responseKey);
        if (threadAuthorization) pendingThreadAuthorizations.delete(responseKey);
        const approvalRelease = responseKey === null ? null : pendingApprovalReleases.get(responseKey);
        if (approvalRelease) {
          pendingApprovalReleases.delete(responseKey);
          if (!notification.error && (responseTo === "turn/start" && notification.result?.turn?.id
              || responseTo === "thread/goal/set" && notification.result?.goal?.status === "active")) {
            await gate.assertOwner(approvalRelease.threadId);
            await approvalService.clear(approvalRelease.threadId, approvalRelease.approvalId);
          }
        }
        if (responseTo === "thread/start" && notification?.result?.thread?.id) {
          try {
            // Native thread creation is the authoritative first point at which
            // an opaque managed client ID can be bound to a durable thread.
            // Do not report success if that ownership record cannot be saved.
            await onThreadStarted({ threadId: notification.result.thread.id });
            bindClassifierThread(notification.result.thread.id);
          } catch (error) {
            notification = { jsonrpc: "2.0", id: notification.id, error: { code: -32603,
              message: `Statewright could not bind the new Codex thread: ${error.message}` } };
            payload = JSON.stringify(notification);
          }
        }
        if (threadAuthorization) {
          const resumedThreadId = String(notification?.result?.thread?.id ?? "");
          try {
            if (responseTo !== threadAuthorization.method) {
              throw new Error("native response method did not match the prepared thread adoption");
            }
            if (notification.error || resumedThreadId !== threadAuthorization.threadId) {
              await threadAuthorization.cancel();
              if (!notification.error) throw new Error("native resume returned a different thread");
            } else {
              await threadAuthorization.commit();
            }
          } catch (error) {
            await threadAuthorization.cancel().catch(() => {});
            notification = { jsonrpc: "2.0", id: notification.id, error: { code: -32603,
              message: `Statewright could not adopt the resumed Codex thread: ${error.message}` } };
            payload = JSON.stringify(notification);
          }
        }
        if ((responseTo === "thread/start" || responseTo === "thread/resume") && notification?.result?.thread?.id) {
          attachedThreadId = notification.result.thread.id;
          const settings = nativeThreadRouteSettings(notification.result);
          const provider = settings.modelProvider;
          const model = settings.model;
          if (provider) activeProviders.set(String(notification.result.thread.id), provider);
          if (model) activeModels.set(String(notification.result.thread.id), model);
          activeSettings.set(String(notification.result.thread.id), {
            model,
            modelProvider: provider,
            ...(Object.hasOwn(settings, "effort") ? { effort: settings.effort } : {}),
            ...(Object.hasOwn(settings, "serviceTier") ? { serviceTier: settings.serviceTier } : {}),
          });
        }
        const pendingTurn = responseKey === null ? null : pendingTurnStarts.get(responseKey);
        if (pendingTurn) {
          pendingTurnStarts.delete(responseKey);
          if (notification.error) {
            removeActivity(pendingTurn.threadId, pendingTurn.reason);
            await sendPresentation(presentation.cancel(pendingTurn.threadId, responseId));
          } else {
            if (notification.result?.turn?.id) turnOrigins.set(pendingTurn.threadId, {
              turnId: notification.result.turn.id, binding: pendingTurn.binding,
              activityEpoch: pendingTurn.activityEpoch,
              provider: activeProviders.get(pendingTurn.threadId), model: pendingTurn.model,
            });
            if (pendingTurn.model) {
              activeModels.set(pendingTurn.threadId, pendingTurn.model);
              if (turnOrigins.get(pendingTurn.threadId)?.turnId === notification.result?.turn?.id) turnOrigins.get(pendingTurn.threadId).model = pendingTurn.model;
            }
            handoffMessages.push(...presentation.accept(pendingTurn.threadId, responseId, notification.result?.turn?.id));
          }
        }
        if (responseTo === "thread/resume") {
          notification = clarifyActiveWriterResumeError(notification);
          notification = hydrateBoundedResumeTurns(notification);
          const threadId = String(notification?.result?.thread?.id ?? "");
          // Pane labels are display-only. A local metadata write must never
          // turn a valid upstream resume into a failed native interaction.
          if (threadId) await onThreadResumed({ threadId }).catch(() => {});
          if (threadId && !notification.error) bindClassifierThread(threadId);
          if (threadId && !notification.error) {
            const activityEpoch = operatorActivity.get(threadId);
            const binding = await workflowOriginStore.binding(threadId);
            if (binding) terminalRestoreHint = {threadId, terminal: {kind: "reconnect"},
              lifecycle: {binding, activityEpoch, turnId: null}};
          }
          payload = JSON.stringify(notification);
        }
        if (responseTo === "thread/list") {
          const labels = await getThreadLabels().catch(() => threadLabels);
          const threadIds = Array.isArray(notification?.result?.data)
            ? notification.result.data.map((entry) => entry?.id).filter(Boolean)
            : [];
          const threadCwds = await getThreadCwds(threadIds).catch(() => ({}));
          notification = labelThreadListResponse(notification, homedir(), labels, threadCwds);
          payload = JSON.stringify(notification);
        }
        if (responseTo === "hooks/list") {
          notification = expandPluginRootHookCommands(notification);
          payload = JSON.stringify(notification);
        }
        const statusThreadId = String(notification?.params?.threadId ?? "");
        if (notification.method === "item/completed" && statusThreadId && gate) {
          const snapshot = pendingApprovalSnapshot(notification.params.item);
          if (snapshot && turnOrigins.get(statusThreadId)?.turnId === notification.params.turnId) {
            approvalHint = { threadId: statusThreadId, snapshot, turnId: notification.params.turnId };
          }
        }
        if (notification.method === "item/completed" && statusThreadId) {
          const completion = terminalStatewrightCompletion(notification.params.item);
          const origin = turnOrigins.get(statusThreadId);
          if (completion && origin?.binding && !origin.completed
              && origin.turnId === notification.params.turnId
              && origin.activityEpoch === operatorActivity.get(statusThreadId)
              && notification.params.item?.id) {
            terminalCompletions.set(statusThreadId, {turnId: origin.turnId, terminal: completion});
          }
        }
        if (notification.method === "thread/settings/updated" && statusThreadId) {
          const settings = notification.params.threadSettings;
          if (settings && typeof settings === "object") activeSettings.set(statusThreadId, structuredClone(settings));
          if (settings?.model) activeModels.set(statusThreadId, routeModel(settings.model));
          if (settings?.modelProvider) activeProviders.set(statusThreadId, settings.modelProvider);
        }
        if (statusThreadId && switchingThreads.has(statusThreadId)
          && ["thread/started", "thread/closed", "thread/status/changed", "thread/settings/updated"].includes(notification?.method)) {
          return;
        }
        if (notification?.method === "thread/status/changed" && statusThreadId) {
          if (notification.params?.status?.type === "active") addActivity(statusThreadId, "server-active");
          else activeThreads.delete(statusThreadId);
        } else if (notification?.method === "turn/started" && statusThreadId) {
          nativeUsage.started(notification.params, activeSettings.get(statusThreadId));
          const turnId = notification.params.turn.id;
          if (turnOrigins.get(statusThreadId)?.turnId !== turnId) {
            const pending = [...pendingTurnStarts.values()].find(entry => entry.threadId === statusThreadId);
            const activityEpoch = operatorActivity.get(statusThreadId);
            const binding = pending?.binding ?? await workflowOriginStore.binding(statusThreadId);
            turnOrigins.set(statusThreadId, {turnId, binding, activityEpoch,
              provider: activeProviders.get(statusThreadId), model: activeModels.get(statusThreadId)});
          }
          addActivity(statusThreadId, "server-active");
        } else if (notification?.method === "turn/completed" && statusThreadId) {
          activeThreads.delete(statusThreadId);
          const origin = turnOrigins.get(statusThreadId);
          const hint = terminalCompletions.get(statusThreadId);
          terminalCompletions.delete(statusThreadId);
          const wasCompleted = origin?.completed;
          if (origin && origin.turnId === notification.params.turn?.id) origin.completed = true;
          if (origin?.binding && !wasCompleted && origin.turnId === notification.params.turn?.id
              && origin.activityEpoch === operatorActivity.get(statusThreadId)) {
            terminalRestoreHint = {threadId: statusThreadId, lifecycle: {...origin},
              terminal: hint?.turnId === origin.turnId ? hint.terminal : {kind: "reconcile"}};
          }
        }
        syncActivity();
        if (notification.method === "thread/tokenUsage/updated" && workflowService
            && await workflowService.ownsThread(statusThreadId)) {
          const event = nativeUsage.event(notification.params);
          if (event) await onNativeUsage(event).catch(error => onProtocolError({
            side: "usage_telemetry", message: error.message,
          }));
        }
        if (downstreamClosed && activeThreads.size === 0 && parkingCount === 0 && upstream.readyState === WebSocket.OPEN) upstream.close();
        scheduleIdle();
        void onConnection({
          direction: "upstream_to_native",
          method: notification.method ?? (responseTo ? `response:${responseTo}` : null),
          bytes: String(raw).length,
          resultKeys: responseTo && notification.result && typeof notification.result === "object" ? Object.keys(notification.result) : null,
        });
        const receipt = settingsConfirmRoute(receipts.get(String(notification?.params?.threadId ?? "")), notification);
        if (receipt) {
          receipts.delete(receipt.threadId);
          const waiter = routeConfirmationWaiters.get(receipt.threadId);
          if (receipt.restoration?.trigger && !waiter) {
            receipt.confirmed = false;
            receipt.reason = "restoration_confirmation_expired";
          }
          await recordRouteConfirmation(receipt, waiter?.checkOwner);
          routeConfirmationWaiters.get(receipt.threadId)?.resolve(receipt);
        }
        const summarized = summarizeStatewrightToolCompletion(summarizeStatewrightToolStart(notification));
        if (summarized !== notification) payload = JSON.stringify(summarized);
      } catch (error) {
        // Protocol traffic is still forwarded; receipt telemetry must never
        // interfere with a native Codex session.
        void onProtocolError({ side: "upstream_to_native", message: error instanceof Error ? error.message : String(error) });
      }
      // App Server WebSocket mode specifies one JSON-RPC text frame per
      // message. `ws` exposes received text as a Buffer by default; sending
      // that buffer would silently convert it into a binary frame, which the
      // native Codex TUI rejects during its initialize handshake.
      let messages;
      try { messages = [...prefaceMessages, ...presentation.present(JSON.parse(payload)), ...handoffMessages]; } catch { messages = null; }
      await (messages ? sendPresentation(messages) : forwardWhenOpen(downstream, payload)).catch((error) => onTransportError({
        side: "upstream_to_native",
        message: error instanceof Error ? error.message : String(error),
      })).catch(() => {});
      if (approvalHint) void gate.observe(approvalHint.threadId, approvalHint.snapshot, approvalHint.turnId)
        .catch(error => reportParkedApprovalFailure(approvalHint.threadId, error));
      else if (attachedThreadId && gate) void gate.reopen(attachedThreadId)
        .catch(error => reportParkedApprovalFailure(attachedThreadId, error));
      if (terminalRestoreHint) void restoreTerminalOrigin(
        terminalRestoreHint.threadId,
        terminalRestoreHint.terminal,
        terminalRestoreHint.lifecycle,
      );
      try {
        const event = JSON.parse(String(raw));
        if (event.method === "item/completed") void handoffWorkflow(event.params);
      } catch { /* not a lifecycle notification */ }
    };
    // Preserve source order while a terminal's display-only route lookup waits.
    upstream.on("message", raw => {
      upstreamDelivery = upstreamDelivery.then(() => handleUpstream(raw)).catch(() => {});
    });
    const closePeer = () => {
      classifierController?.close();
      if (classifierOwner) classifierOwners.delete(classifierOwner);
      gate?.close();
      approvalGates.delete(gate);
      for (const request of internalRequests.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Codex App Server connection closed during provider switch."));
      }
      internalRequests.clear();
      for (const waiter of routeConfirmationWaiters.values()) {
        waiter.resolve({ confirmed: false, reason: "connection_closed" });
      }
      routeConfirmationWaiters.clear();
      for (const authorization of pendingThreadAuthorizations.values()) void authorization.cancel().catch(() => {});
      pendingThreadAuthorizations.clear();
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
      if (downstream.readyState === WebSocket.OPEN || downstream.readyState === WebSocket.CONNECTING) downstream.close();
    };
    let downstreamClosed = false;
    const markDownstreamClosed = () => {
      if (!downstreamClosed) {
        downstreamClosed = true;
        connectedClients = Math.max(0, connectedClients - 1);
        classifierController?.close("native_connection_closed");
        if (classifierOwner) classifierOwners.delete(classifierOwner);
        classifierThreads.clear();
        for (const authorization of pendingThreadAuthorizations.values()) void authorization.cancel().catch(() => {});
        pendingThreadAuthorizations.clear();
      }
    };
    const preserveActiveOrClose = () => {
      gate?.close();
      markDownstreamClosed();
      if (closing || activeThreads.size === 0 && parkingCount === 0) closePeer();
      else if (downstream.readyState === WebSocket.OPEN || downstream.readyState === WebSocket.CONNECTING) downstream.close();
      scheduleIdle();
    };
    downstream.on("close", (code, reason) => {
      void onTransportError({ side: "native_close", code, message: `${code} ${String(reason)}`.trim() });
      preserveActiveOrClose();
    });
    downstream.on("error", (error) => {
      void onTransportError({ side: "native", message: error.message });
      preserveActiveOrClose();
    });
    upstream.on("close", (code, reason) => {
      activeConnections.delete(connection);
      void onTransportError({ side: "upstream_close", code, message: `${code} ${String(reason)}`.trim() });
      closePeer();
      scheduleIdle();
    });
    upstream.on("error", (error) => {
      void onTransportError({ side: "upstream", message: error.message });
      closePeer();
    });
  });

  return {
    url: `ws://127.0.0.1:${address.port}`,
    async close() {
      for (const gate of approvalGates) gate.close();
      closing = true;
      cancelIdle();
      for (const client of server.clients) client.terminate();
      await new Promise((resolveClose) => server.close(() => healthServer.close(() => resolveClose())));
    },
  };
}
