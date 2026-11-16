import { randomUUID } from "node:crypto";
import { classifierApprovalRequest, classifierReviewMessage } from "./classifier-approval-controller.mjs";
import { digestJson } from "./native-mcp-approval-binding.mjs";

const safeId = value => typeof value === "string" && value.length > 0 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;

function requestFromAdapter(body, result, fallbackSession) {
  const context = result?.classifier_context;
  if (result?.decision !== "deny" || !context || !result.risk_assessment) return null;
  return classifierApprovalRequest({
    schema: "statewright/classifier-approval-request/v2",
    thread_id: safeId(body.session_id) ?? fallbackSession,
    run_id: context.run_id,
    run_session_id: context.run_session_id,
    state: context.state,
    state_epoch: context.state_epoch,
    session_generation: context.session_generation,
    approval_memory: context.approval_memory,
    classifier_receipt: result.risk_assessment,
    tool_name: body.tool_name,
    tool_input: body.tool_input,
  });
}

function bindingKey(request) {
  const memory = request.memoryContext;
  return memory && JSON.stringify([memory.grant_policy_v2_sha256 ?? memory.policy_sha256,
    memory.invocation_sha256, memory.dependency_sha256]);
}

/** Claude owns the final permission decision. These observations may remember
 * a human-approved execution, but never issue an allow to the host. */
export class ClaudeClassifierApproval {
  constructor({memory = null, reworkGate, getState, owner = null, record = () => {},
    sessionId, now = Date.now}) {
    this.memory = memory;
    this.reworkGate = reworkGate;
    this.getState = getState;
    this.owner = owner;
    this.record = record;
    this.sessionId = sessionId;
    this.now = now;
    this.pending = new Map();
    this.previouslyRemembered = new Set();
    this.recordChain = Promise.resolve();
  }

  emit(type, request, fields = {}) {
    const memory = request.memoryContext;
    const event = {
      type, provider: "claude-code", host: "claude-code", threadId: request.threadId,
      run_id: request.runId, run_session_id: request.runSessionId, state: request.state,
      state_epoch: request.stateEpoch, basis: request.basis,
      intent_fingerprint: request.intentFingerprint,
      invocation_fingerprint: request.invocationFingerprint,
      ...(memory ? {policy_sha256: memory.policy_sha256,
        policy_fingerprint: memory.policy_sha256,
        invocation_sha256: memory.invocation_sha256,
        ...(memory.grant_policy_v2_sha256 ? {grant_policy_v2_sha256: memory.grant_policy_v2_sha256} : {}),
        dependency_sha256: memory.dependency_sha256} : {}),
      timestamp: new Date(this.now()).toISOString(),
      ...fields,
    };
    this.recordChain = this.recordChain.then(() => this.record(event)).catch(() => {});
    return event;
  }

  async current(request) {
    try {
      await this.owner?.assertOwner?.();
      const state = await this.getState();
      await this.owner?.assertOwner?.();
      this.owner?.assertGateway?.(state);
      const memory = request.memoryContext;
      return !!state && state.is_final !== true && !state.pending_approval
        && state.run_id === request.runId && state.run_session_id === request.runSessionId
        && state.state === request.state && state.state_epoch === request.stateEpoch
        && (!request.sessionGeneration || state.session_generation === request.sessionGeneration)
        && (!memory || state.approval_memory_policy?.policy_sha256 === memory.policy_sha256
          && (state.approval_memory_policy?.approve_for ?? "once") === memory.approve_for
          && memory.allowed_durations.every(duration => duration === "once"
            || state.approval_memory_policy?.allowed_durations?.includes(duration))
          && (!memory.grant_policy_v2_sha256 || state.approval_memory_policy?.grant_policy_v2_sha256
            === memory.grant_policy_v2_sha256));
    } catch { return false; }
  }

  unresolved(sessionId, reason) {
    if (!safeId(sessionId)) return;
    for (const [key, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(key);
      this.emit("classifier_human_approval_unresolved", pending.request, {
        approval_request_id: pending.requestId, decision: "unresolved", reason,
        duration: pending.duration,
      });
    }
  }

  async preTool(body, result, scope) {
    const prior = this.pending.get(JSON.stringify([body.session_id, body.tool_use_id]));
    if (prior) {
      this.pending.delete(JSON.stringify([body.session_id, body.tool_use_id]));
      this.emit("classifier_human_approval_unresolved", prior.request, {
        approval_request_id: prior.requestId, decision: "unresolved",
        reason: "duplicate_pre_tool_without_matching_post_tool", duration: prior.duration,
      });
    }
    const request = requestFromAdapter(body, result, this.sessionId);
    const receipt = result?.risk_assessment ?? result?.riskAssessment;
    if (!request) {
      const rework = result?.decision === "deny" || result?.decision === "block"
        ? this.reworkGate.observeDenial({receipt, scope})
        : (this.reworkGate.observeSuccess({receipt, scope}), null);
      return {result, rework};
    }

    const memory = request.memoryContext;
    let invocationHash = null;
    try { invocationHash = digestJson([body.tool_name, body.tool_input]); }
    catch { /* A non-JSON invocation can only receive a one-time review. */ }
    const invocationMatches = Boolean(invocationHash && memory?.invocation_sha256 === invocationHash);
    const sessionId = safeId(body.session_id);
    const toolUseId = safeId(body.tool_use_id);
    const reusable = Boolean(this.memory && this.owner && memory?.reusable
      && memory.approve_for !== "once" && invocationMatches && sessionId && toolUseId);
    let memoryAvailable = reusable;
    if (reusable) {
      if (!await this.current(request)) return {result: {...result, reason: "approval_state_changed"}, rework: null};
      try {
        const grant = await this.memory.lookup(memory);
        if (grant && grant.duration === memory.approve_for
            && memory.allowed_durations.includes(grant.duration)) {
          if (!await this.current(request) || !await this.memory.confirm(memory, grant)
              || !await this.current(request)) {
            return {result: {...result, reason: "approval_memory_no_longer_valid"}, rework: null};
          }
          this.previouslyRemembered.add(bindingKey(request));
          this.emit("classifier_approval_memory_reused", request, {
            decision: "defer", actor_source: "local_grant_with_gateway_clearance",
            grant_id: grant.id, duration: grant.duration,
            expires_at: grant.expires_at,
          });
          return {result: {...result, decision: "defer", reason: undefined,
            classifier_approval: {action: "reused", grant_id: grant.id,
              duration: grant.duration, expires_at: grant.expires_at}}, rework: null};
        }
      } catch {
        memoryAvailable = false;
        this.emit("classifier_approval_memory_unavailable", request, {decision: "deny"});
      }
    }

    const rework = this.reworkGate.observeDenial({receipt, scope});
    const renewal = rework?.action === "exact_invocation_denied"
      && this.previouslyRemembered.has(bindingKey(request));
    if (rework?.action !== "approval_required" && !renewal) return {result, rework};
    if (!await this.current(request)) return {result: {...result, reason: "approval_state_changed"}, rework};

    const duration = memoryAvailable ? memory.approve_for : "once";
    const memoryUnavailableReason = duration !== "once" ? null : memory?.approve_for === "once" ? null
      : !memory ? "The request did not include a valid approval-memory binding; only a one-time approval is available."
        : !memory.reusable ? "Supporting source provenance is incomplete; only a one-time approval is available."
          : !invocationMatches ? "The current invocation does not match its gateway binding; only a one-time approval is available."
            : !sessionId || !toolUseId ? "Claude did not provide a tool identity; only a one-time approval is available."
              : "The approval store is unavailable; only a one-time approval is available.";
    const reason = classifierReviewMessage({...request, effectiveDuration: duration,
      memoryUnavailableReason});
    const requestId = `statewright-classifier-approval-${randomUUID()}`;
    if (sessionId && toolUseId) this.pending.set(JSON.stringify([sessionId, toolUseId]), {
      request, requestId, sessionId, toolUseId, duration,
      invocationHash,
    });
    this.emit("classifier_human_approval_requested", request, {
      approval_request_id: requestId, decision: "ask", actor_source: "statewright_pre_tool_hook", duration,
      attempts: rework?.attempts ?? null, max_reworks: rework?.max_reworks ?? null,
    });
    return {result: {...result, decision: "ask", reason,
      classifier_approval: {action: "ask", reason, duration, approval_request_id: requestId}}, rework};
  }

  async postTool(body) {
    const sessionId = safeId(body.session_id), toolUseId = safeId(body.tool_use_id);
    if (!sessionId || !toolUseId) return;
    const key = JSON.stringify([sessionId, toolUseId]);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    let hash = null;
    try { hash = digestJson([body.tool_name, body.tool_input]); } catch {}
    if (!pending.invocationHash || hash !== pending.invocationHash) {
      this.emit("classifier_human_approval_unresolved", pending.request, {
        approval_request_id: pending.requestId, decision: "unresolved",
        reason: "post_tool_invocation_mismatch", duration: pending.duration,
      });
      return;
    }
    let duration = "once", grant = null, reason = "human_approved";
    if (pending.duration !== "once" && this.memory && this.owner
        && await this.current(pending.request)) {
      try {
        grant = await this.memory.remember(pending.request.memoryContext, pending.duration);
        if (!await this.current(pending.request)) {
          await this.memory.revoke(grant.id);
          grant = null;
          reason = "approval_state_changed_after_execution";
        } else {
          duration = pending.duration;
          this.previouslyRemembered.add(bindingKey(pending.request));
          this.emit("classifier_approval_memory_created", pending.request, {
            decision: "granted", grant_id: grant.id, duration,
            expires_at: grant.expires_at, approval_request_id: pending.requestId,
          });
        }
      } catch { reason = "approval_memory_write_failed_after_execution"; }
    } else if (pending.duration !== "once") reason = "approval_state_changed_after_execution";
    this.emit("classifier_human_approval_granted", pending.request, {
      approval_request_id: pending.requestId, decision: "granted", actor_source: "claude_post_tool_use",
      reason, duration,
      ...(grant ? {grant_id: grant.id, expires_at: grant.expires_at} : {}),
    });
  }

  close() {
    for (const sessionId of new Set([...this.pending.values()].map(pending => pending.sessionId))) {
      this.unresolved(sessionId, "adapter_closed_without_matching_post_tool");
    }
  }
}
