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

export function statewrightToolSummary(item) {
  if (item?.type !== "mcpToolCall" || item.server !== "statewright" || typeof item.tool !== "string") return null;
  const value = resultValue(item.result);
  const tool = item.tool.replace(/^statewright_/, "");
  const rawText = typeof value === "string" ? clean(value) : "";
  if (/no active workflow/i.test(rawText)) return "no active workflow";
  if (item.status === "failed" || item.result?.isError === true) {
    return `${clean(tool)} · failed${rawText ? `: ${rawText.slice(0, 180)}` : ""}`;
  }
  if (item.tool === "statewright_get_state") return stateLine(value) ?? "state unavailable";
  if (item.tool === "statewright_transition") {
    if (value?.status === "pending_approval") return `${clean(value.from)} → ${clean(value.to)} · approval pending`;
    if (value?.transitioned === true || value?.forced === true) return `${clean(value.from)} → ${clean(value.to)} · transitioned`;
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
