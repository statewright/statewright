import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const codexRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function startBridge() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    requests.push({ method: request.method, url: request.url, body });
    assert.equal(request.headers.authorization, "Bearer bridge-token");
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.url === "/hooks/state") {
      response.end(JSON.stringify({
        state: "reading",
        isFinal: false,
        instructions: "Inspect one file.",
        transitions: [{ event: "DONE" }],
        deliveryRequired: true,
        executor: { active: true, delivery: true },
      }));
    } else if (request.url === "/hooks/pre-tool") {
      response.end(JSON.stringify({ decision: "allow", additional_context: "Read is allowed." }));
    } else if (request.url === "/hooks/post-tool") {
      response.end(JSON.stringify({ completed: false, additional_context: "Tool accounted." }));
    } else if (request.url === "/hooks/stop") {
      response.end(JSON.stringify({ decision: "block", reason: "Workflow is still active." }));
    } else if (request.url === "/mcp") {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const { port } = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function invoke(command, args, input, environment) {
  return await new Promise((resolveChild) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolveChild({ status, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

const loadedState = {
  state_snapshot: {
    state: "intake",
    allowed_tools: ["Read"],
    transitions: [{ event: "EVIDENCE_READY", target: "design" }],
    run_id: "native-hook-test-run",
    capture_output: true,
  },
};

test("native Codex hook unwraps structured MCP workflow-load results", async () => {
  const responses = [
    JSON.stringify(loadedState),
    [{ type: "text", text: JSON.stringify(loadedState) }],
    { content: [{ type: "text", text: JSON.stringify(loadedState) }] },
    { result: { content: [{ type: "text", text: JSON.stringify(loadedState) }] } },
  ];

  for (const [index, tool_response] of responses.entries()) {
    const home = await mkdtemp(resolve(tmpdir(), "statewright-native-hook-"));
    const environment = {
      HOME: home,
      STATEWRIGHT_TELEMETRY_DIR: resolve(home, "telemetry"),
      STATEWRIGHT_TELEMETRY_SUPERVISE_ONLY: "false",
    };
    const session_id = `native-structured-response-${index}`;

    try {
      const post = await invoke("bash", [resolve(codexRoot, "hook.sh"), "post-tool"], {
        session_id,
        tool_name: "mcp__statewright__statewright_load_workflow",
        tool_response,
      }, environment);
      assert.equal(post.status, 0, post.stderr);
      const context = JSON.parse(post.stdout).hookSpecificOutput.additionalContext;
      assert.match(context, /Workflow loaded\. Phase: intake/);
      assert.doesNotMatch(context, /did not return an authoritative state snapshot/);

      const pre = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
        session_id,
        tool_name: "Read",
        tool_input: { file_path: "README.md" },
      }, environment);
      assert.equal(pre.status, 0, pre.stderr);
      assert.equal(pre.stdout, "");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("native Codex hook leaves malformed workflow-load results inactive", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-native-hook-"));
  const environment = {
    HOME: home,
    STATEWRIGHT_TELEMETRY_DIR: resolve(home, "telemetry"),
    STATEWRIGHT_TELEMETRY_SUPERVISE_ONLY: "false",
  };
  try {
    const post = await invoke("bash", [resolve(codexRoot, "hook.sh"), "post-tool"], {
      session_id: "native-malformed-response",
      tool_name: "mcp__statewright__statewright_load_workflow",
      tool_response: { content: [{ type: "text", text: "not workflow JSON" }] },
    }, environment);
    assert.equal(post.status, 0, post.stderr);
    assert.match(
      JSON.parse(post.stdout).hookSpecificOutput.additionalContext,
      /did not return an authoritative state snapshot/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex hooks and MCP join the executor-owned bridge", async () => {
  const bridge = await startBridge();
  const environment = {
    STATEWRIGHT_ADAPTER_URL: bridge.url,
    STATEWRIGHT_ADAPTER_TOKEN: "bridge-token",
    STATEWRIGHT_API_KEY: "must-not-be-used",
  };
  try {
    const user = await invoke("bash", [resolve(codexRoot, "hook.sh"), "user-prompt"], {
      session_id: "codex-session",
    }, environment);
    assert.equal(user.status, 0, user.stderr);
    assert.match(JSON.parse(user.stdout).hookSpecificOutput.additionalContext, /Phase: reading/);

    const pre = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      tool_name: "Read",
      tool_input: { file_path: "README.md" },
    }, environment);
    assert.equal(pre.status, 0, pre.stderr);
    assert.equal(JSON.parse(pre.stdout).hookSpecificOutput.additionalContext, "Read is allowed.");

    const statewrightPre = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      tool_name: "mcp__statewright__statewright_transition",
      tool_input: { event: "DONE" },
    }, environment);
    assert.equal(statewrightPre.status, 0, statewrightPre.stderr);
    assert.equal(statewrightPre.stdout, "");

    const post = await invoke("bash", [resolve(codexRoot, "hook.sh"), "post-tool"], {
      tool_name: "Read",
      tool_input: { file_path: "README.md" },
      tool_response: "contents",
    }, environment);
    assert.equal(post.status, 0, post.stderr);
    assert.equal(JSON.parse(post.stdout).hookSpecificOutput.additionalContext, "Tool accounted.");

    const stop = await invoke("bash", [resolve(codexRoot, "hook.sh"), "stop"], {}, environment);
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).decision, "block");

    const mcp = await invoke("bash", [resolve(codexRoot, "mcp-proxy.sh")], {
      jsonrpc: "2.0",
      id: 17,
      method: "tools/list",
      params: {},
    }, environment);
    assert.equal(mcp.status, 0, mcp.stderr);
    assert.equal(JSON.parse(mcp.stdout).id, 17);

    assert.deepEqual(bridge.requests.map((item) => item.url), [
      "/hooks/state",
      "/hooks/pre-tool",
      "/hooks/post-tool",
      "/hooks/stop",
      "/mcp",
    ]);
    assert.deepEqual(bridge.requests[1].body, {
      tool_name: "Read",
      tool_input: { file_path: "README.md" },
    });
    assert.equal(bridge.requests[2].body.tool_response, "contents");
  } finally {
    await bridge.close();
  }
});

test("executor bridge failure blocks instead of opening a standalone session", async () => {
  const result = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
    tool_name: "Read",
  }, {
    STATEWRIGHT_ADAPTER_URL: "http://127.0.0.1:1",
    STATEWRIGHT_ADAPTER_TOKEN: "bridge-token",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("executor bridge failure preserves the bounded server error detail", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "upstream adapter dispatch failed" }));
  });
  await new Promise((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const { port } = server.address();
  try {
    const result = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      tool_name: "Read",
    }, {
      STATEWRIGHT_ADAPTER_URL: `http://127.0.0.1:${port}`,
      STATEWRIGHT_ADAPTER_TOKEN: "bridge-token",
    });
    assert.equal(result.status, 0, result.stderr);
    const reason = JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /HTTP 502: upstream adapter dispatch failed/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});
