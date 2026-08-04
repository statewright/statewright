import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { ManagedMcpBridge } from "../lib/managed-mcp-bridge.mjs";

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", resolveStart);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

test("managed MCP bridge forwards one immutable client identity", async () => {
  let receivedIdentity = null;
  const upstream = await startServer(async (request, response) => {
    receivedIdentity = request.headers["x-statewright-client-id"];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"jsonrpc":"2.0","result":{"ok":true},"id":1}\n');
  });
  const bridge = await new ManagedMcpBridge({
    gatewayUrl: upstream.url,
    apiKey: "test-key",
    clientId: "swc_0123456789abcdef0123456789abcdef",
    token: "bridge-token",
  }).start();
  try {
    const response = await fetch(`${bridge.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer bridge-token" },
      body: '{"jsonrpc":"2.0","method":"tools/call","id":1}',
    });
    assert.equal(response.status, 200);
    assert.equal(receivedIdentity, "swc_0123456789abcdef0123456789abcdef");
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("managed MCP bridge rejects a caller without its supervisor token", async () => {
  const upstream = await startServer((_request, response) => response.writeHead(500).end());
  const bridge = await new ManagedMcpBridge({
    gatewayUrl: upstream.url,
    apiKey: "test-key",
    clientId: "swc_0123456789abcdef0123456789abcdef",
    token: "bridge-token",
  }).start();
  try {
    const response = await fetch(`${bridge.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
      body: "{}",
    });
    assert.equal(response.status, 401);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});
