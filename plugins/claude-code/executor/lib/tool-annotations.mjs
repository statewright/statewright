// Compatibility for gateways predating MCP tool annotations. Remove bridge
// enrichment once every supported gateway emits these hints itself.
export const STATEWRIGHT_READ_TOOL_ANNOTATIONS = Object.freeze({
  statewright_get_state: Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  statewright_get_usage: Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  statewright_list_workflows: Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function annotateStatewrightReadTool(tool) {
  if (!isObject(tool) || !Object.hasOwn(STATEWRIGHT_READ_TOOL_ANNOTATIONS, tool.name)) return tool;
  const hints = STATEWRIGHT_READ_TOOL_ANNOTATIONS[tool.name];
  const annotations = tool.annotations === undefined ? {} : tool.annotations;
  if (!isObject(annotations)) return tool;
  // An explicit contradiction or invalid hint must never become a read-only claim.
  if (Object.entries(hints).some(([key, value]) => Object.hasOwn(annotations, key) && annotations[key] !== value)) {
    return tool;
  }
  if (Object.keys(hints).every((key) => Object.hasOwn(annotations, key))) return tool;
  return { ...tool, annotations: { ...hints, ...annotations } };
}

export function annotateToolsListResponse(requestBody, responseBody, contentType) {
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") return responseBody;
  try {
    const request = JSON.parse(requestBody.toString());
    const response = JSON.parse(responseBody.toString());
    if (request?.method !== "tools/list" || response?.error || !Array.isArray(response?.result?.tools)
      || request.id === undefined || response.id !== request.id) return responseBody;
    const tools = response.result.tools.map(annotateStatewrightReadTool);
    if (tools.every((tool, index) => tool === response.result.tools[index])) return responseBody;
    return Buffer.from(JSON.stringify({ ...response, result: { ...response.result, tools } }));
  } catch {
    return responseBody;
  }
}
