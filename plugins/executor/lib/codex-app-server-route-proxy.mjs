import { WebSocket, WebSocketServer } from "ws";
import { createServer } from "node:http";

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

export function applyCompactResumeRequest(message, enabled = true) {
  if (!enabled || message?.method !== "thread/resume") return message;
  const params = { ...(message.params ?? {}), excludeTurns: true };
  // A TUI-provided first page would defeat metadata-only resume. The native
  // client can request historical pages explicitly when it actually needs one.
  delete params.initialTurnsPage;
  return { ...message, params };
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
  onConnection = async () => {},
  onTransportError = async () => {},
  compactResume = true,
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
  const receipts = new Map();
  const requestMethods = new Map();
  const listening = new Promise((resolveListening, rejectListening) => {
    healthServer.once("listening", resolveListening);
    healthServer.once("error", rejectListening);
  });
  healthServer.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a Statewright App Server route proxy port.");

  server.on("connection", (downstream) => {
    const upstream = new WebSocket(upstreamUrl);
    void onConnection({ upstreamUrl });
    downstream.on("message", async (raw) => {
      let payload = String(raw);
      try {
        let message = JSON.parse(payload);
        void onConnection({ direction: "native_to_upstream", method: message.method ?? null });
        if (message.id !== undefined && message.method) requestMethods.set(String(message.id), message.method);
        const compacted = compactResume && message.method === "thread/resume";
        message = applyCompactResumeRequest(message, compactResume);
        payload = JSON.stringify(message);
        if (compacted) void onConnection({ direction: "native_to_upstream", method: "thread/resume [history omitted]" });
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
      let payload = String(raw);
      try {
        const notification = JSON.parse(payload);
        const responseTo = notification.id !== undefined ? requestMethods.get(String(notification.id)) : null;
        if (responseTo) requestMethods.delete(String(notification.id));
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
      } catch {
        // Protocol traffic is still forwarded; receipt telemetry must never
        // interfere with a native Codex session.
      }
      // App Server WebSocket mode specifies one JSON-RPC text frame per
      // message. `ws` exposes received text as a Buffer by default; sending
      // that buffer would silently convert it into a binary frame, which the
      // native Codex TUI rejects during its initialize handshake.
      forwardWhenOpen(downstream, payload);
    });
    const closePeer = () => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
      if (downstream.readyState === WebSocket.OPEN || downstream.readyState === WebSocket.CONNECTING) downstream.close();
    };
    downstream.on("close", (code, reason) => {
      void onTransportError({ side: "native_close", message: `${code} ${String(reason)}`.trim() });
      closePeer();
    });
    downstream.on("error", (error) => {
      void onTransportError({ side: "native", message: error.message });
      closePeer();
    });
    upstream.on("close", (code, reason) => {
      void onTransportError({ side: "upstream_close", message: `${code} ${String(reason)}`.trim() });
      closePeer();
    });
    upstream.on("error", (error) => {
      void onTransportError({ side: "upstream", message: error.message });
      closePeer();
    });
  });

  return {
    url: `ws://127.0.0.1:${address.port}`,
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise((resolveClose) => server.close(() => healthServer.close(() => resolveClose())));
    },
  };
}
