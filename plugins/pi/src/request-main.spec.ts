import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AdapterBridge } from "../../executor/lib/adapter-bridge.mjs"
import { createExecutorNativeReadiness } from "../../executor/lib/executor-native-readiness.mjs"
import { fixture } from "../../executor/tests/fixtures/owned-request.mjs"
import { createPiPrivateRequestTransport, piRequestLaunchConfiguration, runPiManagedCli } from "./request-main.mjs"
import { parsePiRequestMode } from "./request-mode.mjs"

const cleanup: Array<() => any> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })

describe("managed owning SDK CLI", () => {
  it("selects native modes without accepting replacement/discovery arguments", () => {
    expect(parsePiRequestMode(["--mode", "json", "--thinking", "off", "a", "b"])).toEqual({ mode: "json", thinkingLevel: "off", messages: ["a", "b"] })
    expect(parsePiRequestMode(["--", "--session", "literal input"]).messages).toEqual(["--session", "literal input"])
    for (const argv of [["--session", "foreign"], ["--resume"], ["--extension", "foreign"], ["--mode"], ["--print", "--mode", "text"], ["--mode", "rpc", "prompt"], ["--thinking", "off", "--thinking", "high"]]) {
      expect(() => parsePiRequestMode(argv)).toThrow()
    }
  })

  it("requires strict private launch configuration and a fixed local bridge", () => {
    expect(() => piRequestLaunchConfiguration({})).toThrow("configuration required")
    for (const value of ["{}", "null", "[]", "invalid", '"literal"']) expect(() => piRequestLaunchConfiguration({ STATEWRIGHT_PI_REQUEST_LAUNCH: value })).toThrow()
    const id = "12345678-1234-4234-8234-123456789012"
    const challenge = { schema: "statewright/native-readiness-challenge/v1", executor_session_id: id, native_session_id: id,
      native_session_file: "/synthetic/session.jsonl", parent_lifetime_id: id, child_lifetime_id: id }
    const launch = { schema: "statewright/pi-request-launch/v1", challenge, cwd: "/synthetic", agent_dir: "/synthetic/agent",
      model: { provider: "synthetic", id: "synthetic" } }
    expect(piRequestLaunchConfiguration({ STATEWRIGHT_PI_REQUEST_LAUNCH: JSON.stringify(launch) }).challenge).toEqual(challenge)
    for (const field of ["executor_session_id", "native_session_id", "parent_lifetime_id", "child_lifetime_id"]) {
      for (const value of [[id], null, 123, { id }]) {
        const malformed = { ...launch, challenge: { ...challenge, [field]: value } }
        expect(() => piRequestLaunchConfiguration({ STATEWRIGHT_PI_REQUEST_LAUNCH: JSON.stringify(malformed) })).toThrow("readiness challenge")
      }
    }
    for (const url of ["https://127.0.0.1:1234", "http://example.com:1234", "http://127.0.0.1:1234/path", "http://127.0.0.1:1234/?token=x", "http://secret@127.0.0.1:1234/"]) {
      expect(() => createPiPrivateRequestTransport({ STATEWRIGHT_ADAPTER_URL: url, STATEWRIGHT_ADAPTER_TOKEN: "synthetic" })).toThrow("loopback")
    }
  })

  it("rejects an alternate environment before fixed project registration or SDK setup", async () => {
    await expect(runPiManagedCli({ argv: [], env: {} })).rejects.toThrow("process environment")
  })

  it("will not forward a private bearer through an HTTP redirect", async () => {
    const received: string[] = []
    const server = createServer((request, response) => {
      received.push(request.url!)
      response.writeHead(302, { Location: "/redirect-target" }); response.end()
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const call = createPiPrivateRequestTransport({ STATEWRIGHT_ADAPTER_URL: `http://127.0.0.1:${(server.address() as any).port}`, STATEWRIGHT_ADAPTER_TOKEN: "synthetic" })
    await expect(call("begin", {})).rejects.toThrow()
    expect(received).toEqual(["/hooks/request/begin"])
  })

  for (const mode of ["text", "json", "rpc"]) it(`runs actual ${mode} CLI with a bound task-owned child and exact private SDK readiness`, async () => {
    const f = await fixture({ after: (callback: () => any) => cleanup.push(callback) }, { nativeFile: true })
    const requests: any[] = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      const chunk = (delta: any, finish_reason: any) => JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", model: "synthetic-chat", choices: [{ index: 0, delta, finish_reason }] })
      response.end(`data: ${chunk({ role: "assistant", content: "synthetic CLI response" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
    const readiness = createExecutorNativeReadiness({ owner: f.owner, requestController: f.controller })
    const bridge = await new AdapterBridge({ call: () => f.getState(), request: async (method: string, params: any) => {
      if (method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } }
      if (method === "tools/list") return { tools: [] }
      if (params.name !== "statewright_get_state") throw new Error("Unexpected project fixture effect")
      return { content: [{ type: "text", text: JSON.stringify(await f.getState()) }] }
    } }, { host: "pi", sessionOwner: f.owner, requestController: f.controller, nativeReadiness: readiness }).start()
    cleanup.push(() => bridge.close())
    const cwd = f.owner.record.scope.cwd
    const agentDir = join(cwd, "agent")
    await mkdir(agentDir)
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "synthetic-provider": {
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, api: "openai-completions", apiKey: "synthetic-not-a-secret",
      models: [{ id: "synthetic-chat", name: "Synthetic", reasoning: false, input: ["text"], contextWindow: 65_536, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }))
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } } }))
    const launch = { schema: "statewright/pi-request-launch/v1", challenge: readiness.challenge, cwd, agent_dir: agentDir, model: { provider: "synthetic-provider", id: "synthetic-chat" } }
    const before = await readFile(f.owner.record.host_session_file, "utf8")
    const child = spawn(process.execPath, [fileURLToPath(new URL("../request-main.mjs", import.meta.url)), "--mode", mode, "--thinking", "off", ...(mode === "rpc" ? [] : ["synthetic explicit input"])], {
      cwd, env: { PATH: process.env.PATH, STATEWRIGHT_ADAPTER_URL: bridge.url, STATEWRIGHT_ADAPTER_TOKEN: bridge.token,
        STATEWRIGHT_PI_REQUEST_LAUNCH: JSON.stringify(launch), STATEWRIGHT_POWERLINE: "0", STATEWRIGHT_API_KEY: "synthetic-not-a-secret",
        STATEWRIGHT_NO_UPDATE_CHECK: "1", STATEWRIGHT_GATEWAY_URL: bridge.url, STATEWRIGHT_PB_URL: bridge.url,
        STATEWRIGHT_SENTRY_DISABLED: "true", STATEWRIGHT_PI_REQUEST_DEBUG: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const closed = once(child, "close")
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await closed })
    await once(child, "spawn")
    readiness.bindChild(child)
    let stdout = ""; let stderr = ""
    child.stdout.on("data", chunk => {
      stdout += chunk
      if (mode === "rpc") {
        for (const line of stdout.split("\n")) {
          try { const event = JSON.parse(line); if (event.type === "agent_end") child.stdin.end() } catch { /* partial native JSON line */ }
        }
      }
    })
    child.stderr.on("data", chunk => { stderr += chunk })
    if (mode === "rpc") child.stdin.write(`${JSON.stringify({ type: "prompt", id: "synthetic-input", message: "synthetic explicit input" })}\n`)
    const timer = setTimeout(() => child.kill("SIGTERM"), 8_000)
    let result
    try { result = await closed } finally { clearTimeout(timer) }
    expect({ result, stderr, stdout, requests: requests.length, epoch: f.owner.record.request_epoch }).toEqual(expect.objectContaining({ result: [0, null] }))
    expect(stdout).toContain("synthetic CLI response")
    if (mode !== "text") for (const line of stdout.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow()
    expect(requests).toHaveLength(1)
    expect(f.owner.record.request_epoch).toBe(1)
    expect(await readFile(f.owner.record.host_session_file, "utf8")).not.toBe(before)
    expect(readiness.ready).toBe(false)
  }, 12_000)
})
