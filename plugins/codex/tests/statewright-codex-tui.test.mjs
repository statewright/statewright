import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliModel, codexArgs, parseArgs, run } from "../scripts/statewright-codex-tui.mjs";

const codexRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function invokeHook(input, environment, endpoint = "post-tool") {
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (key.startsWith("STATEWRIGHT_")) delete inherited[key];
  }
  return await new Promise((resolveResult) => {
    const child = spawn("bash", [resolve(codexRoot, "hook.sh"), endpoint], {
      env: { ...inherited, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (status) => resolveResult({ status, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

test("interactive supervisor carries model, effort, and resume session across a route boundary", () => {
  assert.equal(cliModel("openai-codex/gpt-5.6-sol"), "gpt-5.6-sol");
  assert.deepEqual(
    codexArgs({ model: "openai-codex/gpt-5.6-sol", effort: "high", resumeSession: "session-1", prompt: "continue" }),
    ["-m", "gpt-5.6-sol", "-c", "model_reasoning_effort=\"high\"", "resume", "session-1", "continue"],
  );
});

test("interactive supervisor requires a workflow and initial prompt", () => {
  assert.throws(() => parseArgs(["--workflow", "repair"]));
  assert.equal(parseArgs(["--workflow", "repair", "--", "fix it"]).workflow, "repair");
});

test("workflow load emits an atomic route restart request only for a supervised TUI", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-tui-hook-"));
  const controlDir = await mkdtemp(resolve(tmpdir(), "statewright-tui-route-"));
  try {
    const registration = await invokeHook({ session_id: "session-1", prompt: "start" }, { HOME: home, STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir }, "user-prompt");
    assert.equal(registration.status, 0, registration.stderr);
    const result = await invokeHook({
      session_id: "session-1",
      turn_id: "turn-1",
      tool_name: "mcp__statewright__statewright_load_workflow",
      tool_response: JSON.stringify({ state_snapshot: {
        workflow: "routing-test",
        state: "baseline",
        model: "openai-codex/gpt-5.6-sol",
        thinking_level: "high",
        model_ladder: [
          { model: "local_compatible/local-code-model", thinking_level: "low", health_url: "https://model.example.invalid/health" },
          { model: "openai-codex/gpt-5.6-sol", thinking_level: "high" },
        ],
        run_id: "run-1",
        allowed_tools: ["Read"],
        transitions: [],
      } }),
    }, { HOME: home, STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir });
    assert.equal(result.status, 0, result.stderr);
    const entries = (await readdir(controlDir)).filter((entry) => entry.endsWith(".route.json"));
    assert.equal(entries.length, 1);
    const route = JSON.parse(await readFile(resolve(controlDir, entries[0]), "utf8"));
    assert.deepEqual(route, {
      session_id: "session-1",
      turn_id: "turn-1",
      root_session_id: "session-1",
      client_id: route.client_id,
      run_id: "run-1",
      state: "baseline",
      model: "openai-codex/gpt-5.6-sol",
      effort: "high",
      model_ladder: [
        { model: "local_compatible/local-code-model", thinking_level: "low", health_url: "https://model.example.invalid/health" },
        { model: "openai-codex/gpt-5.6-sol", thinking_level: "high" },
      ],
    });
    assert.match(route.client_id, /^swc_[0-9a-f]{32}$/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(controlDir, { recursive: true, force: true });
  }
});

test("transition refresh publishes the next managed route under a hostile inherited locale", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-tui-hook-"));
  const controlDir = await mkdtemp(resolve(tmpdir(), "statewright-tui-route-"));
  let authoritative = {
    workflow: "routing-test",
    state: "localize",
    model: "openai-codex/gpt-5.6-terra",
    thinking_level: "medium",
    env_overrides: { STATEWRIGHT_CODEX_SERVICE_TIER: "priority" },
    run_id: "run-locale",
    transition_count: 2,
    state_epoch: 2,
    allowed_tools: ["Read"],
    transitions: [{ event: "DECISION_REQUIRED", target: "decision" }],
    is_final: false,
  };
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
      content: [{ type: "text", text: JSON.stringify(authoritative) }],
    } }));
  });
  await new Promise((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const { port } = server.address();
  const environment = {
    HOME: home,
    LC_ALL: "C.UTF-8",
    LANG: "C.UTF-8",
    STATEWRIGHT_API_KEY: "test-key",
    STATEWRIGHT_GATEWAY_URL: `http://127.0.0.1:${port}`,
    STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir,
  };
  try {
    const registration = await invokeHook({ thread_id: "session-locale", prompt: "start" }, environment, "user-prompt");
    assert.equal(registration.status, 0, registration.stderr);
    const loaded = await invokeHook({
      thread_id: "session-locale",
      turn_id: "turn-load",
      tool_name: "mcp__statewright__statewright_load_workflow",
      tool_response: JSON.stringify({ state_snapshot: { ...authoritative,
        state: "intake", thinking_level: "low", transition_count: 1, state_epoch: 1,
      } }),
    }, environment);
    assert.equal(loaded.status, 0, loaded.stderr);
    const transitioned = await invokeHook({
      thread_id: "session-locale",
      turn_id: "turn-transition",
      tool_name: "mcp__statewright__statewright_transition",
      tool_response: JSON.stringify({ transitioned: true, from: "intake", to: "localize" }),
    }, environment);
    assert.equal(transitioned.status, 0, transitioned.stderr);
    const route = JSON.parse(await readFile(resolve(controlDir, "current.route.json"), "utf8"));
    assert.equal(route.run_id, "run-locale");
    assert.equal(route.state, "localize");
    assert.equal(route.model, "openai-codex/gpt-5.6-terra");
    assert.equal(route.effort, "medium");
    assert.equal(route.service_tier, "priority");
    assert.equal(route.turn_id, "turn-transition");
    authoritative = {
      ...authoritative,
      state: "complete",
      is_final: true,
      transition_count: 3,
      state_epoch: 3,
    };
    const completed = await invokeHook({
      thread_id: "session-locale",
      turn_id: "turn-complete",
      tool_name: "mcp__statewright__statewright_transition",
      tool_response: JSON.stringify({ transitioned: true, from: "localize", to: "complete" }),
    }, environment);
    assert.equal(completed.status, 0, completed.stderr);
    const restore = JSON.parse(await readFile(resolve(controlDir, "current.route.json"), "utf8"));
    assert.equal(restore.run_id, "run-locale");
    assert.equal(restore.state, "complete");
    assert.equal(restore.restore_original, true);
    assert.equal(restore.model, "");
    assert.equal(restore.effort, "");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(home, { recursive: true, force: true });
    await rm(controlDir, { recursive: true, force: true });
  }
});

test("new workflow boundaries supersede stale routes and deactivation drains the thread queue", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-tui-hook-"));
  const controlDir = await mkdtemp(resolve(tmpdir(), "statewright-tui-route-"));
  try {
    await invokeHook({ session_id: "session-1", prompt: "start" }, { HOME: home, STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir }, "user-prompt");
    const registration = JSON.parse(await readFile(resolve(controlDir, "codex-root-session.json"), "utf8"));
    await writeFile(resolve(controlDir, "legacy.route.json"), JSON.stringify({ session_id: "session-1",
      root_session_id: "session-1", client_id: registration.client_id,
      run_id: "old-run", state: "baseline", model: "openai-codex/gpt-5.6-sol", effort: "high" }));
    const loaded = await invokeHook({ session_id: "session-1", turn_id: "turn-2",
      tool_name: "mcp__statewright__statewright_load_workflow", tool_response: JSON.stringify({ state_snapshot: {
        workflow: "routing-test", state: "implement", run_id: "new-run", model: "openai-codex/gpt-5.6-terra",
        thinking_level: "medium", allowed_tools: ["Read"], transitions: [],
      } }) }, { HOME: home, STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir });
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.deepEqual((await readdir(controlDir)).filter(name => name.endsWith(".route.json")), ["current.route.json"]);
    assert.equal(JSON.parse(await readFile(resolve(controlDir, "current.route.json"), "utf8")).run_id, "new-run");
    const stopped = await invokeHook({ session_id: "session-1", tool_name: "mcp__statewright__statewright_deactivate",
      tool_response: JSON.stringify({ deactivated: true }) }, { HOME: home, STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.deepEqual((await readdir(controlDir)).filter(name => name.endsWith(".route.json")), []);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(controlDir, { recursive: true, force: true });
  }
});

test("cloud connector lifecycle calls cannot acquire or release local enforcement", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-hook-ownership-"));
  const environment = { HOME: home, STATEWRIGHT_CLIENT_ID: "ownership-test" };
  const snapshot = {
    workflow: "routing-test", state: "implement", run_id: "local-run",
    allowed_tools: ["Read"], transitions: [],
  };
  try {
    const foreignLoad = await invokeHook({ session_id: "ownership-thread",
      tool_name: "mcp__codex_apps__statewright_staging_statewright_load_workflow",
      tool_response: JSON.stringify({ state_snapshot: snapshot }) }, environment);
    assert.equal(foreignLoad.status, 0, foreignLoad.stderr);
    const noLocalState = await access(resolve(home, ".statewright", "sessions")).then(() => false, () => true);
    assert.equal(noLocalState, true);

    const localLoad = await invokeHook({ session_id: "ownership-thread",
      tool_name: "mcp__statewright__statewright_load_workflow",
      tool_response: JSON.stringify({ state_snapshot: snapshot }) }, environment);
    assert.equal(localLoad.status, 0, localLoad.stderr);
    const failedLocalStop = await invokeHook({ session_id: "ownership-thread",
      tool_name: "mcp__statewright__statewright_deactivate",
      tool_response: JSON.stringify({ deactivated: false }) }, environment);
    assert.equal(failedLocalStop.status, 0, failedLocalStop.stderr);
    const foreignStop = await invokeHook({ session_id: "ownership-thread",
      tool_name: "mcp__codex_apps__statewright_staging_statewright_deactivate",
      tool_response: JSON.stringify({ deactivated: true }) }, environment);
    assert.equal(foreignStop.status, 0, foreignStop.stderr);
    const localStop = await invokeHook({ session_id: "ownership-thread" }, environment, "stop");
    assert.equal(localStop.status, 0, localStop.stderr);
    assert.equal(JSON.parse(localStop.stdout).decision, "block");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("exact local inactive state reconciles only the current thread and admits pwd", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-hook-inactive-"));
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const method = JSON.parse(body).params.name;
      const result = method === "statewright_get_state"
        ? { isError: true, content: [{ type: "text", text: "No active workflow. Load a workflow before requesting state." }] }
        : { content: [{ type: "text", text: JSON.stringify({ active_workflow: null, current_state: null }) }] };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const { port } = server.address();
  const environment = { HOME: home, STATEWRIGHT_CLIENT_ID: "inactive-test", STATEWRIGHT_API_KEY: "test-key", STATEWRIGHT_GATEWAY_URL: `http://127.0.0.1:${port}` };
  try {
    const loaded = await invokeHook({ session_id: "inactive-thread",
      tool_name: "mcp__statewright__statewright_load_workflow",
      tool_response: JSON.stringify({ state_snapshot: {
        workflow: "routing-test", state: "implement", run_id: "inactive-run", allowed_tools: ["Bash"], transitions: [],
      } }) }, environment);
    assert.equal(loaded.status, 0, loaded.stderr);
    const reconciled = await invokeHook({ session_id: "inactive-thread", prompt: "continue" }, environment, "user-prompt");
    assert.equal(reconciled.status, 0, reconciled.stderr);
    assert.match(reconciled.stdout, /Stale local enforcement was reconciled/);
    const probe = await invokeHook({ session_id: "inactive-thread", tool_name: "Bash", tool_input: { command: "pwd" } }, environment, "pre-tool");
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout, "");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(home, { recursive: true, force: true });
  }
});

test("unconfirmed no-active reply remains fail-closed and suppresses stale Stop continuation", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-hook-unavailable-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
      isError: true, content: [{ type: "text", text: "No active workflow. Load a workflow before requesting state." }],
    } }));
  });
  await new Promise((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const { port } = server.address();
  const environment = { HOME: home, STATEWRIGHT_CLIENT_ID: "unavailable-test", STATEWRIGHT_API_KEY: "test-key", STATEWRIGHT_GATEWAY_URL: `http://127.0.0.1:${port}` };
  try {
    const loaded = await invokeHook({ session_id: "unavailable-thread",
      tool_name: "mcp__statewright__statewright_load_workflow",
      tool_response: JSON.stringify({ state_snapshot: {
        workflow: "routing-test", state: "intake", run_id: "unavailable-run", allowed_tools: ["Read"], transitions: [],
      } }) }, environment);
    assert.equal(loaded.status, 0, loaded.stderr);
    const refreshed = await invokeHook({ session_id: "unavailable-thread", prompt: "continue" }, environment, "user-prompt");
    assert.equal(refreshed.status, 0, refreshed.stderr);
    assert.match(refreshed.stdout, /fail-closed/);
    const denied = await invokeHook({ session_id: "unavailable-thread", tool_name: "Bash", tool_input: { command: "pwd" } }, environment, "pre-tool");
    assert.equal(denied.status, 0, denied.stderr);
    assert.match(denied.stdout, /gateway state is unavailable/);
    const stopped = await invokeHook({ session_id: "unavailable-thread" }, environment, "stop");
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(stopped.stdout, "");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(home, { recursive: true, force: true });
  }
});

test("Stop cache miss with a semantic error preserves fail-closed enforcement", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-hook-stop-cache-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
      isError: true, content: [{ type: "text", text: "No active workflow. Load a workflow before requesting state." }],
    } }));
  });
  await new Promise((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const { port } = server.address();
  const environment = { HOME: home, STATEWRIGHT_CLIENT_ID: "stop-cache-test", STATEWRIGHT_API_KEY: "test-key", STATEWRIGHT_GATEWAY_URL: `http://127.0.0.1:${port}` };
  try {
    const loaded = await invokeHook({ session_id: "stop-cache-thread", tool_name: "mcp__statewright__statewright_load_workflow", tool_response: JSON.stringify({ state_snapshot: { workflow: "routing-test", state: "implement", run_id: "stop-cache-run", allowed_tools: ["Read"], transitions: [] } }) }, environment);
    assert.equal(loaded.status, 0, loaded.stderr);
    const [sessionDir] = await readdir(resolve(home, ".statewright", "sessions"));
    await rm(resolve(home, ".statewright", "sessions", sessionDir, ".state_cache"));
    const stop = await invokeHook({ session_id: "stop-cache-thread" }, environment, "stop");
    assert.equal(stop.stdout, "");
    const denied = await invokeHook({ session_id: "stop-cache-thread", tool_name: "Bash", tool_input: { command: "pwd" } }, environment, "pre-tool");
    assert.match(denied.stdout, /gateway state is unavailable/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(home, { recursive: true, force: true });
  }
});

test("conflicting active run remains fail-closed without replacing local state", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-hook-conflict-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ workflow: "routing-test", state: "final", run_id: "foreign-run", is_final: true, allowed_tools: [], transitions: [] }) }] } }));
  });
  await new Promise((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const { port } = server.address();
  const environment = { HOME: home, STATEWRIGHT_CLIENT_ID: "conflict-test", STATEWRIGHT_API_KEY: "test-key", STATEWRIGHT_GATEWAY_URL: `http://127.0.0.1:${port}` };
  try {
    await invokeHook({ session_id: "conflict-thread", tool_name: "mcp__statewright__statewright_load_workflow", tool_response: JSON.stringify({ state_snapshot: { workflow: "routing-test", state: "implement", run_id: "local-run", allowed_tools: ["Read"], transitions: [] } }) }, environment);
    const prompt = await invokeHook({ session_id: "conflict-thread", prompt: "continue" }, environment, "user-prompt");
    assert.match(prompt.stdout, /fail-closed/);
    const denied = await invokeHook({ session_id: "conflict-thread", tool_name: "Bash", tool_input: { command: "pwd" } }, environment, "pre-tool");
    assert.match(denied.stdout, /gateway state is unavailable/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(home, { recursive: true, force: true });
  }
});

test("lookalike lifecycle tools, error envelopes, and foreign managed roots cannot acquire local enforcement", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-hook-root-"));
  const controlDir = await mkdtemp(resolve(tmpdir(), "statewright-hook-root-control-"));
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const method = JSON.parse(body).params.name;
      const result = method === "statewright_get_state"
        ? { isError: true, content: [{ type: "text", text: "No active workflow. Load a workflow before requesting state." }] }
        : { content: [{ type: "text", text: JSON.stringify({ active_workflow: null, current_state: null }) }] };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const { port } = server.address();
  const environment = { HOME: home, STATEWRIGHT_CLIENT_ID: "foreign-root-test", STATEWRIGHT_API_KEY: "test-key", STATEWRIGHT_GATEWAY_URL: `http://127.0.0.1:${port}`, STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir };
  const snapshot = { workflow: "routing-test", state: "implement", run_id: "root-run", allowed_tools: ["Read"], transitions: [] };
  try {
    await writeFile(resolve(controlDir, "codex-root-session.json"), JSON.stringify({ version: 1, session_id: "another-thread", client_id: "another-client" }));
    const lookalike = await invokeHook({ session_id: "root-thread", tool_name: "mcp__statewright__statewright_load_workflow_extra", tool_response: JSON.stringify({ state_snapshot: snapshot }) }, environment);
    assert.equal(lookalike.status, 0, lookalike.stderr);
    const envelopeFailure = await invokeHook({ session_id: "root-thread", tool_name: "mcp__statewright__statewright_load_workflow", tool_response: JSON.stringify({ result: { isError: true, content: [{ type: "text", text: JSON.stringify({ state_snapshot: snapshot }) }] } }) }, environment);
    assert.equal(envelopeFailure.status, 0, envelopeFailure.stderr);
    const dormantProbe = await invokeHook({ session_id: "root-thread", tool_name: "Bash", tool_input: { command: "pwd" } }, environment, "pre-tool");
    assert.equal(dormantProbe.stdout, "");

    const loaded = await invokeHook({ session_id: "root-thread", tool_name: "mcp__statewright__statewright_load_workflow", tool_response: JSON.stringify({ state_snapshot: snapshot }) }, environment);
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.match(loaded.stdout, /managed root is not owned/);
    const noLocalState = await access(resolve(home, ".statewright", "sessions")).then(() => false, () => true);
    assert.equal(noLocalState, true);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(home, { recursive: true, force: true });
    await rm(controlDir, { recursive: true, force: true });
  }
});

test("loss of a bound run identity remains fail-closed", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-hook-identity-loss-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ workflow: "routing-test", state: "implement", allowed_tools: ["Read"], transitions: [] }) }] } }));
  });
  await new Promise((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const { port } = server.address();
  const environment = { HOME: home, STATEWRIGHT_CLIENT_ID: "identity-loss-test", STATEWRIGHT_API_KEY: "test-key", STATEWRIGHT_GATEWAY_URL: `http://127.0.0.1:${port}` };
  try {
    const loaded = await invokeHook({ session_id: "identity-loss-thread", tool_name: "mcp__statewright__statewright_load_workflow", tool_response: JSON.stringify({ state_snapshot: { workflow: "routing-test", state: "implement", run_id: "bound-run", run_session_id: "bound-session", allowed_tools: ["Read"], transitions: [] } }) }, environment);
    assert.equal(loaded.status, 0, loaded.stderr);
    const prompt = await invokeHook({ session_id: "identity-loss-thread", prompt: "continue" }, environment, "user-prompt");
    assert.match(prompt.stdout, /fail-closed/);
    const denied = await invokeHook({ session_id: "identity-loss-thread", tool_name: "Bash", tool_input: { command: "pwd" } }, environment, "pre-tool");
    assert.match(denied.stdout, /gateway state is unavailable/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(home, { recursive: true, force: true });
  }
});

test("loss of a bound run session identity remains fail-closed independently", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-hook-session-loss-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ workflow: "routing-test", state: "implement", run_id: "bound-run", allowed_tools: ["Read"], transitions: [] }) }] } }));
  });
  await new Promise((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const { port } = server.address();
  const environment = { HOME: home, STATEWRIGHT_CLIENT_ID: "session-loss-test", STATEWRIGHT_API_KEY: "test-key", STATEWRIGHT_GATEWAY_URL: `http://127.0.0.1:${port}` };
  try {
    await invokeHook({ session_id: "session-loss-thread", tool_name: "mcp__statewright__statewright_load_workflow", tool_response: JSON.stringify({ state_snapshot: { workflow: "routing-test", state: "implement", run_id: "bound-run", run_session_id: "bound-session", allowed_tools: ["Read"], transitions: [] } }) }, environment);
    const prompt = await invokeHook({ session_id: "session-loss-thread", prompt: "continue" }, environment, "user-prompt");
    assert.match(prompt.stdout, /fail-closed/);
    const denied = await invokeHook({ session_id: "session-loss-thread", tool_name: "Bash", tool_input: { command: "pwd" } }, environment, "pre-tool");
    assert.match(denied.stdout, /gateway state is unavailable/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(home, { recursive: true, force: true });
  }
});

test("malformed policy snapshots cannot activate local enforcement", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-hook-policy-"));
  const environment = { HOME: home, STATEWRIGHT_CLIENT_ID: "policy-test" };
  try {
    const result = await invokeHook({ session_id: "policy-thread", tool_name: "mcp__statewright__statewright_load_workflow", tool_response: JSON.stringify({ state_snapshot: { workflow: "routing-test", state: "implement", allowed_tools: ["Read", 7], transitions: [] } }) }, environment);
    assert.match(result.stdout, /did not return an authoritative state snapshot/);
    const noLocalState = await access(resolve(home, ".statewright", "sessions")).then(() => false, () => true);
    assert.equal(noLocalState, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy cache identity constrains a refresh when sidecars are absent", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-hook-legacy-binding-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ workflow: "routing-test", state: "implement", run_id: "foreign-run", run_session_id: "bound-session", allowed_tools: ["Read"], transitions: [] }) }] } }));
  });
  await new Promise((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const { port } = server.address();
  const environment = { HOME: home, STATEWRIGHT_CLIENT_ID: "legacy-binding-test", STATEWRIGHT_API_KEY: "test-key", STATEWRIGHT_GATEWAY_URL: `http://127.0.0.1:${port}` };
  try {
    await invokeHook({ session_id: "legacy-binding-thread", tool_name: "mcp__statewright__statewright_load_workflow", tool_response: JSON.stringify({ state_snapshot: { workflow: "routing-test", state: "implement", run_id: "bound-run", run_session_id: "bound-session", allowed_tools: ["Read"], transitions: [] } }) }, environment);
    const [sessionDir] = await readdir(resolve(home, ".statewright", "sessions"));
    const sessionPath = resolve(home, ".statewright", "sessions", sessionDir);
    await writeFile(resolve(sessionPath, ".active"), JSON.stringify({ activated: "legacy" }));
    await rm(resolve(sessionPath, ".run_id"));
    await rm(resolve(sessionPath, ".run_session_id"));
    const prompt = await invokeHook({ session_id: "legacy-binding-thread", prompt: "continue" }, environment, "user-prompt");
    assert.match(prompt.stdout, /fail-closed/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(home, { recursive: true, force: true });
  }
});

test("versioned active binding constrains refresh when sidecars and cache are absent", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-hook-active-binding-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ workflow: "routing-test", state: "implement", run_id: "foreign-run", run_session_id: "bound-session", allowed_tools: ["Read"], transitions: [] }) }] } }));
  });
  await new Promise((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const { port } = server.address();
  const environment = { HOME: home, STATEWRIGHT_CLIENT_ID: "active-binding-test", STATEWRIGHT_API_KEY: "test-key", STATEWRIGHT_GATEWAY_URL: `http://127.0.0.1:${port}` };
  try {
    await invokeHook({ session_id: "active-binding-thread", tool_name: "mcp__statewright__statewright_load_workflow", tool_response: JSON.stringify({ state_snapshot: { workflow: "routing-test", state: "implement", run_id: "bound-run", run_session_id: "bound-session", allowed_tools: ["Read"], transitions: [] } }) }, environment);
    const [sessionDir] = await readdir(resolve(home, ".statewright", "sessions"));
    const sessionPath = resolve(home, ".statewright", "sessions", sessionDir);
    await rm(resolve(sessionPath, ".run_id"));
    await rm(resolve(sessionPath, ".run_session_id"));
    await rm(resolve(sessionPath, ".state_cache"));
    const prompt = await invokeHook({ session_id: "active-binding-thread", prompt: "continue" }, environment, "user-prompt");
    assert.match(prompt.stdout, /fail-closed/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(home, { recursive: true, force: true });
  }
});

test("real HTTP gateway failures preserve enforcement and deny ordinary tools", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-hook-http-failure-"));
  const server = createServer((_request, response) => response.writeHead(500).end("gateway failed"));
  await new Promise((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const { port } = server.address();
  const environment = { HOME: home, STATEWRIGHT_CLIENT_ID: "http-failure-test", STATEWRIGHT_API_KEY: "test-key", STATEWRIGHT_GATEWAY_URL: `http://127.0.0.1:${port}` };
  try {
    await invokeHook({ session_id: "http-failure-thread", tool_name: "mcp__statewright__statewright_load_workflow", tool_response: JSON.stringify({ state_snapshot: { workflow: "routing-test", state: "implement", run_id: "http-run", allowed_tools: ["Read"], transitions: [] } }) }, environment);
    const prompt = await invokeHook({ session_id: "http-failure-thread", prompt: "continue" }, environment, "user-prompt");
    assert.match(prompt.stdout, /fail-closed/);
    const denied = await invokeHook({ session_id: "http-failure-thread", tool_name: "Bash", tool_input: { command: "pwd" } }, environment, "pre-tool");
    assert.match(denied.stdout, /gateway state is unavailable/);
    const stop = await invokeHook({ session_id: "http-failure-thread" }, environment, "stop");
    assert.equal(stop.stdout, "");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(home, { recursive: true, force: true });
  }
});

test("corroborated inactive cleanup preserves a sibling thread's evidence", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-hook-sibling-"));
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const method = JSON.parse(body).params.name;
      const result = method === "statewright_get_state"
        ? { isError: true, content: [{ type: "text", text: "No active workflow. Load a workflow before requesting state." }] }
        : { content: [{ type: "text", text: JSON.stringify({ active_workflow: null, current_state: null }) }] };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const { port } = server.address();
  const gateway = { STATEWRIGHT_API_KEY: "test-key", STATEWRIGHT_GATEWAY_URL: `http://127.0.0.1:${port}` };
  const current = { HOME: home, STATEWRIGHT_CLIENT_ID: "current-sibling-test", ...gateway };
  const sibling = { HOME: home, STATEWRIGHT_CLIENT_ID: "other-sibling-test", ...gateway };
  try {
    await invokeHook({ session_id: "current-thread", tool_name: "mcp__statewright__statewright_load_workflow", tool_response: JSON.stringify({ state_snapshot: { workflow: "routing-test", state: "implement", run_id: "current-run", allowed_tools: ["Bash"], transitions: [] } }) }, current);
    await invokeHook({ session_id: "sibling-thread", tool_name: "mcp__statewright__statewright_load_workflow", tool_response: JSON.stringify({ state_snapshot: { workflow: "routing-test", state: "implement", run_id: "sibling-run", allowed_tools: ["Read"], transitions: [] } }) }, sibling);
    const sessionRoot = resolve(home, ".statewright", "sessions");
    const entries = await readdir(sessionRoot);
    const siblingDir = (await Promise.all(entries.map(async (entry) => ({ entry, active: await readFile(resolve(sessionRoot, entry, ".active"), "utf8") })))).find(({ active }) => active.includes("sibling-run"));
    const siblingActive = await readFile(resolve(sessionRoot, siblingDir.entry, ".active"), "utf8");
    const siblingCache = await readFile(resolve(sessionRoot, siblingDir.entry, ".state_cache"), "utf8");
    const reconciled = await invokeHook({ session_id: "current-thread", prompt: "continue" }, current, "user-prompt");
    assert.match(reconciled.stdout, /Stale local enforcement was reconciled/);
    assert.equal(await readFile(resolve(sessionRoot, siblingDir.entry, ".active"), "utf8"), siblingActive);
    assert.equal(await readFile(resolve(sessionRoot, siblingDir.entry, ".state_cache"), "utf8"), siblingCache);
    const currentProbe = await invokeHook({ session_id: "current-thread", tool_name: "Bash", tool_input: { command: "pwd" } }, current, "pre-tool");
    assert.equal(currentProbe.stdout, "");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(home, { recursive: true, force: true });
  }
});

test("workflow load beneath codex exec does not request a parent TUI restart", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-tui-hook-"));
  const controlDir = await mkdtemp(resolve(tmpdir(), "statewright-tui-route-"));
  const fakeCodex = resolve(home, "codex");
  try {
    await writeFile(resolve(controlDir, "codex-root-session.json"), JSON.stringify({
      version: 1,
      session_id: "ephemeral-review-thread",
      client_id: "swc_0123456789abcdef0123456789abcdef",
    }));
    await writeFile(resolve(controlDir, "identity.json"), JSON.stringify({
      version: 1,
      host: "codex",
      client_id: "swc_0123456789abcdef0123456789abcdef",
    }));
    await writeFile(fakeCodex, `#!/usr/bin/env bash\nbash ${JSON.stringify(resolve(codexRoot, "hook.sh"))} post-tool\n`);
    await chmod(fakeCodex, 0o755);
    const result = await new Promise((resolveResult) => {
      const child = spawn(fakeCodex, ["exec", "--ephemeral", "review this diff"], {
        env: { ...process.env, HOME: home, STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("exit", (status) => resolveResult({ status, stdout, stderr }));
      child.stdin.end(`${JSON.stringify({
        session_id: "ephemeral-review-thread",
        tool_name: "mcp__statewright__statewright_load_workflow",
        tool_response: JSON.stringify({ state_snapshot: {
          workflow: "routing-test", state: "review", run_id: "run-review",
          model: "openai-codex/gpt-5.6-sol", thinking_level: "high",
          allowed_tools: ["Read"], transitions: [],
        } }),
      })}\n`);
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(controlDir)).filter((entry) => entry.endsWith(".route.json")), []);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(controlDir, { recursive: true, force: true });
  }
});

test("standalone Stop caps nudges per epoch and permits a duplicate Stop", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-tui-hook-"));
  const environment = { HOME: home, STATEWRIGHT_CLIENT_ID: "stop-nudge-test" };
  try {
    const loaded = await invokeHook({
      session_id: "session-stop",
      tool_name: "mcp__statewright__statewright_load_workflow",
      tool_response: JSON.stringify({ state_snapshot: {
        workflow: "routing-test", state: "implement", run_id: "run-stop",
        allowed_tools: ["Read"], transitions: [{ event: "DONE", target: "completed" }],
      } }),
    }, environment);
    assert.equal(loaded.status, 0, loaded.stderr);

    const firstStop = await invokeHook({ session_id: "session-stop" }, environment, "stop");
    assert.equal(firstStop.status, 0, firstStop.stderr);
    assert.equal(JSON.parse(firstStop.stdout).decision, "block");

    for (let index = 0; index < 2; index += 1) {
      const progress = await invokeHook({ session_id: "session-stop", tool_name: "Read", tool_response: "ok" }, environment);
      assert.equal(progress.status, 0, progress.stderr);
      const nextStop = await invokeHook({ session_id: "session-stop" }, environment, "stop");
      assert.equal(nextStop.status, 0, nextStop.stderr);
      assert.equal(JSON.parse(nextStop.stdout).decision, "block");
    }

    const cappedProgress = await invokeHook({ session_id: "session-stop", tool_name: "Read", tool_response: "ok" }, environment);
    assert.equal(cappedProgress.status, 0, cappedProgress.stderr);
    const cappedStop = await invokeHook({ session_id: "session-stop" }, environment, "stop");
    assert.equal(cappedStop.status, 0, cappedStop.stderr);
    assert.equal(cappedStop.stdout, "");

    const duplicateStop = await invokeHook({ session_id: "session-stop" }, environment, "stop");
    assert.equal(duplicateStop.status, 0, duplicateStop.stderr);
    assert.equal(duplicateStop.stdout, "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("interactive supervisor restarts the child with the next state route", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "statewright-tui-supervisor-"));
  const fakeCodex = resolve(root, "fake-codex.mjs");
  const calls = resolve(root, "calls.log");
  const home = resolve(root, "home");
  try {
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");
const marker = join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "emitted");
if (!existsSync(marker)) {
  writeFileSync(marker, "");
  spawnSync("bash", [${JSON.stringify(resolve(codexRoot, "hook.sh"))}, "user-prompt"], { env: process.env, input: JSON.stringify({ session_id: "session-1", prompt: "start" }) });
  const registration = JSON.parse(readFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "codex-root-session.json"), "utf8"));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  writeFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "route.json"), JSON.stringify({ session_id: "session-1", root_session_id: "session-1", client_id: registration.client_id, model: "openai-codex/gpt-5.6-sol", effort: "high" }));
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
}
`);
    await chmod(fakeCodex, 0o755);
    assert.equal(await run({
      workflow: "routing-test",
      prompt: ["do work"],
      codexBin: fakeCodex,
      fallbackModel: "gpt-5.6-terra",
      fallbackEffort: "low",
      environment: { ...process.env, HOME: home },
    }), 0);
    const invocations = (await readFile(calls, "utf8")).trim().split("\n");
    assert.equal(invocations.length, 2);
    assert.match(invocations[0], /-m gpt-5\.6-terra -c model_reasoning_effort="low"/);
    assert.match(invocations[1], /-m gpt-5\.6-sol -c model_reasoning_effort="high" resume session-1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive supervisor preserves a routed primary receipt while an attached peer remains isolated", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "statewright-tui-route-canary-"));
  const primary = resolve(root, "primary-codex.mjs");
  const peer = resolve(root, "peer-codex.mjs");
  const primaryCalls = resolve(root, "primary-calls.jsonl");
  const peerCalls = resolve(root, "peer-calls.jsonl");
  const peerReady = resolve(root, "peer-ready");
  const routeCompleted = resolve(root, "route-completed");
  const primaryHome = resolve(root, "primary-home");
  const peerHome = resolve(root, "peer-home");
  const waitFor = async (path, timeoutMs = 3_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await access(path).then(() => true, () => false)) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    throw new Error(`Timed out waiting for ${path}`);
  };
  try {
    await writeFile(primary, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const control = process.env.STATEWRIGHT_ROUTE_CONTROL_DIR;
const marker = join(control, "primary-started");
const route = join(control, "route.json");
const invocation = { args: process.argv.slice(2), client_id: process.env.STATEWRIGHT_CLIENT_ID };
if (existsSync(route)) invocation.route = JSON.parse(readFileSync(route, "utf8"));
appendFileSync(${JSON.stringify(primaryCalls)}, JSON.stringify(invocation) + "\\n");
if (!existsSync(marker)) {
  writeFileSync(marker, "");
  writeFileSync(join(control, "codex-root-session.json"), JSON.stringify({ version: 1, session_id: "primary-thread", client_id: process.env.STATEWRIGHT_CLIENT_ID }));
  writeFileSync(route, JSON.stringify({ session_id: "primary-thread", root_session_id: "primary-thread", client_id: process.env.STATEWRIGHT_CLIENT_ID, run_id: "primary-run", state: "routed", model: "openai-codex/gpt-5.6-sol", effort: "high" }));
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  writeFileSync(${JSON.stringify(routeCompleted)}, "");
}
`);
    await writeFile(peer, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(peerCalls)}, JSON.stringify({ args: process.argv.slice(2), client_id: process.env.STATEWRIGHT_CLIENT_ID }) + "\\n");
writeFileSync(${JSON.stringify(peerReady)}, "");
const deadline = Date.now() + 3_000;
const timer = setInterval(() => {
  if (existsSync(${JSON.stringify(routeCompleted)})) process.exit(0);
  if (Date.now() >= deadline) process.exit(3);
}, 10);
process.on("SIGINT", () => { clearInterval(timer); process.exit(0); });
`);
    await Promise.all([chmod(primary, 0o755), chmod(peer, 0o755)]);
    const peerRun = run({
      workflow: "peer-workflow", prompt: ["remain attached"], codexBin: peer,
      fallbackModel: "gpt-5.6-terra", fallbackEffort: "medium", environment: { ...process.env, HOME: peerHome, STATEWRIGHT_CLIENT_ID: "peer-terminal" },
    });
    await waitFor(peerReady);
    assert.equal(await run({
      workflow: "primary-workflow", prompt: ["route this terminal"], codexBin: primary,
      fallbackModel: "gpt-5.6-terra", fallbackEffort: "medium", environment: { ...process.env, HOME: primaryHome, STATEWRIGHT_CLIENT_ID: "primary-terminal" },
    }), 0);
    assert.equal(await peerRun, 0);
    const primaryInvocations = (await readFile(primaryCalls, "utf8")).trim().split("\n").map(JSON.parse);
    const peerInvocations = (await readFile(peerCalls, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(primaryInvocations.length, 2);
    assert.match(primaryInvocations[0].args.join(" "), /-m gpt-5\.6-terra -c model_reasoning_effort="medium"/);
    assert.match(primaryInvocations[1].args.join(" "), /-m gpt-5\.6-sol -c model_reasoning_effort="high" resume primary-thread/);
    assert.equal(primaryInvocations[1].route.run_id, "primary-run");
    assert.equal(primaryInvocations[1].route.session_id, "primary-thread");
    assert.equal(primaryInvocations[1].route.model, "openai-codex/gpt-5.6-sol");
    assert.equal(primaryInvocations[1].route.effort, "high");
    assert.equal(peerInvocations.length, 1);
    assert.match(peerInvocations[0].args.join(" "), /-m gpt-5\.6-terra -c model_reasoning_effort="medium"/);
    assert.notEqual(peerInvocations[0].client_id, primaryInvocations[0].client_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow load requests a hard boundary for a state that inherits its route", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "statewright-tui-hook-"));
  const controlDir = await mkdtemp(resolve(tmpdir(), "statewright-tui-route-"));
  try {
    const registration = await invokeHook({ session_id: "session-2", prompt: "start" }, { HOME: home, STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir }, "user-prompt");
    assert.equal(registration.status, 0, registration.stderr);
    const result = await invokeHook({
      session_id: "session-2",
      tool_name: "mcp__statewright__statewright_load_workflow",
      tool_response: JSON.stringify({ state_snapshot: {
        workflow: "routing-test",
        state: "inherited",
        run_id: "run-2",
        allowed_tools: ["Read"],
        transitions: [],
      } }),
    }, { HOME: home, STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir });
    assert.equal(result.status, 0, result.stderr);
    const entries = (await readdir(controlDir)).filter((entry) => entry.endsWith(".route.json"));
    assert.equal(entries.length, 1);
    const request = JSON.parse(await readFile(resolve(controlDir, entries[0]), "utf8"));
    assert.equal(request.model, "");
    assert.equal(request.effort, "");
    assert.deepEqual(request.model_ladder, []);
    assert.equal(request.state, "inherited");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(controlDir, { recursive: true, force: true });
  }
});
