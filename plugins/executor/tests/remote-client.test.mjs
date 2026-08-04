import assert from "node:assert/strict";
import test from "node:test";
import { RemoteStatewrightClient } from "../lib/remote-client.mjs";

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
