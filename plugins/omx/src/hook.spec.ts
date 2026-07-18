/**
 * Tests for statewright OMX hook plugin
 *
 * The OMX plugin runs as a one-shot Codex native hook command.
 * Input: JSON on stdin. Output: Codex hook JSON on stdout.
 * State cache: file-based in ~/.statewright/sessions/<key>/
 *
 * We test the exported handler functions directly, mocking fetch (gateway)
 * and fs (state cache / api key).
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest"

// Mock node:fs before imports
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/test"),
}))

vi.mock("minimatch", () => ({
  minimatch: vi.fn((path: string, pattern: string) => {
    // Minimal mock: match *.test.js and **/*.pb.js patterns
    if (pattern.includes("*.pb.js") && path.endsWith(".pb.js")) return true
    if (pattern.includes("*.test.js") && path.endsWith(".test.js")) return true
    if (pattern.includes("*.env") && path.includes(".env")) return true
    return false
  }),
}))

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import {
  checkToolAllowed,
  classifyBashCommand,
  classifyReadOnlyShellCommand,
  formatStateContext,
  checkInterrupts,
  handleUserPrompt,
  handlePreTool,
  handlePostTool,
  handleStop,
  type StateCache,
  type HookInput,
} from "./hook.js"

// --- Fixtures ---

const API_KEY = "sw_live_testkey123"

const MOCK_STATE: StateCache = {
  state: "implementing",
  isFinal: false,
  iteration: 3,
  maxIterations: 10,
  allowedTools: ["Read", "Edit", "Bash"],
  instructions: "Implement the fix",
  transitions: [
    { event: "DONE", target: "testing" },
    { event: "FAIL", target: "failed" },
  ],
  context: {},
  interrupts: {
    pb_check: { file_pattern: "**/*.pb.js", target: "pb_validating" },
  },
  allowedCommands: [],
  blockedEnv: [],
}

const MOCK_GW_STATE = {
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
    pb_check: { file_pattern: "**/*.pb.js", target: "pb_validating" },
  },
}

// --- Fetch mock helpers ---

let originalFetch: typeof globalThis.fetch
let fetchMock: Mock

interface JsonRpcBody {
  jsonrpc: string
  id: number
  method: string
  params?: { name?: string; arguments?: Record<string, unknown> }
}

function setupFetch(handler: (url: string, body: JsonRpcBody | null) => Record<string, unknown> | null) {
  fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString()
    const body = init?.body ? JSON.parse(init.body as string) : null
    const result = handler(urlStr, body)
    if (result === null) {
      return { ok: false, status: 503, headers: new Headers() } as Response
    }
    return {
      ok: true,
      headers: new Headers({ "mcp-session-id": "test-session" }),
      json: async () => ({
        jsonrpc: "2.0",
        id: body?.id ?? 1,
        result: { content: [{ type: "text", text: JSON.stringify(result) }] },
      }),
    } as Response
  })
  globalThis.fetch = fetchMock
}

function setupGateway(stateResponse = MOCK_GW_STATE) {
  setupFetch((_url, body) => {
    if (body?.method === "tools/call") {
      if (body.params?.name === "statewright_get_state") return stateResponse
      if (body.params?.name === "statewright_transition") {
        return { transitioned: true, from: "implementing", to: "testing" }
      }
      if (body.params?.name === "statewright_list_workflows") {
        return { workflows: ["bugfix", "tdd-feature"] }
      }
    }
    return stateResponse
  })
}

// --- Handler options factory ---

function makeOpts(overrides: Record<string, string | null> = {}) {
  return {
    apiKey: API_KEY,
    gwUrl: "http://localhost:3001",
    sessionDir: "/home/test/.statewright/sessions/abc12345",
    ...overrides,
  }
}

// --- Tests ---

describe("pure logic", () => {
  describe("checkToolAllowed", () => {
    it("allows tools in allowedTools list", () => {
      const result = checkToolAllowed("Edit", MOCK_STATE)
      expect(result.allowed).toBe(true)
    })

    it("denies tools not in allowedTools list", () => {
      const result = checkToolAllowed("Write", MOCK_STATE)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain("Write")
      expect(result.reason).toContain("implementing")
    })

    it("always allows statewright_ tools", () => {
      const result = checkToolAllowed("statewright_transition", MOCK_STATE)
      expect(result.allowed).toBe(true)
    })

    it("always allows system tools (TodoRead, Agent, etc)", () => {
      for (const tool of ["TodoRead", "TodoWrite", "Agent", "SendMessage", "AskUserQuestion", "TaskCreate", "TaskUpdate", "Skill", "ToolSearch"]) {
        const result = checkToolAllowed(tool, MOCK_STATE)
        expect(result.allowed).toBe(true)
      }
    })

    it("allows everything when allowedTools is empty", () => {
      const noRestrictions = { ...MOCK_STATE, allowedTools: [] }
      const result = checkToolAllowed("Write", noRestrictions)
      expect(result.allowed).toBe(true)
    })

    it("includes available transitions in denial reason", () => {
      const result = checkToolAllowed("Write", MOCK_STATE)
      expect(result.reason).toContain("DONE")
      expect(result.reason).toContain("FAIL")
    })

    it("maps Codex apply_patch to Edit or Write capability", () => {
      expect(checkToolAllowed("apply_patch", MOCK_STATE).allowed).toBe(true)
      const writeOnly = { ...MOCK_STATE, allowedTools: ["Write"] }
      expect(checkToolAllowed("apply_patch", writeOnly).allowed).toBe(true)
    })

    it("maps Codex web run operations to the matching web capability", () => {
      const search = { ...MOCK_STATE, allowedTools: ["WebSearch"] }
      expect(checkToolAllowed("webrun", search, { search_query: [{ q: "gridmap" }] }).allowed).toBe(true)
      expect(checkToolAllowed("webrun", search, { open: [{ ref_id: "result" }] }).allowed).toBe(false)

      const fetch = { ...MOCK_STATE, allowedTools: ["WebFetch"] }
      expect(checkToolAllowed("web__run", fetch, { open: [{ ref_id: "result" }] }).allowed).toBe(true)
    })

    it("maps Codex Bash reads to Read/Grep/Glob without granting arbitrary shell", () => {
      const readOnly = { ...MOCK_STATE, allowedTools: ["Read", "Grep", "Glob"] }
      expect(checkToolAllowed("Bash", readOnly, { command: "sed -n '1,80p' src/main.ts" }).allowed).toBe(true)
      expect(checkToolAllowed("Bash", readOnly, { command: "rg -n 'needle' src | head -20" }).allowed).toBe(true)
      expect(checkToolAllowed("Bash", readOnly, { command: "npm test" }).allowed).toBe(false)
    })
  })

  describe("classifyReadOnlyShellCommand", () => {
    it("allows common read pipelines and discarded stderr", () => {
      expect(classifyReadOnlyShellCommand("rg -n foo src 2>/dev/null | head -20").allowed).toBe(true)
      expect(classifyReadOnlyShellCommand("git status --short; git diff -- src/main.ts").allowed).toBe(true)
      expect(classifyReadOnlyShellCommand("find src -type f | sort").allowed).toBe(true)
    })

    it("blocks writes, interpreters, subprocesses, and executable find actions", () => {
      for (const command of [
        "echo changed > file.txt",
        "python3 inspect.py",
        "cat $(touch marker)",
        "find src -type f -exec sh -c 'touch marker' \\;",
        "sed -i 's/a/b/' file.txt",
        "npm test",
      ]) {
        expect(classifyReadOnlyShellCommand(command).allowed, command).toBe(false)
      }
    })
  })

  describe("classifyBashCommand", () => {
    it("allows normal read commands", () => {
      const result = classifyBashCommand("ls -la", MOCK_STATE)
      expect(result.allowed).toBe(true)
    })

    it("blocks file redirects when Write/Edit not both allowed", () => {
      const noWrite = { ...MOCK_STATE, allowedTools: ["Read", "Bash"] }
      const result = classifyBashCommand("echo hello > file.txt", noWrite)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain("redirect")
    })

    it("allows file redirects when Write is allowed", () => {
      const withWrite = { ...MOCK_STATE, allowedTools: ["Read", "Bash", "Write"] }
      const result = classifyBashCommand("echo hello > file.txt", withWrite)
      expect(result.allowed).toBe(true)
    })

    it("blocks sed -i when Edit not allowed", () => {
      const noEdit = { ...MOCK_STATE, allowedTools: ["Read", "Bash"] }
      const result = classifyBashCommand("sed -i 's/old/new/' file.txt", noEdit)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain("in-place")
    })

    it("blocks scripting interpreters when Write/Edit not allowed", () => {
      const noWrite = { ...MOCK_STATE, allowedTools: ["Read", "Bash"] }
      for (const cmd of ["python script.py", "python3 -c 'open(\"f\",\"w\")'", "ruby gen.rb", "node build.js", "perl -e '...'"]) {
        const result = classifyBashCommand(cmd, noWrite)
        expect(result.allowed).toBe(false)
        expect(result.reason).toContain("interpreter")
      }
    })

    it("blocks destructive operations", () => {
      for (const cmd of ["rm -rf /tmp", "rmdir foo", "shred secret.txt", "truncate -s0 log"]) {
        const result = classifyBashCommand(cmd, MOCK_STATE)
        expect(result.allowed).toBe(false)
        expect(result.reason).toContain("Destructive")
      }
    })

    it("blocks chained destructive operations", () => {
      const result = classifyBashCommand("echo done && rm -rf build/", MOCK_STATE)
      expect(result.allowed).toBe(false)
    })

    it("enforces allowed_commands when present", () => {
      const withCmds = { ...MOCK_STATE, allowedCommands: ["npm test", "npm run", "git status"] }
      expect(classifyBashCommand("npm test", withCmds).allowed).toBe(true)
      expect(classifyBashCommand("npm run build", withCmds).allowed).toBe(true)
      expect(classifyBashCommand("cargo build", withCmds).allowed).toBe(false)
    })

    it("blocks commands referencing blocked env vars", () => {
      const withBlocked = { ...MOCK_STATE, blockedEnv: ["PROD_DB_URL", "SECRET_KEY"] }
      const result = classifyBashCommand("curl $PROD_DB_URL/api", withBlocked)
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain("restricted env")
    })
  })

  describe("formatStateContext", () => {
    it("includes autonomous mode directive", () => {
      const ctx = formatStateContext(MOCK_STATE)
      expect(ctx).toContain("AUTONOMOUS MODE")
    })

    it("includes state name and iteration", () => {
      const ctx = formatStateContext(MOCK_STATE)
      expect(ctx).toContain("implementing")
      expect(ctx).toContain("3/10")
    })

    it("includes allowed tools", () => {
      const ctx = formatStateContext(MOCK_STATE)
      expect(ctx).toContain("Read, Edit, Bash")
    })

    it("includes transitions", () => {
      const ctx = formatStateContext(MOCK_STATE)
      expect(ctx).toContain("DONE -> testing")
      expect(ctx).toContain("FAIL -> failed")
    })

    it("includes instructions", () => {
      const ctx = formatStateContext(MOCK_STATE)
      expect(ctx).toContain("Implement the fix")
    })

    it("includes rationale mandate", () => {
      const ctx = formatStateContext(MOCK_STATE)
      expect(ctx).toContain("data.rationale")
    })

    it("notes interrupt handler when active", () => {
      const inHandler = { ...MOCK_STATE, interruptReturn: "implementing" }
      const ctx = formatStateContext(inHandler)
      expect(ctx).toContain("INTERRUPT HANDLER")
      expect(ctx).toContain("implementing")
    })

    it("notes fork when active", () => {
      const forked = { ...MOCK_STATE, fork: { active: true, currentBranch: "lint", branches: {} } }
      const ctx = formatStateContext(forked)
      expect(ctx).toContain("FORK")
      expect(ctx).toContain("lint")
    })
  })

  describe("checkInterrupts", () => {
    const interrupts = {
      pb_check: { file_pattern: "**/*.pb.js", target: "pb_validating" },
      env_check: { file_pattern: "*.env", target: "env_review" },
    }

    it("returns interrupt name when file matches", () => {
      const result = checkInterrupts("site/pb/hooks/auth.pb.js", interrupts)
      expect(result).toBe("pb_check")
    })

    it("returns null for non-matching files", () => {
      const result = checkInterrupts("src/main.rs", interrupts)
      expect(result).toBeNull()
    })

    it("returns null when interrupts map is empty", () => {
      const result = checkInterrupts("anything.pb.js", {})
      expect(result).toBeNull()
    })

    it("skips when already in interrupt handler", () => {
      const result = checkInterrupts("auth.pb.js", interrupts, "implementing")
      expect(result).toBeNull()
    })
  })
})

describe("handleUserPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    originalFetch = globalThis.fetch
    ;(existsSync as Mock).mockReturnValue(false)
    ;(readFileSync as Mock).mockImplementation(() => { throw new Error("ENOENT") })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("returns block when no API key", async () => {
    const result = await handleUserPrompt({} as HookInput, makeOpts({ apiKey: null }))
    expect(result).not.toBeNull()
    expect(result!.decision).toBe("block")
    expect(result!.reason).toContain("API key")
  })

  it("saves pasted API key from input", async () => {
    const input = { prompt: "here is my key sw_live_abc123def" } as HookInput
    const result = await handleUserPrompt(input, makeOpts({ apiKey: null }))
    expect(writeFileSync).toHaveBeenCalled()
    const writeCall = (writeFileSync as Mock).mock.calls[0]
    expect(writeCall[1]).toContain("sw_live_abc123def")
    expect(result!.hookSpecificOutput!.additionalContext).toContain("API key saved")
  })

  it("returns dormant hint when no active workflow (first time)", async () => {
    const result = await handleUserPrompt({} as HookInput, makeOpts())

    expect(result).not.toBeNull()
    expect(result!.hookSpecificOutput!.additionalContext).toContain("No workflow running")
    expect(result!.hookSpecificOutput!.additionalContext).toContain("statewright_start")
  })

  it("returns null when dormant and already hinted", async () => {
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".session_hinted") ? true : false
    )
    const result = await handleUserPrompt({} as HookInput, makeOpts())
    expect(result).toBeNull()
  })

  it("fetches state and injects context when workflow active", async () => {
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".active") ? true : false
    )
    setupGateway()

    const result = await handleUserPrompt({} as HookInput, makeOpts())

    expect(result).not.toBeNull()
    expect(result!.hookSpecificOutput!.additionalContext).toContain("AUTONOMOUS MODE")
    expect(result!.hookSpecificOutput!.additionalContext).toContain("implementing")
    // Should have written cache
    expect(writeFileSync).toHaveBeenCalled()
  })

  it("gracefully degrades when gateway unreachable", async () => {
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".active") ? true : false
    )
    setupFetch(() => null)

    const result = await handleUserPrompt({} as HookInput, makeOpts())

    expect(result!.hookSpecificOutput!.additionalContext).toContain("unreachable")
  })

  it("auto-deactivates on final state", async () => {
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".active") ? true : false
    )
    setupGateway({ ...MOCK_GW_STATE, state: "completed", is_final: true })

    const result = await handleUserPrompt({} as HookInput, makeOpts())

    expect(result!.hookSpecificOutput!.additionalContext).toContain("complete")
    expect(unlinkSync).toHaveBeenCalled()
  })
})

describe("handlePreTool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(existsSync as Mock).mockReturnValue(false)
    ;(readFileSync as Mock).mockImplementation(() => { throw new Error("ENOENT") })
  })

  it("allows everything when no active workflow", async () => {
    const input: HookInput = { tool_name: "Write" }
    const result = await handlePreTool(input, makeOpts())
    expect(result).toBeNull()
  })

  it("allows everything when no cache file", async () => {
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".active") ? true : false
    )
    const input: HookInput = { tool_name: "Write" }
    const result = await handlePreTool(input, makeOpts())
    expect(result).toBeNull()
  })

  it("denies tool not in allowed_tools", async () => {
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".active") || p.includes(".state_cache") ? true : false
    )
    ;(readFileSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".state_cache")) return JSON.stringify(MOCK_GW_STATE)
      throw new Error("ENOENT")
    })

    const input: HookInput = { tool_name: "Write" }
    const result = await handlePreTool(input, makeOpts())

    expect(result).not.toBeNull()
    expect(result!.hookSpecificOutput!.permissionDecision).toBe("deny")
    expect(result!.hookSpecificOutput!.permissionDecisionReason).toContain("Write")
  })

  it("allows tool in allowed_tools (silent pass)", async () => {
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".active") || p.includes(".state_cache") ? true : false
    )
    ;(readFileSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".state_cache")) return JSON.stringify(MOCK_GW_STATE)
      throw new Error("ENOENT")
    })

    const input: HookInput = { tool_name: "Read" }
    const result = await handlePreTool(input, makeOpts())
    expect(result).toBeNull()
  })

  it("allows a read-only Codex Bash command when the phase grants Read", async () => {
    const readOnlyState = { ...MOCK_GW_STATE, allowed_tools: ["Read", "Grep", "Glob"] }
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".active") || p.includes(".state_cache") ? true : false
    )
    ;(readFileSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".state_cache")) return JSON.stringify(readOnlyState)
      throw new Error("ENOENT")
    })

    const result = await handlePreTool(
      { tool_name: "Bash", tool_input: { command: "rg -n needle src | head -20" } },
      makeOpts(),
    )
    expect(result).toBeNull()
  })

  it("does not turn Read into unrestricted Codex Bash access", async () => {
    const readOnlyState = { ...MOCK_GW_STATE, allowed_tools: ["Read", "Grep", "Glob"] }
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".active") || p.includes(".state_cache") ? true : false
    )
    ;(readFileSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".state_cache")) return JSON.stringify(readOnlyState)
      throw new Error("ENOENT")
    })

    const result = await handlePreTool(
      { tool_name: "Bash", tool_input: { command: "npm test" } },
      makeOpts(),
    )
    expect(result!.hookSpecificOutput!.permissionDecision).toBe("deny")
  })

  it("allows Codex apply_patch when the phase grants Edit", async () => {
    const editState = { ...MOCK_GW_STATE, allowed_tools: ["Read", "Edit"] }
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".active") || p.includes(".state_cache") ? true : false
    )
    ;(readFileSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".state_cache")) return JSON.stringify(editState)
      throw new Error("ENOENT")
    })

    const result = await handlePreTool(
      { tool_name: "apply_patch", tool_input: { patch: "*** Begin Patch" } },
      makeOpts(),
    )
    expect(result).toBeNull()
  })

  it("allows Codex web search only for matching web capability", async () => {
    const researchState = { ...MOCK_GW_STATE, allowed_tools: ["WebSearch"] }
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".active") || p.includes(".state_cache") ? true : false
    )
    ;(readFileSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".state_cache")) return JSON.stringify(researchState)
      throw new Error("ENOENT")
    })

    const searchResult = await handlePreTool(
      { tool_name: "webrun", tool_input: { search_query: [{ q: "gridmap" }] } },
      makeOpts(),
    )
    expect(searchResult).toBeNull()

    const fetchResult = await handlePreTool(
      { tool_name: "webrun", tool_input: { open: [{ ref_id: "result" }] } },
      makeOpts(),
    )
    expect(fetchResult!.hookSpecificOutput!.permissionDecision).toBe("deny")
  })

  it("always allows statewright_ tools", async () => {
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".active") || p.includes(".state_cache") ? true : false
    )
    ;(readFileSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".state_cache")) return JSON.stringify(MOCK_GW_STATE)
      throw new Error("ENOENT")
    })

    const input: HookInput = { tool_name: "statewright_transition" }
    const result = await handlePreTool(input, makeOpts())
    expect(result).toBeNull()
  })

  it("denies bash redirects when Write and Edit not allowed", async () => {
    const readOnlyState = { ...MOCK_GW_STATE, allowed_tools: ["Read", "Bash", "Grep"] }
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".active") || p.includes(".state_cache") ? true : false
    )
    ;(readFileSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".state_cache")) return JSON.stringify(readOnlyState)
      throw new Error("ENOENT")
    })

    const input: HookInput = { tool_name: "Bash", tool_input: { command: "echo hack > config.json" } }
    const result = await handlePreTool(input, makeOpts())

    expect(result).not.toBeNull()
    expect(result!.hookSpecificOutput!.permissionDecision).toBe("deny")
    expect(result!.hookSpecificOutput!.permissionDecisionReason).toContain("redirect")
  })

  it("denies destructive bash commands", async () => {
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".active") || p.includes(".state_cache") ? true : false
    )
    ;(readFileSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".state_cache")) return JSON.stringify(MOCK_GW_STATE)
      throw new Error("ENOENT")
    })

    const input: HookInput = { tool_name: "Bash", tool_input: { command: "rm -rf dist/" } }
    const result = await handlePreTool(input, makeOpts())

    expect(result).not.toBeNull()
    expect(result!.hookSpecificOutput!.permissionDecision).toBe("deny")
    expect(result!.hookSpecificOutput!.permissionDecisionReason).toContain("Destructive")
  })
})

describe("handlePostTool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    originalFetch = globalThis.fetch
    ;(existsSync as Mock).mockReturnValue(false)
    ;(readFileSync as Mock).mockImplementation(() => { throw new Error("ENOENT") })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("activates workflow on statewright_start", async () => {
    setupGateway()
    const input: HookInput = {
      tool_name: "mcp__plugin_statewright_statewright__statewright_load_workflow",
      tool_response: JSON.stringify([{ type: "text", text: JSON.stringify({ run_id: "r1", capture_output: false }) }]),
    }

    const result = await handlePostTool(input, makeOpts())

    expect(writeFileSync).toHaveBeenCalled()
    expect(result).not.toBeNull()
    expect(result!.hookSpecificOutput!.additionalContext).toContain("Workflow loaded")
  })

  it("deactivates workflow on statewright_stop", async () => {
    ;(existsSync as Mock).mockReturnValue(true)

    const input: HookInput = {
      tool_name: "mcp__plugin_statewright_statewright__statewright_deactivate",
    }

    const result = await handlePostTool(input, makeOpts())

    expect(unlinkSync).toHaveBeenCalled()
  })

  it("refreshes cache and reports transition", async () => {
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".active") || p.includes(".state_cache") ? true : false
    )
    ;(readFileSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".state_cache")) {
        return JSON.stringify({ ...MOCK_GW_STATE, state: "analyzing" })
      }
      throw new Error("ENOENT")
    })
    setupGateway()

    const input: HookInput = {
      tool_name: "mcp__plugin_statewright_statewright__statewright_transition",
      tool_response: JSON.stringify([{ type: "text", text: JSON.stringify({ transitioned: true }) }]),
    }

    const result = await handlePostTool(input, makeOpts())

    expect(result).not.toBeNull()
    expect(result!.hookSpecificOutput!.additionalContext).toContain("=>")
    expect(result!.hookSpecificOutput!.additionalContext).toContain("KEEP WORKING")
  })

  it("detects fork transition", async () => {
    ;(existsSync as Mock).mockReturnValue(true)
    ;(readFileSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".state_cache")) {
        return JSON.stringify(MOCK_GW_STATE)
      }
      throw new Error("ENOENT")
    })
    setupGateway()

    const forkResult = {
      forked: true,
      branches: { lint: {}, test: {}, build: {} },
      current_branch: "lint",
    }
    const input: HookInput = {
      tool_name: "mcp__plugin_statewright_statewright__statewright_transition",
      tool_response: JSON.stringify([{ type: "text", text: JSON.stringify(forkResult) }]),
    }

    const result = await handlePostTool(input, makeOpts())

    expect(result!.hookSpecificOutput!.additionalContext).toContain("FORK")
    expect(result!.hookSpecificOutput!.additionalContext).toContain("3 branches")
  })

  it("captures tool logs to PocketBase workflow_logs", async () => {
    // Active workflow with run_id → non-statewright tool calls should POST to PB
    ;(existsSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && (p.includes(".active") || p.includes(".state_cache") || p.includes(".run_id"))) return true
      return false
    })
    ;(readFileSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".state_cache")) return JSON.stringify(MOCK_GW_STATE)
      if (typeof p === "string" && p.includes(".run_id")) return "run_abc123"
      throw new Error("ENOENT")
    })

    const input: HookInput = {
      tool_name: "Edit",
      tool_input: { file_path: "/project/src/main.ts" },
      tool_result: "File edited successfully",
    }

    // Set up fetch to capture the log POST alongside normal gateway calls
    const logPosts: { url: string; body: Record<string, unknown> }[] = []
    fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString()
      const body = init?.body ? JSON.parse(init.body as string) : null
      if (urlStr.includes("workflow_logs")) {
        logPosts.push({ url: urlStr, body })
        return { ok: true, headers: new Headers(), json: async () => ({}) } as Response
      }
      // Gateway calls for state refresh
      return {
        ok: true,
        headers: new Headers({ "mcp-session-id": "test-session" }),
        json: async () => ({
          jsonrpc: "2.0", id: body?.id ?? 1,
          result: { content: [{ type: "text", text: JSON.stringify(MOCK_GW_STATE) }] },
        }),
      } as Response
    })
    globalThis.fetch = fetchMock

    await handlePostTool(input, makeOpts())

    // Verify log POST was fired
    expect(logPosts.length).toBe(1)
    expect(logPosts[0].url).toContain("workflow_logs")
    expect(logPosts[0].body.tool_name).toBe("Edit")
    expect(logPosts[0].body.phase).toBe("implementing")
    expect(logPosts[0].body.run_id).toBe("run_abc123")
    expect(logPosts[0].body.sequence).toBe(1)
    // Verify sequence file was written
    expect(writeFileSync).toHaveBeenCalledWith(expect.stringContaining(".log_seq"), "1")
  })

  it("skips log capture for statewright_ tools", async () => {
    ;(existsSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && (p.includes(".active") || p.includes(".state_cache") || p.includes(".run_id"))) return true
      return false
    })
    ;(readFileSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".state_cache")) return JSON.stringify(MOCK_GW_STATE)
      if (typeof p === "string" && p.includes(".run_id")) return "run_abc123"
      throw new Error("ENOENT")
    })
    setupGateway()

    const input: HookInput = {
      tool_name: "mcp__plugin_statewright_statewright__statewright_get_state",
    }

    await handlePostTool(input, makeOpts())

    // No POST to workflow_logs for statewright tools
    const logCalls = fetchMock.mock.calls.filter(
      ([url]: [string]) => typeof url === "string" && url.includes("workflow_logs")
    )
    expect(logCalls.length).toBe(0)
  })

  it("detects interrupt from file edit", async () => {
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".active") || p.includes(".state_cache") ? true : false
    )
    ;(readFileSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".state_cache")) return JSON.stringify(MOCK_GW_STATE)
      throw new Error("ENOENT")
    })

    const input: HookInput = {
      tool_name: "Edit",
      tool_input: { file_path: "/project/site/pb/hooks/auth.pb.js" },
    }

    const result = await handlePostTool(input, makeOpts())

    expect(result).not.toBeNull()
    expect(result!.hookSpecificOutput!.additionalContext).toContain("INTERRUPT")
    expect(result!.hookSpecificOutput!.additionalContext).toContain("pb_check")
  })

  it("ignores non-edit tools for interrupt detection", async () => {
    ;(existsSync as Mock).mockImplementation((p: string) =>
      p.includes(".active") || p.includes(".state_cache") ? true : false
    )
    ;(readFileSync as Mock).mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes(".state_cache")) return JSON.stringify(MOCK_GW_STATE)
      throw new Error("ENOENT")
    })

    const input: HookInput = {
      tool_name: "Read",
      tool_input: { file_path: "/project/site/pb/hooks/auth.pb.js" },
    }

    const result = await handlePostTool(input, makeOpts())
    expect(result).toBeNull()
  })
})

describe("handleStop", () => {
  it("always returns null (no-op)", async () => {
    const result = await handleStop()
    expect(result).toBeNull()
  })
})
