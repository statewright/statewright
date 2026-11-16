import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import test, { after, before } from "node:test"

const root = new URL("../", import.meta.url).pathname
const hook = join(root, "hook.sh")
const scratch = mkdtempSync(join(tmpdir(), "statewright-claude-hook-"))
let server
let bridgeUrl
let lastPreTool = null
let lastPostTool = null
let lastStop = null
let postCount = 0

before(async () => {
  server = createServer((request, response) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
      response.setHeader("content-type", "application/json")
      if (request.url === "/hooks/state") {
        response.end(JSON.stringify({
          state: "implementing",
          is_final: false,
          iteration: 1,
          max_iterations: 4,
          allowed_tools: ["Read", "Edit"],
          allowed_commands: [],
          transitions: [{ event: "DONE", target: "testing" }],
          instructions: "Implement the fix",
          model: "claude-sonnet-4-6",
          thinking_level: "high",
          meta: { workspace: { required: true } },
          executor: { active: true, delivery: true },
        }))
      } else if (request.url === "/hooks/pre-tool") {
        lastPreTool = body
        if (body.tool_name === "Bash" && body.tool_input.command === "inspect one") {
          response.end(JSON.stringify({ decision: "ask", classifier_approval: { reason: "Review inspect one. Allowing will remember this for 2h." } }))
        } else if (body.tool_name === "Bash" && body.tool_input.command === "inspect two") {
          response.end(JSON.stringify({ decision: "defer" }))
        } else response.end(JSON.stringify({ decision: "deny", reason: "Read denied by test" }))
      } else if (request.url === "/hooks/post-tool") {
        lastPostTool = body
        postCount += 1
        response.end(JSON.stringify({}))
      } else if (request.url === "/hooks/stop") {
        lastStop = body
        response.end(JSON.stringify({ decision: "block", reason: "Continue workflow" }))
      } else if (request.url === "/newer/api/plugins/versions") {
        response.end(JSON.stringify({ versions: { "claude-code": "9.9.9" } }))
      } else if (request.url === "/older/api/plugins/versions") {
        response.end(JSON.stringify({ versions: { "claude-code": "0.3.0" } }))
      } else {
        response.statusCode = 404
        response.end("{}")
      }
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  bridgeUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(scratch, { recursive: true, force: true })
})

async function invoke(event, input = {}, environment = {}) {
  const result = await new Promise((resolve) => {
    const child = spawn("bash", [hook, event], {
      cwd: scratch,
      env: {
        ...process.env,
        HOME: scratch,
        STATEWRIGHT_API_KEY: "",
        STATEWRIGHT_ADAPTER_URL: bridgeUrl,
        STATEWRIGHT_ADAPTER_TOKEN: "bridge-token",
        STATEWRIGHT_EXECUTOR_ID: "executor-1",
        STATEWRIGHT_NO_UPDATE_CHECK: "1",
        ...environment,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.on("close", (status) => resolve({ status, stdout, stderr }))
    child.stdin.end(JSON.stringify({ session_id: "claude-session", ...input }))
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout || "{}")
}

test("executor bridge supplies workflow context without an API key", async () => {
  const result = await invoke("user-prompt")
  assert.match(result.hookSpecificOutput.additionalContext, /Phase: implementing/)
  assert.match(result.hookSpecificOutput.additionalContext, /claude-sonnet-4-6/)
})

test("update checks keep one hook response and only announce a newer version", async () => {
  const updateCache = join(scratch, ".statewright", ".update_cache")
  rmSync(updateCache, { force: true })
  const newer = await invoke("user-prompt", {}, {
    STATEWRIGHT_NO_UPDATE_CHECK: "",
    STATEWRIGHT_PB_URL: `${bridgeUrl}/newer`,
  })
  assert.match(newer.hookSpecificOutput.additionalContext, /Phase: implementing/)
  assert.match(newer.hookSpecificOutput.additionalContext, /update available: v0\.4\.0 → v9\.9\.9/)

  rmSync(updateCache, { force: true })
  const older = await invoke("user-prompt", {}, {
    STATEWRIGHT_NO_UPDATE_CHECK: "",
    STATEWRIGHT_PB_URL: `${bridgeUrl}/older`,
  })
  assert.match(older.hookSpecificOutput.additionalContext, /Phase: implementing/)
  assert.doesNotMatch(older.hookSpecificOutput.additionalContext, /update available/)
})

test("executor bridge owns Claude pre-tool, post-tool, and stop lifecycle", async () => {
  const denied = await invoke("pre-tool", {
    tool_name: "Read",
    tool_input: { file_path: "README.md" },
  })
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny")
  assert.equal(lastPreTool.tool_name, "Read")

  await invoke("post-tool", {
    tool_name: "Read",
    tool_input: { file_path: "README.md" },
    tool_result: "content",
  })
  assert.equal(postCount, 1)
  assert.equal((await invoke("stop")).decision, "block")
})

test("managed classifier review asks Claude with the selected duration and binds tool identity", async () => {
  const ask = await invoke("pre-tool", {
    tool_name: "Bash", tool_use_id: "tool-review-1",
    cwd: scratch, tool_input: { command: "inspect one" },
  })
  assert.equal(ask.hookSpecificOutput.permissionDecision, "ask")
  assert.match(ask.hookSpecificOutput.permissionDecisionReason, /Allowing will remember this for 2h/)
  assert.equal(lastPreTool.session_id, "claude-session")
  assert.equal(lastPreTool.tool_use_id, "tool-review-1")
  assert.equal(realpathSync(lastPreTool.tool_input.cwd), realpathSync(scratch))

  await invoke("post-tool", {
    tool_name: "Bash", tool_use_id: "tool-review-1",
    cwd: scratch, tool_input: { command: "inspect one" }, tool_result: "ok",
  })
  assert.equal(lastPostTool.session_id, "claude-session")
  assert.equal(lastPostTool.tool_use_id, "tool-review-1")
  assert.deepEqual(lastPostTool.tool_input, lastPreTool.tool_input)
  await invoke("stop")
  assert.deepEqual(lastStop, { session_id: "claude-session" })
})

test("remembered classifier approval defers to Claude permissions and managed responder stays silent", async () => {
  const deferred = await invoke("pre-tool", {
    tool_name: "Bash", tool_use_id: "tool-reuse-1",
    cwd: scratch,
    tool_input: { command: "inspect two" },
  })
  assert.deepEqual(deferred, {})
  assert.equal(realpathSync(lastPreTool.tool_input.cwd), realpathSync(scratch))
  const sessionDir = join(scratch, ".statewright", "sessions", "claude-session".slice(0, 12))
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, ".active"), "active\n")
  writeFileSync(join(sessionDir, ".state_cache"), JSON.stringify({
    state: "work", allowed_tools: ["Bash"], allowed_commands: ["inspect two"],
    meta: { autonomous: true },
  }))
  try {
    const responder = await invoke("permission-request", {
      tool_name: "Bash", tool_use_id: "tool-reuse-1",
      tool_input: { command: "inspect two" },
    })
    assert.deepEqual(responder, {})
  } finally {
    rmSync(sessionDir, { recursive: true, force: true })
  }
})

test("post-tool forwards Claude's actual changed input for invocation binding", async () => {
  await invoke("pre-tool", {
    tool_name: "Bash", tool_use_id: "tool-rewrite-1", cwd: scratch,
    tool_input: { command: "inspect one" },
  })
  const checked = lastPreTool.tool_input
  await invoke("post-tool", {
    tool_name: "Bash", tool_use_id: "tool-rewrite-1", cwd: scratch,
    tool_input: { command: "inspect changed" }, tool_result: "ok",
  })
  assert.equal(lastPostTool.tool_input.command, "inspect changed")
  assert.notDeepEqual(lastPostTool.tool_input, checked)
})
