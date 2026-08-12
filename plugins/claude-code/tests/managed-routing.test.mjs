import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

const hook = resolve("plugins/claude-code/hook.sh");

async function runHook(input, environment) {
  return await new Promise((resolveResult, rejectResult) => {
    const child = spawn("bash", [hook, "post-tool"], {
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectResult);
    child.once("exit", (code) => resolveResult({ code, stderr }));
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

test("Claude workflow load emits a route request only for a managed client", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-claude-route-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const control = join(root, "control");
  const state = { state: "implement", model: "claude-opus-4-6", thinking_level: "high", run_id: "run-1", allowed_tools: ["Read"], transitions: [] };
  try {
    await (await import("node:fs/promises")).mkdir(control, { recursive: true });
    await writeFile(join(control, "identity.json"), '{"version":1,"host":"claude","client_id":"swc_0123456789abcdef0123456789abcdef"}\n');
    await writeFile(join(root, "curl"), `#!/usr/bin/env sh\nprintf '%s' ${JSON.stringify(JSON.stringify({ result: { content: [{ text: JSON.stringify(state) }] } }))}\n`);
    await chmod(join(root, "curl"), 0o755);
    await (await import("node:fs/promises")).mkdir(bin, { recursive: true });
    await (await import("node:fs/promises")).rename(join(root, "curl"), join(bin, "curl"));
    const result = await runHook({
      session_id: "claude-session-1",
      tool_name: "mcp__plugin_statewright_statewright_load_workflow",
      tool_response: JSON.stringify([{ text: JSON.stringify({ run_id: "run-1" }) }]),
    }, { HOME: home, PATH: `${bin}:${process.env.PATH}`, STATEWRIGHT_ROUTE_CONTROL_DIR: control, STATEWRIGHT_API_KEY: "test" });
    assert.equal(result.code, 0, result.stderr);
    const entries = (await readdir(control)).filter((entry) => entry.endsWith(".route.json"));
    assert.equal(entries.length, 1);
    const request = JSON.parse(await readFile(join(control, entries[0]), "utf8"));
    assert.equal(request.session_id, "claude-session-1");
    assert.equal(request.root_session_id, "");
    assert.equal(request.client_id, "swc_0123456789abcdef0123456789abcdef");
    assert.equal(request.model, "claude-opus-4-6");
    assert.equal(request.effort, "high");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Claude route requests retain the managed root session for native child routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "statewright-claude-root-route-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const control = join(root, "control");
  const state = { state: "implement", model: "claude-opus-4-6", thinking_level: "high", run_id: "run-1", allowed_tools: ["Read"], transitions: [] };
  try {
    await (await import("node:fs/promises")).mkdir(control, { recursive: true });
    await writeFile(join(control, "identity.json"), '{"version":1,"host":"claude","client_id":"swc_0123456789abcdef0123456789abcdef"}\n');
    await writeFile(join(root, "curl"), `#!/usr/bin/env sh\nprintf '%s' ${JSON.stringify(JSON.stringify({ result: { content: [{ text: JSON.stringify(state) }] } }))}\n`);
    await chmod(join(root, "curl"), 0o755);
    await (await import("node:fs/promises")).mkdir(bin, { recursive: true });
    await (await import("node:fs/promises")).rename(join(root, "curl"), join(bin, "curl"));
    const result = await runHook({
      session_id: "claude-child-session",
      tool_name: "mcp__plugin_statewright_statewright_load_workflow",
      tool_response: JSON.stringify([{ text: JSON.stringify({ run_id: "run-1" }) }]),
    }, { HOME: home, PATH: `${bin}:${process.env.PATH}`, STATEWRIGHT_ROUTE_CONTROL_DIR: control, STATEWRIGHT_MANAGED_CLAUDE_ROOT_SESSION_ID: "claude-parent-session", STATEWRIGHT_API_KEY: "test" });
    assert.equal(result.code, 0, result.stderr);
    const entries = (await readdir(control)).filter((entry) => entry.endsWith(".route.json"));
    const request = JSON.parse(await readFile(join(control, entries[0]), "utf8"));
    assert.equal(request.session_id, "claude-child-session");
    assert.equal(request.root_session_id, "claude-parent-session");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Claude MCP proxy forwards managed sessions through the supervisor bridge", async () => {
  const seen = [];
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({ path: request.url, authorization: request.headers.authorization, session_id: request.headers["mcp-session-id"], body: Buffer.concat(chunks).toString("utf8") });
    requestCount += 1;
    response.writeHead(200, {
      "Content-Type": "application/json",
      ...(requestCount === 1 ? { "Mcp-Session-Id": "session-from-gateway" } : {}),
    });
    response.end(`{"jsonrpc":"2.0","result":{"ok":true},"id":${requestCount}}\n`);
  });
  await new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", resolveStart);
  });
  const address = server.address();
  const root = await mkdtemp(join(tmpdir(), "statewright-claude-proxy-"));
  try {
    const child = spawn("bash", [resolve("plugins/claude-code/mcp-proxy.sh")], {
      env: {
        ...process.env,
        HOME: root,
        STATEWRIGHT_MANAGED_CLIENT_HOST: "claude",
        STATEWRIGHT_MANAGED_MCP_URL: `http://127.0.0.1:${address.port}`,
        STATEWRIGHT_MANAGED_MCP_TOKEN: "bridge-token",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stdin.write('{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}\n');
    await new Promise((resolveOutput) => setTimeout(resolveOutput, 100));
    child.stdin.end('{"jsonrpc":"2.0","method":"tools/list","params":{},"id":2}\n');
    await new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", resolveExit);
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].authorization, "Bearer bridge-token");
    assert.equal(seen[1].authorization, "Bearer bridge-token");
    assert.equal(seen[1].session_id, "session-from-gateway");
    assert.match(output, /"id":1/);
    assert.match(output, /"id":2/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});
