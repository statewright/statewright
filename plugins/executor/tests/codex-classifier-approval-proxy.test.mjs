import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { startCodexAppServerRouteProxy } from "../lib/codex-app-server-route-proxy.mjs";
import { handleExecutorHook } from "../../codex/scripts/executor-hook.mjs";
import { AdapterBridge } from "../lib/adapter-bridge.mjs";
import {ApprovalMemory} from "../lib/approval-memory.mjs";
import {manageApprovalMemory, requestClassifierApproval} from "../../codex/scripts/classifier-approval.mjs";

const memoryContext={schema:"statewright/approval-memory-context/v1",policy_sha256:"a".repeat(64),
  invocation_sha256:"b".repeat(64),dependency_sha256:"c".repeat(64),reusable:true,
  allowed_durations:["once","2h","4h","8h","always"],approve_for:"8h"};

const threadId = "classifier-fixture-thread";
const token = "classifier-fixture-token";

function approvalRequest(invocation, overrides = {}) {
  return {
    schema: "statewright/classifier-approval-request/v2",
    thread_id: threadId,
    run_id: "run-one",
    run_session_id: "session-one",
    state: "implement",
    state_epoch: 4,
    session_generation:"generation-one",
    classifier_receipt: {
      intent_fingerprint: "intent_v1_family",
      invocation_fingerprint: `invocation_v1_${invocation}`,
      semantic_status: "Assessed",
      semantic_vector: {read_only: 0.53, may_write: 0.55, destructive: 0.32, external_or_account_effect: 0.48},
      final_denial_basis: "semantic_authorization_disabled",
      required_authority: "complete_structural_evidence_or_separate_approval",
      reformulation_allowed: true,
      exact_invocation_retry_allowed: false,
      separate_approval_allowed: true,
    },
    ...overrides,
  };
}

async function until(predicate, label) {
  for (let index = 0; index < 200; index += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function hold() {
  let enter, release;
  return {
    entered: new Promise(resolve => { enter = resolve; }),
    release: new Promise(resolve => { release = resolve; }),
    enter: () => enter(),
    resume: () => release(),
  };
}

async function setup(t, {maxReworks = 2, memory = false, userAgent = null} = {}) {
  const memoryRoot=memory?await mkdtemp(join(tmpdir(),"statewright-native-memory-")):null;
  if(memoryRoot)t.after(()=>rm(memoryRoot,{recursive:true,force:true}));
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  upstream.on("connection", socket => socket.on("message", raw => {
    const request = JSON.parse(String(raw));
    if (request.method === "thread/start" || request.method === "thread/resume") {
      socket.send(JSON.stringify({ id: request.id, result: {
        thread: { id: threadId, status: { type: "idle" }, turns: [] },
        modelProvider: "openai", model: "fixture-model",
      } }));
    } else if (request.method === "turn/start") {
      const turn = { id: "classifier-active-turn", status: "inProgress", items: [] };
      socket.send(JSON.stringify({ id: request.id, result: { turn } }));
      socket.send(JSON.stringify({ method: "turn/started", params: { threadId, turn } }));
    } else if (request.method === "initialize") {
      socket.send(JSON.stringify({id: request.id, result: {userAgent}}));
    } else if (request.id !== undefined) {
      socket.send(JSON.stringify({ id: request.id, result: {} }));
    }
  }));
  let state = { run_id: "run-one", run_session_id: "session-one", state: "implement", state_epoch: 4,
    session_generation:"generation-one",
    approval_memory_policy:{policy_sha256:memoryContext.policy_sha256,allowed_durations:memoryContext.allowed_durations,approve_for:memoryContext.approve_for} };
  let owned = true;
  let stateHold = null;
  let ownerHold = null;
  const warnings = [];
  const proxy = await startCodexAppServerRouteProxy({
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`,
    classifierApprovalToken: token,
    classifierMaxReworks: maxReworks,
    onCompatibilityWarning: message => warnings.push(message),
    classifierApprovalService: {
      ...(memory?{approvalMemory:new ApprovalMemory({root:memoryRoot,namespace:"fixture-principal-project-staging"})}:{}),
      ownsThread: async id => {
        if (ownerHold) {
          const pending = ownerHold;
          ownerHold = null;
          pending.enter();
          await pending.release;
        }
        return owned && id === threadId;
      },
      getState: async id => {
        assert.equal(id, threadId);
        if (stateHold) {
          const hold = stateHold;
          stateHold = null;
          hold.enter();
          await hold.release;
        }
        return structuredClone(state);
      },
    },
  });
  const clients = [];
  async function connectAndOwn() {
    const messages = [];
    const client = new WebSocket(proxy.url);
    clients.push(client);
    client.on("message", raw => messages.push(JSON.parse(String(raw))));
    await once(client, "open");
    const initializeId = `initialize-${clients.length}`;
    client.send(JSON.stringify({ id: initializeId, method: "initialize", params: {} }));
    await until(() => messages.find(message => message.id === initializeId), "native initialization response");
    const id = `start-${clients.length}`;
    client.send(JSON.stringify({ id, method: "thread/start", params: {} }));
    await until(() => messages.find(message => message.id === id), "thread ownership response");
    return { client, messages };
  }
  const endpoint = `${proxy.url.replace(/^ws/, "http")}/classifier-approval`;
  async function post(body, headers = {}) {
    return fetch(endpoint, { method: "POST", headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers,
    }, body: JSON.stringify(body) });
  }
  t.after(async () => {
    for (const client of clients) client.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise(resolve => upstream.close(resolve));
  });
  return { connectAndOwn, endpoint, post, warnings,
    setState(value) { state = structuredClone(value); },
    setOwned(value) { owned = value; },
    holdStateRead() {
      return stateHold = hold();
    },
    holdOwnerLookup() {
      return ownerHold = hold();
    } };
}

test("native initialization warns older Codex clients without blocking their connection", async t => {
  for (const [version, expected] of [["0.160.0", 1], ["0.167.0", 0], ["1.0.0", 0]]) {
    const fixture = await setup(t, {userAgent: `codex_cli_rs/${version} (test platform)`});
    await fixture.connectAndOwn();
    assert.equal(fixture.warnings.length, expected);
    if (expected) assert.match(fixture.warnings[0], /Statewright may not work properly.*Update Codex/);
  }
});

test("classifier uncertainty reaches native approval immediately when rewrites are disabled", async t => {
  const fixture = await setup(t, {maxReworks: 0});
  const {client, messages} = await fixture.connectAndOwn();
  const pending = fixture.post(approvalRequest("immediate"));
  const modal = await until(() => messages.find(message => message.method === "mcpServer/elicitation/request"), "immediate native classifier form");
  assert.doesNotMatch(modal.params.message, /after 0 rewrites/);
  client.send(JSON.stringify({id: modal.id, result: {action:"accept"}}));
  const allowed = await (await pending).json();
  assert.equal(allowed.action, "allow_once");
  assert.equal(allowed.invocation_fingerprint, "invocation_v1_immediate");
});

const waitSoakMs = Number(process.env.STATEWRIGHT_APPROVAL_WAIT_SOAK_MS ?? 80);
test("approval helper preserves a quiet native review and reuses the resulting 8h grant", {timeout: waitSoakMs + 30_000}, async t => {
  assert(Number.isSafeInteger(waitSoakMs) && waitSoakMs >= 0 && waitSoakMs <= 330_000);
  const fixture = await setup(t, {maxReworks: 0, memory: true});
  const {client, messages} = await fixture.connectAndOwn();
  const value = approvalRequest("quiet-human", {approval_memory: memoryContext});
  const options = {environment: {STATEWRIGHT_CLASSIFIER_APPROVAL_RECEIPT: "/synthetic/owner.json"},
    readFile: async () => JSON.stringify({proxyUrl: fixture.endpoint.replace(/^http/, "ws"), proxyToken: token})};
  let settled = false;
  const pending = requestClassifierApproval(value, options).finally(() => { settled = true; });
  const modal = await until(() => messages.find(message => message.method === "mcpServer/elicitation/request"), "quiet review form");
  assert.match(modal.params.message, /8 hours/);
  assert.match(modal.params.message, /S1 classification.*read-only 53%, write 55%/);
  await new Promise(resolve => setTimeout(resolve, waitSoakMs));
  assert.equal(settled, false, "quiet human review must remain pending until the native outcome");
  assert(!messages.some(message => message.method === "serverRequest/resolved"));
  client.send(JSON.stringify({id: modal.id, result: {action: "accept"}}));
  const approved = await pending;
  assert.equal(approved.action, "allow_once");
  assert.equal(approved.duration, "8h");
  const reused = await requestClassifierApproval(value, options);
  assert.equal(reused.reason, "remembered_human_approval");
  assert.equal(reused.duration, "8h");
  assert.equal(messages.filter(message => message.method === "mcpServer/elicitation/request").length, 1);
});

test("approval helper waits for a real native decision without an approval deadline", async t => {
  const fixture = await setup(t, {maxReworks: 0});
  const {messages, client} = await fixture.connectAndOwn();
  let settled = false;
  const pending = requestClassifierApproval(approvalRequest("native-wait"), {
    environment: {STATEWRIGHT_CLASSIFIER_APPROVAL_RECEIPT: "/synthetic/owner.json"},
    readFile: async () => JSON.stringify({proxyUrl: fixture.endpoint.replace(/^http/, "ws"), proxyToken: token}),
  }).finally(() => { settled = true; });
  const modal = await until(() => messages.find(message => message.method === "mcpServer/elicitation/request"), "native review");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(settled, false);
  assert(!messages.some(message => message.method === "serverRequest/resolved"));
  client.send(JSON.stringify({id: modal.id, result: {action: "decline"}}));
  const result = await pending;
  assert.equal(result.action, "deny");
  assert.equal(result.reason, "human_declined");
  assert.equal(messages.filter(message => message.method === "mcpServer/elicitation/request").length, 1);
});

test("native memory selection survives reconnect, names fresh receipt, and supports owned revocation",async t=>{
  const fixture=await setup(t,{maxReworks:0,memory:true});
  const first=await fixture.connectAndOwn();
  const value=approvalRequest("before-restart",{approval_memory:memoryContext});
  const pending=fixture.post(value);
  const modal=await until(()=>first.messages.find(m=>m.method==="mcpServer/elicitation/request"),"duration form");
  assert.deepEqual(modal.params.requestedSchema.properties,{});
  assert.match(modal.params.message,/8 hours/);
  first.client.send(JSON.stringify({id:modal.id,result:{action:"accept"}}));
  const approved=await(await pending).json();assert.equal(approved.duration,"8h");
  first.client.close();await once(first.client,"close");
  const second=await fixture.connectAndOwn();
  const next=approvalRequest("after-restart",{approval_memory:memoryContext});
  const reused=await(await fixture.post(next)).json();
  assert.equal(reused.reason,"remembered_human_approval");assert.equal(reused.invocation_fingerprint,"invocation_v1_after-restart");
  assert(!second.messages.some(m=>m.method==="mcpServer/elicitation/request"));
  const options={environment:{STATEWRIGHT_CLASSIFIER_APPROVAL_RECEIPT:"/synthetic/receipt"},
    readFile:async()=>JSON.stringify({proxyUrl:fixture.endpoint.replace(/^http/,"ws"),proxyToken:token})};
  const listed=await manageApprovalMemory({threadId,action:"list"},options);assert.equal(listed.grants.length,1);
  await manageApprovalMemory({threadId,action:"revoke",grantId:approved.grant_id},options);
  const again=fixture.post(next);
  const newModal=await until(()=>second.messages.find(m=>m.method==="mcpServer/elicitation/request"),"revoked grant prompts again");
  second.client.send(JSON.stringify({id:newModal.id,result:{action:"cancel"}}));
  assert.equal((await(await again).json()).reason,"human_cancelled");
});

test("changed dependency evidence never reuses a native always grant",async t=>{
  const fixture=await setup(t,{maxReworks:0,memory:true});const {client,messages}=await fixture.connectAndOwn();
  const value=approvalRequest("original",{approval_memory:memoryContext});
  const first=fixture.post(value);const modal=await until(()=>messages.find(m=>m.method==="mcpServer/elicitation/request"),"first grant");
  client.send(JSON.stringify({id:modal.id,result:{action:"accept"}}));
  await(await first).json();
  const changed=approvalRequest("changed",{approval_memory:{...memoryContext,dependency_sha256:"d".repeat(64)}});
  const next=fixture.post(changed);const second=await until(()=>messages.find(m=>m.method==="mcpServer/elicitation/request"&&m.id!==modal.id),"changed evidence review");
  client.send(JSON.stringify({id:second.id,result:{action:"decline"}}));assert.equal((await(await next).json()).reason,"human_declined");
});

test("an explicitly configured legacy rewrite budget still reaches one exact native approval", async t => {
  const fixture = await setup(t);
  const { client, messages } = await fixture.connectAndOwn();
  for (const invocation of ["one", "two"]) {
    const response = await fixture.post(approvalRequest(invocation));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.action, "rework");
    assert.equal(result.attempts, invocation === "one" ? 1 : 2);
  }

  const pending = fixture.post(approvalRequest("three"));
  const modal = await until(() => messages.find(message => message.method === "mcpServer/elicitation/request"),
    "native classifier approval form");
  assert.equal(modal.params.threadId, threadId);
  assert.match(modal.params.message, /Allow this exact invocation once/);
  client.send(JSON.stringify({ id: modal.id, result: { action: "accept" } }));
  const response = await pending;
  assert.equal(response.status, 200);
  const allowed = await response.json();
  assert.equal(allowed.action, "allow_once");
  assert.equal(allowed.invocation_fingerprint, "invocation_v1_three");
  await until(() => messages.find(message => message.method === "serverRequest/resolved"
    && message.params.requestId === modal.id), "native approval resolution");

  const consumed = await (await fixture.post(approvalRequest("three"))).json();
  assert.equal(consumed.action, "rework", "one approval cannot persist beyond its held invocation");
});

test("executor hook and bridge share the native controller budget and exact approval", async t => {
  for (const action of ["accept", "decline", "cancel"]) {
    await t.test(action, {timeout: 10_000}, async t => {
      const fixture = await setup(t);
      const {client, messages} = await fixture.connectAndOwn();
      let invocation = 0;
      const bridge = await new AdapterBridge({async call(name) {
        assert.equal(name, "statewright_adapter_pre_tool");
        const request = approvalRequest(String(++invocation));
        return {decision: "deny", state: request.state,
          classifier_context: {run_id: request.run_id, run_session_id: request.run_session_id,
            state: request.state, state_epoch: request.state_epoch},
          risk_assessment: request.classifier_receipt};
      }}, {host: "codex", token: "bridge-test"}).start();
      t.after(() => bridge.close());
      const options = {adapterUrl: bridge.url, adapterToken: "bridge-test", approvalOptions: {
        environment: {STATEWRIGHT_CLASSIFIER_APPROVAL_RECEIPT: "/synthetic/owner.json"},
        readFile: async () => JSON.stringify({proxyUrl: fixture.endpoint.replace(/^http/, "ws"), proxyToken: token}),
      }};
      const invoke = () => handleExecutorHook("pre-tool", {session_id: threadId,
        tool_name: "opaque_fixture", tool_input: {private: "never-forward-this"}}, options);
      for (const attempt of [1, 2]) {
        const result = await invoke();
        assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
        assert.match(result.hookSpecificOutput.permissionDecisionReason, new RegExp(`Rework attempt ${attempt}/2`));
        assert.doesNotMatch(JSON.stringify(result), /never-forward-this/);
      }
      const pending = invoke();
      const modal = await until(() => messages.find(item => item.method === "mcpServer/elicitation/request"), "executor native form");
      assert.match(modal.params.message, /S1 classification: read-only 53%, write 55%, destructive 32%, external 48%/);
      client.send(JSON.stringify({id: modal.id, result: {action}}));
      const result = await pending;
      assert.equal(result.hookSpecificOutput.permissionDecision, action === "accept" ? undefined : "deny");
      assert.match(JSON.stringify(result), action === "accept" ? /allow_once/ : action === "decline" ? /human_declined/ : /human_cancelled/);
      assert.doesNotMatch(JSON.stringify(messages), /never-forward-this/);
    });
  }
});

test("packaged symlinked approval CLI reaches native elicitation with S1 disabled", async t => {
  for (const action of ["accept", "decline", "cancel"]) {
    await t.test(action, {timeout: 10_000}, async t => {
      const fixture = await setup(t);
      const {client, messages} = await fixture.connectAndOwn();
      const home = await mkdtemp(join(tmpdir(), "statewright-native-cli-"));
      t.after(() => rm(home, {recursive: true, force: true}));
      await mkdir(join(home, "codex-home"));
      await symlink(fileURLToPath(new URL("../../codex/", import.meta.url)),
        join(home, "codex-home", "plugins"), "junction");
      const receipt = join(home, "manifest.json");
      await writeFile(receipt, JSON.stringify({
        proxyUrl: fixture.endpoint.replace(/^http/, "ws"), proxyToken: token,
      }));
      async function invokeCli(invocation) {
        const child = spawn(process.execPath,
          [join(home, "codex-home", "plugins", "scripts", "classifier-approval.mjs")], {
            env: {PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, "codex-home"),
              STATEWRIGHT_CLASSIFIER_APPROVAL_RECEIPT: receipt},
            stdio: ["pipe", "pipe", "pipe"],
          });
        t.after(() => { if (child.exitCode === null) child.kill(); });
        let stdout = "", stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        const exited = once(child, "close");
        child.stdin.end(JSON.stringify(approvalRequest(invocation)));
        const [status] = await exited;
        assert.equal(status, 0, stderr);
        assert.ok(stdout.trim(), "packaged approval CLI must not silently exit");
        return JSON.parse(stdout);
      }
      assert.equal((await invokeCli("one")).action, "rework");
      assert.equal((await invokeCli("two")).action, "rework");
      const pending = invokeCli("three");
      const modal = await until(() => messages.find(message => message.method === "mcpServer/elicitation/request"),
        "packaged CLI's native approval form");
      assert.equal(modal.params.threadId, threadId);
      client.send(JSON.stringify({id: modal.id, result: {action}}));
      const result = await pending;
      assert.equal(result.action, action === "accept" ? "allow_once" : "deny");
      if (action !== "accept") assert.equal(result.reason, action === "decline" ? "human_declined" : "human_cancelled");
      assert.equal(result.basis, "semantic_authorization_disabled");
      assert.equal(result.invocation_fingerprint, "invocation_v1_three");
    });
  }
});

test("classifier approval endpoint authenticates and fails closed without one exact owner", async t => {
  const fixture = await setup(t);
  assert.equal((await fetch(fixture.endpoint, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(fixture.endpoint, { method: "POST", headers: {
    Authorization: `Bearer ${token}`, Origin: "https://example.invalid",
  }, body: "{}" })).status, 401);

  const noOwner = await fixture.post(approvalRequest("ownerless"));
  assert.equal(noOwner.status, 400);
  assert.match((await noOwner.json()).reason, /no owning native connection/);

  await fixture.connectAndOwn();
  fixture.setOwned(false);
  const transferred = await fixture.post(approvalRequest("transferred"));
  assert.equal(transferred.status, 400);
  assert.match((await transferred.json()).reason, /no owning native connection/);

  fixture.setOwned(true);
  await fixture.connectAndOwn();
  const duplicate = await fixture.post(approvalRequest("duplicate"));
  assert.equal(duplicate.status, 400);
  assert.match((await duplicate.json()).reason, /multiple owning native connections/);
});

test("workflow transition approval blocks classifier fallthrough", async t => {
  const fixture = await setup(t);
  await fixture.connectAndOwn();
  fixture.setState({ run_id: "run-one", run_session_id: "session-one", state: "implement", state_epoch: 4,
    pending_approval: { approval_id: "approval-one" } });
  const response = await fixture.post(approvalRequest("workflow-pending"));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.action, "deny");
  assert.equal(result.reason, "workflow_approval_pending");
});

test("ownership loss during accepted-state reread denies the held invocation", async t => {
  const fixture = await setup(t);
  const { client, messages } = await fixture.connectAndOwn();
  await fixture.post(approvalRequest("one"));
  await fixture.post(approvalRequest("two"));
  const pending = fixture.post(approvalRequest("three"));
  const modal = await until(() => messages.find(message => message.method === "mcpServer/elicitation/request"),
    "native classifier approval form");
  const hold = fixture.holdStateRead();
  client.send(JSON.stringify({ id: modal.id, result: { action: "accept" } }));
  await hold.entered;
  fixture.setOwned(false);
  hold.resume();
  const result = await (await pending).json();
  assert.equal(result.action, "deny");
  assert.equal(result.reason, "approval_state_changed");
});

test("a duplicate live native owner appearing during state reread denies release", async t => {
  const fixture = await setup(t);
  const { client, messages } = await fixture.connectAndOwn();
  await fixture.post(approvalRequest("one"));
  await fixture.post(approvalRequest("two"));
  const pending = fixture.post(approvalRequest("three"));
  const modal = await until(() => messages.find(message => message.method === "mcpServer/elicitation/request"),
    "native classifier approval form");
  const stateRead = fixture.holdStateRead();
  client.send(JSON.stringify({ id: modal.id, result: { action: "accept" } }));
  await stateRead.entered;
  await fixture.connectAndOwn();
  stateRead.resume();
  const result = await (await pending).json();
  assert.equal(result.action, "deny");
  assert.equal(result.reason, "approval_state_changed");
});

test("HTTP abort during asynchronous owner lookup cannot orphan a native prompt", async t => {
  const fixture = await setup(t);
  const { messages } = await fixture.connectAndOwn();
  await fixture.post(approvalRequest("one"));
  await fixture.post(approvalRequest("two"));
  const ownerLookup = fixture.holdOwnerLookup();
  const abort = new AbortController();
  const request = fetch(fixture.endpoint, {
    method: "POST",
    headers: {"Content-Type": "application/json", Authorization: `Bearer ${token}`},
    body: JSON.stringify(approvalRequest("three")),
    signal: abort.signal,
  });
  const rejected = assert.rejects(request, /abort/i);
  await ownerLookup.entered;
  abort.abort();
  // Let the server observe the closed response while ownership is still
  // blocked; the regression is losing that already-delivered close event.
  await new Promise(resolve => setTimeout(resolve, 20));
  ownerLookup.resume();
  await rejected;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(messages.some(message => message.method === "mcpServer/elicitation/request"), false);
});

test("native disconnect denies classifier approval even while its turn remains active", async t => {
  const fixture = await setup(t);
  const { client, messages } = await fixture.connectAndOwn();
  client.send(JSON.stringify({ id: "active-turn", method: "turn/start", params: { threadId, input: [] } }));
  await until(() => messages.find(message => message.method === "turn/started"), "active turn notification");
  await fixture.post(approvalRequest("one"));
  await fixture.post(approvalRequest("two"));
  const pending = fixture.post(approvalRequest("three"));
  await until(() => messages.find(message => message.method === "mcpServer/elicitation/request"),
    "native classifier approval form");
  client.close();
  await once(client, "close");
  const result = await (await pending).json();
  assert.equal(result.action, "deny");
  assert.equal(result.reason, "native_connection_closed");
});
