import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import test, { after, before } from "node:test"

const root = new URL("../", import.meta.url).pathname
const hook = join(root, "hook.sh")
const scratch = mkdtempSync(join(tmpdir(), "statewright-cursor-hook-"))
const portFile = join(scratch, "port")
let state = {
  state: "implementing",
  model: "openai/gpt-5.6-terra",
  thinkingLevel: "medium",
  deliveryRequired: false,
  executor: { active: true, delivery: false },
  additionalContext: "Current state: implementing.",
}
let lastPreTool = null
let postCount = 0
let server

before(async () => {
  server = createServer((request, response) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
      response.setHeader("content-type", "application/json")
      if (request.url === "/hooks/state") response.end(JSON.stringify(state))
      else if (request.url === "/hooks/pre-tool") {
        lastPreTool = body
        response.end(JSON.stringify({
          decision: body.tool_name === "Bash" ? "deny" : "allow",
          additionalContext: "Bash is not allowed",
        }))
      } else if (request.url === "/hooks/post-tool") {
        postCount += 1
        response.end(JSON.stringify({}))
      } else if (request.url === "/hooks/stop") {
        response.end(JSON.stringify({
          decision: "block",
          additionalContext: "Continue the workflow.",
        }))
      } else {
        response.statusCode = 404
        response.end("{}")
      }
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  writeFileSync(portFile, String(server.address().port))
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(scratch, { recursive: true, force: true })
})

async function invoke(event, input = {}, extraEnv = {}) {
  const result = await new Promise((resolve) => {
    const child = spawn("bash", [hook, event], {
      env: {
        ...process.env,
        STATEWRIGHT_HOOK_PORT_FILE: portFile,
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.on("close", (status) => resolve({ status, stdout, stderr }))
    child.stdin.end(JSON.stringify(input))
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout || "{}")
}

test("sessionStart injects state and route advisory", async () => {
  const result = await invoke("session-start")
  assert.match(result.additional_context, /implementing/)
  assert.match(result.additional_context, /openai\/gpt-5\.6-terra/)
})

test("preToolUse normalizes Cursor Shell to portable Bash and denies it", async () => {
  const result = await invoke("pre-tool", {
    tool_name: "Shell",
    tool_input: { command: "npm test" },
  })
  assert.equal(result.permission, "deny")
  assert.equal(lastPreTool.tool_name, "Bash")
  assert.equal(lastPreTool.host_tool_name, "Shell")
})

test("preToolUse normalizes Cursor ReadFile to portable Read", async () => {
  const result = await invoke("pre-tool", {
    tool_name: "ReadFile",
    tool_input: { path: "README.md" },
  })
  assert.equal(result.permission, "allow")
  assert.equal(lastPreTool.tool_name, "Read")
})

test("required delivery trusts the executor contract, not an environment marker", async () => {
  state = { ...state, deliveryRequired: true, executor: { active: true, delivery: false } }
  assert.equal((await invoke("pre-tool", { tool_name: "ReadFile", tool_input: {} })).permission, "deny")
  assert.equal((await invoke(
    "pre-tool",
    { tool_name: "ReadFile", tool_input: {} },
    { STATEWRIGHT_DELIVERY_ACTIVE: "1" },
  )).permission, "deny")
  state = { ...state, executor: { active: true, delivery: true } }
  assert.equal((await invoke("pre-tool", { tool_name: "ReadFile", tool_input: {} })).permission, "allow")
  state = { ...state, deliveryRequired: false, executor: { active: true, delivery: false } }
})

test("postToolUse and stop bridge lifecycle endpoints", async () => {
  await invoke("post-tool", { tool_name: "ReadFile" })
  assert.equal(postCount, 1)
  assert.equal((await invoke("stop")).followup_message, "Continue the workflow.")
})

test("Statewright control tools bypass workload policy and accounting", async () => {
  const before = postCount
  const result = await invoke("pre-tool", {
    tool_name: "CallMcpTool",
    tool_input: {
      server_name: "statewright",
      tool_name: "statewright_transition",
    },
  })
  assert.equal(result.permission, "allow")
  await invoke("post-tool", {
    tool_name: "CallMcpTool",
    tool_input: {
      server_name: "statewright",
      tool_name: "statewright_transition",
    },
  })
  assert.equal(postCount, before)
})
