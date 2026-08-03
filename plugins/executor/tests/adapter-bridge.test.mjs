import assert from "node:assert/strict";
import test from "node:test";
import { AdapterBridge } from "../lib/adapter-bridge.mjs";

test("bridge authenticates adapters and preserves one executor identity", async () => {
  const calls = [];
  const client = {
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
        return { decision: "allow", additional_context: "checkpoint" };
      }
      if (name === "statewright_adapter_post_tool") {
        return { previous_state: "implementing", state: "testing", completed: false };
      }
      return { decision: "block", reason: "workflow is not final" };
    },
  };
  const bridge = await new AdapterBridge(client, {
    executorId: "executor-1",
    deliveryActive: true,
    token: "test-token",
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
  } finally {
    await bridge.close();
  }
});
