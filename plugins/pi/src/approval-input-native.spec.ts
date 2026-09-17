import { afterEach, describe, expect, it, vi } from "vitest"
import { AgentSession, createExtensionRuntime, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent"
import statewrightExtension from "./index.js"

// Actual installed SDK AgentSession and ExtensionRunner, with inference replaced
// by a terminal counter and compaction/authentication boundary counters. No
// provider, real gateway, workflow loading or native files are used.
const savedEnv = { ...process.env }
const savedFetch = globalThis.fetch
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  globalThis.fetch = savedFetch
  vi.restoreAllMocks()
})

async function fixture(initial: unknown, options: { unavailable?: boolean; initUnavailable?: boolean; uiThrows?: boolean;
  ownership?: Readonly<{ ownsCurrent: () => boolean; hasConsumedApproval?: (id: string | null) => boolean }>; beforeStateRead?: () => Promise<void> } = {}) {
  process.env.STATEWRIGHT_ADAPTER_URL = "http://127.0.0.1:1"
  process.env.STATEWRIGHT_ADAPTER_TOKEN = "fixture-token"
  process.env.STATEWRIGHT_EXECUTOR_ID = "fixture-owner"
  process.env.STATEWRIGHT_BRANCH_SESSION_ID = "fixture-session"
  delete process.env.STATEWRIGHT_WORKFLOW
  let snapshot = initial
  let unavailable = Boolean(options.initUnavailable)
  const toolNames: string[] = []
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (unavailable) throw new Error("fixture disconnect")
    const body = init?.body ? JSON.parse(String(init.body)) : null
    if (!body) return { ok: true, json: async () => ({ state: "frontier" }) } as Response
    if (body.method === "tools/call") {
      toolNames.push(body.params.name)
      if (body.params.name !== "statewright_get_state") throw new Error("Unexpected mutating call")
      await options.beforeStateRead?.()
      return { ok: true, json: async () => ({ result: { content: [{ type: "text", text: JSON.stringify(snapshot) }] } }) } as Response
    }
    return { ok: true, json: async () => ({}) } as Response
  })
  vi.spyOn(console, "log").mockImplementation(() => {})
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>()
  const tools: string[] = []
  const pi = {
    on: (name: string, callback: (...args: any[]) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), callback])
    },
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: vi.fn(), registerProvider: vi.fn(), sendUserMessage: vi.fn(),
    exec: vi.fn(), getActiveTools: () => tools, setActiveTools: vi.fn(),
    setModel: vi.fn(async () => true), getThinkingLevel: () => "off", setThinkingLevel: vi.fn(),
  }
  await statewrightExtension(pi as any, options.ownership)
  unavailable = Boolean(options.unavailable || options.initUnavailable)
  const agent = {
    state: { model: { provider: "fixture", id: "fixture" }, messages: [], tools: [], isStreaming: false },
    subscribe: () => () => {}, prompt: vi.fn(async () => {}), abort: vi.fn(), waitForIdle: vi.fn(async () => {}),
  }
  const modelRegistry = { hasConfiguredAuth: vi.fn(() => true), find: vi.fn(), getAll: () => [] }
  const extension = {
    path: "fixture:statewright", handlers, tools: new Map(), commands: new Map(),
    flags: new Map(), shortcuts: new Map(), messageRenderers: new Map(),
  }
  const session = new AgentSession({
    agent, cwd: "/fixture", sessionManager: SessionManager.inMemory("/fixture"),
    settingsManager: SettingsManager.inMemory(), modelRegistry,
    baseToolsOverride: {}, resourceLoader: {
      getExtensions: () => ({ extensions: [extension], runtime: createExtensionRuntime() }),
      getSystemPrompt: () => "fixture", getAppendSystemPrompt: () => [],
      getSkills: () => ({ skills: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getPrompts: () => ({ prompts: [] }),
    },
  } as any)
  const compaction = vi.fn(async () => {})
  // A prior assistant forces SDK's real prompt path to check compaction.
  vi.spyOn(session as any, "_findLastAssistantMessage").mockReturnValue({ role: "assistant" })
  vi.spyOn(session as any, "_checkCompaction").mockImplementation(compaction)
  const notify = vi.fn(() => { if (options.uiThrows) throw new Error("fixture UI failure") })
  session.extensionRunner!.setUIContext({ notify, setStatus: vi.fn() } as any)
  return { session, agent, modelRegistry, compaction, notify, toolNames, pi,
    setSnapshot: (next: unknown) => { snapshot = next },
  }
}

const state = { state: "frontier", run_id: "run-fixture", allowed_tools: [], transitions: [], meta: {} }
const pending = { ...state, pending_approval: { approval_id: "approval-fixture", event: "DONE", from_state: "frontier", to_state: "testing" } }

describe("native Pi approval admission", () => {
  it("cannot replace a project hold from continued ownership and projection clearance alone", async () => {
    let owned = true
    const f = await fixture(pending, { ownership: { ownsCurrent: () => owned } })
    await f.session.prompt("owned pending input", { expandPromptTemplates: false })
    expect(f.agent.prompt).not.toHaveBeenCalled()
    f.setSnapshot(state)
    owned = false
    const observations = f.toolNames.length
    await f.session.prompt("unowned replacement", { expandPromptTemplates: false })
    expect(f.toolNames).toHaveLength(observations)
    expect(f.agent.prompt).not.toHaveBeenCalled()
    owned = true
    await f.session.prompt("privately admitted replacement", { expandPromptTemplates: false })
    expect(f.agent.prompt).not.toHaveBeenCalled()
  })

  it("replaces a project hold only for its matching privately consumed approval", async () => {
    let consumed: string | null = null
    const f = await fixture(pending, { ownership: { ownsCurrent: () => true, hasConsumedApproval: id => id !== null && id === consumed } })
    await f.session.prompt("project pending input", { expandPromptTemplates: false })
    f.setSnapshot(state)
    consumed = "foreign-approval"
    await f.session.prompt("unrelated private release", { expandPromptTemplates: false, source: "extension" })
    expect(f.agent.prompt).not.toHaveBeenCalled()
    consumed = "approval-fixture"
    await f.session.prompt("matching private release", { expandPromptTemplates: false, source: "extension" })
    expect(f.agent.prompt).toHaveBeenCalledTimes(1)
  })

  it("cannot abort or notify for a private input superseded during its project state read", async () => {
    let owned = true
    let paused = false
    let arrived!: () => void; let release!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    const f = await fixture(pending, { ownership: { ownsCurrent: () => owned }, beforeStateRead: async () => { if (paused) { arrived(); await barrier } } })
    paused = true
    const input = f.session.prompt("superseded private input", { expandPromptTemplates: false })
    await arrival
    owned = false
    release()
    await input
    expect(f.agent.prompt).not.toHaveBeenCalled()
    expect(f.agent.abort).not.toHaveBeenCalled()
    expect(f.notify).not.toHaveBeenCalled()
    expect(f.modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled()
  })

  it.each(["interactive", "rpc", "extension"] as const)("parks %s input before auth, compaction and inference", async source => {
    const f = await fixture(pending)
    await f.session.prompt("fixture only", { expandPromptTemplates: false, source })
    expect(f.modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled()
    expect(f.compaction).not.toHaveBeenCalled()
    expect(f.agent.prompt).not.toHaveBeenCalled()
    expect(f.toolNames.length).toBeGreaterThan(0)
    expect(f.toolNames.every(name => name === "statewright_get_state")).toBe(true)
  })

  it("admits normal input through the same native path", async () => {
    const f = await fixture(state)
    await f.session.prompt("fixture only", { expandPromptTemplates: false })
    expect(f.modelRegistry.hasConfiguredAuth).toHaveBeenCalledTimes(1)
    expect(f.compaction).toHaveBeenCalledTimes(1)
    expect(f.agent.prompt).toHaveBeenCalledTimes(1)
  })

  it.each([false, 0, "", [], { event: "DONE" }])("holds malformed pending projection %j", async value => {
    const f = await fixture({ ...state, pending_approval: value })
    await f.session.prompt("fixture only", { expandPromptTemplates: false })
    expect(f.agent.prompt).not.toHaveBeenCalled()
    expect(f.compaction).not.toHaveBeenCalled()
  })

  it.each([null, {}, [], { state: 42 }, { state: "" }])("holds absent or malformed managed state %j", async value => {
    const f = await fixture(value)
    await f.session.prompt("fixture only", { expandPromptTemplates: false })
    expect(f.modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled()
    expect(f.compaction).not.toHaveBeenCalled()
    expect(f.agent.prompt).not.toHaveBeenCalled()
  })

  it("does not release held work from projection absence or replacement input", async () => {
    const f = await fixture(pending)
    await f.session.prompt("old fixture", { expandPromptTemplates: false })
    f.setSnapshot(state)
    await f.session.prompt("replacement fixture", { expandPromptTemplates: false, source: "extension" })
    expect(f.agent.prompt).not.toHaveBeenCalled()
    expect(f.pi.sendUserMessage).not.toHaveBeenCalled()
  })

  it("does not fail open when notification throws", async () => {
    const f = await fixture(pending, { uiThrows: true })
    await f.session.prompt("fixture only", { expandPromptTemplates: false })
    expect(f.agent.prompt).not.toHaveBeenCalled()
  })

  it("holds managed transport disconnect before inference", async () => {
    const f = await fixture(state, { unavailable: true })
    await f.session.prompt("fixture only", { expandPromptTemplates: false })
    expect(f.agent.prompt).not.toHaveBeenCalled()
    expect(f.compaction).not.toHaveBeenCalled()
  })

  it("keeps the input boundary when managed initialization fails", async () => {
    const f = await fixture(state, { initUnavailable: true })
    await f.session.prompt("fixture only", { expandPromptTemplates: false })
    expect(f.agent.prompt).not.toHaveBeenCalled()
    expect(f.compaction).not.toHaveBeenCalled()
  })

  it("does not enqueue steering or follow-up input while held", async () => {
    const f = await fixture(pending)
    f.agent.state.isStreaming = true
    const steer = vi.spyOn(f.session as any, "_queueSteer")
    const follow = vi.spyOn(f.session as any, "_queueFollowUp")
    await f.session.prompt("fixture steer", { expandPromptTemplates: false, streamingBehavior: "steer" })
    await f.session.prompt("fixture follow", { expandPromptTemplates: false, streamingBehavior: "followUp" })
    expect(steer).not.toHaveBeenCalled()
    expect(follow).not.toHaveBeenCalled()
    expect(f.agent.prompt).not.toHaveBeenCalled()
  })

  it("returns from the actual SDK tool hook without awaiting abort's idle promise", async () => {
    const f = await fixture(pending)
    await f.session.prompt("fixture only", { expandPromptTemplates: false })
    f.agent.waitForIdle.mockImplementation(() => new Promise<void>(() => {}))
    const result = await (f.agent as any).beforeToolCall({ toolCall: { id: "fixture-call", name: "statewright_transition" }, args: { event: "DONE" } })
    expect(result).toMatchObject({ block: true })
    expect(result.reason).not.toContain("Call statewright_transition")
    expect(f.agent.abort).toHaveBeenCalled()
    expect(f.toolNames.every(name => name === "statewright_get_state")).toBe(true)
  })
})
