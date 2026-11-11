import { randomUUID } from "node:crypto";

const S1_FIELDS = [["read_only", "read-only"], ["may_write", "write"],
  ["reversible", "reversible"], ["destructive", "destructive"],
  ["irreversible", "irreversible"], ["external_or_account_effect", "external"]];
const S1_STATUSES = new Set(["Disabled", "Queued", "Unavailable", "Timeout", "Malformed", "QueueFull", "Assessed", "ShadowOnly", "NotRequired"]);

// This is presentation data only: do not infer authority from a model score.
export function s1Classification(receipt) {
  const status = S1_STATUSES.has(receipt?.semantic_status) ? receipt.semantic_status : null;
  const raw = receipt?.semantic_vector;
  const vector = {};
  if ((status === "Assessed" || status === "ShadowOnly") && raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key] of S1_FIELDS) {
      if (typeof raw[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= 0 && raw[key] <= 1) vector[key] = raw[key];
    }
  }
  return {semantic_status: status, semantic_vector: Object.keys(vector).length ? vector : null};
}

export function s1ClassificationDisplay(receipt) {
  const {semantic_status: status, semantic_vector: vector} = s1Classification(receipt);
  if (!vector) return `S1 classification: ${status ? status.toLowerCase() : "unavailable"}; no predictions available.`;
  const scores = S1_FIELDS.filter(([key]) => Object.hasOwn(vector, key))
    .map(([key, label]) => `${label} ${Math.round(vector[key] * 100)}%`);
  return `S1 classification: ${scores.join(", ")}.${status === "ShadowOnly" ? " Evaluation only." : ""}`;
}

export function interactionText(value, maximum = 4096) {
  if (typeof value !== "string") return null;
  const masked = value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[redacted]")
    .replace(/\bsw_(?:live|test)_[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/((?:--?|\b)(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|token)(?:\s+|=))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1[redacted]")
    .replace(/\b([A-Z_]*(?:API_KEY|TOKEN|PASSWORD|SECRET)[A-Z_]*=)(?:"[^"]*"|'[^']*'|[^\s]+)/g, "$1[redacted]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  return masked.length > maximum ? masked.slice(0, maximum) + " [truncated]" : masked;
}

export function interactionValue(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return interactionText(value);
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) {
    const output = value.slice(0, 32).map(item => interactionValue(item, depth + 1));
    if (value.length > 32) {
      const prior = value.length === 33 ? value[32]?._statewright_omitted_items : null;
      output.push({_statewright_omitted_items: Number.isSafeInteger(prior) && prior > 0 ? prior : value.length - 32});
    }
    return output;
  }
  if (typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [
    key, /^(?:authorization|api[_-]?key|password|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|session[_-]?token|cookie|proxyToken)$/i.test(key)
      ? "[redacted]" : interactionValue(item, depth + 1),
  ]));
}

export function approvalDisplayContext(value) {
  const input = value?.tool_input ?? {};
  const display = value?.display_context ?? {};
  const tool = interactionText(value?.tool_name ?? display.tool, 128);
  const command = interactionText(input.command ?? input.cmd ?? display.command, 8192);
  const cwd = interactionText(input.workdir ?? input.cwd ?? display.cwd, 1024);
  const details = {};
  // Display actual requested actions, not a tool-name-only consent card.
  // This projection is for human review/logging; it never grants authority.
  const keys = ["search_query", "image_query", "open", "click", "find", "screenshot",
    "finance", "weather", "sports", "time", "query", "q", "url", "method", "operation", "action"];
  for (const key of keys) {
    if (Object.hasOwn(input, key)) details[key] = interactionValue(input[key]);
    else if (display.details && Object.hasOwn(display.details, key)) details[key] = interactionValue(display.details[key]);
  }
  const context = command || tool ? { tool, command, cwd } : null;
  if (context && Object.keys(details).length) context.details = details;
  return context;
}

export class HumanInteractionRecorder {
  constructor(record) { this.record = record; this.pending = new Map(); this.completed = new Map(); this.executions = new Map(); }
  emit(fields) {
    const event = {schema:"statewright/human-interaction/v1", ...fields};
    void Promise.resolve().then(() => this.record(event)).catch(() => {});
  }
  request(message, {runId} = {}) {
    if (message?.id === undefined || typeof message.method !== "string"
        || !/(?:\/requestApproval|\/requestUserInput|elicitation\/request)$/.test(message.method)) return;
    const key = JSON.stringify([typeof message.id, message.id]);
    if (this.pending.has(key)) return;
    const item = {interaction_id:randomUUID(), request_id:String(message.id),
      thread_id:message.params?.threadId ?? message.params?.thread_id ?? null, method:message.method,
      ...(runId ? {run_id:runId} : {}),
      dialog:interactionValue(message.params), native_item_id:message.params?.itemId ?? null};
    this.pending.set(key, item);
    this.emit({...item, stage:"requested"});
  }
  response(message) {
    if (message?.method || message?.id === undefined) return;
    const key = JSON.stringify([typeof message.id, message.id]);
    const item = this.pending.get(key);
    if (!item) return;
    this.pending.delete(key);
    if (this.completed.size >= 1024) this.completed.delete(this.completed.keys().next().value);
    this.completed.set(key, item);
    if (item.native_item_id && /commandExecution/.test(item.method)) {
      if (this.executions.size >= 1024) this.executions.delete(this.executions.keys().next().value);
      this.executions.set(JSON.stringify([item.thread_id, item.native_item_id]), item);
    }
    this.emit({...item, stage:message.error ? "failed" : "responded",
      result:interactionValue(message.error ?? message.result), actor_source:"native_client_reply"});
  }
  resolve(requestId, result) {
    const key = JSON.stringify([typeof requestId, requestId]);
    const item = this.completed.get(key) ?? this.pending.get(key);
    this.pending.delete(key);
    this.completed.delete(key);
    if (item) this.emit({...item, stage:"resolved", result:interactionValue(result)});
  }
  recordClassifierApproval(event) {
    const grant = event.grant_id ? {
      grant_id:event.grant_id, duration:event.duration, expires_at:event.expires_at,
    } : {};
    if (event.type === "classifier_approval_memory_reused") {
      this.emit({stage:"approval_reused", method:"statewright/classifierApproval",
        interaction_id:event.grant_id, request_id:event.invocation_fingerprint,
        thread_id:event.threadId, run_id:event.run_id,
        result:{action:"reuse", ...grant, invocation_fingerprint:event.invocation_fingerprint}});
    } else if (event.approval_request_id) {
      const granted = event.type === "classifier_human_approval_granted";
      this.resolve(event.approval_request_id, {
        action:granted ? "allow_once" : "deny",
        ...(granted ? {approval_scope:event.grant_id ? "remembered" : "once"} : {}),
        ...grant, reason:event.reason, invocation_fingerprint:event.invocation_fingerprint,
      });
    }
  }
  observeExecution(notification) {
    if (notification?.method !== "item/completed") return;
    const params = notification.params;
    const key = JSON.stringify([params?.threadId, params?.item?.id]);
    const item = this.executions.get(key);
    if (!item) return;
    this.executions.delete(key);
    this.emit({...item, stage:"execution_completed", result:interactionValue({
      status:params.item.status, exit_code:params.item.exitCode,
      output:params.item.aggregatedOutput, duration_ms:params.item.durationMs})});
  }
  close(reason = "connection_closed") {
    for (const item of this.pending.values()) this.emit({...item, stage:"interrupted", result:{reason}});
    this.pending.clear();
    this.completed.clear();
    this.executions.clear();
  }
}
