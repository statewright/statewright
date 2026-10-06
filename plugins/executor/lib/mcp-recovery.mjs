import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Recovery is a local control surface, not permission to retry an upstream call.
export const RECOVERY_TOOLS = [
  { name: "statewright_search_docs", description: "Search Statewright documentation. Available without login.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "statewright_list_workflows", description: "Report Statewright connectivity and available workflows.", inputSchema: { type: "object", properties: {} } },
  { name: "statewright_connect", description: "Explicitly start secure browser approval for this configured Statewright profile. Does not retry a failed action or repair a retired managed server; restart that owner normally after connection.", inputSchema: { type: "object", properties: {} } },
].map(tool => ({ ...tool, securitySchemes: [{ type: "noauth" }] }));

export function recoveryCatalog(request, failure) {
  return { jsonrpc: "2.0", id: request.id ?? null, result: {
    tools: RECOVERY_TOOLS,
    _meta: { statewright: { recovery: failure, retryAllowed: false } },
  } };
}

export function mcpFailure(request, kind, status = 0, catalog = true) {
  const auth = kind === "authentication_required";
  const messages = {
    authentication_required: "Statewright login is required. Use statewright_connect for this profile, then explicitly retry the intended action. No action was replayed.",
    permission_denied: "Statewright denied access. Login does not grant missing permissions; no action was replayed.",
    managed_binding_unavailable: "Statewright managed server binding is unavailable or rejected. Reconnect the owning server through its normal lifecycle. No call was forwarded to a different session.",
    transport_unavailable: "Statewright gateway transport failed. Check this profile's endpoint/connectivity; this is not proof that login is required.",
    http_error: `Statewright gateway returned HTTP ${status}. Check the configured endpoint/service; this is not a login rejection.`,
    protocol_error: "Statewright gateway returned an invalid MCP response.",
  };
  const error = { code: auth ? -32001 : kind === "permission_denied" ? -32004 : -32003,
    message: messages[kind], data: { kind, httpStatus: status, retryAllowed: false,
      ...(auth ? { recoveryTool: "statewright_connect" } : {}) } };
  if (catalog && request.method === "tools/list") return recoveryCatalog(request, error);
  return { jsonrpc: "2.0", id: request.id ?? null, error };
}

export function normalizeMcpHttpResponse(request, status, body, { managed = false, catalog = true } = {}) {
  if (!(status >= 200 && status < 300)) {
    const kind = managed ? "managed_binding_unavailable"
      : status === 401 ? "authentication_required"
      : status === 403 ? "permission_denied"
      : status === 0 ? "transport_unavailable" : "http_error";
    return mcpFailure(request, kind, status, catalog);
  }
  let response;
  try { response = JSON.parse(body); } catch { return mcpFailure(request, "protocol_error", status, catalog); }
  if (response?.jsonrpc !== "2.0" || response.id !== request.id
      || (!Object.hasOwn(response, "result") && !Object.hasOwn(response, "error"))) {
    return mcpFailure(request, "protocol_error", status, catalog);
  }
  // Typed gateway/bridge errors are preserved. Do not infer authentication from
  // arbitrary error text, a policy denial, or a successful tool's private data.
  if (response.error?.code === -32001 && response.error.data?.kind === "authentication_required") {
    const upstreamStatus = response.error.data.httpStatus === 401 ? 401 : status;
    return mcpFailure(request, "authentication_required", upstreamStatus, catalog);
  }
  if (catalog && request.method === "tools/list" && response.error) return recoveryCatalog(request, response.error);
  if (catalog && request.method === "tools/list") {
    if (!Array.isArray(response.result?.tools)) return mcpFailure(request, "protocol_error", status, catalog);
    response.result.tools = [...response.result.tools.filter(t => !["statewright_connect", "statewright_search_docs"].includes(t.name)),
      ...RECOVERY_TOOLS.filter(t => t.name !== "statewright_list_workflows")];
  }
  return response;
}

// Shell transport contract: one JSON-RPC request line, then curl's body and
// final HTTP status line. Neither credentials nor private responses enter argv.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const first = input.indexOf("\n");
  const last = input.lastIndexOf("\n");
  const request = JSON.parse(input.slice(0, first));
  const status = Number(input.slice(last + 1));
  process.stdout.write(JSON.stringify(normalizeMcpHttpResponse(request, status, input.slice(first + 1, last), {
    managed: process.argv.includes("--managed"),
  })) + "\n");
}
