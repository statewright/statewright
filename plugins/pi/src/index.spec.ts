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
  },
}))

import { readFileSync } from "node:fs"
import statewrightExtension from "./index.js"

// --- Types ---

interface RegisteredTool {
  name: string
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>
}

interface MockUI {
  setStatus: Mock
  notify: Mock
}

interface MockCtx {
  ui: MockUI
}

type EventHandler = (event: Record<string, unknown>, ctx: MockCtx) => Promise<unknown>

interface MockPi {
  registerTool: Mock
  on: Mock
  sendUserMessage: Mock
  exec: Mock
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

function createCtx(): MockCtx {
  return { ui: { setStatus: vi.fn(), notify: vi.fn() } }
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

      expect(pi.registerTool).toHaveBeenCalledTimes(4)
      const names = pi._tools.map((t) => t.name)
      expect(names).toContain("statewright_get_state")
      expect(names).toContain("statewright_transition")
      expect(names).toContain("statewright_list_workflows")
      expect(names).toContain("statewright_load_workflow")

      expect(pi.on).toHaveBeenCalledTimes(4)
      expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function))
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
      const result = results[0] as { appendSystemPrompt?: string }

      expect(result).toHaveProperty("appendSystemPrompt")
      expect(result.appendSystemPrompt).toContain("MUST work autonomously")
      expect(result.appendSystemPrompt).toContain("implementing")
      expect(result.appendSystemPrompt).toContain("read, edit, bash")
      expect(result.appendSystemPrompt).toContain("DONE (-> testing)")
    })

    it("updates status bar", async () => {
      setupFetch([{ match: "/mcp", body: MOCK_STATE }])
      vi.spyOn(console, "log").mockImplementation(() => {})
      const pi = createMockPi()
      const ctx = createCtx()

      await statewrightExtension(asPi(pi))
      await pi._fire("before_agent_start", {}, ctx)

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "statewright",
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
        "statewright",
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
      // Should feed results back via sendUserMessage
      expect(pi.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("executed your tool calls"),
        expect.objectContaining({ deliverAs: "steer" }),
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

      // edit is not shell-executable, should still send results back
      expect(pi.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("executed your tool calls"),
        expect.objectContaining({ deliverAs: "steer" }),
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

      // Should still execute (with error) and feed back
      expect(pi.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("not executable via recovery"),
        expect.objectContaining({ deliverAs: "steer" }),
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
})
