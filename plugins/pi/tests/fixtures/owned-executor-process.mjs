import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutorSessionStore } from "../../../executor/lib/executor-session-ownership.mjs";
import { createExecutorApprovalMirror } from "../../../executor/lib/executor-approval-mirror.mjs";
import { approvalJournal } from "../../../executor/lib/approval-journal.mjs";
import { createPiNativeSession } from "../../../executor/lib/host-adapters.mjs";
import { createPiExecutorRuntime } from "../../../executor/lib/executor-pi-runtime.mjs";
import { observeHost } from "../../../executor/statewright-exec.mjs";
import { ownedProcessDriver } from "./owned-process-driver.mjs";

const schema = "statewright/pi-executor-process-fixture/v1";
const sdkSchema = "statewright/pi-process-fixture/v1";
const send = (type, value = {}) => process.send?.({ schema, type, pid: process.pid, ...value });
let owner;
let mirror;
let runtime;
let control;
let observing;
let proxy;
let starting;
let closing;
const successfulConsumes = [];

async function initialize({ root, authorityUrl, providerUrl, resumeSessionId, dropBeginResponse, dropConsumeResponse }) {
  if (starting || owner || closing) throw new Error("Executor fixture initialization replay");
  const options = { root: join(root, "owners"), cwd: root, host: "pi", workflow: "fixture",
    apiKey: "synthetic-private-key", gatewayUrl: authorityUrl };
  const readAuthority = async path => {
    const response = await fetch(authorityUrl + path, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error("Synthetic authority unavailable");
    return response.json();
  };
  const getState = () => readAuthority("/state");
  owner = await createExecutorSessionStore(options).open(resumeSessionId ? { sessionId: resumeSessionId, resume: true } : {});
  const live = await getState();
  if (resumeSessionId) owner.assertGateway(live);
  else {
    await owner.bindGateway(live);
    const sessionFile = await createPiNativeSession({ pluginsRoot: fileURLToPath(new URL("../../../", import.meta.url)),
      cwd: root, sessionDir: owner.nativeRoot, sessionId: owner.record.host_session_id });
    await owner.bindHost({ sessionId: owner.record.host_session_id, sessionFile });
  }
  mirror = createExecutorApprovalMirror({ ...options, root: join(root, "approvals"), deferClear: true,
    executorSessionId: owner.record.executor_session_id, transportClientId: owner.record.transport_client_id, getState,
    makeService: configuration => {
      const journal = approvalJournal(configuration.root, configuration.journalClientId);
      return { restore: thread => journal.load(thread), park: (thread, value) => journal.save(thread, value),
        async read(ticket) {
          const receipt = await readAuthority("/receipt");
          assert.equal(ticket.run_id, receipt.run_id);
          assert.equal(ticket.run_session_id, receipt.run_session_id);
          assert.equal(ticket.approval_id, receipt.approval_id);
          return { status: receipt.status };
        }, resolve() { throw new Error("Unprivileged host cannot resolve"); },
        async clear(thread, id) {
          const disk = JSON.parse(await readFile(owner.path, "utf8"));
          assert.ok(disk.request.consumed_approval_ids.includes(id));
          await journal.clear(thread, id);
        } };
    } });
  const client = { call: async name => {
    assert.equal(name, "statewright_get_state");
    return getState();
  } };
  runtime = await createPiExecutorRuntime({ client, sessionOwner: owner, approvalMirror: mirror });
  const nativeBeforeHash = createHash("sha256").update(await readFile(owner.record.host_session_file)).digest("hex");
  const consume = runtime.requestController.consume.bind(runtime.requestController);
  runtime.requestController.consume = async body => {
    const result = await consume(body);
    successfulConsumes.push(structuredClone(body));
    return result;
  };
  // Task-owned wire-loss proxy. Real bridge completes and fsyncs before drop.
  proxy = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const upstream = await fetch(runtime.adapterBridge.url + request.url, { method: request.method,
        headers: { Authorization: request.headers.authorization, "Content-Type": "application/json" },
        body: Buffer.concat(chunks), signal: AbortSignal.timeout(3_000) });
      const body = await upstream.text();
      if (dropBeginResponse && request.url === "/hooks/request/begin" && upstream.ok) {
        send("begin-dropped", { reference: JSON.parse(body).reference });
        response.destroy(); // No acknowledgement bytes delivered to the SDK.
        return;
      }
      if (dropConsumeResponse && request.url === "/hooks/request/consume" && upstream.ok) {
        send("consume-dropped", { consumeBody: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        response.destroy(); // Real consumption completed; no response bytes delivered.
        return;
      }
      response.writeHead(upstream.status, { "Content-Type": "application/json" });
      response.end(body);
    } catch (error) {
      if (!response.destroyed) { response.writeHead(502); response.end(JSON.stringify({ error: String(error.message) })); }
    }
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const bridge = { url: `http://127.0.0.1:${proxy.address().port}`, token: runtime.adapterBridge.token };
  let spawned;
  const spawning = new Promise(resolve => { spawned = resolve; });
  observing = observeHost({ ...runtime, host: "pi", piRequestFrontend: true, client, approvalMirror: mirror, sessionOwner: owner,
    cwd: root, hostSessionId: owner.record.host_session_id, hostSessionFile: owner.record.host_session_file,
    pluginsRoot: fileURLToPath(new URL("../../../", import.meta.url)), piAgentDir: owner.nativeRoot,
    prompt: "synthetic pending task", initialState: live, environment: {}, telemetry: async () => {},
    pollIntervalMs: 10, nativeReadyTimeoutMs: 5_000,
    spawnHost() {
      if (control) throw new Error("Unexpected second SDK spawn");
      const child = fork(new URL("./owned-sdk-process.mjs", import.meta.url), [], {
        cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
      control = ownedProcessDriver(child, { schema: sdkSchema, timeoutMs: 8_000 });
      child.on("message", message => {
        if (message?.schema !== sdkSchema || message.pid !== child.pid) return;
        if (["parked", "prompt-settled", "failure"].includes(message.type)) {
          send(message.type === "failure" ? "failure" : "sdk-" + message.type,
            { sdkPid: child.pid, finalResponse: message.finalResponse, error: message.error });
        }
      });
      control.send("initialize", { options: { challenge: runtime.nativeReadiness.challenge, cwd: root,
        nativeRoot: owner.nativeRoot, bridge, providerUrl, withholdBegin: false } });
      spawned();
      return child;
    } });
  observing.catch(fail);
  await spawning;
  const ready = await control.wait("ready");
  await runtime.nativeReadiness.assertReady();
  send("ready", { owner: owner.record, ownerPath: owner.path, journalClientId: mirror.clientId,
    challenge: runtime.nativeReadiness.challenge, bridge, sdkPid: control.child.pid, sdkEnvironmentKeys: ready.environmentKeys,
    environmentKeys: Object.keys(process.env).sort(), nativeBeforeHash });
}

async function close() {
  if (closing) return closing;
  closing = (async () => {
    const errors = [];
    const drain = async operation => { try { return await operation(); } catch (error) { errors.push(error); } };
    if (control) {
      await drain(async () => {
        try { assert.deepEqual(await control.close(), { code: 0, signal: null }); }
        finally { if (!control.exited) await control.terminate(); }
      });
    }
    const result = await drain(() => observing);
    await drain(() => runtime?.adapterBridge.close());
    if (proxy) await drain(() => new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); }));
    const record = owner?.record;
    await drain(() => owner?.release());
    if (errors.length) throw new AggregateError(errors, "Executor fixture drain failed");
    send("closed", { owner: record, sdkResult: result });
    process.removeListener("message", dispatch);
    process.disconnect?.();
  })();
  return closing;
}

function fail(error) {
  send("failure", { error: String(error?.message ?? error) });
  process.exitCode = 1;
  void close().catch(() => { process.disconnect?.(); });
}

function dispatch(message) {
  void (async () => {
    if (message?.schema !== schema) throw new Error("Invalid executor fixture IPC");
    if (message.type === "initialize") { starting = initialize(message.options); return starting; }
    if (message.type === "close") return close();
    if (!control || closing) throw new Error("Executor fixture not ready");
    if (message.type === "prompt") return control.send("prompt", { text: message.text });
    if (message.type === "reap-sdk") {
      const sdkExit = await control.terminate(); // Exact child; force and observe exit.
      const result = await observing; // Real observer/readiness teardown completes.
      await owner.assertOwner();
      send("sdk-reaped", { sdkPid: control.child.pid, sdkExit, result, owner: owner.record });
      return;
    }
    if (message.type === "snapshot") {
      await owner.assertOwner();
      send("snapshot", { owner: owner.record, checkpoint: await mirror.loadCheckpoint(), successfulConsumes });
      return;
    }
    throw new Error("Invalid executor fixture command");
  })().catch(fail);
}
process.on("message", dispatch);
