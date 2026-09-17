import assert from "node:assert/strict";
import test from "node:test";
import { RemoteStatewrightClient, gatewayEndpoint } from "../lib/remote-client.mjs";

test("remote client preserves a bounded, redacted non-2xx gateway cause", async () => {
  const client = new RemoteStatewrightClient({
    gatewayUrl: "https://statewright.example",
    apiKey: "sw_live_private",
    clientId: "client-1",
    sessionId: "session-1",
    fetch: async () => new Response(JSON.stringify({
      error: { message: "upstream rejected Bearer secret-token and sw_live_private" },
    }), { status: 502, headers: { "Content-Type": "application/json" } }),
  });
  assert.equal(client.gatewayOrigin, "https://statewright.example");

  await assert.rejects(
    client.request("tools/call", { name: "statewright_get_state", arguments: {} }),
    new Error(
      "Statewright gateway tools/call failed with HTTP 502: "
      + "upstream rejected Bearer [redacted] and sw_[redacted]",
    ),
  );
});

test("remote initialization retains the authoritative session header for subsequent requests", async () => {
  const headers = [];
  const client = new RemoteStatewrightClient({ gatewayUrl: "http://127.0.0.1:9", apiKey: "private", clientId: "client",
    sessionId: "requested-branch", requireNegotiatedSessionId: true,
    fetch: async (_url, init) => { headers.push(init.headers); return new Response(JSON.stringify({ result: {} }),
      { headers: { "mcp-session-id": "canonical-branch" } }); } });
  await client.initialize();
  await client.call("statewright_get_state");
  assert.equal(headers[0]["Mcp-Session-Id"], "requested-branch");
  assert.equal(headers[1]["Mcp-Session-Id"], "canonical-branch");
});

test("resume refuses a changed or missing negotiated session before any tool call", async () => {
  for (const negotiated of [undefined, "foreign-session"]) {
    let calls = 0;
    const client = new RemoteStatewrightClient({ gatewayUrl: "http://127.0.0.1:9", apiKey: "private", clientId: "client",
      sessionId: "owned-session", expectedSessionId: "owned-session", requireNegotiatedSessionId: true,
      fetch: async () => { calls++; return new Response(JSON.stringify({ result: {} }),
        { headers: negotiated ? { "mcp-session-id": negotiated } : {} }); } });
    await assert.rejects(client.initialize(), /session identity|ownership identity/);
    assert.equal(calls, 1);
    assert.equal(client.sessionId, "owned-session");
  }
});

test("exact-run resume capability requires the advertised selector contract", async () => {
  for (const selector of [undefined, { type: "number" }, { type: "string" }, { type: "string", minLength: 1 }]) {
    const methods = [];
    const client = new RemoteStatewrightClient({ gatewayUrl: "http://127.0.0.1:9", apiKey: "private", clientId: "client",
      sessionId: "owned-session", fetch: async (_url, init) => {
        methods.push(JSON.parse(init.body).method);
        return new Response(JSON.stringify({ result: { tools: [{ name: "statewright_load_workflow",
          inputSchema: { properties: { ...(selector ? { run_id: selector } : {}) } } }] } }));
      } });
    assert.equal(await client.supportsExactRunResume(), selector?.minLength === 1);
    assert.deepEqual(methods, ["tools/list"]);
  }
});

test("continuation denies a changed authoritative session header", async () => {
  let request = 0;
  const client = new RemoteStatewrightClient({ gatewayUrl: "http://127.0.0.1:9", apiKey: "private", clientId: "client",
    sessionId: "owned-session", requireNegotiatedSessionId: true, fetch: async () => new Response(JSON.stringify({ result: {} }),
      { headers: { "mcp-session-id": ++request === 1 ? "owned-session" : "foreign-session" } }) });
  await client.initialize();
  await assert.rejects(client.call("statewright_get_state"), /continuation denied/);
});

test("gateway aliases share the exact transport endpoint and invalid identities deny", () => {
  for (const alias of ["http://LOCALHOST:80", "http://localhost/", "http://localhost/mcp/", "http://localhost/mcp"]) {
    assert.equal(gatewayEndpoint(alias), "http://localhost/mcp");
  }
  for (const foreign of ["file:///mcp", "https://user:password@example.test", "https://example.test?token=private", "https://example.test#foreign"]) {
    assert.throws(() => gatewayEndpoint(foreign), /Gateway identity/);
  }
});

test("a foreign-session inactive error cannot authorize durable resume", async () => {
  const client = new RemoteStatewrightClient({ gatewayUrl: "http://127.0.0.1:9", apiKey: "private", clientId: "client",
    sessionId: "owned-session", requireNegotiatedSessionId: true,
    fetch: async () => new Response(JSON.stringify({ error: { message: "No active workflow. Load a workflow before requesting state." } }),
      { headers: { "mcp-session-id": "foreign-session" } }) });
  await assert.rejects(client.call("statewright_get_state"), /ownership identity changed/);
});
