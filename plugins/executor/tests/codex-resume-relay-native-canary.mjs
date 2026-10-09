// Run in a PTY with CODEX_BIN set. No real thread, gateway, or model turn is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
const { prepareCodexResidentTui } = await import(process.env.STATEWRIGHT_CANARY_RELAY_MODULE ?? "../lib/codex-resume-relay.mjs");

assert.ok(process.stdin.isTTY, "native relay canary requires a PTY");
assert.ok(process.env.CODEX_BIN, "set CODEX_BIN to the native executable");
const threadId = "00000000-0000-4000-8000-000000000001";
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
const tui = await prepareCodexResidentTui({
  proxyUrl: `ws://127.0.0.1:${server.address().port}`,
  args: ["--yolo", "resume", threadId],
  yoloOverride: { sessionId: threadId, args: ["resume", threadId] },
});
let receipt = null;
server.on("connection", (peer, request) => {
  peer.on("message", data => {
    const message = JSON.parse(data.toString());
    receipt = { requestUrl: request.url, method: message.method, nativeRemote: tui.args[1] };
    peer.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Statewright relay canary: intentionally stopped before session initialization" } }));
  });
});
const child = spawn(process.env.CODEX_BIN, ["-c", "check_for_update_on_startup=false", ...tui.args], { stdio: "inherit", env: { ...process.env, LC_ALL: "C", TERM: "xterm-256color" } });
const timeout = setTimeout(() => child.kill("SIGTERM"), 15_000);
try {
  const [code, signal] = await once(child, "exit");
  assert.equal(signal, null, "native Codex must exit without timing out");
  assert.equal(code, 1, "the controlled initialize rejection must reach native Codex");
  assert.equal(receipt?.method, "initialize");
  assert.equal(receipt?.requestUrl, `/?statewright_resume_yolo_thread=${threadId}`);
  assert.match(receipt.nativeRemote, /^ws:\/\/127\.0\.0\.1:\d+$/);
  process.stdout.write(`\nNATIVE_RELAY_CANARY_PASS ${JSON.stringify(receipt)}\n`);
} finally {
  clearTimeout(timeout);
  await tui.close();
  for (const peer of server.clients) if (peer.readyState !== WebSocket.CLOSED) peer.terminate();
  await new Promise(resolve => server.close(resolve));
}
