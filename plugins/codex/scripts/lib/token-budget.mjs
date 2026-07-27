const TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

const TOKEN_ALIASES = {
  input_tokens: ["inputTokens", "input_tokens"],
  cached_input_tokens: ["cachedInputTokens", "cached_input_tokens"],
  cache_write_input_tokens: ["cacheWriteInputTokens", "cache_write_input_tokens"],
  output_tokens: ["outputTokens", "output_tokens"],
  reasoning_output_tokens: ["reasoningOutputTokens", "reasoning_output_tokens"],
  total_tokens: ["totalTokens", "total_tokens"],
};

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function firstNumber(source, keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined) return nonNegativeNumber(source[key]);
  }
  return 0;
}

// Codex app-server reports thread usage as { last, total }. The cumulative
// total is the stable snapshot used for per-turn deltas; flat objects remain
// supported for other adapters and unit tests.
function usageSnapshot(usage = {}) {
  return usage?.total && typeof usage.total === "object" ? usage.total : usage;
}

function isCumulativeThreadUsage(usage = {}) {
  return Boolean(usage?.total && typeof usage.total === "object");
}

export function hasMeasuredTokenUsage(usage = {}) {
  const snapshot = usageSnapshot(usage);
  return TOKEN_FIELDS.some((field) =>
    TOKEN_ALIASES[field].some((key) =>
      typeof snapshot?.[key] === "number" && Number.isFinite(snapshot[key]) && snapshot[key] > 0,
    ),
  );
}

export function normalizeTokenUsage(usage = {}) {
  const snapshot = usageSnapshot(usage);
  const normalized = Object.fromEntries(
    TOKEN_FIELDS.map((field) => [field, firstNumber(snapshot, TOKEN_ALIASES[field])]),
  );
  if (normalized.total_tokens === 0) {
    normalized.total_tokens = normalized.input_tokens + normalized.output_tokens;
  }
  return normalized;
}

export function tokenUsageDelta(previous = null, next = {}) {
  const current = normalizeTokenUsage(next);
  const prior = previous ? normalizeTokenUsage(previous) : null;
  if (!prior) return current;
  return Object.fromEntries(
    TOKEN_FIELDS.map((field) => [
      field,
      current[field] >= prior[field] ? current[field] - prior[field] : current[field],
    ]),
  );
}

function sumUsage(target, delta) {
  for (const field of TOKEN_FIELDS) target[field] += delta[field] ?? 0;
}

function itemResult(item) {
  return item?.result ?? item?.output ?? item?.content ?? null;
}

export function toolItemSummary(item) {
  const type = item?.type ?? "unknown";
  const tool = item?.tool ?? item?.name ?? type;
  const result = itemResult(item);
  let resultBytes = 0;
  if (result !== null && result !== undefined) {
    try {
      resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    } catch {
      resultBytes = 0;
    }
  }
  return {
    type,
    tool,
    result_bytes: resultBytes,
    // Approximation only: provider-reported token deltas remain authoritative.
    estimated_input_tokens: Math.ceil(resultBytes / 4),
  };
}

export class StateBudgetLedger {
  constructor() {
    this.session = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
    this.state = null;
    this.stateEpoch = 0;
    this.stateUsage = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
    this.toolResultBytes = 0;
    this.toolResultCount = 0;
    this.estimatedToolOutputTokens = 0;
    this.lastProviderUsage = null;
    this.lastUsageByTurn = new Map();
    this.emittedThresholds = new Set();
    this.hasProviderUsage = false;
  }

  enterState(state) {
    const next = state?.state ?? null;
    if (next === this.state) return this.snapshot();
    this.state = next;
    this.stateEpoch += 1;
    this.hasProviderUsage = false;
    this.stateUsage = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
    this.toolResultBytes = 0;
    this.toolResultCount = 0;
    this.estimatedToolOutputTokens = 0;
    this.lastUsageByTurn.clear();
    this.emittedThresholds.clear();
    return this.snapshot(state);
  }

  observeTokenUsage(turnId, usage, state) {
    if (!hasMeasuredTokenUsage(usage)) {
      return {
        available: false,
        usage: null,
        delta: null,
        ledger: this.snapshot(state),
      };
    }
    const current = normalizeTokenUsage(usage);
    const cumulative = isCumulativeThreadUsage(usage);
    const previous = cumulative ? this.lastProviderUsage : this.lastUsageByTurn.get(turnId);
    const delta = tokenUsageDelta(previous, current);
    if (cumulative) this.lastProviderUsage = current;
    else this.lastUsageByTurn.set(turnId, current);
    sumUsage(this.session, delta);
    sumUsage(this.stateUsage, delta);
    this.hasProviderUsage = true;
    return { available: true, usage: current, delta, ledger: this.snapshot(state) };
  }

  observeToolItem(item, state) {
    const tool = toolItemSummary(item);
    this.toolResultBytes += tool.result_bytes;
    this.toolResultCount += 1;
    this.estimatedToolOutputTokens += tool.estimated_input_tokens;
    return { tool, ledger: this.snapshot(state) };
  }

  snapshot(state = null) {
    const budget = nonNegativeNumber(state?.context_budget_bytes);
    const pct = budget > 0 ? (this.toolResultBytes / budget) * 100 : null;
    const totalTokens = this.stateUsage.total_tokens;
    return {
      state: this.state,
      state_epoch: this.stateEpoch,
      context_budget_bytes: budget || null,
      tool_result_bytes: this.toolResultBytes,
      tool_result_count: this.toolResultCount,
      estimated_tool_output_tokens: this.estimatedToolOutputTokens,
      context_budget_percent: pct,
      precision: this.hasProviderUsage ? "exact" : "unavailable",
      token_usage: this.hasProviderUsage ? { ...this.stateUsage } : null,
      session_token_usage: this.hasProviderUsage ? { ...this.session } : null,
      token_attribution: {
        provider_total_tokens: this.hasProviderUsage ? totalTokens : null,
        estimated_tool_output_tokens: this.estimatedToolOutputTokens,
        // Residual includes prompts, model output, and any provider tokens that
        // cannot be causally assigned to one completed tool result.
        unattributed_tokens: this.hasProviderUsage
          ? Math.max(0, totalTokens - this.estimatedToolOutputTokens)
          : null,
        reported_reasoning_output_tokens: this.hasProviderUsage
          ? this.stateUsage.reasoning_output_tokens
          : null,
      },
    };
  }

  thresholdCrossed(state, threshold) {
    const snapshot = this.snapshot(state);
    if (snapshot.context_budget_percent === null || snapshot.context_budget_percent < threshold) {
      return false;
    }
    const key = `${this.state}:${threshold}`;
    if (this.emittedThresholds.has(key)) return false;
    this.emittedThresholds.add(key);
    return true;
  }
}
