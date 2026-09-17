import { isDeepStrictEqual } from "node:util";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const printable = value => typeof value === "string" && value.length > 0 && value.length <= 1024
  && !/[\u0000-\u001f\u007f]/.test(value);
const KEYS = ["schema", "request_id", "request_epoch", "native_session_id", "input_digest", "phase",
  "approval", "release_nonce", "consumed_approval_ids", "reason"].sort();

export function requestCheckpoint(live) {
  const checkpoint = JSON.parse(JSON.stringify({ run_id: live?.run_id, run_session_id: live?.run_session_id,
    state: live?.state, pending_approval: live?.pending_approval }));
  if (![checkpoint.run_id, checkpoint.run_session_id, checkpoint.state, checkpoint.pending_approval?.approval_id,
    checkpoint.pending_approval?.event, checkpoint.pending_approval?.from_state, checkpoint.pending_approval?.to_state].every(printable)
    || checkpoint.state !== checkpoint.pending_approval.from_state
    || typeof checkpoint.pending_approval !== "object" || Array.isArray(checkpoint.pending_approval)) {
    throw new Error("Invalid request approval checkpoint; continuation denied");
  }
  return checkpoint;
}

export function validateExecutorRequest(record) {
  const request = record.request;
  // Additive v1 ownership compatibility: older records have no request ledger
  // and the formerly reserved epoch is zero. A nonzero orphan epoch is unsafe.
  if (request === undefined && record.request_epoch === 0) return;
  if (!request || typeof request !== "object" || Array.isArray(request)
    || !isDeepStrictEqual(Object.keys(request).sort(), KEYS)
    || request.schema !== "statewright/executor-request/v1" || typeof request.request_id !== "string" || !UUID.test(request.request_id)
    || request.request_epoch !== record.request_epoch || request.request_epoch < 1
    || !Number.isSafeInteger(request.request_epoch) || request.native_session_id !== record.host_session_id
    || !record.host_ready || !record.run_id || !record.transport_session_id
    || typeof request.input_digest !== "string" || !/^[a-f0-9]{64}$/.test(request.input_digest)
    || !["active", "parked", "ready", "cancelled", "completed"].includes(request.phase)
    || !Array.isArray(request.consumed_approval_ids) || request.consumed_approval_ids.length > 256
    || !request.consumed_approval_ids.every(printable)
    || new Set(request.consumed_approval_ids).size !== request.consumed_approval_ids.length
    || (request.phase === "ready" ? typeof request.release_nonce !== "string" || !UUID.test(request.release_nonce) : request.release_nonce !== null)
    || (["cancelled", "completed"].includes(request.phase) ? !printable(request.reason) : request.reason !== null)
    || (["parked", "ready"].includes(request.phase) ? request.approval === null : request.phase === "active" && request.approval !== null)) {
    throw new Error("Invalid executor request ledger; continuation denied");
  }
  if (request.approval !== null) {
    const checkpoint = requestCheckpoint(request.approval);
    if (!isDeepStrictEqual(checkpoint, request.approval) || checkpoint.run_id !== record.run_id
      || checkpoint.run_session_id !== record.transport_session_id
      || request.consumed_approval_ids.includes(checkpoint.pending_approval.approval_id)) {
      throw new Error("Foreign or consumed request approval; continuation denied");
    }
  }
}

export function requestReference(request) {
  return { schema: "statewright/executor-request-ref/v1", request_id: request.request_id,
    request_epoch: request.request_epoch, native_session_id: request.native_session_id };
}

export function sameRequest(request, reference) {
  return request && reference && isDeepStrictEqual(requestReference(request), reference);
}
