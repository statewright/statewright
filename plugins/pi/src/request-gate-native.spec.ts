import { afterEach, describe, expect, it, vi } from "vitest"
import { AgentSession, createExtensionRuntime, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent"
import { createPiRequestGate } from "./request-gate.mjs"
import { AdapterBridge } from "../../executor/lib/adapter-bridge.mjs"
import { base, pending, fixture } from "../../executor/tests/fixtures/owned-request.mjs"

const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })

// Real installed SDK prompt/runner and real loopback bridge + durable owner /
// journal. Only the authority receipt and terminal agent are synthetic. These
// fixtures do NOT claim the SDK Agent provider/retry/compaction loop is proved.
async function nativeFixture(options: { parked?: boolean; timeoutMs?: number; enable?: boolean;
  wrapCall?: (call: (...args: any[]) => Promise<any>) => (...args: any[]) => Promise<any> } = {}) {
  const f = await fixture({ after: (fn: () => Promise<void>) => cleanup.push(fn) }, options)
  const forwarded: string[] = []
  const bridge = await new AdapterBridge({
    call: async (name: string) => {
      forwarded.push(name)
      if (name === "statewright_get_state") return f.getState()
      throw new Error("Unexpected gateway effect in fixture")
    },
    request: async () => { throw new Error("Unexpected MCP forwarding in fixture") },
  }, { host: "pi", sessionOwner: f.owner, requestController: f.controller }).start()
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
  const onActive = vi.fn()
  const gate = createPiRequestGate({ nativeSessionId: f.owner.record.host_session_id,
    call: options.wrapCall ? options.wrapCall(call) : call, onPark, onActive, pollMs: 5, timeoutMs: options.timeoutMs ?? 3_000 })
  cleanup.push(() => gate.close())
  const sessionManager = SessionManager.inMemory("/fixture")
  sessionManager.newSession({ id: f.owner.record.host_session_id })
  const agent = {
    state: { model: { provider: "fixture", id: "fixture" }, messages: [], tools: [], isStreaming: false },
    subscribe: () => () => {}, prompt: vi.fn(async () => {}), abort: vi.fn(), waitForIdle: vi.fn(async () => {}),
  }
  const modelRegistry = { hasConfiguredAuth: vi.fn(() => true), find: vi.fn(), getAll: () => [] }
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>([
    ["input", [(event, ctx) => gate.input(event, ctx)]],
    ["tool_call", [async (_event, ctx) => await gate.checkpoint(ctx) ? undefined : { block: true, reason: "Native request held" }]],
  ])
  const extension = { path: "fixture:request-gate", handlers, tools: new Map(), commands: new Map(),
    flags: new Map(), shortcuts: new Map(), messageRenderers: new Map() }
  const session = new AgentSession({ agent, cwd: "/fixture", sessionManager, modelRegistry,
    settingsManager: SettingsManager.inMemory(), baseToolsOverride: {}, resourceLoader: {
      getExtensions: () => ({ extensions: [extension], runtime: createExtensionRuntime() }),
      getSystemPrompt: () => "fixture", getAppendSystemPrompt: () => [],
      getSkills: () => ({ skills: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getPrompts: () => ({ prompts: [] }),
    },
  } as any)
  cleanup.push(() => session.dispose())
  const compaction = vi.fn(async () => {})
  vi.spyOn(session as any, "_findLastAssistantMessage").mockReturnValue({ role: "assistant" })
  vi.spyOn(session as any, "_checkCompaction").mockImplementation(compaction)
  session.extensionRunner!.setUIContext({ notify: vi.fn(), setStatus: vi.fn() } as any)
  if (options.enable !== false) gate.enable()
  const prompt = (text = "fixture", source: "interactive" | "rpc" | "extension" = "interactive") =>
    session.prompt(text, { expandPromptTemplates: false, source })
  return { ...f, gate, session, sessionManager, agent, modelRegistry, compaction, onPark, onActive, prompt, bridge, forwarded }
}

const parked = async (f: Awaited<ReturnType<typeof nativeFixture>>) => {
  await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
  expect(f.agent.prompt).not.toHaveBeenCalled()
  expect(f.modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled()
  expect(f.compaction).not.toHaveBeenCalled()
}

describe("private Pi receipt waiting through the installed native SDK", () => {
  it.each(["interactive", "rpc", "extension"] as const)("keeps %s input waiting outside inference, then consumes once", async source => {
    const f = await nativeFixture({ parked: true })
    let settled = false
    const input = f.prompt("same owned input", source).then(() => { settled = true })
    await parked(f)
    expect(settled).toBe(false)
    const observations = f.onPark.mock.calls.length
    f.setLive({ ...base, state: "work" })
    await vi.waitFor(() => expect(f.onPark.mock.calls.length).toBeGreaterThan(observations), { timeout: 2_000, interval: 5 })
    expect(settled).toBe(false)
    expect(f.agent.prompt).not.toHaveBeenCalled()
    f.approve()
    await input
    expect(f.agent.prompt).toHaveBeenCalledTimes(1)
    expect(f.modelRegistry.hasConfiguredAuth).toHaveBeenCalledTimes(1)
    expect(f.compaction).toHaveBeenCalledTimes(1)
    expect(f.events.filter((event: string) => event === "clear:approval")).toHaveLength(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
    expect(await f.mirror.loadCheckpoint()).toBeNull()
  })

  it("requires explicit readiness after every native protection is installed", async () => {
    const f = await nativeFixture({ enable: false })
    await f.prompt()
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled()
    expect(f.agent.prompt).not.toHaveBeenCalled()
  })

  it("refuses a different native session before beginning a parent request", async () => {
    const f = await nativeFixture()
    f.sessionManager.newSession()
    await f.prompt()
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.agent.prompt).not.toHaveBeenCalled()
  })

  it("never admits the parked callback after the live native session changes", async () => {
    const f = await nativeFixture({ parked: true })
    const input = f.prompt()
    await parked(f)
    f.sessionManager.newSession()
    f.approve()
    await input
    expect(f.agent.prompt).not.toHaveBeenCalled()
    expect(f.modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled()
    expect(f.agent.abort).not.toHaveBeenCalled()
    expect(f.gate.held).toBe(true)
  })

  it("rechecks live native identity after begin's asynchronous response", async () => {
    let f!: Awaited<ReturnType<typeof nativeFixture>>
    f = await nativeFixture({ wrapCall: call => async (...args) => {
      const result = await call(...args)
      if (args[0] === "begin") f.sessionManager.newSession()
      return result
    } })
    await f.prompt()
    expect(f.agent.prompt).not.toHaveBeenCalled()
    expect(f.agent.abort).not.toHaveBeenCalled()
  })

  it("blocks an existing request's tool checkpoint in a replacement native session", async () => {
    const f = await nativeFixture()
    await f.prompt()
    f.sessionManager.newSession()
    const result = await (f.agent as any).beforeToolCall({ toolCall: { id: "old-call", name: "fixture-tool" }, args: {} })
    expect(result).toMatchObject({ block: true })
    expect(f.agent.abort).not.toHaveBeenCalled()
  })

  it("rechecks identity after wait's final asynchronous input handoff", async () => {
    const f = await nativeFixture()
    f.onActive.mockImplementation(() => { queueMicrotask(() => f.sessionManager.newSession()) })
    await f.prompt()
    expect(f.agent.prompt).not.toHaveBeenCalled()
    expect(f.modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled()
    expect(f.agent.abort).not.toHaveBeenCalled()
    expect(f.gate.held).toBe(true)
  })

  it("rechecks identity after wait's final asynchronous checkpoint handoff", async () => {
    const f = await nativeFixture()
    await f.prompt()
    f.onActive.mockImplementation(() => { queueMicrotask(() => f.sessionManager.newSession()) })
    const result = await (f.agent as any).beforeToolCall({ toolCall: { id: "old-call", name: "fixture-tool" }, args: {} })
    expect(result).toMatchObject({ block: true })
    expect(f.agent.abort).not.toHaveBeenCalled()
    expect(f.gate.held).toBe(true)
  })

  it("handles a native identity read exception instead of escaping the SDK input hook", async () => {
    const f = await nativeFixture()
    vi.spyOn(f.sessionManager, "getSessionId").mockImplementation(() => { throw new Error("Disposed identity") })
    await f.prompt()
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.agent.prompt).not.toHaveBeenCalled()
  })

  it("bounds an unresponsive begin transport even when it ignores AbortSignal", async () => {
    const f = await nativeFixture({ timeoutMs: 100, wrapCall: _call => async () => new Promise(() => {}) })
    await f.prompt()
    expect(f.agent.prompt).not.toHaveBeenCalled()
    expect(f.modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled()
    expect(f.owner.record.request_epoch).toBe(0)
  })

  it("blocks a tool when the SDK context signal getter throws", async () => {
    const f = await nativeFixture()
    await f.prompt()
    Object.defineProperty(f.agent, "signal", { get: () => { throw new Error("Disposed operation") } })
    const result = await (f.agent as any).beforeToolCall({ toolCall: { id: "owned-call", name: "fixture-tool" }, args: {} })
    expect(result).toMatchObject({ block: true })
    expect(f.agent.prompt).toHaveBeenCalledTimes(1)
  })

  it("keeps rejected input cancelled and retains the approval journal", async () => {
    const f = await nativeFixture({ parked: true })
    const input = f.prompt()
    await parked(f)
    f.reject()
    await input
    f.approve()
    expect(f.owner.record.request.reason).toBe("rejected")
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    expect(f.agent.prompt).not.toHaveBeenCalled()
  })

  it.each(["cancelled", "dismissed", "disconnected", "timeout", "superseded"])("never resumes %s input after a late approved receipt", async reason => {
    const f = await nativeFixture({ parked: true })
    const input = f.prompt()
    await parked(f)
    await f.gate.cancel(reason)
    await input
    f.approve()
    expect(f.owner.record.request.reason).toBe(reason)
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    expect(f.agent.prompt).not.toHaveBeenCalled()
  })

  it("times out a native pending wait without model polling or self-approval", async () => {
    const f = await nativeFixture({ parked: true, timeoutMs: 250 })
    const input = f.prompt()
    await parked(f)
    await input
    expect(f.owner.record.request.reason).toBe("timeout")
    expect(f.forwarded).toEqual([])
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    expect(f.agent.prompt).not.toHaveBeenCalled()
  })

  it("replacement input cancels the old callback and does not abort the new one", async () => {
    const f = await nativeFixture({ parked: true })
    const old = f.prompt("old")
    await parked(f)
    const replacement = f.prompt("replacement")
    await old
    await vi.waitFor(() => expect(f.owner.record.request_epoch).toBe(2), { timeout: 2_000, interval: 5 })
    f.approve()
    await replacement
    expect(f.agent.prompt).toHaveBeenCalledTimes(1)
    expect(f.agent.abort).toHaveBeenCalledTimes(1)
    expect(f.owner.record.request_epoch).toBe(2)
  })

  it("discards a late begin response without signalling the replacement agent", async () => {
    let release!: () => void
    let arrived!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    const f = await nativeFixture({ wrapCall: call => async (action, body, signal) => {
      const result = await call(action, body, signal)
      if (action === "begin" && body.input_sequence === 1) { arrived(); await barrier }
      return result
    } })
    const old = f.prompt("old")
    await arrival
    await f.prompt("replacement")
    await old
    release()
    await Promise.resolve()
    expect(f.agent.prompt).toHaveBeenCalledTimes(1)
    expect(f.agent.abort).toHaveBeenCalledTimes(1)
  })

  it.each([false, 0, "", [], { event: "ACCEPT" }])("holds malformed pending projection %j", async value => {
    const f = await nativeFixture()
    f.setLive({ ...base, pending_approval: value })
    await f.prompt()
    expect(f.agent.prompt).not.toHaveBeenCalled()
    expect(f.modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled()
  })

  it("waits inside the actual SDK tool hook without holding an abort idle promise", async () => {
    const f = await nativeFixture()
    await f.prompt()
    f.setLive(pending)
    f.agent.waitForIdle.mockImplementation(() => new Promise<void>(() => {}))
    const tool = (f.agent as any).beforeToolCall({ toolCall: { id: "owned-call", name: "fixture-tool" }, args: {} })
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    expect(f.agent.prompt).toHaveBeenCalledTimes(1)
    await f.gate.cancel("dismissed")
    expect(await tool).toMatchObject({ block: true })
    expect(f.agent.abort).toHaveBeenCalled()
    expect(f.agent.prompt).toHaveBeenCalledTimes(1)
  })
})
