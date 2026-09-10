import { WebSocket, WebSocketServer } from "ws";
import { createServer } from "node:http";
import { providerModel, selectAvailableRoute, selectRouteForProvider } from "./model-ladder.mjs";

function routeModel(model) {
  return String(model ?? "").replace(/^[^/]+\//, "").trim();
}

function sameRouteValue(actual, expected) {
  return String(actual ?? "").trim() === String(expected ?? "").trim();
}

function normalizeProvider(provider) {
  return providerModel(`${String(provider ?? "").trim()}/_`).provider;
}

function bearerToken(request) {
  const authorization = String(request?.headers?.authorization ?? "").trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function mergeProviderModelList(message, { activeProvider = "openai", profiles = [] } = {}) {
  if (!Array.isArray(message?.result?.data)) return message;
  const active = normalizeProvider(activeProvider);
  const providers = new Map();
  providers.set(active, message.result.data);
  for (const profile of profiles) {
    const provider = normalizeProvider(profile?.provider);
    if (provider && provider !== active && Array.isArray(profile.models)) providers.set(provider, profile.models);
  }
  const seen = new Set();
  const data = [];
  for (const [provider, models] of providers) {
    for (const model of models) {
      const nativeModel = routeModel(model?.model ?? model?.id);
      if (!provider || !nativeModel) continue;
      const providerModelId = `${provider}/${nativeModel}`;
      if (seen.has(providerModelId)) continue;
      seen.add(providerModelId);
      const id = provider === active ? nativeModel : providerModelId;
      data.push({ ...model, id, model: id });
    }
  }
  return { ...message, result: { ...message.result, data, nextCursor: null } };
}

export function normalizeProviderMessage(message) {
  if (!message || typeof message !== "object") return message;
  if (message.result?.thread) {
    const result = { ...message.result };
    if (typeof message.result.model === "string") result.model = routeModel(message.result.model);
    if (typeof message.result.thread.model === "string") {
      result.thread = { ...message.result.thread, model: routeModel(message.result.thread.model) };
    }
    return { ...message, result };
  }
  if (message.method === "thread/settings/updated" && message.params?.threadSettings) {
    const settings = message.params.threadSettings;
    return {
      ...message,
      params: {
        ...message.params,
        threadSettings: {
          ...settings,
          model: routeModel(settings.model),
        },
      },
    };
  }
  return message;
}

export function applyProviderResumeRequest(message, route) {
  if (message?.method !== "thread/resume" || !route?.provider || !route?.model) return message;
  return {
    ...message,
    params: {
      ...(message.params ?? {}),
      modelProvider: normalizeProvider(route.provider),
      model: routeModel(route.model),
    },
  };
}

export function providerHandoffForSettingsUpdate(message, {
  activeProvider,
  profiles = [],
  threadActive = false,
  threadResumable = true,
} = {}) {
  if (message?.method !== "thread/settings/update") return null;
  const parsed = providerModel(message.params?.model);
  if (!parsed.provider || !parsed.model || parsed.provider === normalizeProvider(activeProvider)) return null;
  if (threadActive) {
    throw new Error("Statewright cannot switch Codex providers during an active turn. Wait for the current turn to finish and try again.");
  }
  const profile = parsed.provider === "openai"
    ? null
    : profiles.find((candidate) => normalizeProvider(candidate?.provider) === parsed.provider)?.profile;
  if (parsed.provider !== "openai" && !profile) {
    throw new Error(`Statewright has no Codex profile for provider '${parsed.provider}'. Add $CODEX_HOME/<name>.config.toml with model_provider and model_catalog_json.`);
  }
  return {
    threadId: String(message.params?.threadId ?? ""),
    provider: parsed.provider,
    profile,
    model: parsed.model,
    effort: message.params?.effort ?? null,
    resume: threadResumable,
    source: "manual_model_picker",
  };
}

export function providerHandoffForRoute(route, { activeProvider, profiles = [] } = {}) {
  const parsed = providerModel(route?.model);
  const provider = parsed.provider ?? normalizeProvider(activeProvider);
  if (!provider || provider === normalizeProvider(activeProvider)) return null;
  const profile = provider === "openai"
    ? null
    : profiles.find((candidate) => normalizeProvider(candidate?.provider) === provider)?.profile;
  if (provider !== "openai" && !profile) {
    throw new Error(`Statewright has no Codex profile for provider '${provider}'. Add $CODEX_HOME/<name>.config.toml with model_provider and model_catalog_json.`);
  }
  return {
    threadId: String(route?.session_id ?? ""),
    provider,
    profile,
    model: parsed.model,
    effort: route?.effort ?? null,
    resume: true,
    source: "statewright_model_ladder",
  };
}

export function applyRouteToTurnStart(message, route, activeProvider = null) {
  if (message?.method !== "turn/start" || !route) return { message, receipt: null };
  const threadId = String(message.params?.threadId ?? "");
  const routeSessionId = String(route.session_id ?? "");
  if (!threadId || !routeSessionId || threadId !== routeSessionId) return { message, receipt: null };
  const selectedRoute = selectRouteForProvider(route, activeProvider);
  const model = routeModel(selectedRoute.model);
  if (!model) throw new Error("Statewright App Server route is missing a model.");
  const params = { ...(message.params ?? {}), model };
  if (selectedRoute.effort) params.effort = selectedRoute.effort;
  const routed = { ...message, params };
  return {
    message: routed,
    receipt: {
      route: selectedRoute,
      threadId,
      requestedModel: String(selectedRoute.model),
      effectiveModel: model,
      effectiveEffort: selectedRoute.effort ?? null,
    },
  };
}

export function settingsConfirmRoute(receipt, notification) {
  if (!receipt || notification?.method !== "thread/settings/updated") return null;
  const params = notification.params ?? {};
  if (String(params.threadId ?? "") !== receipt.threadId) return null;
  const settings = params.threadSettings ?? {};
  const actualModel = routeModel(settings.model);
  const actualEffort = settings.effort ?? null;
  return {
    ...receipt,
    actualModel,
    actualEffort,
    confirmed: sameRouteValue(actualModel, receipt.effectiveModel)
      && (!receipt.effectiveEffort || sameRouteValue(actualEffort, receipt.effectiveEffort)),
  };
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
  takePendingRoute,
  profiles = [],
  activeProvider = "openai",
  resumeRoute = null,
  onProviderHandoff = async () => {},
  prepareProviderHandoff = null,
  onThreadAttached = async () => {},
  onRouteInjected = async () => {},
  onRouteConfirmed = async () => {},
  onConnection = async () => {},
  onTransportError = async () => {},
  onProtocolError = async () => {},
  compactResume = true,
  resumeHistoryLimit = 4,
  threadListCwd = null,
  forwardPayload = forwardWhenOpen,
  forwardDownstreamPayload = forwardWhenOpen,
  idleMs = 500,
  routePollMs = 100,
  providerHandoffCloseMs = 100,
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
  const connectionActivities = new Map();
  const residentActiveThreads = new Map();
  const completingThreads = new Set();
  const resumableThreads = new Set();
  const syncConnectionActivity = (connection) => {
    const activity = connectionActivities.get(connection);
    if (activity?.size) activeConnections.add(connection);
    else activeConnections.delete(connection);
  };
  const clearThreadActivity = (threadId) => {
    const owners = residentActiveThreads.get(threadId);
    if (!owners) return;
    for (const connection of owners) {
      connectionActivities.get(connection)?.delete(threadId);
      syncConnectionActivity(connection);
    }
    residentActiveThreads.delete(threadId);
  };
  const clearConnectionActivity = (connection) => {
    const activity = connectionActivities.get(connection);
    for (const threadId of activity?.keys?.() ?? []) {
      const owners = residentActiveThreads.get(threadId);
      owners?.delete(connection);
      if (owners?.size === 0) residentActiveThreads.delete(threadId);
    }
    connectionActivities.delete(connection);
    activeConnections.delete(connection);
  };
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
    const connection = Symbol("app-server-connection");
    const launchNonce = bearerToken(request);
    const activeThreads = new Map();
    connectionActivities.set(connection, activeThreads);
    const activeProviders = new Map();
    const pendingTurnStarts = new Map();
    const receipts = new Map();
    const requestMethods = new Map();
    const attachmentRequests = new Map();
    const queuedRoutes = new Map();
    let currentProvider = normalizeProvider(activeProvider);
    let providerSwitching = null;
    let providerHandoffPendingRoute = null;
    let providerHandoffCloseTimer = null;
    let providerHandoffCommit = null;
    let providerHandoffConfigWriteId = null;
    let routePollBusy = false;
    let protocolFailed = false;
    const syncActivity = () => {
      syncConnectionActivity(connection);
    };
    const addActivity = (threadId, reason) => {
      if (!threadId) return;
      const reasons = activeThreads.get(threadId) ?? new Set();
      reasons.add(reason);
      activeThreads.set(threadId, reasons);
      const owners = residentActiveThreads.get(threadId) ?? new Set();
      owners.add(connection);
      residentActiveThreads.set(threadId, owners);
      syncActivity();
      cancelIdle();
    };
    const removeActivity = (threadId, reason) => {
      const reasons = activeThreads.get(threadId);
      if (!reasons) return;
      reasons.delete(reason);
      if (reasons.size === 0) {
        activeThreads.delete(threadId);
        const owners = residentActiveThreads.get(threadId);
        owners?.delete(connection);
        if (owners?.size === 0) residentActiveThreads.delete(threadId);
      }
      syncActivity();
    };
    const reservePendingRoute = async (threadId) => {
      const pending = await takePendingRoute(threadId);
      if (!pending) return null;
      const route = pending.route ?? pending;
      try {
        const selected = await selectAvailableRoute(route);
        return { ...pending, route: selected };
      } catch (error) {
        await pending.release?.();
        throw error;
      }
    };
    const sameProviderHandoff = (left, right) => left
      && left.threadId === right.threadId
      && left.provider === right.provider
      && left.model === right.model;
    const scheduleProviderClose = () => {
      if (providerHandoffCloseTimer) clearTimeout(providerHandoffCloseTimer);
      providerHandoffCloseTimer = setTimeout(() => {
        providerHandoffCloseTimer = null;
        if (downstream.readyState === WebSocket.OPEN) downstream.close(1012, "Statewright provider handoff");
      }, providerHandoffCloseMs);
      providerHandoffCloseTimer.unref?.();
    };
    const commitProviderHandoff = async () => {
      if (providerHandoffCommit) return providerHandoffCommit;
      if (!providerSwitching) return false;
      const handoff = providerSwitching;
      const pending = providerHandoffPendingRoute;
      providerHandoffCommit = (async () => {
        let transaction = null;
        let published = false;
        try {
          transaction = prepareProviderHandoff
            ? await prepareProviderHandoff(handoff)
            : {
              publish: () => onProviderHandoff(handoff),
              discard: async () => {},
            };
          await transaction.publish();
          published = true;
          scheduleProviderClose();
          // Publish first so a crash or failed source acknowledgement cannot
          // create a state where neither side of the provider handoff is
          // discoverable. A failed source ACK is safe at-least-once delivery:
          // its orphaned route claim is recovered and becomes a same-provider
          // route after the target attaches.
          try {
            await pending?.ack?.();
          } catch (error) {
            void Promise.resolve(onProtocolError({
              side: "provider_handoff_source_ack",
              message: error instanceof Error ? error.message : String(error),
            })).catch(() => {});
          }
          return true;
        } catch (error) {
          if (!published) await transaction?.discard?.().catch(() => {});
          providerSwitching = null;
          providerHandoffPendingRoute = null;
          providerHandoffCommit = null;
          providerHandoffConfigWriteId = null;
          await pending?.release?.();
          throw error;
        }
      })();
      return providerHandoffCommit;
    };
    const requestProviderHandoff = async (handoff, pending = null, { deferCommit = false } = {}) => {
      if (providerHandoffCommit) {
        if (pending && pending !== providerHandoffPendingRoute) await pending.release?.();
        return sameProviderHandoff(providerSwitching, handoff);
      }
      providerSwitching = sameProviderHandoff(providerSwitching, handoff)
        ? { ...handoff, effort: handoff.effort ?? providerSwitching.effort }
        : handoff;
      if (pending) providerHandoffPendingRoute = pending;
      if (!deferCommit) return commitProviderHandoff();
      return true;
    };
    const pollRoutes = async () => {
      if (routePollBusy || providerSwitching || protocolFailed || downstream.readyState !== WebSocket.OPEN) return;
      routePollBusy = true;
      const releaseLease = await acquireRouteLease();
      try {
        for (const threadId of activeProviders.keys()) {
          if (residentActiveThreads.has(threadId) || completingThreads.has(threadId) || queuedRoutes.has(threadId)) continue;
          const pending = await reservePendingRoute(threadId);
          if (!pending) continue;
          let handoff;
          try {
            handoff = providerHandoffForRoute(pending.route, { activeProvider: currentProvider, profiles });
          } catch (error) {
            await pending.release?.();
            throw error;
          }
          if (handoff) {
            await requestProviderHandoff(handoff, pending);
            return;
          }
          queuedRoutes.set(threadId, pending);
        }
      } catch (error) {
        void onProtocolError({ side: "route_poll", message: error instanceof Error ? error.message : String(error) });
      } finally {
        releaseLease();
        routePollBusy = false;
      }
    };
    const routeTimer = setInterval(() => { void pollRoutes(); }, routePollMs);
    routeTimer.unref?.();
    everConnected = true;
    connectedClients += 1;
    cancelIdle();
    const upstream = new WebSocket(upstreamUrl);
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
      try {
        let message = JSON.parse(payload);
        void onConnection({ direction: "native_to_upstream", method: message.method ?? null });
        message = applyThreadListCwd(message, threadListCwd);
        const compacted = compactResume && message.method === "thread/resume";
        message = applyCompactResumeRequest(message, compactResume, resumeHistoryLimit);
        message = applyProviderResumeRequest(message, resumeRoute);
        if (message.method === "thread/settings/update" && message.params?.model) {
          let handoff;
          try {
            handoff = providerHandoffForSettingsUpdate(message, {
              activeProvider: currentProvider,
              profiles,
              threadActive: residentActiveThreads.has(String(message.params?.threadId ?? ""))
                || completingThreads.has(String(message.params?.threadId ?? "")),
              threadResumable: resumableThreads.has(String(message.params?.threadId ?? "")),
            });
          } catch (error) {
            if (message.id !== undefined) {
              await forwardDownstreamPayload(downstream, JSON.stringify({
                id: message.id,
                error: { code: -32600, message: error instanceof Error ? error.message : String(error) },
              }));
            }
            return;
          }
          if (handoff) {
            try {
              if (!await requestProviderHandoff(handoff, null, { deferCommit: true })) return;
              if (message.id !== undefined) await forwardDownstreamPayload(downstream, JSON.stringify({ id: message.id, result: {} }));
            } catch (error) {
              if (message.id !== undefined) {
                await forwardDownstreamPayload(downstream, JSON.stringify({
                  id: message.id,
                  error: { code: -32603, message: `Statewright could not prepare the provider handoff: ${error instanceof Error ? error.message : String(error)}` },
                }));
              }
            }
            return;
          }
          const parsed = providerModel(message.params.model);
          if (providerSwitching?.source === "manual_model_picker" && parsed.provider === currentProvider) {
            providerSwitching = null;
            providerHandoffPendingRoute = null;
            providerHandoffConfigWriteId = null;
          }
          if (parsed.provider) message = { ...message, params: { ...message.params, model: parsed.model } };
        }
        if (message.method === "config/batchWrite" && providerSwitching?.source === "manual_model_picker" && providerHandoffConfigWriteId === null && message.id !== undefined) {
          providerHandoffConfigWriteId = String(message.id);
        }
        if (message.id !== undefined && message.method) requestMethods.set(String(message.id), message.method);
        payload = JSON.stringify(message);
        if (compacted) void onConnection({ direction: "native_to_upstream", method: `thread/resume [last ${resumeHistoryLimit} turns]` });
        if (message.method === "turn/start") {
          const requestedModel = providerModel(message.params?.model);
          if (requestedModel.provider) {
            if (requestedModel.provider !== currentProvider) {
              throw new Error(`Codex turn requested provider '${requestedModel.provider}' while '${currentProvider}' owns the thread. Switch providers before starting the turn.`);
            }
            message = { ...message, params: { ...(message.params ?? {}), model: requestedModel.model } };
          }
          releaseRouteLease = await acquireRouteLease();
          if (protocolFailed || downstream.readyState !== WebSocket.OPEN) {
            releaseRouteLease();
            return;
          }
          const threadId = String(message.params?.threadId ?? "");
          const requestId = message.id === undefined ? null : String(message.id);
          const reason = requestId === null ? Symbol("turn-start") : `turn-start:${requestId}`;
          const pendingRoute = queuedRoutes.get(threadId) ?? await reservePendingRoute(threadId);
          if (queuedRoutes.has(threadId)) queuedRoutes.delete(threadId);
          releasePendingRoute = pendingRoute?.release ?? null;
          const handoff = providerHandoffForRoute(pendingRoute?.route, { activeProvider: currentProvider, profiles });
          if (handoff) {
            await requestProviderHandoff(handoff, pendingRoute, { deferCommit: true });
            if (requestId !== null && downstream.readyState === WebSocket.OPEN) {
              try {
                await forwardDownstreamPayload(downstream, JSON.stringify({
                  id: message.id,
                  error: { code: -32001, message: "Statewright changed Codex providers at this turn boundary. Retry the prompt after the session reconnects." },
                }));
              } catch (error) {
                providerSwitching = null;
                providerHandoffPendingRoute = null;
                await releasePendingRoute?.();
                releasePendingRoute = null;
                throw error;
              }
            }
            releasePendingRoute = null;
            await commitProviderHandoff();
            releaseRouteLease();
            return;
          }
          provisionalTurn = { requestId, reason, threadId };
          addActivity(threadId, reason);
          if (requestId !== null) pendingTurnStarts.set(requestId, provisionalTurn);
          const route = pendingRoute?.route ?? pendingRoute;
          const applied = applyRouteToTurnStart(message, route, activeProviders.get(threadId));
          message = applied.message;
          payload = JSON.stringify(message);
          if (applied.receipt) {
            routeReceipt = applied.receipt;
            acknowledgeRoute = pendingRoute?.ack ?? null;
          } else {
            await releasePendingRoute?.();
            releasePendingRoute = null;
          }
        }
        if ((message.method === "thread/start" || message.method === "thread/resume") && message.id !== undefined) {
          attachmentRequests.set(String(message.id), {
            launchNonce,
            method: message.method,
            requestedThreadId: String(message.params?.threadId ?? "") || null,
            requestedProvider: normalizeProvider(message.params?.modelProvider) || currentProvider,
            requestedModel: routeModel(message.params?.model ?? resumeRoute?.model),
            requestedEffort: String(message.params?.effort ?? resumeRoute?.effort ?? "").trim() || null,
          });
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
        protocolFailed = true;
        if (!routeForwarded) {
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
        downstream.close(1011, "Statewright route proxy failed");
        return;
      }
    });
    upstream.on("message", async (raw) => {
      let payload = String(raw);
      let responseTo = null;
      let responseId = null;
      let responseFailed = false;
      let completedThreadId = null;
      let attachedThread = null;
      try {
        let notification = JSON.parse(payload);
        responseId = notification.id === undefined ? null : String(notification.id);
        responseTo = responseId === null ? null : requestMethods.get(responseId);
        const attachmentRequest = responseId === null ? null : attachmentRequests.get(responseId);
        responseFailed = Boolean(notification.error);
        if (responseTo) requestMethods.delete(responseId);
        if (attachmentRequest) attachmentRequests.delete(responseId);
        if ((responseTo === "thread/start" || responseTo === "thread/resume") && notification?.result?.thread?.id) {
          const threadId = String(notification.result.thread.id);
          const provider = String(notification.result.thread.modelProvider ?? "").trim();
          if (provider) {
            currentProvider = normalizeProvider(provider);
            activeProviders.set(threadId, currentProvider);
            if (responseTo === "thread/resume") resumableThreads.add(threadId);
          }
          attachedThread = {
            launchNonce: attachmentRequest?.launchNonce ?? null,
            threadId,
            provider: normalizeProvider(notification.result.modelProvider ?? notification.result.thread.modelProvider),
            model: routeModel(notification.result.model ?? notification.result.thread.model),
            effort: notification.result.reasoningEffort ?? notification.result.thread.reasoningEffort ?? null,
            method: responseTo,
            requestedThreadId: attachmentRequest?.requestedThreadId ?? null,
            requestedProvider: attachmentRequest?.requestedProvider ?? null,
            requestedModel: attachmentRequest?.requestedModel ?? null,
            requestedEffort: attachmentRequest?.requestedEffort ?? null,
          };
        }
        const pendingTurn = responseId === null ? null : pendingTurnStarts.get(responseId);
        if (pendingTurn) {
          pendingTurnStarts.delete(responseId);
          if (notification.error) removeActivity(pendingTurn.threadId, pendingTurn.reason);
          else resumableThreads.add(pendingTurn.threadId);
        }
        if (responseTo === "thread/resume") {
          notification = clarifyActiveWriterResumeError(notification);
          notification = hydrateBoundedResumeTurns(notification);
          payload = JSON.stringify(notification);
        }
        if (responseTo === "model/list") notification = mergeProviderModelList(notification, { activeProvider: currentProvider, profiles });
        const statusThreadId = String(notification?.params?.threadId ?? "");
        if (notification?.method === "thread/status/changed" && statusThreadId) {
          if (notification.params?.status?.type === "active") addActivity(statusThreadId, "server-active");
          else clearThreadActivity(statusThreadId);
        } else if (notification?.method === "turn/started" && statusThreadId) {
          addActivity(statusThreadId, "server-active");
        } else if (notification?.method === "turn/completed" && statusThreadId) {
          completingThreads.add(statusThreadId);
          completedThreadId = statusThreadId;
        }
        syncActivity();
        if (downstreamClosed && activeThreads.size === 0 && upstream.readyState === WebSocket.OPEN) upstream.close();
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
        notification = normalizeProviderMessage(notification);
        payload = JSON.stringify(notification);
      } catch (error) {
        // Protocol traffic is still forwarded; receipt telemetry must never
        // interfere with a native Codex session.
        void onProtocolError({ side: "upstream_to_native", message: error instanceof Error ? error.message : String(error) });
      }
      // App Server WebSocket mode specifies one JSON-RPC text frame per
      // message. `ws` exposes received text as a Buffer by default; sending
      // that buffer would silently convert it into a binary frame, which the
      // native Codex TUI rejects during its initialize handshake.
      let forwarded = forwardDownstreamPayload(downstream, payload);
      if (attachedThread) forwarded = forwarded.then(() => onThreadAttached(attachedThread));
      if (responseTo === "config/batchWrite" && responseId === providerHandoffConfigWriteId && providerSwitching?.source === "manual_model_picker") {
        void forwarded.then(() => {
          if (responseFailed) {
            providerSwitching = null;
            providerHandoffPendingRoute = null;
            providerHandoffConfigWriteId = null;
            return false;
          }
          return commitProviderHandoff();
        }).catch((error) => onProtocolError({
          side: "provider_handoff",
          message: error instanceof Error ? error.message : String(error),
        })).catch(() => {});
      } else if (completedThreadId) {
        const finishCompletionDelivery = () => {
          clearThreadActivity(completedThreadId);
          completingThreads.delete(completedThreadId);
          if (downstreamClosed && activeThreads.size === 0 && upstream.readyState === WebSocket.OPEN) upstream.close();
          scheduleIdle();
        };
        void forwarded.then(() => {
          finishCompletionDelivery();
          return pollRoutes();
        }).catch((error) => {
          finishCompletionDelivery();
          return onTransportError({
            side: "upstream_to_native",
            message: error instanceof Error ? error.message : String(error),
          });
        }).catch(() => {});
      } else void forwarded.catch((error) => onTransportError({
        side: "upstream_to_native",
        message: error instanceof Error ? error.message : String(error),
      })).catch(() => {});
    });
    const closePeer = () => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
      if (downstream.readyState === WebSocket.OPEN || downstream.readyState === WebSocket.CONNECTING) downstream.close();
    };
    let downstreamClosed = false;
    const markDownstreamClosed = () => {
      if (!downstreamClosed) {
        downstreamClosed = true;
        if (providerHandoffCloseTimer) clearTimeout(providerHandoffCloseTimer);
        providerHandoffCloseTimer = null;
        connectedClients = Math.max(0, connectedClients - 1);
        clearInterval(routeTimer);
        for (const pending of queuedRoutes.values()) void pending.release?.().catch(() => {});
        queuedRoutes.clear();
      }
    };
    const preserveActiveOrClose = () => {
      markDownstreamClosed();
      if (closing || activeThreads.size === 0) closePeer();
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
      clearConnectionActivity(connection);
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
      closing = true;
      cancelIdle();
      for (const client of server.clients) client.terminate();
      await new Promise((resolveClose) => server.close(() => healthServer.close(() => resolveClose())));
    },
  };
}
