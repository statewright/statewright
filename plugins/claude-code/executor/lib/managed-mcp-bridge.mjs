import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { annotateToolsListResponse } from "./tool-annotations.mjs";
import { canonicalGateway } from "./gateway-profile.mjs";
import { normalizeMcpHttpResponse } from "./mcp-recovery.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const AGENT_RUN_TIMEOUT_MS = 300_000;

export function timeoutForManagedMcpRequest(body) {
  try {
    const request = JSON.parse(Buffer.from(body).toString("utf8"));
    if (request?.method === "tools/call" && request?.params?.name === "statewright_run_agent") {
      return AGENT_RUN_TIMEOUT_MS;
    }
  } catch {
    // The upstream gateway owns JSON-RPC validation; malformed requests keep
    // the short bridge timeout.
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

function authorized(request, token) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("managed MCP request exceeds 2 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export class ManagedMcpBridge {
  constructor({ gatewayUrl, apiKey, clientId, token = randomUUID(), fetch = globalThis.fetch, nativeUsage = null, projectUsage }) {
    if (nativeUsage && typeof projectUsage !== "function") throw new Error("Native usage requires a payload projector");
    this.gatewayUrl = canonicalGateway(gatewayUrl);
    this.apiKey = apiKey;
    this.clientId = clientId;
    this.token = token;
    this.fetch = fetch;
    this.server = null;
    this.url = null;
    this.nativeUsage = nativeUsage;
    this.projectUsage = projectUsage;
  }

  async start() {
    this.server = createServer(async (request, response) => {
      try {
        if (request.method !== "POST" || !["/mcp", ...(this.nativeUsage ? ["/native-usage"] : [])].includes(request.url)) {
          response.writeHead(404).end();
          return;
        }
        if (request.headers.origin || !authorized(request, this.token)) {
          response.writeHead(401).end();
          return;
        }
        // Token ownership is mandatory. An additional asserted client identity
        // must agree too; never route a foreign proxy using this owner's key.
        if (request.headers["x-statewright-client-id"]
            && request.headers["x-statewright-client-id"] !== this.clientId) {
          response.writeHead(403).end();
          return;
        }
        const body = await readBody(request);
        if (request.url === "/native-usage") {
          let event;
          try { event = this.projectUsage(JSON.parse(body.toString("utf8"))); }
          catch { response.writeHead(400).end(); return; }
          this.nativeUsage.outbox.appendUsage(event, event.binding);
          response.writeHead(202).end();
          void this.nativeUsage.flush().catch(() => {});
          return;
        }
        const forwardedHeaders = {
          "Content-Type": request.headers["content-type"] ?? "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "X-Statewright-Client-Id": this.clientId,
        };
        for (const name of ["accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
          if (request.headers[name]) forwardedHeaders[name] = request.headers[name];
        }
        const upstream = await this.fetch(this.gatewayUrl, {
          method: "POST",
          headers: forwardedHeaders,
          body,
          signal: AbortSignal.timeout(timeoutForManagedMcpRequest(body)),
        });
        const responseBody = await upstream.arrayBuffer();
        if (!upstream.ok) {
          const rpc = JSON.parse(body.toString("utf8"));
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(normalizeMcpHttpResponse(rpc, upstream.status, "", { catalog: false })));
          return;
        }
        const responseHeaders = {
          "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        };
        for (const name of ["mcp-session-id", "mcp-protocol-version", "last-event-id", "retry"]) {
          const value = upstream.headers.get(name);
          if (value) responseHeaders[name] = value;
        }
        response.writeHead(upstream.status, responseHeaders);
        response.end(upstream.ok
          ? annotateToolsListResponse(body, Buffer.from(responseBody), responseHeaders["Content-Type"])
          : Buffer.from(responseBody));
      } catch {
        response.writeHead(502, { "Content-Type": "application/json" });
        response.end('{"error":"Statewright managed MCP bridge unavailable."}\n');
      }
    });
    await new Promise((resolveStart, rejectStart) => {
      this.server.once("error", rejectStart);
      this.server.listen(0, "127.0.0.1", resolveStart);
    });
    const address = this.server.address();
    this.url = `http://127.0.0.1:${address.port}`;
    if (this.nativeUsage) {
      this.usageTimer = setInterval(() => { void this.nativeUsage.flush().catch(() => {}); }, 2_000);
      this.usageTimer.unref();
    }
    return this;
  }

  async close() {
    clearInterval(this.usageTimer);
    if (!this.server) return;
    await new Promise((resolveClose, rejectClose) => {
      this.server.close((error) => error ? rejectClose(error) : resolveClose());
    });
    this.server = null;
  }
}
