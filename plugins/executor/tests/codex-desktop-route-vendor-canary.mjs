import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runDesktopAppServerBroker } from "../lib/codex-desktop-app-server-launcher.mjs";

// Opt-in because this uses the signed-in vendor Desktop App Server and starts
// one harmless, read-only route canary turn. It never patches ChatGPT.app.
if (process.env.STATEWRIGHT_DESKTOP_ROUTE_CANARY !== "1") {
  console.log("SKIP: set STATEWRIGHT_DESKTOP_ROUTE_CANARY=1 to run the signed-in Desktop route canary.");
  process.exit(0);
}

const clientId = `swc_${"0123456789abcdef0123456789abcdef"}`;
const desktopCodex = process.env.STATEWRIGHT_DESKTOP_CODEX_BIN ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
const home = await mkdtemp(join(tmpdir(), "statewright-desktop-route-"));
const stdin = new PassThrough();
const stdout = new PassThrough();
const stderr = new PassThrough();
let output = "";
let errors = "";
let requestId = 0;
const frames = [];
let broker;
let passedThreadId = null;

stdout.on("data", chunk => {
  output += String(chunk);
  for (;;) {
    const boundary = output.indexOf("\n");
    if (boundary < 0) return;
    const line = output.slice(0, boundary).trim();
    output = output.slice(boundary + 1);
    if (!line) continue;
    try { frames.push(JSON.parse(line)); } catch { /* native output is JSON-RPC only */ }
  }
});
stderr.on("data", chunk => { errors += String(chunk); });

async function waitFor(predicate, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = frames.find(predicate);
    if (frame) return frame;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Desktop route canary timed out. Broker stderr: ${errors}`);
}

async function waitForFresh(predicate, startAt, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = frames.slice(startAt).find(predicate);
    if (frame) return frame;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Desktop route canary timed out. Broker stderr: ${errors}`);
}

async function waitForStderr(pattern, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(errors)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Desktop route canary never reported route injection. Broker stderr: ${errors}`);
}

async function rpc(method, params = {}) {
  const id = ++requestId;
  stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  const frame = await waitFor(value => value.id === id);
  if (frame.error) throw new Error(`${method}: ${frame.error.message}`);
  return frame.result;
}

try {
  broker = await runDesktopAppServerBroker({
    argv: ["app-server"], stdin, stdout, stderr, home,
    environment: {
      ...process.env,
      STATEWRIGHT_DESKTOP_ORIGINAL_CODEX: desktopCodex,
      STATEWRIGHT_DESKTOP_CLIENT_ID: clientId,
    },
  });
  await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: { experimentalApi: true },
    clientInfo: { name: "statewright-desktop-route-canary", version: "1" },
  });
  stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  const started = await rpc("thread/start", { approvalPolicy: "never", sandbox: "read-only" });
  const threadId = started.thread?.id;
  assert.ok(threadId, "native Desktop App Server returned no thread id");
  const controlDir = join(home, ".statewright", "codex-desktop-app-server", clientId, "routes");
  await writeFile(join(controlDir, "current.route.json"), `${JSON.stringify({
    session_id: threadId, root_session_id: threadId, client_id: clientId,
    run_id: "desktop-route-canary", state: "validate",
    model: "openai-codex/gpt-5.6-terra", effort: "low",
  })}\n`);
  const startAt = frames.length;
  await rpc("turn/start", {
    threadId, input: [{ type: "text", text: "Reply exactly ROUTE_CANARY_OK." }],
    // Desktop gives nested settings precedence. Start deliberately opposite
    // the route so a receipt proves both top-level and nested replacement.
    model: "gpt-5.6-sol", effort: "high",
    collaborationMode: { mode: "default", settings: { model: "gpt-5.6-sol", reasoning_effort: "high" } },
  });
  await waitForStderr(/injected next-turn route gpt-5\.6-terra \(low\)/);
  const receipt = await waitForFresh(value => value.method === "thread/settings/updated" && value.params?.threadId === threadId, startAt);
  assert.equal(receipt.params.threadSettings?.model, "gpt-5.6-terra");
  assert.equal(receipt.params.threadSettings?.effort, "low");
  assert.equal(receipt.params.threadSettings?.collaborationMode?.settings?.model, "gpt-5.6-terra");
  assert.equal(receipt.params.threadSettings?.collaborationMode?.settings?.reasoning_effort, "low");
  await waitForFresh(value => value.method === "turn/completed" && value.params?.threadId === threadId, startAt);
  passedThreadId = threadId;
} finally {
  stdin.end();
  await broker?.close();
  await rm(home, { recursive: true, force: true });
}

console.log(`PASS: Desktop broker applied nested gpt-5.6-terra/low to ${passedThreadId} and shut down cleanly.`);
