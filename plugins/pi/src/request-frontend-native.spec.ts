import { createServer } from "node:http"
import { EventEmitter } from "node:events"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthStorage, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent"
import { createPiRequestFrontend } from "./request-frontend.mjs"
import { createPiNativeReadinessPublisher } from "./request-readiness.mjs"
import { createExecutorNativeReadiness } from "../../executor/lib/executor-native-readiness.mjs"
import { AdapterBridge } from "../../executor/lib/adapter-bridge.mjs"
import { fixture, pending } from "../../executor/tests/fixtures/owned-request.mjs"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })

// Public SDK services/runtime and actual Agent; task-owned HTTP returns inert
// SSE. Parent authority is synthetic, owner/journal/bridge are real local code.
async function frontendFixture(options: { parked?: boolean; streaming?: boolean; register?: (...args: any[]) => unknown;
  onReady?: (...args: any[]) => unknown; handshake?: boolean; acknowledgement?: (value: any) => any } = {}) {
  const f = await fixture({ after: (fn: () => unknown) => cleanup.push(fn) }, { ...options, nativeFile: options.handshake })
  const requests: any[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    if (options.streaming) { response.flushHeaders(); return }
    const chunk = (delta: unknown, finish_reason: string | null) => JSON.stringify({
      id: "synthetic", object: "chat.completion.chunk", model: "synthetic-chat",
      choices: [{ index: 0, delta, finish_reason }],
    })
    response.end(`data: ${chunk({ role: "assistant", content: "synthetic response" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const nativeReadiness = options.handshake ? createExecutorNativeReadiness({ owner: f.owner, requestController: f.controller }) : null
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, killed: false })
  nativeReadiness?.bindChild(child)
  const bridge = await new AdapterBridge({ call: async (name: string) => {
    if (name !== "statewright_get_state") throw new Error("Unexpected fixture effect")
    return f.getState()
  } }, { host: "pi", sessionOwner: f.owner, requestController: f.controller, nativeReadiness }).start()
  cleanup.push(() => bridge.close())
  const call = async (action: string, body: unknown, signal?: AbortSignal) => {
    const response = await fetch(`${bridge.url}/hooks/request/${action}`, {
      method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal,
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    return action === "ready" && options.acknowledgement ? options.acknowledgement(result) : result
  }
  const cwd = options.handshake ? f.owner.record.scope.cwd : dirname(f.owner.path)
  const sessionManager = options.handshake ? SessionManager.open(f.owner.record.host_session_file, f.owner.nativeRoot, cwd) : SessionManager.inMemory(cwd)
  if (!options.handshake) sessionManager.newSession({ id: f.owner.record.host_session_id })
  const model = { id: "synthetic-chat", name: "Synthetic", api: "openai-completions", provider: "synthetic-provider",
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, reasoning: false,
    input: ["text"], contextWindow: 65_536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  const modelRegistry = { hasConfiguredAuth: vi.fn(() => true), getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "synthetic-not-a-secret" })),
    getAll: () => [], find: () => model, isUsingOAuth: () => false }
  const onPark = vi.fn()
  const publish = nativeReadiness ? createPiNativeReadinessPublisher({ challenge: nativeReadiness.challenge, sessionManager, call }) : null
  const onReady = vi.fn(async (...args: any[]) => { await options.onReady?.(...args); if (publish) await publish(args[0]) })
  const args = { nativeSessionId: f.owner.record.host_session_id, call,
    target: { cwd, agentDir: join(cwd, "agent"), sessionManager },
    servicesOptions: { authStorage: AuthStorage.inMemory(), modelRegistry,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } } }) },
    resources: { noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, systemPrompt: "Synthetic fixture" },
    sessionOptions: { model, thinkingLevel: "off", noTools: "all" },
    gateOptions: { pollMs: 5, timeoutMs: 3_000, onPark }, register: options.register ?? (() => {}), onReady }
  const frontend = await createPiRequestFrontend(args)
  cleanup.push(() => frontend.close())
  return { ...f, frontend, args, requests, sessionManager, modelRegistry, onPark, onReady, nativeReadiness, child, bridge, publish,
    session: frontend.runtime.session,
    bind: () => frontend.runtime.session.bindExtensions({ uiContext: { notify: vi.fn(), setStatus: vi.fn() } }),
  }
}

describe("owning public SDK frontend readiness", () => {
  it("privately admits before project input and never lends current ownership outside its call", async () => {
    let ownership: any
    const observed: boolean[] = []
    const inherited: Array<() => boolean> = []
    const releaseProof: Array<() => boolean> = []
    const f = await frontendFixture({ parked: true, register: (pi, privateOwnership) => {
      ownership = privateOwnership
      pi.on("input", () => {
        observed.push(ownership.ownsCurrent())
        inherited.push(ownership.bind(() => ownership.ownsCurrent()))
        releaseProof.push(ownership.bind(() => ownership.hasConsumedApproval("approval")))
        expect(ownership.hasConsumedApproval("foreign-approval")).toBe(false)
        return ownership.ownsCurrent() ? { action: "continue" } : { action: "handled" }
      })
    } })
    expect(Object.isFrozen(ownership)).toBe(true)
    expect(ownership.ownsCurrent()).toBe(false)
    await f.bind()
    const input = f.session.prompt("parked project input")
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    expect(observed).toEqual([])
    expect(f.requests).toHaveLength(0)
    f.approve()
    await input
    expect(observed).toEqual([true])
    expect(f.requests).toHaveLength(1)
    expect(ownership.ownsCurrent()).toBe(false)
    expect(inherited[0]()).toBe(true)
    expect(releaseProof[0]()).toBe(true)
    expect(ownership.hasConsumedApproval("approval")).toBe(false)
    await f.session.prompt("new private input")
    expect(inherited[0]()).toBe(false)
    expect(inherited[1]()).toBe(true)
    expect(releaseProof[0]()).toBe(false)
    expect(releaseProof[1]()).toBe(false)
    await f.frontend.close()
    expect(inherited[1]()).toBe(false)
  })

  it("negotiates exact native file and fresh parent/child lifetimes before actual SDK delivery", async () => {
    const f = await frontendFixture({ handshake: true })
    expect(f.sessionManager.getSessionFile()).toBe(f.owner.record.host_session_file)
    await f.session.prompt("pre-handshake held input")
    expect(f.requests).toHaveLength(0)
    expect(f.nativeReadiness!.ready).toBe(false)
    await f.bind()
    expect(await f.bridge.waitForReady({ timeoutMs: 10 })).toBe(true)
    await f.session.prompt("private acknowledged input")
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request_epoch).toBe(1)
    await expect(f.publish!(f.frontend.readiness)).rejects.toThrow("ownership mismatch")
  })

  it("holds actual SDK input throughout private parent acknowledgement publication", async () => {
    let arrived!: () => void; let release!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    const f = await frontendFixture({ handshake: true, onReady: async () => { arrived(); await barrier } })
    const binding = f.bind()
    await arrival
    try {
      await f.session.prompt("private ack overlap")
      expect(f.nativeReadiness!.ready).toBe(false)
      expect(f.frontend.readiness).toBeNull()
      expect(f.owner.record.request_epoch).toBe(0)
      expect(f.modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled()
    } finally { release(); await binding }
    expect(f.nativeReadiness!.ready).toBe(true)
  })

  it("fails closed if the bound child exits during actual SDK startup", async () => {
    let f!: Awaited<ReturnType<typeof frontendFixture>>
    f = await frontendFixture({ handshake: true, register: pi => pi.on("session_start", () => f.child.emit("exit", 0)) })
    await expect(f.bind()).rejects.toThrow("readiness")
    await f.session.prompt("obsolete child input")
    expect(f.frontend.readiness).toBeNull()
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.requests).toHaveLength(0)
  })

  it("rejects a foreign private acknowledgement before actual SDK gate enable", async () => {
    const f = await frontendFixture({ handshake: true, acknowledgement: value => ({ ...value, child_lifetime_id: "foreign" }) })
    await expect(f.bind()).rejects.toThrow("acknowledgement")
    await f.session.prompt("forged private ack input")
    expect(f.frontend.readiness).toBeNull()
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.requests).toHaveLength(0)
  })

  it("rejects file drift before private publication and UUID-preserving descriptor substitution", async () => {
    const f = await frontendFixture({ handshake: true })
    vi.spyOn(f.sessionManager, "getSessionFile").mockReturnValue("/foreign/native.jsonl")
    await expect(f.bind()).rejects.toThrow("Owned SDK frontend unavailable")
    expect(f.nativeReadiness!.ready).toBe(false)
    expect(f.requests).toHaveLength(0)
    expect(f.owner.record.request_epoch).toBe(0)
  })

  it("rechecks exact native file after an awaited private acknowledgement", async () => {
    const f = await frontendFixture({ handshake: true, acknowledgement: value => {
      vi.spyOn(f.sessionManager, "getSessionFile").mockReturnValue("/foreign/late.jsonl")
      return value
    } })
    await expect(f.bind()).rejects.toThrow("acknowledgement")
    await f.session.prompt("late descriptor drift")
    expect(f.frontend.readiness).toBeNull()
    expect(f.requests).toHaveLength(0)
    expect(f.owner.record.request_epoch).toBe(0)
  })

  it("holds fresh input after parent lifetime close without creating a new epoch", async () => {
    const f = await frontendFixture({ handshake: true })
    await f.bind()
    await f.nativeReadiness!.close()
    await f.session.prompt("parent disconnected input")
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.requests).toHaveLength(0)
  })

  it("revokes native readiness monotonically after UUID-preserving file drift", async () => {
    const f = await frontendFixture({ handshake: true })
    await f.bind()
    const abort = vi.spyOn(f.session.agent, "abort")
    const file = vi.spyOn(f.sessionManager, "getSessionFile").mockReturnValue("/foreign/after-ready.jsonl")
    expect(f.frontend.readiness).toBeNull()
    await f.session.prompt("foreign file input")
    expect(abort).not.toHaveBeenCalled()
    expect(f.owner.record.request_epoch).toBe(0)
    file.mockRestore()
    await f.session.prompt("restored file must remain held")
    expect(f.frontend.readiness).toBeNull()
    expect(f.requests).toHaveLength(0)
  })

  it("denies actual primary HTTP after file drift during the provider auth await", async () => {
    const f = await frontendFixture({ handshake: true })
    await f.bind()
    const abort = vi.spyOn(f.session.agent, "abort")
    f.modelRegistry.getApiKeyAndHeaders.mockImplementation(async () => {
      vi.spyOn(f.sessionManager, "getSessionFile").mockReturnValue("/foreign/provider.jsonl")
      return { ok: true, apiKey: "synthetic-not-a-secret" }
    })
    await f.session.prompt("provider file drift")
    expect(f.requests).toHaveLength(0)
    expect(abort).not.toHaveBeenCalled()
    expect(f.frontend.readiness).toBeNull()
  })

  it("bounds private acknowledgement even when an injected transport ignores cancellation", async () => {
    const f = await frontendFixture({ handshake: true })
    let signal!: AbortSignal
    const publish = createPiNativeReadinessPublisher({ challenge: f.nativeReadiness!.challenge, sessionManager: f.sessionManager,
      timeoutMs: 10, call: (_action: string, _body: unknown, incoming: AbortSignal) => { signal = incoming; return new Promise(() => {}) } })
    await expect(publish({ schema: "statewright/pi-native-readiness/v1", native_session_id: f.owner.record.host_session_id }))
      .rejects.toThrow("timed out")
    expect(signal.aborted).toBe(true)
    await expect(publish({ schema: "statewright/pi-native-readiness/v1", native_session_id: f.owner.record.host_session_id }))
      .rejects.toThrow("ownership mismatch")
    expect(f.nativeReadiness!.ready).toBe(false)
  })

  it("holds actual SDK input until startup binding, then publishes exact native readiness", async () => {
    const f = await frontendFixture()
    expect(f.frontend.readiness).toBeNull()
    await f.session.prompt("before readiness")
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
    await f.bind()
    expect(f.frontend.readiness).toEqual({ schema: "statewright/pi-native-readiness/v1", native_session_id: f.owner.record.host_session_id })
    expect(Object.isFrozen(f.frontend.readiness)).toBe(true)
    expect(f.onReady).toHaveBeenCalledTimes(1)
    await f.session.prompt("owned explicit input")
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request_epoch).toBe(1)
  })

  it("keeps input held throughout an awaited session_start handler", async () => {
    let arrived!: () => void
    let release!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    const f = await frontendFixture({ register: pi => pi.on("session_start", async () => { arrived(); await barrier }) })
    const binding = f.bind()
    await arrival
    try {
      await f.session.prompt("startup overlap")
      expect(f.requests).toHaveLength(0)
      expect(f.owner.record.request_epoch).toBe(0)
      expect(f.onReady).not.toHaveBeenCalled()
    } finally { release(); await binding }
    await f.session.prompt("ready input")
    expect(f.requests).toHaveLength(1)
  })

  it("parks without HTTP through the owned frontend, then consumes synthetic approval once", async () => {
    const f = await frontendFixture({ parked: true })
    await f.bind()
    const input = f.session.prompt("parked input")
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    expect(f.requests).toHaveLength(0)
    expect(f.modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled()
    f.approve()
    await input
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
  })

  it("installs provider admission last after earlier trusted project hooks", async () => {
    let f!: Awaited<ReturnType<typeof frontendFixture>>
    let first = true
    f = await frontendFixture({ register: pi => pi.on("before_provider_request", (event: any) => {
      if (first) { first = false; f.setLive(pending) }
      return event.payload
    }) })
    await f.bind()
    const input = f.session.prompt("provider checkpoint input")
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    expect(f.requests).toHaveLength(0)
    f.approve()
    await input
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
  })

  it("refuses a late hook even when SDK catches the startup handler exception", async () => {
    const f = await frontendFixture({ register: pi => pi.on("session_start", () => {
      pi.on("before_provider_request", () => ({ unsafe: "replacement" }))
    }) })
    await expect(f.bind()).rejects.toThrow("Owned SDK frontend unavailable")
    await f.session.prompt("held after late hook")
    expect(f.frontend.readiness).toBeNull()
    expect(f.onReady).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
  })

  it("refuses readiness after a normal startup handler error swallowed by the SDK", async () => {
    const f = await frontendFixture({ register: pi => pi.on("session_start", () => {
      throw new Error("Synthetic startup failed")
    }) })
    await expect(f.bind()).rejects.toThrow("Owned SDK frontend unavailable")
    await f.session.prompt("unsafe startup input")
    expect(f.frontend.readiness).toBeNull()
    expect(f.onReady).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
  })

  it("rejects SDK-collected extension setup errors before constructing readiness", async () => {
    await expect(frontendFixture({ register: () => { throw new Error("Synthetic registration failed") } }))
      .rejects.toThrow("Owned SDK frontend unavailable")
  })

  it("rejects extension API mutation that would shadow final guard registration", async () => {
    let failure: unknown = null
    try { await frontendFixture({ register: pi => { pi.on = () => {} } }) }
    catch (error) { failure = error }
    expect(failure).toMatchObject({ message: "Owned SDK frontend unavailable" })
  })

  it("keeps input held while the private readiness publication callback awaits", async () => {
    let arrived!: () => void
    let release!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    const f = await frontendFixture({ onReady: async () => { arrived(); await barrier } })
    const binding = f.bind()
    await arrival
    try {
      await f.session.prompt("readiness overlap")
      expect(f.frontend.readiness).toBeNull()
      expect(f.requests).toHaveLength(0)
      expect(f.owner.record.request_epoch).toBe(0)
    } finally { release(); await binding }
    await f.session.prompt("after publication")
    expect(f.requests).toHaveLength(1)
  })

  it("requires awaited resource discovery before publishing readiness", async () => {
    let arrived!: () => void
    let release!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    const f = await frontendFixture({ register: pi => pi.on("resources_discover", async () => { arrived(); await barrier; return {} }) })
    const binding = f.bind()
    await arrival
    try {
      await f.session.prompt("resources overlap")
      expect(f.requests).toHaveLength(0)
      expect(f.onReady).not.toHaveBeenCalled()
    } finally { release(); await binding }
    await f.session.prompt("ready resources")
    expect(f.requests).toHaveLength(1)
  })

  it("holds after the private readiness publication fails", async () => {
    const f = await frontendFixture({ onReady: () => { throw new Error("Synthetic readiness unavailable") } })
    await expect(f.bind()).rejects.toThrow("Synthetic readiness unavailable")
    await f.session.prompt("failed publication")
    expect(f.frontend.readiness).toBeNull()
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.requests).toHaveLength(0)
  })

  it("denies a second UI binding without changing its established native ownership", async () => {
    const f = await frontendFixture()
    await f.bind()
    await expect(f.bind()).rejects.toThrow("Owned SDK frontend unavailable")
    expect(f.onReady).toHaveBeenCalledTimes(1)
    await f.session.prompt("original binding input")
    expect(f.requests).toHaveLength(1)
  })

  it("revokes readiness for a hook captured before sealing but invoked after readiness", async () => {
    let late!: (...args: any[]) => unknown
    const f = await frontendFixture({ register: pi => { late = pi.on } })
    await f.bind()
    await f.session.prompt("owned input")
    expect(() => late("before_provider_request", () => ({}))).toThrow("Managed hook registration is sealed")
    expect(f.frontend.readiness).toBeNull()
    await f.session.prompt("after violation")
    expect(f.requests).toHaveLength(1)
  })

  it("cannot enable readiness after close interrupts awaited startup", async () => {
    let arrived!: () => void
    let release!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    const f = await frontendFixture({ register: pi => pi.on("session_start", async () => { arrived(); await barrier }) })
    const binding = f.bind()
    const failed = expect(binding).rejects.toThrow("Owned SDK frontend unavailable")
    await arrival
    await f.frontend.close()
    release()
    await failed
    expect(f.frontend.readiness).toBeNull()
    expect(f.onReady).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
  })

  it("refuses native drift during the readiness callback", async () => {
    let f!: Awaited<ReturnType<typeof frontendFixture>>
    f = await frontendFixture({ onReady: () => { f.sessionManager.newSession() } })
    await expect(f.bind()).rejects.toThrow("Owned SDK frontend unavailable")
    await f.session.prompt("foreign input")
    expect(f.frontend.readiness).toBeNull()
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.requests).toHaveLength(0)
  })

  it("revokes readiness after observed post-binding drift and never reactivates on UUID restoration", async () => {
    const f = await frontendFixture()
    await f.bind()
    const abort = vi.spyOn(f.session.agent, "abort")
    f.sessionManager.newSession()
    await f.session.prompt("foreign native input")
    expect(f.frontend.readiness).toBeNull()
    expect(abort).not.toHaveBeenCalled()
    f.sessionManager.newSession({ id: f.owner.record.host_session_id })
    await f.session.prompt("restored UUID input")
    expect(f.frontend.readiness).toBeNull()
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.requests).toHaveLength(0)
  })

  it("revokes readiness for an unavailable native identity probe without authorizing abort", async () => {
    const f = await frontendFixture()
    await f.bind()
    const abort = vi.spyOn(f.session.agent, "abort")
    const identity = vi.spyOn(f.sessionManager, "getSessionId").mockImplementation(() => { throw new Error("Synthetic native identity unavailable") })
    expect(f.frontend.readiness).toBeNull()
    expect(abort).not.toHaveBeenCalled()
    // Probe denial is the criterion; SDK disposal itself needs its identity.
    identity.mockRestore()
    await f.session.prompt("unavailable native identity")
    expect(f.frontend.readiness).toBeNull()
    expect(f.requests).toHaveLength(0)
  })

  it("drains one owned close when a real streaming abort listener reenters close", async () => {
    const shutdown = vi.fn()
    const f = await frontendFixture({ streaming: true, register: pi => pi.on("session_shutdown", shutdown) })
    await f.bind()
    const input = f.session.prompt("owned streaming input")
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 2_000, interval: 5 })
    const signal = f.session.agent.signal!
    signal.addEventListener("abort", () => { void f.frontend.close() }, { once: true })
    await f.frontend.close()
    await input
    expect(signal.aborted).toBe(true)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(f.frontend.readiness).toBeNull()
    expect(f.owner.record.request.phase).toBe("cancelled")
    expect(f.owner.record.request.reason).toBe("disconnected")
  })

  it.each(["newSession", "switchSession", "fork", "importFromJsonl"])("requires fresh parent ownership before runtime %s", async method => {
    const f = await frontendFixture()
    await f.bind()
    await f.session.prompt("old input")
    await expect((f.frontend.runtime as any)[method]("/fixture-unused")).rejects.toThrow("Fresh parent/native ownership required")
    expect(f.sessionManager.getSessionId()).toBe(f.owner.record.host_session_id)
    expect(f.frontend.readiness).toBeNull()
    await f.session.prompt("held old frontend")
    expect(f.requests).toHaveLength(1)
  })

  it("holds SDK reload before it can drop the exclusive guards", async () => {
    const f = await frontendFixture()
    await f.bind()
    await f.session.prompt("old input")
    await expect(f.session.reload()).rejects.toThrow("Fresh parent/native ownership required")
    expect(f.frontend.readiness).toBeNull()
    await f.session.prompt("after denied reload")
    expect(f.requests).toHaveLength(1)
  })
})
