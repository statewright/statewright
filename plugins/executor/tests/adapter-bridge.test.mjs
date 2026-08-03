import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AdapterBridge } from "../lib/adapter-bridge.mjs";

const executorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function invokeProxy(line, environment) {
  return await new Promise((resolveChild) => {
    const child = spawn("bash", [resolve(executorRoot, "mcp-proxy.sh")], {
      env: { ...process.env, STATEWRIGHT_API_KEY: "", ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolveChild({ status, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(line)}\n`);
  });
}

test("bridge authenticates adapters and preserves one executor identity", async () => {
  const calls = [];
  const telemetry = [];
  const client = {
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === "tools/list") {
        return { tools: [{ name: "statewright_transition" }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    },
    async call(name, args = {}) {
      calls.push({ name, args });
      if (name === "statewright_get_state") {
        return {
          state: "implementing",
          iteration: 2,
          allowed_tools: ["Read", "Edit"],
          model: "openai/gpt-5.6-terra",
          thinking_level: "medium",
          meta: { workspace: { required: true } },
        };
      }
      if (name === "statewright_adapter_pre_tool") {
        return {
          decision: "allow",
          policy_tool_name: "Read",
          state: "implementing",
          additional_context: "checkpoint",
        };
      }
      if (name === "statewright_adapter_post_tool") {
        return {
          policy_tool_name: "Read",
          previous_state: "implementing",
          state: "testing",
          completed: false,
        };
      }
      return { decision: "block", reason: "workflow is not final" };
    },
  };
  const bridge = await new AdapterBridge(client, {
    executorId: "executor-1",
    deliveryActive: true,
    token: "test-token",
    host: "pi",
    telemetry: async (event, fields) => telemetry.push({ event, fields }),
  }).start();

  try {
    assert.equal((await fetch(`${bridge.url}/hooks/state`)).status, 401);
    const headers = { Authorization: "Bearer test-token" };
    const state = await (await fetch(`${bridge.url}/hooks/state`, { headers })).json();
    assert.deepEqual(state.executor, {
      active: true,
      id: "executor-1",
      delivery: true,
    });
    assert.equal(state.deliveryRequired, true);
    assert.equal(state.model, "openai/gpt-5.6-terra");

    const pre = await (await fetch(`${bridge.url}/hooks/pre-tool`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ tool_name: "Read", tool_input: { path: "README.md" } }),
    })).json();
    assert.equal(pre.additionalContext, "checkpoint");

    const post = await (await fetch(`${bridge.url}/hooks/post-tool`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ tool_name: "Read", tool_response: "text" }),
    })).json();
    assert.equal(post.transition, "implementing => testing");
    assert.deepEqual(calls.at(-1), {
      name: "statewright_adapter_post_tool",
      args: {
        tool_name: "Read",
        tool_input: {},
        tool_response: "text",
        is_error: false,
      },
    });
    assert.deepEqual(telemetry, [
      {
        event: "executor_adapter_pre_tool",
        fields: {
          host: "pi",
          tool_name: "Read",
          policy_tool_name: "Read",
          decision: "allow",
          state: "implementing",
        },
      },
      {
        event: "executor_adapter_post_tool",
        fields: {
          host: "pi",
          tool_name: "Read",
          policy_tool_name: "Read",
          state: "testing",
          previous_state: "implementing",
          transition: "implementing => testing",
          completed: false,
          is_error: false,
        },
      },
    ]);

    const mcp = await (await fetch(`${bridge.url}/mcp`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/list",
        params: {},
      }),
    })).json();
    assert.equal(mcp.id, 7);
    assert.equal(mcp.result.tools[0].name, "statewright_transition");
    assert.deepEqual(calls.at(-1), { method: "tools/list", params: {} });

    const proxied = await invokeProxy({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/list",
      params: {},
    }, {
      STATEWRIGHT_ADAPTER_URL: bridge.url,
      STATEWRIGHT_ADAPTER_TOKEN: "test-token",
    });
    assert.equal(proxied.status, 0, proxied.stderr);
    assert.equal(JSON.parse(proxied.stdout).result.tools[0].name, "statewright_transition");
  } finally {
    await bridge.close();
  }
});
