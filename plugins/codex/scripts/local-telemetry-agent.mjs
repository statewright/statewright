#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BindingLedger,
  createLocalTelemetryServer,
  LocalTelemetryService,
  telemetryIdentity,
} from "./lib/local-telemetry-agent.mjs";

const dataDir = process.env.STATEWRIGHT_TELEMETRY_DIR ||
  join(homedir(), ".statewright", "telemetry", "native-codex");
const pocketbaseUrl = process.env.STATEWRIGHT_PB_URL || "https://statewright.ai";
const apiKey = process.env.STATEWRIGHT_API_KEY || "";
const rawCaptureDestination = process.env.STATEWRIGHT_RAW_TOOL_CAPTURE_DESTINATION || "";
const codexSessionsDir = process.env.STATEWRIGHT_CODEX_SESSIONS_DIR ||
  join(homedir(), ".codex", "sessions");
const host = "127.0.0.1";
const port = Number(process.env.STATEWRIGHT_TELEMETRY_PORT || 4318);
const buildId = process.env.STATEWRIGHT_TELEMETRY_BUILD_ID ||
  createHash("sha256")
    .update(readFileSync(new URL(import.meta.url)))
    .update(readFileSync(new URL("./lib/local-telemetry-agent.mjs", import.meta.url)))
    .digest("hex")
    .slice(0, 16);

if (process.argv.includes("--bind-stdin")) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const binding = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result = new BindingLedger(join(dataDir, "bindings.jsonl")).append(binding);
  process.stdout.write(`${JSON.stringify({ accepted: result.duplicate ? 0 : 1 })}\n`);
  process.exit(0);
}

if (process.argv.includes("--identity")) {
  process.stdout.write(`${JSON.stringify(telemetryIdentity({
    pocketbaseUrl,
    apiKey,
    buildId,
    host,
    port,
    dataDir,
    rawCaptureDestination,
  }))}\n`);
  process.exit(0);
}

const service = new LocalTelemetryService({
  dataDir,
  pocketbaseUrl,
  apiKey,
  buildId,
  host,
  port,
  rawCaptureDestination,
  codexSessionsDir,
});
const listener = createLocalTelemetryServer(service, { host, port });

try {
  const address = await listener.listen();
  process.stderr.write(
    `[statewright] native Codex token telemetry listening on ${address.address}:${address.port}\n`,
  );
  await service.flush();
} catch (error) {
  if (error?.code !== "EADDRINUSE") {
    process.stderr.write(`[statewright] token telemetry agent failed: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
