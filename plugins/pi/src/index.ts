/**
 * Statewright extension for Pi coding agent
 *
 * State machine guardrails — per-state tool enforcement, interrupts,
 * fork/join (parallel via subagent spawn), approval gates. Talks directly to the
 * statewright gateway via HTTP (no MCP proxy needed).
 *
 * Install:
 *   ~/.pi/agent/extensions/statewright/index.ts  (global)
 *   .pi/extensions/statewright/index.ts           (project)
 *
 * Config:
 *   ~/.statewright/api_key              API key (from statewright.ai/keys)
 *   STATEWRIGHT_GATEWAY_URL env var     Override gateway URL (default: managed cloud)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "typebox"
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs"
import { join, basename } from "node:path"
import { homedir, tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { minimatch } from "minimatch"

// --- Debug logging (mauve-colored, gated behind STATEWRIGHT_DEBUG) ---
const SW_LOG_COLOR = "\x1b[35m"
const SW_LOG_RESET = "\x1b[0m"
function swLog(msg: string) { if (process.env.STATEWRIGHT_DEBUG) console.error(`${SW_LOG_COLOR}[statewright] ${msg}${SW_LOG_RESET}`) }

// --- Gateway client ---

const GW_URL = process.env.STATEWRIGHT_GATEWAY_URL || "https://mcp.statewright.ai"
const KEY_PATH = join(homedir(), ".statewright", "api_key")

function getApiKey(): string | null {
  if (process.env.STATEWRIGHT_API_KEY) return process.env.STATEWRIGHT_API_KEY.trim()
  try {
    return readFileSync(KEY_PATH, "utf8").trim()
  } catch {
    return null
  }
}

let sessionId: string | null = process.env.STATEWRIGHT_BRANCH_SESSION_ID ?? null
let rpcId = 1

interface JsonRpcResult {
  result?: { content?: Array<{ type: string; text: string }> }
  error?: { code: number; message: string }
}

async function gwCall(
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown> | null> {
  const apiKey = getApiKey()
  if (!apiKey) return null

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  }
  if (sessionId) headers["Mcp-Session-Id"] = sessionId

  try {
    const resp = await fetch(`${GW_URL}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId++,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return null

    // Capture session ID from first response
    // Only update sessionId from response if not a branch subprocess
    if (!process.env.STATEWRIGHT_BRANCH_SESSION_ID) {
      const sid = resp.headers.get("mcp-session-id")
      if (sid) sessionId = sid
    }

    const data = (await resp.json()) as JsonRpcResult
    if (data.error) return null
    const text = data.result?.content?.[0]?.text
    return text ? JSON.parse(text) : data.result
  } catch {
    return null
  }
}

async function gwInit(): Promise<boolean> {
  const apiKey = getApiKey()
  if (!apiKey) return false

  const presetSessionId = sessionId  // preserve branch session ID from env if set

  try {
    const initHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    }
    if (presetSessionId) initHeaders["Mcp-Session-Id"] = presetSessionId

    const resp = await fetch(`${GW_URL}/mcp`, {
      method: "POST",
      headers: initHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId++,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "statewright-pi", version: "1.0" },
        },
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return false
    // Only capture session ID from response if we didn't have a preset branch ID
    if (!presetSessionId) {
      const sid = resp.headers.get("mcp-session-id")
      if (sid) sessionId = sid
    }
    return true
  } catch {
    return false
  }
}

// --- Tool name mapping ---
// Gateway returns Claude Code tool names; Pi uses lowercase.
// Map both directions for enforcement + display.

const TOOL_NAME_MAP: Record<string, string> = {
  // Claude Code names
  // Claude Code names → Pi names
  Read: "read", Edit: "edit", Write: "write", Bash: "bash",
  Grep: "grep", Glob: "find", MultiEdit: "edit", LS: "ls",
  Agent: "agent", WebFetch: "fetch", WebSearch: "search",
  // OpenAI / Codex / generic model conventions
  read_file: "read", write_file: "write", edit_file: "edit",
  list_directory: "ls", run_test: "bash", run_command: "bash",
  search_files: "grep", find_files: "find", glob: "find",
  apply_patch: "edit", patch_file: "edit", edit_line: "edit",
  edit_block: "edit", create_file: "write",
  // Statewright Rust harness names
  diff: "bash",
}

function normalizeToolName(name: string): string {
  return TOOL_NAME_MAP[name] ?? name.toLowerCase()
}

function toolNamesMatch(gwName: string, piName: string): boolean {
  return normalizeToolName(gwName) === piName.toLowerCase()
}

// --- State cache ---

interface StateCache {
  state: string
  isFinal: boolean
  allowedTools: string[]
  instructions: string | null
  transitions: Array<{ event: string; target: string }>
  maxIterations: number | null
  iteration: number
  context: Record<string, unknown>
  interrupts: Record<string, { file_pattern: string; target: string }>
  fork?: { active: boolean; current_branch: string; branches: Record<string, unknown> }
  interruptHandler?: { return_state: string }
  model: string | null
  defaultModel: string | null
  thinkingLevel: string | null
}

let stateCache: StateCache | null = null
let lastNudgeTime = 0

async function refreshState(): Promise<StateCache | null> {
  const raw = await gwCall("statewright_get_state")
  if (!raw?.state) return stateCache
  stateCache = {
    state: raw.state,
    isFinal: raw.is_final ?? false,
    allowedTools: raw.allowed_tools ?? [],
    instructions: raw.instructions ?? null,
    transitions: raw.transitions ?? [],
    maxIterations: raw.max_iterations ?? null,
    iteration: raw.iteration ?? 0,
    context: raw.context ?? {},
    interrupts: raw.interrupts ?? {},
    fork: raw.fork ?? undefined,
    interruptHandler: raw.interrupt_handler ?? undefined,
    model: raw.model ?? null,
    defaultModel: raw.default_model ?? null,
    thinkingLevel: raw.thinking_level ?? null,
  }
  return stateCache
}

// --- Transition descriptions ---
// Infer intent from graph structure, not hardcoded event names.
// Final target = terminal. Target already visited = retry. Otherwise = advance.

function describeTransition(
  t: { event: string; target: string },
  cache: StateCache,
): string {
  const isFinal = cache.transitions.every((other) =>
    other.target === t.target || cache.transitions.length === 1,
  ) ? false : !cache.transitions.some((other) => other.target === t.target && other.event !== t.event)

  // Check if target is a final state (no outgoing transitions — we approximate
  // by checking if the target name suggests finality, since we don't have the
  // full graph here, only the current state's transitions)
  const targetLooksFinal = /^(completed|failed|done|error|aborted)$/i.test(t.target)
  const targetIsCurrentOrPrior = t.target !== cache.state &&
    !targetLooksFinal &&
    cache.transitions.filter((o) => !(/^(completed|failed|done|error|aborted)$/i.test(o.target))).length > 1

  if (targetLooksFinal && t.target.match(/fail|error|abort/i)) {
    return `${t.event} (last resort, unrecoverable only)`
  }
  if (targetLooksFinal) {
    return `${t.event} (done)`
  }
  // Non-final target that isn't forward progress = retry loop
  const forwardTransitions = cache.transitions.filter((o) => !(/^(completed|failed|done|error|aborted)$/i.test(o.target)))
  if (forwardTransitions.length > 1) {
    // Multiple non-final targets — the one that goes "backward" is the retry
    // Heuristic: if event name contains fail/retry/fix, it's the retry path
    if (t.event.match(/fail|retry|fix|redo|back/i)) {
      return `${t.event} (retry, go back to ${t.target})`
    }
  }
  return `${t.event} (-> ${t.target})`
}

// --- Model tier detection ---
// Rough cost tier for override indicators. Higher = more expensive.
// Ordered most-specific first. First match wins.
const MODEL_TIER_RULES: Array<[string, number]> = [
  // Tier 1: cheap / local / free
  ["mini", 1], ["nano", 1], ["spark", 1], ["haiku", 1], ["flash", 1],
  // Tier 2: mid-tier workhorses
  ["gemma", 2], ["sonnet", 2], ["gpt-4o", 2], ["gpt-4.1", 2],
  ["gpt-5.1", 2], ["gpt-5.2", 2], ["gpt-5.3", 2], ["gpt-5.4", 2],
  // Tier 3: frontier / expensive
  ["opus", 3], ["gpt-5.5", 3], ["o3", 3], ["o4", 3],
]

function modelTier(model: string): number {
  const lower = model.toLowerCase()
  for (const [key, tier] of MODEL_TIER_RULES) {
    if (lower.includes(key)) return tier
  }
  return 2 // unknown → middle
}

function formatModelLabel(model: string | null, defaultModel: string | null): string {
  if (!model) return ""
  const shortName = model.split("/").pop()!
  if (!defaultModel || model === defaultModel) return ` [${shortName}]`
  const tier = modelTier(model)
  const defaultTier = modelTier(defaultModel)
  if (tier < defaultTier) return ` [${shortName} \u2193]`  // ↓ cheaper
  if (tier > defaultTier) return ` [${shortName} \u2191]`  // ↑ more expensive
  return ` [${shortName}]`
}

// --- Formatting ---

function formatContext(s: StateCache): string {
  const transitionDescs = s.transitions.map((t) => describeTransition(t, s)).join(", ")

  const toolList = s.allowedTools.map(normalizeToolName).join(", ")
  const lines = [
    `STATEWRIGHT WORKFLOW ACTIVE.`,
    `You MUST work autonomously. Do NOT stop, summarize, or ask the user between steps. When a tool call fails or is blocked, immediately retry with the correct tool and arguments. Keep working until you reach a final state or an approval gate.`,
    `Phase: ${s.state} (iteration ${s.iteration}/${s.maxIterations ?? "none"}).`,
    `ONLY these tools work right now: ${toolList}. Any other tool will be rejected. Do not invent tool names.`,
    `CRITICAL: Use ONLY the native tool calling mechanism. NEVER output JSON like {"name":"tool"} or {"type":"function"} as text. It does not work. If you write tool calls as text they will be rejected and you will waste a turn. Just call the tool directly.`,
    `Tool signatures: read(path: "file.py") -> file contents, ls(path: ".") -> directory listing, grep(pattern: "search", path?: "dir") -> matching lines, find(pattern: "**/*.py") -> matching file paths, edit(path: "file.py", edits: [{oldText: "old", newText: "new"}]) -> applies find-and-replace, write(path: "file.py", content: "full content") -> writes entire file, bash(command: "shell cmd") -> command output. To list files in the current directory, call ls(path: ".").`,
    `To advance to the next phase, call: statewright_transition(event='EVENT_NAME', data={rationale: 'why'}).`,
    `Available transitions: ${transitionDescs}.`,
  ]
  if (s.model) lines.push(`Model for this phase: ${s.model}.`)
  if (s.instructions) lines.push(`Instructions: ${s.instructions}`)
  if (s.interruptHandler) lines.push(`IN INTERRUPT HANDLER. Return to: ${s.interruptHandler.return_state}`)
  if (s.fork?.active) lines.push(`FORK active. Branch: ${s.fork.current_branch}`)
  return lines.join(" ")
}

// --- Tool call recovery (parse_llm_response equivalent) ---
// Local models sometimes dump tool calls as JSON text in content
// instead of using structured tool_calls. Detect and flag for the model.

interface ParsedToolCall {
  name: string
  args: Record<string, unknown>
}

function extractToolCallsFromText(text: string): ParsedToolCall[] {
  const trimmed = text.trim()

  // Try direct JSON parse
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Try stripping markdown code fences
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    if (fenceMatch) {
      try { parsed = JSON.parse(fenceMatch[1].trim()) } catch { /* noop */ }
    }
    // Try finding embedded JSON
    if (!parsed) {
      const start = trimmed.indexOf("{")
      const end = trimmed.lastIndexOf("}")
      if (start >= 0 && end > start) {
        try { parsed = JSON.parse(trimmed.slice(start, end + 1)) } catch { /* noop */ }
      }
    }
  }
  if (!parsed) return []

  // Format 1: {"tool_calls": [{"name": "...", "args": {...}}]}
  if (Array.isArray(parsed.tool_calls)) {
    return (parsed.tool_calls as Array<Record<string, unknown>>)
      .filter((tc) => typeof tc.name === "string")
      .map((tc) => ({ name: tc.name as string, args: (tc.args ?? tc.arguments ?? {}) as Record<string, unknown> }))
  }

  // Format 2: {"type": "function", "name": "...", "parameters": {...}}
  if (parsed.type === "function" && typeof parsed.name === "string") {
    return [{ name: parsed.name as string, args: (parsed.parameters ?? parsed.arguments ?? {}) as Record<string, unknown> }]
  }

  // Format 3: [{"type": "function", "name": "...", ...}, ...]
  if (Array.isArray(parsed)) {
    return (parsed as Array<Record<string, unknown>>)
      .filter((item) => typeof item.name === "string")
      .map((item) => ({ name: item.name as string, args: (item.parameters ?? item.arguments ?? item.args ?? {}) as Record<string, unknown> }))
  }

  // Format 5: {"name": "tool_name", "parameters": {...}} (no type field)
  if (typeof parsed.name === "string" && (parsed.parameters || parsed.arguments || parsed.args)) {
    return [{ name: parsed.name as string, args: (parsed.parameters ?? parsed.arguments ?? parsed.args ?? {}) as Record<string, unknown> }]
  }

  // Format 4: {"transition": "EVENT_NAME"} (state machine nav)
  if (typeof parsed.transition === "string") {
    return [{ name: "statewright_transition", args: { event: parsed.transition, data: { rationale: parsed.error ?? "model-emitted transition" } } }]
  }

  return []
}

// --- Interrupt detection ---

function checkInterrupts(filePath: string, interrupts: Record<string, { file_pattern: string; target: string }>): string | null {
  if (!filePath || !interrupts || Object.keys(interrupts).length === 0) return null
  // Don't re-trigger while in handler
  if (stateCache?.context?._interrupt_return) return null

  for (const [name, def] of Object.entries(interrupts)) {
    if (minimatch(filePath, def.file_pattern, { matchBase: true }) ||
        minimatch(filePath, `**/${def.file_pattern}`, { dot: true })) {
      return name
    }
  }
  return null
}

// --- Extension entry ---

export default async function statewrightExtension(pi: ExtensionAPI) {
  // Per-instance state tracking (scoped to this extension load, not module-level)
  let lastSwitchedModel: string | null = null
  let originalModel: unknown = null  // saved before first statewright-driven switch
  let originalTools: string[] | null = null  // saved before first tool restriction
  let lastThinkingLevel: string | null = null
  let dormant = false  // true after deactivate — suppresses enforcement until next load
  let ramblingWatchdog: ReturnType<typeof setTimeout> | null = null  // kills rambling output
  const RAMBLING_TIMEOUT_MS = 30000  // 30s without a tool call = rambling

  const apiKey = getApiKey()
  if (!apiKey) {
    console.warn("[statewright] No API key found. Visit https://statewright.ai/keys")
    return
  }

  // Initialize gateway session
  if (!(await gwInit())) {
    console.warn("[statewright] Could not connect to gateway at", GW_URL)
    return
  }

  console.log(`[statewright] Connected to ${GW_URL}`)

  // --- Bootstrap: subagent extension for fork/join (disabled — WIP) ---
  if (false) {
  const piAgentDir = join(homedir(), ".pi", "agent")
  const subagentExtDir = join(piAgentDir, "extensions", "subagent")
  if (!existsSync(subagentExtDir)) {
    const piSubagentExample = join(
      require.resolve("@mariozechner/pi-coding-agent").replace(/\/[^/]+$/, ""),
      "..", "examples", "extensions", "subagent",
    )
    if (existsSync(piSubagentExample)) {
      try {
        mkdirSync(subagentExtDir, { recursive: true })
        for (const f of ["index.ts", "agents.ts"]) {
          const src = join(piSubagentExample, f)
          if (existsSync(src)) writeFileSync(join(subagentExtDir, f), readFileSync(src))
        }
        console.log("[statewright] Installed subagent extension for fork/join support")
      } catch (e) {
        console.warn("[statewright] Could not auto-install subagent extension:", e)
        console.warn("[statewright] For fork/join, manually copy Pi's examples/extensions/subagent to ~/.pi/agent/extensions/subagent/")
      }
    } else {
      console.warn("[statewright] Subagent extension not found. Fork/join parallel dispatch uses built-in statewright_fork tool.")
    }
  }
  } // end disabled fork/join bootstrap

  // --- Branch subprocess auto-init ---
  // If this is a fork branch subprocess, the branch session is already created on the gateway.
  // Just refresh state — no need for the model to call statewright_load_workflow.
  if (process.env.STATEWRIGHT_BRANCH_SESSION_ID) {
    await refreshState()
    dormant = false
    console.log(`[statewright] Branch subprocess connected (session: ${sessionId})`)
  }

  // --- Custom tools ---

  pi.registerTool({
    name: "statewright_get_state",
    label: "Get Workflow State",
    description: "Get the current state machine state, available tools, transitions, and iteration count.",
    parameters: Type.Object({}),
    async execute() {
      const state = await refreshState()
      if (!state) return { content: [{ type: "text", text: "Gateway not reachable" }] }
      // Normalize tool names to Pi conventions (lowercase) so models don't see upcase/lowercase mismatch
      const normalized = { ...state, allowedTools: state.allowedTools.map(normalizeToolName) }
      return { content: [{ type: "text", text: JSON.stringify(normalized, null, 2) }] }
    },
  })

  pi.registerTool({
    name: "statewright_transition",
    label: "Transition State",
    description: "Transition the state machine by emitting an event. Include rationale in data.",
    parameters: Type.Object({
      event: Type.String({ description: "Event name (e.g., DONE, FAIL, READY)" }),
      data: Type.Optional(Type.Object({}, { additionalProperties: true })),
    }),
    async execute(_id, params: { event: string; data?: Record<string, any> }) {
      const result = await gwCall("statewright_transition", {
        event: params.event,
        data: params.data ?? {},
      })
      if (!result) return { content: [{ type: "text", text: "Gateway not reachable" }] }

      // Refresh state after transition
      await refreshState()

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    },
  })

  pi.registerTool({
    name: "statewright_list_workflows",
    label: "List Workflows",
    description: "List available workflows and which one is active.",
    parameters: Type.Object({}),
    async execute() {
      const result = await gwCall("statewright_list_workflows")
      if (!result) return { content: [{ type: "text", text: "Gateway not reachable" }] }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    },
  })

  pi.registerTool({
    name: "statewright_load_workflow",
    label: "Load Workflow",
    description: "Load a named workflow. Activates enforcement.",
    parameters: Type.Object({
      name: Type.String({ description: "Workflow name (e.g., bugfix, tdd-feature)" }),
      resume: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params: { name: string; resume?: boolean }) {
      const result = await gwCall("statewright_load_workflow", params)
      if (!result) return { content: [{ type: "text", text: "Gateway not reachable" }] }

      dormant = false
      await refreshState()

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    },
  })

  pi.registerTool({
    name: "statewright_deactivate",
    label: "Deactivate Workflow",
    description: "Deactivate workflow enforcement. All tools pass through without restriction.",
    parameters: Type.Object({}),
    async execute() {
      const result = await gwCall("statewright_deactivate")
      if (!result) return { content: [{ type: "text", text: "Gateway not reachable" }] }
      stateCache = null
      lastSwitchedModel = null
      dormant = true
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    },
  })

  pi.registerTool({
    name: "statewright_pause",
    label: "Pause Workflow",
    description: "Pause the current workflow. Resume later with statewright_load_workflow(name, resume=true).",
    parameters: Type.Object({}),
    async execute() {
      const result = await gwCall("statewright_pause")
      if (!result) return { content: [{ type: "text", text: "Gateway not reachable" }] }
      stateCache = null
      dormant = true
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    },
  })

  pi.registerTool({
    name: "statewright_get_status",
    label: "Gateway Status",
    description: "Get gateway status: active workflow, current state, available workflows.",
    parameters: Type.Object({}),
    async execute() {
      const result = await gwCall("statewright_get_status")
      if (!result) return { content: [{ type: "text", text: "Gateway not reachable" }] }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    },
  })

  // --- Fork/Join: parallel sub-agent dispatch ---

  function getPiInvocation(args: string[]): { command: string; args: string[] } {
    const currentScript = process.argv[1]
    if (currentScript && existsSync(currentScript)) {
      return { command: process.execPath, args: [currentScript, ...args] }
    }
    return { command: "pi", args }
  }

  interface BranchResult {
    branch: string
    task: string
    exitCode: number
    output: string
    usage: { input: number; output: number; cost: number; turns: number }
  }

  async function runBranch(
    branch: string,
    task: string,
    cwd: string,
    workflowName: string,
    signal?: AbortSignal,
  ): Promise<BranchResult> {
    const systemPrompt = [
      `You are a Statewright fork branch agent (branch: ${branch}).`,
      `The workflow is already loaded. Work autonomously on your assigned task.`,
      `Then complete the task. Work autonomously through all states until done.`,
    ].join("\n")

    const tmpDir = mkdtempSync(join(tmpdir(), "sw-fork-"))
    const promptFile = join(tmpDir, `prompt-${branch}.md`)
    writeFileSync(promptFile, systemPrompt, { encoding: "utf-8", mode: 0o600 })

    const piArgs = [
      "--mode", "json", "-p", "--no-session",
      "--append-system-prompt", promptFile,
      `Task: ${task}`,
    ]

    const result: BranchResult = {
      branch, task, exitCode: 0, output: "",
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
    }

    let lastAssistantText = ""
    let stderrBuf = ""

    try {
      const exitCode = await new Promise<number>((resolve) => {
        const invocation = getPiInvocation(piArgs)
        const proc = spawn(invocation.command, invocation.args, {
          cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            STATEWRIGHT_GATEWAY_URL: GW_URL,
            STATEWRIGHT_API_KEY: getApiKey() ?? "",
            STATEWRIGHT_BRANCH_SESSION_ID: `br_${branch}`,
          },
        })

        let buffer = ""

        proc.stdout.on("data", (data: Buffer) => {
          buffer += data.toString()
          const lines = buffer.split("\n")
          buffer = lines.pop() || ""
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const event = JSON.parse(line)
              if (event.type === "message_end" && event.message?.role === "assistant") {
                const msg = event.message
                for (const part of msg.content ?? []) {
                  if (part.type === "text") lastAssistantText = part.text
                }
                const u = msg.usage
                if (u) {
                  result.usage.input += u.input ?? 0
                  result.usage.output += u.output ?? 0
                  result.usage.cost += u.cost?.total ?? 0
                  result.usage.turns++
                }
              }
            } catch { /* skip non-JSON lines */ }
          }
        })

        proc.stderr.on("data", (data: Buffer) => {
          stderrBuf += data.toString()
          if (process.env.STATEWRIGHT_DEBUG) {
            for (const line of data.toString().split("\n").filter((l: string) => l.trim())) {
              swLog(`[branch:${branch}] ${line}`)
            }
          }
        })

        proc.on("close", (code) => {
          if (buffer.trim()) {
            try {
              const event = JSON.parse(buffer)
              if (event.type === "message_end" && event.message?.role === "assistant") {
                for (const part of event.message.content ?? []) {
                  if (part.type === "text") lastAssistantText = part.text
                }
              }
            } catch { /* skip */ }
          }
          resolve(code ?? 0)
        })

        proc.on("error", () => resolve(1))

        if (signal) {
          const kill = () => { proc.kill("SIGTERM"); setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL") }, 5000) }
          if (signal.aborted) kill()
          else signal.addEventListener("abort", kill, { once: true })
        }
      })

      result.exitCode = exitCode
      result.output = lastAssistantText || "(no output)"
      if (stderrBuf.trim()) {
        result.output += `\n--- stderr ---\n${stderrBuf.slice(-2000)}`
      }
    } finally {
      try { unlinkSync(promptFile) } catch { /* ignore */ }
      try { rmdirSync(tmpDir) } catch { /* ignore */ }
    }

    return result
  }

  pi.registerTool({
    name: "statewright_fork",
    label: "Fork Branches",
    description: "Dispatch parallel sub-agent branches. Each branch runs as a separate pi process with its own workflow session. Results are collected for the join state.",
    parameters: Type.Object({
      branches: Type.Array(
        Type.Object({
          branch: Type.String({ description: "Branch identifier (e.g., 'branch-1')" }),
          task: Type.String({ description: "Task for this branch to complete" }),
          cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
        }),
        { description: "Array of branches to dispatch in parallel", maxItems: 8 },
      ),
    }),
    async execute(_id, params: { branches: Array<{ branch: string; task: string; cwd?: string }> }, signal) {
      // Suspend the rambling watchdog — fork execution takes minutes
      if (ramblingWatchdog) { clearTimeout(ramblingWatchdog); ramblingWatchdog = null }
      try {
      if (!stateCache) {
        return { content: [{ type: "text", text: "No active workflow. Load a workflow first." }], isError: true }
      }

      // Get current workflow name from gateway
      const status = await gwCall("statewright_get_status") as { active_workflow?: string } | null
      const workflowName = status?.active_workflow
      if (!workflowName) {
        return { content: [{ type: "text", text: "No active workflow found on gateway." }], isError: true }
      }

      // Trigger the engine-level FORK transition to create branch sessions on the gateway.
      // Skip if fork is already active (agent may have called statewright_transition(FORK) first).
      let gatewayBranches: string[] = []
      const forkAlreadyActive = stateCache.fork?.active || stateCache.context?._fork
      if (!forkAlreadyActive) {
        const forkEvent = stateCache.transitions.find((t) => {
          return t.event === "FORK" || t.event.startsWith("FORK")
        })?.event
        if (forkEvent) {
          const forkResult = await gwCall("statewright_transition", {
            event: forkEvent,
            data: { rationale: "Dispatching parallel fork branches" },
          }) as { forked?: boolean; branches?: Record<string, unknown> } | null
          if (forkResult?.forked && forkResult.branches) {
            gatewayBranches = Object.keys(forkResult.branches)
            swLog(`fork: engine transition fired (${forkEvent}), branches: ${gatewayBranches.join(", ")}`)
          }
          await refreshState()
        }
      } else {
        // Fork already active — extract branch names from state
        const forkCtx = stateCache.fork?.branches || stateCache.context?._fork?.branches
        if (forkCtx && typeof forkCtx === "object") {
          gatewayBranches = Object.keys(forkCtx as Record<string, unknown>)
        }
        swLog(`fork: already active, branches: ${gatewayBranches.join(", ")}`)
      }

      const defaultCwd = process.cwd()
      const MAX_CONCURRENCY = 4
      const modelBranches = params.branches.slice(0, 8)

      // Map model tasks to gateway branch names (by order, with fallback to model names)
      const branches = gatewayBranches.length > 0
        ? gatewayBranches.map((gwName, i) => ({
            branch: gwName,
            task: modelBranches[i]?.task ?? `Complete the ${gwName} branch`,
            cwd: modelBranches[i]?.cwd,
          }))
        : modelBranches  // no gateway fork context — use model's names as-is

      swLog(`fork: using branch names: ${branches.map(b => b.branch).join(", ")} (gateway: ${gatewayBranches.join(", ") || "none"})`)

      // Run branches in parallel with concurrency limit
      let nextIdx = 0
      const results: BranchResult[] = new Array(branches.length)
      const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, branches.length) }, async () => {
        while (true) {
          const idx = nextIdx++
          if (idx >= branches.length) return
          const b = branches[idx]
          results[idx] = await runBranch(b.branch, b.task, b.cwd ?? defaultCwd, workflowName, signal)

          // Fire BRANCH_DONE on gateway using the GATEWAY's branch name (not model's)
          await gwCall("statewright_transition", {
            event: `BRANCH_DONE:${b.branch}`,
            data: {
              rationale: `Branch ${b.branch} completed`,
              branch: b.branch,
              exit_code: results[idx].exitCode,
              output_summary: results[idx].output.slice(0, 500),
            },
          })
        }
      })
      await Promise.all(workers)

      // Refresh state (gateway join logic may have advanced)
      await refreshState()
      // Suppress watchdog for one cycle — the agent needs time to process fork results
      if (ramblingWatchdog) { clearTimeout(ramblingWatchdog); ramblingWatchdog = null }

      const succeeded = results.filter(r => r.exitCode === 0).length
      const totalCost = results.reduce((sum, r) => sum + r.usage.cost, 0)
      const totalTurns = results.reduce((sum, r) => sum + r.usage.turns, 0)

      const summaries = results.map(r => {
        const icon = r.exitCode === 0 ? "OK" : "FAIL"
        return `[${r.branch}] ${icon} (${r.usage.turns} turns, $${r.usage.cost.toFixed(4)})\n${r.output.slice(0, 200)}`
      })

      return {
        content: [{
          type: "text",
          text: `Fork complete: ${succeeded}/${branches.length} branches succeeded.\nTotal: ${totalTurns} turns, $${totalCost.toFixed(4)}\n\n${summaries.join("\n\n")}`,
        }],
        details: { results },
      }
      } catch (err) {
        const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err)
        return { content: [{ type: "text", text: `Fork error: ${msg}` }], isError: true }
      }
    },
  })

  // --- /statewright command ---

  pi.registerCommand("statewright", {
    description: "Statewright workflow control: load, deactivate, pause, status, list",
    async handler(args, ctx) {
      const parts = args.trim().split(/\s+/)
      const sub = parts[0]?.toLowerCase() ?? "status"

      if (sub === "load" || sub === "start") {
        const name = parts[1]
        if (!name) { ctx.ui.notify("[statewright] Usage: /statewright load <workflow-name>", "warn"); return }
        const resume = parts.includes("--resume")
        const result = await gwCall("statewright_load_workflow", { name, resume })
        if (!result) { ctx.ui.notify("[statewright] Gateway not reachable", "error"); return }
        dormant = false
        await refreshState()
        if (stateCache) await applyModelRouting(stateCache, ctx)
        ctx.ui.notify(`[statewright] Workflow '${name}' loaded. State: ${stateCache?.state ?? "unknown"}`, "success")
      } else if (sub === "deactivate" || sub === "stop" || sub === "off") {
        const result = await gwCall("statewright_deactivate")
        if (!result) { ctx.ui.notify("[statewright] Gateway not reachable", "error"); return }
        stateCache = null
        lastSwitchedModel = null
        lastThinkingLevel = null
        if (originalModel) {
          await pi.setModel(originalModel as Parameters<typeof pi.setModel>[0])
          originalModel = null
        }
        if (originalTools) {
          pi.setActiveTools(originalTools)
          originalTools = null
        }
        ctx.ui.setStatus("statewright", "")
        ctx.ui.notify("[statewright] Workflow deactivated. All tools unrestricted.", "info")
      } else if (sub === "pause") {
        const result = await gwCall("statewright_pause")
        if (!result) { ctx.ui.notify("[statewright] Gateway not reachable", "error"); return }
        stateCache = null
        ctx.ui.setStatus("statewright", "[statewright] paused")
        ctx.ui.notify("[statewright] Workflow paused. Resume with /statewright load <name> --resume", "info")
      } else if (sub === "list" || sub === "ls") {
        const result = await gwCall("statewright_list_workflows")
        if (!result) { ctx.ui.notify("[statewright] Gateway not reachable", "error"); return }
        const wfs = (result as { workflows?: string[] }).workflows ?? []
        const active = (result as { active?: string }).active
        const lines = wfs.map((w: string) => w === active ? `  * ${w} (active)` : `    ${w}`)
        ctx.ui.notify(`[statewright] Workflows:\n${lines.join("\n")}`, "info")
      } else {
        // Default: status
        const result = await gwCall("statewright_get_status")
        if (!result) { ctx.ui.notify("[statewright] Gateway not reachable", "error"); return }
        ctx.ui.notify(`[statewright] ${JSON.stringify(result, null, 2)}`, "info")
      }
    },
    getArgumentCompletions(prefix) {
      const subs = ["load", "deactivate", "pause", "status", "list"]
      return subs.filter((s) => s.startsWith(prefix)).map((s) => ({ label: s, value: s }))
    },
  })

  // --- Model switching (shared by before_agent_start and tool_result) ---

  async function applyModelRouting(state: StateCache, ctx: { modelRegistry: { find: (p: string, m: string) => unknown; getAll: () => Array<{ provider: string; id: string }> }; model?: unknown; ui: { notify: (msg: string, level: string) => void; setStatus: (ns: string, text: string) => void } }) {
    try {
      const currentModel = ctx.model as { provider?: string; id?: string } | undefined
      swLog(`model] state=${state.state} want=${state.model} have=${currentModel?.provider}/${currentModel?.id} lastSwitched=${lastSwitchedModel}`)
      if (state.model && state.model !== lastSwitchedModel) {
        if (!originalModel && ctx.model) {
          originalModel = ctx.model
        }
        const parts = state.model.split("/")
        let resolved: unknown = null
        if (parts.length === 2) {
          resolved = ctx.modelRegistry.find(parts[0], parts[1])
          swLog(`model] registry.find(${parts[0]}, ${parts[1]}) = ${resolved ? "FOUND" : "null"}`)
        }
        if (!resolved) {
          const allModels = ctx.modelRegistry.getAll()
          swLog(`model] registry has ${allModels.length} models: ${allModels.map((m: { provider: string; id: string }) => `${m.provider}/${m.id}`).join(", ")}`)
          resolved = allModels.find((m: { id: string }) => m.id === state.model)
            ?? allModels.find((m: { id: string }) => m.id === parts[parts.length - 1])
        }
        if (resolved) {
          const r = resolved as { provider?: string; id?: string }
          swLog(`model] calling setModel(${r.provider}/${r.id})...`)
          const success = await pi.setModel(resolved as Parameters<typeof pi.setModel>[0])
          swLog(`model] setModel returned: ${success}`)
          if (success) {
            lastSwitchedModel = state.model
            ctx.ui.notify(`[statewright] Model → ${state.model}`, "info")
          } else {
            swLog(`model] setModel FAILED — no API key for ${state.model}?`)
          }
        } else {
          swLog(`model] Model '${state.model}' NOT FOUND in registry`)
        }
      } else if (!state.model && lastSwitchedModel) {
        if (originalModel) {
          const success = await pi.setModel(originalModel as Parameters<typeof pi.setModel>[0])
          if (success) {
            const orig = originalModel as { id?: string }
            ctx.ui.notify(`[statewright] Model → ${orig.id ?? "previous"} (restored)`, "info")
          }
        }
        lastSwitchedModel = null
      }
    } catch (err) {
      swLog(`model] ERROR:`, err)
    }

    // --- Per-state thinking level ---
    try {
      if (state.thinkingLevel && state.thinkingLevel !== lastThinkingLevel) {
        const before = pi.getThinkingLevel()
        pi.setThinkingLevel(state.thinkingLevel as Parameters<typeof pi.setThinkingLevel>[0])
        const after = pi.getThinkingLevel()
        lastThinkingLevel = state.thinkingLevel
        if (after !== state.thinkingLevel) {
          ctx.ui.notify(`[statewright] Thinking '${state.thinkingLevel}' not supported by this model — clamped to '${after}'`, "warn")
        } else {
          ctx.ui.notify(`[statewright] Thinking → ${after}`, "info")
        }
      } else if (!state.thinkingLevel && lastThinkingLevel) {
        lastThinkingLevel = null
      }
    } catch (err) {
      swLog(`thinking] ERROR:`, err)
    }

    // --- Native tool restrictions ---
    try {
      if (state.allowedTools.length > 0) {
        if (!originalTools) {
          originalTools = pi.getActiveTools()
          swLog(`tools] saved original tools: ${originalTools.join(", ")}`)
        }
        // Map state tools to Pi names, keep statewright tools always active
        const piTools = state.allowedTools.map(normalizeToolName)
        const swTools = pi.getActiveTools().filter((t: string) => t.startsWith("statewright_"))
        const activeSet = [...new Set([...piTools, ...swTools])]
        swLog(`tools] state=${state.state} setting active: ${activeSet.join(", ")}`)
        pi.setActiveTools(activeSet)
        swLog(`tools] after set, active: ${pi.getActiveTools().join(", ")}`)
      } else if (originalTools) {
        pi.setActiveTools(originalTools)
        originalTools = null
      }
    } catch (err) {
      swLog(`tools] ERROR:`, err)
    }

    // --- Rambling watchdog ---
    // If the model generates text for too long without a tool call, abort + steer.
    // sendUserMessage alone can't interrupt mid-stream — must abort first.
    if (ramblingWatchdog) { clearTimeout(ramblingWatchdog); ramblingWatchdog = null }
    if (!state.isFinal) {
      const abortCtx = ctx  // capture for closure
      ramblingWatchdog = setTimeout(() => {
        ramblingWatchdog = null
        if (!stateCache || stateCache.isFinal || dormant) return
        const tools = stateCache.allowedTools.map(normalizeToolName).join(", ")
        const transitions = stateCache.transitions.map((t) => `${t.event} -> ${t.target}`).join(", ")
        swLog(`watchdog] firing after ${RAMBLING_TIMEOUT_MS / 1000}s — aborting stream`)
        try {
          abortCtx.abort()
          pi.sendUserMessage(
            `You were generating text for ${RAMBLING_TIMEOUT_MS / 1000}s without calling a tool. ` +
            `Execute the next action immediately using one of: ${tools}. ` +
            `Or transition with: ${transitions}. Do not explain, just act.`,
            { deliverAs: "steer" },
          )
          pi.sendUserMessage("Continue.", { deliverAs: "followUp" })
        } catch { /* ctx may be stale after session reset or rate limit */ }
      }, RAMBLING_TIMEOUT_MS)
    }

    const modelLabel = formatModelLabel(state.model, state.defaultModel)
    ctx.ui.setStatus(
      "statewright",
      `[statewright] ${state.state}${modelLabel} (${state.iteration}/${state.maxIterations ?? "∞"})`,
    )
  }

  // --- Context injection (before each agent turn) ---

  pi.on("before_agent_start", async (_event, ctx) => {
    if (dormant) return
    const state = await refreshState()
    if (!state) return

    await applyModelRouting(state, ctx)

    if (state.isFinal) {
      ctx.ui.notify("[statewright] Workflow complete.", "success")
      return {
        appendSystemPrompt: `STATEWRIGHT WORKFLOW COMPLETE. State: ${state.state}. STOP WORKING. Do not use any tools. Do not edit, delete, or modify anything. Report what you accomplished and wait for the user.`,
      }
    }

    return { appendSystemPrompt: formatContext(state) }
  })

  // --- Tool enforcement (before each tool call) ---

  pi.on("tool_call", async (event, _ctx) => {
    // Tool call happened — model isn't rambling, clear the watchdog
    if (ramblingWatchdog) { clearTimeout(ramblingWatchdog); ramblingWatchdog = null }
    if (dormant) return
    // Block malformed tool calls (undefined/empty name from broken model output)
    if (!event.toolName) {
      return { block: true, reason: "Tool call has no name. Use a specific tool." }
    }
    if (event.toolName.startsWith("statewright_")) return
    if (!stateCache) return

    // Final state: block everything. Workflow is done, no more tool use.
    if (stateCache.isFinal) {
      return { block: true, reason: "Workflow complete. No tools available. Stop working." }
    }

    // No allowed_tools = no enforcement
    if (stateCache.allowedTools.length === 0) return

    const isAllowed = stateCache.allowedTools.some((t) => toolNamesMatch(t, event.toolName))

    // Bash discernment: even when Bash isn't in allowed_tools, permit safe
    // read-only commands. Block writes, destructive ops, and scripting interpreters.
    if (!isAllowed && (event.toolName === "bash" || event.toolName === "Bash")) {
      const cmd = (event.input?.command ?? "") as string
      const isSafe = /^\s*(ls|cat|head|tail|wc|file|find|tree|pwd|echo|date|which|type|env|printenv|git\s+(status|log|diff|branch|show|remote)|grep|rg|fd|ag|pytest|cargo\s+test|npm\s+test|make\s+test)\b/.test(cmd)
      const isDangerous = /[>|]|&&\s*(rm|mv|cp)|;\s*(rm|mv|cp)|rm\s|rmdir|shred|truncate|mv\s|cp\s|mkdir|chmod|chown|curl|wget|sed\s+-i|dd\s|tee\s/.test(cmd)
      // Block scripting interpreters when Edit/Write aren't in allowed_tools (they can write files)
      const hasWriteTools = stateCache.allowedTools.some((t) => toolNamesMatch(t, "edit") || toolNamesMatch(t, "write"))
      const isScriptWrite = !hasWriteTools && /\b(python3?|node|ruby|perl|php)\b/.test(cmd)
      const leavesDir = /\.\.\/?|^\s*cd\s/.test(cmd)
      if (isSafe && !isDangerous && !leavesDir && !isScriptWrite) {
        return // allow safe read-only bash through
      }
      // Bash attempted but not safe — explain why
      const reasons: string[] = []
      if (isDangerous) reasons.push("contains destructive or write operations")
      if (isScriptWrite) reasons.push("scripting interpreter can write files — use edit tool instead")
      if (leavesDir) reasons.push("attempts to leave the working directory")
      if (!isSafe && !isDangerous && !isScriptWrite) reasons.push("not a recognized read-only command")
      return {
        block: true,
        reason: `Bash command blocked: ${reasons.join(", ")}. Safe read-only commands (ls, cat, grep, git status, etc.) are allowed. Destructive commands, writes, and directory traversal are not.`,
      }
    }

    if (!isAllowed) {
      const available = stateCache.allowedTools.map(normalizeToolName).join(", ")
      const transitionHints = stateCache.transitions.map((t) =>
        describeTransition(t, stateCache!),
      ).join(", ")
      return {
        block: true,
        reason: `Tool '${event.toolName}' is not available in the '${stateCache.state}' phase. Available: ${available}. To advance, use statewright_transition with: ${transitionHints}.`,
      }
    }
  })

  // --- Post-tool: interrupt detection + state tracking ---

  pi.on("tool_result", async (event, ctx) => {
    if (dormant) return
    if (event.toolName.startsWith("statewright_")) {
      // Refresh state after statewright tool calls
      await refreshState()
      if (stateCache) {
        await applyModelRouting(stateCache, ctx)
        if (stateCache.isFinal) {
          ctx.ui.notify("[statewright] Workflow complete.", "success")
        }
      }
      return
    }

    // Interrupt detection for file-changing tools
    if (!stateCache?.interrupts) return
    const isFileEdit = ["Edit", "Write", "MultiEdit", "edit_file", "write_file", "apply_patch"].includes(event.toolName)
    if (!isFileEdit) return

    const filePath = event.toolInput?.file_path || event.toolInput?.path || event.toolInput?.file
    if (!filePath) return

    const matched = checkInterrupts(filePath, stateCache.interrupts)
    if (matched) {
      const target = stateCache.interrupts[matched].target
      ctx.ui.notify(`[statewright] INTERRUPT '${matched}' triggered by ${filePath}`, "warn")

      // Trigger the interrupt via gateway
      await gwCall("statewright_transition", {
        event: `INTERRUPT:${matched}`,
        data: { rationale: "File edit triggered interrupt", trigger_file: filePath },
      })
      await refreshState()

      if (stateCache) {
        ctx.ui.setStatus(
          "statewright",
          `[statewright] ${stateCache.state} (INTERRUPT → ${target})`,
        )
      }
    }
  })

  // --- Tool call recovery (message_end hook) ---
  // When local models dump tool calls as JSON text instead of structured
  // tool_calls, DON'T ask the model to retry. Execute the intended tool
  // ourselves and feed the result back. Same approach as the Rust harness's
  // parse_llm_response → execute → feed results loop.

  pi.on("message_end", async (event, _ctx) => {
    if (dormant || !stateCache) return
    const msg = event.message
    if (msg.role !== "assistant") return

    const textParts = (msg.content ?? []).filter(
      (c: Record<string, unknown>) => c.type === "text" && typeof c.text === "string",
    )
    const toolCallParts = (msg.content ?? []).filter(
      (c: Record<string, unknown>) => c.type === "toolCall",
    )

    if (toolCallParts.length > 0) return

    for (const part of textParts) {
      const extracted = extractToolCallsFromText(part.text as string)
      if (extracted.length === 0) continue

      // Execute each extracted tool call directly
      const results: string[] = []
      for (const tc of extracted) {
        const name = normalizeToolName(tc.name)
        const args = tc.args

        try {
          let result: string

          // Statewright tools → call gateway directly
          if (tc.name.startsWith("statewright_") || name.startsWith("statewright_")) {
            const gwResult = await gwCall(tc.name, args)
            result = gwResult ? JSON.stringify(gwResult, null, 2) : "Gateway not reachable"
            // Refresh state after statewright calls
            await refreshState()
          }
          // Shell-executable tools → pi.exec
          else if (name === "ls" || name === "find" || tc.name === "list_directory") {
            const path = (args.path ?? args.pattern ?? ".") as string
            const execResult = await pi.exec("ls", ["-la", path])
            result = typeof execResult === "string" ? execResult : JSON.stringify(execResult)
          }
          else if (name === "read" || tc.name === "read_file") {
            const path = (args.path ?? args.file_path ?? args.filename) as string
            const execResult = await pi.exec("cat", [path])
            result = typeof execResult === "string" ? execResult : JSON.stringify(execResult)
          }
          else if (name === "grep" || tc.name === "search_files") {
            const pattern = (args.pattern ?? args.query) as string
            const path = (args.path ?? args.file ?? ".") as string
            const execResult = await pi.exec("grep", ["-rn", pattern, path])
            result = typeof execResult === "string" ? execResult : JSON.stringify(execResult)
          }
          else if (name === "bash" || tc.name === "run_command" || tc.name === "run_test") {
            const cmd = (args.command ?? args.cmd) as string
            const execResult = await pi.exec("bash", ["-c", cmd])
            result = typeof execResult === "string" ? execResult : JSON.stringify(execResult)
          }
          // Edit tool — normalize parameter variants from local models
          // Local models emit {file, old, new}, {path, old_text, new_text}, {edits: [{file, oldText, newText}]}, etc.
          // Pi expects: edit(path, edits: [{oldText, newText}])
          else if (name === "edit" || tc.name === "edit_file" || tc.name === "apply_patch" || tc.name === "patch_file") {
            const filePath = (args.path ?? args.file ?? args.file_path ?? args.filename) as string | undefined
            const oldText = (args.old ?? args.old_text ?? args.oldText ?? args.original) as string | undefined
            const newText = (args.new ?? args.new_text ?? args.newText ?? args.replacement) as string | undefined
            const editsArr = args.edits as Array<Record<string, unknown>> | undefined

            let editPath = filePath
            let edits: Array<{ oldText: string; newText: string }> = []

            if (editsArr && Array.isArray(editsArr)) {
              // {edits: [{file/path, oldText/old, newText/new}]}
              for (const e of editsArr) {
                editPath = editPath ?? (e.path ?? e.file ?? e.file_path) as string
                const o = (e.oldText ?? e.old ?? e.old_text) as string
                const n = (e.newText ?? e.new ?? e.new_text) as string
                if (o && n) edits.push({ oldText: o, newText: n })
              }
            } else if (oldText && newText) {
              // {path, old, new} flat format
              edits = [{ oldText, newText }]
            } else if (args.patch && typeof args.patch === "string") {
              // Unified diff — execute via sed-like approach
              const execResult = await pi.exec("bash", ["-c",
                `cd "${process.cwd()}" && echo ${JSON.stringify(args.patch)} | patch -p0 --no-backup-if-mismatch 2>&1`])
              result = typeof execResult === "string" ? execResult : JSON.stringify(execResult)
              results.push(`[${tc.name}] ${result}`)
              continue
            }

            if (editPath && edits.length > 0) {
              // Read current file, apply replacements, write back
              try {
                const readResult = await pi.exec("cat", [editPath])
                let content = typeof readResult === "string" ? readResult : JSON.stringify(readResult)
                let applied = 0
                for (const edit of edits) {
                  if (content.includes(edit.oldText)) {
                    content = content.replace(edit.oldText, edit.newText)
                    applied++
                  }
                }
                if (applied > 0) {
                  await pi.exec("bash", ["-c", `cat > ${JSON.stringify(editPath)} << 'STATEWRIGHT_EOF'\n${content}\nSTATEWRIGHT_EOF`])
                  result = `Applied ${applied}/${edits.length} edit(s) to ${editPath}`
                } else {
                  result = `No matches found in ${editPath}. Re-read the file to get exact current content.`
                }
              } catch (err) {
                result = `Edit failed: ${err instanceof Error ? err.message : String(err)}`
              }
            } else {
              result = `Could not parse edit parameters. Use: edit(path="file.py", edits=[{oldText: "old", newText: "new"}])`
            }
          }
          else {
            result = `Tool '${tc.name}' not executable via recovery. Use native tool calling.`
          }

          results.push(`[${tc.name}] ${result}`)
        } catch (err) {
          results.push(`[${tc.name}] Error: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // Feed results back to the model with guidance
      pi.sendUserMessage(
        `I executed your tool calls. Results:\n${results.join("\n")}\n\nContinue working. If an edit fails because the old text didn't match, re-read the file first to get the exact current content, then try again with the exact text.`,
        { deliverAs: "steer" },
      )
      return
    }

    // Auto-continuation: nudge the model to keep working if it stalled.
    // Cooldown prevents flail loops — only fires once per 30 seconds.
    if (!stateCache.isFinal && textParts.length > 0 && toolCallParts.length === 0) {
      const now = Date.now()
      if (now - lastNudgeTime < 30000) return
      lastNudgeTime = now

      const available = stateCache.allowedTools.map(normalizeToolName).join(", ")
      const transitionHints = stateCache.transitions.map((t) => describeTransition(t, stateCache!)).join(", ")
      const instructions = stateCache.instructions ?? "Proceed with the task."
      pi.sendUserMessage(
        `Continue working. Phase: '${stateCache.state}'. Instructions: ${instructions}. Tools: ${available}. Transitions: ${transitionHints}. Do NOT re-read files you have already read. Continue from where you left off.`,
        { deliverAs: "steer" },
      )
    }
  })
}
