import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliModel, codexArgs, parseArgs, run } from "../scripts/statewright-codex-tui.mjs";

const codexRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function invokeHook(input, environment) {
  return await new Promise((resolveResult) => {
    const child = spawn("bash", [resolve(codexRoot, "hook.sh"), "post-tool"], {
      env: { ...process.env, ...environment },
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
    const result = await invokeHook({
      session_id: "session-1",
      tool_name: "mcp__statewright__statewright_load_workflow",
      tool_response: JSON.stringify({ state_snapshot: {
        workflow: "routing-test",
        state: "baseline",
        model: "openai-codex/gpt-5.6-sol",
        thinking_level: "high",
        run_id: "run-1",
        allowed_tools: ["Read"],
        transitions: [],
      } }),
    }, { HOME: home, STATEWRIGHT_ROUTE_CONTROL_DIR: controlDir });
    assert.equal(result.status, 0, result.stderr);
    const entries = await readdir(controlDir);
    assert.equal(entries.length, 1);
    assert.deepEqual(JSON.parse(await readFile(resolve(controlDir, entries[0]), "utf8")), {
      session_id: "session-1",
      run_id: "run-1",
      state: "baseline",
      model: "openai-codex/gpt-5.6-sol",
      effort: "high",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(controlDir, { recursive: true, force: true });
  }
});

test("interactive supervisor restarts the child with the next state route", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "statewright-tui-supervisor-"));
  const fakeCodex = resolve(root, "fake-codex.mjs");
  const calls = resolve(root, "calls.log");
  try {
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");
const marker = join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "emitted");
if (!existsSync(marker)) {
  writeFileSync(marker, "");
  writeFileSync(join(process.env.STATEWRIGHT_ROUTE_CONTROL_DIR, "route.json"), JSON.stringify({ session_id: "session-1", model: "openai-codex/gpt-5.6-sol", effort: "high" }));
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
    const entries = await readdir(controlDir);
    assert.equal(entries.length, 1);
    const request = JSON.parse(await readFile(resolve(controlDir, entries[0]), "utf8"));
    assert.equal(request.model, "");
    assert.equal(request.effort, "");
    assert.equal(request.state, "inherited");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(controlDir, { recursive: true, force: true });
  }
});
