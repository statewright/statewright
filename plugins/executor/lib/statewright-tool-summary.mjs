const clean = value => String(value ?? "").replace(/[\x00-\x1f\x7f\x1b]/g, " ").replace(/\s+/g, " ").trim();
const shortModel = value => clean(value).replace(/^openai-codex\//, "");

function resultValue(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  for (const block of result?.content ?? []) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    try { return JSON.parse(block.text); } catch { return block.text; }
  }
  return null;
}

function stateLine(value) {
  if (!value || typeof value !== "object" || !clean(value.state)) return null;
  const route = shortModel(value.model);
  const effort = clean(value.thinking_level);
  const suffix = route ? ` · ${route}${effort ? ` / ${effort}` : ""}` : "";
  const transitions = Array.isArray(value.transitions) ? ` · ${value.transitions.length} transition${value.transitions.length === 1 ? "" : "s"}` : "";
  const pending = value.pending_approval?.to_state ? ` · approval pending → ${clean(value.pending_approval.to_state)}` : "";
  return `${clean(value.state)}${suffix}${transitions}${pending}`;
}

function workflowCount(value) {
  if (Array.isArray(value)) return value.length;
  for (const key of ["workflows", "items", "data"]) if (Array.isArray(value?.[key])) return value[key].length;
  return null;
}

function transitionUsage(value) {
  const used = value?.usage?.transitions ?? value?.transition_count;
  const limit = value?.usage?.limit;
  const remaining = value?.usage?.remaining;
  if (used === undefined && limit === undefined && remaining === undefined) return "";
  const count = used === undefined ? "" : limit === undefined ? clean(used) : `${clean(used)}/${clean(limit)}`;
  const parts = [];
  if (count) parts.push(`${count} transition${String(used) === "1" ? "" : "s"}`);
  if (remaining !== undefined) parts.push(`${clean(remaining)} remaining`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function transitionLine(value) {
  const from = clean(value?.from);
  const to = clean(value?.to);
  const movement = from && to ? `${from} → ${to}` : to || from || "transition";
  let status = "completed";
  if (value?.status === "pending_approval" || value?.requires_approval === true) status = "approval pending";
  else if (value?.branch_completed) status = `branch ${clean(value.branch_completed)} completed`;
  else if (value?.forked === true) status = "forked";
  else if (value?.joined === true) status = "joined";
  else if (value?.forced === true) status = "forced";
  else if (value?.transitioned === true) status = "transitioned";
  return `${movement} · ${status}${transitionUsage(value)}`;
}

function isTransitionReceipt(value) {
  return Boolean(value && typeof value === "object" && ([
    "from", "to", "transitioned", "forced", "forked", "joined", "branch_completed", "requires_approval", "transition_count",
  ].some(key => Object.hasOwn(value, key)) || value.status === "pending_approval"));
}

export function statewrightToolSummary(item) {
  if (!["mcpToolCall", "McpToolCall"].includes(item?.type) || item.server !== "statewright" || typeof item.tool !== "string") return null;
  const value = resultValue(item.result);
  const tool = item.tool.replace(/^statewright_/, "");
  const rawText = typeof value === "string" ? clean(value) : "";
  if (/no active workflow/i.test(rawText)) return "no active workflow";
  if (item.status === "failed" || item.result?.isError === true) {
    return `${clean(tool)} · failed${rawText ? `: ${rawText.slice(0, 180)}` : ""}`;
  }
  if (item.tool === "statewright_get_state") return stateLine(value) ?? "state unavailable";
  if (item.tool === "statewright_transition") {
    if (isTransitionReceipt(value)) return transitionLine(value);
    return stateLine(value) ?? "transition completed";
  }
  if (item.tool === "statewright_load_workflow") {
    const state = value?.state_snapshot ?? value;
    const name = clean(value?.loaded ?? value?.workflow ?? state?.workflow);
    const line = stateLine(state) ?? clean(value?.initial_state);
    return [name, line, "loaded"].filter(Boolean).join(" · ");
  }
  if (["statewright_deactivate", "statewright_pause"].includes(item.tool)) {
    return item.tool.endsWith("pause") ? "workflow paused" : "workflow deactivated";
  }
  if (item.tool === "statewright_list_workflows") {
    const count = workflowCount(value);
    const active = clean(value?.active ?? value?.active_workflow);
    return `workflows · ${count ?? "unknown"} available${active ? ` · active: ${active}` : " · none active"}`;
  }
  if (item.tool === "statewright_get_workflow") {
    const definition = value?.definition ?? value?.workflow ?? value;
    const states = definition?.states && typeof definition.states === "object" ? Object.keys(definition.states).length : null;
    return `workflow ${clean(value?.name ?? definition?.name) || "definition"}${states === null ? "" : ` · ${states} states`}`;
  }
  if (item.tool === "statewright_create_workflow") {
    return `workflow ${clean(value?.name ?? value?.created ?? value?.workflow) || "definition"} · ${value?.overwritten ? "overwritten" : "created"}`;
  }
  if (item.tool === "statewright_get_usage") {
    const used = value?.transitions ?? value?.used;
    const limit = value?.limit;
    return `usage${used !== undefined ? ` · ${clean(used)}${limit !== undefined ? `/${clean(limit)}` : ""}` : ""}`;
  }
  // Search/reference results are user-facing content, not control-plane JSON.
  if (["statewright_search_docs", "statewright_search_references"].includes(item.tool)) return null;
  return `${clean(tool)} · completed`;
}

// The native Codex MCP transport displays result.content verbatim. Replace only
// successful transition JSON with the bounded supervisor line while retaining
// the authoritative object in structuredContent for hooks and other clients.
export function summarizeStatewrightMcpResponse(tool, response) {
  if (tool !== "statewright_transition" || !response?.result || response.result.isError === true) return response;
  const value = resultValue(response.result);
  if (!value || typeof value !== "object" || Array.isArray(value)) return response;
  const summary = statewrightToolSummary({
    type: "mcpToolCall",
    server: "statewright",
    tool,
    status: "completed",
    result: { structuredContent: value },
  });
  if (!summary) return response;
  return {
    ...response,
    result: {
      ...response.result,
      structuredContent: value,
      content: [{ type: "text", text: `Statewright supervisor: ${summary}` }],
    },
  };
}

export function summarizeStatewrightToolCompletion(message) {
  if (message?.method !== "item/completed") return message;
  const summary = statewrightToolSummary(message.params?.item);
  if (!summary) return message;
  const item = message.params.item;
  return { ...message, params: { ...message.params, item: { ...item,
    result: { content: [{ type: "text", text: `Statewright supervisor: ${summary}` }],
      ...(item.result?.isError === true ? { isError: true } : {}) },
  } } };
}
