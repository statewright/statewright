const REWORKABLE_BASES = new Set([
  "semantic_threshold_not_met",
  "incomplete_structural_evidence",
  "semantic_vector_unavailable",
  "semantic_assessment_incomplete",
  "semantic_authorization_disabled",
]);

function printable(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function classifierIntent(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const fingerprint = receipt.intent_fingerprint;
  const invocationFingerprint = receipt.invocation_fingerprint;
  const basis = receipt.final_denial_basis ?? receipt.resolution_basis;
  if (!printable(fingerprint) || !fingerprint.startsWith("intent_v1_")
      || !printable(invocationFingerprint)
      || !invocationFingerprint.startsWith("invocation_v1_")
      || !printable(basis)) return null;
  const reworkable = REWORKABLE_BASES.has(basis)
    && receipt.required_authority === "complete_structural_evidence_or_separate_approval"
    && receipt.reformulation_allowed === true
    && receipt.exact_invocation_retry_allowed === false
    && receipt.separate_approval_allowed === true;
  return {
    fingerprint,
    invocationFingerprint,
    basis,
    reworkable,
  };
}

/**
 * Provider-neutral retry accounting for classifier denials.
 *
 * The gate stores only gateway-issued redacted intent identities and bounded
 * workflow scope. It never receives or retains raw tool arguments. Host
 * adapters decide how to render rework notices and how to request native
 * human approval when `action` becomes `approval_required`.
 */
export class ClassifierReworkGate {
  constructor({ maxReworks = 2, ttlMs = 10 * 60_000, now = () => Date.now() } = {}) {
    if (!Number.isSafeInteger(maxReworks) || maxReworks < 1 || maxReworks > 10) {
      throw new Error("Classifier rework budget must be between 1 and 10");
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000) {
      throw new Error("Classifier rework TTL must be at least one second");
    }
    Object.assign(this, { maxReworks, ttlMs, now });
    this.entries = new Map();
  }

  scopeKey({ runId = null, state = null, hostSessionId = null } = {}) {
    return JSON.stringify([runId ?? "run", state ?? "state", hostSessionId ?? "session"]);
  }

  intentKey(scopeKey, intent) {
    return JSON.stringify([scopeKey, intent.fingerprint, intent.basis]);
  }

  prune(timestamp = this.now()) {
    for (const [key, value] of this.entries) {
      if (timestamp - value.updatedAt >= this.ttlMs) this.entries.delete(key);
    }
  }

  observeDenial({ receipt, scope = {} }) {
    const intent = classifierIntent(receipt);
    if (!intent?.reworkable) return null;
    const timestamp = this.now();
    this.prune(timestamp);
    const scopeKey = this.scopeKey(scope);
    const key = this.intentKey(scopeKey, intent);
    const previous = this.entries.get(key);
    if (previous?.seenInvocations.has(intent.invocationFingerprint)) {
      return Object.freeze({
        schema: "statewright/classifier-rework/v1",
        intent_fingerprint: intent.fingerprint,
        invocation_fingerprint: intent.invocationFingerprint,
        basis: intent.basis,
        attempts: previous.attempts,
        max_reworks: this.maxReworks,
        action: "exact_invocation_denied",
      });
    }
    const attempts = (previous?.attempts ?? 0) + 1;
    const seenInvocations = previous?.seenInvocations ?? new Set();
    seenInvocations.add(intent.invocationFingerprint);
    this.entries.set(key, { attempts, updatedAt: timestamp, scopeKey, seenInvocations });
    return Object.freeze({
      schema: "statewright/classifier-rework/v1",
      intent_fingerprint: intent.fingerprint,
      invocation_fingerprint: intent.invocationFingerprint,
      basis: intent.basis,
      attempts,
      max_reworks: this.maxReworks,
      action: attempts > this.maxReworks ? "approval_required" : "rework",
    });
  }

  observeSuccess({ receipt, scope = {} }) {
    const intent = classifierIntent(receipt);
    if (!intent) return false;
    return this.entries.delete(this.intentKey(this.scopeKey(scope), intent));
  }

  clearScope(scope = {}) {
    const target = this.scopeKey(scope);
    let cleared = 0;
    for (const [key, value] of this.entries) {
      if (value.scopeKey === target) {
        this.entries.delete(key);
        cleared += 1;
      }
    }
    return cleared;
  }
}
