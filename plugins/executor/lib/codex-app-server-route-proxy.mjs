import { WebSocket, WebSocketServer } from "ws";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { selectRouteForProvider } from "./model-ladder.mjs";

function routeModel(model) {
  return String(model ?? "").replace(/^[^/]+\//, "").trim();
}

function sameRouteValue(actual, expected) {
  return String(actual ?? "").trim() === String(expected ?? "").trim();
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
  const data = message.result.data.filter((entry) => threadCwds[entry?.id]?.threadSource !== "subagent").map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const metadata = threadCwds[entry.id];
    const cwd = displayCwd(metadata?.cwd ?? metadata ?? entry.cwd, home);
    if (!cwd) return entry;
    const terminal = labels[`codex:${entry.id}`]?.label;
    const synopsis = !terminal && metadata?.synopsis ? ` · ${metadata.synopsis}` : "";
    const fork = !terminal && String(metadata?.cwd ?? "").includes("/.agent-worktrees/") ? "fork · " : "";
    const fingerprint = String(entry.id ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(-6);
    const suffix = fingerprint ? ` · #${fingerprint}` : "";
    const prefix = terminal ? `[${terminal} · ${cwd}${suffix}]` : `[${fork}${cwd}${synopsis}${suffix}]`;
    if (typeof entry.name === "string" && entry.name.trim() && !entry.name.startsWith(prefix)) {
      changed = true;
      return { ...entry, name: `${prefix} ${entry.name}` };
    }
    if ((!entry.name || !String(entry.name).trim()) && typeof entry.preview === "string" && entry.preview.trim() && !entry.preview.startsWith(prefix)) {
      changed = true;
      return { ...entry, preview: `${prefix} ${entry.preview}` };
    }
    return entry;
  });
  return changed ? { ...message, result: { ...message.result, data } } : message;
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
  onRouteInjected = async () => {},
  onRouteConfirmed = async () => {},
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
    const activeThreads = new Map();
    const activeProviders = new Map();
    const pendingTurnStarts = new Map();
    const receipts = new Map();
    const requestMethods = new Map();
    let protocolFailed = false;
    const syncActivity = () => {
      if (activeThreads.size > 0) activeConnections.add(connection);
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
        if (message.id !== undefined && message.method) requestMethods.set(String(message.id), message.method);
        message = applyThreadListCwd(message, threadListCwd);
        const compacted = compactResume && message.method === "thread/resume";
        message = applyCompactResumeRequest(message, compactResume, resumeHistoryLimit);
        payload = JSON.stringify(message);
        if (compacted) void onConnection({ direction: "native_to_upstream", method: `thread/resume [last ${resumeHistoryLimit} turns]` });
        if (message.method === "turn/start") {
          releaseRouteLease = await acquireRouteLease();
          if (protocolFailed || downstream.readyState !== WebSocket.OPEN) {
            releaseRouteLease();
            return;
          }
          const threadId = String(message.params?.threadId ?? "");
          const requestId = message.id === undefined ? null : String(message.id);
          const reason = requestId === null ? Symbol("turn-start") : `turn-start:${requestId}`;
          provisionalTurn = { requestId, reason, threadId };
          addActivity(threadId, reason);
          if (requestId !== null) pendingTurnStarts.set(requestId, provisionalTurn);
          const pendingRoute = await takePendingRoute(threadId);
          const route = pendingRoute?.route ?? pendingRoute;
          releasePendingRoute = pendingRoute?.release ?? null;
          const applied = applyRouteToTurnStart(message, route, activeProviders.get(threadId));
          payload = JSON.stringify(applied.message);
          if (applied.receipt) {
            routeReceipt = applied.receipt;
            acknowledgeRoute = pendingRoute?.ack ?? null;
          } else {
            await releasePendingRoute?.();
            releasePendingRoute = null;
          }
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
        downstream.close(1011, `Statewright route proxy failed: ${error.message}`);
        return;
      }
    });
    upstream.on("message", async (raw) => {
      let payload = String(raw);
      try {
        let notification = JSON.parse(payload);
        const responseId = notification.id === undefined ? null : String(notification.id);
        const responseTo = responseId === null ? null : requestMethods.get(responseId);
        if (responseTo) requestMethods.delete(responseId);
        if ((responseTo === "thread/start" || responseTo === "thread/resume") && notification?.result?.thread?.id) {
          const provider = String(notification.result.thread.modelProvider ?? "").trim();
          if (provider) activeProviders.set(String(notification.result.thread.id), provider);
        }
        const pendingTurn = responseId === null ? null : pendingTurnStarts.get(responseId);
        if (pendingTurn) {
          pendingTurnStarts.delete(responseId);
          if (notification.error) removeActivity(pendingTurn.threadId, pendingTurn.reason);
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
        const statusThreadId = String(notification?.params?.threadId ?? "");
        if (notification?.method === "thread/status/changed" && statusThreadId) {
          if (notification.params?.status?.type === "active") addActivity(statusThreadId, "server-active");
          else activeThreads.delete(statusThreadId);
        } else if (notification?.method === "turn/started" && statusThreadId) {
          addActivity(statusThreadId, "server-active");
        } else if (notification?.method === "turn/completed" && statusThreadId) {
          activeThreads.delete(statusThreadId);
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
      } catch (error) {
        // Protocol traffic is still forwarded; receipt telemetry must never
        // interfere with a native Codex session.
        void onProtocolError({ side: "upstream_to_native", message: error instanceof Error ? error.message : String(error) });
      }
      // App Server WebSocket mode specifies one JSON-RPC text frame per
      // message. `ws` exposes received text as a Buffer by default; sending
      // that buffer would silently convert it into a binary frame, which the
      // native Codex TUI rejects during its initialize handshake.
      void forwardWhenOpen(downstream, payload).catch((error) => onTransportError({
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
        connectedClients = Math.max(0, connectedClients - 1);
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
      closing = true;
      cancelIdle();
      for (const client of server.clients) client.terminate();
      await new Promise((resolveClose) => server.close(() => healthServer.close(() => resolveClose())));
    },
  };
}
