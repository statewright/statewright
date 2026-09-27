import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { prepareQueuedHumanInput, humanInputHook } from "../lib/queued-human-input.mjs";
import { startCodexAppServerRouteProxy } from "../lib/codex-app-server-route-proxy.mjs";
import { startCodexAppServerRouteProxy as startPackagedProxy } from "../../codex/scripts/lib/desktop-runtime/codex-app-server-route-proxy.mjs";

const question = (id = 7, overrides = {}) => ({ id, method: "item/tool/requestUserInput", params: {
  threadId: "thread-a", turnId: "turn-a", itemId: "item-a", isBlocking: false,
  autoResolutionMs: 100, questions: [{ id: "milestone-format", header: "Format", question: "Which report format?",
    isOther: true, options: [{ label: "Short", description: "Summary" }, { label: "Full", description: "Details" }] }],
  ...overrides,
} });

test("non-blocking question clears the nullable legacy timer without changing native identity or options", () => {
  const input = question();
  const output = prepareQueuedHumanInput(input);
  assert.deepEqual(output, { ...input, params: { ...input.params, autoResolutionMs: null } });
  assert.equal(input.params.autoResolutionMs, 100, "do not mutate upstream message");
  assert.strictEqual(prepareQueuedHumanInput(output), output, "idempotent");
});

test("blocking, legacy, approval and ordinary messages retain their exact semantics", () => {
  const legacy = question(); delete legacy.params.isBlocking;
  for (const value of [legacy, question(8, { isBlocking: true }),
    { id: 1, method: "item/commandExecution/requestApproval", params: { autoResolutionMs: 100 } },
    { id: "statewright-approval-id", method: "mcpServer/elicitation/request", params: {} },
    { id: 7, result: { answers: {} } }, { method: "serverRequest/resolved", params: { requestId: 7 } }, null]) {
    assert.strictEqual(prepareQueuedHumanInput(value), value);
  }
});

test("shared policy is a separate additive hook, not a workflow or auth prerequisite", async () => {
  const hook = humanInputHook();
  assert.equal(hook.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const text = hook.hookSpecificOutput.additionalContext;
  for (const pattern of [/request_user_input_async/, /only.*advertised/i, /dependent work/, /silence/i,
    /approval/i, /unavailable/i, /same.*scope/i, /chat.*SMS/i]) assert.match(text, pattern);
  const config = JSON.parse(await readFile("plugins/codex/hooks/hooks.json", "utf8"));
  const commands = config.hooks.UserPromptSubmit.flatMap(entry => entry.hooks).map(h => h.command);
  assert(commands.includes('node "$PLUGIN_ROOT/scripts/human-input-hook.mjs"'));
  assert(commands.includes('bash "$PLUGIN_ROOT/hook.sh" user-prompt'), "retain enforcement hook");
  const result = spawnSync(process.execPath, ["plugins/codex/scripts/human-input-hook.mjs"], {
    env: {}, input: "not-json-and-not-needed", encoding: "utf8", timeout: 2000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), hook);
});

const until = async predicate => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert(Date.now() < deadline, "timed out waiting for protocol evidence");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

for (const [host, startProxy] of [["TUI canonical", startCodexAppServerRouteProxy], ["Desktop packaged", startPackagedProxy]]) {
  test(`${host}: a question id cannot consume an outstanding client request`, { timeout: 5000 }, async t => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const connected = once(server, "connection");
    const bound = [];
    const proxy = await startProxy({
      upstreamUrl: `ws://127.0.0.1:${server.address().port}`,
      onThreadStarted: async value => bound.push(value),
    });
    t.after(async () => {
      for (const socket of server.clients) socket.terminate();
      await proxy.close();
      await new Promise(resolve => server.close(resolve));
    });
    const client = new WebSocket(proxy.url);
    t.after(() => client.terminate());
    const visible = [], forwarded = [];
    client.on("message", raw => visible.push(JSON.parse(String(raw))));
    await once(client, "open");
    const [upstream] = await connected;
    upstream.on("message", raw => forwarded.push(JSON.parse(String(raw))));
    client.send(JSON.stringify({ id: 7, method: "thread/start", params: {} }));
    await until(() => forwarded.length === 1);
    upstream.send(JSON.stringify(question(7)));
    await until(() => visible.length === 1);
    assert.equal(visible[0].method, "item/tool/requestUserInput");
    assert.equal(visible[0].params.autoResolutionMs, null);
    assert.deepEqual(bound, [], "a server question is not the thread/start response");
    upstream.send(JSON.stringify({ id: 7, result: { thread: { id: "thread-bound" } } }));
    await until(() => visible.length === 2 && bound.length === 1);
    assert.deepEqual(bound, [{ threadId: "thread-bound" }]);
    assert.equal(visible[1].result.thread.id, "thread-bound");
  });

  test(`${host}: numeric and string client request ids remain distinct`, { timeout: 5000 }, async t => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const connected = once(server, "connection");
    const bound = [];
    const proxy = await startProxy({
      upstreamUrl: `ws://127.0.0.1:${server.address().port}`,
      onThreadStarted: async value => bound.push(value),
    });
    t.after(async () => {
      for (const socket of server.clients) socket.terminate();
      await proxy.close();
      await new Promise(resolve => server.close(resolve));
    });
    const client = new WebSocket(proxy.url);
    t.after(() => client.terminate());
    const visible = [], forwarded = [];
    client.on("message", raw => visible.push(JSON.parse(String(raw))));
    await once(client, "open");
    const [upstream] = await connected;
    upstream.on("message", raw => forwarded.push(JSON.parse(String(raw))));
    client.send(JSON.stringify({ id: 7, method: "thread/start", params: {} }));
    client.send(JSON.stringify({ id: "7", method: "thread/start", params: {} }));
    await until(() => forwarded.length === 2);
    upstream.send(JSON.stringify({ id: "7", result: { thread: { id: "thread-string" } } }));
    upstream.send(JSON.stringify({ id: 7, result: { thread: { id: "thread-number" } } }));
    await until(() => visible.length === 2 && bound.length === 2);
    assert.deepEqual(bound, [{ threadId: "thread-string" }, { threadId: "thread-number" }]);
    assert.equal(visible[0].id, "7");
    assert.equal(visible[1].id, 7);
  });

  test(`${host}: cards, independent work, out-of-order answers and resolution cross the shim`, { timeout: 5000 }, async t => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const connected = once(server, "connection");
    const proxy = await startProxy({ upstreamUrl: `ws://127.0.0.1:${server.address().port}` });
    t.after(async () => {
      for (const socket of server.clients) socket.terminate();
      await proxy.close();
      await new Promise(resolve => server.close(resolve));
    });
    const client = new WebSocket(proxy.url);
    t.after(() => client.terminate());
    const visible = [], replies = [];
    client.on("message", raw => visible.push(JSON.parse(String(raw))));
    await once(client, "open");
    const [upstream] = await connected;
    upstream.on("message", raw => replies.push(JSON.parse(String(raw))));
    const first = question(7), second = question("7", { itemId: "item-b" });
    upstream.send(JSON.stringify(first));
    upstream.send(JSON.stringify(second));
    const progress = { method: "item/agentMessage/delta", params: {
      threadId: "thread-a", turnId: "turn-a", itemId: "independent-work", delta: "Independent tests passed." } };
    upstream.send(JSON.stringify(progress));
    await until(() => visible.length === 3);
    assert.deepEqual(visible, [prepareQueuedHumanInput(first), prepareQueuedHumanInput(second), progress]);
    assert.deepEqual(replies, [], "no synthetic answer, pause, goal change or interrupt while pending");
    const answer = { id: "7", result: { answers: { "milestone-format": { answers: ["Full"] } } } };
    client.send(JSON.stringify(answer));
    await until(() => replies.length === 1);
    assert.deepEqual(replies, [answer], "preserve request id type and answer, do not turn it into an approval");
    const resolved = { method: "serverRequest/resolved", params: { threadId: "thread-a", requestId: "7" } };
    upstream.send(JSON.stringify(resolved));
    await until(() => visible.length === 4);
    assert.deepEqual(visible[3], resolved);
    const empty = { id: 7, result: { answers: {} } };
    client.send(JSON.stringify(empty));
    await until(() => replies.length === 2);
    assert.deepEqual(replies[1], empty, "dismissal remains empty, never a recommended option");
  });
}
