/**
 * Tests for statewright Pi extension
 *
 * Mocks: fetch (gateway HTTP), readFileSync (port file), Pi ExtensionAPI
 * Tests: initialization, tool registration, tool blocking, context injection,
 *        transition tracking, error handling
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest"

// Mock node:fs before importing the extension
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}))

// Mock typebox — the extension only uses Type.Object and Type.String
vi.mock("typebox", () => ({
  Type: {
    Object: vi.fn((schema: unknown) => ({ type: "object", properties: schema })),
    String: vi.fn((opts: unknown) => ({ type: "string", ...(opts as Record<string, unknown>) })),
  },
}))

import { readFileSync } from "node:fs"
import statewrightExtension from "./index.js"

// --- Types for test infrastructure ---

interface ToolContent {
  type: string
  text: string
}

interface ToolResult {
  content: ToolContent[]
}

interface RegisteredTool {
  name: string
  label: string
  description: string
  parameters: unknown
  execute: (
    toolCallId: string,
    params: Record<string, string>,
    signal: AbortSignal | undefined,
  ) => Promise<ToolResult>
}

interface ToolCallEvent {
  toolName: string
}

interface ToolCallResult {
  block?: boolean
  reason?: string
}

interface AgentStartResult {
  appendSystemPrompt?: string
}

interface MockUI {
  setStatus: Mock
  notify: Mock
}

interface MockCtx {
  ui: MockUI
}

type EventHandler = (
  event: Record<string, unknown>,
  ctx: MockCtx,
) => Promise<ToolCallResult | AgentStartResult | undefined>

interface MockPi {
  registerTool: Mock
  on: Mock
  _tools: RegisteredTool[]
  _handlers: Record<string, EventHandler[]>
  _fireEvent: (
    event: string,
    eventData: Record<string, unknown>,
    ctx: MockCtx,
  ) => Promise<Array<ToolCallResult | AgentStartResult | undefined>>
}

// --- Test fixtures ---

const MOCK_PORT = "9876"

const MOCK_STATE = {
  state: "implementing",
  isFinal: false,
  iteration: 3,
  maxIterations: 10,
  allowedTools: ["Read", "Edit", "Bash"],
  instructions: "Implement the fix using minimal changes",
  additionalContext: "",
}

const MOCK_FINAL_STATE = {
  ...MOCK_STATE,
  state: "completed",
  isFinal: true,
  iteration: 7,
}

// --- Mock ExtensionAPI builder ---

function createMockPi(): MockPi {
  const tools: RegisteredTool[] = []
  const handlers: Record<string, EventHandler[]> = {}

  return {
    registerTool: vi.fn((def: RegisteredTool) => tools.push(def)),
    on: vi.fn((event: string, handler: EventHandler) => {
      if (!handlers[event]) handlers[event] = []
      handlers[event].push(handler)
    }),
    _tools: tools,
    _handlers: handlers,
    _fireEvent: async (event, eventData, ctx) => {
      const results = []
      for (const h of handlers[event] ?? []) {
        results.push(await h(eventData, ctx))
      }
      return results
    },
  }
}

function createMockCtx(): MockCtx {
  return {
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  }
}

// --- Mock fetch responses ---

function mockFetchResponses(responses: Record<string, unknown>): () => void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url.toString()

    for (const [pattern, body] of Object.entries(responses)) {
      if (urlStr.includes(pattern)) {
        return {
          ok: true,
          json: async () => body,
        } as Response
      }
    }

    return { ok: false, status: 404 } as Response
  }) as Mock

  return () => {
    globalThis.fetch = originalFetch
  }
}

// ExtensionAPI is opaque to us — the mock satisfies the structural contract
// Cast through unknown to avoid coupling to the peer dependency's exact shape
function asPiApi(mock: MockPi): Parameters<typeof statewrightExtension>[0] {
  return mock as unknown as Parameters<typeof statewrightExtension>[0]
}

// --- Tests ---

describe("statewright Pi extension", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("initialization", () => {
    it("exits silently when port file does not exist", async () => {
      ;(readFileSync as Mock).mockImplementation(() => {
        throw new Error("ENOENT")
      })
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      const pi = createMockPi()

      await statewrightExtension(asPiApi(pi))

      expect(pi.registerTool).not.toHaveBeenCalled()
      expect(pi.on).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Gateway not running"),
      )
      warn.mockRestore()
    })

    it("exits when gateway is unreachable", async () => {
      ;(readFileSync as Mock).mockReturnValue(MOCK_PORT)
      globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 })) as Mock
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      const pi = createMockPi()

      await statewrightExtension(asPiApi(pi))

      expect(pi.registerTool).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it("registers two tools and three event handlers on success", async () => {
      ;(readFileSync as Mock).mockReturnValue(MOCK_PORT)
      const cleanup = mockFetchResponses({ "/hooks/state": MOCK_STATE })
      const log = vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()

      await statewrightExtension(asPiApi(pi))

      expect(pi.registerTool).toHaveBeenCalledTimes(2)
      expect(pi._tools[0]).toHaveProperty("name", "statewright_get_state")
      expect(pi._tools[1]).toHaveProperty("name", "statewright_transition")

      expect(pi.on).toHaveBeenCalledTimes(3)
      expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function))
      expect(pi.on).toHaveBeenCalledWith("tool_call", expect.any(Function))
      expect(pi.on).toHaveBeenCalledWith("tool_result", expect.any(Function))

      log.mockRestore()
      cleanup()
    })

    it("logs initial state on startup", async () => {
      ;(readFileSync as Mock).mockReturnValue(MOCK_PORT)
      const cleanup = mockFetchResponses({ "/hooks/state": MOCK_STATE })
      const log = vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()

      await statewrightExtension(asPiApi(pi))

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("implementing"),
      )
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("3/10"),
      )

      log.mockRestore()
      cleanup()
    })
  })

  describe("statewright_get_state tool", () => {
    it("returns state JSON from gateway", async () => {
      ;(readFileSync as Mock).mockReturnValue(MOCK_PORT)
      const cleanup = mockFetchResponses({ "/hooks/state": MOCK_STATE })
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()

      await statewrightExtension(asPiApi(pi))

      const tool = pi._tools[0]
      const result = await tool.execute("call-1", {}, undefined)

      expect(result.content[0].type).toBe("text")
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.state).toBe("implementing")
      expect(parsed.allowedTools).toContain("Edit")

      cleanup()
    })

    it("returns error when gateway unreachable", async () => {
      ;(readFileSync as Mock).mockReturnValue(MOCK_PORT)
      // First call succeeds (init), subsequent fail
      let callCount = 0
      globalThis.fetch = vi.fn(async () => {
        callCount++
        if (callCount === 1) return { ok: true, json: async () => MOCK_STATE } as Response
        return { ok: false, status: 503 } as Response
      }) as Mock
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()

      await statewrightExtension(asPiApi(pi))

      const tool = pi._tools[0]
      const result = await tool.execute("call-1", {}, undefined)

      expect(result.content[0].text).toBe("Gateway not reachable")
    })
  })

  describe("statewright_transition tool", () => {
    it("sends transition event to gateway", async () => {
      ;(readFileSync as Mock).mockReturnValue(MOCK_PORT)
      const transitionResp = { decision: "allow", transition: "implementing => testing" }
      const cleanup = mockFetchResponses({
        "/hooks/state": MOCK_STATE,
        "/hooks/pre-tool": transitionResp,
      })
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()

      await statewrightExtension(asPiApi(pi))

      const tool = pi._tools[1]
      const result = await tool.execute("call-1", { event: "DONE" }, undefined)

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.transition).toBe("implementing => testing")

      // Verify fetch was called with the right tool_name
      const fetchCalls = (globalThis.fetch as Mock).mock.calls as Array<[string, RequestInit]>
      const transitionCall = fetchCalls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/hooks/pre-tool"),
      )
      expect(transitionCall).toBeDefined()
      const body = JSON.parse(transitionCall![1].body as string)
      expect(body.tool_name).toBe("statewright_transition:DONE")

      cleanup()
    })
  })

  describe("tool_call enforcement", () => {
    it("blocks denied tools", async () => {
      ;(readFileSync as Mock).mockReturnValue(MOCK_PORT)
      const cleanup = mockFetchResponses({
        "/hooks/state": MOCK_STATE,
        "/hooks/pre-tool": {
          decision: "deny",
          additionalContext: "Write not allowed in implementing phase",
        },
      })
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createMockCtx()

      await statewrightExtension(asPiApi(pi))

      const result = await pi._fireEvent(
        "tool_call",
        { toolName: "Write" },
        ctx,
      )

      expect(result[0]).toEqual({
        block: true,
        reason: "Write not allowed in implementing phase",
      })

      cleanup()
    })

    it("allows permitted tools (returns undefined)", async () => {
      ;(readFileSync as Mock).mockReturnValue(MOCK_PORT)
      const cleanup = mockFetchResponses({
        "/hooks/state": MOCK_STATE,
        "/hooks/pre-tool": { decision: "allow" },
      })
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createMockCtx()

      await statewrightExtension(asPiApi(pi))

      const result = await pi._fireEvent(
        "tool_call",
        { toolName: "Edit" },
        ctx,
      )

      expect(result[0]).toBeUndefined()

      cleanup()
    })

    it("skips enforcement for statewright_ tools", async () => {
      ;(readFileSync as Mock).mockReturnValue(MOCK_PORT)
      const cleanup = mockFetchResponses({ "/hooks/state": MOCK_STATE })
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createMockCtx()

      await statewrightExtension(asPiApi(pi))

      // Clear fetch mock to detect calls
      const fetchBefore = (globalThis.fetch as Mock).mock.calls.length

      await pi._fireEvent(
        "tool_call",
        { toolName: "statewright_get_state" },
        ctx,
      )

      // No new fetch calls — statewright tools are skipped
      expect((globalThis.fetch as Mock).mock.calls.length).toBe(fetchBefore)

      cleanup()
    })
  })

  describe("tool_result tracking", () => {
    it("shows notification on transition", async () => {
      ;(readFileSync as Mock).mockReturnValue(MOCK_PORT)
      const cleanup = mockFetchResponses({
        "/hooks/state": MOCK_STATE,
        "/hooks/post-tool": { transition: "implementing => testing" },
      })
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createMockCtx()

      await statewrightExtension(asPiApi(pi))

      await pi._fireEvent("tool_result", { toolName: "Edit" }, ctx)

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "[statewright] implementing => testing",
        "info",
      )

      cleanup()
    })

    it("shows success notification on completion", async () => {
      ;(readFileSync as Mock).mockReturnValue(MOCK_PORT)
      const cleanup = mockFetchResponses({
        "/hooks/state": MOCK_FINAL_STATE,
        "/hooks/post-tool": { completed: true },
      })
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createMockCtx()

      await statewrightExtension(asPiApi(pi))

      await pi._fireEvent("tool_result", { toolName: "Bash" }, ctx)

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "[statewright] Workflow complete.",
        "success",
      )

      cleanup()
    })

    it("updates status bar after each tool", async () => {
      ;(readFileSync as Mock).mockReturnValue(MOCK_PORT)
      const cleanup = mockFetchResponses({
        "/hooks/state": MOCK_STATE,
        "/hooks/post-tool": {},
      })
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createMockCtx()

      await statewrightExtension(asPiApi(pi))

      await pi._fireEvent("tool_result", { toolName: "Read" }, ctx)

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "statewright",
        expect.stringContaining("implementing"),
      )

      cleanup()
    })

    it("skips tracking for statewright_ tools", async () => {
      ;(readFileSync as Mock).mockReturnValue(MOCK_PORT)
      const cleanup = mockFetchResponses({ "/hooks/state": MOCK_STATE })
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createMockCtx()

      await statewrightExtension(asPiApi(pi))

      const fetchBefore = (globalThis.fetch as Mock).mock.calls.length

      await pi._fireEvent(
        "tool_result",
        { toolName: "statewright_transition" },
        ctx,
      )

      expect((globalThis.fetch as Mock).mock.calls.length).toBe(fetchBefore)
      expect(ctx.ui.setStatus).not.toHaveBeenCalled()

      cleanup()
    })
  })

  describe("before_agent_start context injection", () => {
    it("returns appendSystemPrompt with state context", async () => {
      ;(readFileSync as Mock).mockReturnValue(MOCK_PORT)
      const cleanup = mockFetchResponses({ "/hooks/state": MOCK_STATE })
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createMockCtx()

      await statewrightExtension(asPiApi(pi))

      const results = await pi._fireEvent("before_agent_start", {}, ctx)
      const result = results[0] as AgentStartResult

      expect(result).toHaveProperty("appendSystemPrompt")
      expect(result.appendSystemPrompt).toContain("implementing")
      expect(result.appendSystemPrompt).toContain("iteration 3/10")
      expect(result.appendSystemPrompt).toContain("Read, Edit, Bash")
      expect(result.appendSystemPrompt).toContain("Implement the fix")

      cleanup()
    })

    it("updates status bar", async () => {
      ;(readFileSync as Mock).mockReturnValue(MOCK_PORT)
      const cleanup = mockFetchResponses({ "/hooks/state": MOCK_STATE })
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createMockCtx()

      await statewrightExtension(asPiApi(pi))

      await pi._fireEvent("before_agent_start", {}, ctx)

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "statewright",
        "[statewright] implementing (3/10)",
      )

      cleanup()
    })

    it("omits instructions line when state has no instructions", async () => {
      const stateNoInstructions = { ...MOCK_STATE, instructions: null }
      ;(readFileSync as Mock).mockReturnValue(MOCK_PORT)
      const cleanup = mockFetchResponses({
        "/hooks/state": stateNoInstructions,
      })
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createMockCtx()

      await statewrightExtension(asPiApi(pi))

      const results = await pi._fireEvent("before_agent_start", {}, ctx)
      const result = results[0] as AgentStartResult

      expect(result.appendSystemPrompt).not.toContain("Phase instructions:")

      cleanup()
    })
  })
})
