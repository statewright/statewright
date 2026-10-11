import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CODEX_JSONL_READ_BYTES = 1024 * 1024;
const MAX_DURABLE_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_DURABLE_LEDGER_RECORDS = 100_000;
const DURABLE_LEDGER_READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_LIVE_REQUEST_TIMEOUT_MS = 5_000;
export const TELEMETRY_PROTOCOL_VERSION = 1;
export const TELEMETRY_AGENT_BUILD_ID = "native-codex-otel-v1";
const TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

function text(value, max = 255) {
  if (value === null || value === undefined) return "";
  return String(value).slice(0, max);
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(fetchImpl(url, { ...options, signal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function timestamp(value, fallback = new Date().toISOString()) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function anyValue(value) {
  if (!value || typeof value !== "object") return null;
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return value.intValue;
  if ("doubleValue" in value) return value.doubleValue;
  if ("boolValue" in value) return value.boolValue;
  if ("bytesValue" in value) return value.bytesValue;
  return null;
}

function attributeMap(attributes = []) {
  return Object.fromEntries(
    attributes
      .filter((attribute) => attribute && typeof attribute.key === "string")
      .map((attribute) => [attribute.key, anyValue(attribute.value)]),
  );
}

function isoFromUnixNano(value) {
  try {
    const nanoseconds = BigInt(value);
    const milliseconds = Number(nanoseconds / 1_000_000n);
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

function stableId(kind, value) {
  return createHash("sha256")
    .update(`${kind}\0${JSON.stringify(value)}`)
    .digest("hex");
}

function addUsage(left = {}, right = {}) {
  return Object.fromEntries(
    TOKEN_FIELDS.map((field) => [field, count(left[field]) + count(right[field])]),
  );
}

function emptyUsage() {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
}

function compactJson(value, max = 102_400) {
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return "[unserializable tool output]";
  }
}

function toolOutputText(output) {
  if (Array.isArray(output)) {
    return output
      .map((part) => typeof part?.text === "string" ? part.text : compactJson(part, 16_384))
      .join("\n")
      .slice(0, 102_400);
  }
  return typeof output === "string" ? output.slice(0, 102_400) : compactJson(output);
}

function reportedExitCode(output) {
  const value = toolOutputText(output);
  const match = value.match(/(?:exit[_ ]?code|exit)\s*[:=]\s*(-?\d+)/i);
  if (!match) return null;
  const code = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(code) ? code : null;
}

// TODO(telemetry-redaction): support configurable Sentry-style scrubbing rules
// before preserving opt-in raw tool output outside the local session JSONL.
export function inspectCodexCustomToolRecords(records, conversationId, calls = new Map()) {
  const events = [];
  for (const record of records) {
    const payload = record?.payload;
    if (record?.type !== "response_item" || !payload?.call_id) continue;
    if (payload.type === "custom_tool_call") {
      calls.set(payload.call_id, {
        call_id: text(payload.call_id, 255),
        tool: text(payload.name, 255) || "custom_tool",
        tool_input: { input: text(payload.input, 102_400) },
        source_event_at: timestamp(record.timestamp),
      });
      continue;
    }
    if (payload.type !== "custom_tool_call_output") continue;
    const call = calls.get(payload.call_id);
    if (!call) continue;
    const output = toolOutputText(payload.output);
    events.push({
      event_id: stableId("codex-jsonl-custom-tool", {
        conversation_id: conversationId,
        call_id: call.call_id,
      }),
      invocation_id: call.call_id,
      conversation_id: text(conversationId, 255),
      source: "codex_jsonl",
      provider: "codex",
      tool: call.tool,
      tool_input: call.tool_input,
      tool_output: output,
      exit_code: reportedExitCode(payload.output),
      result_bytes: Buffer.byteLength(output, "utf8"),
      is_error: false,
      source_event_at: timestamp(record.timestamp, call.source_event_at),
      received_at: new Date().toISOString(),
    });
    calls.delete(payload.call_id);
  }
  return events;
}

export function telemetryIdentity({
  pocketbaseUrl,
  gatewayUrl = "",
  apiKey,
  buildId = TELEMETRY_AGENT_BUILD_ID,
  host = "127.0.0.1",
  port = 4318,
  dataDir = "",
  rawCaptureDestination = "",
}) {
  return {
    protocol_version: TELEMETRY_PROTOCOL_VERSION,
    agent_build_id: buildId,
    config_identity: stableId("local-telemetry-config", {
      pocketbase_url: String(pocketbaseUrl || "").replace(/\/$/, ""),
      gateway_url: String(gatewayUrl || "").replace(/\/$/, ""),
      api_key_hash: stableId("api-key", String(apiKey || "")),
      host: String(host),
      port: count(port),
      data_dir: String(dataDir),
      raw_capture_destination: String(rawCaptureDestination || "").trim(),
    }),
  };
}

export function credentialScopedDataDir(dataDir, apiKey) {
  const generation = stableId("telemetry-owner", String(apiKey || "")).slice(0, 16);
  return join(dataDir, "generations", generation);
}

/**
 * Normalize only privacy-safe Codex response usage logs. Raw OTLP records,
 * prompt fields, account fields, and arbitrary attributes are not returned.
 */
export function inspectOtlpLogs(document, receivedAt = new Date().toISOString()) {
  const result = {
    events: [],
    ignored: 0,
    protocol_errors: 0,
    last_protocol_error: null,
  };
  let recordCount = 0;
  for (const resourceLog of document?.resourceLogs ?? []) {
    const resourceAttributes = attributeMap(resourceLog?.resource?.attributes);
    for (const scopeLog of resourceLog?.scopeLogs ?? []) {
      for (const logRecord of scopeLog?.logRecords ?? []) {
        recordCount += 1;
        const attributes = {
          ...resourceAttributes,
          ...attributeMap(logRecord?.attributes),
        };
        if (attributes["event.name"] !== "codex.sse_event" ||
            attributes["event.kind"] !== "response.completed") {
          result.ignored += 1;
          continue;
        }

        const conversationId = text(attributes["conversation.id"], 255);
        if (!conversationId) {
          result.protocol_errors += 1;
          result.last_protocol_error = "response.completed missing conversation.id";
          continue;
        }
        const sourceTimeKey = text(logRecord.timeUnixNano || logRecord.observedTimeUnixNano, 40);
        const sourceEventAt = timestamp(
          attributes["event.timestamp"] || isoFromUnixNano(sourceTimeKey),
          receivedAt,
        );
        const usage = {
          input_tokens: count(attributes.input_token_count),
          cached_input_tokens: count(attributes.cached_token_count),
          cache_write_input_tokens: count(attributes.cache_write_token_count),
          output_tokens: count(attributes.output_token_count),
          reasoning_output_tokens: count(attributes.reasoning_token_count),
          // Codex currently emits total usage under this historical field.
          total_tokens: count(attributes.tool_token_count),
        };
        if (!TOKEN_FIELDS.some((field) => usage[field] > 0)) {
          result.protocol_errors += 1;
          result.last_protocol_error = "response.completed missing token usage fields";
          continue;
        }

        const identity = {
          conversation_id: conversationId,
          source_time_key: sourceTimeKey || sourceEventAt,
          usage,
          model: text(attributes.model, 255),
          effort: text(attributes.model_reasoning_effort, 100),
        };
        result.events.push({
          event_id: stableId("codex-otel-response-completed", identity),
          source: "codex_otel",
          provider: "codex",
          precision: "exact",
          conversation_id: conversationId,
          source_event_at: sourceEventAt,
          received_at: timestamp(receivedAt),
          model: identity.model || null,
          effort: identity.effort || null,
          token_usage_delta: usage,
        });
      }
    }
  }
  if (recordCount === 0) {
    result.protocol_errors += 1;
    result.last_protocol_error = "OTLP payload contained no log records";
  }
  return result;
}

export function normalizeOtlpLogs(document, receivedAt = new Date().toISOString()) {
  return inspectOtlpLogs(document, receivedAt).events;
}

function appendDurably(path, record) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const encoded = `${JSON.stringify(record)}\n`;
  const currentSize = existsSync(path) ? statSync(path).size : 0;
  if (currentSize + Buffer.byteLength(encoded) > MAX_DURABLE_LEDGER_BYTES) {
    throw new Error(`durable telemetry ledger exceeds ${MAX_DURABLE_LEDGER_BYTES} bytes`);
  }
  const fd = openSync(path, "a", 0o600);
  try {
    appendFileSync(fd, encoded, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

function* readJsonLines(path) {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  if (size > MAX_DURABLE_LEDGER_BYTES) {
    throw new Error(`durable telemetry ledger exceeds ${MAX_DURABLE_LEDGER_BYTES} bytes`);
  }
  const fd = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(DURABLE_LEDGER_READ_CHUNK_BYTES);
  let remainder = "";
  let records = 0;
  try {
    let bytesRead;
    do {
      bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      const lines = `${remainder}${chunk.toString("utf8", 0, bytesRead)}`.split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        records += 1;
        if (records > MAX_DURABLE_LEDGER_RECORDS) {
          throw new Error(`durable telemetry ledger exceeds ${MAX_DURABLE_LEDGER_RECORDS} records`);
        }
        try { yield JSON.parse(line); } catch { /* Ignore a torn final append. */ }
      }
    } while (bytesRead > 0);
    if (remainder) {
      records += 1;
      if (records > MAX_DURABLE_LEDGER_RECORDS) {
        throw new Error(`durable telemetry ledger exceeds ${MAX_DURABLE_LEDGER_RECORDS} records`);
      }
      try { yield JSON.parse(remainder); } catch { /* Ignore a torn final append. */ }
    }
  } finally {
    closeSync(fd);
  }
}

export class BindingLedger {
  constructor(path) {
    this.path = path;
    this.bindings = [];
    this.eventIds = new Set();
    this.byConversation = new Map();
    this.activeAt = new Map();
    this.lastSignature = null;
    this.refresh({ activateNew: false });
  }

  refresh({ activateNew = true } = {}) {
    let signature = "missing";
    try {
      const stat = statSync(this.path);
      signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      // A missing ledger is a valid empty ledger until the first binding arrives.
    }
    if (signature === this.lastSignature) return false;
    this.lastSignature = signature;
    for (const record of readJsonLines(this.path)) this.#remember(record, activateNew);
    return true;
  }

  #remember(record, activate = true) {
    if (record?.kind !== "binding" || !record.binding?.event_id) return;
    if (this.eventIds.has(record.binding.event_id)) return;
    this.eventIds.add(record.binding.event_id);
    this.bindings.push(record.binding);
    const entries = this.byConversation.get(record.binding.conversation_id) ?? [];
    entries.push(record.binding);
    this.byConversation.set(record.binding.conversation_id, entries);
    if (activate) this.activeAt.set(record.binding.conversation_id, Date.now());
  }

  append(input) {
    const binding = {
      event_id: text(input.event_id, 64) || stableId("state-binding", {
        conversation_id: input.conversation_id,
        root_session_id: input.root_session_id,
        run_id: input.run_id,
        run_session_id: input.run_session_id,
        state: input.state,
        state_epoch: input.state_epoch,
        effective_at: input.effective_at,
      }),
      conversation_id: text(input.conversation_id, 255),
      root_session_id: text(input.root_session_id, 255) || null,
      run_id: text(input.run_id, 64),
      run_session_id: text(input.run_session_id, 255) || null,
      workflow: text(input.workflow, 100),
      state: text(input.state, 255),
      state_epoch: count(input.state_epoch),
      effective_at: timestamp(input.effective_at),
      capture_output: input.capture_output === true,
      propagated: input.propagated === true,
    };
    if (!binding.conversation_id || !binding.run_id || !binding.state || !binding.state_epoch) {
      throw new Error("binding requires conversation_id, run_id, state, and state_epoch");
    }
    if (this.eventIds.has(binding.event_id)) return { binding, duplicate: true };
    appendDurably(this.path, { kind: "binding", binding });
    this.#remember({ kind: "binding", binding });

    if (input.propagate_children === true) {
      const childIds = new Set(
        this.bindings
          .filter((candidate) =>
            candidate.root_session_id === binding.conversation_id &&
            candidate.conversation_id !== binding.conversation_id)
          .map((candidate) => candidate.conversation_id),
      );
      for (const childId of childIds) {
        this.append({
          ...binding,
          event_id: "",
          conversation_id: childId,
          root_session_id: binding.conversation_id,
          propagated: true,
          propagate_children: false,
        });
      }
    }
    return { binding, duplicate: false };
  }

  knows(conversationId, { refresh = true } = {}) {
    if (refresh) this.refresh();
    return this.byConversation.has(conversationId);
  }

  conversationIds({ refresh = true } = {}) {
    if (refresh) this.refresh();
    return [...this.byConversation.keys()];
  }

  activeConversationIds(since, { refresh = true } = {}) {
    if (refresh) this.refresh();
    const threshold = Number(since);
    const active = new Set(
      [...this.activeAt.entries()]
        .filter(([, observedAt]) => observedAt >= threshold)
        .map(([conversationId]) => conversationId),
    );
    // A collector may restart mid-state. A recent effective boundary is the
    // durable signal that lets it resume that active transcript without
    // re-scanning the full historical binding ledger.
    for (const [conversationId, bindings] of this.byConversation) {
      if (bindings.some((binding) => new Date(binding.effective_at).getTime() >= threshold)) {
        active.add(conversationId);
      }
    }
    return [...active];
  }

  resolve(conversationId, sourceEventAt, { refresh = true } = {}) {
    if (refresh) this.refresh();
    const at = new Date(sourceEventAt).getTime();
    let match = null;
    for (const binding of this.byConversation.get(conversationId) ?? []) {
      const effective = new Date(binding.effective_at).getTime();
      if (!Number.isFinite(effective) || effective > at) continue;
      if (!match || effective >= new Date(match.effective_at).getTime()) match = binding;
    }
    return match;
  }

  identity(conversationId, { refresh = true } = {}) {
    if (refresh) this.refresh();
    let match = null;
    for (const binding of this.byConversation.get(conversationId) ?? []) {
      if (!match || new Date(binding.effective_at) >= new Date(match.effective_at)) {
        match = binding;
      }
    }
    return match;
  }
}

export class DurableOutbox {
  constructor(path, { onUsageAppended = () => {} } = {}) {
    this.path = path;
    this.onUsageAppended = onUsageAppended;
    this.events = new Map();
    this.acked = new Set();
    this.seenEventIds = new Set();
    this.recentEventIds = [];
    this.stateTotals = new Map();
    this.sequence = 0;
    for (const record of readJsonLines(path)) {
      if (record?.kind === "checkpoint") {
        this.sequence = Math.max(this.sequence, count(record.sequence));
        for (const eventId of record.seen_event_ids ?? []) {
          this.#remember(eventId);
        }
        for (const [key, value] of Object.entries(record.state_totals ?? {})) {
          this.stateTotals.set(key, value);
        }
      } else if (record?.kind === "event" && record.event?.event_id) {
        this.events.set(record.event.event_id, record.event);
        this.#remember(record.event.event_id);
        this.sequence = Math.max(this.sequence, count(record.event.sequence));
        const state = record.event.state_budget;
        if (state?.run_id && state?.state_epoch && state?.token_usage) {
          const key = `${state.run_id}:${state.state_epoch}`;
          const prior = this.stateTotals.get(key);
          if (!prior || count(record.event.sequence) >= prior.sequence) {
            this.stateTotals.set(key, {
              sequence: count(record.event.sequence),
              usage: state.token_usage,
            });
          }
        }
      } else if (record?.kind === "ack" && record.event_id) {
        this.acked.add(record.event_id);
      }
    }
    this.#pruneStateTotals();
  }

  #remember(eventId) {
    if (this.seenEventIds.has(eventId)) return;
    this.seenEventIds.add(eventId);
    this.recentEventIds.push(eventId);
    while (this.recentEventIds.length > 10_000) {
      const expired = this.recentEventIds.shift();
      if (!this.events.has(expired) || this.acked.has(expired)) this.seenEventIds.delete(expired);
    }
  }

  #pruneStateTotals() {
    if (this.stateTotals.size <= 1_000) return;
    const pendingKeys = new Set(this.pending().flatMap((event) => {
      const budget = event.state_budget;
      return budget?.run_id && budget?.state_epoch ? [`${budget.run_id}:${budget.state_epoch}`] : [];
    }));
    for (const key of this.stateTotals.keys()) {
      if (this.stateTotals.size <= 1_000) break;
      if (!pendingKeys.has(key)) this.stateTotals.delete(key);
    }
  }

  appendUsage(normalized, binding, identity = binding) {
    if (this.seenEventIds.has(normalized.event_id)) {
      return { event: this.events.get(normalized.event_id) ?? null, duplicate: true };
    }
    const sequence = ++this.sequence;
    let stateBudget = null;
    if (binding) {
      const key = `${binding.run_id}:${binding.state_epoch}`;
      const previous = this.stateTotals.get(key)?.usage ?? emptyUsage();
      const cumulative = addUsage(previous, normalized.token_usage_delta);
      stateBudget = {
        run_id: binding.run_id,
        state: binding.state,
        state_epoch: binding.state_epoch,
        provider: normalized.provider,
        model: normalized.model,
        effort: normalized.effort,
        precision: "exact",
        token_usage: cumulative,
        token_attribution: {
          reported_reasoning_output_tokens: cumulative.reasoning_output_tokens,
        },
      };
      this.stateTotals.delete(key);
      this.stateTotals.set(key, { sequence, usage: cumulative });
      this.#pruneStateTotals();
    }
    // A delayed provider event must remain attached to the binding active when
    // it was emitted. `identity` is the latest binding for the conversation
    // and can belong to a later workflow run after a routed restart.
    const eventIdentity = binding ?? identity;
    const event = {
      event_id: normalized.event_id,
      run_id: eventIdentity?.run_id ?? null,
      run_session_id: eventIdentity?.run_session_id ?? null,
      workflow: eventIdentity?.workflow ?? null,
      thread_id: normalized.conversation_id,
      provider_session_id: normalized.conversation_id,
      ...(normalized.turn_id ? {turn_id: normalized.turn_id} : {}),
      root_session_id: eventIdentity?.root_session_id ?? normalized.conversation_id,
      event: "provider_token_usage",
      source: normalized.source,
      provider: normalized.provider,
      precision: normalized.precision,
      state: binding?.state ?? null,
      binding_status: binding ? "bound" : "unbound",
      timestamp: normalized.source_event_at,
      received_at: normalized.received_at,
      sequence,
      model: normalized.model,
      effort: normalized.effort,
      token_usage_delta: normalized.token_usage_delta,
      state_budget: stateBudget,
    };
    appendDurably(this.path, { kind: "event", event });
    this.events.set(event.event_id, event);
    this.#remember(event.event_id);
    this.onUsageAppended(event);
    return { event, duplicate: false };
  }

  appendTool(normalized, binding, identity = binding) {
    if (this.seenEventIds.has(normalized.event_id)) {
      return { event: this.events.get(normalized.event_id) ?? null, duplicate: true };
    }
    const sequence = ++this.sequence;
    const event = {
      event_id: normalized.event_id,
      run_id: identity?.run_id ?? null,
      run_session_id: identity?.run_session_id ?? null,
      workflow: identity?.workflow ?? null,
      thread_id: normalized.conversation_id,
      provider_session_id: normalized.conversation_id,
      root_session_id: identity?.root_session_id ?? normalized.conversation_id,
      event: "tool_completed",
      source: normalized.source,
      provider: normalized.provider,
      precision: "estimated",
      state: binding?.state ?? null,
      binding_status: binding ? "bound" : "unbound",
      timestamp: normalized.source_event_at,
      received_at: normalized.received_at,
      sequence,
      state_budget: binding ? {
        run_id: binding.run_id,
        state: binding.state,
        state_epoch: binding.state_epoch,
        provider: normalized.provider,
        precision: "estimated",
      } : null,
      tool: {
        invocation_id: normalized.invocation_id,
        tool: normalized.tool,
        tool_type: "codex_custom",
        result_bytes: normalized.result_bytes,
        estimated_input_tokens: Math.floor(normalized.result_bytes / 4),
        exit_code: normalized.exit_code,
        is_error: normalized.is_error,
      },
    };
    appendDurably(this.path, { kind: "event", event });
    this.events.set(event.event_id, event);
    this.#remember(event.event_id);
    return { event, duplicate: false };
  }

  has(eventId) {
    return this.seenEventIds.has(eventId);
  }

  acknowledge(eventId) {
    if (this.acked.has(eventId)) return false;
    appendDurably(this.path, {
      kind: "ack",
      event_id: eventId,
      acknowledged_at: new Date().toISOString(),
    });
    this.acked.add(eventId);
    if (this.acked.size >= 500) this.compact();
    return true;
  }

  pending(limit = Number.POSITIVE_INFINITY) {
    const pending = [];
    for (const event of this.events.values()) {
      if (this.acked.has(event.event_id)) continue;
      pending.push(event);
      if (pending.length >= limit) break;
    }
    return pending;
  }

  pendingCount() {
    let count = 0;
    for (const event of this.events.values()) if (!this.acked.has(event.event_id)) count += 1;
    return count;
  }

  compact() {
    const pending = this.pending();
    this.#pruneStateTotals();
    const retainedIds = new Set([
      ...this.recentEventIds,
      ...pending.map((event) => event.event_id),
    ]);
    const checkpoint = {
      kind: "checkpoint",
      sequence: this.sequence,
      seen_event_ids: [...retainedIds].sort(),
      state_totals: Object.fromEntries(this.stateTotals),
    };
    const temporary = `${this.path}.tmp-${process.pid}`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const fd = openSync(temporary, "w", 0o600);
    try {
      const records = [
        checkpoint,
        ...pending.map((event) => ({ kind: "event", event })),
      ];
      writeFileSync(fd, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
    this.events = new Map(pending.map((event) => [event.event_id, event]));
    this.seenEventIds = retainedIds;
    this.recentEventIds = this.recentEventIds.filter((eventId) => retainedIds.has(eventId));
    this.acked.clear();
  }
}

export class DurableLogOutbox {
  constructor(path) {
    this.path = path;
    this.sourceSequence = 0;
    this.events = new Map();
    this.acked = new Set();
    this.seenEventIds = new Set();
    this.recentEventIds = [];
    for (const record of readJsonLines(path)) {
      if (record?.kind === "event" && record.event?.event_id) {
        this.events.set(record.event.event_id, record.event);
        this.sourceSequence = Math.max(this.sourceSequence, count(record.event.sequence));
        this.#remember(record.event.event_id);
      } else if (record?.kind === "ack" && record.event_id) {
        this.acked.add(record.event_id);
      } else if (record?.kind === "checkpoint") {
        this.sourceSequence = Math.max(this.sourceSequence, count(record.source_sequence));
        for (const eventId of record.seen_event_ids ?? []) this.#remember(eventId);
      }
    }
  }

  #remember(eventId) {
    if (this.seenEventIds.has(eventId)) return;
    this.seenEventIds.add(eventId);
    this.recentEventIds.push(eventId);
    while (this.recentEventIds.length > 1_000) {
      this.seenEventIds.delete(this.recentEventIds.shift());
    }
  }

  append(event) {
    if (this.seenEventIds.has(event.event_id)) return { event: this.events.get(event.event_id) ?? null, duplicate: true };
    appendDurably(this.path, { kind: "event", event });
    this.sourceSequence = Math.max(this.sourceSequence, count(event.sequence));
    this.events.set(event.event_id, event);
    this.#remember(event.event_id);
    return { event, duplicate: false };
  }

  pending(limit = Number.POSITIVE_INFINITY) {
    const pending = [];
    for (const event of this.events.values()) {
      if (this.acked.has(event.event_id)) continue;
      pending.push(event);
      if (pending.length >= limit) break;
    }
    return pending;
  }

  pendingCount() {
    let count = 0;
    for (const event of this.events.values()) if (!this.acked.has(event.event_id)) count += 1;
    return count;
  }

  acknowledge(eventId) {
    if (this.acked.has(eventId)) return false;
    appendDurably(this.path, { kind: "ack", event_id: eventId, acknowledged_at: new Date().toISOString() });
    this.acked.add(eventId);
    if (this.acked.size >= 500) this.compact();
    return true;
  }

  compact() {
    const pending = this.pending();
    const records = [
      { kind: "checkpoint", seen_event_ids: this.recentEventIds, source_sequence: this.sourceSequence },
      ...pending.map((event) => ({ kind: "event", event })),
    ];
    const temporary = `${this.path}.tmp-${process.pid}`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
    this.events = new Map(pending.map((event) => [event.event_id, event]));
    this.acked.clear();
  }
}

class BoundedDiagnosticLog {
  constructor(path, maxRecords = 100) {
    this.path = path;
    this.maxRecords = maxRecords;
    this.records = [...readJsonLines(path)].slice(-maxRecords);
  }

  append(record) {
    const bounded = {
      event_id: text(record.event_id, 64),
      run_id: text(record.run_id, 64),
      status: count(record.status),
      reason: text(record.reason, 120),
      quarantined_at: new Date().toISOString(),
    };
    appendDurably(this.path, bounded);
    this.records.push(bounded);
    if (this.records.length <= this.maxRecords) return;
    this.records = this.records.slice(-this.maxRecords);
    const temporary = `${this.path}.tmp-${process.pid}`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, `${this.records.map((item) => JSON.stringify(item)).join("\n")}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
}

function findSessionFile(root, conversationId) {
  if (!existsSync(root)) return null;
  const suffix = `${conversationId}.jsonl`;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.endsWith(suffix)) return candidate;
    }
  }
  return null;
}

class CodexJsonlToolTailer {
  constructor({ sessionsDir, cursorPath, onEvent, onDiagnostic }) {
    this.sessionsDir = sessionsDir;
    this.cursorPath = cursorPath;
    this.onEvent = onEvent;
    this.onDiagnostic = onDiagnostic;
    this.cursors = existsSync(cursorPath) ? JSON.parse(readFileSync(cursorPath, "utf8")) : {};
    this.paths = new Map();
    this.calls = new Map();
    this.missingPaths = new Map();
    this.missingPathRetryMs = 60_000;
  }

  #save() {
    const temporary = `${this.cursorPath}.tmp-${process.pid}`;
    mkdirSync(dirname(this.cursorPath), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(this.cursors));
    renameSync(temporary, this.cursorPath);
    chmodSync(this.cursorPath, 0o600);
  }

  #prime(path, size) {
    if (Object.hasOwn(this.cursors, path)) return false;
    // Preserve a small pre-existing tail for a collector that starts just
    // after its state boundary. Long-lived transcripts begin at EOF: replaying
    // their historical session would be stale telemetry and unbounded I/O.
    const cursor = size <= MAX_CODEX_JSONL_READ_BYTES ? 0 : size;
    this.cursors[path] = cursor;
    this.#save();
    return cursor === size;
  }

  #readCompleteLines(path, offset, size) {
    const length = Math.min(size - offset, MAX_CODEX_JSONL_READ_BYTES);
    if (length <= 0) return { records: [], nextOffset: offset };
    const bytes = Buffer.allocUnsafe(length);
    const descriptor = openSync(path, "r");
    let read = 0;
    try {
      read = readSync(descriptor, bytes, 0, length, offset);
    } finally {
      closeSync(descriptor);
    }
    const data = bytes.subarray(0, read);
    const completeEnd = data.lastIndexOf(0x0A);
    // A single transcript record can exceed the bounded window. Advance over
    // the window so that a later poll can find its trailing newline; the
    // malformed tail fragment is ignored and later records remain observable.
    if (completeEnd < 0) {
      return {
        records: [],
        nextOffset: offset + read,
        skippedOversizedRecord: read === length,
      };
    }
    const records = data.subarray(0, completeEnd + 1).toString("utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    return { records, nextOffset: offset + completeEnd + 1, skippedOversizedRecord: false };
  }

  poll(conversationIds) {
    let observed = 0;
    for (const conversationId of conversationIds) {
      const retryAt = this.missingPaths.get(conversationId) ?? 0;
      const path = this.paths.get(conversationId) ??
        (retryAt > Date.now() ? null : findSessionFile(this.sessionsDir, conversationId));
      if (!path) {
        this.missingPaths.set(conversationId, Date.now() + this.missingPathRetryMs);
        continue;
      }
      this.missingPaths.delete(conversationId);
      this.paths.set(conversationId, path);
      const size = statSync(path).size;
      if (this.#prime(path, size)) continue;
      const offset = Math.min(Number(this.cursors[path] || 0), size);
      if (offset === size) continue;
      const { records, nextOffset, skippedOversizedRecord } = this.#readCompleteLines(path, offset, size);
      if (nextOffset === offset) continue;
      const calls = this.calls.get(conversationId) ?? new Map();
      for (const event of inspectCodexCustomToolRecords(records, conversationId, calls)) {
        this.onEvent(event);
        observed++;
      }
      this.calls.set(conversationId, calls);
      this.cursors[path] = nextOffset;
      this.#save();
      if (skippedOversizedRecord) {
        this.onDiagnostic?.(
          `Skipped an oversized Codex JSONL record after reading ${MAX_CODEX_JSONL_READ_BYTES} bytes.`,
        );
      }
    }
    return observed;
  }
}

export class PendingBindingLedger {
  constructor(path, {
    correlationWindowMs = 5_000,
    retentionMs = 24 * 60 * 60 * 1_000,
    maxRecords = 10_000,
  } = {}) {
    this.path = path;
    this.correlationWindowMs = correlationWindowMs;
    this.retentionMs = retentionMs;
    this.maxRecords = maxRecords;
    this.events = new Map();
    this.released = new Set();
    for (const record of readJsonLines(path)) {
      if (record?.kind === "event" && record.event?.event_id) {
        this.events.set(record.event.event_id, record.event);
      } else if (record?.kind === "release" && record.event_id) {
        this.released.add(record.event_id);
      }
    }
    for (const eventId of this.released) this.events.delete(eventId);
  }

  append(normalized) {
    if (this.events.has(normalized.event_id) || this.released.has(normalized.event_id)) {
      return false;
    }
    appendDurably(this.path, { kind: "event", event: normalized });
    this.events.set(normalized.event_id, normalized);
    return true;
  }

  release(eventId) {
    if (!this.events.has(eventId)) return false;
    appendDurably(this.path, {
      kind: "release",
      event_id: eventId,
      released_at: new Date().toISOString(),
    });
    this.events.delete(eventId);
    this.released.add(eventId);
    if (this.released.size >= 500) this.compact();
    return true;
  }

  pending() {
    return [...this.events.values()]
      .sort((left, right) => left.source_event_at.localeCompare(right.source_event_at));
  }

  isMature(event, now = Date.now()) {
    return new Date(event.received_at).getTime() <= now - this.correlationWindowMs;
  }

  unbound(now = Date.now(), limit = 100) {
    return this.pending()
      .filter((event) => this.isMature(event, now))
      .slice(-limit)
      .map((event) => ({
        event_id: event.event_id,
        conversation_id: event.conversation_id,
        source_event_at: event.source_event_at,
        received_at: event.received_at,
        provider: event.provider,
        model: event.model,
        effort: event.effort,
        precision: event.precision,
        token_usage_delta: event.token_usage_delta,
        binding_status: "unbound",
      }));
  }

  prune(now = Date.now()) {
    const pending = this.pending();
    const expired = pending.filter((event) =>
      new Date(event.received_at).getTime() < now - this.retentionMs);
    const remaining = pending.length - expired.length;
    const overflow = Math.max(0, remaining - this.maxRecords);
    const removals = [...expired, ...pending
      .filter((event) => !expired.includes(event))
      .slice(0, overflow)];
    for (const event of removals) this.release(event.event_id);
    if (removals.length > 0) this.compact();
    return removals.length;
  }

  compact() {
    const temporary = `${this.path}.tmp-${process.pid}`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const fd = openSync(temporary, "w", 0o600);
    try {
      const body = this.pending()
        .map((event) => JSON.stringify({ kind: "event", event }))
        .join("\n");
      writeFileSync(fd, body ? `${body}\n` : "");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
    this.released.clear();
  }
}

export class LocalTelemetryService {
  constructor({
    dataDir,
    pocketbaseUrl,
    gatewayUrl = "",
    apiKey,
    fetchImpl = globalThis.fetch,
    buildId = TELEMETRY_AGENT_BUILD_ID,
    host = "127.0.0.1",
    port = 4318,
    rawCaptureDestination = "",
    codexSessionsDir = "",
    correlationWindowMs = 5_000,
    unboundRetentionMs = 24 * 60 * 60 * 1_000,
    maxUnboundRecords = 10_000,
    activeBindingWindowMs = 6 * 60 * 60 * 1_000,
    liveRequestTimeoutMs = DEFAULT_LIVE_REQUEST_TIMEOUT_MS,
    primaryRequestTimeoutMs = DEFAULT_LIVE_REQUEST_TIMEOUT_MS,
    maxDrainEvents = 100,
    maxDrainMs = 1_500,
  }) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const scopedDataDir = credentialScopedDataDir(dataDir, apiKey);
    mkdirSync(scopedDataDir, { recursive: true, mode: 0o700 });
    this.scopedDataDir = scopedDataDir;
    this.bindings = new BindingLedger(join(scopedDataDir, "bindings.jsonl"));
    this.liveProjectionCandidates = new Map();
    this.outbox = new DurableOutbox(join(scopedDataDir, "outbox.jsonl"), {
      onUsageAppended: event => {
        if (gatewayUrl) this.liveProjectionCandidates.set(event.event_id, event);
      },
    });
    this.logOutbox = new DurableLogOutbox(join(scopedDataDir, "tool-logs.jsonl"));
    this.liveUsageOutbox = new DurableLogOutbox(join(scopedDataDir, "live-usage-outbox.jsonl"));
    // One recovery pass at startup; subsequent drains only inspect a bounded
    // page, including when primary delivery remains unavailable indefinitely.
    for (const event of this.outbox.events.values()) {
      if (gatewayUrl && !this.outbox.acked.has(event.event_id) && event.sequence > this.liveUsageOutbox.sourceSequence) {
        this.liveProjectionCandidates.set(event.event_id, event);
      }
    }
    this.liveUsageQuarantine = new BoundedDiagnosticLog(join(scopedDataDir, "live-usage-quarantine.jsonl"));
    this.pendingBindings = new PendingBindingLedger(
      join(scopedDataDir, "pending-bindings.jsonl"),
      {
        correlationWindowMs,
        retentionMs: unboundRetentionMs,
        maxRecords: maxUnboundRecords,
      },
    );
    this.pocketbaseUrl = pocketbaseUrl.replace(/\/$/, "");
    this.gatewayUrl = gatewayUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    // `capture_output` is the workflow-level opt-in. The collector also
    // requires an explicitly configured raw-capture destination so no
    // deployment identity or private endpoint is compiled into the plugin.
    const captureDestination = String(rawCaptureDestination).trim();
    if (captureDestination) {
      const parsed = new URL(captureDestination);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Raw tool capture destination must use HTTP or HTTPS.");
      }
    }
    this.rawCaptureDestination = captureDestination;
    this.rawCaptureEnabled = Boolean(this.rawCaptureDestination);
    this.fetchImpl = fetchImpl;
    this.activeBindingWindowMs = activeBindingWindowMs;
    this.primaryFlushing = false;
    this.liveFlushing = false;
    this.liveRequestTimeoutMs = liveRequestTimeoutMs;
    this.primaryRequestTimeoutMs = primaryRequestTimeoutMs;
    this.maxDrainEvents = maxDrainEvents;
    this.maxDrainMs = maxDrainMs;
    this.identity = telemetryIdentity({
      pocketbaseUrl,
      gatewayUrl,
      apiKey,
      buildId,
      host,
      port,
      dataDir,
      rawCaptureDestination,
    });
    this.receiver = {
      requests: 0,
      accepted: 0,
      reconciled: 0,
      ignored: 0,
      protocol_errors: 0,
      last_received_at: null,
      last_accepted_at: null,
      last_reconciled_at: null,
      last_protocol_error: null,
    };
    this.delivery = {
      status: "idle",
      consecutive_failures: 0,
      last_error: null,
      next_attempt_at: null,
    };
    this.liveDelivery = {
      status: "idle",
      consecutive_failures: 0,
      last_error: null,
      next_attempt_at: null,
    };
    this.jsonlTailer = codexSessionsDir
      ? new CodexJsonlToolTailer({
        sessionsDir: codexSessionsDir,
        cursorPath: join(scopedDataDir, "codex-jsonl-cursors.json"),
        onEvent: (event) => this.ingestCodexTool(event),
        onDiagnostic: (message) => { this.receiver.last_protocol_error = `Codex JSONL tailer: ${message}`; },
      })
      : null;
  }

  bind(input) {
    const result = this.bindings.append(input);
    const reconciled = this.reconcilePendingBindings();
    if (reconciled > 0) {
      this.receiver.reconciled += reconciled;
      this.receiver.last_reconciled_at = new Date().toISOString();
    }
    return { ...result, reconciled };
  }

  reconcilePendingBindings(now = Date.now()) {
    let reconciled = 0;
    this.bindings.refresh();
    for (const normalized of this.pendingBindings.pending()) {
      if (!this.pendingBindings.isMature(normalized, now)) continue;
      const identity = this.bindings.identity(normalized.conversation_id, { refresh: false });
      if (!identity) continue;
      const binding = this.bindings.resolve(
        normalized.conversation_id,
        normalized.source_event_at,
        { refresh: false },
      );
      this.outbox.appendUsage(normalized, binding, identity);
      this.pendingBindings.release(normalized.event_id);
      reconciled += 1;
    }
    this.pendingBindings.prune(now);
    return reconciled;
  }

  ingestOtlp(document, receivedAt = new Date().toISOString()) {
    const inspected = inspectOtlpLogs(document, receivedAt);
    const result = {
      accepted: 0,
      buffered: 0,
      duplicate: 0,
      ignored: inspected.ignored,
      protocol_errors: inspected.protocol_errors,
    };
    const appendedIds = [];
    this.receiver.requests += 1;
    this.receiver.ignored += inspected.ignored;
    this.receiver.protocol_errors += inspected.protocol_errors;
    this.receiver.last_received_at = timestamp(receivedAt);
    if (inspected.last_protocol_error) {
      this.receiver.last_protocol_error = inspected.last_protocol_error;
    }
    for (const normalized of inspected.events) {
      if (this.outbox.has(normalized.event_id)) {
        result.duplicate += 1;
        continue;
      }
      if (this.pendingBindings.append(normalized)) {
        result.accepted += 1;
        appendedIds.push(normalized.event_id);
      } else {
        result.duplicate += 1;
      }
    }
    const reconciled = this.reconcilePendingBindings();
    this.receiver.reconciled += reconciled;
    if (reconciled > 0) this.receiver.last_reconciled_at = timestamp(receivedAt);
    const stillPending = new Set(
      this.pendingBindings.pending().map((event) => event.event_id),
    );
    result.buffered = appendedIds.filter((eventId) => stillPending.has(eventId)).length;
    this.receiver.accepted += result.accepted;
    if (result.accepted > 0) this.receiver.last_accepted_at = timestamp(receivedAt);
    return result;
  }

  ingestCodexTool(normalized) {
    const binding = this.bindings.resolve(
      normalized.conversation_id,
      normalized.source_event_at,
    );
    if (!binding) return { accepted: 0, ignored: 1 };
    const usage = this.outbox.appendTool(normalized, binding, binding);
    let rawQueued = 0;
    if (this.rawCaptureEnabled && binding.capture_output) {
      const sequence = Number.parseInt(normalized.event_id.slice(0, 12), 16);
      const raw = this.logOutbox.append({
        event_id: normalized.event_id,
        run_id: binding.run_id,
        run_session_id: binding.run_session_id,
        workflow: binding.workflow,
        phase: binding.state,
        source: "codex_jsonl",
        tool_name: normalized.tool,
        tool_input: normalized.tool_input,
        tool_output: normalized.tool_output,
        exit_code: normalized.exit_code,
        sequence: Number.isSafeInteger(sequence) ? sequence : 0,
        duration_ms: 0,
      });
      rawQueued = raw.duplicate ? 0 : 1;
    }
    return { accepted: usage.duplicate ? 0 : 1, raw_queued: rawQueued, ignored: 0 };
  }

  async maintain() {
    let customTools = 0;
    try {
      customTools = this.jsonlTailer
        ? this.jsonlTailer.poll(this.bindings.activeConversationIds(
          Date.now() - this.activeBindingWindowMs,
        ))
        : 0;
    } catch (error) {
      this.receiver.last_protocol_error = `Codex JSONL tailer: ${text(error?.message || error, 240)}`;
    }
    const reconciled = this.reconcilePendingBindings();
    if (reconciled > 0) {
      this.receiver.reconciled += reconciled;
      this.receiver.last_reconciled_at = new Date().toISOString();
    }
    return { ...(await this.flush()), custom_tools: customTools };
  }

  async flush() {
    const pending = this.outbox.pendingCount() + this.logOutbox.pendingCount();
    if (!this.apiKey) return { delivered: 0, pending };
    if (this.primaryFlushing) {
      await this.flushLive();
      return { delivered: 0, pending };
    }
    const nextAttemptAt = this.delivery.next_attempt_at
      ? new Date(this.delivery.next_attempt_at).getTime()
      : 0;
    if (nextAttemptAt > Date.now()) {
      await this.flushLive();
      return { delivered: 0, pending, deferred: true };
    }
    this.primaryFlushing = true;
    let delivered = 0;
    let attempted = 0;
    const drainDeadline = Date.now() + this.maxDrainMs;
    try {
      for (const event of this.outbox.pending(this.maxDrainEvents)) {
        if (attempted >= this.maxDrainEvents || Date.now() >= drainDeadline) break;
        attempted += 1;
        if (
          this.gatewayUrl &&
          event.event === "provider_token_usage" &&
          event.run_id &&
          event.run_session_id &&
          event.state_budget?.state &&
          event.state_budget?.state_epoch &&
          event.state_budget?.precision !== "unavailable"
        ) {
          // Queue the live projection before acknowledging PocketBase so a
          // crash between the two destinations cannot lose the live update.
          this.liveUsageOutbox.append(event);
          this.liveProjectionCandidates.delete(event.event_id);
        }
        try {
          const response = await fetchWithTimeout(
            this.fetchImpl,
            `${this.pocketbaseUrl}/api/gateway/telemetry/events`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`,
              },
              body: JSON.stringify({ events: [event] }),
            },
            this.primaryRequestTimeoutMs,
          );
          if (!response.ok) {
            throw new Error(`PocketBase telemetry upload returned HTTP ${response.status}`);
          }
          const receipt = await response.json().catch(() => ({}));
          const acknowledged = [
            ...(Array.isArray(receipt.accepted_event_ids) ? receipt.accepted_event_ids : []),
            ...(Array.isArray(receipt.duplicate_event_ids) ? receipt.duplicate_event_ids : []),
          ];
          if (!acknowledged.includes(event.event_id)) {
            throw new Error("PocketBase telemetry response did not acknowledge the submitted event ID");
          }
        } catch (error) {
          const failures = this.delivery.consecutive_failures + 1;
          const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(6, failures - 1)));
          this.delivery = {
            status: "degraded",
            consecutive_failures: failures,
            last_error: text(error?.message || error, 240),
            next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
          };
          break;
        }
        this.outbox.acknowledge(event.event_id);
        this.liveProjectionCandidates.delete(event.event_id);
        delivered += 1;
      }
      for (const log of this.logOutbox.pending(this.maxDrainEvents - attempted)) {
        if (attempted >= this.maxDrainEvents || Date.now() >= drainDeadline) break;
        attempted += 1;
        try {
          const response = await fetchWithTimeout(
            this.fetchImpl,
            this.rawCaptureDestination,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`,
              },
              body: JSON.stringify(log),
            },
            this.primaryRequestTimeoutMs,
          );
          if (!response.ok) {
            throw new Error(`PocketBase workflow-log upload returned HTTP ${response.status}`);
          }
        } catch (error) {
          const failures = this.delivery.consecutive_failures + 1;
          const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(6, failures - 1)));
          this.delivery = {
            status: "degraded",
            consecutive_failures: failures,
            last_error: text(error?.message || error, 240),
            next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
          };
          break;
        }
        this.logOutbox.acknowledge(log.event_id);
        delivered += 1;
      }
      if (delivered > 0 && this.outbox.pendingCount() === 0 && this.logOutbox.pendingCount() === 0) {
        this.delivery = {
          status: "healthy",
          consecutive_failures: 0,
          last_error: null,
          next_attempt_at: null,
        };
      }
      const result = { delivered, pending: this.outbox.pendingCount() + this.logOutbox.pendingCount() };
      // The live ledger has its own lock and timeout. Awaiting it here keeps
      // explicit flushes deterministic without holding the primary delivery
      // lock, so another flush can continue PocketBase/log delivery even if
      // the Gateway request stalls.
      this.primaryFlushing = false;
      await this.flushLive();
      return result;
    } finally {
      this.primaryFlushing = false;
    }
  }

  async flushLive() {
    if (this.liveFlushing || !this.apiKey || !this.gatewayUrl) return;
    // Recover/project independently of PocketBase progress, in source order.
    // The watermark is persisted with the live outbox (including compaction),
    // so an indefinitely failing primary cannot repeatedly refill old batches.
    let inspected = 0;
    const projectionDeadline = Date.now() + this.maxDrainMs;
    for (const event of this.liveProjectionCandidates.values()) {
      if (inspected++ >= this.maxDrainEvents || Date.now() >= projectionDeadline) break;
      if (event.sequence > this.liveUsageOutbox.sourceSequence &&
          event.event === "provider_token_usage" && event.run_id && event.run_session_id &&
          event.state_budget?.state && event.state_budget?.state_epoch &&
          event.state_budget?.precision !== "unavailable") {
        this.liveUsageOutbox.append(event);
      }
      this.liveProjectionCandidates.delete(event.event_id);
    }
    const nextAttemptAt = this.liveDelivery.next_attempt_at
      ? new Date(this.liveDelivery.next_attempt_at).getTime()
      : 0;
    if (nextAttemptAt > Date.now()) return;
    this.liveFlushing = true;
    let quarantined = false;
    let attempted = 0;
    const drainDeadline = Date.now() + this.maxDrainMs;
    try {
      for (const event of this.liveUsageOutbox.pending(this.maxDrainEvents)) {
        if (attempted >= this.maxDrainEvents || Date.now() >= drainDeadline) break;
        attempted += 1;
        try {
          const response = await fetchWithTimeout(
            this.fetchImpl,
            `${this.gatewayUrl}/api/runtime-usage`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`,
              },
              body: JSON.stringify({
                run_id: event.run_id,
                run_session_id: event.run_session_id,
                usage: {
                  sequence: event.sequence,
                  state: event.state_budget.state,
                  state_epoch: event.state_budget.state_epoch,
                  provider: event.state_budget.provider,
                  model: event.state_budget.model ?? event.model ?? null,
                  effort: event.state_budget.effort ?? event.effort ?? null,
                  precision: event.state_budget.precision,
                  token_usage: event.state_budget.token_usage,
                },
              }),
            },
            this.liveRequestTimeoutMs,
          );
          if (response.status === 409) {
            const detail = await response.json().catch(() => ({}));
            if (!["duplicate_or_stale", "stale_state", "inactive_run", "inactive_session", "superseded", "unavailable"].includes(detail.error)) {
              throw new Error(`Gateway runtime usage rejected report: ${detail.error ?? "unknown"}`);
            }
          } else if (response.status === 401 || response.status === 403) {
            this.liveUsageQuarantine.append({
              event_id: event.event_id,
              run_id: event.run_id,
              status: response.status,
              reason: "credential_generation_mismatch",
            });
            this.liveUsageOutbox.acknowledge(event.event_id);
            quarantined = true;
            continue;
          } else if (!response.ok) {
            throw new Error(`Gateway runtime usage upload returned HTTP ${response.status}`);
          }
          this.liveUsageOutbox.acknowledge(event.event_id);
        } catch (error) {
          const failures = this.liveDelivery.consecutive_failures + 1;
          const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(6, failures - 1)));
          this.liveDelivery = {
            status: "degraded",
            consecutive_failures: failures,
            last_error: text(error?.message || error, 240),
            next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
          };
          break;
        }
      }
      if (this.liveUsageOutbox.pendingCount() === 0) {
        this.liveDelivery = {
          status: quarantined ? "quarantined" : "healthy",
          consecutive_failures: 0,
          last_error: quarantined ? "One or more reports belonged to a different credential generation" : null,
          next_attempt_at: null,
        };
      }
    } finally {
      this.liveFlushing = false;
    }
  }
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body exceeds 1 MiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createLocalTelemetryServer(service, {
  host = "127.0.0.1",
  port = 4318,
  flushIntervalMs = 5_000,
} = {}) {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        return jsonResponse(response, 200, {
          status: "ok",
          listener_status: "healthy",
          delivery_status: service.delivery.status,
          last_delivery_error: service.delivery.last_error,
          pending: service.outbox.pending().length,
          live_delivery_status: service.liveDelivery.status,
          last_live_delivery_error: service.liveDelivery.last_error,
          pending_live_usage: service.liveUsageOutbox.pending().length,
          quarantined_live_usage: service.liveUsageQuarantine.records.length,
          pending_bindings: service.pendingBindings.pending().length,
          unbound_visible: service.pendingBindings.unbound().length,
          receiver: service.receiver,
          ...service.identity,
        });
      }
      if (request.method === "GET" && request.url === "/v1/unbound") {
        return jsonResponse(response, 200, {
          events: service.pendingBindings.unbound(),
        });
      }
      if (request.method !== "POST") return jsonResponse(response, 404, { error: "not found" });
      const body = await readJsonBody(request);
      if (request.url === "/v1/logs") {
        const result = service.ingestOtlp(body);
        void service.maintain().catch(() => {});
        return jsonResponse(response, 200, result);
      }
      if (request.url === "/v1/state-bindings") {
        const result = service.bind(body);
        void service.maintain().catch(() => {});
        return jsonResponse(response, 202, {
          accepted: result.duplicate ? 0 : 1,
          reconciled: result.reconciled,
        });
      }
      return jsonResponse(response, 404, { error: "not found" });
    } catch (error) {
      return jsonResponse(response, 400, { error: text(error?.message || error, 240) });
    }
  });
  const timer = setInterval(() => void service.maintain().catch(() => {}), flushIntervalMs);
  timer.unref();
  server.on("close", () => clearInterval(timer));
  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve(server.address());
      });
    }),
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
