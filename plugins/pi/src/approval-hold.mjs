/**
 * Hold-only Pi admission boundary. There is deliberately no release operation:
 * a missing pending projection is not an approved private decision receipt.
 * Receipt/epoch-driven continuation belongs to the executor, not the model.
 */
export function createPiApprovalHold({ readState, onHold = () => {} }) {
  let reason = null;
  let approvalId = null;
  function hold(message) {
    if (!reason) {
      reason = message;
      // ExtensionRunner swallows hook exceptions and continues inference. A
      // failing UI/cleanup callback must not escape this admission boundary.
      try { onHold(message); } catch { /* admission stays closed */ }
    }
    return reason;
  }
  function observe(snapshot, { required = true } = {}) {
    if (reason) return reason;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
      || typeof snapshot.state !== "string" || !snapshot.state.trim()) {
      return required ? hold("Statewright approval state unavailable; inference remains held. Explicit recovery required.") : null;
    }
    if (snapshot.pending_approval == null) return null;
    const pending = snapshot.pending_approval;
    const valid = pending && typeof pending === "object" && !Array.isArray(pending)
      && [pending.approval_id, pending.event, pending.from_state, pending.to_state]
        .every(value => typeof value === "string" && value.trim().length > 0)
      && pending.from_state === snapshot.state;
    approvalId = valid ? pending.approval_id : null;
    return hold(valid
      ? `Statewright approval ${pending.approval_id} (${pending.event}) awaits an authorized human decision. Inference remains held; the model cannot approve. Explicit owned-session recovery required.`
      : "Malformed Statewright pending approval; inference remains held. Explicit recovery required.");
  }
  function notify(ctx) {
    try { ctx?.ui?.notify?.(`[statewright] ${reason}`, "warning"); } catch { /* fail closed */ }
  }
  function stopCurrent(ctx) {
    // Awaiting SDK abort inside a tool hook deadlocks on waitForIdle: the
    // currently running agent is waiting for this hook to return.
    try { Promise.resolve(ctx?.abort?.()).catch(() => {}); } catch { /* parent owns shutdown */ }
  }
  async function input(ctx) {
    if (!reason) {
      let snapshot;
      try { snapshot = await readState(); } catch { snapshot = null; }
      observe(snapshot);
    }
    if (!reason) return { action: "continue" };
    notify(ctx);
    stopCurrent(ctx);
    return { action: "handled" };
  }
  function blockTool(ctx) {
    if (!reason) return undefined;
    notify(ctx);
    stopCurrent(ctx);
    return { block: true, reason };
  }
  return { get held() { return reason !== null; }, get approvalId() { return approvalId; }, observe, input, blockTool, stopCurrent };
}
