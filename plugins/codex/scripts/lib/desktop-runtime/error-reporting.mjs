import { randomUUID } from "node:crypto";

// This is intentionally dependency-free. Managed runtimes are bundled into
// multiple plugin distributions, where resolving @sentry/node is not reliable.
// Sentry envelopes let every Node entrypoint share the same scrubber instead.
export const DEFAULT_SENTRY_DSN = "https://3c30b803a5b44d74bf9657db7a89f033@glitch.enhasa.cloud/12";
const MAX_VALUE_BYTES = 2_048;
const SAFE_CONTEXT_FIELDS = new Set([
  "mechanism", "operation", "host", "transport", "side", "close_code",
  "exit_code", "signal", "phase", "runtime", "reason",
]);
const SECRET_PATTERNS = [
  /\b(?:sw_(?:live|test)_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]+)\b/g,
  /(authorization\s*[:=]\s*(?:bearer\s+)?)\S+/gi,
  /\b((?:api[_-]?key|token|secret|password|cookie|session)[A-Za-z0-9_-]*\s*[:=]\s*)[^\s,;]+/gi,
  /([?&](?:api[_-]?key|token|secret|password|access_token)=)[^&#\s]+/gi,
  /(["']?(?:prompt|tool_input|tool_response|payload|arguments|messages|content|input|output)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^,}\]\n]+)/gi,
];

function redactString(value, limit = MAX_VALUE_BYTES) {
  let result = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (_match, prefix) => prefix ? `${prefix}[redacted]` : "[redacted]");
  }
  return result.length > limit ? `${result.slice(0, limit)}…[truncated]` : result;
}

export function sentryEndpoint(dsn) {
  try {
    const parsed = new URL(dsn);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const projectId = parts.at(-1);
    if (!parsed.username || !projectId) return null;
    const prefix = parts.slice(0, -1).join("/");
    return `${parsed.protocol}//${parsed.host}${prefix ? `/${prefix}` : ""}/api/${projectId}/envelope/?sentry_version=7&sentry_key=${encodeURIComponent(parsed.username)}`;
  } catch {
    return null;
  }
}

export function sanitizeError(error) {
  const source = error instanceof Error ? error : new Error(String(error));
  return {
    type: redactString(source.name || "Error", 120),
    // Error messages frequently include upstream bodies, prompts, or the
    // serialized JSON-RPC request. Keep the class for grouping and send the
    // operation/mechanism tags below, but never export arbitrary message text.
    value: "Unexpected plugin failure (message withheld).",
    // Error stacks can embed a rejected request body or prompt through a
    // dependency's error formatting. The mechanism/operation tags identify
    // the runtime locus without exporting that unbounded, user-controlled text.
    stacktrace: undefined,
  };
}

export function sanitizeContext(context = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(context)) {
    if (!SAFE_CONTEXT_FIELDS.has(key) || value == null) continue;
    if (typeof value === "number" || typeof value === "boolean") safe[key] = value;
    else safe[key] = redactString(value, 512);
  }
  return safe;
}

export function isExpectedExit({ code, signal, shuttingDown = false } = {}) {
  if (shuttingDown) return true;
  if (signal === "SIGINT" || signal === "SIGTERM") return true;
  // POSIX shells conventionally surface Ctrl-C / SIGTERM as 128 + signal.
  // Windows Ctrl-C can arrive as STATUS_CONTROL_C_EXIT.
  return code === 0 || code === 130 || code === 143 || code === 3_221_225_786;
}

export function isExpectedTransportClose({ side, code } = {}) {
  return (side === "native_close" || side === "upstream_close") && (code === 1000 || code === 1001 || code === 1005);
}

export function isExpectedPluginError(error) {
  const message = String(error instanceof Error ? error.message : error ?? "");
  return error?.name === "AbortError"
    || /^(?:--(?:host|real-bin|workflow|sandbox|approval-policy|approvals-reviewer|delivery-run-id)|Unknown option:)/.test(message)
    || /^(?:Choose either|Unsupported managed client host|Statewright cannot translate OpenAI model|Provide the task)/.test(message)
    || message.startsWith("[statewright] BLOCKED:")
    || message.includes("requires isolated delivery")
    || message.includes("Native-tool adapter unavailable");
}

export function createErrorReporter({
  plugin,
  version = process.env.npm_package_version ?? "unknown",
  environment = process.env,
  send = defaultSend,
} = {}) {
  const dsn = environment.STATEWRIGHT_SENTRY_DSN ?? DEFAULT_SENTRY_DSN;
  const endpoint = sentryEndpoint(dsn);
  // Public plugin installs must not transmit diagnostics without an explicit
  // operator choice. STATEWRIGHT_SENTRY_DISABLED remains an emergency kill
  // switch for environments that centrally enable reporting.
  const enabled = environment.STATEWRIGHT_SENTRY_ENABLED === "true"
    && environment.STATEWRIGHT_SENTRY_DISABLED !== "true"
    && Boolean(endpoint);
  const seen = new Set();
  const tags = {
    plugin: redactString(plugin ?? "unknown", 120),
    release: `statewright-${redactString(plugin ?? "unknown", 120)}@${redactString(version, 120)}`,
    platform: `${process.platform}-${process.arch}`,
    runtime: "node",
  };

  async function report(error, context = {}) {
    const safeContext = sanitizeContext(context);
    const safeError = sanitizeError(error);
    const fingerprint = `${safeError.type}:${safeError.value}:${safeContext.mechanism ?? ""}:${safeContext.operation ?? ""}`;
    if (!enabled || seen.has(fingerprint)) return false;
    const eventId = randomUUID().replace(/-/g, "");
    const event = {
      event_id: eventId,
      timestamp: new Date().toISOString(),
      platform: "node",
      level: "error",
      release: tags.release,
      environment: redactString(environment.NODE_ENV || "production", 120),
      tags: { ...tags, ...safeContext },
      exception: { values: [safeError] },
    };
    try {
      await send({ endpoint, dsn, event, environment });
      seen.add(fingerprint);
      return true;
    } catch {
      // Reporting must never become a plugin failure or change an exit code.
      return false;
    }
  }

  function installProcessHandlers() {
    process.on("unhandledRejection", (reason) => { void report(reason, { mechanism: "unhandled_rejection" }); });
    process.on("uncaughtExceptionMonitor", (error) => { void report(error, { mechanism: "uncaught_exception" }); });
  }

  return { report, installProcessHandlers, tags };
}

export function formatEnvelope({ dsn, event }) {
  return `${JSON.stringify({ event_id: event.event_id, sent_at: event.timestamp, dsn, sdk: { name: "statewright.plugin", version: "1" } })}\n${JSON.stringify({ type: "event", content_type: "application/json" })}\n${JSON.stringify(event)}\n`;
}

async function defaultSend({ endpoint, dsn, event, environment }) {
  if (!endpoint) return;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-sentry-envelope" },
    body: formatEnvelope({ dsn, event }),
    signal: AbortSignal.timeout(Number(environment.STATEWRIGHT_SENTRY_TIMEOUT_MS ?? 1_000)),
  });
  if (!response.ok) throw new Error(`Sentry envelope rejected with HTTP ${response.status}.`);
}
