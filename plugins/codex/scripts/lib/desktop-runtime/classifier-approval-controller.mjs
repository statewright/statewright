import { randomUUID } from "node:crypto";
import { approvalAsk, approvalDeny, approvalNotHandled } from "./approval-pipeline.mjs";

const REWORKABLE_BASES = new Set([
  "semantic_threshold_not_met",
  "incomplete_structural_evidence",
  "semantic_vector_unavailable",
  "semantic_assessment_incomplete",
  "semantic_authorization_disabled",
]);

function printable(value, maximum = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function boundedIdentity(value, prefix) {
  return printable(value) && value.startsWith(prefix) ? value : null;
}

export function classifierApprovalRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.schema !== "statewright/classifier-approval-request/v2") return null;
  const receipt = value.classifier_receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const threadId = printable(value.thread_id) ? value.thread_id : null;
  const runId = printable(value.run_id) ? value.run_id : null;
  const runSessionId = printable(value.run_session_id) ? value.run_session_id : null;
  const state = printable(value.state) ? value.state : null;
  const stateEpoch = Number.isSafeInteger(value.state_epoch) && value.state_epoch >= 0
    ? value.state_epoch : null;
  const intentFingerprint = boundedIdentity(receipt.intent_fingerprint, "intent_v1_");
  const invocationFingerprint = boundedIdentity(receipt.invocation_fingerprint, "invocation_v1_");
  const basis = printable(receipt.final_denial_basis)
    ? receipt.final_denial_basis
    : printable(receipt.resolution_basis) ? receipt.resolution_basis : null;
  const requiredAuthority = printable(receipt.required_authority)
    ? receipt.required_authority : null;
  const reformulationAllowed = receipt.reformulation_allowed === true;
  const exactInvocationRetryAllowed = receipt.exact_invocation_retry_allowed === false
    ? false : null;
  const separateApprovalAllowed = receipt.separate_approval_allowed === true;
  if (!threadId || !runId || !runSessionId || !state || stateEpoch === null
      || !intentFingerprint || !invocationFingerprint || !basis) return null;
  if (!REWORKABLE_BASES.has(basis)
      || requiredAuthority !== "complete_structural_evidence_or_separate_approval"
      || !reformulationAllowed
      || exactInvocationRetryAllowed !== false
      || !separateApprovalAllowed) return null;
  return Object.freeze({threadId, runId, runSessionId, state, stateEpoch, intentFingerprint,
    invocationFingerprint, basis, requiredAuthority, reformulationAllowed,
    exactInvocationRetryAllowed, separateApprovalAllowed});
}

/**
 * Process-resident retry accounting and one-use native approval for classifier
 * uncertainty. Only gateway-issued redacted identities enter this controller;
 * raw commands and tool arguments stay in the short-lived hook process.
 */
export class ClassifierApprovalController {
  constructor({send, record = async () => {}, maxReworks = 2,
    ttlMs = 10 * 60_000, approvalTimeoutMs = 10 * 60_000,
    now = () => Date.now(), getState = null} = {}) {
    if (typeof send !== "function") throw new Error("Classifier approval requires a native sender");
    if (!Number.isSafeInteger(maxReworks) || maxReworks < 1 || maxReworks > 10) {
      throw new Error("Classifier rework budget must be between 1 and 10");
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000) {
      throw new Error("Classifier rework TTL must be at least one second");
    }
    if (!Number.isSafeInteger(approvalTimeoutMs) || approvalTimeoutMs < 10) {
      throw new Error("Classifier approval timeout must be at least ten milliseconds");
    }
    if (getState !== null && typeof getState !== "function") {
      throw new Error("Classifier approval state reader must be a function");
    }
    Object.assign(this, {send, record, maxReworks, ttlMs, approvalTimeoutMs, now, getState});
    this.entries = new Map();
    this.requests = new Map();
  }

  prune(timestamp = this.now()) {
    for (const [key, entry] of this.entries) {
      if (timestamp - entry.updatedAt >= this.ttlMs && !entry.pending) this.entries.delete(key);
    }
  }

  key(request) {
    return JSON.stringify([request.threadId, request.runId, request.runSessionId,
      request.state, request.stateEpoch, request.intentFingerprint, request.basis,
      request.requiredAuthority, request.reformulationAllowed,
      request.exactInvocationRetryAllowed, request.separateApprovalAllowed]);
  }

  emit(event) {
    void Promise.resolve().then(() => this.record(event)).catch(() => {});
  }

  result(request, action, details = {}) {
    return Object.freeze({schema: "statewright/classifier-approval/v2", action,
      thread_id: request.threadId, run_id: request.runId,
      run_session_id: request.runSessionId, state: request.state,
      state_epoch: request.stateEpoch,
      intent_fingerprint: request.intentFingerprint,
      invocation_fingerprint: request.invocationFingerprint,
      basis: request.basis, required_authority: request.requiredAuthority,
      reformulation_allowed: request.reformulationAllowed,
      exact_invocation_retry_allowed: request.exactInvocationRetryAllowed,
      separate_approval_allowed: request.separateApprovalAllowed,
      ...details});
  }

  async begin(value, {signal} = {}) {
    if (value?.schema !== "statewright/classifier-approval-request/v2") {
      return approvalNotHandled();
    }
    const request = classifierApprovalRequest(value);
    if (!request) return approvalDeny(Object.freeze({schema: "statewright/classifier-approval/v2",
      action: "deny", reason: "invalid_redacted_classifier_receipt"}));
    if (signal?.aborted) return approvalDeny(
      this.result(request, "deny", {reason: "approval_request_aborted"}));
    const timestamp = this.now();
    this.prune(timestamp);
    const key = this.key(request);
    const entry = this.entries.get(key) ?? {attempts: 0, updatedAt: timestamp,
      pending: null, seenInvocations: new Set(), denied: false};
    if (entry.denied) {
      return approvalDeny(this.result(request, "deny", {reason: "approval_previously_denied",
        prior_reason: entry.denialReason}));
    }
    if (entry.pending) {
      return approvalDeny(this.result(request, "deny", {reason: "approval_already_pending"}));
    }
    if (entry.seenInvocations.has(request.invocationFingerprint)) {
      return approvalDeny(this.result(request, "deny", {reason: "exact_invocation_already_observed",
        attempts: entry.attempts, max_reworks: this.maxReworks}));
    }
    entry.seenInvocations.add(request.invocationFingerprint);
    entry.attempts += 1;
    entry.updatedAt = timestamp;
    this.entries.set(key, entry);
    if (entry.attempts <= this.maxReworks) {
      this.emit({type: "classifier_rework_requested", threadId: request.threadId,
        run_id: request.runId, state: request.state, basis: request.basis,
        attempts: entry.attempts, max_reworks: this.maxReworks});
      return approvalDeny(this.result(request, "rework", {attempts: entry.attempts,
        max_reworks: this.maxReworks}));
    }

    const requestId = `statewright-classifier-approval-${randomUUID()}`;
    const pending = {request, requestId, settled: false, presented: false, signal};
    pending.promise = new Promise(resolve => { pending.resolve = resolve; });
    entry.pending = pending;
    const container = {key, entry, pending};
    this.requests.set(requestId, container);
    pending.abort = () => this.finish(container, "deny", "approval_request_aborted");
    signal?.addEventListener("abort", pending.abort, {once: true});
    pending.timer = setTimeout(() => this.finish(container, "deny", "native_approval_timeout"),
      this.approvalTimeoutMs);
    pending.timer.unref?.();
    this.emit({type: "classifier_human_approval_requested", threadId: request.threadId,
      run_id: request.runId, state: request.state, basis: request.basis,
      attempts: entry.attempts, max_reworks: this.maxReworks});
    try {
      this.send({id: requestId, method: "mcpServer/elicitation/request", params: {
        threadId: request.threadId, turnId: null, serverName: "statewright", mode: "form",
        message: `Statewright could not prove this exact invocation after ${this.maxReworks} rewrites.\nPhase: ${request.state}\nClassifier axis: ${request.basis}\nRequired authority: ${request.requiredAuthority}\nAllow this exact invocation once?`,
        requestedSchema: {type: "object", properties: {}},
      }});
      pending.presented = true;
    } catch {
      this.finish(container, "deny", "native_approval_unavailable");
    }
    return approvalAsk(pending.promise);
  }

  finish(container, action, reason) {
    const {key, entry, pending} = container;
    if (pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.abort);
    this.requests.delete(pending.requestId);
    entry.pending = null;
    entry.updatedAt = this.now();
    if (action === "allow_once") this.entries.delete(key);
    else {
      entry.denied = true;
      entry.denialReason = reason;
    }
    if (pending.presented) {
      try {
        this.send({method: "serverRequest/resolved", params: {
          threadId: pending.request.threadId, requestId: pending.requestId,
        }});
      } catch {}
    }
    this.emit({type: action === "allow_once"
      ? "classifier_human_approval_granted" : "classifier_human_approval_denied",
    threadId: pending.request.threadId, run_id: pending.request.runId,
    state: pending.request.state, basis: pending.request.basis, reason});
    pending.resolve(this.result(pending.request, action, {reason,
      approval_request_id: pending.requestId, attempts: entry.attempts,
      max_reworks: this.maxReworks}));
  }

  handleReply(reply) {
    if (reply?.method || typeof reply?.id !== "string"
        || !reply.id.startsWith("statewright-classifier-approval-")) return false;
    const container = this.requests.get(reply.id);
    if (!container) return true;
    const action = reply.result?.action;
    if (!reply.error && action === "accept") void this.finishAccepted(container);
    else this.finish(container, "deny", reply.error ? "native_approval_error"
      : action === "decline" ? "human_declined" : "human_cancelled");
    return true;
  }

  async finishAccepted(container) {
    if (!this.getState) {
      this.finish(container, "deny", "approval_state_unavailable");
      return;
    }
    const request = container.pending.request;
    let state;
    try {
      state = await this.getState(request.threadId);
    } catch {
      this.finish(container, "deny", "approval_state_unavailable");
      return;
    }
    if (!state || state.is_final === true || state.pending_approval
        || state.run_id !== request.runId
        || state.run_session_id !== request.runSessionId
        || state.state !== request.state || state.state_epoch !== request.stateEpoch) {
      this.finish(container, "deny", "approval_state_changed");
      return;
    }
    this.finish(container, "allow_once", "human_approved");
  }

  close(reason = "provider_connection_closed") {
    for (const container of [...this.requests.values()]) this.finish(container, "deny", reason);
  }
}
