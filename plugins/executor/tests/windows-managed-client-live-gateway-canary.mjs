import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ManagedMcpBridge } from "../lib/managed-mcp-bridge.mjs";

if (process.platform !== "win32") {
  throw new Error("The Windows live gateway canary must run on a Windows runner.");
}

const apiKey = process.env.STATEWRIGHT_API_KEY?.trim();
const gatewayUrl = process.env.STATEWRIGHT_GATEWAY_URL?.trim();

if (!apiKey) {
  throw new Error("STATEWRIGHT_API_KEY is required for the authenticated Windows gateway canary.");
}
if (!gatewayUrl) {
  throw new Error("STATEWRIGHT_GATEWAY_URL is required for the authenticated Windows gateway canary.");
}

async function callMcp(bridge, token, id, method, params) {
  const response = await fetch(`${bridge.url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assert.equal(response.status, 200, `managed bridge returned HTTP ${response.status} for ${method}`);
  const payload = await response.json();
  assert.equal(payload.id, id, `managed bridge returned a mismatched response id for ${method}`);
  assert.equal(payload.error, undefined, `managed bridge rejected ${method}`);
  return payload.result;
}

const bridge = await new ManagedMcpBridge({
  gatewayUrl,
  apiKey,
  clientId: `swc_${randomUUID().replaceAll("-", "")}`,
}).start();

try {
  await callMcp(bridge, bridge.token, 1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "statewright-windows-canary", version: "1" },
  });
  await callMcp(bridge, bridge.token, 2, "tools/call", {
    name: "statewright_get_status",
    arguments: {},
  });
  console.log("Windows authenticated managed gateway canary passed.");
} finally {
  await bridge.close();
}
