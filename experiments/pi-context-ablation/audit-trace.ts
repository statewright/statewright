/**
 * Pi Audit Trace Extension
 *
 * Logs every tool call, tool result, state transition, model switch,
 * and context window usage to a JSONL file for post-hoc analysis.
 *
 * Usage: symlink or copy to ~/.pi/agent/extensions/audit-trace/
 * Output: /tmp/pi-audit-{session-id}.jsonl
 *
 * Each line is a JSON object with:
 *   { ts, event, tool?, state?, tokens?, duration_ms?, data? }
 */
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function auditTraceExtension(pi: ExtensionAPI) {
  const sessionId = process.env.PI_SESSION_ID || Date.now().toString(36);
  const traceDir = process.env.AUDIT_TRACE_DIR || "/tmp";
  const traceFile = join(traceDir, `pi-audit-${sessionId}.jsonl`);
  let stepCount = 0;
  let lastToolCallTs = 0;

  function emit(event: string, data: Record<string, unknown> = {}) {
    const entry = {
      ts: new Date().toISOString(),
      elapsed_ms: lastToolCallTs ? Date.now() - lastToolCallTs : 0,
      step: stepCount,
      event,
      ...data,
    };
    try {
      appendFileSync(traceFile, JSON.stringify(entry) + "\n");
    } catch {}
  }

  // Session start
  pi.on("session_start" as any, async (_event: unknown, ctx: any) => {
    const model = ctx.model?.id || "unknown";
    const provider = ctx.model?.provider || "unknown";
    emit("session_start", { model, provider, trace_file: traceFile });
    ctx.ui?.notify?.(`[audit] Tracing to ${traceFile}`, "info");
  });

  // Before each agent turn — capture context size
  pi.on("before_agent_start", async (_event, ctx) => {
    stepCount++;
    const usage = (ctx as any).getContextUsage?.();
    emit("agent_turn", {
      step: stepCount,
      context_window: usage?.contextWindow,
      tokens_used: usage?.tokensUsed,
      tokens_remaining: usage?.contextWindow && usage?.tokensUsed
        ? usage.contextWindow - usage.tokensUsed
        : undefined,
    });
  });

  // Tool calls — what tool, what input (truncated)
  pi.on("tool_call", async (event, _ctx) => {
    lastToolCallTs = Date.now();
    const input = event.input || {};
    // Truncate large inputs for the trace
    const truncatedInput: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      truncatedInput[k] = s.length > 500 ? s.slice(0, 500) + "..." : v;
    }
    emit("tool_call", {
      tool: event.toolName,
      input: truncatedInput,
    });
  });

  // Tool results — success/error, output size
  pi.on("tool_result", async (event, _ctx) => {
    const duration = lastToolCallTs ? Date.now() - lastToolCallTs : 0;
    const output = (event as any).result?.content?.[0]?.text || "";
    emit("tool_result", {
      tool: (event as any).toolName || "unknown",
      is_error: !!(event as any).result?.isError,
      output_length: output.length,
      output_preview: output.slice(0, 200),
      duration_ms: duration,
    });
  });

  // Context event — measure what gets sent vs trimmed
  pi.on("context", async (event, _ctx) => {
    const messages = (event as any).messages || [];
    const totalTokensEstimate = messages.reduce((acc: number, m: any) => {
      const content = typeof m.content === "string"
        ? m.content
        : JSON.stringify(m.content || "");
      return acc + Math.ceil(content.length / 4); // rough token estimate
    }, 0);
    emit("context", {
      message_count: messages.length,
      estimated_tokens: totalTokensEstimate,
    });
  });

  // Provider request — what actually gets sent to the model
  pi.on("before_provider_request", async (event, _ctx) => {
    const payload = event as any;
    const messages = payload.messages || [];
    const tools = payload.tools || [];
    emit("provider_request", {
      model: payload.model,
      message_count: messages.length,
      tool_count: tools.length,
      tool_names: tools.map((t: any) => t.function?.name || t.name || "?").slice(0, 20),
    });
  });

  // Session end summary
  pi.on("session_end" as any, async () => {
    emit("session_end", {
      total_steps: stepCount,
    });
  });
}
