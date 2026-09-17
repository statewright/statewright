import { createServer, type ServerResponse } from "node:http"
import { createHash } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Type } from "typebox"
import { AuthStorage, createAgentSession, createExtensionRuntime, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent"
import { createPiRequestGate } from "./request-gate.mjs"
import { installPiRequestGuards } from "./request-hooks.mjs"
import { AdapterBridge } from "../../executor/lib/adapter-bridge.mjs"
import { base, pending, fixture } from "../../executor/tests/fixtures/owned-request.mjs"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })
const inputDigest = (text: string) => createHash("sha256").update(JSON.stringify({ text, images: null })).digest("hex")

function respond(response: ServerResponse, content = "synthetic response") {
  if (response.destroyed) return
  response.writeHead(200, { "Content-Type": "text/event-stream" })
  const chunk = (delta: unknown, finish_reason: string | null) => JSON.stringify({
    id: "synthetic", object: "chat.completion.chunk", model: "synthetic-chat",
    choices: [{ index: 0, delta, finish_reason }],
  })
  response.end(`data: ${chunk({ role: "assistant", content }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`)
}

function respondWithTool(response: ServerResponse) {
  response.writeHead(200, { "Content-Type": "text/event-stream" })
  const chunk = (delta: unknown, finish_reason: string | null) => JSON.stringify({
    id: "synthetic", object: "chat.completion.chunk", model: "synthetic-chat",
    choices: [{ index: 0, delta, finish_reason }],
  })
  response.end(`data: ${chunk({ tool_calls: [{ index: 0, id: "synthetic-call", type: "function",
    function: { name: "synthetic_tool", arguments: "{}" } }] }, null)}\n\ndata: ${chunk({}, "tool_calls")}\n\ndata: [DONE]\n\n`)
}

// Public SDK factory installs actual Agent, onPayload and primary provider
// transport. Responses are inert loopback SSE, not model inference. No native
// session files, user settings, provider credentials or workflow are used.
async function agentFixture(options: { parked?: boolean; retry?: boolean; tool?: boolean; bind?: boolean } = {}) {
  const f = await fixture({ after: (fn: () => Promise<void>) => cleanup.push(fn) }, options)
  const requests: any[] = []
  const sockets: ServerResponse[] = []
  let serve = (_body: any, response: ServerResponse, _index: number) => respond(response)
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    requests.push(body)
    sockets.push(response)
    serve(body, response, requests.length)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const address = server.address() as { port: number }
  const bridge = await new AdapterBridge({ call: async (name: string) => {
    if (name !== "statewright_get_state") throw new Error("Unexpected fixture gateway effect")
    return f.getState()
  } }, { host: "pi", sessionOwner: f.owner, requestController: f.controller }).start()
  cleanup.push(() => bridge.close())
  const call = async (action: string, body: unknown, signal?: AbortSignal) => {
    const response = await fetch(`${bridge.url}/hooks/request/${action}`, {
      method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal,
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    return result
  }
  const onPark = vi.fn()
  const gate = createPiRequestGate({ nativeSessionId: f.owner.record.host_session_id, call, onPark, pollMs: 5, timeoutMs: 3_000 })
  cleanup.push(() => gate.close())
  const sessionManager = SessionManager.inMemory("/fixture")
  sessionManager.newSession({ id: f.owner.record.host_session_id })
  const model = { id: "synthetic-chat", name: "Synthetic", api: "openai-completions", provider: "synthetic-provider",
    baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"],
    contextWindow: 65_536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  const modelRegistry = { hasConfiguredAuth: vi.fn(() => true), getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "synthetic-not-a-secret" })),
    getAll: () => [], find: () => model, isUsingOAuth: () => false }
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>()
  const on = (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, [...handlers.get(event) ?? [], handler])
  // Test-only operation binding uses the untouched synthetic prompt digest.
  // It is NOT a general template/recovery/follow-up correlation implementation.
  const admissions = new Map<string, unknown>()
  const bindings = new WeakMap<AbortSignal, any>()
  let beforeAgent = () => {}
  let beforeProvider = (_ctx: any) => {}
  let toolEffect = () => {}
  const execute = vi.fn(async () => { toolEffect(); return { content: [{ type: "text", text: "synthetic tool result" }], details: {} } })
  let manualReference: unknown = null
  on("input", async (event, ctx) => {
    const result = await gate.input(event, ctx)
    if (result.action === "continue") admissions.set(inputDigest(event.text), gate.reference)
    return result
  })
  on("before_agent_start", () => { beforeAgent() })
  on("before_provider_request", (_event, ctx) => { beforeProvider(ctx) })
  on("context", (event, ctx) => {
    if (options.bind === false) return
    if (bindings.has(ctx.signal)) return
    const user = [...event.messages].reverse().find((message: any) => message.role === "user") as any
    const text = user?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("")
    bindings.set(ctx.signal, admissions.get(inputDigest(text)))
  })
  installPiRequestGuards({ pi: { on }, gate, referenceFor: (event: any, ctx: any) =>
    event.type === "session_before_compact" && !ctx.signal ? manualReference : bindings.get(ctx.signal) })
  const extension = { path: "fixture:actual-agent", handlers, tools: new Map(), commands: new Map(), flags: new Map(),
    shortcuts: new Map(), messageRenderers: new Map() }
  const { session } = await createAgentSession({ cwd: "/fixture", agentDir: "/fixture-unused", model,
    thinkingLevel: "off", ...(options.tool ? { tools: ["synthetic_tool"], customTools: [{
      name: "synthetic_tool", label: "Synthetic", description: "Inert fixture counter", parameters: Type.Object({}), execute,
    }] } : { noTools: "all" }), authStorage: AuthStorage.inMemory(), modelRegistry,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 1 },
      retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 5, provider: { maxRetries: 0 } } }), sessionManager,
    resourceLoader: { getExtensions: () => ({ extensions: [extension], runtime: createExtensionRuntime() }),
      getSystemPrompt: () => "Synthetic fixture", getAppendSystemPrompt: () => [],
      getSkills: () => ({ skills: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getPrompts: () => ({ prompts: [] }) },
  } as any)
  cleanup.push(async () => { await session.abort(); session.dispose() })
  session.extensionRunner!.setUIContext({ notify: vi.fn(), setStatus: vi.fn() } as any)
  gate.enable()
  return { ...f, gate, session, sessionManager, modelRegistry, requests, sockets, onPark, execute,
    setBeforeAgent: (callback: () => void) => { beforeAgent = callback },
    setBeforeProvider: (callback: typeof beforeProvider) => { beforeProvider = callback },
    setServe: (callback: typeof serve) => { serve = callback },
    setToolEffect: (callback: typeof toolEffect) => { toolEffect = callback },
    prompt: (text = "synthetic input", streamingBehavior?: "steer" | "followUp") => session.prompt(text, { expandPromptTemplates: false, streamingBehavior }),
    compact: async () => { manualReference = gate.reference; try { return await session.compact() } finally { manualReference = null } },
  }
}

describe("real SDK Agent and primary provider approval boundaries", () => {
  it("completes the real SDK agent loop through inert primary-provider HTTP", async () => {
    const f = await agentFixture()
    await f.prompt()
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].messages.at(-1).content).toEqual([{ type: "text", text: "synthetic input" }])
    expect(f.session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" })
  })

  it("parks before primary HTTP dispatch, then consumes the same input's release once", async () => {
    const f = await agentFixture()
    f.setBeforeAgent(() => f.setLive(pending))
    const input = f.prompt()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    expect(f.session.isStreaming).toBe(true)
    expect(f.requests).toHaveLength(0)
    f.approve()
    await input
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
    expect(f.events.filter((event: string) => event === "clear:approval")).toHaveLength(1)
  })

  it("keeps pending input before actual Agent start and provider authentication", async () => {
    const f = await agentFixture({ parked: true })
    const input = f.prompt()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    expect(f.session.isStreaming).toBe(false)
    expect(f.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
    f.approve()
    await input
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
  })

  it("native preflight cancellation prevents primary HTTP even though SDK hooks swallow errors", async () => {
    const f = await agentFixture()
    f.setBeforeAgent(() => f.setLive(pending))
    const input = f.prompt()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    const signal = f.session.agent.signal!
    await f.gate.cancel("dismissed")
    await input
    expect(signal.aborted).toBe(true)
    expect(f.requests).toHaveLength(0)
    expect(f.session.agent.state.messages.at(-1)).toMatchObject({ stopReason: "aborted" })
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
  })

  it("denies primary dispatch on native-session drift without aborting the foreign session", async () => {
    const f = await agentFixture()
    const abort = vi.spyOn(f.session.agent, "abort")
    f.setBeforeProvider(() => f.sessionManager.newSession())
    await f.prompt()
    expect(f.requests).toHaveLength(0)
    expect(abort).not.toHaveBeenCalled()
    expect(f.session.agent.state.messages.at(-1)).toMatchObject({ stopReason: "error" })
    expect(f.owner.record.request.reason).toBe("disconnected")
  })

  it("denies unbound primary dispatch without borrowing the current request or aborting it", async () => {
    const f = await agentFixture({ bind: false })
    const abort = vi.spyOn(f.session.agent, "abort")
    await f.prompt()
    expect(f.requests).toHaveLength(0)
    expect(abort).not.toHaveBeenCalled()
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.owner.record.request.phase).toBe("active")
    expect(f.session.agent.state.messages.at(-1)).toMatchObject({ stopReason: "error" })
  })

  it("rechecks native identity across the request helper's asynchronous return", async () => {
    const f = await agentFixture()
    const abort = vi.spyOn(f.session.agent, "abort")
    const checkpoint = f.gate.checkpoint.bind(f.gate)
    vi.spyOn(f.gate, "checkpoint").mockImplementation(async (...args) => {
      const result = await checkpoint(...args)
      if (result) f.sessionManager.newSession()
      return result
    })
    await f.prompt()
    expect(f.requests).toHaveLength(0)
    expect(abort).not.toHaveBeenCalled()
    expect(f.session.agent.state.messages.at(-1)).toMatchObject({ stopReason: "error" })
  })

  it("rejects an old private reference without aborting or cancelling the replacement", async () => {
    const f = await agentFixture()
    await f.prompt("old input")
    const old = f.gate.reference
    await f.prompt("replacement input")
    const abort = vi.spyOn(f.session.agent, "abort")
    const ctx = f.session.extensionRunner!.createContext()
    expect(await f.gate.checkpoint(ctx, undefined, old)).toBe(false)
    expect(abort).not.toHaveBeenCalled()
    expect(f.owner.record.request_epoch).toBe(2)
    expect(f.owner.record.request.phase).toBe("active")
    expect(f.gate.held).toBe(false)
  })

  it.each(["old", "missing"] as const)("rejects %s reference before foreign or throwing context reads", async referenceKind => {
    const f = await agentFixture()
    await f.prompt("old input")
    const old = f.gate.reference
    await f.prompt("replacement input")
    const abort = vi.spyOn(f.session.agent, "abort")
    for (const kind of ["foreign", "throwing identity", "throwing signal"]) {
      const ctx = f.session.extensionRunner!.createContext()
      const read = vi.fn(() => { if (kind === "foreign") return "foreign-native-session"; throw new Error("Stale context") })
      if (kind === "throwing signal") Object.defineProperty(ctx, "signal", { get: read })
      else Object.defineProperty(ctx, "sessionManager", { value: { getSessionId: read } })
      expect(await f.gate.checkpoint(ctx, undefined, referenceKind === "old" ? old : null)).toBe(false)
      expect(read).not.toHaveBeenCalled()
      expect(abort).not.toHaveBeenCalled()
      expect(f.owner.record.request_epoch).toBe(2)
      expect(f.owner.record.request.phase).toBe("active")
      expect(f.gate.held).toBe(false)
    }
  })

  it("parks an actual SDK tool call before its inert effect and cancels without more HTTP", async () => {
    const f = await agentFixture({ tool: true })
    f.setServe((_body, response, index) => {
      if (index === 1) { f.setLive(pending); respondWithTool(response) } else respond(response)
    })
    const input = f.prompt()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(1)
    await f.gate.cancel("dismissed")
    await input
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(1)
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
  })

  it("parks an actual SDK tool result before any next provider request", async () => {
    const f = await agentFixture({ tool: true })
    f.setServe((_body, response, index) => index === 1 ? respondWithTool(response) : respond(response))
    f.setToolEffect(() => f.setLive(pending))
    const input = f.prompt()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.requests).toHaveLength(1)
    await f.gate.cancel("dismissed")
    await input
    expect(f.requests).toHaveLength(1)
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
  })

  it("releases the same actual SDK tool call once before its next provider request", async () => {
    const f = await agentFixture({ tool: true })
    f.setServe((_body, response, index) => {
      if (index === 1) { f.setLive(pending); respondWithTool(response) } else respond(response)
    })
    const input = f.prompt()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    expect(f.execute).not.toHaveBeenCalled()
    f.approve()
    await input
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.requests).toHaveLength(2)
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
  })

  it("guards the SDK's automatic continue retry before its next primary HTTP request", async () => {
    const f = await agentFixture({ retry: true })
    f.setServe((_body, response, index) => {
      if (index !== 1) { respond(response); return }
      f.setLive(pending)
      response.writeHead(503, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "Synthetic 503 overload" } }))
    })
    const input = f.prompt()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request_epoch).toBe(1)
    f.approve()
    await input
    expect(f.requests).toHaveLength(2)
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
  })

  it("cancels the SDK retry preflight without issuing another primary HTTP request", async () => {
    const f = await agentFixture({ retry: true })
    f.setServe((_body, response) => {
      f.setLive(pending)
      response.writeHead(503, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "Synthetic 503 overload" } }))
    })
    const input = f.prompt()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    await f.gate.cancel("dismissed")
    await input
    expect(f.requests).toHaveLength(1)
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
  })

  it("guards actual SDK manual compaction before its separate provider path", async () => {
    const f = await agentFixture()
    await f.prompt()
    // Public session entries supply real SDK compaction preparation. No
    // _checkCompaction/compact/provider implementation is mocked.
    for (let index = 0; index < 4; index++) {
      f.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: `synthetic history ${index}` }], timestamp: Date.now() } as any)
    }
    f.setLive(pending)
    const compaction = f.compact()
    // Attach rejection immediately; it is expected after cancellation.
    const result = compaction.then(() => null, error => error)
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    expect(f.requests).toHaveLength(1)
    await f.gate.cancel("dismissed")
    expect(await result).toMatchObject({ message: "Compaction cancelled" })
    expect(f.requests).toHaveLength(1)
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
  })

  it("releases actual SDK manual compaction for its captured request once", async () => {
    const f = await agentFixture()
    await f.prompt()
    for (let index = 0; index < 4; index++) {
      f.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: `synthetic history ${index}` }], timestamp: Date.now() } as any)
    }
    f.setLive(pending)
    const compaction = f.compact()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    expect(f.requests).toHaveLength(1)
    f.approve()
    const result = await compaction
    expect(result.summary).toContain("synthetic response")
    expect(f.requests).toHaveLength(2)
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
  })

  it.each(["steer", "followUp"] as const)("replacement %s input waits for real idle and never enters SDK queues", async mode => {
    const f = await agentFixture()
    f.setServe((_body, response, index) => {
      if (index !== 1) { respond(response); return }
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.flushHeaders()
    })
    let arrived!: () => void
    let release!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(release)
    let first = true
    f.session.agent.subscribe(async event => {
      if (event.type === "agent_end" && first) { first = false; arrived(); await barrier }
    })
    const steer = vi.spyOn(f.session as any, "_queueSteer")
    const follow = vi.spyOn(f.session as any, "_queueFollowUp")
    const old = f.prompt("old input")
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 2_000, interval: 5 })
    let settled = false
    const replacement = f.prompt("replacement input", mode).then(() => { settled = true })
    await arrival
    try {
      await vi.waitFor(() => expect(f.owner.record.request_epoch).toBe(2), { timeout: 2_000, interval: 5 })
      // Allow durable status and input admission to settle while the actual
      // agent_end listener deliberately keeps the old SDK Agent non-idle.
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(settled).toBe(false)
      expect(steer).not.toHaveBeenCalled()
      expect(follow).not.toHaveBeenCalled()
      expect(f.requests).toHaveLength(1)
    } finally { release(); await old; await replacement }
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1].messages.at(-1).content).toEqual([{ type: "text", text: "replacement input" }])
    expect(f.session.pendingMessageCount).toBe(0)
  })
})
