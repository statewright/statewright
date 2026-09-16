import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
