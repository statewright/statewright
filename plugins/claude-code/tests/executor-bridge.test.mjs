import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
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
        response.end(JSON.stringify({ decision: "deny", reason: "Read denied by test" }))
      } else if (request.url === "/hooks/post-tool") {
        postCount += 1
        response.end(JSON.stringify({}))
      } else if (request.url === "/hooks/stop") {
        response.end(JSON.stringify({ decision: "block", reason: "Continue workflow" }))
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

async function invoke(event, input = {}) {
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
