import {randomUUID} from "node:crypto";

const label = value => String(value ?? "unknown").replace(/[\x00-\x1f\x7f\x1b]/g, " ").slice(0, 100);

export function contextRecoveryNotice() {
  return "[statewright] Local-model context handoff: encrypted OpenAI state omitted; using bounded recovered plaintext and recent turns. Original history is unchanged; some context may be missing.";
}

export function hardInterruptNotice(from, to) {
  if (!from?.model || !to?.model || !from.provider || !to.provider) return null;
  const pair = new Set([from.model, to.model]);
  const solAstra = from.provider === "openai" && to.provider === "openai"
    && pair.has("gpt-5.6-sol") && pair.has("gpt-6-astra");
  const providerSwitch = new Set([from.provider, to.provider]);
  const openaiQwen = providerSwitch.has("openai") && providerSwitch.has("qwen_private");
  if (!solAstra && !openaiQwen) return null;
  const name = route => route.model === "gpt-5.6-sol" ? "sol" : route.model === "gpt-6-astra" ? "astra" : label(route.model);
  return `[statewright] switching from ${name(from)}=>${name(to)}, hard interrupt required`;
}

// Statewright-owned downstream presentation. Raw history, user input and every
// turn lifecycle event remain untouched. An interrupted terminal also restores
// TUI-local drafts: a proxy cannot safely suppress it.
export class HandoffPresentation {
  constructor({onStatus = () => {}} = {}) {
    this.onStatus = onStatus;
    this.turns = new Map();
    this.handoffs = new Map();
    this.switches = new Map();
  }

  observe(message) {
    const p = message.params;
    if (!p?.threadId) return;
    if (message.method === "turn/started" && p.turn?.id) this.turns.set(p.threadId, {id: p.turn.id, active: true, nativeSafe: true});
    if (message.method?.startsWith("item/") && this.turns.get(p.threadId)?.id === p.turnId) {
      this.turns.get(p.threadId).nativeSafe = false;
    }
    if (message.method === "turn/completed" && p.turn?.id && this.turns.get(p.threadId)?.id === p.turn.id) {
      this.turns.get(p.threadId).active = false;
    }
  }

  prepare(threadId, requestId, details) {
    if (typeof threadId !== "string" || !threadId || requestId == null || !details?.state) return;
    this.handoffs.set(threadId, {...details, requestId, acceptedTurnId: null});
  }

  // Only the response to this shim's exact routed start establishes ownership.
  // Notifications can precede the response; never infer it from the next turn.
  accept(threadId, requestId, turnId) {
    const handoff = this.handoffs.get(threadId);
    if (!handoff || handoff.requestId !== requestId || typeof turnId !== "string" || !turnId) return [];
    handoff.acceptedTurnId = turnId;
    const observed = this.turns.get(threadId);
    if (observed?.id !== turnId) return [];
    if (!observed.active) { this.handoffs.delete(threadId); return []; }
    return this.running(threadId, turnId, handoff);
  }

  cancel(threadId, requestId) {
    if (requestId !== undefined && this.handoffs.get(threadId)?.requestId !== requestId) return [];
    this.handoffs.delete(threadId);
    return [];
  }

  userActivity(threadId) { return this.cancel(threadId); }

  beginSwitch(threadId, fromModel, toModel) {
    const handoff = this.handoffs.get(threadId);
    if (handoff) this.switches.set(threadId, {handoff, fromModel, toModel, warnings: []});
  }

  finishSwitch(threadId, verified) {
    const entry = this.switches.get(threadId);
    this.switches.delete(threadId);
    return verified && entry?.handoff === this.handoffs.get(threadId) ? [] : entry?.warnings ?? [];
  }

  running(threadId, turnId, handoff) {
    this.handoffs.delete(threadId);
    const text = `${label(handoff.state)} · ${label(handoff.model)} / ${label(handoff.effort)} · running`;
    // Shared UI/log contract: no prompts, tool output, paths or credentials.
    const event = {schema: "statewright/app-server-handoff/v1", source: "statewright",
      thread_id: threadId, turn_id: turnId, run_id: handoff.runId ?? null,
      phase: "running", from_state: handoff.fromState ?? null, state: handoff.state,
      model: handoff.model ?? null, effort: handoff.effort ?? null, text};
    try { Promise.resolve(this.onStatus(event)).catch(() => {}); } catch { /* display cannot break execution */ }
    // Native Codex has one message stream. A late start response must not
    // finalize an answer already streaming under a synthetic status item.
    if (!this.turns.get(threadId)?.nativeSafe) return [];
    const item = {id: `statewright_status_${randomUUID()}`, type: "agentMessage",
      phase: "commentary", text: `Statewright supervisor: ${text}`};
    const now = Date.now();
    return ["item/started", "item/completed"].map(method => ({method, params: {threadId, turnId, item,
      [method === "item/started" ? "startedAtMs" : "completedAtMs"]: now}}));
  }

  present(message) {
    const p = message.params;
    const threadId = p?.threadId;
    if (message.method === "warning") {
      const attempt = this.switches.get(threadId);
      if (attempt && p.message === `This session was recorded with model \`${attempt.fromModel}\` but is resuming with \`${attempt.toModel}\`. Consider switching back to \`${attempt.fromModel}\` as it may affect Codex performance.`) {
        attempt.warnings.push(message);
        return [];
      }
    }
    const handoff = this.handoffs.get(threadId);
    if (message.method === "turn/started" && handoff?.acceptedTurnId) {
      if (handoff.acceptedTurnId === p.turn?.id) return [message, ...this.running(threadId, p.turn.id, handoff)];
      this.handoffs.delete(threadId); // a different writer superseded this start
    }
    return [message];
  }
}
