import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { resolve } from "node:path";
import readline from "node:readline";

if (process.platform === "win32") {
  throw new Error("The Unix plugin gateway canary must run on a macOS or Linux runner.");
}

const plugin = process.argv[2];
const proxyByPlugin = {
  codex: "plugins/codex/mcp-proxy.sh",
  claude: "plugins/claude-code/mcp-proxy.sh",
  cursor: "plugins/cursor/mcp-proxy.sh",
};
const proxy = proxyByPlugin[plugin];
const apiKey = process.env.STATEWRIGHT_API_KEY?.trim();
const gatewayUrl = process.env.STATEWRIGHT_GATEWAY_URL?.trim();

if (!proxy) throw new Error("Usage: unix-plugin-live-gateway-canary.mjs <codex|claude|cursor>");
if (!apiKey || !gatewayUrl) {
  throw new Error("STATEWRIGHT_API_KEY and STATEWRIGHT_GATEWAY_URL are required for the live gateway canary.");
}

const child = spawn("bash", [resolve(proxy)], {
  env: {
    ...process.env,
    STATEWRIGHT_API_KEY: apiKey,
    STATEWRIGHT_GATEWAY_URL: gatewayUrl,
    STATEWRIGHT_CLIENT_ID: `swc_${randomUUID().replaceAll("-", "")}`,
    STATEWRIGHT_NO_UPDATE_CHECK: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
const lines = readline.createInterface({ input: child.stdout });
const pending = new Map();

lines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      request.resolve(message);
    }
  } catch {
    // Proxies should emit JSON-RPC responses. Ignore incidental diagnostics.
  }
});

function call(id, method, params) {
  return new Promise((resolveCall, rejectCall) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      rejectCall(new Error(`${plugin} proxy did not answer ${method} within 20 seconds.`));
    }, 20_000);
    pending.set(id, {
      resolve: (message) => {
        clearTimeout(timeout);
        resolveCall(message);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

try {
  const initialized = await call(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: `statewright-${plugin}-unix-canary`, version: "1" },
  });
  assert.equal(initialized.error, undefined, `${plugin} proxy rejected initialize.`);

  const status = await call(2, "tools/call", {
    name: "statewright_get_status",
    arguments: {},
  });
  assert.equal(status.error, undefined, `${plugin} proxy rejected statewright_get_status.`);
  assert.notEqual(status.result?.isError, true, `${plugin} gateway returned an error result.`);
  console.log(`${plugin} Unix authenticated plugin gateway canary passed.`);
} finally {
  lines.close();
  child.stdin.end();
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
  ]);
}
