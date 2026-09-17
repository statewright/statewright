import { createRuntimeApprovalService } from "./runtime-approval-service.mjs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const noop = async () => {};

/**
 * Executor-side mirror of the P0 shared approval journal (contract P1 item 3).
 *
 * The gateway remains the approval authority: it parks the transition, the
 * authorized human reviewer resolves it, and
 * the pi extension keeps raw tools blocked while the approval is pending. The
 * executor only mirrors ownership through the runtime approval service's
 * park/restore/clear calls so that an executor restart preserves the parked
 * approval checkpoint. Missing or foreign observations cannot discard it.
 * Release requires a private authoritative receipt and the applied state edge.
 *
 * The journal key is (clientId, threadId) where clientId is stable across
 * executor restarts (the transport session identity is not), so a fresh
 * process can load the checkpoint written by its predecessor.
 */
export function createExecutorApprovalMirror({ workflow, projectId, host, cwd, root, apiKey, gatewayUrl, transportClientId,
  telemetry = noop, makeService = createRuntimeApprovalService, getState }) {
  // Scope local storage without storing the credential or trusting CWD alone.
  // This is a journal namespace, not the gateway's authenticated client ID.
  const scope = [workflow, projectId ?? null, host ?? null, resolve(cwd),
    gatewayUrl.replace(/\/+$/, ""), createHash("sha256").update(apiKey).digest("hex")];
  const clientId = `exec_${createHash("sha256").update(JSON.stringify(scope)).digest("hex")}`;
  const threadId = workflow;
  const service = makeService({
    root,
    apiKey,
    gatewayUrl,
    cwd,
    clientId: transportClientId ?? clientId,
    journalClientId: clientId,
    ownsThread: async id => id === threadId,
  });
  let tracked = null;

  function checkpoint(live) {
    if (live?.pending_approval == null) return null;
    if (typeof live.pending_approval !== "object" || Array.isArray(live.pending_approval)
      || ![live.run_id, live.run_session_id, live.state, live.pending_approval.approval_id,
      live.pending_approval.event, live.pending_approval.from_state, live.pending_approval.to_state]
      .every(value => typeof value === "string" && value.length > 0)
      || live.state !== live.pending_approval.from_state) {
      throw new Error("Incomplete approval checkpoint; work remains parked");
    }
    return live;
  }

  /**
   * Classify a checkpoint from a previous process against the workflow state
   * observed after (re)attaching. Failed reconciliation preserves the receipt
   * and denies execution; it is never an implicit cancellation or approval.
   */
  async function restore(live) {
    const saved = await service.restore(threadId);
    if (!saved) return null;
    checkpoint(saved);
    if (!live || live.run_id !== saved.run_id || live.run_session_id !== saved.run_session_id) {
      throw new Error("Approval checkpoint has no matching live workflow; work remains parked");
    }
    const current = checkpoint(live);
    if (current) {
      if (current.state !== saved.state || !isDeepStrictEqual(current.pending_approval, saved.pending_approval)) {
        throw new Error("Approval identity or edge changed; work remains parked");
      }
      const wasTracked = tracked?.approvalId === current.pending_approval.approval_id;
      tracked = {
        runId: current.run_id,
        approvalId: current.pending_approval.approval_id,
        toState: saved.pending_approval.to_state,
      };
      if (!wasTracked) await telemetry({
        type: "executor_approval_restored",
        approvalId: tracked.approvalId,
        toState: tracked.toState,
      });
      return { status: "parked", saved };
    }
    if (live.state === saved.pending_approval.to_state) {
      const ticket = { ...saved.pending_approval, run_id: saved.run_id,
        run_session_id: saved.run_session_id, threadId };
      const receipt = await service.read(ticket);
      if (receipt.status !== "approved") {
        throw new Error(`Approval is ${receipt.status}; work remains parked`);
      }
      // The receipt read may wait on transport/DB work. A pre-read snapshot
      // cannot authorize release after a replacement run or approval appears.
      const latest = await (getState ?? service.getState)();
      if (!latest || latest.run_id !== saved.run_id || latest.run_session_id !== saved.run_session_id
        || latest.state !== saved.pending_approval.to_state || latest.pending_approval != null) {
        throw new Error("Approved transition is no longer applied to the owning workflow; work remains parked");
      }
      const approvalId = saved.pending_approval.approval_id;
      await service.clear(threadId, approvalId);
      tracked = null;
      await telemetry({ type: "executor_approval_cleared", approvalId, reason: "approved_while_parked" });
      return { status: "cleared", saved };
    }
    throw new Error("Approved transition has not been applied; work remains parked");
  }

  /**
   * Reconcile durable ownership on every observation, including after a
   * restart. Never overwrite a different approval that has not been consumed.
   */
  async function observe(live) {
    const next = checkpoint(live);
    const restored = await restore(live);
    if (restored?.status === "parked") return "parked";
    if (next) {
      await service.park(threadId, next);
      tracked = {
        runId: next.run_id,
        approvalId: next.pending_approval.approval_id,
        toState: next.pending_approval.to_state ?? null,
      };
      await telemetry({ type: "executor_approval_parked", approvalId: tracked.approvalId, toState: tracked.toState });
      return "parked";
    }
    return "live";
  }

  return { clientId, threadId, restore, observe };
}
