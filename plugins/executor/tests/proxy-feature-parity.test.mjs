import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";

const clients = [
  { name: "codex", proxy: resolve("plugins/codex/mcp-proxy.sh"), local: ["statewright_search_docs", "statewright_search_references"] },
  { name: "claude", proxy: resolve("plugins/claude-code/mcp-proxy.sh"), local: ["statewright_search_docs"] },
];

async function startUpstream() {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: [{ name: "statewright_get_state", inputSchema: { type: "object" } }] },
    }));
  });
  await new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", resolveStart);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function invokeProxy(proxy, message, environment) {
  return await new Promise((resolveResult, rejectResult) => {
    const child = spawn("bash", [proxy], {
      env: {
        ...process.env,
        STATEWRIGHT_API_KEY: "test-key",
        STATEWRIGHT_CLIENT_ID: "swc_0123456789abcdef0123456789abcdef",
        STATEWRIGHT_MANAGED_MCP_URL: "",
        STATEWRIGHT_MANAGED_MCP_TOKEN: "",
        STATEWRIGHT_ADAPTER_URL: "",
        STATEWRIGHT_ADAPTER_TOKEN: "",
        ...environment,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectResult);
    child.once("close", (status) => {
      if (status !== 0) return rejectResult(new Error(stderr || `proxy exited ${status}`));
      const response = JSON.parse(stdout.trim().split("\n").at(-1));
      resolveResult(response);
    });
    child.stdin.end(`${JSON.stringify(message)}\n`);
  });
}

async function listTools(proxy, environment) {
  const response = await invokeProxy(proxy, {
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
    id: 1,
  }, environment);
  return response.result.tools.map((tool) => tool.name);
}

for (const client of clients) {
  for (const transport of ["direct", "managed", "adapter"]) {
    test(`${client.name} exposes local tools through ${transport} transport`, async () => {
      const upstream = await startUpstream();
      try {
        const environment = transport === "direct"
          ? { STATEWRIGHT_GATEWAY_URL: upstream.url }
          : transport === "managed"
            ? { STATEWRIGHT_MANAGED_CLIENT_HOST: client.name, STATEWRIGHT_MANAGED_MCP_URL: upstream.url, STATEWRIGHT_MANAGED_MCP_TOKEN: "bridge-token" }
            : { STATEWRIGHT_ADAPTER_URL: upstream.url, STATEWRIGHT_ADAPTER_TOKEN: "bridge-token" };
        const names = await listTools(client.proxy, environment);
        assert.ok(names.includes("statewright_get_state"));
        for (const local of client.local) assert.ok(names.includes(local), `${local} missing from ${client.name}/${transport}`);
      } finally {
        await upstream.close();
      }
    });
  }

  test(`${client.name} recovers when its managed bridge is gone`, async () => {
    const upstream = await startUpstream();
    try {
      const names = await listTools(client.proxy, {
        STATEWRIGHT_GATEWAY_URL: upstream.url,
        STATEWRIGHT_MANAGED_CLIENT_HOST: client.name,
        STATEWRIGHT_MANAGED_MCP_URL: "http://127.0.0.1:1",
        STATEWRIGHT_MANAGED_MCP_TOKEN: "stale-token",
      });
      assert.ok(names.includes("statewright_get_state"));
      for (const local of client.local) assert.ok(names.includes(local));
    } finally {
      await upstream.close();
    }
  });
}

test("Codex reference search executes locally through managed transport", async () => {
  const upstream = await startUpstream();
  try {
    const response = await invokeProxy(clients[0].proxy, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "statewright_search_references",
        arguments: { query: "statewright_search_references", limit: 2 },
      },
      id: 7,
    }, {
      STATEWRIGHT_MANAGED_CLIENT_HOST: "codex",
      STATEWRIGHT_MANAGED_MCP_URL: upstream.url,
      STATEWRIGHT_MANAGED_MCP_TOKEN: "bridge-token",
    });
    assert.equal(response.id, 7);
    assert.match(response.result.content[0].text, /statewright_search_references|rank:/);
  } finally {
    await upstream.close();
  }
});
