import { createServer, type ServerResponse } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Type } from "typebox"
import { AuthStorage, createAgentSession, createExtensionRuntime, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent"
import { getApiProvider, getApiProviders, registerApiProvider, unregisterApiProviders } from "@mariozechner/pi-ai"
import { randomUUID } from "node:crypto"
import { AsyncResource } from "node:async_hooks"
import { createPiRequestGate } from "./request-gate.mjs"
import { installPiRequestGuards } from "./request-hooks.mjs"
import { createPiRequestOperations } from "./request-operations.mjs"
import { AdapterBridge } from "../../executor/lib/adapter-bridge.mjs"
import { base, pending, fixture } from "../../executor/tests/fixtures/owned-request.mjs"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })

function respond(response: ServerResponse, content = "synthetic response", usage?: unknown) {
  if (response.destroyed) return
  response.writeHead(200, { "Content-Type": "text/event-stream" })
  const chunk = (delta: unknown, finish_reason: string | null) => JSON.stringify({
    id: "synthetic", object: "chat.completion.chunk", model: "synthetic-chat",
    choices: [{ index: 0, delta, finish_reason }],
  })
  response.end(`data: ${chunk({ role: "assistant", content }, null)}\n\ndata: ${chunk({}, "stop")}\n\n${usage ? `data: ${JSON.stringify({ choices: [], usage })}\n\n` : ""}data: [DONE]\n\n`)
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
async function agentFixture(options: { parked?: boolean; retry?: boolean; tool?: boolean; bind?: boolean; api?: string;
  autoCompact?: boolean; retryDelayMs?: number; history?: "initial" | "after" } = {}) {
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
  const operations = createPiRequestOperations()
  const gate = createPiRequestGate({ nativeSessionId: f.owner.record.host_session_id, call, onPark,
    onAdmit: (reference: unknown) => operations.admit(reference), pollMs: 5, timeoutMs: 3_000 })
  cleanup.push(() => gate.close())
  const sessionManager = SessionManager.inMemory("/fixture")
  sessionManager.newSession({ id: f.owner.record.host_session_id })
  // Synthetic initial history is setup, before any guarded runtime API exists.
  // Runtime appendMessage remains denied outside a private request scope.
  const seedHistory = () => {
    for (let index = 0; index < 4; index++) {
      sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: `synthetic history ${index}` }], timestamp: Date.now() } as any)
    }
  }
  if (options.history === "initial") seedHistory()
  const model = { id: "synthetic-chat", name: "Synthetic", api: options.api ?? "openai-completions", provider: "synthetic-provider",
    baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"],
    contextWindow: 65_536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  const modelRegistry = { hasConfiguredAuth: vi.fn(() => true), getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "synthetic-not-a-secret" })),
    getAll: () => [], getAvailable: () => [model], find: () => model, isUsingOAuth: () => false }
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>()
  const on = (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, [...handlers.get(event) ?? [], handler])
  let preparedHistory: (() => unknown) | null = null
  let captureInput = () => {}
  let beforeAgent: () => unknown | Promise<unknown> = () => {
    if (options.history === "after") preparedHistory ??= operations.bind(seedHistory)
    captureInput()
  }
  let beforeProvider = (_ctx: any) => {}
  let beforeCompact = (_event: any, _ctx: any): unknown => undefined
  let beforeTree = (_event: any, _ctx: any): unknown => undefined
  let command = async () => {}
  let toolEffect = () => {}
  const execute = vi.fn(async () => { toolEffect(); return { content: [{ type: "text", text: "synthetic tool result" }], details: {} } })
  on("input", (event, ctx) => operations.input(event, ctx))
  on("before_agent_start", async () => { await beforeAgent() })
  on("before_provider_request", (_event, ctx) => { beforeProvider(ctx) })
  on("session_before_compact", (event, ctx) => beforeCompact(event, ctx))
  on("session_before_tree", (event, ctx) => beforeTree(event, ctx))
  installPiRequestGuards({ pi: { on }, gate, referenceFor: () => options.bind === false ? null : operations.referenceFor() })
  const extension = { path: "fixture:actual-agent", handlers, tools: new Map(), commands: new Map([
    ["fixture-cmd", { name: "fixture-cmd", description: "Synthetic command", handler: () => command() }],
  ]), flags: new Map(),
    shortcuts: new Map(), messageRenderers: new Map() }
  const { session } = await createAgentSession({ cwd: "/fixture", agentDir: "/fixture-unused", model,
    thinkingLevel: "off", ...(options.tool ? { tools: ["synthetic_tool"], customTools: [{
      name: "synthetic_tool", label: "Synthetic", description: "Inert fixture counter", parameters: Type.Object({}), execute,
    }] } : { noTools: "all" }), authStorage: AuthStorage.inMemory(), modelRegistry,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: options.autoCompact ?? false, reserveTokens: 1024, keepRecentTokens: 1 },
      retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: options.retryDelayMs ?? 5, provider: { maxRetries: 0 } } }), sessionManager,
    resourceLoader: { getExtensions: () => ({ extensions: [extension], runtime: createExtensionRuntime() }),
      getSystemPrompt: () => "Synthetic fixture", getAppendSystemPrompt: () => [],
      getSkills: () => ({ skills: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getPrompts: () => ({ prompts: [
        { name: "fixture", description: "Synthetic", content: "expanded synthetic $1", source: "fixture", filePath: "/fixture-unused" },
      ] }) },
  } as any)
  cleanup.push(async () => { await session.abort(); session.dispose() })
  operations.install({ session, gate })
  cleanup.push(() => operations.close())
  session.extensionRunner!.setUIContext({ notify: vi.fn(), setStatus: vi.fn() } as any)
  gate.enable()
  return { ...f, gate, operations, session, sessionManager, modelRegistry, requests, sockets, onPark, execute,
    seedHistory: () => {
      if (!preparedHistory) throw new Error("Synthetic history has no captured owner")
      return preparedHistory()
    },
    setBeforeAgent: (callback: typeof beforeAgent) => { beforeAgent = callback },
    setCaptureInput: (callback: typeof captureInput) => { captureInput = callback },
    setBeforeProvider: (callback: typeof beforeProvider) => { beforeProvider = callback },
    setBeforeCompact: (callback: typeof beforeCompact) => { beforeCompact = callback },
    setBeforeTree: (callback: typeof beforeTree) => { beforeTree = callback },
    setServe: (callback: typeof serve) => { serve = callback },
    setToolEffect: (callback: typeof toolEffect) => { toolEffect = callback },
    setCommand: (callback: typeof command) => { command = callback },
    prompt: (text = "synthetic input", streamingBehavior?: "steer" | "followUp") => session.prompt(text, { expandPromptTemplates: false, streamingBehavior }),
    compact: () => session.compact(),
  }
}

describe("real SDK Agent and primary provider approval boundaries", () => {
  function payloadWait() {
    const source = randomUUID()
    const api = `fixture-summary-${source}`
    const primary = getApiProvider("openai-completions")!
    let released!: () => void
    let arrived!: () => void
    let block = false
    const ready = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { released = resolve })
    const callbacks: any[] = []
    const stream = (model: any, context: any, options: any) => primary.streamSimple({ ...model, api: "openai-completions" }, context, {
      ...options,
      onPayload: async (payload: any, nativeModel: any) => {
        if (block) { block = false; callbacks.push(options?.onPayload); arrived(); await barrier }
        return await options?.onPayload?.(payload, nativeModel)
      },
    })
    registerApiProvider({ api, stream, streamSimple: stream } as any, source)
    cleanup.push(() => { released(); unregisterApiProviders(source) })
    return { api, ready, release: released, block: () => { block = true }, callbacks }
  }

  it.each([false, true])("parks actual SDK summary after payload wait before wire (automatic=%s)", async automatic => {
    const wait = payloadWait()
    const f = await agentFixture({ history: "after", api: wait.api })
    cleanup.push(wait.release) // Release task-owned provider waits before SDK drain, even on red.
    let summary!: () => Promise<unknown>
    if (automatic) f.setCaptureInput(() => {
      summary = f.operations.bind(() => (f.session as any)._runAutoCompaction("threshold", false))
    })
    await f.prompt()
    f.seedHistory()
    wait.block()
    // Bind the native automatic method to a genuine originating private request;
    // do not replace its compaction implementation or provider transport.
    const changed = automatic ? summary() : f.compact()
    const settled = changed.then(() => null, error => error)
    await wait.ready
    f.setLive(pending)
    wait.release()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(f.requests).toHaveLength(1)
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0)
    f.approve()
    expect(await settled).toBeNull()
    expect(f.requests).toHaveLength(2)
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
  })

  it("rechecks actual SDK compaction after HTTP completion before native append", async () => {
    const f = await agentFixture({ history: "after" })
    await f.prompt()
    f.seedHistory()
    f.setServe(() => {})
    const changed = f.compact()
    const settled = changed.then(() => null, error => error)
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 500 })
    f.setLive(pending)
    respond(f.sockets[1])
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0)
    f.approve()
    expect(await settled).toBeNull()
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1)
    expect(f.requests).toHaveLength(2)
  })

  it("guards actual SDK branch summary payload wait before inference and preserves current positive", async () => {
    const wait = payloadWait()
    const f = await agentFixture({ history: "after", api: wait.api })
    cleanup.push(wait.release)
    let navigate!: () => Promise<any>
    let target!: string
    f.setCaptureInput(() => {
      navigate = f.operations.bind(() => f.session.navigateTree(target, { summarize: true }))
    })
    await f.prompt()
    f.seedHistory()
    target = f.sessionManager.getEntries().find(entry => entry.type === "message")!.id
    wait.block()
    const beforeLeaf = f.sessionManager.getLeafId()
    const changed = navigate()
    const settled = changed.then(value => value, error => error)
    await wait.ready
    f.setLive(pending)
    wait.release()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(f.requests).toHaveLength(1)
    expect(f.sessionManager.getLeafId()).toBe(beforeLeaf)
    f.approve()
    expect(await settled).toMatchObject({ cancelled: false })
    expect(f.requests).toHaveLength(2)
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "branch_summary")).toHaveLength(1)
  })

  it("parks natural SDK automatic compaction after Agent completion before summary wire", async () => {
    const wait = payloadWait()
    const f = await agentFixture({ history: "initial", api: wait.api, autoCompact: true })
    cleanup.push(wait.release)
    let expected = 1
    f.setBeforeCompact(event => {
      const p = event.preparation
      expected = p.isSplitTurn && p.turnPrefixMessages.length && p.messagesToSummarize.length ? 2 : 1
    })
    f.setServe((_body, response, index) => {
      if (index === 1) { wait.block(); respond(response, "synthetic response", { prompt_tokens: 64_514, completion_tokens: 1, total_tokens: 64_515 }) }
      else respond(response)
    })
    const input = f.prompt()
    await wait.ready
    f.setLive(pending)
    wait.release()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(f.requests).toHaveLength(1)
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0)
    f.approve()
    await input
    await vi.waitFor(() => expect(f.sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1))
    expect(f.requests).toHaveLength(1 + expected)
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
  })

  it("cancels parked SDK summary and denies its late payload callback without clearing journal", async () => {
    const wait = payloadWait()
    const f = await agentFixture({ history: "after", api: wait.api })
    cleanup.push(wait.release)
    await f.prompt()
    f.seedHistory()
    wait.block()
    const changed = f.compact().then(() => null, error => error)
    await wait.ready
    f.setLive(pending)
    wait.release()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    await f.gate.cancel("dismissed")
    expect(await changed).toBeInstanceOf(Error)
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    f.approve()
    await expect(wait.callbacks[0]({ stream: true })).rejects.toThrow("Owned summary payload unavailable")
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual([])
    expect(getApiProviders().filter(provider => provider.api.startsWith("statewright-summary-"))).toEqual([])
  })

  it("rejects old SDK summary after a newer native configuration and keeps original API records", async () => {
    const wait = payloadWait()
    const f = await agentFixture({ history: "after", api: wait.api })
    cleanup.push(wait.release)
    const primary = getApiProvider("openai-completions")
    const originalApi = getApiProvider(wait.api)
    await f.prompt()
    f.seedHistory()
    wait.block()
    const changed = f.compact().then(() => null, error => error)
    await wait.ready
    await f.operations.configuration("synthetic newer native configuration", () => f.session.setSessionName("new owner"))
    wait.release()
    expect(await changed).toBeInstanceOf(Error)
    await expect(wait.callbacks[0]({ stream: true })).rejects.toThrow("Owned summary payload unavailable")
    expect(f.sessionManager.getSessionName()).toBe("new owner")
    expect(f.owner.record.request_epoch).toBe(2)
    expect(f.requests).toHaveLength(1)
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0)
    expect(f.session.model!.api).toBe(wait.api)
    expect(getApiProvider("openai-completions")).toBe(primary)
    expect(getApiProvider(wait.api)).toBe(originalApi)
    expect(getApiProviders().filter(provider => provider.api.startsWith("statewright-summary-"))).toEqual([])
  })

  it("preserves genuine current SDK summary HTTP failure without implicit client retries", async () => {
    const f = await agentFixture({ history: "after" })
    await f.prompt()
    f.seedHistory()
    const events: any[] = []
    f.session.subscribe(event => events.push(event))
    f.setServe((_body, response) => { response.writeHead(500, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { message: "synthetic summary failure" } })) })
    await expect(f.compact()).rejects.toThrow("synthetic summary failure")
    expect(f.requests).toHaveLength(2)
    expect(events.find(event => event.type === "compaction_end").errorMessage).toContain("synthetic summary failure")
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0)
    expect(getApiProviders().filter(provider => provider.api.startsWith("statewright-summary-"))).toEqual([])
  })

  it.each([false, true])("preserves explicit SDK compaction override or cancel (cancel=%s)", async cancel => {
    const f = await agentFixture({ history: "after" })
    await f.prompt()
    f.seedHistory()
    f.setBeforeCompact(event => cancel ? { cancel: true } : { compaction: {
      summary: "synthetic custom summary", firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore, details: { custom: true },
    } })
    if (cancel) await expect(f.compact()).rejects.toThrow("Compaction cancelled")
    else expect(await f.compact()).toMatchObject({ summary: "synthetic custom summary", details: { custom: true } })
    expect(f.requests).toHaveLength(1)
    expect(getApiProviders().filter(provider => provider.api.startsWith("statewright-summary-"))).toEqual([])
  })

  it("rechecks native branch summary after registry wait before inference and leaf mutation", async () => {
    const f = await agentFixture({ history: "after" })
    let target!: string
    let navigate!: () => Promise<any>
    f.setCaptureInput(() => { navigate = f.operations.bind(() => f.session.navigateTree(target, { summarize: true })) })
    await f.prompt()
    f.seedHistory()
    target = f.sessionManager.getEntries().find(entry => entry.type === "message")!.id
    let release!: () => void
    let arrived!: () => void
    const ready = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(release)
    f.modelRegistry.getApiKeyAndHeaders.mockImplementationOnce(async () => {
      arrived(); await barrier; return { ok: true, apiKey: "synthetic-not-a-secret" }
    })
    f.setServe(() => {})
    const leaf = f.sessionManager.getLeafId()
    const changed = navigate().then(value => value, error => error)
    await ready
    f.setLive(pending)
    release()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(f.requests).toHaveLength(1)
    f.approve()
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 500 })
    respond(f.sockets[1])
    expect(await changed).toMatchObject({ cancelled: false })
    expect(f.requests).toHaveLength(2)
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "branch_summary")).toHaveLength(1)
  })

  it("rechecks native branch summary after final HTTP before leaf mutation", async () => {
    const f = await agentFixture({ history: "after" })
    let target!: string
    let navigate!: () => Promise<any>
    f.setCaptureInput(() => { navigate = f.operations.bind(() => f.session.navigateTree(target, { summarize: true })) })
    await f.prompt()
    f.seedHistory()
    target = f.sessionManager.getEntries().find(entry => entry.type === "message")!.id
    f.setServe(() => {})
    const leaf = f.sessionManager.getLeafId()
    const changed = navigate().then(value => value, error => error)
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 500 })
    f.setLive(pending)
    respond(f.sockets[1])
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(f.sessionManager.getLeafId()).toBe(leaf)
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "branch_summary")).toHaveLength(0)
    f.approve()
    expect(await changed).toMatchObject({ cancelled: false })
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "branch_summary")).toHaveLength(1)
  })

  it("fails closed on changed native summary event rather than falling back to raw SDK inference", async () => {
    const f = await agentFixture({ history: "after" })
    await f.prompt()
    f.seedHistory()
    f.setBeforeCompact(event => { event.type = "session_before_tree" })
    await expect(f.compact()).rejects.toThrow("Owned summary event changed")
    expect(f.requests).toHaveLength(1)
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0)
    expect(getApiProviders().filter(provider => provider.api.startsWith("statewright-summary-"))).toEqual([])
  })

  it.each([false, true])("preserves supported tree summary override or cancel with detached preparation (cancel=%s)", async cancel => {
    const f = await agentFixture({ history: "after" })
    let target!: string
    let navigate!: () => Promise<any>
    f.setCaptureInput(() => { navigate = f.operations.bind(() => f.session.navigateTree(target, { summarize: true })) })
    await f.prompt()
    f.seedHistory()
    target = f.sessionManager.getEntries().find(entry => entry.type === "message")!.id
    const leaf = f.sessionManager.getLeafId()
    f.setBeforeTree(() => cancel ? { cancel: true } : {
      summary: { summary: "synthetic custom branch", details: { custom: true } }, label: "synthetic branch label",
    })
    const result = await navigate()
    expect(result.cancelled).toBe(cancel)
    if (cancel) {
      expect(f.sessionManager.getLeafId()).toBe(leaf)
      expect(f.sessionManager.getEntries().filter(entry => entry.type === "branch_summary")).toHaveLength(0)
    } else {
      expect(result.summaryEntry).toMatchObject({ summary: "synthetic custom branch", details: { custom: true }, fromHook: true })
      expect(f.sessionManager.getLabel(result.summaryEntry.id)).toBe("synthetic branch label")
    }
    expect(f.requests).toHaveLength(1)
    expect(getApiProviders().filter(provider => provider.api.startsWith("statewright-summary-"))).toEqual([])
  })

  it("preserves supported tree instruction and label result overrides in default SDK summary", async () => {
    const f = await agentFixture({ history: "after" })
    let target!: string
    let navigate!: () => Promise<any>
    f.setCaptureInput(() => { navigate = f.operations.bind(() => f.session.navigateTree(target, { summarize: true })) })
    await f.prompt()
    f.seedHistory()
    target = f.sessionManager.getEntries().find(entry => entry.type === "message")!.id
    f.setBeforeTree(() => ({ customInstructions: "synthetic replacement summary instruction", replaceInstructions: true,
      label: "synthetic default label" }))
    const result = await navigate()
    expect(result).toMatchObject({ cancelled: false, summaryEntry: { fromHook: true } })
    expect(f.requests).toHaveLength(2)
    expect(JSON.stringify(f.requests[1].messages)).toContain("synthetic replacement summary instruction")
    expect(f.sessionManager.getLabel(result.summaryEntry.id)).toBe("synthetic default label")
    expect(getApiProviders().filter(provider => provider.api.startsWith("statewright-summary-"))).toEqual([])
  })

  it.each(["same-array", "replacement-array", "replacement-preparation"])("rejects mutated empty branch preparation before raw SDK fallback (%s)", async mutation => {
    const f = await agentFixture({ history: "after" })
    let ancestor!: string
    let target!: string
    let rewind!: () => void
    let navigate!: () => Promise<any>
    f.setCaptureInput(() => {
      rewind = f.operations.bind(() => f.sessionManager.branch(ancestor))
      navigate = f.operations.bind(() => f.session.navigateTree(target, { summarize: true }))
    })
    await f.prompt()
    ancestor = f.sessionManager.getLeafId()!
    f.seedHistory()
    target = f.sessionManager.getLeafId()!
    rewind()
    f.setBeforeTree(event => {
      expect(event.preparation.entriesToSummarize).toHaveLength(0)
      const clean = structuredClone(event.preparation)
      event.preparation.entriesToSummarize.push(f.sessionManager.getEntry(ancestor))
      if (mutation === "replacement-array") event.preparation.entriesToSummarize = clean.entriesToSummarize
      if (mutation === "replacement-preparation") event.preparation = clean
    })
    await expect(navigate()).rejects.toThrow("Owned summary preparation changed")
    expect(f.requests).toHaveLength(1)
    expect(f.sessionManager.getLeafId()).toBe(ancestor)
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "branch_summary")).toHaveLength(0)
    expect(getApiProviders().filter(provider => provider.api.startsWith("statewright-summary-"))).toEqual([])
  })

  it("captures tree options before awaiting hooks so later mutation cannot activate raw summary fallback", async () => {
    const f = await agentFixture({ history: "after" })
    let target!: string
    let navigate!: () => Promise<any>
    const options = { summarize: false }
    f.setCaptureInput(() => { navigate = f.operations.bind(() => f.session.navigateTree(target, options)) })
    await f.prompt()
    f.seedHistory()
    target = f.sessionManager.getEntries().find(entry => entry.type === "message")!.id
    let release!: () => void
    let arrived!: () => void
    const ready = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(release)
    f.setBeforeTree(async event => {
      expect(event.preparation.userWantsSummary).toBe(false)
      expect(event.preparation.entriesToSummarize.length).toBeGreaterThan(0)
      arrived(); await barrier
    })
    const changed = navigate().then(value => value, error => error)
    await ready
    options.summarize = true
    release()
    expect(await changed).toMatchObject({ cancelled: false })
    expect(f.requests).toHaveLength(1)
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "branch_summary")).toHaveLength(0)
    expect(getApiProviders().filter(provider => provider.api.startsWith("statewright-summary-"))).toEqual([])
  })

  it.each(["hook-view", "native-retained"])("prevents retained branch array mutation between aggregate validation and SDK consumption (%s)", async mutation => {
    const f = await agentFixture({ history: "after" })
    let ancestor!: string
    let target!: string
    let rewind!: () => void
    let navigate!: () => Promise<any>
    let preparation: any
    let nativePreparation: any
    let mutationError: unknown
    let queued = false
    f.setCaptureInput(() => {
      rewind = f.operations.bind(() => f.sessionManager.branch(ancestor))
      navigate = f.operations.bind(() => f.session.navigateTree(target, { summarize: true }))
    })
    await f.prompt()
    ancestor = f.sessionManager.getLeafId()!
    f.seedHistory()
    target = f.sessionManager.getLeafId()!
    rewind()
    const emit = f.session.extensionRunner!.emit.bind(f.session.extensionRunner)
    vi.spyOn(f.session.extensionRunner!, "emit").mockImplementation((event: any) => {
      if (event.type === "session_before_tree") nativePreparation = event.preparation
      return emit(event)
    })
    f.setBeforeTree(event => {
      expect(event.preparation.entriesToSummarize).toHaveLength(0)
      preparation = event.preparation
      expect(preparation).not.toBe(nativePreparation)
      expect(preparation.entriesToSummarize).not.toBe(nativePreparation.entriesToSummarize)
      expect(Object.isFrozen(nativePreparation.entriesToSummarize)).toBe(true)
    })
    const dispatch = f.operations.dispatch.bind(f.operations)
    vi.spyOn(f.operations, "dispatch").mockImplementation((effect: any, options: any) => dispatch(effect, options).then(value => {
      if (preparation && !queued) {
        queued = true
        queueMicrotask(() => queueMicrotask(() => {
          // A future immutable SDK input may reject mutation; observe that
          // denial without creating an unrelated unhandled microtask error.
          const entries = (mutation === "native-retained" ? nativePreparation : preparation).entriesToSummarize
          try { entries.push(f.sessionManager.getEntry(ancestor)) } catch (error) { mutationError = error }
        }))
      }
      return value
    }))
    expect(await navigate()).toMatchObject({ cancelled: false })
    expect(queued).toBe(true)
    if (mutation === "native-retained") expect(mutationError).toBeInstanceOf(TypeError)
    else expect(preparation.entriesToSummarize).toHaveLength(1)
    expect(nativePreparation.entriesToSummarize).toHaveLength(0)
    expect(Object.isFrozen(f.sessionManager.getEntry(ancestor))).toBe(false)
    expect(f.requests).toHaveLength(1)
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "branch_summary")).toHaveLength(0)
    expect(getApiProviders().filter(provider => provider.api.startsWith("statewright-summary-"))).toEqual([])
  })

  it("denies completed summary callback even from its original private request", async () => {
    const wait = payloadWait()
    const f = await agentFixture({ history: "after", api: wait.api })
    cleanup.push(wait.release)
    let late!: () => Promise<unknown>
    f.setCaptureInput(() => { late = f.operations.bind(() => wait.callbacks[0]({ stream: true })) })
    await f.prompt()
    f.seedHistory()
    wait.block()
    const changed = f.compact()
    await wait.ready
    wait.release()
    await changed
    await expect(late()).rejects.toThrow("Owned summary payload unavailable")
    expect(f.owner.record.request.phase).toBe("active")
    expect(f.requests).toHaveLength(2)
  })

  it("correlates template-expanded input without relying on message text", async () => {
    const f = await agentFixture()
    await f.session.prompt("/fixture argument")
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].messages.at(-1).content).toEqual([{ type: "text", text: "expanded synthetic argument" }])
    expect(f.owner.record.request_epoch).toBe(1)
  })

  it.each(["interactive", "rpc"] as const)("never lets an older template input supersede newer %s input before the SDK input hook", async source => {
    const f = await agentFixture()
    const old = f.session.prompt("/fixture old argument")
    const replacement = f.session.prompt("newer explicit input", { source })
    await Promise.all([old, replacement])
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].messages.at(-1).content).toEqual([{ type: "text", text: "newer explicit input" }])
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.owner.record.request.phase).toBe("active")
  })

  it("never lets an overlapping same-text pre-start prompt borrow the replacement epoch", async () => {
    const f = await agentFixture()
    let arrived!: () => void
    let release!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(release)
    let first = true
    f.setBeforeAgent(async () => { if (first) { first = false; arrived(); await barrier } })
    const old = f.prompt("same input")
    await arrival
    try {
      await f.prompt("same input")
      expect(f.requests).toHaveLength(1)
    } finally { release(); await old }
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request_epoch).toBe(2)
  })

  it("cannot turn an unbound extension follow-up into explicit human input", async () => {
    const f = await agentFixture()
    await f.session.sendUserMessage("unbound extension input", { deliverAs: "followUp" })
    expect(f.requests).toHaveLength(0)
    expect(f.owner.record.request_epoch).toBe(0)
  })

  it("completes the real SDK agent loop through inert primary-provider HTTP", async () => {
    const f = await agentFixture()
    await f.prompt()
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].messages.at(-1).content).toEqual([{ type: "text", text: "synthetic input" }])
    expect(f.session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" })
  })

  it("parks before primary HTTP dispatch, then consumes the same input's release once", async () => {
    const f = await agentFixture()
    f.setBeforeProvider(() => f.setLive(pending))
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

  it("binds RPC input privately and returns defensive reference copies", async () => {
    const f = await agentFixture()
    f.setBeforeAgent(() => {
      const reference = f.operations.referenceFor()!
      expect(Object.isFrozen(reference)).toBe(true)
      expect(() => { reference.request_id = "foreign" }).toThrow()
    })
    await f.session.prompt("synthetic RPC input", { source: "rpc" })
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.owner.record.request.phase).toBe("active")
    expect(f.gate.reference!.request_id).not.toBe("foreign")
    expect(() => f.operations.admit(f.gate.reference)).toThrow("Private explicit-input call unavailable")
    expect(() => f.operations.bind(() => {})).toThrow("Private inherited call unavailable")
  })

  it("native preflight cancellation prevents primary HTTP even though SDK hooks swallow errors", async () => {
    const f = await agentFixture()
    f.setBeforeProvider(() => f.setLive(pending))
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
      if (result && f.session.isStreaming) f.sessionManager.newSession()
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

  it.each(["cancel", "replacement"])("settles old SDK retry sleep before a native %s can leave stale retry work", async action => {
    const f = await agentFixture({ retry: true, retryDelayMs: 60 })
    let arrived!: () => void
    const ready = new Promise<void>(resolve => { arrived = resolve })
    f.session.subscribe(event => { if (event.type === "auto_retry_start") arrived() })
    f.setServe((_body, response, index) => {
      if (index !== 1) return // Hold replacement response, not an artificial old retry.
      response.writeHead(503, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "Synthetic 503 overload" } }))
    })
    let settled = false
    const old = f.prompt("old native input").then(() => { settled = true }, () => { settled = true })
    await ready
    expect(f.session.isRetrying).toBe(true)
    let replacement: Promise<void> | undefined
    if (action === "cancel") await f.operations.cancelInput()
    else {
      replacement = f.prompt("replacement native input")
      await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 500 })
    }
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 300 })
    expect(f.session.isRetrying).toBe(false)
    expect(f.session.retryAttempt).toBe(0)
    if (replacement) {
      respond(f.sockets[1])
      await replacement
      expect(f.owner.record.request_epoch).toBe(2)
    }
    await old
    expect(f.requests).toHaveLength(action === "cancel" ? 1 : 2)
  })

  it("holds native retry events and error persistence while approval is pending", async () => {
    const f = await agentFixture({ retry: true })
    const events: any[] = []
    f.session.subscribe(event => { events.push(event) })
    f.setServe((_body, response, index) => {
      if (index !== 1) { respond(response); return }
      f.setLive(pending)
      response.writeHead(503, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "Synthetic 503 overload" } }))
    })
    const input = f.prompt()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(0)
    expect(f.session.retryAttempt).toBe(0)
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "assistant")).toHaveLength(0)
    expect(f.requests).toHaveLength(1)
    f.approve()
    await input
    expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(1)
    expect(f.requests).toHaveLength(2)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
  })

  it("denies an old private abortRetry callback against a newer natural native retry", async () => {
    const f = await agentFixture({ retry: true, retryDelayMs: 80 })
    let oldAbort!: () => unknown
    f.setBeforeAgent(() => { oldAbort ??= f.operations.bind(() => f.session.abortRetry()) })
    await f.prompt("old completed input")
    let arrived!: () => void
    const ready = new Promise<void>(resolve => { arrived = resolve })
    f.session.subscribe(event => { if (event.type === "auto_retry_start") arrived() })
    f.setServe((_body, response, index) => {
      if (index !== 2) { respond(response); return }
      response.writeHead(503, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "Synthetic 503 overload" } }))
    })
    const current = f.prompt("new native input")
    await ready
    expect(f.session.isRetrying).toBe(true)
    oldAbort()
    expect(f.session.isRetrying).toBe(true)
    await current
    expect(f.requests).toHaveLength(3)
    expect(f.owner.record.request_epoch).toBe(2)
    expect(f.session.retryAttempt).toBe(0)
  })

  it("blocks native retry consumption after the final aggregate return microtask", async () => {
    const f = await agentFixture({ retry: true })
    const native = new AsyncResource("fixture-native-cancellation")
    cleanup.push(() => { native.emitDestroy() })
    let cancelled: Promise<void> | undefined
    const emit = f.session.extensionRunner!.emit.bind(f.session.extensionRunner)
    f.session.extensionRunner!.emit = async event => {
      const result = await emit(event)
      if (event.type === "agent_end") queueMicrotask(() => {
        cancelled = native.runInAsyncScope(() => f.operations.cancelInput())
      })
      return result
    }
    const events: any[] = []
    f.session.subscribe(event => { events.push(event) })
    f.setServe((_body, response) => {
      response.writeHead(503, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "Synthetic 503 overload" } }))
    })
    await f.prompt()
    expect(cancelled).toBeDefined()
    await cancelled
    expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(0)
    expect(f.requests).toHaveLength(1)
    expect(f.session.isRetrying).toBe(false)
    expect(f.session.retryAttempt).toBe(0)
  })

  it("preserves native retry exhaustion and final error events", async () => {
    const f = await agentFixture({ retry: true })
    const events: any[] = []
    f.session.subscribe(event => { events.push(event) })
    f.setServe((_body, response) => {
      response.writeHead(503, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "Synthetic 503 overload" } }))
    })
    await f.prompt()
    expect(f.requests).toHaveLength(2)
    expect(events.filter(event => event.type === "auto_retry_start")).toHaveLength(1)
    expect(events.filter(event => event.type === "auto_retry_end")).toEqual([
      expect.objectContaining({ success: false, attempt: 1, finalError: expect.stringContaining("503") }),
    ])
    expect(f.session.isRetrying).toBe(false)
    expect(f.session.retryAttempt).toBe(0)
  })

  it.each(["cancel", "replacement"])("settles reentrant native %s from retry-start without leaving old attempts", async action => {
    const f = await agentFixture({ retry: true, retryDelayMs: 60 })
    const native = new AsyncResource("fixture-native-retry-start-input")
    cleanup.push(() => { native.emitDestroy() })
    let control: Promise<void> | undefined
    let first = true
    f.session.subscribe(event => {
      if (event.type !== "auto_retry_start" || !first) return
      first = false
      control = native.runInAsyncScope(() => action === "cancel" ? f.operations.cancelInput() : f.prompt("replacement from retry-start"))
      control!.catch(() => {})
    })
    f.setServe((_body, response, index) => {
      if (index !== 1) return // Keep replacement response held until old cleanup is proved.
      response.writeHead(503, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "Synthetic 503 overload" } }))
    })
    await f.prompt("old reentrant input")
    expect(control).toBeDefined()
    if (action === "replacement") await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 500 })
    else await control
    expect(f.session.retryAttempt).toBe(0)
    expect(f.session.isRetrying).toBe(false)
    if (action === "replacement") { respond(f.sockets[1]); await control }
    expect(f.requests).toHaveLength(action === "cancel" ? 1 : 2)
  })

  it("reports retry-start observer failure without corrupting native retry cleanup", async () => {
    const f = await agentFixture({ retry: true })
    const errors = vi.fn()
    const unsubscribe = f.session.extensionRunner!.onError(errors)
    cleanup.push(unsubscribe)
    f.session.subscribe(event => { if (event.type === "auto_retry_start") throw new Error("synthetic observer failure") })
    f.setServe((_body, response, index) => {
      if (index !== 1) { respond(response); return }
      response.writeHead(503, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "Synthetic 503 overload" } }))
    })
    await f.prompt()
    expect(f.requests).toHaveLength(2)
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ event: "auto_retry_start", error: "synthetic observer failure" }))
    expect(f.session.retryAttempt).toBe(0)
    expect(f.session.isRetrying).toBe(false)
  })

  it("guards actual SDK manual compaction before its separate provider path", async () => {
    const f = await agentFixture({ history: "after" })
    await f.prompt()
    f.seedHistory()
    // Public initial session entries supply real compaction preparation. No
    // _checkCompaction/compact/provider implementation is mocked.
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
    const f = await agentFixture({ history: "after" })
    await f.prompt()
    f.seedHistory()
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

  it("inherits an actual SDK follow-up without minting another human input epoch", async () => {
    const f = await agentFixture()
    let follow!: () => Promise<void>
    f.setBeforeAgent(() => { follow ??= f.operations.bind(() => f.session.sendUserMessage("inherited follow-up", { deliverAs: "followUp" })) })
    await f.prompt()
    await follow()
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1].messages.at(-1).content).toEqual([{ type: "text", text: "inherited follow-up" }])
    expect(f.owner.record.request_epoch).toBe(1)
  })

  it("holds a delayed inherited follow-up and native continue after replacement", async () => {
    const f = await agentFixture()
    let follow!: () => Promise<void>
    let retry!: () => Promise<void>
    let forged!: () => Promise<void>
    f.setBeforeAgent(() => {
      follow ??= f.operations.bind(() => f.session.sendUserMessage("stale follow-up", { deliverAs: "followUp" }))
      retry ??= f.operations.bind(() => f.session.agent.continue())
      forged ??= f.operations.bind(() => f.session.prompt("stale pretend human input", { source: "interactive" }))
    })
    const started = vi.fn()
    f.session.agent.subscribe(event => { if (event.type === "agent_start") started() })
    await f.prompt("old input")
    await f.prompt("replacement input")
    await follow()
    await retry()
    await forged()
    expect(f.requests).toHaveLength(2)
    expect(started).toHaveBeenCalledTimes(2)
    expect(f.session.pendingMessageCount).toBe(0)
    expect(f.owner.record.request_epoch).toBe(2)
    expect(f.owner.record.request.phase).toBe("active")
  })

  it("inherits real SDK threshold compaction's separate provider path", async () => {
    const f = await agentFixture({ history: "initial" })
    f.session.setAutoCompactionEnabled(true)
    const ended: any[] = []
    f.session.subscribe(event => { if (event.type === "compaction_end") ended.push(event) })
    f.setServe((_body, response, index) => {
      if (index === 1) { f.setLive(pending); respond(response, "synthetic response", { prompt_tokens: 65_000, completion_tokens: 1, total_tokens: 65_001 }) }
      else respond(response)
    })
    const input = f.prompt()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    // Final response itself is now held before persistence/automatic compaction.
    expect(f.session.isCompacting).toBe(false)
    expect(f.sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "assistant")).toHaveLength(0)
    expect(f.requests).toHaveLength(1)
    f.approve()
    await input
    await vi.waitFor(() => expect(ended).toHaveLength(1), { timeout: 2_000, interval: 5 })
    expect(ended[0]).toMatchObject({ reason: "threshold", aborted: false, willRetry: false })
    expect(ended[0].result.summary).toBe("synthetic response\n\n---\n\n**Turn Context (split turn):**\n\nsynthetic response")
    // Actual SDK split-turn compaction makes summary + turn-prefix calls.
    expect(f.requests).toHaveLength(3)
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
  })

  it.each(["steer", "followUp"] as const)("replacement removes an inherited %s queue before old agent completion", async deliverAs => {
    const f = await agentFixture()
    let follow!: () => Promise<void>
    f.setBeforeAgent(() => { follow ??= f.operations.bind(() => f.session.sendUserMessage("stale queued input", { deliverAs })) })
    f.setServe((_body, response, index) => {
      if (index !== 1) { respond(response); return }
      response.writeHead(200, { "Content-Type": "text/event-stream" }); response.flushHeaders()
    })
    const old = f.prompt("old input")
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 2_000, interval: 5 })
    await follow()
    expect(f.session.pendingMessageCount).toBe(1)
    expect(f.owner.record.request_epoch).toBe(1)
    const signal = f.session.agent.signal!
    await f.prompt("replacement input", "followUp")
    await old
    expect(signal.aborted).toBe(true)
    expect(f.requests).toHaveLength(2)
    expect(f.requests[1].messages.at(-1).content).toEqual([{ type: "text", text: "replacement input" }])
    expect(JSON.stringify(f.requests[1])).not.toContain("stale queued input")
    expect(f.session.pendingMessageCount).toBe(0)
    expect(f.owner.record.request_epoch).toBe(2)
  })

  it("cannot let an unbound overlapping SDK command borrow manual compaction authority", async () => {
    const f = await agentFixture()
    await f.prompt("old input")
    let arrived!: () => void
    let release!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(release)
    let failure: unknown = null
    f.setCommand(async () => { arrived(); await barrier; try { await f.session.compact() } catch (error) { failure = error } })
    const command = f.session.prompt("/fixture-cmd")
    await arrival
    try { await f.prompt("replacement input") } finally { release(); await command }
    expect(failure).toMatchObject({ message: "Owned compaction request unavailable" })
    expect(f.requests).toHaveLength(2)
    expect(f.owner.record.request_epoch).toBe(2)
    expect(f.owner.record.request.phase).toBe("active")
  })

  it("command-only explicit input interrupts the actual old owned Agent before any input hook", async () => {
    const f = await agentFixture()
    f.setServe((_body, response) => { response.writeHead(200, { "Content-Type": "text/event-stream" }); response.flushHeaders() })
    const handled = vi.fn(async () => {})
    f.setCommand(handled)
    const old = f.prompt("old input")
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 2_000, interval: 5 })
    const signal = f.session.agent.signal!
    await f.session.prompt("/fixture-cmd")
    await old
    expect(handled).toHaveBeenCalledTimes(1)
    expect(signal.aborted).toBe(true)
    expect(f.session.isStreaming).toBe(false)
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request_epoch).toBe(1)
    await vi.waitFor(() => {
      expect(f.owner.record.request.phase).toBe("cancelled")
      expect(f.owner.record.request.reason).toBe("superseded")
    }, { timeout: 2_000, interval: 5 })
  })

  it("never aborts a now-foreign Agent after a synchronous queue listener changes native identity", async () => {
    const f = await agentFixture()
    f.setServe((_body, response) => { response.writeHead(200, { "Content-Type": "text/event-stream" }); response.flushHeaders() })
    const old = f.prompt("old input")
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 2_000, interval: 5 })
    const signal = f.session.agent.signal!
    const abort = vi.spyOn(f.session.agent, "abort")
    const unsubscribe = f.session.subscribe(event => {
      if (event.type === "queue_update") f.sessionManager.newSession()
    })
    try {
      await f.session.prompt("/fixture-cmd")
      expect(abort).not.toHaveBeenCalled()
      expect(signal.aborted).toBe(false)
      expect(f.requests).toHaveLength(1)
    } finally {
      unsubscribe()
      f.sockets[0].end("data: [DONE]\n\n")
      await old
    }
  })

  it("delivers private next-turn asides only to an inherited originating request", async () => {
    const f = await agentFixture()
    let aside!: () => Promise<void>
    let follow!: () => Promise<void>
    f.setBeforeAgent(() => {
      aside ??= f.operations.bind(() => f.session.sendCustomMessage({ customType: "fixture-aside", content: "owned private aside", display: false }, { deliverAs: "nextTurn" }))
      follow ??= f.operations.bind(() => f.session.sendUserMessage("inherited follow-up", { deliverAs: "followUp" }))
    })
    await f.prompt()
    await aside()
    expect(f.requests).toHaveLength(1)
    await follow()
    expect(f.requests).toHaveLength(2)
    expect(JSON.stringify(f.requests[1])).toContain("owned private aside")
    expect(f.owner.record.request_epoch).toBe(1)
  })

  it("never transfers old private next-turn asides into replacement input", async () => {
    const f = await agentFixture()
    let aside!: () => Promise<void>
    f.setBeforeAgent(() => { aside ??= f.operations.bind(() => f.session.sendCustomMessage({ customType: "fixture-aside", content: "stale private aside", display: false }, { deliverAs: "nextTurn" })) })
    await f.prompt("old input")
    await aside()
    await f.prompt("replacement input")
    expect(f.requests).toHaveLength(2)
    expect(JSON.stringify(f.requests[1])).not.toContain("stale private aside")
    expect(f.owner.record.request_epoch).toBe(2)
  })

  it("owned close aborts the actual streaming Agent and holds late inherited work", async () => {
    const f = await agentFixture()
    let follow!: () => Promise<void>
    f.setBeforeAgent(() => { follow ??= f.operations.bind(() => f.session.sendUserMessage("late closed input", { deliverAs: "followUp" })) })
    f.setServe((_body, response) => { response.writeHead(200, { "Content-Type": "text/event-stream" }); response.flushHeaders() })
    const input = f.prompt()
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 2_000, interval: 5 })
    const signal = f.session.agent.signal!
    await f.operations.close()
    await input
    await follow()
    await f.prompt("after close")
    expect(signal.aborted).toBe(true)
    expect(f.session.isStreaming).toBe(false)
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request.reason).toBe("disconnected")
  })

  it("never aborts a foreign native session on carrier close", async () => {
    const f = await agentFixture()
    await f.prompt()
    const abort = vi.spyOn(f.session.agent, "abort")
    f.sessionManager.newSession()
    await f.operations.close()
    await f.prompt("foreign closed input")
    expect(abort).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request.reason).toBe("disconnected")
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
