import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
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
      if (body.params?.name === "statewright_transition") {
        const transition = { transitioned: true, from: "baseline", to: "implement", transition_count: 2,
          usage: { transitions: 2, limit: 2500, remaining: 2498 } };
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text", text: JSON.stringify(transition) }] } }));
      } else {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }));
      }
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

async function startNativeGateway() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push({ authorization: request.headers.authorization, body });
    const toolName = body.params?.arguments?.tool_name;
    let decision;
    if (body.params?.name === "statewright_get_state") {
      decision = {
        state: "intake",
        allowed_tools: ["Read", "Bash"],
        disallowed_tools: ["Write"],
        transitions: [],
        context: { tool_policy_mode: "denylist_heuristic_v1" },
      };
    } else if (toolName === "opaque_mutation_tool") {
      decision = { decision: "allow", additional_context: "System One approved the bounded operation." };
    } else if (toolName === "Read") {
      decision = { decision: "deny", reason: "Gateway denied this read fixture." };
    } else if (toolName === "classifier_denied") {
      decision = {
        decision: "deny",
        reason: "Classifier denied this fixture.",
        risk_assessment: {
          deterministic_risk: "Moderate",
          deterministic_exposure: "Local",
          deterministic_source: "shell_ast",
          semantic_status: "Assessed",
          semantic_vector: {
            read_only: 0.04,
            may_write: 0.96,
            reversible: 0.92,
            destructive: 0.01,
            irreversible: 0.01,
            external_or_account_effect: 0.01,
          },
          resolution_basis: "deterministic_local_write",
          final_denial_basis: "classifier_policy_low_local",
          required_authority: "moderate_local_or_assessed_moderate_local",
          equivalent_retry_allowed: false,
          command: "private-command-sentinel",
        },
      };
    } else if (toolName === "stale_fixture") {
      decision = { decision: "allow", active: false };
    } else {
      decision = { unexpected: true };
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: { content: [{ type: "text", text: JSON.stringify(decision) }] },
    }));
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

test("native Codex hook leaves disconnected onboarding to the device-connect tool", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-native-hook-"));
  const statewrightDirectory = resolve(home, ".statewright");
  await mkdir(statewrightDirectory, {recursive: true});
  await writeFile(resolve(statewrightDirectory, ".update_checked"), "");
  const environment = {
    HOME: home,
    STATEWRIGHT_API_KEY: "",
    STATEWRIGHT_TELEMETRY_DIR: resolve(home, "telemetry"),
    STATEWRIGHT_TELEMETRY_SUPERVISE_ONLY: "false",
  };

  try {
    const result = await invoke("bash", [resolve(codexRoot, "hook.sh"), "user-prompt"], {
      session_id: "native-device-connect",
      prompt: "sw_live_fixture_must_not_be_saved",
    }, environment);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /No workflow running/);
    assert.doesNotMatch(result.stdout, /needs an API key|paste it here/i);
    assert.equal(output.decision, undefined);
    await assert.rejects(readFile(resolve(statewrightDirectory, "api_key"), "utf8"));
  } finally {
    await rm(home, {recursive: true, force: true});
  }
});

test("native Codex hook unwraps structured MCP workflow-load results", async () => {
  const responses = [
    JSON.stringify(loadedState),
    [{ type: "text", text: JSON.stringify(loadedState) }],
    { content: [{ type: "text", text: JSON.stringify(loadedState) }] },
    { result: { content: [{ type: "text", text: JSON.stringify(loadedState) }] } },
    { structuredContent: loadedState, content: [{ type: "text", text: "Statewright supervisor: loaded" }] },
    { result: { structuredContent: loadedState, content: [{ type: "text", text: "Statewright supervisor: loaded" }] } },
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

test("native Codex hook delegates denylist policy to the authoritative gateway", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-native-hook-"));
  const gateway = await startNativeGateway();
  const environment = {
    HOME: home,
    STATEWRIGHT_API_KEY: "fixture-key",
    STATEWRIGHT_GATEWAY_URL: gateway.url,
    STATEWRIGHT_TELEMETRY_DIR: resolve(home, "telemetry"),
    STATEWRIGHT_TELEMETRY_SUPERVISE_ONLY: "false",
  };
  const session_id = "native-gateway-delegation";
  const state = {state_snapshot: {...loadedState.state_snapshot,
    allowed_tools: ["Read", "Bash"],
    disallowed_tools: ["Write"],
    context: {...loadedState.state_snapshot.context, tool_policy_mode: "denylist_heuristic_v1"}}};

  try {
    const post = await invoke("bash", [resolve(codexRoot, "hook.sh"), "post-tool"], {
      session_id,
      tool_name: "mcp__statewright__statewright_load_workflow",
      tool_response: state,
    }, environment);
    assert.equal(post.status, 0, post.stderr);
    assert.match(
      JSON.parse(post.stdout).hookSpecificOutput.additionalContext,
      /Tools: unrestricted except explicit blocks: Write/,
      post.stdout,
    );

    const allowed = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id,
      tool_name: "opaque_mutation_tool",
      tool_input: {operation: "bounded-fixture"},
    }, environment);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(gateway.requests.length, 1, allowed.stdout);
    assert.equal(
      JSON.parse(allowed.stdout).hookSpecificOutput.additionalContext,
      "System One approved the bounded operation.",
      allowed.stdout,
    );
    assert.equal(gateway.requests[0].authorization, "Bearer fixture-key");
    assert.equal(gateway.requests[0].body.params.name, "statewright_adapter_pre_tool");
    assert.deepEqual(gateway.requests[0].body.params.arguments, {
      tool_name: "opaque_mutation_tool",
      tool_input: {operation: "bounded-fixture"},
    });

    const denied = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id,
      tool_name: "Read",
      tool_input: {file_path: "README.md"},
    }, environment);
    assert.equal(denied.status, 0, denied.stderr);
    assert.equal(
      JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason,
      "Gateway denied this read fixture.",
    );

    const classifierDenied = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id,
      tool_name: "classifier_denied",
      tool_input: {command: "private-input-sentinel"},
    }, environment);
    assert.equal(classifierDenied.status, 0, classifierDenied.stderr);
    const classifierReason = JSON.parse(classifierDenied.stdout).hookSpecificOutput.permissionDecisionReason;
    assert.match(classifierReason, /basis=classifier_policy_low_local/);
    assert.match(classifierReason, /deterministic=Moderate\/Local via shell_ast/);
    assert.match(classifierReason, /System One=Assessed p\(read=0\.04, write=0\.96/);
    assert.match(classifierReason, /required=moderate_local_or_assessed_moderate_local/);
    assert.match(classifierReason, /equivalent retry=false/);
    assert.doesNotMatch(classifierReason, /private-(command|input)-sentinel/);

    const stale = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id,
      tool_name: "stale_fixture",
      tool_input: {},
    }, environment);
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(
      JSON.parse(stale.stdout).hookSpecificOutput.permissionDecisionReason,
      /no active workflow/,
    );

    const malformed = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id,
      tool_name: "unknown_fixture",
      tool_input: {},
    }, environment);
    assert.equal(malformed.status, 0, malformed.stderr);
    assert.equal(
      JSON.parse(malformed.stdout).hookSpecificOutput.permissionDecisionReason,
      "Blocked by Statewright gateway policy.",
    );

    const unavailable = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id,
      tool_name: "Read",
      tool_input: {},
    }, {...environment, STATEWRIGHT_GATEWAY_URL: "http://127.0.0.1:1"});
    assert.equal(unavailable.status, 0, unavailable.stderr);
    assert.match(
      JSON.parse(unavailable.stdout).hookSpecificOutput.permissionDecisionReason,
      /decision unavailable; denylist policy fails closed/,
    );

    const [sessionDirectory] = await readdir(resolve(home, ".statewright", "sessions"));
    await unlink(resolve(home, ".statewright", "sessions", sessionDirectory, ".state_cache"));
    const requestCountBeforeMissingCache = gateway.requests.length;
    const missingCache = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id,
      tool_name: "Read",
      tool_input: {},
    }, environment);
    assert.equal(missingCache.status, 0, missingCache.stderr);
    assert.match(
      JSON.parse(missingCache.stdout).hookSpecificOutput.permissionDecisionReason,
      /state cache is unavailable; the active workflow fails closed/,
    );
    assert.equal(gateway.requests.length, requestCountBeforeMissingCache);

    const reload = await invoke("bash", [resolve(codexRoot, "hook.sh"), "post-tool"], {
      session_id,
      tool_name: "mcp__statewright__statewright_load_workflow",
      tool_response: state,
    }, environment);
    assert.equal(reload.status, 0, reload.stderr);
    await writeFile(resolve(home, ".statewright", ".update_checked"), "");

    const unreachablePrompt = await invoke("bash", [resolve(codexRoot, "hook.sh"), "user-prompt"], {
      session_id,
    }, {...environment, STATEWRIGHT_GATEWAY_URL: "http://127.0.0.1:1"});
    assert.equal(unreachablePrompt.status, 0, unreachablePrompt.stderr);
    assert.match(
      JSON.parse(unreachablePrompt.stdout).hookSpecificOutput.additionalContext,
      /active workflow remains fail-closed/,
    );
    const requestCountBeforeUnavailableState = gateway.requests.length;
    const unavailableState = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id,
      tool_name: "Read",
      tool_input: {},
    }, environment);
    assert.equal(unavailableState.status, 0, unavailableState.stderr);
    assert.match(
      JSON.parse(unavailableState.stdout).hookSpecificOutput.permissionDecisionReason,
      /gateway state is unavailable; the active workflow fails closed/,
    );
    assert.equal(gateway.requests.length, requestCountBeforeUnavailableState);

    const recoveredPrompt = await invoke("bash", [resolve(codexRoot, "hook.sh"), "user-prompt"], {
      session_id,
    }, environment);
    assert.equal(recoveredPrompt.status, 0, recoveredPrompt.stderr);
    assert.match(
      JSON.parse(recoveredPrompt.stdout).hookSpecificOutput.additionalContext,
      /Phase: intake/,
    );
  } finally {
    await gateway.close();
    await rm(home, {recursive: true, force: true});
  }
});

test("native gateway calls stream request JSON instead of placing it in argv", async () => {
  const hookSource = await readFile(resolve(codexRoot, "hook.sh"), "utf8");
  assert.match(hookSource, /printf '%s' "\$1" \| curl[\s\S]*--data-binary @-/);
  assert.doesNotMatch(hookSource, /(?:-d|--data) "\$1"/);
});

test("legacy hook honors exact MCP authorization without namespace collisions", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-mcp-policy-"));
  const environment = {
    HOME: home,
    STATEWRIGHT_TELEMETRY_DIR: resolve(home, "telemetry"),
    STATEWRIGHT_TELEMETRY_SUPERVISE_ONLY: "false",
  };
  const session_id = "legacy-mcp-policy";
  try {
    const post = await invoke("bash", [resolve(codexRoot, "hook.sh"), "post-tool"], {
      session_id,
      tool_name: "mcp__statewright__statewright_load_workflow",
      tool_response: { state_snapshot: {
        state: "sync_tasks", transitions: [],
        allowed_tools: ["mcp__gtasks_work__list_task_lists", "mcp__gtasks_work__update"],
        disallowed_tools: ["mcp__gtaskswork__list_task_lists"],
      } },
    }, environment);
    assert.equal(post.status, 0, post.stderr);
    for (const [tool_name, allowed] of [
      ["mcp__gtasks_work__list_task_lists", true],
      ["mcp__gtasks_work__update", true],
      ["mcp__gtasks_personal__update", false],
      ["mcp__gtasks_work__delete", false],
      ["mcp__gtaskswork__update", false],
      ["mcp__gtasks_work__UPDATE", false],
    ]) {
      const pre = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
        session_id, tool_name, tool_input: { title: "private fixture" },
      }, environment);
      assert.equal(pre.status, 0, pre.stderr);
      if (allowed) assert.equal(pre.stdout, "", tool_name);
      else assert.equal(JSON.parse(pre.stdout).hookSpecificOutput.permissionDecision, "deny", tool_name);
    }
    const deniedPost = await invoke("bash", [resolve(codexRoot, "hook.sh"), "post-tool"], {
      session_id,
      tool_name: "mcp__statewright__statewright_load_workflow",
      tool_response: { state_snapshot: { state:"sync_tasks", transitions:[],
        allowed_tools:["mcp__gtasks_work__update"], disallowed_tools:["mcp__gtasks_work__update"] } },
    }, environment);
    assert.equal(deniedPost.status, 0, deniedPost.stderr);
    const blocked = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id, tool_name:"mcp__gtasks_work__update", tool_input:{},
    }, environment);
    assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, "deny");
  } finally {
    await rm(home, {recursive: true, force: true});
  }
});

test("legacy state without an allowlist remains unenforced", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-native-hook-"));
  const environment = {
    HOME: home,
    STATEWRIGHT_TELEMETRY_DIR: resolve(home, "telemetry"),
    STATEWRIGHT_TELEMETRY_SUPERVISE_ONLY: "false",
  };
  const session_id = "legacy-empty-policy";
  try {
    const post = await invoke("bash", [resolve(codexRoot, "hook.sh"), "post-tool"], {
      session_id,
      tool_name: "mcp__statewright__statewright_load_workflow",
      tool_response: { state_snapshot: { state: "legacy", transitions: [] } },
    }, environment);
    assert.equal(post.status, 0, post.stderr);
    const pre = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id,
      tool_name: "apply_patch",
      tool_input: {},
    }, environment);
    assert.equal(pre.status, 0, pre.stderr);
    assert.equal(pre.stdout, "");
  } finally {
    await rm(home, {recursive: true, force: true});
  }
});

test("Codex hooks and MCP join the executor-owned bridge", async () => {
  const bridge = await startBridge();
  const environment = {
    STATEWRIGHT_ADAPTER_URL: bridge.url,
    STATEWRIGHT_ADAPTER_TOKEN: "bridge-token",
    STATEWRIGHT_MANAGED_MCP_URL: "",
    STATEWRIGHT_MANAGED_MCP_TOKEN: "",
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

    const transition = await invoke("bash", [resolve(codexRoot, "mcp-proxy.sh")], {
      jsonrpc: "2.0",
      id: 18,
      method: "tools/call",
      params: { name: "statewright_transition", arguments: { event: "READY", data: { rationale: "test" } } },
    }, environment);
    assert.equal(transition.status, 0, transition.stderr);
    const transitionResponse = JSON.parse(transition.stdout);
    assert.equal(transitionResponse.result.content[0].text,
      "Statewright supervisor: baseline → implement · transitioned · 2/2500 transitions · 2498 remaining");
    assert.equal(transitionResponse.result.structuredContent.transitioned, true);

    assert.deepEqual(bridge.requests.map((item) => item.url), [
      "/hooks/state",
      "/hooks/pre-tool",
      "/hooks/post-tool",
      "/hooks/stop",
      "/mcp",
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
