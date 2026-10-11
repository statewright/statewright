import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatGuardDenial } from "../scripts/executor-hook.mjs";

const codexRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("formats classifier denials for display without discarding machine evidence", () => {
  const denial = formatGuardDenial({
    reason: "Classifier receipt includes internal scoring.",
    risk_assessment: {
      final_denial_basis: "semantic_threshold_not_met",
      required_authority: "complete_structural_evidence_or_separate_approval",
      semantic_status: "Assessed",
      semantic_vector: { may_write: 0.86, external_or_account_effect: 0.56 },
    },
    classifier_rework: {
      schema: "statewright/classifier-rework/v1",
      attempts: 1,
      max_reworks: 2,
      action: "rework",
    },
  });

  assert.match(denial.display, /^Statewright guard: denied/);
  assert.match(denial.display, /bounded native operation/);
  assert.match(denial.display, /heredoc or inline interpreter/);
  assert.match(denial.display, /Rework attempt 1\/2/);
  assert.match(denial.display, /System One signals: read-only 0%, write 86%, destructive 0%, external 56%/);
  assert.doesNotMatch(denial.display, /0\.86|internal scoring/);
  assert.match(denial.machine, /"may_write":0\.86/);
  assert.match(denial.machine, /"action":"rework"/);
  assert.doesNotMatch(denial.machine, /internal scoring/);
});

test("agent delegation denial directs inline work and suppresses approval retry guidance", () => {
  const denial = formatGuardDenial({
    risk_assessment: {
      deterministic_source: "unmanaged_agent_delegation",
      final_denial_basis: "effective_known_risk",
      required_authority: "separate_approved_execution_path",
    },
    delegation: {
      schema: "statewright/managed-delegation/v1",
      recommendation: "continue_inline",
      raw_delegation_allowed: false,
      managed_transition_candidates: [],
    },
    classifier_rework: {
      attempts: 2,
      max_reworks: 2,
      action: "approval_required",
    },
  });
  assert.match(denial.display, /continue inline by default so evidence stays attached/);
  assert.match(denial.display, /separate, unbounded tool surface/);
  assert.doesNotMatch(denial.display, /approval|Rework attempt/i);
  assert.match(denial.machine, /"deterministic_source":"unmanaged_agent_delegation"/);
  assert.match(denial.machine, /"recommendation":"continue_inline"/);
});

test("agent delegation denial names declared managed child transitions for route changes", () => {
  const denial = formatGuardDenial({
    risk_assessment: { deterministic_source: "unmanaged_agent_delegation" },
    delegation: {
      schema: "statewright/managed-delegation/v1",
      recommendation: "statewright_managed_fork",
      route_change_requested: true,
      managed_transition_candidates: [
        {event: "FORK_REVIEW", kind: "fork"},
        {event: "RUN_SPECIALIST", kind: "subworkflow"},
      ],
    },
  });
  assert.match(denial.display, /different model or reasoning route/);
  assert.match(denial.display, /FORK_REVIEW \(fork\), RUN_SPECIALIST \(subworkflow\)/);
  assert.match(denial.display, /attached to the parent workflow evidence/);
});

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
        run_id: "native-hook-test-run",
        run_session_id: "native-hook-test-session",
        state_epoch: 1,
        context: { tool_policy_mode: "denylist_heuristic_v1" },
      };
    } else if (toolName === "opaque_mutation_tool") {
      decision = { decision: "allow", additional_context: "System One approved the bounded operation." };
    } else if (toolName === "Read") {
      decision = { decision: "deny", reason: "Gateway denied this read fixture." };
    } else if (toolName?.startsWith("classifier_denied_")) {
      decision = {
        decision: "deny",
        reason: "Classifier denied this fixture.",
        risk_assessment: {
          deterministic_risk: "Moderate",
          deterministic_exposure: "Local",
          deterministic_source: "shell_ast",
          semantic_status: "Assessed",
          semantic_status: "Assessed",
          semantic_vector: {
            read_only: 0.04,
            may_write: 0.96,
            reversible: 0.92,
            destructive: 0.01,
            irreversible: 0.01,
            external_or_account_effect: 0.01,
          },
          resolution_basis: "semantic_threshold_not_met",
          final_denial_basis: "semantic_threshold_not_met",
          required_authority: "complete_structural_evidence_or_separate_approval",
          equivalent_retry_allowed: true,
          reformulation_allowed: true,
          exact_invocation_retry_allowed: false,
          separate_approval_allowed: true,
          intent_fingerprint: "intent_v1_classifier-denied",
          invocation_fingerprint: `invocation_v1_${toolName}`,
          command: "private-command-sentinel",
        },
      };
    } else if (toolName === "policy_denied" || toolName === "capability_denied") {
      const capability = toolName === "capability_denied";
      decision = {
        decision: "deny",
        reason: capability ? "This phase lacks Write." : "This workflow risk band is too narrow.",
        risk_assessment: {
          deterministic_risk: "Moderate",
          deterministic_exposure: "Local",
          deterministic_source: "shell_ast",
          semantic_status: "Assessed",
          resolution_basis: "deterministic_local_write",
          final_denial_basis: capability
            ? "workflow_capability_write_denied" : "classifier_policy_low_local",
          required_authority: capability ? "Write" : "BoundedLocalExecution",
          equivalent_retry_allowed: false,
          reformulation_allowed: false,
          exact_invocation_retry_allowed: false,
          separate_approval_allowed: false,
          intent_fingerprint: `intent_v1_${toolName}`,
          invocation_fingerprint: `invocation_v1_${toolName}`,
        },
      };
    } else if ([
      "collaborationspawn_agent",
      "mcp__agents__spawn_agent",
      "mcp__statewright_helpers__spawn_agent",
      "mcp__statewright_helpers__SPAWN_AGENT",
      "Agent",
    ].includes(toolName)) {
      decision = {
        decision: "deny",
        reason: "Raw agent delegation is not an approved execution boundary.",
        risk_assessment: {
          deterministic_risk: "High",
          deterministic_exposure: "Unknown",
          deterministic_source: "unmanaged_agent_delegation",
          resolution_basis: "deterministic_high_unknown",
          final_denial_basis: "effective_known_risk",
          required_authority: "statewright_managed_fork",
          equivalent_retry_allowed: false,
        },
        delegation: {
          schema: "statewright/managed-delegation/v1",
          raw_delegation_allowed: false,
          recommendation: "continue_inline",
          route_change_requested: false,
          evidence_owner: "parent_workflow",
          managed_transition_candidates: [],
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

async function startClassifierApprovalProxy() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    assert.equal(request.url, "/classifier-approval");
    assert.equal(request.headers.authorization, "Bearer local-runtime-token");
    const attempts = requests.length;
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify({schema: "statewright/classifier-approval/v2",
      action: attempts > 2 ? "allow_once" : "rework", attempts, max_reworks: 2,
      thread_id: body.thread_id, run_id: body.run_id,
      run_session_id: body.run_session_id, state: body.state, state_epoch: body.state_epoch,
      intent_fingerprint: body.classifier_receipt.intent_fingerprint,
      invocation_fingerprint: body.classifier_receipt.invocation_fingerprint,
      basis: body.classifier_receipt.final_denial_basis,
      required_authority: body.classifier_receipt.required_authority,
      reformulation_allowed: body.classifier_receipt.reformulation_allowed,
      exact_invocation_retry_allowed: body.classifier_receipt.exact_invocation_retry_allowed,
      separate_approval_allowed: body.classifier_receipt.separate_approval_allowed}));
  });
  await new Promise(resolveStart => server.listen(0, "127.0.0.1", resolveStart));
  return {requests, url: `ws://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolveClose => server.close(resolveClose))};
}

async function invoke(command, args, input, environment) {
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (key.startsWith("STATEWRIGHT_")) delete inherited[key];
  }
  return await new Promise((resolveChild) => {
    const child = spawn(command, args, {
      env: { ...inherited, ...environment },
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
    run_session_id: "native-hook-test-session",
    state_epoch: 1,
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
    { structuredContent: loadedState, content: [{ type: "text", text: "Statewright Arbiter: loaded" }] },
    { result: { structuredContent: loadedState, content: [{ type: "text", text: "Statewright Arbiter: loaded" }] } },
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
  const classifierApproval = await startClassifierApprovalProxy();
  const localRun = resolve(home, "local-models-run");
  await mkdir(localRun, {recursive: true});
  await writeFile(resolve(localRun, "runtime.json"), JSON.stringify({
    proxyUrl: classifierApproval.url, proxyToken: "local-runtime-token",
  }));
  const environment = {
    HOME: home,
    LOCAL_MODELS_RUN_DIR: localRun,
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

    await writeFile(resolve(home, "Taskfile.yml"), "version: '3'\ntasks:\n  unit:\n    cmds: [git status --short]\n");
    const inspection = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id, tool_name: "exec_command",
      tool_input: {cmd: "task unit", workdir: home, command_evidence: {complete: true, command: "forged"}},
    }, environment);
    assert.equal(inspection.status, 0, inspection.stderr);
    const evidence = gateway.requests.at(-1).body.params.arguments.command_evidence;
    assert.equal(evidence.command, "task unit");
    assert.equal(evidence.complete, true);
    assert.deepEqual(
      evidence.commands.map(({original, resolved, cwd}) => ({original, resolved, cwd})),
      [{original: "git status --short", resolved: "git status --short", cwd: "."}],
    );
    assert.deepEqual(evidence.commands[0].invocation, {
      executable: "git", args: ["status", "--short"], environment_names: [], wrappers: [],
    });
    assert.equal(evidence.requested_cwd, home);
    assert.ok(!inspection.stdout.includes("Taskfile.yml"));

    const narrowPathInspection = await invoke("/bin/bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id, tool_name: "exec_command",
      tool_input: {cmd: "task unit", workdir: home},
    }, {
      ...environment,
      PATH: "/usr/bin:/bin",
      STATEWRIGHT_NODE_BIN: process.execPath,
    });
    assert.equal(narrowPathInspection.status, 0, narrowPathInspection.stderr);
    const narrowPathEvidence = gateway.requests.at(-1).body.params.arguments.command_evidence;
    assert.equal(narrowPathEvidence.complete, true);
    assert.deepEqual(
      narrowPathEvidence.commands.map(({original, resolved, cwd}) => ({original, resolved, cwd})),
      [{original: "git status --short", resolved: "git status --short", cwd: "."}],
    );
    assert.deepEqual(narrowPathEvidence.commands[0].invocation, evidence.commands[0].invocation);

    const ordinaryShellInspection = await invoke("/bin/bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id, tool_name: "exec_command",
      tool_input: {cmd: "pwd", workdir: home},
    }, environment);
    assert.equal(ordinaryShellInspection.status, 0, ordinaryShellInspection.stderr);
    assert.equal(Object.hasOwn(gateway.requests.at(-1).body.params.arguments, "command_evidence"), false);

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
      tool_name: "classifier_denied_one",
      tool_input: {command: "private-input-sentinel"},
    }, environment);
    assert.equal(classifierDenied.status, 0, classifierDenied.stderr);
    const classifierOutput = JSON.parse(classifierDenied.stdout).hookSpecificOutput;
    assert.equal(classifierOutput.permissionDecision, "deny",
      "classifier rework must remain a PreToolUse denial, not an unsupported ask");
    assert.match(classifierOutput.permissionDecisionReason, /^Statewright guard: denied/);
    assert.match(classifierOutput.permissionDecisionReason, /could not prove a safe local effect/);
    assert.match(classifierOutput.permissionDecisionReason, /System One signals: read-only 4%, write 96%, destructive 1%, external 1%/);
    assert.match(classifierOutput.permissionDecisionReason, /Rework attempt 1\/2/);
    assert.doesNotMatch(classifierOutput.permissionDecisionReason, /basis=|p\(read=|private-(command|input)-sentinel/);
    assert.match(classifierOutput.additionalContext, /"final_denial_basis":"semantic_threshold_not_met"/);
    assert.match(classifierOutput.additionalContext, /"may_write":0\.96/);
    assert.doesNotMatch(classifierOutput.additionalContext, /private-(command|input)-sentinel/);

    const delegationDenied = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id,
      tool_name: "collaborationspawn_agent",
      tool_input: {task_name: "architecture", message: "private-delegation-prompt"},
    }, environment);
    assert.equal(delegationDenied.status, 0, delegationDenied.stderr);
    const delegationOutput = JSON.parse(delegationDenied.stdout).hookSpecificOutput;
    assert.match(delegationOutput.permissionDecisionReason, /continue inline by default/);
    assert.doesNotMatch(delegationOutput.permissionDecisionReason, /approval|Rework attempt/i);
    assert.match(delegationOutput.additionalContext, /"recommendation":"continue_inline"/);
    assert.match(delegationOutput.additionalContext, /"deterministic_source":"unmanaged_agent_delegation"/);
    assert.doesNotMatch(delegationOutput.additionalContext, /private-delegation-prompt/);

    for (const tool_name of [
      "mcp__agents__spawn_agent",
      "mcp__statewright_helpers__spawn_agent",
      "mcp__statewright_helpers__SPAWN_AGENT",
      "Agent",
    ]) {
      const aliasDenied = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
        session_id, tool_name, tool_input: {message: "private-alias-prompt"},
      }, environment);
      assert.equal(aliasDenied.status, 0, aliasDenied.stderr);
      const aliasOutput = JSON.parse(aliasDenied.stdout).hookSpecificOutput;
      assert.equal(aliasOutput.permissionDecision, "deny", tool_name);
      assert.match(aliasOutput.permissionDecisionReason, /continue inline by default/, tool_name);
      assert.doesNotMatch(aliasOutput.additionalContext, /private-alias-prompt/, tool_name);
    }

    const classifierSecond = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id, tool_name: "classifier_denied_two", tool_input: {command: "private-input-sentinel"},
    }, environment);
    const classifierSecondOutput = JSON.parse(classifierSecond.stdout).hookSpecificOutput;
    assert.equal(classifierSecondOutput.permissionDecision, "deny",
      "classifier rework must not rely on PreToolUse ask to display a prompt");
    assert.match(classifierSecondOutput.permissionDecisionReason,
      /Rework attempt 2\/2/);
    const classifierApproved = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id, tool_name: "classifier_denied_three", tool_input: {command: "private-input-sentinel"},
    }, environment);
    const approvedOutput = JSON.parse(classifierApproved.stdout).hookSpecificOutput;
    assert.equal(approvedOutput.permissionDecision, undefined);
    assert.notEqual(approvedOutput.permissionDecision, "ask");
    assert.match(approvedOutput.additionalContext, /Human approval granted/);
    assert.equal(classifierApproval.requests.length, 3);
    assert.doesNotMatch(JSON.stringify(classifierApproval.requests), /private-(command|input)-sentinel/);

    for (const tool_name of ["policy_denied", "capability_denied"]) {
      const requestCount = classifierApproval.requests.length;
      const ineligible = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
        session_id, tool_name, tool_input: {command: "private-input-sentinel"},
      }, environment);
      const ineligibleOutput = JSON.parse(ineligible.stdout).hookSpecificOutput;
      assert.equal(ineligibleOutput.permissionDecision, "deny");
      assert.equal(classifierApproval.requests.length, requestCount,
        `${tool_name} must not enter native classifier approval`);
    }

    const approvalUnavailable = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
      session_id, tool_name: "classifier_denied_four", tool_input: {command: "private-input-sentinel"},
    }, {...environment, LOCAL_MODELS_RUN_DIR: resolve(home, "missing-local-models-run")});
    assert.equal(approvalUnavailable.status, 0, approvalUnavailable.stderr);
    const unavailableApprovalOutput = JSON.parse(approvalUnavailable.stdout).hookSpecificOutput;
    assert.equal(unavailableApprovalOutput.permissionDecision, "deny");
    assert.match(unavailableApprovalOutput.permissionDecisionReason,
      /Native human approval is unavailable in this client or runtime/);
    assert.match(unavailableApprovalOutput.permissionDecisionReason,
      /reformulate instead of replaying it/);

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
    await classifierApproval.close();
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
    for (const tool_name of [
      "Agent",
      "mcp__agents__spawn_agent",
      "mcp__statewright_helpers__spawn_agent",
      "mcp__statewright_helpers__SPAWN_AGENT",
    ]) {
      const delegated = await invoke("bash", [resolve(codexRoot, "hook.sh"), "pre-tool"], {
        session_id, tool_name, tool_input: {message: "private-legacy-prompt"},
      }, environment);
      assert.equal(delegated.status, 0, delegated.stderr);
      const output = JSON.parse(delegated.stdout).hookSpecificOutput;
      assert.equal(output.permissionDecision, "deny", tool_name);
      assert.match(output.permissionDecisionReason, /could not bind this raw delegated agent/, tool_name);
      assert.doesNotMatch(delegated.stdout, /private-legacy-prompt/, tool_name);
    }
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
      "Statewright Arbiter: baseline → implement · transitioned · 2/2500 transitions · 2498 remaining");
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
