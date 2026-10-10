import { createHash } from "node:crypto";
import { DurableLogOutbox } from "./local-telemetry-agent.mjs";

// Persist before attempting loopback delivery. The same event ID survives a
// lost acknowledgement or process restart; the receiving ledger deduplicates.
export class DesktopUsageRelay {
  constructor({path, deliver, retryMs = 2_000}) {
    this.outbox = new DurableLogOutbox(path);
    this.deliver = deliver;
    this.timer = setInterval(() => { void this.flush(); }, retryMs);
    this.timer.unref();
  }
  append(event) {
    this.outbox.append(projectDesktopUsage(event));
    void this.flush();
  }
  async flush() {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    try {
      for (const event of this.outbox.pending(20)) {
        await this.deliver(event);
        this.outbox.acknowledge(event.event_id);
      }
      this.lastError = null;
    } catch (error) { this.lastError = error.message; }
    finally { this.flushing = false; }
  }
  close() { this.closed = true; clearInterval(this.timer); }
}

const fields = {inputTokens: "input_tokens", cachedInputTokens: "cached_input_tokens",
  cacheWriteInputTokens: "cache_write_input_tokens", outputTokens: "output_tokens",
  reasoningOutputTokens: "reasoning_output_tokens", totalTokens: "total_tokens"};
const validText = v => typeof v === "string" && v.length > 0 && v.length <= 255;
function counts(value) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const [native, key] of Object.entries(fields)) {
    const v = native === "cacheWriteInputTokens" ? value[native] ?? 0 : value[native];
    if (!Number.isSafeInteger(v) || v < 0) return null;
    result[key] = v;
  }
  return result;
}

// Capture identity at turn start, never from whichever workflow phase is
// current when a delayed token notification arrives. No model-request inference.
export class DesktopNativeUsage {
  constructor() { this.routes = new Map(); this.turns = new Map(); }
  prepare(threadId, route) { this.routes.set(threadId, route ? structuredClone(route) : null); }
  started({threadId, turn}, settings) {
    const route = this.routes.get(threadId);
    if (!route || route.restored_original || route.restore_original || !validText(turn?.id)
        || ![threadId, route.run_id, route.run_session_id, route.state].every(validText)
        || !Number.isSafeInteger(route.state_epoch) || route.state_epoch < 1) return;
    const key = `${threadId}:${turn.id}`;
    if (this.turns.has(key)) return;
    this.turns.set(key, {route, settings: structuredClone(settings ?? {}), lastTotal: null});
    while (this.turns.size > 128) this.turns.delete(this.turns.keys().next().value);
  }
  event(params) {
    const {threadId, turnId, tokenUsage} = params ?? {};
    const entry = this.turns.get(`${threadId}:${turnId}`);
    const total = counts(tokenUsage?.total), delta = counts(tokenUsage?.last);
    if (!entry || !total || !delta || delta.total_tokens === 0) return null;
    const {route, settings} = entry;
    if (!validText(settings.model) || !validText(settings.modelProvider)
        || !Object.hasOwn(settings, "effort")) return null;
    // The native cumulative total is the duplicate/stale watermark. The last
    // completion is the delta: never charge a resumed thread's historical total.
    if (entry.lastTotal !== null && total.total_tokens <= entry.lastTotal) return null;
    entry.lastTotal = total.total_tokens;
    const timestamp = new Date().toISOString();
    return {event_id: createHash("sha256").update(JSON.stringify([
      "desktop-native-usage-v1", threadId, turnId, total])).digest("hex"),
      conversation_id: threadId, turn_id: turnId, source: "codex_app_server",
      source_event_at: timestamp, received_at: timestamp, provider: settings.modelProvider,
      model: settings.model, effort: settings.effort, precision: "exact", token_usage_delta: delta,
      binding: {conversation_id: threadId, root_session_id: threadId, run_id: route.run_id,
        run_session_id: route.run_session_id, workflow: route.workflow ?? "",
        state: route.state, state_epoch: route.state_epoch}};
  }
}

// Project the authenticated local payload; arbitrary fields never reach disk
// or remote telemetry. The loopback token is scoped to this one Desktop lane.
export function projectDesktopUsage(input) {
  const b = input?.binding;
  if (!b || ![input.event_id, input.conversation_id, input.turn_id, input.provider,
    input.model, b.run_id, b.run_session_id, b.state].every(validText)
      || !/^[a-f0-9]{64}$/.test(input.event_id)
      || b.conversation_id !== input.conversation_id || b.root_session_id !== input.conversation_id
      || !Number.isSafeInteger(b.state_epoch) || b.state_epoch < 1
      || !(input.effort === null || validText(input.effort))) throw new Error("Invalid Desktop usage identity");
  const delta = {};
  for (const key of Object.values(fields)) {
    if (!Number.isSafeInteger(input.token_usage_delta?.[key]) || input.token_usage_delta[key] < 0)
      throw new Error("Invalid Desktop usage counters");
    delta[key] = input.token_usage_delta[key];
  }
  const at = new Date(input.source_event_at);
  if (!Number.isFinite(at.getTime())) throw new Error("Invalid Desktop usage timestamp");
  return {event_id: input.event_id, conversation_id: input.conversation_id, turn_id: input.turn_id,
    provider: input.provider, model: input.model, effort: input.effort, precision: "exact",
    source: "codex_app_server", source_event_at: at.toISOString(), received_at: new Date().toISOString(),
    token_usage_delta: delta, binding: {conversation_id: b.conversation_id, root_session_id: b.root_session_id,
      run_id: b.run_id, run_session_id: b.run_session_id, state: b.state, state_epoch: b.state_epoch,
      workflow: typeof b.workflow === "string" ? b.workflow.slice(0, 100) : ""}};
}
