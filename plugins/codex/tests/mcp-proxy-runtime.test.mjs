import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

async function fixture(t, { pinned = process.execPath, pathNode = false, bundled = null } = {}) {
  const home = await mkdtemp(join(tmpdir(), "statewright-mcp-path-"));
  const bin = join(home, "bin");
  await mkdir(bin);
  for (const name of ["dirname", "curl", "jq"]) {
    const executable = execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    await symlink(executable, join(bin, name));
  }
  if (pathNode) await symlink(process.execPath, join(bin, "node"));
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const part of request) raw += part;
    const rpc = JSON.parse(raw);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id,
      result: rpc.method === "tools/list" ? { tools: [{ name: "statewright_get_state", inputSchema: { type: "object" } }] } : {} }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const child = spawn("/bin/bash", [resolve("plugins/codex/mcp-proxy.sh")], {
    env: { PATH: bin, HOME: home, STATEWRIGHT_MANAGED_CLIENT_HOST: "codex",
      STATEWRIGHT_NODE_BIN: pinned, STATEWRIGHT_DESKTOP_BUNDLED_NODE: bundled ?? join(home, "no-bundled-node"),
      STATEWRIGHT_MANAGED_MCP_URL: `http://127.0.0.1:${server.address().port}`,
      STATEWRIGHT_MANAGED_MCP_TOKEN: "fixture", STATEWRIGHT_CLIENT_ID: "swc_fixture" },
  });
  let output = "", stderr = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { stderr += data; });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => { child.kill(); await closed; server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  child.stdin.end([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  await closed;
  return { responses: output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)), stderr };
}

test("managed MCP discovery uses pinned Node when Desktop PATH has no node", async t => {
  const result = await fixture(t);
  const response = result.responses.find(value => value.id === 2);
  assert.ok(response?.result?.tools.some(tool => tool.name === "statewright_get_state"), result.stderr);
});

test("managed MCP discovery retains terminal PATH Node when no executable is pinned", async t => {
  const result = await fixture(t, { pinned: "", pathNode: true });
  assert.ok(result.responses.find(value => value.id === 2)?.result?.tools.length);
});

test("managed MCP discovery uses the bundled fallback when no Node is pinned or on PATH", async t => {
  const result = await fixture(t, { pinned: "", bundled: process.execPath });
  assert.ok(result.responses.find(value => value.id === 2)?.result?.tools.length);
});

test("unavailable pinned Node returns an immediate correlated MCP error, not an empty reply", async t => {
  const result = await fixture(t, { pinned: "/missing-statewright-node", pathNode: true });
  const response = result.responses.find(value => value.id === 2);
  assert.ok(response?.error);
  assert.match(response.error.message, /Node|runtime|helper/);
});

test("missing Node without a pinned or bundled runtime returns a correlated MCP error", async t => {
  const result = await fixture(t, { pinned: "" });
  assert.ok(result.responses.find(value => value.id === 2)?.error);
});
