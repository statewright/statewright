import { randomUUID } from "node:crypto";
import { approvalDisplayContext, interactionValue } from "./human-interaction.mjs";
import { approvalAsk, approvalDeny, approvalAllow, approvalNotHandled } from "./approval-pipeline.mjs";
import {approvalMemoryContext} from "./approval-memory.mjs";

const REWORKABLE_BASES = new Set([
  "semantic_threshold_not_met",
  "incomplete_structural_evidence",
  "semantic_vector_unavailable",
  "semantic_assessment_incomplete",
  "semantic_authorization_disabled",
  "external_effect_unresolved",
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
  const memoryContext=approvalMemoryContext(value.approval_memory);
  const sessionGeneration=printable(value.session_generation)?value.session_generation:null;
  if(memoryContext?.reusable&&!sessionGeneration)return null;
  if (!threadId || !runId || !runSessionId || !state || stateEpoch === null
      || !intentFingerprint || !invocationFingerprint || !basis) return null;
  if (!REWORKABLE_BASES.has(basis)
      || requiredAuthority !== "complete_structural_evidence_or_separate_approval"
      || !reformulationAllowed
      || exactInvocationRetryAllowed !== false
      || !separateApprovalAllowed) return null;
  return Object.freeze({threadId, runId, runSessionId, state, stateEpoch, intentFingerprint,
    invocationFingerprint, basis, requiredAuthority, reformulationAllowed,
    exactInvocationRetryAllowed, separateApprovalAllowed,
    memoryContext,sessionGeneration,
    displayContext: approvalDisplayContext(value),
    reviewContext: interactionValue(receipt.review_context ?? null)});
}

export function classifierReviewMessage(request) {
  const display = request.displayContext;
  const reasons = {
    semantic_authorization_disabled: "The built-in checks did not prove this request's effects. Semantic assessments cannot authorize commands in this environment, so this request needs your review.",
    incomplete_structural_evidence: "The command's structure or the effects of a referenced script could not be fully verified. Review the command and its dependencies before allowing it.",
    semantic_vector_unavailable: "The semantic assessor returned no usable judgment for this invocation.",
    semantic_assessment_incomplete: "The semantic assessment did not complete successfully.",
    semantic_threshold_not_met: "The semantic assessment did not establish a sufficiently safe effect for this invocation.",
    external_effect_unresolved: "The command reaches an external service, but its effects could not be determined. Remote transport alone is not the concern; the delegated operation remains unverified.",
  };
  const lines = ["Statewright approval", `Tool: ${display?.tool ?? "unavailable"}`];
  if (display?.command) lines.push(`Command: ${display.command}`);
  if (display?.details) lines.push(`Request: ${JSON.stringify(display.details, null, 2)}`);
  if (JSON.stringify(display?.details ?? {}).includes("_statewright_omitted_items")) {
    lines.push("Some actions are omitted above; this card does not display the entire request.");
  }
  if (display?.cwd) lines.push(`Working directory: ${display.cwd}`);
  lines.push("", `Why review: ${reasons[request.basis] ?? "The request has an unresolved effect."}`);
  const structure = request.reviewContext?.execution_structure;
  if (Array.isArray(structure)) {
    for (const node of structure.slice(0, 4)) {
      const label = [node.executable, node.operation].filter(value => typeof value === "string").join(" ");
      if (label) lines.push(`Parsed operation: ${label}; location: ${node.location ?? "unknown"}.`);
      if (node.syntax_complete === false) lines.push("Missing evidence: CLI options or delegated execution could not be fully decomposed.");
      if (node.operand_values_omitted) lines.push("Argument values were omitted from model evidence; the model did not see the full invocation.");
    }
  }
  if (!display?.command && !display?.details) lines.push("Request details were not supplied by this client; the scope cannot be inspected here.");
  const duration = request.effectiveDuration ?? "once";
  const remember = duration === "always" ? "until revoked" : `for ${duration.replace("h", " hours")}`;
  lines.push(`Phase: ${request.state}`, duration === "once"
    ? "Allow this exact invocation once?"
    : `Allow this exact invocation and remember it ${remember}, while its request, source evidence and policy match?`);
  if (request.memoryUnavailableReason) lines.push(request.memoryUnavailableReason);
  return lines.join("\n");
}

/**
 * Process-resident retry accounting and one-use native approval for classifier
 * uncertainty. Only gateway-issued redacted identities enter this controller;
 * raw commands and tool arguments stay in the short-lived hook process.
 */
export class ClassifierApprovalController {
  constructor({send, record = async () => {}, maxReworks = 0,
    ttlMs = 10 * 60_000, approvalTimeoutMs = 10 * 60_000,
    now = () => Date.now(), getState = null, memory = null} = {}) {
    if (typeof send !== "function") throw new Error("Classifier approval requires a native sender");
    if (!Number.isSafeInteger(maxReworks) || maxReworks < 0 || maxReworks > 10) {
      throw new Error("Classifier rework budget must be between 0 and 10");
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
    Object.assign(this, {send, record, maxReworks, ttlMs, approvalTimeoutMs, now, getState, memory});
    this.entries = new Map();
    this.requests = new Map();
    this.closedReason=null;
  }

  prune(timestamp = this.now()) {
    for (const [key, entry] of this.entries) {
      if (timestamp - entry.updatedAt >= this.ttlMs && !entry.pending) this.entries.delete(key);
    }
  }

  key(request) {
    return JSON.stringify([request.threadId, request.runId, request.runSessionId,
      request.state, request.stateEpoch, request.sessionGeneration,request.intentFingerprint, request.basis,
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
      ...(request.sessionGeneration?{session_generation:request.sessionGeneration}:{}),
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
    if(this.closedReason)return approvalDeny(this.result(request,"deny",{reason:this.closedReason}));
    if (signal?.aborted) return approvalDeny(
      this.result(request, "deny", {reason: "approval_request_aborted"}));
    if (this.memory && request.memoryContext?.reusable && request.memoryContext.approve_for !== "once") {
      if (!await this.current(request)) return approvalDeny(this.result(request,"deny",{reason:"approval_state_changed"}));
      try {
        const grant = await this.memory.lookup(request.memoryContext);
        if (grant && grant.duration === request.memoryContext.approve_for && request.memoryContext.allowed_durations.includes(grant.duration)) {
          const current=await this.current(request);
          if (signal?.aborted || !current) return approvalDeny(this.result(request,"deny",{reason:"approval_state_changed"}));
          const valid=await this.memory.confirm(request.memoryContext,grant);
          if(!valid||signal?.aborted||this.closedReason)return approvalDeny(this.result(request,"deny",{reason:"approval_memory_no_longer_valid"}));
          this.emit({type:"classifier_approval_memory_reused",threadId:request.threadId,
            run_id:request.runId,state:request.state,grant_id:grant.id,duration:grant.duration,
            invocation_fingerprint:request.invocationFingerprint});
          return approvalAllow(this.result(request,"allow_once",{reason:"remembered_human_approval",
            grant_id:grant.id,duration:grant.duration,expires_at:grant.expires_at}));
        }
      } catch {
        // An unavailable/corrupt store cannot grant execution. A fresh human
        // may still approve once through the ordinary dialog.
        this.emit({type:"classifier_approval_memory_unavailable",threadId:request.threadId,run_id:request.runId});
      }
    }
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
    const configuredDuration=request.memoryContext?.approve_for ?? "once";
    const reusable=Boolean(this.memory && request.memoryContext?.reusable);
    const effectiveDuration=reusable ? configuredDuration : "once";
    const memoryUnavailableReason = !request.memoryContext
      ? "The request did not include a valid approval-memory policy and binding; only a one-time approval is available."
      : configuredDuration !== "once" && !reusable
        ? (!this.memory ? "The configured reusable approval is unavailable: the approval store is unavailable."
          : "The configured reusable approval is unavailable: supporting source provenance is incomplete.") : null;
    const pending = {request, requestId, settled: false, presented: false, signal, effectiveDuration};
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
      const sent = this.send({id: requestId, method: "mcpServer/elicitation/request", params: {
        threadId: request.threadId, turnId: null, serverName: "statewright", mode: "form",
        message: classifierReviewMessage({...request,effectiveDuration,memoryUnavailableReason}),
        requestedSchema: {type: "object", properties: {}},
      }});
      // A queued send is not proof of presentation. Observe asynchronous
      // transport failures without stalling abort/timeout processing.
      void Promise.resolve(sent).then(() => {
        pending.presented = true;
        if (pending.settled) this.dismiss(pending);
      }, () => this.finish(container, "deny", "native_approval_unavailable"));
    } catch {
      this.finish(container, "deny", "native_approval_unavailable");
    }
    return approvalAsk(pending.promise);
  }

  dismiss(pending) {
    try {
      void Promise.resolve(this.send({method: "serverRequest/resolved", params: {
        threadId: pending.request.threadId, requestId: pending.requestId,
      }})).catch(() => {});
    } catch {}
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
      this.dismiss(pending);
    }
    this.emit({type: action === "allow_once"
      ? "classifier_human_approval_granted" : "classifier_human_approval_denied",
    threadId: pending.request.threadId, run_id: pending.request.runId,
    state: pending.request.state, basis: pending.request.basis, reason,
    approval_request_id: pending.requestId,
    invocation_fingerprint: pending.request.invocationFingerprint,
    display_context: pending.request.displayContext});
    pending.resolve(this.result(pending.request, action, {reason,
      ...(pending.grant?{grant_id:pending.grant.id,duration:pending.grant.duration,expires_at:pending.grant.expires_at}:{}),
      approval_request_id: pending.requestId, attempts: entry.attempts,
      max_reworks: this.maxReworks}));
  }

  handleReply(reply) {
    if (reply?.method || typeof reply?.id !== "string"
        || !reply.id.startsWith("statewright-classifier-approval-")) return false;
    const container = this.requests.get(reply.id);
    if (!container) return true;
    const action = reply.result?.action;
    if (!reply.error && action === "accept") {
      const supplied=reply.result?.content?.duration;
      if (supplied !== undefined && supplied !== container.pending.effectiveDuration) {
        this.finish(container,"deny","approval_duration_invalid");
      } else void this.finishAccepted(container,container.pending.effectiveDuration);
    }
    else this.finish(container, "deny", reply.error ? "native_approval_error"
      : action === "decline" ? "human_declined" : "human_cancelled");
    return true;
  }

  async current(request) {
    try {
      const state=await this.getState?.(request.threadId);
      return state && !state.is_final && !state.pending_approval && state.run_id===request.runId
        && state.run_session_id===request.runSessionId && state.state===request.state && state.state_epoch===request.stateEpoch
        && (!request.sessionGeneration || state.session_generation===request.sessionGeneration)
        && (!request.memoryContext || state.approval_memory_policy?.policy_sha256===request.memoryContext.policy_sha256
          && (state.approval_memory_policy?.approve_for ?? "once") === request.memoryContext.approve_for
          && request.memoryContext.allowed_durations.every(d=>d==="once"||state.approval_memory_policy?.allowed_durations?.includes(d)));
    }catch{return false;}
  }

  async finishAccepted(container,duration="once") {
    const pending=container.pending;
    if(pending.settled||pending.accepting)return;
    pending.accepting=true;
    if(duration!==pending.effectiveDuration) {this.finish(container,"deny","approval_duration_invalid");return;}
    if (!this.getState) {
      this.finish(container, "deny", "approval_state_unavailable");
      return;
    }
    const request = container.pending.request;
    if(request.memoryContext||request.sessionGeneration) {
      if(!await this.current(request)){this.finish(container,"deny","approval_state_changed");return;}
      if(pending.settled)return;
      if(duration!=="once") {
        let grant;
        try {
          grant=await this.memory.remember(request.memoryContext,duration);
          if(pending.settled||!await this.current(request)) {
            await this.memory.revoke(grant.id);
            if(!pending.settled)this.finish(container,"deny","approval_state_changed");
            return;
          }
          this.emit({type:"classifier_approval_memory_created",threadId:request.threadId,
            run_id:request.runId,state:request.state,grant_id:grant.id,duration,expires_at:grant.expires_at});
          pending.grant=grant;
        } catch {this.finish(container,"deny","approval_memory_write_failed");return;}
      }
      this.finish(container,"allow_once","human_approved");return;
    }
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
    this.closedReason=reason;
    for (const container of [...this.requests.values()]) this.finish(container, "deny", reason);
  }
}
