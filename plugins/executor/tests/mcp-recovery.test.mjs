import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { normalizeMcpHttpResponse } from "../lib/mcp-recovery.mjs";
import { ManagedMcpBridge } from "../lib/managed-mcp-bridge.mjs";

const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "statewright_transition", arguments: { event: "DONE" } } };
for (const [status, kind] of [[401, "authentication_required"], [403, "permission_denied"], [404, "http_error"], [503, "http_error"], [0, "transport_unavailable"]]) {
  test(`MCP HTTP ${status} remains classified and does not disclose or replay`, () => {
    const result = normalizeMcpHttpResponse(call, status, 'Bearer private-secret');
    assert.equal(result.error.data.kind, kind);
    assert.equal(result.error.data.retryAllowed, false);
    assert.equal(result.error.data.recoveryTool, status === 401 ? "statewright_connect" : undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-secret/);
    const catalog = normalizeMcpHttpResponse(list, status, 'private-secret');
    assert.deepEqual(catalog.result.tools.map(t => t.name), ["statewright_search_docs", "statewright_list_workflows", "statewright_connect"]);
    assert.equal(catalog.result._meta.statewright.recovery.data.kind, kind);
    assert.ok(catalog.result.tools.every(t => t.securitySchemes[0].type === "noauth"));
  });
}
test("managed transport failure is owner loss, not gateway login or fallback authority", () => {
  for (const status of [0, 401, 403, 404, 502]) {
    const response = normalizeMcpHttpResponse(call, status, "", { managed: true });
    assert.equal(response.error.data.kind, "managed_binding_unavailable");
    assert.equal(response.error.data.recoveryTool, undefined);
  }
});
test("MCP reply identity, malformed JSON and explicit policy errors remain distinct", () => {
  for (const body of ["oops", JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} })]) {
    assert.equal(normalizeMcpHttpResponse(call, 200, body).error.data.kind, "protocol_error");
  }
  const denied = { jsonrpc: "2.0", id: 3, error: { code: -42, message: "policy denied" } };
  assert.deepEqual(normalizeMcpHttpResponse(call, 200, JSON.stringify(denied)), denied);
  const auth = { jsonrpc: "2.0", id: 3, error: { code: -32001, message: "login needed" } };
  // Server-reserved codes/text alone cannot relabel an arbitrary upstream denial.
  assert.deepEqual(normalizeMcpHttpResponse(call, 200, JSON.stringify(auth)), auth);
  auth.error.data = { kind: "authentication_required", httpStatus: 401 };
  assert.equal(normalizeMcpHttpResponse(call, 200, JSON.stringify(auth)).error.data.recoveryTool, "statewright_connect");
  assert.equal(normalizeMcpHttpResponse(call, 200, JSON.stringify(auth), { managed: true }).error.data.httpStatus, 401);
});

async function fixture(t, handler) {
  const root = await mkdtemp(join(tmpdir(), "statewright-mcp-recovery-"));
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, ".statewright"), { recursive: true });
  await writeFile(join(root, ".statewright", "config.json"), JSON.stringify({ routing: { managed_clients: { enabled: false } }, telemetry: { codex: { native_tokens: false } } }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(STATEWRIGHT_|CODEX_)/i.test(key)));
  Object.assign(env, { HOME: root, STATEWRIGHT_GATEWAY_URL: base, STATEWRIGHT_PB_URL: base,
    STATEWRIGHT_API_KEY: "fixture-key", STATEWRIGHT_NO_BROWSER: "true", STATEWRIGHT_NO_UPDATE_CHECK: "1",
    STATEWRIGHT_SENTRY_DISABLED: "true", STATEWRIGHT_DESKTOP_PLATFORM: "Linux" });
  return { env, base };
}
async function proxy(env, requests) {
  const child = spawn("bash", [resolve("plugins/codex/mcp-proxy.sh")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", d => output += d); child.stderr.on("data", d => errors += d);
  const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
  child.stdin.end(requests.map(JSON.stringify).join("\n") + "\n");
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  clearTimeout(timer);
  assert.equal(code, 0, errors);
  return output.trim().split("\n").map(JSON.parse);
}
test("actual Codex proxy uses exact canonical endpoint and keeps explicit connect discoverable", async t => {
  const paths = [];
  const { env } = await fixture(t, async (req, res) => {
    paths.push(req.url); let body = ""; for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    res.writeHead(req.url === "/mcp" ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "protected_tool", inputSchema: { type: "object" } }] } }));
  });
  const [response] = await proxy(env, [list]);
  assert.deepEqual(paths, ["/mcp"]);
  assert.ok(response.result.tools.some(t => t.name === "protected_tool"));
  assert.ok(response.result.tools.some(t => t.name === "statewright_connect"));
});
test("actual proxy keeps 401 discovery alive, never retries writes, and starts login only explicitly", async t => {
  const paths = [];
  const { env } = await fixture(t, async (req, res) => {
    paths.push(req.url); for await (const _ of req) {}
    res.writeHead(req.url === "/mcp" ? 401 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_api_key" }));
  });
  const [response, catalog, connected] = await proxy(env, [call, list, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "statewright_connect", arguments: {} } }]);
  assert.equal(response.error.data.kind, "authentication_required");
  assert.ok(catalog.result.tools.some(t => t.name === "statewright_connect"));
  assert.equal(connected.error.code, -32002); // fixture refuses device grant; no real OAuth
  assert.deepEqual(paths, ["/mcp", "/api/oauth/device/code"]);
});
for (const mode of ["MANAGED_MCP", "ADAPTER"]) test(`dead ${mode} owner initializes and exposes recovery without remote replay`, async t => {
  let count = 0;
  const { env } = await fixture(t, (_req, res) => { count++; res.writeHead(500).end(); });
  const dead = createServer(); await new Promise(r => dead.listen(0, "127.0.0.1", r));
  const port = dead.address().port; await new Promise(r => dead.close(r));
  Object.assign(env, { [`STATEWRIGHT_${mode}_URL`]: `http://127.0.0.1:${port}`, [`STATEWRIGHT_${mode}_TOKEN`]: "old-owner", STATEWRIGHT_CLIENT_ID: "old-client" });
  const [initialized, catalog, failure] = await proxy(env, [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, list, call]);
  assert.equal(initialized.result.serverInfo.name, "statewright");
  assert.ok(catalog.result.tools.some(t => t.name === "statewright_connect"));
  assert.equal(failure.error.data.kind, "managed_binding_unavailable");
  assert.equal(count, 0);
});

for (const status of [403, 404, 503]) test(`actual proxy preserves HTTP ${status} without starting login`, async t => {
  const paths = [];
  const { env } = await fixture(t, async (req, res) => {
    paths.push(req.url); for await (const _ of req) {}
    res.writeHead(status, { "Content-Type": "application/json" }).end('{"private":"not for diagnostics"}');
  });
  const [catalog, failure] = await proxy(env, [list, call]);
  assert.equal(failure.error.data.httpStatus, status);
  assert.equal(failure.error.data.kind, status === 403 ? "permission_denied" : "http_error");
  assert.equal(failure.error.data.recoveryTool, undefined);
  assert.equal(catalog.result.tools.some(tool => tool.name === "statewright_transition"), false);
  assert.doesNotMatch(JSON.stringify([catalog, failure]), /not for diagnostics/);
  assert.deepEqual(paths, ["/mcp", "/mcp"]);
});

test("actual proxy and managed bridge distinguish upstream login from foreign bridge access", async t => {
  let forwarded = 0;
  const { env, base } = await fixture(t, async (req, res) => {
    forwarded++; for await (const _ of req) {}
    res.writeHead(401).end('{"error":"invalid_api_key"}');
  });
  const bridge = await new ManagedMcpBridge({ gatewayUrl: base, apiKey: "fixture", clientId: "owner", token: "owner-token" }).start();
  t.after(() => bridge.close());
  Object.assign(env, { STATEWRIGHT_MANAGED_MCP_URL: bridge.url, STATEWRIGHT_MANAGED_MCP_TOKEN: "owner-token", STATEWRIGHT_CLIENT_ID: "owner" });
  const [auth] = await proxy(env, [call]);
  assert.equal(auth.error.data.kind, "authentication_required");
  assert.equal(auth.error.data.httpStatus, 401);
  env.STATEWRIGHT_CLIENT_ID = "foreign";
  const [foreign] = await proxy(env, [call]);
  assert.equal(foreign.error.data.kind, "managed_binding_unavailable");
  assert.equal(forwarded, 1);
});
