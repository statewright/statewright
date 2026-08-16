import { WebSocket, WebSocketServer } from "ws";

function routeModel(model) {
  return String(model ?? "").replace(/^[^/]+\//, "").trim();
}

function sameRouteValue(actual, expected) {
  return String(actual ?? "").trim() === String(expected ?? "").trim();
}

export function applyRouteToTurnStart(message, route) {
  if (message?.method !== "turn/start" || !route) return { message, receipt: null };
  const model = routeModel(route.model);
  if (!model) throw new Error("Statewright App Server route is missing a model.");
  const params = { ...(message.params ?? {}), model };
  if (route.effort) params.effort = route.effort;
  const routed = { ...message, params };
  return {
    message: routed,
    receipt: {
      route,
      threadId: String(params.threadId ?? ""),
      requestedModel: String(route.model),
      effectiveModel: model,
      effectiveEffort: route.effort ?? null,
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

function forwardWhenOpen(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  else socket.once("open", () => socket.send(payload));
}

export async function startCodexAppServerRouteProxy({
  upstreamUrl,
  takePendingRoute,
  onRouteInjected = async () => {},
  onRouteConfirmed = async () => {},
}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const receipts = new Map();
  const listening = new Promise((resolveListening, rejectListening) => {
    server.once("listening", resolveListening);
    server.once("error", rejectListening);
  });
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a Statewright App Server route proxy port.");

  server.on("connection", (downstream) => {
    const upstream = new WebSocket(upstreamUrl);
    downstream.on("message", async (raw) => {
      let payload = String(raw);
      try {
        const message = JSON.parse(payload);
        if (message.method === "turn/start") {
          const route = await takePendingRoute();
          const applied = applyRouteToTurnStart(message, route);
          payload = JSON.stringify(applied.message);
          if (applied.receipt) {
            receipts.set(applied.receipt.threadId, applied.receipt);
            await onRouteInjected(applied.receipt);
          }
        }
      } catch (error) {
        downstream.close(1011, `Statewright route proxy failed: ${error.message}`);
        return;
      }
      forwardWhenOpen(upstream, payload);
    });
    upstream.on("message", async (raw) => {
      try {
        const notification = JSON.parse(String(raw));
        const receipt = settingsConfirmRoute(receipts.get(String(notification?.params?.threadId ?? "")), notification);
        if (receipt) {
          receipts.delete(receipt.threadId);
          await onRouteConfirmed(receipt);
        }
      } catch {
        // Protocol traffic is still forwarded; receipt telemetry must never
        // interfere with a native Codex session.
      }
      forwardWhenOpen(downstream, raw);
    });
    const closePeer = () => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
      if (downstream.readyState === WebSocket.OPEN || downstream.readyState === WebSocket.CONNECTING) downstream.close();
    };
    downstream.on("close", closePeer);
    downstream.on("error", closePeer);
    upstream.on("close", closePeer);
    upstream.on("error", closePeer);
  });

  return {
    url: `ws://127.0.0.1:${address.port}`,
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
