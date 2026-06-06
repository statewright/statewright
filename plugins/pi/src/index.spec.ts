/**
 * Tests for statewright Pi extension (managed cloud gateway architecture)
 *
 * Mocks: fetch (gateway HTTP), readFileSync (API key), Pi ExtensionAPI
 * Tests: initialization, tool registration, tool blocking, context injection,
 *        interrupt detection, state tracking, error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest"

// Mock node:fs
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}))

// Mock node:os
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/test"),
}))

// Mock node:path
vi.mock("node:path", () => ({
  join: vi.fn((...args: string[]) => args.join("/")),
}))

// Mock minimatch
vi.mock("minimatch", () => ({
  minimatch: vi.fn((path: string, pattern: string) => {
    // Simple mock: check if the path ends with a matching extension
    if (pattern.includes("*.js") && path.endsWith(".js")) return true
    if (pattern.includes("*.env") && path.includes(".env")) return true
    return false
  }),
}))

// Mock typebox
vi.mock("typebox", () => ({
  Type: {
    Object: vi.fn((schema: unknown, opts?: unknown) => ({ type: "object", properties: schema })),
    String: vi.fn((opts: unknown) => ({ type: "string", ...(opts as Record<string, unknown>) })),
    Boolean: vi.fn(() => ({ type: "boolean" })),
    Optional: vi.fn((inner: unknown) => inner),
    Array: vi.fn((inner: unknown, opts?: unknown) => ({ type: "array", items: inner })),
  },
}))

import { readFileSync } from "node:fs"
import statewrightExtension from "./index.js"

// --- Types ---

interface RegisteredTool {
  name: string
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>
}

interface MockModel {
  provider: string
  id: string
  name: string
}

interface MockModelRegistry {
  find: Mock
  getAll: Mock
}

interface MockUI {
  setStatus: Mock
  notify: Mock
}

interface MockCtx {
  ui: MockUI
  modelRegistry: MockModelRegistry
  model: MockModel | undefined
}

type EventHandler = (event: Record<string, unknown>, ctx: MockCtx) => Promise<unknown>

interface MockPi {
  registerTool: Mock
  on: Mock
  sendUserMessage: Mock
  exec: Mock
  setModel: Mock
  getActiveTools: () => string[]
  _tools: RegisteredTool[]
  _handlers: Record<string, EventHandler[]>
  _fire: (event: string, data: Record<string, unknown>, ctx: MockCtx) => Promise<unknown[]>
}

// --- Fixtures ---

const API_KEY = "sw_live_testkey123"

const MOCK_STATE = {
  state: "implementing",
  is_final: false,
  iteration: 3,
  max_iterations: 10,
  allowed_tools: ["Read", "Edit", "Bash"],
  instructions: "Implement the fix",
  transitions: [
    { event: "DONE", target: "testing" },
    { event: "FAIL", target: "failed" },
  ],
  context: {},
  interrupts: {
    pb_check: { file_pattern: "site/pb/**/*.js", target: "pb_validating" },
  },
}

const MOCK_TRANSITION = {
  transitioned: true,
  from: "implementing",
  to: "testing",
}

// --- Helpers ---

function createMockPi(): MockPi {
  const tools: RegisteredTool[] = []
  const handlers: Record<string, EventHandler[]> = {}
  return {
    registerTool: vi.fn((def: RegisteredTool) => tools.push(def)),
    on: vi.fn((event: string, handler: EventHandler) => {
      if (!handlers[event]) handlers[event] = []
      handlers[event].push(handler)
    }),
    sendUserMessage: vi.fn(),
    exec: vi.fn(async () => "mock exec output"),
    setModel: vi.fn(async () => true),
    setThinkingLevel: vi.fn(),
    getThinkingLevel: vi.fn(() => "medium"),
    setActiveTools: vi.fn(),
    registerCommand: vi.fn(),
    getActiveTools: () => ["read", "bash", "edit", "write", "find", "ls", "grep", "statewright_get_state", "statewright_transition", "statewright_list_workflows", "statewright_load_workflow"],
    _tools: tools,
    _handlers: handlers,
    _fire: async (event, data, ctx) => {
      const results = []
      for (const h of handlers[event] ?? []) results.push(await h(data, ctx))
      return results
    },
  }
}

const MOCK_MODELS: MockModel[] = [
  { provider: "anthropic", id: "claude-haiku-4-5-20251001", name: "Haiku" },
  { provider: "anthropic", id: "claude-sonnet-4-6", name: "Sonnet" },
  { provider: "anthropic", id: "claude-opus-4-6", name: "Opus" },
  { provider: "openai-codex", id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
  { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" },
  { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" },
  { provider: "ollama", id: "gemma4:12b", name: "Gemma 4 12B" },
]

function createCtx(currentModel?: MockModel): MockCtx {
  return {
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    modelRegistry: {
      find: vi.fn((provider: string, modelId: string) =>
        MOCK_MODELS.find((m) => m.provider === provider && m.id === modelId) ?? undefined,
      ),
      getAll: vi.fn(() => MOCK_MODELS),
    },
    model: currentModel ?? MOCK_MODELS[2], // default to opus
  }
}

function asPi(mock: MockPi): Parameters<typeof statewrightExtension>[0] {
  return mock as unknown as Parameters<typeof statewrightExtension>[0]
}

let originalFetch: typeof globalThis.fetch
let fetchMock: Mock

function setupFetch(responses: Array<{ match: string; body: unknown; headers?: Record<string, string> }>) {
  fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString()
    for (const r of responses) {
      if (urlStr.includes(r.match)) {
        // Check if it's a JSON-RPC call and extract the tool name
        if (init?.body) {
          const parsed = JSON.parse(init.body as string)
          // For tools/call, check if the tool name matches
          if (parsed.params?.name && r.match.includes(parsed.params.name)) {
            return {
              ok: true,
              headers: new Headers(r.headers ?? { "mcp-session-id": "test-session" }),
              json: async () => ({
                jsonrpc: "2.0",
                id: parsed.id,
                result: { content: [{ type: "text", text: JSON.stringify(r.body) }] },
              }),
            } as Response
          }
        }
        // Default: return as JSON-RPC response
        return {
          ok: true,
          headers: new Headers(r.headers ?? { "mcp-session-id": "test-session" }),
          json: async () => {
            if (r.match === "/mcp" && init?.body) {
              const parsed = JSON.parse(init.body as string)
              if (parsed.method === "initialize") {
                return { jsonrpc: "2.0", id: parsed.id, result: { protocolVersion: "2024-11-05" } }
              }
              if (parsed.method === "tools/call") {
                return {
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: { content: [{ type: "text", text: JSON.stringify(r.body) }] },
                }
              }
            }
            return r.body
          },
        } as Response
      }
    }
    return { ok: false, status: 404, headers: new Headers() } as unknown as Response
  }) as Mock
  globalThis.fetch = fetchMock
}

// --- Tests ---

describe("statewright Pi extension", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    originalFetch = globalThis.fetch
    process.env.STATEWRIGHT_API_KEY = API_KEY
    process.env.STATEWRIGHT_GATEWAY_URL = "http://localhost:3001"
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    delete process.env.STATEWRIGHT_API_KEY
    delete process.env.STATEWRIGHT_GATEWAY_URL
  })

  describe("initialization", () => {
    it("exits when no API key", async () => {
      delete process.env.STATEWRIGHT_API_KEY
      ;(readFileSync as Mock).mockImplementation(() => { throw new Error("ENOENT") })
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      const pi = createMockPi()

      await statewrightExtension(asPi(pi))

      expect(pi.registerTool).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("No API key"))
      warn.mockRestore()
    })

    it("exits when gateway unreachable", async () => {
      globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503, headers: new Headers() })) as Mock
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      const pi = createMockPi()

      await statewrightExtension(asPi(pi))

      expect(pi.registerTool).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Could not connect"),
        expect.anything(),
      )
      warn.mockRestore()
    })

    it("registers 4 tools and 3 event handlers on success", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      const log = vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()

      await statewrightExtension(asPi(pi))

      expect(pi.registerTool).toHaveBeenCalledTimes(9)
      const names = pi._tools.map((t) => t.name)
      expect(names).toContain("statewright_get_state")
      expect(names).toContain("statewright_transition")
      expect(names).toContain("statewright_list_workflows")
      expect(names).toContain("statewright_load_workflow")

      expect(pi.on).toHaveBeenCalledTimes(7)
      expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function))
      expect(pi.on).toHaveBeenCalledWith("context", expect.any(Function))
      expect(pi.on).toHaveBeenCalledWith("before_provider_request", expect.any(Function))
      expect(pi.on).toHaveBeenCalledWith("tool_call", expect.any(Function))
      expect(pi.on).toHaveBeenCalledWith("tool_result", expect.any(Function))
      expect(pi.on).toHaveBeenCalledWith("message_end", expect.any(Function))

      log.mockRestore()
    })
  })

  describe("tool enforcement", () => {
    it("blocks tools not in allowed_tools", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))

      // Trigger before_agent_start to populate state cache
      await pi._fire("before_agent_start", {}, ctx)

      // Write is not in allowed_tools ["Read", "Edit", "Bash"]
      const results = await pi._fire("tool_call", { toolName: "Write" }, ctx)

      expect(results[0]).toEqual(expect.objectContaining({
        block: true,
        reason: expect.stringContaining("Write"),
      }))
    })

    it("allows tools in allowed_tools", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      const results = await pi._fire("tool_call", { toolName: "Edit" }, ctx)

      expect(results[0]).toBeUndefined()
    })

    it("blocks tool calls with undefined or empty name", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      // undefined toolName
      const results1 = await pi._fire("tool_call", { toolName: undefined }, ctx)
      expect(results1[0]).toEqual(expect.objectContaining({ block: true }))

      // empty string toolName
      const results2 = await pi._fire("tool_call", { toolName: "" }, ctx)
      expect(results2[0]).toEqual(expect.objectContaining({ block: true }))
    })

    it("never blocks statewright_ tools", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      const results = await pi._fire("tool_call", { toolName: "statewright_transition" }, ctx)

      expect(results[0]).toBeUndefined()
    })
  })

  describe("context injection", () => {
    it("injects state context with autonomous mode directive", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      const results = await pi._fire("before_agent_start", {}, ctx)
      const result = results[0] as { systemPrompt?: string }

      expect(result).toHaveProperty("systemPrompt")
      expect(result.systemPrompt).toContain("Work autonomously")
      expect(result.systemPrompt).toContain("implementing")
      expect(result.systemPrompt).toContain("read, edit, bash")
      expect(result.systemPrompt).toContain("DONE (-> testing)")
    })

    it("updates status bar", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "!statewright",
        expect.stringContaining("implementing"),
      )
    })
  })

  describe("interrupt detection", () => {
    it("triggers interrupt when file matches pattern", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      // Edit a PB hook file
      await pi._fire("tool_result", {
        toolName: "Edit",
        toolInput: { file_path: "site/pb/hooks/auth.pb.js" },
      }, ctx)

      // Should have notified about interrupt
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("INTERRUPT"),
        "warn",
      )

      // Should have called gateway with INTERRUPT: transition
      const calls = fetchMock.mock.calls as Array<[string, RequestInit]>
      const interruptCall = calls.find((c) => {
        if (!c[1]?.body) return false
        const body = JSON.parse(c[1].body as string)
        return body.params?.arguments?.event?.startsWith("INTERRUPT:")
      })
      expect(interruptCall).toBeDefined()
    })

    it("does not trigger for non-matching files", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      await pi._fire("tool_result", {
        toolName: "Edit",
        toolInput: { file_path: "src/main.rs" },
      }, ctx)

      expect(ctx.ui.notify).not.toHaveBeenCalled()
    })

    it("does not trigger for non-edit tools", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      await pi._fire("tool_result", {
        toolName: "Read",
        toolInput: { file_path: "site/pb/hooks/auth.pb.js" },
      }, ctx)

      expect(ctx.ui.notify).not.toHaveBeenCalled()
    })
  })

  describe("statewright tools", () => {
    it("get_state returns state JSON", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()

      await statewrightExtension(asPi(pi))

      const tool = pi._tools.find((t) => t.name === "statewright_get_state")!
      const result = await tool.execute("call-1", {})

      expect(result.content[0].type).toBe("text")
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.state).toBe("implementing")
    })

    it("transition sends event to gateway", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()

      await statewrightExtension(asPi(pi))

      const tool = pi._tools.find((t) => t.name === "statewright_transition")!
      await tool.execute("call-1", { event: "DONE", data: { rationale: "test" } })

      const calls = fetchMock.mock.calls as Array<[string, RequestInit]>
      const transitionCall = calls.find((c) => {
        if (!c[1]?.body) return false
        const body = JSON.parse(c[1].body as string)
        return body.params?.arguments?.event === "DONE"
      })
      expect(transitionCall).toBeDefined()
    })
  })

  describe("post-tool state tracking", () => {
    it("refreshes state after statewright tool calls", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))

      await pi._fire("tool_result", { toolName: "statewright_transition" }, ctx)

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "!statewright",
        expect.stringContaining("implementing"),
      )
    })

    it("notifies on final state", async () => {
      const finalState = { ...MOCK_STATE, state: "completed", is_final: true }
      setupFetch([{ match: "/mcp", body: finalState }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))

      await pi._fire("tool_result", { toolName: "statewright_transition" }, ctx)

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "[statewright] Workflow complete.",
        "success",
      )
    })
  })

  describe("tool call recovery (message_end)", () => {
    it("executes extracted tool calls via pi.exec and feeds results back", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      await pi._fire("message_end", {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: '{"tool_calls": [{"name": "read", "args": {"path": "src/main.rs"}}]}' },
          ],
        },
      }, ctx)

      // Should have called pi.exec to execute the tool
      expect(pi.exec).toHaveBeenCalledWith("cat", ["src/main.rs"])
      // Flush deferred sendUserMessage (setTimeout(0) in recovery handler)
      await new Promise(r => setTimeout(r, 10))
      // Should feed results back via sendUserMessage with state-aware guidance
      expect(pi.sendUserMessage).toHaveBeenCalledWith(
        expect.stringMatching(/mock exec output/),
        expect.objectContaining({ deliverAs: expect.stringMatching(/steer|followUp/) }),
      )
    })

    it("does not intervene when real toolCall blocks exist", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      await pi._fire("message_end", {
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", toolCallId: "real-1", toolName: "read", args: { path: "test.txt" } },
          ],
        },
      }, ctx)

      expect(pi.exec).not.toHaveBeenCalled()
      expect(pi.sendUserMessage).not.toHaveBeenCalled()
    })

    it("does not intervene on plain text responses", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      await pi._fire("message_end", {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will now read the file to understand the bug." },
          ],
        },
      }, ctx)

      expect(pi.exec).not.toHaveBeenCalled()
    })

    it("executes function-format JSON tool calls", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      await pi._fire("message_end", {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: '{"type": "function", "name": "edit", "parameters": {"path": "app.py", "old": "foo", "new": "bar"}}' },
          ],
        },
      }, ctx)

      // Flush deferred sendUserMessage
      await new Promise(r => setTimeout(r, 10))
      // edit recovery should send results back
      expect(pi.sendUserMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ deliverAs: expect.stringMatching(/steer|followUp/) }),
      )
    })

    it("executes unrecognized tools with error message in results", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      await pi._fire("message_end", {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: '{"tool_calls": [{"name": "deploy_to_prod", "args": {"env": "production"}}]}' },
          ],
        },
      }, ctx)

      // Flush deferred sendUserMessage
      await new Promise(r => setTimeout(r, 10))
      // Should still execute (with error) and feed back
      expect(pi.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("not executable"),
        expect.objectContaining({ deliverAs: expect.stringMatching(/steer|followUp/) }),
      )
    })

    it("normalizes tool names before execution (Read -> cat)", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      await pi._fire("message_end", {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: '{"tool_calls": [{"name": "Read", "args": {"path": "src/main.rs"}}]}' },
          ],
        },
      }, ctx)

      // Read normalizes to "read", which executes via cat
      expect(pi.exec).toHaveBeenCalledWith("cat", ["src/main.rs"])
    })
  })

  describe("per-state model switching", () => {
    const MODEL_STATE = {
      ...MOCK_STATE,
      model: "anthropic/claude-haiku-4-5-20251001",
    }

    it("switches model when state has model field (provider/id format)", async () => {
      setupFetch([{ match: "/mcp", body: MODEL_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      expect(pi.setModel).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "anthropic", id: "claude-haiku-4-5-20251001" }),
      )
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Model"),
        "info",
      )
    })

    it("finds model by bare id when provider/id format not found", async () => {
      const bareState = { ...MOCK_STATE, model: "claude-opus-4-6" }
      setupFetch([{ match: "/mcp", body: bareState }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      expect(pi.setModel).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "anthropic", id: "claude-opus-4-6" }),
      )
    })

    it("does not switch model when already on the correct model", async () => {
      setupFetch([{ match: "/mcp", body: MODEL_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))

      // First call — switches
      await pi._fire("before_agent_start", {}, ctx)
      expect(pi.setModel).toHaveBeenCalledTimes(1)

      // Second call — same model, no switch
      await pi._fire("before_agent_start", {}, ctx)
      expect(pi.setModel).toHaveBeenCalledTimes(1)
    })

    it("warns when model not found in registry", async () => {
      const unknownState = { ...MOCK_STATE, model: "deepseek/deepseek-r3" }
      setupFetch([{ match: "/mcp", body: unknownState }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      process.env.STATEWRIGHT_DEBUG = "1"
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      expect(pi.setModel).not.toHaveBeenCalled()
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("NOT FOUND in registry"))
      errorSpy.mockRestore()
      delete process.env.STATEWRIGHT_DEBUG
    })

    it("does not switch when state has no model field", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      expect(pi.setModel).not.toHaveBeenCalled()
    })

    it("shows model in status bar", async () => {
      setupFetch([{ match: "/mcp", body: MODEL_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "!statewright",
        expect.stringContaining("claude-haiku-4-5-20251001"),
      )
    })

    it("shows downgrade indicator when model is cheaper than default", async () => {
      const stateWithDefault = {
        ...MOCK_STATE,
        model: "anthropic/claude-haiku-4-5-20251001",
        default_model: "anthropic/claude-opus-4-6",
      }
      setupFetch([{ match: "/mcp", body: stateWithDefault }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      // Should show ↓ for cheaper model
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "!statewright",
        expect.stringContaining("\u2193"),
      )
    })

    it("shows upgrade indicator when model is more expensive than default", async () => {
      const stateWithDefault = {
        ...MOCK_STATE,
        model: "anthropic/claude-opus-4-6",
        default_model: "claude-haiku-4-5-20251001",
      }
      setupFetch([{ match: "/mcp", body: stateWithDefault }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      // Should show ↑ for more expensive model
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "!statewright",
        expect.stringContaining("\u2191"),
      )
    })

    it("restores original model when entering state with no model", async () => {
      // Simulate: start on opus, switch to haiku for one state, then enter state with no model
      const opusModel = MOCK_MODELS[2] // opus — user's starting model
      setupFetch([{ match: "/mcp", body: MODEL_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx(opusModel)

      await statewrightExtension(asPi(pi))

      // First turn: state has model → switch to haiku, save opus as original
      await pi._fire("before_agent_start", {}, ctx)
      expect(pi.setModel).toHaveBeenCalledTimes(1)
      expect(pi.setModel).toHaveBeenCalledWith(
        expect.objectContaining({ id: "claude-haiku-4-5-20251001" }),
      )

      // Now gateway returns a state with no model (simulating transition)
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])  // MOCK_STATE has no model field

      // Second turn: state has no model → restore opus
      await pi._fire("before_agent_start", {}, ctx)
      expect(pi.setModel).toHaveBeenCalledTimes(2)
      expect(pi.setModel).toHaveBeenLastCalledWith(opusModel)
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("restored"),
        "info",
      )
    })

    it("does nothing when no model set anywhere", async () => {
      // Pure backward compat: no model fields, no switching, no restore
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)
      await pi._fire("before_agent_start", {}, ctx)
      await pi._fire("before_agent_start", {}, ctx)

      expect(pi.setModel).not.toHaveBeenCalled()
    })

    it("switches across providers (openai-codex to anthropic)", async () => {
      // Start on gpt-5.4, state routes to opus — cross-provider switch
      const crossProviderState = { ...MOCK_STATE, model: "anthropic/claude-opus-4-6" }
      setupFetch([{ match: "/mcp", body: crossProviderState }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const gptModel = MOCK_MODELS.find((m) => m.id === "gpt-5.4")!
      const ctx = createCtx(gptModel)

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      // Should switch to opus (different provider)
      expect(pi.setModel).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "anthropic", id: "claude-opus-4-6" }),
      )

      // Transition to state with no model — should restore gpt-5.4
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      await pi._fire("before_agent_start", {}, ctx)
      expect(pi.setModel).toHaveBeenCalledTimes(2)
      expect(pi.setModel).toHaveBeenLastCalledWith(gptModel)
    })
  })

  describe("upstream failure handling", () => {
    // State with FAIL transition — matches the chaos-bugfix/reconnaissance pattern
    const RECON_STATE = {
      ...MOCK_STATE,
      state: "reconnaissance",
      iteration: 0,
      max_iterations: 12,
      allowed_tools: ["Read", "Grep", "Find", "LS", "Bash"],
      instructions: "Run the test suite first to see what fails.",
      transitions: [
        { event: "FAIL", target: "failed" },
        { event: "HYPOTHESIS_FORMED", target: "planning" },
      ],
    }

    it("auto-continuation increments nudgeCount and stops after MAX_NUDGES", async () => {
      setupFetch([{ match: "/mcp", body: RECON_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      // Fire message_end with text but no tool calls — simulates timeout partial output
      // Each call should count toward the nudge limit
      const timeoutMessage = {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "<thought\n<channel|><thought" }],
        },
      }

      // Fire MAX_NUDGES + 2 times (with clock advancing to bypass cooldown)
      for (let i = 0; i < 8; i++) {
        // Advance lastNudgeTime past cooldown
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + (i + 1) * 31000)
        await pi._fire("message_end", timeoutMessage, ctx)
      }

      // After exceeding MAX_NUDGES, sendUserMessage should have been called with
      // auto-continuation messages but should STOP after the limit.
      // The last calls should include FAIL transition attempt.
      const calls = pi.sendUserMessage.mock.calls
      const lastCall = calls[calls.length - 1]
      // Should NOT keep sending "Continue working" messages forever
      // Either stops sending or transitions to FAIL
      expect(calls.length).toBeLessThanOrEqual(8) // bounded, not infinite
    })

    it("blocked tool calls do NOT reset inactivity counter", async () => {
      setupFetch([{ match: "/mcp", body: RECON_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      // Fire a text-only message to trigger auto-continuation (start nudge counting)
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31000)
      await pi._fire("message_end", {
        message: { role: "assistant", content: [{ type: "text", text: "thinking..." }] },
      }, ctx)
      expect(pi.sendUserMessage).toHaveBeenCalled()
      const callsAfterNudge = pi.sendUserMessage.mock.calls.length

      // Now fire a BLOCKED tool call (Write is not in allowed_tools)
      await pi._fire("tool_call", { toolName: "Write" }, ctx)

      // Fire another text-only message — nudge count should NOT have reset
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 62000)
      await pi._fire("message_end", {
        message: { role: "assistant", content: [{ type: "text", text: "still thinking..." }] },
      }, ctx)

      // If nudgeCount was NOT reset, the second nudge message should show escalation (STUCK/FINAL WARNING)
      const allCalls = pi.sendUserMessage.mock.calls
      const lastMsg = allCalls[allCalls.length - 1]?.[0] as string
      // Should NOT be a fresh "Continue working" (nudge 0) — should be escalated
      expect(lastMsg).not.toContain("Continue working")
    })

    it("extracts tool calls from <call:tool{args}<tool_call|> format", async () => {
      setupFetch([{ match: "/mcp", body: RECON_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      await pi._fire("message_end", {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: '<call:bash{command: "pytest -q"}<tool_call|>' },
          ],
        },
      }, ctx)

      // Should have executed via pi.exec
      expect(pi.exec).toHaveBeenCalledWith("bash", ["-c", "pytest -q"])
      await new Promise(r => setTimeout(r, 10))
      expect(pi.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Continue"),
        expect.objectContaining({ deliverAs: expect.stringMatching(/steer|followUp/) }),
      )
    })

    it("extracts tool calls from <call:read{path: \"file.py\"}<tool_call|> format", async () => {
      setupFetch([{ match: "/mcp", body: RECON_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      await pi._fire("message_end", {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: '<call:read{path: "registry.py"}<tool_call|>' },
          ],
        },
      }, ctx)

      expect(pi.exec).toHaveBeenCalledWith("cat", ["registry.py"])
    })

    it("auto-FAIL transitions to failed state when upstream repeatedly fails", async () => {
      // Set up fetch to handle both get_state AND statewright_transition
      const failedState = { ...RECON_STATE, state: "failed", is_final: true }
      setupFetch([
        { match: "statewright_transition", body: { transitioned: true, from: "reconnaissance", to: "failed" } },
        { match: "/mcp", body: RECON_STATE },
      ])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      // Simulate MAX_NUDGES+1 timeouts — each fires message_end with partial text
      for (let i = 0; i < 8; i++) {
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + (i + 1) * 31000)
        await pi._fire("message_end", {
          message: { role: "assistant", content: [{ type: "text", text: "Error: Request timed out." }] },
        }, ctx)
      }

      // After exceeding limit, should have attempted FAIL transition via gateway
      expect(fetchMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.stringContaining("statewright_transition"),
        }),
      )
    })
  })

  describe("plugin orchestration", () => {
    const PLUGIN_STATE = {
      ...MOCK_STATE,
      meta: { orchestration: "plugin", task_description: "Fix the LIFO bug in hooks.py" },
    }

    const AGENTIC_STATE = {
      ...MOCK_STATE,
      // no meta.orchestration — default agentic behavior
    }

    it("context hook replaces messages with fresh prompt in plugin mode", async () => {
      setupFetch([{ match: "/mcp", body: PLUGIN_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      // Simulate 50 accumulated messages (33k tokens worth)
      const accumulated = Array.from({ length: 50 }, (_, i) => ({
        role: "user",
        content: [{ type: "text", text: `Accumulated message ${i} with lots of context padding` }],
      }))

      const results = await pi._fire("context", { messages: accumulated }, ctx)
      const result = results[0] as { messages?: unknown[] }

      // Should window to at most PLUGIN_CONTEXT_WINDOW (6) messages
      expect(result).toHaveProperty("messages")
      expect(result.messages!.length).toBeLessThanOrEqual(6)
    })

    it("context hook is no-op in agentic mode", async () => {
      setupFetch([{ match: "/mcp", body: AGENTIC_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      const results = await pi._fire("context", {
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }, ctx)

      // Should return undefined — no modification
      expect(results[0]).toBeUndefined()
    })

    it("windows messages to at most PLUGIN_CONTEXT_WINDOW entries", async () => {
      setupFetch([{ match: "/mcp", body: PLUGIN_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      // 20 messages — should be windowed down
      const messages = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `Message ${i}` }],
      }))

      const results = await pi._fire("context", { messages }, ctx)
      const result = results[0] as { messages?: unknown[] }

      expect(result).toHaveProperty("messages")
      expect(result.messages!.length).toBeLessThanOrEqual(6)
      // Should keep the LAST messages, not the first
      const lastMsg = JSON.stringify(result.messages![result.messages!.length - 1])
      expect(lastMsg).toContain("Message 19")
    })

    it("captures last tool result for next prompt", async () => {
      setupFetch([{ match: "/mcp", body: PLUGIN_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      // Simulate a tool result — lastToolResult should be set
      await pi._fire("tool_result", {
        toolName: "bash",
        input: { command: "ls -la" },
        content: [{ type: "text", text: "total 42\ndrwxr-xr-x  5 user staff 160 hooks.py" }],
      }, ctx)

      // Context hook uses sliding window — with empty messages, returns empty
      // lastToolResult is consumed by buildFreshSystemPrompt in before_agent_start
      const results = await pi._fire("context", { messages: [] }, ctx)
      const result = results[0] as { messages?: unknown[] }
      expect(result).toHaveProperty("messages")
    })

    it("auto-transitions TESTS_PASS when tests pass", async () => {
      const testingState = {
        ...PLUGIN_STATE,
        state: "testing",
        allowed_tools: ["Read", "Bash"],
        transitions: [
          { event: "TESTS_PASS", target: "review" },
          { event: "TESTS_FAIL", target: "implementing" },
          { event: "FAIL", target: "failed" },
        ],
      }
      setupFetch([
        { match: "statewright_transition", body: { transitioned: true, from: "testing", to: "review" } },
        { match: "/mcp", body: testingState },
      ])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      // Push nudge count near limit — auto-transition is last-resort only
      for (let i = 0; i < 5; i++) {
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + (i + 1) * 31000)
        await pi._fire("message_end", {
          message: { role: "assistant", content: [{ type: "text", text: "thinking..." }] },
        }, ctx)
      }

      // Simulate passing test output — should auto-fire near limit
      await pi._fire("tool_result", {
        toolName: "bash",
        input: { command: "pytest -q" },
        content: [{ type: "text", text: "12 passed in 0.05s" }],
      }, ctx)

      // Should have attempted TESTS_PASS transition
      expect(fetchMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.stringContaining("TESTS_PASS"),
        }),
      )
    })

    it("auto-transitions TESTS_FAIL when tests fail", async () => {
      const testingState = {
        ...PLUGIN_STATE,
        state: "testing",
        allowed_tools: ["Read", "Bash"],
        transitions: [
          { event: "TESTS_PASS", target: "review" },
          { event: "TESTS_FAIL", target: "implementing" },
          { event: "FAIL", target: "failed" },
        ],
      }
      setupFetch([
        { match: "statewright_transition", body: { transitioned: true, from: "testing", to: "implementing" } },
        { match: "/mcp", body: testingState },
      ])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      // Push nudge count near limit
      for (let i = 0; i < 5; i++) {
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + (i + 1) * 31000)
        await pi._fire("message_end", {
          message: { role: "assistant", content: [{ type: "text", text: "thinking..." }] },
        }, ctx)
      }

      // Simulate failing test output
      await pi._fire("tool_result", {
        toolName: "bash",
        input: { command: "pytest tests/" },
        content: [{ type: "text", text: "3 failed, 9 passed in 0.02s" }],
      }, ctx)

      // Should have attempted TESTS_FAIL transition
      expect(fetchMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.stringContaining("TESTS_FAIL"),
        }),
      )
    })

    it("does not auto-transition when event not available in state", async () => {
      // State has no TESTS_PASS/TESTS_FAIL transitions
      const planningState = {
        ...PLUGIN_STATE,
        state: "planning",
        allowed_tools: ["Read", "Bash"],
        transitions: [
          { event: "PLAN_READY", target: "implementing" },
          { event: "FAIL", target: "failed" },
        ],
      }
      setupFetch([{ match: "/mcp", body: planningState }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      // Run tests — output looks like pass
      await pi._fire("tool_result", {
        toolName: "bash",
        input: { command: "pytest -q" },
        content: [{ type: "text", text: "12 passed in 0.05s" }],
      }, ctx)

      // Should NOT have attempted any transition (no TESTS_PASS in this state)
      const calls = (fetchMock.mock.calls as Array<[string, RequestInit]>).filter(c => {
        if (!c[1]?.body) return false
        return (c[1].body as string).includes("TESTS_PASS")
      })
      expect(calls).toHaveLength(0)
    })

    it("rewrites tool role for Gemma models in before_provider_request", async () => {
      setupFetch([{ match: "/mcp", body: PLUGIN_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const gemmaModel = { provider: "ollama", id: "gemma4:31b", name: "Gemma 4 31B" }
      const ctx = createCtx(gemmaModel)

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      const payload = {
        model: "gemma4:31b",
        messages: [
          { role: "system", content: "You are..." },
          { role: "user", content: "Fix the bug" },
          { role: "tool", content: "file contents", tool_call_id: "1" },
          { role: "tool", content: "more contents", tool_call_id: "2" },
        ],
      }

      await pi._fire("before_provider_request", { payload }, ctx)

      // Both tool messages should be rewritten
      expect(payload.messages[2].role).toBe("tool_responses")
      expect(payload.messages[3].role).toBe("tool_responses")
      // Non-tool messages unchanged
      expect(payload.messages[0].role).toBe("system")
      expect(payload.messages[1].role).toBe("user")
    })

    it("does not rewrite roles for non-Gemma models", async () => {
      setupFetch([{ match: "/mcp", body: PLUGIN_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx() // default opus

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      const payload = {
        model: "claude-opus-4-6",
        messages: [
          { role: "tool", content: "file contents", tool_call_id: "1" },
        ],
      }

      await pi._fire("before_provider_request", { payload }, ctx)
      expect(payload.messages[0].role).toBe("tool") // unchanged
    })
  })
})
