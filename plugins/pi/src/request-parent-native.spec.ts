import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createPiExecutorRuntime } from "../../executor/lib/executor-pi-runtime.mjs"
import { executorAgentEnvironment, observeHost } from "../../executor/statewright-exec.mjs"
import { fixture } from "../../executor/tests/fixtures/owned-request.mjs"

const cleanup: Array<() => any> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

describe("actual owning parent / fixed CLI composition", () => {
  for (const cold of [false, true]) it(`runs the fixed SDK print child through the real parent${cold ? " after cold parked reopen" : " from active state"}`, async () => {
    const f = await fixture({ after: (callback: () => any) => cleanup.push(callback) }, { nativeFile: true, parked: cold })
    const savedFile = f.owner.record.host_session_file
    const savedId = f.owner.record.host_session_id
    if (cold) {
      expect((await f.controller.begin(f.body(1))).phase).toBe("parked")
      await f.controller.close()
      await f.reopen()
      expect(f.owner.record.request.reason).toBe("disconnected")
    }
    const requests: any[] = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      const chunk = (delta: any, finish_reason: any) => JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", model: "synthetic-chat", choices: [{ index: 0, delta, finish_reason }] })
      response.end(`data: ${chunk({ role: "assistant", content: "owned parent response" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const client = { call: async (name: string) => {
      if (name !== "statewright_get_state") throw new Error("Unexpected parent fixture effect")
      return f.getState()
    }, request: async (method: string, params: any) => {
      if (method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } }
      if (method === "tools/list") return { tools: [] }
      if (params.name !== "statewright_get_state") throw new Error("Unexpected project fixture effect")
      return { content: [{ type: "text", text: JSON.stringify(await f.getState()) }] }
    } }
    const bridgeEvents: any[] = []
    const runtime = await createPiExecutorRuntime({ client, sessionOwner: f.owner, approvalMirror: f.mirror,
      telemetry: async (event: string, fields: any) => { if (event === "executor_adapter_error") bridgeEvents.push(fields) } })
    cleanup.push(() => runtime.adapterBridge.close())
    const cwd = f.owner.record.scope.cwd
    const agentDir = join(cwd, "agent")
    await mkdir(agentDir)
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "synthetic-provider": {
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, api: "openai-completions", apiKey: "synthetic-not-a-secret",
      models: [{ id: "synthetic-chat", name: "Synthetic", reasoning: false, input: ["text"], contextWindow: 65_536, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }))
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } } }))
    const environment = executorAgentEnvironment({ PATH: process.env.PATH, STATEWRIGHT_POWERLINE: "0",
      STATEWRIGHT_NO_UPDATE_CHECK: "1", STATEWRIGHT_GATEWAY_URL: runtime.adapterBridge.url,
      STATEWRIGHT_PB_URL: runtime.adapterBridge.url, STATEWRIGHT_SENTRY_DISABLED: "true", STATEWRIGHT_PI_REQUEST_DEBUG: "1" }, {
      host: "pi", workflow: "fixture", adapterBridge: runtime.adapterBridge,
      executorId: f.owner.record.executor_session_id,
      transportClientId: f.owner.record.transport_client_id, transportSessionId: f.owner.record.transport_session_id,
    })
    let child: any; let closed: any; let stdout = ""; let stderr = ""; let launches = 0
    cleanup.push(async () => { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await closed })
    const observing = observeHost({ ...runtime, host: "pi", piRequestFrontend: true, piMode: "text", piAgentDir: agentDir,
      cwd, pluginsRoot: fileURLToPath(new URL("../../", import.meta.url)), sessionOwner: f.owner,
      hostSessionId: savedId, hostSessionFile: savedFile, initialState: { ...await f.getState(), model: "synthetic-provider/synthetic-chat" },
      prompt: "synthetic explicit input", environment, client, approvalMirror: f.mirror, telemetry: async () => {}, pollIntervalMs: 25,
      spawnHost: (command: string, args: string[], options: any) => {
        launches++
        expect(command).toBe(process.execPath)
        expect(args[0]).toBe(fileURLToPath(new URL("../request-main.mjs", import.meta.url)))
        child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] })
        closed = once(child, "close")
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk })
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk })
        return child
      },
    })
    // Attach rejection immediately, even while checking the pending barriers.
    const result = observing.then((value: any) => ({ value }), (error: any) => ({ error }))
    const timer = setTimeout(() => child?.kill("SIGTERM"), 8_000)
    try {
      if (cold) {
        await vi.waitFor(() => expect(f.owner.record.request_epoch).toBe(2), { timeout: 2_500, interval: 10 })
        expect(requests).toHaveLength(0)
        expect(runtime.nativeReadiness.ready).toBe(true)
        expect(await f.mirror.loadCheckpoint()).not.toBeNull()
        const reads = f.events.filter((event: string) => event === "read:pending").length
        f.setLive({ run_id: "run", run_session_id: "session", workflow: "fixture", state: "work" })
        await vi.waitFor(() => expect(f.events.filter((event: string) => event === "read:pending").length).toBeGreaterThan(reads), { timeout: 1_500, interval: 10 })
        expect(requests).toHaveLength(0)
        expect(await f.mirror.loadCheckpoint()).not.toBeNull()
        f.approve()
      }
      expect(await result, JSON.stringify({ stdout, stderr, launches, request: f.owner.record.request })).toEqual(expect.objectContaining({ value: expect.objectContaining({ code: 0 }) }))
      await closed
    } finally { clearTimeout(timer) }
    expect(launches).toBe(1)
    expect(stdout, JSON.stringify({ stderr, bridgeEvents, requests: requests.length, request: f.owner.record.request })).toContain("owned parent response")
    expect(requests).toHaveLength(1)
    expect(f.owner.record.host_session_id).toBe(savedId)
    expect(f.owner.record.host_session_file).toBe(savedFile)
    expect(f.owner.record.request_epoch).toBe(cold ? 2 : 1)
    expect(f.owner.record.request.reason).toBe("disconnected")
    expect(runtime.nativeReadiness.ready).toBe(false)
    expect(await readFile(savedFile, "utf8")).toContain("owned parent response")
    if (cold) {
      expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
      expect(f.events.filter((event: string) => event === "clear:approval")).toHaveLength(1)
      expect(await f.mirror.loadCheckpoint()).toBeNull()
    }
  }, 12_000)
})
