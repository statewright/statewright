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

test("managed MCP bridge preserves SSE and renders typed upstream HTTP failures", async () => {
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
    assert.equal(failure.status, 200); // bridge transport succeeded; upstream did not
    const failed = await failure.json();
    assert.equal(failed.error.data.httpStatus, 500);
    assert.equal(failed.error.data.kind, "http_error");
    assert.equal(failed.error.data.retryAllowed, false);
  } finally {
    await bridge.close();
  }
});

test("two simultaneous bridge owners isolate gateway, client, token and session; one retirement cannot reroute the other", async () => {
  const received = [];
  const make = async label => new ManagedMcpBridge({ gatewayUrl: `https://${label}.example/mcp`, apiKey: `${label}-key`, clientId: label, token: `${label}-token`,
    fetch: async (url, options) => {
      received.push({ label, url, key: options.headers.Authorization, client: options.headers["X-Statewright-Client-Id"], session: options.headers["mcp-session-id"] });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { owner: label } }), { headers: { "content-type": "application/json" } });
    } }).start();
  const a = await make("a"), b = await make("b");
  const invoke = (bridge, label, token = `${label}-token`, client = label) => fetch(`${bridge.url}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Statewright-Client-Id": client, "Mcp-Session-Id": `${label}-session` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }) });
  try {
    const results = await Promise.all([invoke(a, "a"), invoke(b, "b")]);
    assert.deepEqual(await Promise.all(results.map(r => r.json())), ["a", "b"].map(owner => ({ jsonrpc: "2.0", id: 1, result: { owner } })));
    assert.equal((await invoke(b, "b", "a-token")).status, 401);
    assert.equal((await invoke(b, "b", "b-token", "a")).status, 403);
    await a.close();
    assert.equal((await (await invoke(b, "b")).json()).result.owner, "b");
    assert.deepEqual(received.map(x => x.label).sort(), ["a", "b", "b"]);
    for (const x of received) assert.deepEqual(x, { label: x.label, url: `https://${x.label}.example/mcp`, key: `Bearer ${x.label}-key`, client: x.label, session: `${x.label}-session` });
  } finally { await a.close(); await b.close(); }
});

test("managed gateway authentication failure is typed, distinct from bridge authorization, and never replayed", async () => {
  let count = 0;
  const bridge = await new ManagedMcpBridge({ gatewayUrl: "https://a.example", apiKey: "fixture", clientId: "a", token: "token",
    fetch: async () => { count++; return new Response('Bearer private-fixture', { status: 401 }); } }).start();
  try {
    const response = await fetch(`${bridge.url}/mcp`, { method: "POST", headers: { Authorization: "Bearer token" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}' });
    const result = await response.json();
    assert.equal(result.error.data.kind, "authentication_required");
    assert.equal(result.error.data.recoveryTool, "statewright_connect");
    assert.doesNotMatch(JSON.stringify(result), /private-fixture/);
    assert.equal(count, 1);
  } finally { await bridge.close(); }
});

test("reconnected bridge rotates capability without reviving the retired owner's token", async () => {
  let count = 0;
  const options = { gatewayUrl: "https://a.example/mcp", apiKey: "fixture", clientId: "owner", fetch: async () => {
    count++;
    return new Response('{"jsonrpc":"2.0","id":1,"result":{}}');
  } };
  const old = await new ManagedMcpBridge(options).start();
  const oldToken = old.token;
  await old.close();
  const current = await new ManagedMcpBridge(options).start();
  try {
    assert.notEqual(current.token, oldToken);
    const invoke = token => fetch(`${current.url}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Statewright-Client-Id": "owner" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal((await invoke(oldToken)).status, 401);
    assert.equal((await invoke(current.token)).status, 200);
    assert.equal(count, 1);
  } finally { await current.close(); }
});
