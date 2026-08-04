import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

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
  constructor({ gatewayUrl, apiKey, clientId, token = randomUUID(), fetch = globalThis.fetch }) {
    this.gatewayUrl = gatewayUrl.replace(/\/+$/, "") || gatewayUrl;
    this.apiKey = apiKey;
    this.clientId = clientId;
    this.token = token;
    this.fetch = fetch;
    this.server = null;
    this.url = null;
  }

  async start() {
    this.server = createServer(async (request, response) => {
      try {
        if (request.method !== "POST" || request.url !== "/mcp") {
          response.writeHead(404).end();
          return;
        }
        if (!authorized(request, this.token)) {
          response.writeHead(401).end();
          return;
        }
        const body = await readBody(request);
        const upstream = await this.fetch(this.gatewayUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "X-Statewright-Client-Id": this.clientId,
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        const responseBody = await upstream.arrayBuffer();
        response.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        });
        response.end(Buffer.from(responseBody));
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
    return this;
  }

  async close() {
    if (!this.server) return;
    await new Promise((resolveClose, rejectClose) => {
      this.server.close((error) => error ? rejectClose(error) : resolveClose());
    });
    this.server = null;
  }
}
