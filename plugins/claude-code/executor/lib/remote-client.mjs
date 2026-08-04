import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_GATEWAY_ERROR_BYTES = 4 * 1024;

function sanitizeGatewayError(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/\bsw_(?:live|test)_[A-Za-z0-9_-]+\b/g, "sw_[redacted]")
    .slice(0, MAX_GATEWAY_ERROR_BYTES);
}

async function gatewayErrorDetail(response) {
  const raw = await response.text().catch(() => "");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.error === "string") return sanitizeGatewayError(parsed.error);
    if (typeof parsed?.error?.message === "string") {
      return sanitizeGatewayError(parsed.error.message);
    }
  } catch {}
  return sanitizeGatewayError(raw);
}

function gatewayEndpoint(value) {
  const base = value.replace(/\/+$/, "");
  return base.endsWith("/mcp") ? base : `${base}/mcp`;
}

export async function resolveApiKey(environment = process.env) {
  if (environment.STATEWRIGHT_API_KEY?.trim()) {
    return environment.STATEWRIGHT_API_KEY.trim();
  }
  return (await readFile(join(homedir(), ".statewright", "api_key"), "utf8")).trim();
}

export class RemoteStatewrightClient {
  constructor(options) {
    this.endpoint = gatewayEndpoint(options.gatewayUrl);
    this.gatewayOrigin = new URL(this.endpoint).origin;
    this.apiKey = options.apiKey;
    this.clientId = options.clientId;
    this.sessionId = options.sessionId;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.requestId = 1;
  }

  headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "X-Statewright-Client-Id": this.clientId,
      "Mcp-Session-Id": this.sessionId,
    };
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "statewright-executor", version: "0.1.0" },
    });
  }

  async call(name, args = {}) {
    const result = await this.request("tools/call", {
      name,
      arguments: args,
    });
    if (result?.isError) {
      const detail = result.content?.[0]?.text ?? `Statewright tool '${name}' failed.`;
      throw new Error(detail);
    }
    const text = result?.content?.[0]?.text;
    if (!text) return result ?? null;
    try {
      return JSON.parse(text);
    } catch {
      return { _raw: text };
    }
  }

  async request(method, params) {
    const response = await this.fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.requestId++,
        method,
        params,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = await gatewayErrorDetail(response);
      throw new Error(
        `Statewright gateway ${method} failed with HTTP ${response.status}`
        + `${detail ? `: ${detail}` : "."}`,
      );
    }
    const payload = await response.json();
    if (payload.error) {
      throw new Error(payload.error.message ?? JSON.stringify(payload.error));
    }
    return payload.result;
  }
}
