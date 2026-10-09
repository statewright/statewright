import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";

// Native Codex accepts only a plain host:port remote address. Keep the
// connection-scoped resume intent on the resident-facing leg, never the CLI.
export async function prepareCodexResidentTui({ proxyUrl, args, yoloOverride }) {
  const relay = yoloOverride
    ? await startCodexResumeRelay({ proxyUrl, threadId: yoloOverride.sessionId })
    : null;
  return {
    // Prepend global options so a prompt after -- cannot swallow --remote.
    args: ["--remote", relay?.url ?? proxyUrl, ...(yoloOverride?.args ?? args)],
    close: () => relay?.close(),
  };
}

export async function startCodexResumeRelay({ proxyUrl, threadId, handshakeTimeoutMs = 5_000 }) {
  const upstreamUrl = new URL(proxyUrl);
  if (upstreamUrl.protocol !== "ws:" || upstreamUrl.hostname !== "127.0.0.1"
    || !upstreamUrl.port || upstreamUrl.username || upstreamUrl.password
    || upstreamUrl.search || upstreamUrl.hash || upstreamUrl.pathname !== "/") {
    throw new Error("Codex resume relay requires a plain loopback resident address.");
  }
  if (typeof threadId !== "string" || !threadId.trim() || threadId.length > 128) {
    throw new Error("Codex resume relay requires an exact thread ID.");
  }
  upstreamUrl.searchParams.set("statewright_resume_yolo_thread", threadId);
  const maxBytes = 100 * 1024 * 1024; // Match ws's default frame limit.
  const server = http.createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const sockets = new Set();
  const connections = new Set();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: maxBytes });
  let consumed = false;
  let closed = false;
  let closePromise;

  server.on("upgrade", (request, socket, head) => {
    // A browser must not acquire the launcher's explicit permission intent.
    // The listener is single-use, including after a frontend disconnects.
    if (closed || consumed || request.headers.origin !== undefined || request.url !== "/") {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    consumed = true;
    websocketServer.handleUpgrade(request, socket, head, (downstream) => {
      const upstream = new WebSocket(upstreamUrl, { handshakeTimeout: handshakeTimeoutMs, maxPayload: maxBytes });
      sockets.add(downstream);
      sockets.add(upstream);
      let pending = [];
      let pendingBytes = 0;
      const stop = () => {
        pending = [];
        pendingBytes = 0;
        for (const peer of [downstream, upstream]) {
          if (peer.readyState !== WebSocket.CLOSED) peer.terminate();
        }
      };
      const send = (target, data, binary) => {
        if (target.readyState !== WebSocket.OPEN || target.bufferedAmount + data.length > maxBytes) {
          stop();
          return;
        }
        target.send(data, { binary }, (error) => { if (error) stop(); });
      };
      for (const peer of [downstream, upstream]) {
        peer.on("error", stop);
        peer.on("close", () => { sockets.delete(peer); stop(); });
      }
      downstream.on("message", (data, binary) => {
        if (upstream.readyState === WebSocket.CONNECTING) {
          if (pendingBytes + data.length > maxBytes || pending.length >= 256) return stop();
          pending.push([data, binary]);
          pendingBytes += data.length;
        } else send(upstream, data, binary);
      });
      upstream.on("open", () => {
        const queued = pending;
        pending = [];
        pendingBytes = 0;
        for (const [data, binary] of queued) send(upstream, data, binary);
      });
      upstream.on("message", (data, binary) => send(downstream, data, binary));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    close() {
      if (!closePromise) {
        closed = true;
        closePromise = new Promise((resolve) => {
          for (const peer of sockets) peer.terminate();
          websocketServer.close();
          server.close(resolve);
          // HTTP closeAllConnections excludes upgraded sockets, including a
          // rejected upgrade whose client keeps its TCP write half open.
          for (const socket of connections) socket.destroy();
        });
      }
      return closePromise;
    },
  };
}
