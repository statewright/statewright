export const ApprovalOutcome = Object.freeze({
  NOT_HANDLED: "not_handled",
  DENY: "deny",
  ASK: "ask",
  ALLOW: "allow",
  ERROR: "error",
});

const OUTCOMES = new Set(Object.values(ApprovalOutcome));

function validOutcome(value) {
  if (!value || !OUTCOMES.has(value.outcome)) return false;
  if ([ApprovalOutcome.DENY, ApprovalOutcome.ALLOW].includes(value.outcome)) {
    return value.response !== null && typeof value.response === "object";
  }
  if (value.outcome === ApprovalOutcome.ASK) {
    return value.completion && typeof value.completion.then === "function";
  }
  if (value.outcome === ApprovalOutcome.ERROR) {
    return typeof value.reason === "string" && value.reason.length > 0;
  }
  return true;
}

function outcome(kind, details = {}) {
  if (!OUTCOMES.has(kind)) throw new Error(`Unknown approval outcome: ${kind}`);
  return Object.freeze({outcome: kind, ...details});
}

export const approvalNotHandled = () => outcome(ApprovalOutcome.NOT_HANDLED);
export const approvalDeny = response => outcome(ApprovalOutcome.DENY, {response});
export const approvalAsk = completion => outcome(ApprovalOutcome.ASK, {completion});
export const approvalAllow = response => outcome(ApprovalOutcome.ALLOW, {response});
export const approvalError = reason => outcome(ApprovalOutcome.ERROR, {reason});

/**
 * Ordered chain of responsibility for native-session approvals.
 *
 * Only `not_handled` advances. A deny, ask, allow, or error is terminal so an
 * unavailable or negative higher-priority authority can never fall through to
 * a more permissive handler.
 */
export class ApprovalPipeline {
  constructor(handlers = []) {
    if (!Array.isArray(handlers) || handlers.length === 0) {
      throw new Error("Approval pipeline requires at least one handler");
    }
    const names = new Set();
    const priorities = new Set();
    this.handlers = handlers.map(handler => {
      if (!handler || typeof handler.name !== "string" || !handler.name
          || !Number.isSafeInteger(handler.priority)
          || typeof handler.handle !== "function") {
        throw new Error("Approval handler requires name, integer priority, and handle");
      }
      if (names.has(handler.name)) throw new Error(`Duplicate approval handler: ${handler.name}`);
      if (priorities.has(handler.priority)) {
        throw new Error(`Duplicate approval priority: ${handler.priority}`);
      }
      names.add(handler.name);
      priorities.add(handler.priority);
      return Object.freeze({...handler});
    }).sort((left, right) => left.priority - right.priority);
  }

  async service(request, context = {}) {
    for (const handler of this.handlers) {
      let result;
      try {
        result = await handler.handle(request, context);
      } catch {
        return approvalError(`approval_handler_unavailable:${handler.name}`);
      }
      if (!validOutcome(result)) {
        return approvalError(`approval_handler_invalid_result:${handler.name}`);
      }
      if (result.outcome !== ApprovalOutcome.NOT_HANDLED) {
        return Object.freeze({...result, handler: handler.name, priority: handler.priority});
      }
    }
    return approvalNotHandled();
  }
}
