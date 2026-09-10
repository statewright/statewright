import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  ENCRYPTED_COMPACTION_HANDOFF,
  startCodexResponsesCompatibilityProxy,
  translateFunctionToolNames,
  translateUnsupportedCompactionItems,
} from "../lib/codex-responses-compat-proxy.mjs";

test("encrypted compaction becomes an explicit provider handoff without dropping retained history", () => {
  const before = { type: "message", role: "user", content: [{ type: "input_text", text: "before" }] };
  const after = { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] };
  const result = translateUnsupportedCompactionItems({
    model: "qwen3.8-27b",
    input: [before, { type: "compaction", encrypted_content: "opaque" }, after],
  });
  assert.equal(result.translated, 1);
  assert.equal(result.payload.input.length, 3);
  assert.equal(result.payload.input[0], before);
  assert.equal(result.payload.input[2], after);
  assert.deepEqual(result.payload.input[1], {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: ENCRYPTED_COMPACTION_HANDOFF }],
  });
  assert.equal(result.payload.input.some((item) => item.type === "compaction"), false);
});

test("long function names round-trip through deterministic provider-safe wire names", () => {
  const originalName = "mcp__provider__" + "long_tool_name_".repeat(6);
  const result = translateFunctionToolNames({
    tools: [{ type: "function", name: originalName }, { type: "function", name: "short_tool" }],
    input: [{ type: "function_call", name: originalName, call_id: "call-1", arguments: "{}" }],
  });
  const wireName = result.payload.tools[0].name;
  assert.equal(result.renamed, 1);
  assert.match(wireName, /^[A-Za-z0-9_-]{1,64}$/);
  assert.notEqual(wireName, originalName);
  assert.equal(result.payload.input[0].name, wireName);
  assert.equal(result.payload.tools[1].name, "short_tool");
  assert.equal(result.reverseNames.get(wireName), originalName);
});

test("Responses compatibility proxy preserves auth and streams the translated request", async () => {
  let observed;
  const originalToolName = "mcp__provider__" + "very_long_tool_name_".repeat(5);
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = {
      authorization: request.headers.authorization,
      url: request.url,
      payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    const wireToolName = observed.payload.tools[0].name;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
    response.end(`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", name: wireToolName } })}\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  const translations = [];
  const proxy = await startCodexResponsesCompatibilityProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    onTranslation: async (event) => translations.push(event),
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/responses?beta=true`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({
        input: [{ type: "compaction", encrypted_content: "opaque" }],
        tools: [{ type: "function", name: originalToolName }],
      }),
    });
    assert.equal(response.status, 200);
    const responseBody = await response.text();
    assert.match(responseBody, /data: first/);
    assert.match(responseBody, new RegExp(originalToolName));
    assert.equal(observed.authorization, "Bearer secret");
    assert.equal(observed.url, "/v1/responses?beta=true");
    assert.equal(observed.payload.input[0].type, "message");
    assert.deepEqual(translations, [{ translated: 1, renamedTools: 1 }]);
  } finally {
    await proxy.close();
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
