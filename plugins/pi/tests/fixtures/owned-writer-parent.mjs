import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createExecutorSessionStore } from "../../../executor/lib/executor-session-ownership.mjs";
import { createExecutorApprovalMirror } from "../../../executor/lib/executor-approval-mirror.mjs";
import { approvalJournal } from "../../../executor/lib/approval-journal.mjs";
import { matchExecutorRecoveryBinding } from "../../../executor/lib/executor-recovery-contract.mjs";
import { createPiExecutorRuntime } from "../../../executor/lib/executor-pi-runtime.mjs";
import { parentWriterPort, writerRelaySelection } from "./owned-writer-relay.mjs";

// Real owner/controller/bridge process, with writer created by the outliving
// root instead of this process. No observeHost/main activation or private SDK API.
const schema = "statewright/pi-writer-parent-fixture/v1";
const send = (type, value = {}) => process.send?.({ schema, type, pid: process.pid, ...value });
let initializing = false;
let binding;
let owner;
let mirror;
let runtime;
let writer;

async function initialize({ root, authorityUrl, selected }) {
  if (initializing) throw new Error("Parent initialization replay");
  initializing = true;
  binding = matchExecutorRecoveryBinding(selected, selected);
  const options = { root: join(root, "owners"), cwd: root, host: "pi", workflow: "fixture",
    apiKey: "synthetic-private-key", gatewayUrl: authorityUrl };
  owner = await createExecutorSessionStore(options).open({ sessionId: binding.executor_session_id, resume: true });
  const readAuthority = async path => {
    const response = await fetch(authorityUrl + path, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error("Synthetic authority unavailable");
    return response.json();
  };
  const getState = () => readAuthority("/state");
  const saved = owner.record;
  assert.equal(binding.scope_id, owner.scopeId);
  for (const [field, value] of Object.entries({ transport_client_id: saved.transport_client_id,
    transport_session_id: saved.transport_session_id, run_id: saved.run_id,
    native_session_id: saved.host_session_id, native_session_file: saved.host_session_file })) {
    assert.equal(binding[field], value);
  }
  assert.equal(JSON.parse(await readFile(owner.path + ".lock", "utf8")).pid, process.pid);
  const live = await getState(); owner.assertGateway(live);
  mirror = createExecutorApprovalMirror({ ...options, root: join(root, "approvals"), deferClear: true,
    executorSessionId: saved.executor_session_id, transportClientId: saved.transport_client_id, getState,
    makeService: configuration => {
      const journal = approvalJournal(configuration.root, configuration.journalClientId);
      return { restore: thread => journal.load(thread), park: (thread, value) => journal.save(thread, value),
        async read(ticket) {
          const receipt = await readAuthority("/receipt");
          for (const field of ["run_id", "run_session_id", "approval_id"]) assert.equal(ticket[field], receipt[field]);
          return { status: receipt.status };
        },
        resolve() { throw new Error("Unprivileged fixture cannot resolve"); },
        async clear(thread, id) {
          const disk = JSON.parse(await readFile(owner.path, "utf8"));
          assert.ok(disk.request.consumed_approval_ids.includes(id));
          return journal.clear(thread, id);
        } };
    } });
  const client = { call: name => { assert.equal(name, "statewright_get_state"); return getState(); } };
  runtime = await createPiExecutorRuntime({ client, sessionOwner: owner, approvalMirror: mirror });
  assert.equal(await mirror.observe(live), "parked");
  send("descriptor", { owner: owner.record, ownerPath: owner.path, journalClientId: mirror.clientId,
    challenge: runtime.nativeReadiness.challenge, bridge: { url: runtime.adapterBridge.url, token: runtime.adapterBridge.token },
    environmentKeys: Object.keys(process.env).sort() });
}

async function dispatch(message) {
  if (message?.schema !== schema) throw new Error("Invalid creator IPC envelope");
  if (message.type === "initialize") return initialize(message.options);
  if (!runtime) throw new Error("Parent not ready");
  if (message.type === "attach-writer") {
    if (writer) throw new Error("Writer attachment replay");
    const expected = writerRelaySelection(binding, process.pid, message.selection?.writer_pid);
    assert.deepEqual(message.selection, expected);
    writer = parentWriterPort(expected);
    runtime.nativeReadiness.bindChild(writer);
    send("writer-bound", { selection: expected }); return;
  }
  if (message.type === "writer-exit") {
    if (!writer) throw new Error("Unbound lifecycle relay");
    writer.receive({ type: message.type, selection: message.selection, receipt: message.receipt });
    await runtime.nativeReadiness.close();
    send("writer-exit-observed", { ready: runtime.nativeReadiness.ready, owner: owner.record }); return;
  }
  if (message.type === "snapshot") {
    await owner.assertOwner();
    send("snapshot", { owner: owner.record, checkpoint: await mirror.loadCheckpoint(), ready: runtime.nativeReadiness.ready }); return;
  }
  // Intentionally no release/unlock command. Exact root-owned process handles
  // perform cleanup; even an accepted creator relay cannot reclaim this lock.
  throw new Error("Invalid creator command");
}
function listener(message) {
  void dispatch(message).catch(error => { send("failure", { error: String(error?.message ?? error) }); process.exitCode = 1; });
}
process.on("message", listener);
