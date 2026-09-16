import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { ManagedMcpBridge, timeoutForManagedMcpRequest } from "../lib/managed-mcp-bridge.mjs";

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

test("managed MCP bridge reserves a bounded long timeout only for delegated agent runs", () => {
  assert.equal(timeoutForManagedMcpRequest(Buffer.from('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_run_agent"}}')), 300_000);
  assert.equal(timeoutForManagedMcpRequest(Buffer.from('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state"}}')), 15_000);
  assert.equal(timeoutForManagedMcpRequest(Buffer.from("not json")), 15_000);
});

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

test("managed MCP bridge annotates successful JSON tool lists without changing SSE or failures", async () => {
  const payload = '{ "jsonrpc":"2.0", "result":{"tools":[{"name":"statewright_get_usage"},{"name":"statewright_transition"}]}, "id":1 }\n';
  let contentType = "application/json";
  let status = 200;
  const bridge = await new ManagedMcpBridge({
    gatewayUrl: "https://gateway.example/mcp", apiKey: "test-key", clientId: "test-client", token: "bridge-token",
    fetch: async () => new Response(payload, { status, headers: { "content-type": contentType, "mcp-session-id": "session-1" } }),
  }).start();
  const call = () => fetch(`${bridge.url}/mcp`, {
    method: "POST", headers: { Authorization: "Bearer bridge-token" },
    body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
  });
  try {
    const response = await call();
    assert.equal(response.headers.get("mcp-session-id"), "session-1");
    const { result } = await response.json();
    assert.deepEqual(result.tools[0].annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    assert.equal(result.tools[1].annotations, undefined);
    contentType = "text/event-stream";
    assert.equal(await (await call()).text(), payload);
    contentType = "application/json";
    status = 500;
    const failure = await call();
    assert.equal(failure.status, 500);
    assert.equal(await failure.text(), payload);
  } finally {
    await bridge.close();
  }
});
