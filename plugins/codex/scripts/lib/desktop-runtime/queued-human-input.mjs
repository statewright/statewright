// One policy for both native hosts. This is additive hook context, not a
// replacement for user/configured developer instructions or workflow authority.
export function humanInputHook() {
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: [
    "Statewright human-input policy (Desktop and TUI):",
    "For a clarification or preference that does not block the whole task, use request_user_input_async only when advertised and permitted by the current tool policy. Use the native question UI, not a prose-only question buried in progress output.",
    "Make the question self-contained: identify the decision, affected milestone/task and scope, give concise options where useful, and state which dependent work is parked. Continue only independent work already authorized by the user. Do not wait or poll merely because a question is pending.",
    "Record the pending decision and affected task in the existing handoff; when a reply arrives, correlate it with the same question and scope and recheck whether it is still current. An ambiguous, stale, empty or dismissed reply leaves that decision open. Do not repeat an already-pending question.",
    "A recommended/preselected option, silence, elapsed time or delivery acknowledgement is never an answer or approval. Do not call a task complete while required decisions remain unresolved.",
    "Permission, deployment, destructive-action and Statewright approval gates remain on their existing authorized approval path; do not use a clarification tool to bypass them or to release a protected action. Follow the active workflow's tools and transitions. This policy does not activate a workflow.",
    "Native approval waits are not asynchronous preference questions. Never cancel, interrupt, kill, or abandon a pending native approval or its waiting tool solely because of elapsed time, missing output, or a quiet tool call. Await the existing native approval result using the host's supported wait mechanism; continue only independent authorized work when the host supports it. Do not transition to BLOCKED merely because approval is pending, and do not let a continuation nudge force such a transition. Do not replay or duplicate the protected action or switch tools to bypass the gate.",
    "Only explicit user cancellation, an authoritative denial/expiry, or a confirmed transport failure ends that approval wait. Preserve the request identity and decision evidence. After interruption or transport loss, treat execution as unknown and reconcile the original request's outcome before any retry; never infer cancellation, denial, approval, or execution from silence.",
    "If asynchronous input is unavailable, say so, record the question, and continue independent work. Use a supported blocking input only when needed and allowed; when no authorized independent work remains, leave the dependent task parked without cancelling an outstanding approval. Never invent a tool or auto-answer.",
    "Chat or SMS projections are not enabled by this policy. External delivery or replies require a separately authorized, authenticated adapter bound to the original request, thread and scope; never treat uncorrelated messages as decisions.",
  ].join("\n") } };
}

/**
 * The native server owns question correlation and asynchronous delivery. Keep
 * its card, isBlocking bit, IDs and replies intact. Some host versions still
 * honor the deprecated autoResolutionMs timer: queued questions must not be
 * auto-selected merely because the human has not replied. Do not transform
 * blocking questions, legacy messages or any approval request into async ones.
 */
export function prepareQueuedHumanInput(message) {
  if (message?.method !== "item/tool/requestUserInput"
      || message.params?.isBlocking !== false
      || message.params.autoResolutionMs == null) return message;
  return { ...message, params: { ...message.params, autoResolutionMs: null } };
}
