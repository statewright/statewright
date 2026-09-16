import { WebSocket, WebSocketServer } from "ws";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { HandoffPresentation, hardInterruptNotice } from "./app-server-handoff.mjs";
import { CodexApprovalGate } from "./codex-approval-gate.mjs";
import { pendingApprovalSnapshot } from "./human-approval.mjs";
function routeModel(model) {
  return String(model ?? "").replace(/^[^/]+\//, "").trim();
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
  if (selectedRoute.effort) params.effort = selectedRoute.effort;
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
      providerConfig: identity.config,
    },
  };
}

export function settingsConfirmRoute(receipt, notification) {
  if (!receipt || notification?.method !== "thread/settings/updated") return null;
  const params = notification.params ?? {};
  if (String(params.threadId ?? "") !== receipt.threadId) return null;
  const settings = params.threadSettings ?? {};
  const actualModel = routeModel(settings.model);
  const actualProvider = String(settings.modelProvider ?? "").trim() || null;
  const actualEffort = settings.effort ?? null;
  return {
    ...receipt,
    actualModel,
    actualProvider,
    actualEffort,
    confirmed: sameRouteValue(actualModel, receipt.effectiveModel)
      && (!receipt.effectiveProvider || sameRouteValue(actualProvider, receipt.effectiveProvider))
      && (!receipt.effectiveEffort || sameRouteValue(actualEffort, receipt.effectiveEffort)),
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
  peekPendingRoute = async () => null,
  onRouteInjected = async () => {},
  onRouteConfirmed = async () => {},
  onHandoffStatus = async () => {},
  onConnection = async () => {},
  onTransportError = async () => {},
  onProtocolError = async () => {},
  compactResume = true,
  resumeHistoryLimit = 4,
  threadListCwd = null,
  threadLabels = {},
  getThreadLabels = async () => threadLabels,
  getThreadCwds = async () => ({}),
  onThreadResumed = async () => {},
  forwardPayload = forwardWhenOpen,
  idleMs = 500,
  onIdle = async () => {},
}) {
  const healthServer = createServer((request, response) => {
    if (request.url === "/readyz" || request.url === "/healthz") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("ok\n");
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

  server.on("connection", (downstream) => {
    const connection = Symbol("app-server-connection");
    let parkingCount = 0;
    const activeThreads = new Map();
    const activeProviders = new Map();
    const activeModels = new Map();
    const operatorActivity = new Map();
    const explainedTurns = new Map();
    const turnOrigins = new Map();
    const pendingTurnStarts = new Map();
    const receipts = new Map();
    const requestMethods = new Map();
    const pendingApprovalReleases = new Map();
    const internalRequests = new Map();
    const switchingThreads = new Set();
    const stateNames = new Map();
    const presentation = new HandoffPresentation({onStatus: event => {
      if (event.phase === "running") stateNames.set(event.thread_id, event.state);
      return onHandoffStatus(event);
    }});
    const sendPresentation = (messages) => Promise.all(messages.map(message =>
      forwardWhenOpen(downstream, JSON.stringify(message))));
    let internalSequence = 0;
    let protocolFailed = false;
    const internalRpc = async (method, params) => {
      const id = `statewright-provider-switch-${++internalSequence}`;
      const response = new Promise((resolveResponse, rejectResponse) => {
        const timer = setTimeout(() => {
          internalRequests.delete(id);
          rejectResponse(new Error(`Codex App Server timed out switching provider during ${method}.`));
        }, 12_000);
        internalRequests.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
      });
      await forwardPayload(upstream, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return response;
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
      continueApproved: async ({ threadId, state, goal, check }) => {
        const checkOwner = async () => { check(); await gate.assertOwner(threadId); check(); };
        const release = await acquireRouteLease();
        let reservation, forwarded = false;
        try {
          await checkOwner();
          await waitForApprovalIdle(threadId, checkOwner);
          reservation = await takePendingRoute(threadId);
          await checkOwner();
          const route = reservation?.route ?? reservation ?? { session_id: threadId, run_id: state.run_id,
            state: state.state, model: state.model, effort: state.thinking_level };
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
        if (gate?.handleReply(message)) return;
        if ((["turn/start", "turn/interrupt", "turn/steer", "thread/goal/clear"].includes(message.method)
            || message.method === "thread/goal/set" && message.params?.status === "active") && message.params?.threadId) {
          gate?.userActivity(message.params.threadId);
          operatorActivity.set(message.params.threadId, (operatorActivity.get(message.params.threadId) ?? 0) + 1);
          requestEpoch = operatorActivity.get(message.params.threadId);
          if (message.method === "turn/interrupt" && message.params.turnId) explainedTurns.set(message.params.threadId, message.params.turnId);
          await sendPresentation(presentation.userActivity(message.params.threadId));
        }
        void onConnection({ direction: "native_to_upstream", method: message.method ?? null });
        if (message.id !== undefined && message.method) requestMethods.set(String(message.id), message.method);
        message = applyThreadListCwd(message, threadListCwd);
        const compacted = compactResume && message.method === "thread/resume";
        message = applyCompactResumeRequest(message, compactResume, resumeHistoryLimit);
        payload = JSON.stringify(message);
        if (compacted) void onConnection({ direction: "native_to_upstream", method: `thread/resume [last ${resumeHistoryLimit} turns]` });
        if (["turn/start", "turn/steer"].includes(message.method) || message.method === "thread/goal/set" && message.params?.status === "active") {
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
              requestMethods.delete(String(message.id));
              await forwardWhenOpen(downstream, JSON.stringify({ id: message.id,
                error: { code: -32603, message: error.message } }));
              await reportApprovalFailure(error);
              return;
            }
          }
        }
        if (message.method === "turn/start" || approvedRelease && message.method === "thread/goal/set") {
          releaseRouteLease = await acquireRouteLease();
          await checkReleaseOwner();
          if (protocolFailed || downstream.readyState !== WebSocket.OPEN) {
            releaseRouteLease();
            return;
          }
          const threadId = String(message.params?.threadId ?? "");
          const requestId = message.id === undefined ? null : String(message.id);
          const reason = requestId === null ? Symbol("turn-start") : `turn-start:${requestId}`;
          if (message.method === "turn/start") {
            provisionalTurn = { requestId, reason, threadId };
            addActivity(threadId, reason);
            if (requestId !== null) pendingTurnStarts.set(requestId, provisionalTurn);
          }
          const pendingRoute = await takePendingRoute(threadId);
          releasePendingRoute = pendingRoute?.release ?? null;
          await checkReleaseOwner();
          const state = approvedRelease?.state;
          const route = pendingRoute?.route ?? pendingRoute ?? (state && { session_id: threadId,
            run_id: state.run_id, state: state.state, model: state.model, effort: state.thinking_level });
          if (state && (route?.session_id !== threadId || route.run_id !== state.run_id || route.state !== state.state
              || !route.model || route.model !== state.model || route.effort !== state.thinking_level)) {
            const error = new Error("Approval release lacks the authoritative destination route");
            error.code = "STATEWRIGHT_APPROVAL_ROUTE";
            throw error;
          }
          if (state) await waitForApprovalIdle(threadId, checkReleaseOwner);
          const applied = applyRouteToTurnStart(message.method === "turn/start" ? message
            : { method: "turn/start", params: { threadId } }, route, process.env);
          if (applied.receipt) {
            presentation.prepare(threadId, requestId, {
              state: route.state, fromState: stateNames.get(threadId), runId: route.run_id,
              model: applied.receipt.effectiveModel, effort: applied.receipt.effectiveEffort,
            });
            // Only a provider handoff is recoverable at request scope. A
            // generic upstream send failure still means the transport itself
            // is broken and must close as before.
            providerRouteAttempted = applied.receipt.effectiveProvider !== "openai"
              || (activeProviders.has(threadId) && activeProviders.get(threadId) !== applied.receipt.effectiveProvider);
            await switchProvider(threadId, applied.receipt);
            await checkReleaseOwner();
            if (message.method === "thread/goal/set") {
              await internalRpc("thread/settings/update", { threadId, model: applied.message.params.model,
                effort: applied.message.params.effort });
              await checkReleaseOwner();
            }
          }
          payload = JSON.stringify(message.method === "turn/start" ? applied.message : message);
          if (provisionalTurn) provisionalTurn.model = routeModel(applied.message.params?.model);
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
          pendingApprovalReleases.set(String(message.id), { ...approvedRelease, threadId: message.params.threadId });
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
          if (message?.id !== undefined) pendingApprovalReleases.delete(String(message.id));
          try {
            await releasePendingRoute?.();
          } catch (releaseError) {
            error = new AggregateError([error, releaseError], "Statewright route forwarding and reservation release both failed.");
          }
        }
        releaseRouteLease?.();
        if (provisionalTurn) {
          removeActivity(provisionalTurn.threadId, provisionalTurn.reason);
          if (provisionalTurn.requestId !== null) pendingTurnStarts.delete(provisionalTurn.requestId);
        }
        void onProtocolError({ side: "native_to_upstream", message: error instanceof Error ? error.message : String(error) });
        // A rejected route is a turn-level failure, not a corrupted transport.
        // Closing the WebSocket here makes native Codex lose its session and
        // defeats retry/recovery after a provider configuration mistake.
        if ((providerRouteAttempted || approvedRelease || error.code === "STATEWRIGHT_SUPERSEDED")
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
        downstream.close(1011, `Statewright route proxy failed: ${error.message}`);
        return;
      }
    });
    let upstreamDelivery = Promise.resolve();
    const handleUpstream = async (raw) => {
      let payload = String(raw);
      let approvalHint = null;
      let attachedThreadId = null;
      const handoffMessages = [];
      const prefaceMessages = [];
      try {
        let notification = JSON.parse(payload);
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
        const responseId = notification.id === undefined ? null : String(notification.id);
        const internal = responseId === null ? null : internalRequests.get(responseId);
        if (internal) {
          internalRequests.delete(responseId);
          clearTimeout(internal.timer);
          if (notification.error) internal.reject(new Error(notification.error.message ?? "Codex App Server rejected the provider switch."));
          else internal.resolve(notification.result);
          return;
        }
        const responseTo = responseId === null ? null : requestMethods.get(responseId);
        if (responseTo) requestMethods.delete(responseId);
        const approvalRelease = responseId === null ? null : pendingApprovalReleases.get(responseId);
        if (approvalRelease) {
          pendingApprovalReleases.delete(responseId);
          if (!notification.error && (responseTo === "turn/start" && notification.result?.turn?.id
              || responseTo === "thread/goal/set" && notification.result?.goal?.status === "active")) {
            await gate.assertOwner(approvalRelease.threadId);
            await approvalService.clear(approvalRelease.threadId, approvalRelease.approvalId);
          }
        }
        if ((responseTo === "thread/start" || responseTo === "thread/resume") && notification?.result?.thread?.id) {
          attachedThreadId = notification.result.thread.id;
          const provider = String(notification.result.modelProvider ?? notification.result.thread.modelProvider ?? "").trim();
          const model = routeModel(notification.result.model ?? notification.result.thread.model);
          if (provider) activeProviders.set(String(notification.result.thread.id), provider);
          if (model) activeModels.set(String(notification.result.thread.id), model);
        }
        const pendingTurn = responseId === null ? null : pendingTurnStarts.get(responseId);
        if (pendingTurn) {
          pendingTurnStarts.delete(responseId);
          if (notification.error) {
            removeActivity(pendingTurn.threadId, pendingTurn.reason);
            await sendPresentation(presentation.cancel(pendingTurn.threadId, responseId));
          } else {
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
        if (notification.method === "thread/settings/updated" && statusThreadId) {
          const settings = notification.params.threadSettings;
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
          turnOrigins.set(statusThreadId, {turnId: notification.params.turn.id,
            provider: activeProviders.get(statusThreadId), model: activeModels.get(statusThreadId)});
          addActivity(statusThreadId, "server-active");
        } else if (notification?.method === "turn/completed" && statusThreadId) {
          activeThreads.delete(statusThreadId);
        }
        syncActivity();
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
          await onRouteConfirmed(receipt);
        }
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
      if (approvalHint) void gate.observe(approvalHint.threadId, approvalHint.snapshot, approvalHint.turnId).catch(reportApprovalFailure);
      else if (attachedThreadId && gate) void gate.reopen(attachedThreadId).catch(reportApprovalFailure);
    };
    // Preserve source order while a terminal's display-only route lookup waits.
    upstream.on("message", raw => {
      upstreamDelivery = upstreamDelivery.then(() => handleUpstream(raw)).catch(() => {});
    });
    const closePeer = () => {
      gate?.close();
      approvalGates.delete(gate);
      for (const request of internalRequests.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Codex App Server connection closed during provider switch."));
      }
      internalRequests.clear();
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
      if (downstream.readyState === WebSocket.OPEN || downstream.readyState === WebSocket.CONNECTING) downstream.close();
    };
    let downstreamClosed = false;
    const markDownstreamClosed = () => {
      if (!downstreamClosed) {
        downstreamClosed = true;
        connectedClients = Math.max(0, connectedClients - 1);
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
