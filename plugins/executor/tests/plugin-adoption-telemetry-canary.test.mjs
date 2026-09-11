import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCanaryEvent,
  resolvePluginVersion,
  submitCanaryEvent,
} from "./plugin-adoption-telemetry-canary.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("adoption telemetry canary resolves the exercised plugin version", async () => {
  assert.equal(await resolvePluginVersion(repositoryRoot, "codex"), "0.3.3");
  assert.equal(await resolvePluginVersion(repositoryRoot, "pi"), "0.3.0");
});

test("adoption telemetry canary emits a bounded attributable event without exposing the key", () => {
  const event = buildCanaryEvent({
    plugin: "claude",
    apiKey: "sw_live_secret",
    version: "0.3.1",
    platform: "ubuntu-24.04",
    runId: "123456789",
    runAttempt: "2",
  });
  assert.deepEqual(event, {
    plugin: "claude-code",
    event: "ci_canary",
    version: "0.3.1",
    api_key: "sw_live_secret",
    platform: "github-ubuntu-24.04-123456789-2",
  });
  assert.doesNotMatch(JSON.stringify({ ...event, api_key: "[redacted]" }), /sw_live_secret/);
});

test("adoption telemetry canary requires an explicit endpoint acknowledgement", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, latest_version: "0.3.1" }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const event = buildCanaryEvent({
      plugin: "codex",
      apiKey: "sw_live_secret",
      version: "0.3.1",
      platform: "macos-14",
      runId: "run-1",
      runAttempt: "1",
    });
    const acknowledgement = await submitCanaryEvent({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      event,
    });
    assert.equal(acknowledgement.ok, true);
    assert.equal(requests[0].url, "/api/telemetry/plugin-event");
    assert.equal(requests[0].body.api_key, "sw_live_secret");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("adoption telemetry canary rejects an ambiguous success response", async () => {
  await assert.rejects(
    submitCanaryEvent({
      baseUrl: "https://statewright.invalid",
      event: { plugin: "pi", event: "ci_canary" },
      fetchImpl: async () => new Response(JSON.stringify({ latest_version: "0.3.0" }), { status: 200 }),
    }),
    /acknowledge the event/,
  );
});
