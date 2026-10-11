import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { prepareCodexResidentTui, startCodexResumeRelay } from "../lib/codex-resume-relay.mjs";
import { codexYoloResumeOverride } from "../lib/managed-client-supervisor.mjs";

async function fixture(t, { delay = 0 } = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    setTimeout(() => wss.handleUpgrade(request, socket, head,
      peer => wss.emit("connection", peer, request)), delay);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const peer of wss.clients) peer.terminate();
    wss.close();
    await new Promise(resolve => server.close(resolve));
  });
  return { wss, url: `ws://127.0.0.1:${server.address().port}` };
}

test("native arguments stay query-free and preserve prompts and ordinary resumes", async (t) => {
  const { url } = await fixture(t);
  for (const flag of ["--yolo", "--dangerously-bypass-approvals-and-sandbox"]) {
    const args = [flag, "resume", "thread-1", "--", "--yolo"];
    const tui = await prepareCodexResidentTui({ proxyUrl: url, args, yoloOverride: codexYoloResumeOverride("codex", args) });
    t.after(() => tui.close());
    assert.match(tui.args[1], /^ws:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(tui.args.slice(2), ["resume", "thread-1", "--", "--yolo"]);
    assert.equal(tui.args[0], "--remote");
  }
  const ordinary = await prepareCodexResidentTui({ proxyUrl: url, args: ["resume", "thread-1"] });
  assert.deepEqual(ordinary.args, ["--remote", url, "resume", "thread-1"]);
  await ordinary.close();
});

test("relay binds exact intent upstream and preserves ordered text and binary frames", { timeout: 5_000 }, async (t) => {
  const { wss, url } = await fixture(t, { delay: 40 });
  const relay = await startCodexResumeRelay({ proxyUrl: url, threadId: "thread-1" });
  t.after(() => relay.close());
  const upstreamConnection = once(wss, "connection");
  const client = new WebSocket(relay.url);
  client.on("error", () => {});
  t.after(() => client.terminate());
  await once(client, "open");
  const received = [];
  const echoed = [];
  const roundtrip = new Promise(resolve => client.on("message", (data, binary) => {
    echoed.push([data.toString(), binary]);
    if (echoed.length === 3) resolve();
  }));
  client.send("first");
  client.send(Buffer.from("second"));
  client.send("third");
  const [peer, request] = await upstreamConnection;
  assert.equal(request.url, "/?statewright_resume_yolo_thread=thread-1");
  peer.on("message", (data, binary) => {
    received.push([data.toString(), binary]);
    peer.send(data, { binary });
  });
  await roundtrip;
  assert.deepEqual(received, [["first", false], ["second", true], ["third", false]]);
  assert.deepEqual(echoed, received);
  const peerClosed = once(peer, "close");
  await relay.close();
  await peerClosed;
  await relay.close(); // Idempotent, and the resident listener remains alive.
  const independent = new WebSocket(url);
  await once(independent, "open");
  independent.terminate();
});

test("browser origins and altered endpoint paths cannot claim a relay", { timeout: 5_000 }, async (t) => {
  const { url } = await fixture(t);
  const relay = await startCodexResumeRelay({ proxyUrl: url, threadId: "thread-1" });
  t.after(() => relay.close());
  for (const [suffix, options] of [["", { origin: "https://untrusted.example" }], ["/?thread=other", {}]]) {
    const rejected = new WebSocket(`${relay.url}${suffix}`, options);
    const [error] = await once(rejected, "error");
    assert.match(error.message, /403/);
  }
  const client = new WebSocket(relay.url);
  client.on("error", () => {});
  await once(client, "open");
  const second = new WebSocket(relay.url);
  assert.match((await once(second, "error"))[0].message, /403/);
  const closed = once(client, "close");
  client.terminate();
  await closed;
  const reused = new WebSocket(relay.url);
  assert.match((await once(reused, "error"))[0].message, /403/);
});

test("upstream failures close the frontend without leaving a listener after cleanup", { timeout: 5_000 }, async (t) => {
  const relay = await startCodexResumeRelay({ proxyUrl: "ws://127.0.0.1:1", threadId: "thread-1" });
  t.after(() => relay.close());
  const client = new WebSocket(relay.url);
  client.on("error", () => {});
  await once(client, "close");
  await relay.close();
  const retry = new WebSocket(relay.url);
  assert.match((await once(retry, "error"))[0].message, /ECONNREFUSED/);
});

test("relay refuses nonresident addresses and invalid thread bindings", async () => {
  for (const proxyUrl of ["ws://example.com:123", "wss://127.0.0.1:123", "ws://user@127.0.0.1:123", "ws://127.0.0.1:123/path", "ws://127.0.0.1:123/?other=1"]) {
    await assert.rejects(startCodexResumeRelay({ proxyUrl, threadId: "thread-1" }), /plain loopback/);
  }
  for (const threadId of [null, "", " ", "x".repeat(129)]) {
    await assert.rejects(startCodexResumeRelay({ proxyUrl: "ws://127.0.0.1:123", threadId }), /exact thread ID/);
  }
});

test("cleanup destroys rejected half-open upgrades and incomplete HTTP connections", { timeout: 2_000 }, async (t) => {
  const relay = await startCodexResumeRelay({ proxyUrl: "ws://127.0.0.1:1", threadId: "thread-1" });
  t.after(() => relay.close());
  const rejected = net.connect({ host: "127.0.0.1", port: Number(new URL(relay.url).port), allowHalfOpen: true });
  t.after(() => rejected.destroy());
  await once(rejected, "connect");
  rejected.write("GET /bad HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
  assert.match((await once(rejected, "data"))[0].toString(), /403/);
  const incomplete = net.connect({ host: "127.0.0.1", port: Number(new URL(relay.url).port) });
  t.after(() => incomplete.destroy());
  await once(incomplete, "connect");
  incomplete.write("GET / HTTP/1.1\r\n");
  await relay.close();
});

test("installed native Codex accepts the repaired address and rejects the original regression", {
  skip: !process.env.CODEX_BIN,
}, async (t) => {
  const args = ["--yolo", "resume", "00000000-0000-4000-8000-000000000001"];
  const tui = await prepareCodexResidentTui({ proxyUrl: "ws://127.0.0.1:1", args, yoloOverride: codexYoloResumeOverride("codex", args) });
  t.after(() => tui.close());
  const invoke = argv => spawnSync(process.env.CODEX_BIN, argv, { encoding: "utf8", timeout: 5_000, env: { ...process.env, LC_ALL: "C" } });
  const fixed = invoke(tui.args);
  assert.equal(fixed.error, undefined);
  assert.match(fixed.stderr, /stdin is not a terminal/);
  assert.doesNotMatch(fixed.stderr, /invalid remote address/);
  const broken = invoke(["--remote", `${tui.args[1]}/?statewright_resume_yolo_thread=thread-1`, "resume", args[2]]);
  assert.match(broken.stderr, /invalid remote address/);
});
