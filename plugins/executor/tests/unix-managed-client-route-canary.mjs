import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runManagedClient } from "../lib/managed-client-supervisor.mjs";

if (process.platform === "win32") {
  console.log("SKIP: Unix managed-client route canary; Windows coverage runs windows-managed-client-route-canary.mjs.");
  process.exit(0);
}

async function waitFor(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function bridgeFactory() {
  let number = 0;
  return () => {
    number += 1;
    return {
      url: `http://127.0.0.1:${9400 + number}`,
      token: `unix-route-canary-${number}`,
      async start() { return this; },
      async close() {},
    };
  };
}

const root = await mkdtemp(join(tmpdir(), "statewright-unix-managed-route-"));
const primaryHome = join(root, "primary-home");
const peerHome = join(root, "peer-home");
const primary = join(root, "primary-codex.mjs");
const peer = join(root, "peer-codex.mjs");
const primaryCalls = join(root, "primary-calls.jsonl");
const peerCalls = join(root, "peer-calls.jsonl");
const peerReady = join(root, "peer-ready");
const routeCompleted = join(root, "primary-route-complete");

try {
  await writeFile(primary, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const control = process.env.STATEWRIGHT_ROUTE_CONTROL_DIR;
const calls = ${JSON.stringify(primaryCalls)};
const invocation = {
  args: process.argv.slice(2),
  client_id: process.env.STATEWRIGHT_CLIENT_ID,
  bridge_url: process.env.STATEWRIGHT_MANAGED_MCP_URL,
  control_dir: control,
};
const currentRoute = join(control, "current.route.json");
if (existsSync(currentRoute)) invocation.route = JSON.parse(readFileSync(currentRoute, "utf8"));
appendFileSync(calls, JSON.stringify(invocation) + "\\n");
const mediumMarker = join(control, "medium-route-written");
const highMarker = join(control, "high-route-written");
if (!existsSync(mediumMarker)) {
  writeFileSync(mediumMarker, "");
  writeFileSync(join(control, "codex-root-session.json"), JSON.stringify({
    version: 1, session_id: "managed-route-canary-thread", client_id: process.env.STATEWRIGHT_CLIENT_ID,
  }));
  writeFileSync(join(control, "current.route.json"), JSON.stringify({
    session_id: "managed-route-canary-thread",
    root_session_id: "managed-route-canary-thread",
    client_id: process.env.STATEWRIGHT_CLIENT_ID,
    run_id: "managed-route-canary-run",
    state: "localize",
    model: "openai-codex/gpt-5.6-terra",
    effort: "medium",
  }));
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (!existsSync(highMarker)) {
  writeFileSync(highMarker, "");
  writeFileSync(join(control, "current.route.json"), JSON.stringify({
    session_id: "managed-route-canary-thread",
    root_session_id: "managed-route-canary-thread",
    client_id: process.env.STATEWRIGHT_CLIENT_ID,
    run_id: "managed-route-canary-run",
    state: "decision",
    model: "openai-codex/gpt-5.6-sol",
    effort: "high",
  }));
  const routeDeadline = setTimeout(() => process.exit(4), 5_000);
  process.on("SIGINT", () => {
    clearTimeout(routeDeadline);
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else {
  writeFileSync(${JSON.stringify(routeCompleted)}, "");
}
`);
  await writeFile(peer, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(peerCalls)}, JSON.stringify({
  args: process.argv.slice(2),
  client_id: process.env.STATEWRIGHT_CLIENT_ID,
  bridge_url: process.env.STATEWRIGHT_MANAGED_MCP_URL,
  control_dir: process.env.STATEWRIGHT_ROUTE_CONTROL_DIR,
}) + "\\n");
writeFileSync(${JSON.stringify(peerReady)}, "");
const completed = ${JSON.stringify(routeCompleted)};
const deadline = Date.now() + 5_000;
setInterval(() => {
  if (existsSync(completed)) process.exit(0);
  if (Date.now() >= deadline) process.exit(3);
}, 5);
`);
  await Promise.all([chmod(primary, 0o755), chmod(peer, 0o755)]);
  const makeBridge = bridgeFactory();
  const environment = { PATH: process.env.PATH, STATEWRIGHT_API_KEY: "test", STATEWRIGHT_SENTRY_DISABLED: "true" };
  const peerResultPromise = runManagedClient({
    host: "codex", command: peer,
    args: ["-m", "gpt-5.6-terra", "-c", 'model_reasoning_effort="medium"', "--full-auto"],
    environment, home: peerHome, cwd: root, pollMs: 5, bridgeFactory: makeBridge,
  });
  await waitFor(peerReady);
  const primaryResult = await runManagedClient({
    host: "codex", command: primary,
    args: ["-m", "gpt-5.6-terra", "-c", 'model_reasoning_effort="low"', "--full-auto"],
    environment, home: primaryHome, cwd: root, pollMs: 5, bridgeFactory: makeBridge,
  });
  const peerResult = await peerResultPromise;
  assert.equal(primaryResult, 0);
  assert.equal(peerResult, 0);
  const primaryInvocations = (await readFile(primaryCalls, "utf8")).trim().split("\n").map(JSON.parse);
  const peerInvocations = (await readFile(peerCalls, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(primaryInvocations.length, 3, "primary managed client must consume both same-file route receipts");
  assert.deepEqual(primaryInvocations[0].args.slice(0, 5), ["-m", "gpt-5.6-terra", "-c", 'model_reasoning_effort="low"', "--full-auto"]);
  assert.deepEqual(primaryInvocations[1].args.slice(0, 8), ["-m", "gpt-5.6-terra", "-c", 'model_provider="openai"', "-c", 'model_reasoning_effort="medium"', "--full-auto", "resume"]);
  assert.deepEqual(primaryInvocations[2].args.slice(0, 8), ["-m", "gpt-5.6-sol", "-c", 'model_provider="openai"', "-c", 'model_reasoning_effort="high"', "--full-auto", "resume"]);
  assert.equal(primaryInvocations[1].args[8], "managed-route-canary-thread");
  assert.equal(primaryInvocations[2].args[8], "managed-route-canary-thread");
  assert.equal(primaryInvocations[1].route.run_id, "managed-route-canary-run");
  assert.equal(primaryInvocations[1].route.state, "localize");
  assert.equal(primaryInvocations[2].route.run_id, "managed-route-canary-run");
  assert.equal(primaryInvocations[2].route.state, "decision");
  for (const invocation of primaryInvocations.slice(1)) {
    assert.equal(primaryInvocations[0].client_id, invocation.client_id, "the routed child must retain the managed identity");
    assert.equal(primaryInvocations[0].bridge_url, invocation.bridge_url, "the routed child must retain the bridge");
    assert.equal(primaryInvocations[0].control_dir, invocation.control_dir, "the routed child must retain its control boundary");
  }
  assert.equal(peerInvocations.length, 1, "the peer terminal must not be restarted by the primary route");
  assert.notEqual(peerInvocations[0].client_id, primaryInvocations[0].client_id, "peer terminal must own a distinct managed identity");
  assert.notEqual(peerInvocations[0].bridge_url, primaryInvocations[0].bridge_url, "peer terminal must own a distinct bridge");
  assert.notEqual(peerInvocations[0].control_dir, primaryInvocations[0].control_dir, "peer terminal must own a distinct control boundary");
  console.log("Unix managed route control canary passed: bootstrap -> Terra/medium -> Sol/high with isolated peer terminal.");
  console.log("This is a local supervisor-control proof; a signed-in gateway canary must separately attest statewright_get_state run continuity.");
} finally {
  await rm(root, { recursive: true, force: true });
}
