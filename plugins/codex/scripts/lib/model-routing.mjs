const FAMILY_ALIASES = new Set(["sol", "terra", "luna"]);

export const STATE_BOUNDARY_TOOLS = new Set([
  "statewright_start",
  "statewright_load_workflow",
  "statewright_transition",
  "statewright_force_state",
  "statewright_pause",
  "statewright_stop",
  "statewright_deactivate",
]);

function effortNames(entry) {
  const options = entry.supportedReasoningEfforts ?? entry.supported_reasoning_levels ?? [];
  return options
    .map((option) =>
      typeof option === "string"
        ? option
        : option.reasoningEffort ?? option.effort ?? null,
    )
    .filter(Boolean);
}
export function normalizeCatalog(entries) {
  return entries.map((entry) => ({
    id: entry.id ?? entry.slug ?? entry.model,
    model: entry.model ?? entry.slug ?? entry.id,
    displayName: entry.displayName ?? entry.display_name ?? entry.id ?? entry.slug,
    defaultEffort:
      entry.defaultReasoningEffort ??
      entry.default_reasoning_level ??
      entry.defaultEffort ??
      null,
    efforts: effortNames(entry),
    isDefault: entry.isDefault ?? entry.is_default ?? false,
    hidden: entry.hidden ?? entry.visibility === "hide",
  }));
}

function stripProvider(raw) {
  const value = raw.trim();
  for (const prefix of ["openai-codex/", "openai/"]) {
    if (value.toLowerCase().startsWith(prefix)) return value.slice(prefix.length);
  }
  return value;
}

function findFamily(catalog, family) {
  const suffix = `-${family.toLowerCase()}`;
  return catalog.find((model) =>
    [model.id, model.model].some((value) => value?.toLowerCase().endsWith(suffix)),
  );
}

export function findModel(catalog, requested) {
  if (!requested) return null;
  const stripped = stripProvider(requested);
  const lower = stripped.toLowerCase();

  if (FAMILY_ALIASES.has(lower)) return findFamily(catalog, lower);

  return (
    catalog.find((model) => model.id?.toLowerCase() === lower) ??
    catalog.find((model) => model.model?.toLowerCase() === lower) ??
    catalog.find((model) => model.displayName?.toLowerCase() === lower) ??
    null
  );
}

function assertEffort(model, effort, requestedModel) {
  if (!effort) return model.defaultEffort;
  if (model.efforts.length > 0 && !model.efforts.includes(effort)) {
    throw new Error(
      `Statewright requested effort '${effort}' for '${requestedModel}', but ` +
        `the live Codex catalog only advertises: ${model.efforts.join(", ")}`,
    );
  }
  return effort;
}

export function resolveFallbackRoute(catalog, requestedModel = "luna", requestedEffort = "medium") {
  let model = findModel(catalog, requestedModel);
  let source = "configured-fallback";
  if (!model) {
    model = catalog.find((entry) => entry.isDefault) ?? catalog.find((entry) => !entry.hidden);
    source = "catalog-default";
  }
  if (!model) throw new Error("The Codex model catalog is empty.");

  const effort = model.efforts.includes(requestedEffort)
    ? requestedEffort
    : model.defaultEffort ?? model.efforts[0] ?? requestedEffort;

  return {
    model: model.id,
    effort,
    requestedModel,
    requestedEffort,
    source,
  };
}

export function resolveStateRoute(state, catalog, currentRoute) {
  if (!state?.model) {
    return {
      ...currentRoute,
      state: state?.state ?? null,
      requestedModel: null,
      requestedEffort: state?.thinking_level ?? null,
      source: "inherited",
    };
  }

  const model = findModel(catalog, state.model);
  if (!model) {
    throw new Error(
      `Statewright requested model '${state.model}', but it is not in the live Codex model catalog. ` +
        "Refusing to silently reroute the next state.",
    );
  }

  const sameModel = model.id === currentRoute?.model;
  const desiredEffort =
    state.thinking_level ?? (sameModel ? currentRoute?.effort : model.defaultEffort);
  const effort = assertEffort(model, desiredEffort, state.model);

  return {
    state: state.state ?? null,
    model: model.id,
    effort,
    requestedModel: state.model,
    requestedEffort: state.thinking_level ?? null,
    source: "state",
  };
}

export function normalizeToolName(tool) {
  if (!tool) return "";
  for (const candidate of STATE_BOUNDARY_TOOLS) {
    if (tool === candidate || tool.endsWith(candidate)) return candidate;
  }
  return tool;
}

export function isStateBoundaryItem(item, serverName) {
  if (!item || item.type !== "mcpToolCall" || item.status !== "completed") return false;
  if (item.result?.isError === true || item.error) return false;
  if (serverName && item.server !== serverName && !item.server?.endsWith(serverName)) return false;
  return STATE_BOUNDARY_TOOLS.has(normalizeToolName(item.tool));
}

export function parseMcpJsonResult(result) {
  if (!result || result.isError === true) {
    throw new Error("Statewright MCP call failed.");
  }
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result.content?.find((item) => item?.type === "text")?.text;
  if (!text) throw new Error("Statewright MCP response did not contain JSON text.");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Statewright MCP response was not valid JSON: ${error.message}`);
  }
}
