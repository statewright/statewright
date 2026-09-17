import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const equal = isDeepStrictEqual;
const uuid = value => typeof value === "string" && UUID.test(value);
const printable = value => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
const referenceKeys = ["native_session_id", "request_epoch", "request_id", "schema"];

function untilAborted(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function sleep(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Native callbacks wait outside inference; authority and epochs belong to parent. */
export function createPiRequestGate({ nativeSessionId, nativeSessionFile, call, onPark = () => {}, onActive = () => {}, onAdmit = () => {}, pollMs = 500, timeoutMs = 30 * 60_000 }) {
  if (typeof call !== "function" || !Number.isSafeInteger(pollMs) || pollMs < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid native request transport limits");
  let sequence = 0;
  let current = null;
  let closed = false;
  let enabled = false;
  function assertNative(ctx) {
    if (typeof ctx?.sessionManager?.getSessionId !== "function" || ctx.sessionManager.getSessionId() !== nativeSessionId
      || nativeSessionFile !== undefined && ctx.sessionManager.getSessionFile?.() !== nativeSessionFile) {
      throw new Error("Live native session changed; admission denied");
    }
  }
  const stop = (ctx, signal) => { try {
    assertNative(ctx);
    if (signal && ctx.signal !== signal) return;
    Promise.resolve(ctx?.abort?.()).catch(() => {});
  } catch { /* never abort a foreign native session or replacement operation */ } };
  const active = request => !closed && current === request && !request.controller.signal.aborted;
  const notify = (ctx, message) => { try { ctx?.ui?.notify?.(message, "warning"); } catch { /* never fail open */ } };

  function validate(result, request, ctx) {
    assertNative(ctx);
    if (!active(request) || result?.schema !== "statewright/executor-request-status/v1"
      || result.reference?.schema !== "statewright/executor-request-ref/v1"
      || !equal(Object.keys(result.reference).sort(), referenceKeys)
      || !uuid(result.reference.request_id) || !Number.isSafeInteger(result.reference.request_epoch) || result.reference.request_epoch < 1
      || result.reference.native_session_id !== nativeSessionId
      || request.reference && !equal(request.reference, result.reference)
      || !["active", "parked", "ready", "cancelled"].includes(result.phase)
      || !result.state || ![result.state.run_id, result.state.run_session_id, result.state.workflow, result.state.state]
        .every(printable)
      || request.identity && !equal(request.identity, [result.state.run_id, result.state.run_session_id, result.state.workflow])
      || ["active", "ready"].includes(result.phase) && result.state.pending_approval != null
      || (result.phase === "ready" ? !uuid(result.release_nonce) || !printable(result.approval?.approval_id) : result.release_nonce !== null)) {
      throw new Error("Foreign, stale or malformed parent request status; inference held");
    }
    request.reference ??= result.reference;
    request.identity ??= [result.state.run_id, result.state.run_session_id, result.state.workflow];
    request.phase = result.phase;
    return result;
  }

  async function cancelRequest(request, reason) {
    if (!request || request.controller.signal.aborted) return;
    request.phase = "cancelled";
    request.controller.abort(reason);
    if (request.reference) {
      const signal = AbortSignal.timeout(Math.min(timeoutMs, 5_000));
      try { await untilAborted(() => call("cancel", { reference: request.reference, reason }, signal), signal); } catch { /* durable epoch/parent close also invalidate */ }
    }
  }

  async function wait(request, ctx, initial, operationSignal) {
    const signal = AbortSignal.any([request.controller.signal, AbortSignal.timeout(timeoutMs), ...(operationSignal ? [operationSignal] : [])]);
    let result = initial;
    try {
      for (;;) {
        signal.throwIfAborted();
        assertNative(ctx);
        if (!active(request)) throw new Error("Native input replaced");
        result = validate(result ?? await untilAborted(() => { assertNative(ctx); return call("status", { reference: request.reference }, signal); }, signal), request, ctx);
        if (result.phase === "cancelled") throw new Error("Request rejected or cancelled");
        if (result.phase === "ready") {
          const approvalId = result.approval.approval_id;
          result = validate(await untilAborted(() => { assertNative(ctx); return call("consume", { reference: request.reference, release_nonce: result.release_nonce }, signal); }, signal), request, ctx);
          if (result.phase !== "active") throw new Error("Parent did not consume the current release");
          request.consumedApprovalIds.add(approvalId);
        }
        if (result.phase === "active") {
          if (!active(request)) throw new Error("Native input replaced after release");
          onActive(result.state);
          assertNative(ctx);
          if (!active(request)) throw new Error("Native input replaced before admission");
          return true;
        }
        try { onPark(); } catch { /* native callback still waits */ }
        assertNative(ctx);
        notify(ctx, `[statewright] Approval ${result.approval?.approval_id ?? "pending"} awaits an authorized human; inference is parked.`);
        await sleep(pollMs, signal);
        result = null;
      }
    } catch {
      const reason = signal.reason?.name === "TimeoutError" ? "timeout" : !active(request) ? "superseded" : operationSignal?.aborted ? "cancelled" : "disconnected";
      await cancelRequest(request, reason);
      // SDK contexts resolve abort() against the currently active agent. An
      // old response must not abort the replacement input's agent.
      if (current === request) stop(ctx, operationSignal);
      return false;
    }
  }

  return {
    get reference() { return current?.reference ? structuredClone(current.reference) : null; },
    get held() { return !current?.admitted || current.phase !== "active" || !active(current); },
    ownsNative(ctx) { try { assertNative(ctx); return enabled && !closed; } catch { return false; } },
    ownsRequest(ctx, reference) {
      try {
        assertNative(ctx);
        return !!current?.admitted && active(current) && current.phase === "active"
          && !!current.reference && equal(current.reference, reference);
      } catch { return false; }
    },
    hasConsumedApproval(ctx, reference, approvalId) {
      return typeof approvalId === "string" && this.ownsRequest(ctx, reference)
        && current.consumedApprovalIds.has(approvalId);
    },
    canDispatch(ctx, operationSignal, reference, { compaction = false } = {}) {
      try {
        assertNative(ctx);
        return !!current?.admitted && active(current) && current.phase === "active"
          && !!current.reference && equal(current.reference, reference)
          && operationSignal instanceof AbortSignal && !operationSignal.aborted
          && (compaction || ctx.signal === operationSignal);
      } catch { return false; }
    },
    enable() { if (!closed) enabled = true; },
    async input(event, ctx) {
      try {
        if (!enabled || closed || !uuid(nativeSessionId) || sequence >= Number.MAX_SAFE_INTEGER) return { action: "handled" };
        assertNative(ctx);
      } catch {
        await cancelRequest(current, "disconnected");
        return { action: "handled" }; // SDK input exceptions otherwise fail open.
      }
      const previous = current;
      // Synchronous invalidation precedes every potentially waiting network or
      // idle operation. Old responses cannot become the new input's authority.
      if (previous) void cancelRequest(previous, "superseded");
      const request = { sequence: ++sequence, controller: new AbortController(), reference: null, identity: null, phase: "parked", admitted: false,
        consumedApprovalIds: new Set() };
      current = request;
      try {
        if (typeof ctx?.isIdle !== "function") throw new Error("Native idle boundary unavailable; admission denied");
        if (previous || ctx.isIdle() !== true) stop(ctx);
        const inputDigest = createHash("sha256").update(JSON.stringify({ text: event.text, images: event.images ?? null })).digest("hex");
        const signal = AbortSignal.any([request.controller.signal, AbortSignal.timeout(timeoutMs)]);
        const result = await untilAborted(() => { assertNative(ctx); return call("begin", { native_session_id: nativeSessionId, input_sequence: request.sequence, input_digest: inputDigest }, signal); }, signal);
        if (!active(request)) return { action: "handled" };
        if (!await wait(request, ctx, result)) return { action: "handled" };
        // SDK ctx.abort() discards its idle promise. Never hand input back to
        // SDK's steering/follow-up queues while the interrupted agent remains
        // active, including its awaited agent_end listeners.
        while (ctx.isIdle() !== true) {
          signal.throwIfAborted();
          assertNative(ctx);
          if (!active(request)) throw new Error("Native input replaced while awaiting idle");
          await sleep(pollMs, signal);
        }
        signal.throwIfAborted();
        assertNative(ctx);
        if (!active(request)) throw new Error("Native input replaced at admission handoff");
        request.admitted = true;
        onAdmit(structuredClone(request.reference));
        assertNative(ctx);
        if (!active(request)) throw new Error("Native input replaced during private binding");
        return { action: "continue" };
      } catch (error) {
        await cancelRequest(request, error?.name === "TimeoutError" ? "timeout" : "disconnected");
        if (current === request) stop(ctx);
        return { action: "handled" };
      }
    },
    async checkpoint(ctx, operationSignal, reference) {
      const request = current;
      try {
        if (!request?.admitted || !active(request) || !request.reference || !equal(request.reference, reference)) {
          // Without the private reference this callback has no authority to
          // abort either. SDK contexts expose a lazy current-operation signal.
          return false;
        }
      } catch { return false; } // No ownership established: no cancellation.
      try {
        assertNative(ctx);
        operationSignal ??= ctx?.signal;
        if (!await wait(request, ctx, null, operationSignal)) return false;
        assertNative(ctx);
        if (!active(request)) throw new Error("Native request replaced at checkpoint handoff");
        return true;
      } catch {
        await cancelRequest(request, "disconnected");
        if (current === request) stop(ctx, operationSignal);
        return false;
      }
    },
    async cancel(reason = "cancelled") { await cancelRequest(current, reason); },
    async close() { closed = true; await cancelRequest(current, "disconnected"); },
  };
}
