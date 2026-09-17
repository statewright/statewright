import { isDeepStrictEqual } from "node:util";
import { requestReference } from "./executor-request-record.mjs";

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), keys.sort());
}

/** Parent-only authority. No resolve method; no model-supplied approval data. */
export function createExecutorRequestController({ owner, approvalMirror, getState }) {
  if (!approvalMirror?.deferClear) throw new Error("Request ownership requires deferred approval clearance");
  let highestSequence = 0;
  let latestReference = null;
  let closed = false;
  const checkOpen = () => { if (closed) throw new Error("Native request controller disconnected; continuation denied"); };

  async function current(reference) {
    checkOpen();
    if (!isDeepStrictEqual(reference, latestReference)) throw new Error("Native input replaced; continuation denied");
    const request = await owner.assertRequest(reference);
    checkOpen();
    if (!isDeepStrictEqual(reference, latestReference)) throw new Error("Native input replaced; continuation denied");
    return request;
  }
  async function state(reference) {
    await current(reference);
    const live = await getState();
    await current(reference);
    owner.assertGateway(live);
    return live;
  }
  function view(reference, request, live) {
    checkOpen();
    if (!isDeepStrictEqual(reference, latestReference)) throw new Error("Native input replaced; continuation denied");
    return { schema: "statewright/executor-request-status/v1", reference,
      phase: request.phase, state: live, release_nonce: request.release_nonce,
      approval: request.approval ? { approval_id: request.approval.pending_approval.approval_id,
        event: request.approval.pending_approval.event } : null };
  }
  async function clearConsumed(reference, saved) {
    return approvalMirror.clearConsumed(saved, { assertConsumed: async () => {
      const request = await current(reference);
      if (!request.consumed_approval_ids.includes(saved.pending_approval.approval_id)) {
        throw new Error("Request approval was not durably consumed; journal clearance denied");
      }
    } });
  }
  async function status(reference) {
    let live = await state(reference);
    await approvalMirror.observe(live);
    await current(reference);
    const saved = await approvalMirror.loadCheckpoint();
    await current(reference);
    let request = owner.record.request;
    if (saved && request.consumed_approval_ids.includes(saved.pending_approval.approval_id)) {
      // Crash after durable consumption but before journal clear: repair only
      // the journal, never reissue the consumed native continuation.
      await clearConsumed(reference, saved);
      await current(reference);
    } else if (saved) {
      request = await owner.parkRequest(reference, saved);
      const decision = await approvalMirror.readDecision(saved);
      owner.assertGateway(decision.latest);
      live = decision.latest;
      await current(reference);
      if (decision.status === "rejected") {
        request = await owner.cancelRequest(reference, "rejected");
        return view(reference, request, decision.latest);
      }
      if (decision.status === "approved") request = await owner.readyRequest(reference);
    } else if (["parked", "ready"].includes(request.phase)) {
      // Missing durable gate is not cancellation or approval.
      throw new Error("Request approval journal disappeared; continuation denied");
    }
    live = await state(reference);
    request = await current(reference);
    if (["active", "ready"].includes(request.phase) && (live.pending_approval != null
      || request.phase === "ready" && live.state !== request.approval.pending_approval.to_state)) {
      throw new Error("Approval edge changed during request status; continuation denied");
    }
    return view(reference, request, live);
  }

  async function begin(body) {
    checkOpen();
    if (!exactKeys(body, ["native_session_id", "input_sequence", "input_digest"])
      || body.native_session_id !== owner.record.host_session_id
      || !Number.isSafeInteger(body.input_sequence) || body.input_sequence <= highestSequence
      || typeof body.input_digest !== "string" || !/^[a-f0-9]{64}$/.test(body.input_digest)) {
      throw new Error("Invalid or superseded native input; continuation denied");
    }
    const sequence = body.input_sequence;
    highestSequence = sequence;
    latestReference = null;
    const reference = await owner.beginRequest({ nativeSessionId: body.native_session_id, inputDigest: body.input_digest });
    if (sequence !== highestSequence || closed) {
      await owner.cancelRequest(reference, "superseded").catch(() => {});
      throw new Error("Native input superseded during admission; continuation denied");
    }
    latestReference = reference;
    return status(reference);
  }

  async function consume(body) {
    if (!exactKeys(body, ["reference", "release_nonce"])) throw new Error("Invalid release consumption request");
    const reference = body.reference;
    const request = await current(reference);
    if (request.phase !== "ready" || request.release_nonce !== body.release_nonce) throw new Error("Stale or consumed release; continuation denied");
    await state(reference);
    const decision = await approvalMirror.readDecision(request.approval);
    owner.assertGateway(decision.latest);
    await current(reference);
    if (decision.status !== "approved") throw new Error("Approval is not approved; continuation denied");
    await owner.consumeRequest(reference, body.release_nonce);
    try {
      await current(reference);
      await clearConsumed(reference, request.approval);
      const latestRequest = await current(reference);
      // Fresh owned state after all potentially waiting mutations, not the
      // earlier pre-consumption snapshot, is the admission result.
      const live = await state(reference);
      if (live.pending_approval != null || live.state !== request.approval.pending_approval.to_state) {
        throw new Error("Consumed transition changed before native admission; continuation denied");
      }
      return view(reference, latestRequest, live);
    } catch (error) {
      // Consumption without a successfully checked delivery is ambiguous.
      // Preserve its tombstone, but require fresh explicit input rather than
      // letting status() replay the old grant after a transient failure.
      if (isDeepStrictEqual(latestReference, reference)) latestReference = null;
      await owner.cancelRequest(reference, "release_delivery_failed").catch(() => {});
      throw error;
    }
  }

  return { begin, status, consume,
    async cancel(body) {
      if (!exactKeys(body, ["reference", "reason"]) || !["cancelled", "dismissed", "disconnected", "timeout", "superseded"].includes(body.reason)) {
        throw new Error("Invalid request cancellation");
      }
      checkOpen();
      if (!isDeepStrictEqual(body.reference, latestReference)) throw new Error("Native input replaced; continuation denied");
      latestReference = null;
      return owner.cancelRequest(body.reference, body.reason);
    },
    async close() {
      closed = true;
      const request = owner.record.request;
      if (request && !["cancelled", "completed"].includes(request.phase)) {
        await owner.cancelRequest(requestReference(request), "disconnected");
      }
    },
  };
}
