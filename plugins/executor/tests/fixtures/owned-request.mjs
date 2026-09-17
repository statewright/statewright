import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExecutorSessionStore } from "../../lib/executor-session-ownership.mjs";
import { createExecutorApprovalMirror } from "../../lib/executor-approval-mirror.mjs";
import { createExecutorRequestController } from "../../lib/executor-request-controller.mjs";
import { approvalJournal } from "../../lib/approval-journal.mjs";

export const digest = "a".repeat(64);
export const base = { run_id: "run", run_session_id: "session", workflow: "fixture", state: "review" };
export const pending = { ...base, pending_approval: { approval_id: "approval", event: "ACCEPT", from_state: "review", to_state: "work" } };

// Synthetic authority only. Real durable owner/journal, never a gateway,
// workflow load, approval resolver or provider request.
export async function fixture(t, { parked = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "executor-request-"));
  let owner;
  t.after(async () => {
    await owner?.release();
    await rm(root, { recursive: true, force: true });
  });
  const options = { root: join(root, "owners"), cwd: root, host: "pi", workflow: "fixture",
    apiKey: "fixture-private-key", gatewayUrl: "http://127.0.0.1:9" };
  const store = createExecutorSessionStore(options);
  owner = await store.open();
  await owner.bindGateway(base);
  await owner.bindHost({ sessionId: owner.record.host_session_id, sessionFile: join(owner.nativeRoot, "fixture.jsonl") });
  let live = parked ? pending : base;
  let decision = "pending";
  let afterRead = async () => {};
  let clearFailure = false;
  let afterClear = async () => {};
  const events = [];
  const mirror = createExecutorApprovalMirror({ ...options, root: join(root, "approvals"), executorSessionId: owner.record.executor_session_id,
    transportClientId: owner.record.transport_client_id, deferClear: true, getState: async () => live,
    makeService: configuration => {
      const journal = approvalJournal(configuration.root, configuration.journalClientId);
      return {
        restore: () => journal.load("fixture"), park: (_, value) => journal.save("fixture", value),
        async read(ticket) {
          events.push("read:" + decision);
          assert.equal(ticket.run_id, base.run_id);
          assert.equal(ticket.run_session_id, base.run_session_id);
          assert.equal(ticket.approval_id, "approval");
          await afterRead();
          return { status: decision };
        },
        resolve: () => { throw new Error("Host must never resolve"); },
        async clear(_, id) {
          if (clearFailure) throw new Error("fixture clear unavailable");
          const disk = JSON.parse(await readFile(owner.path, "utf8"));
          assert.ok(disk.request.consumed_approval_ids.includes(id), "durable consumption precedes journal clearance");
          events.push("clear:" + id);
          await journal.clear("fixture", id);
          await afterClear();
        },
      };
    },
  });
  let controller = createExecutorRequestController({ owner, approvalMirror: mirror, getState: async () => live });
  const body = sequence => ({ native_session_id: owner.record.host_session_id, input_sequence: sequence, input_digest: digest });
  return { get owner() { return owner; }, store, get controller() { return controller; }, mirror, body, events,
    getState: async () => live,
    approve: () => { decision = "approved"; live = { ...base, state: "work" }; },
    reject: () => { decision = "rejected"; live = base; },
    setLive: value => { live = value; },
    setAfterRead: callback => { afterRead = callback; },
    setAfterClear: callback => { afterClear = callback; },
    setClearFailure: value => { clearFailure = value; },
    async reopen() {
      const sessionId = owner.record.executor_session_id;
      await owner.release();
      owner = await store.open({ sessionId, resume: true });
      controller = createExecutorRequestController({ owner, approvalMirror: mirror, getState: async () => live });
    },
  };
}
