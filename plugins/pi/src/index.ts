/**
 * Statewright extension for Pi coding agent
 *
 * State machine guardrails — per-state tool enforcement, interrupts,
 * fork/join (sequential), approval gates. Talks directly to the
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
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { minimatch } from "minimatch"

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

let sessionId: string | null = null
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
    const sid = resp.headers.get("mcp-session-id")
    if (sid) sessionId = sid

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

  try {
    const resp = await fetch(`${GW_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
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
    const sid = resp.headers.get("mcp-session-id")
    if (sid) sessionId = sid
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

  // --- Custom tools ---

  pi.registerTool({
    name: "statewright_get_state",
    label: "Get Workflow State",
    description: "Get the current state machine state, available tools, transitions, and iteration count.",
    parameters: Type.Object({}),
    async execute() {
      const state = await refreshState()
      if (!state) return { content: [{ type: "text", text: "Gateway not reachable" }] }
      return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] }
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

      // Refresh state after load
      await refreshState()

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    },
  })

  // --- Context injection (before each agent turn) ---

  pi.on("before_agent_start", async (_event, ctx) => {
    const state = await refreshState()
    if (!state) return

    ctx.ui.setStatus(
      "statewright",
      `[sw] ${state.state} (${state.iteration}/${state.maxIterations ?? "∞"})`,
    )

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
      const isSafe = /^\s*(ls|cat|head|tail|wc|file|find|tree|pwd|echo|date|which|type|env|printenv|git\s+(status|log|diff|branch|show|remote)|grep|rg|fd|ag)\b/.test(cmd)
      const isDangerous = /[>|]|&&\s*(rm|mv|cp)|;\s*(rm|mv|cp)|rm\s|rmdir|shred|truncate|mv\s|cp\s|mkdir|chmod|chown|curl|wget|python|node|ruby|perl|php|sed\s+-i|dd\s/.test(cmd)
      const leavesDir = /\.\.\/?|^\s*cd\s/.test(cmd)
      if (isSafe && !isDangerous && !leavesDir) {
        return // allow safe read-only bash through
      }
      // Bash attempted but not safe — explain why
      const reasons: string[] = []
      if (isDangerous) reasons.push("contains destructive or write operations")
      if (leavesDir) reasons.push("attempts to leave the working directory")
      if (!isSafe) reasons.push("not a recognized read-only command")
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
    if (event.toolName.startsWith("statewright_")) {
      // Refresh state after statewright tool calls
      await refreshState()
      if (stateCache) {
        ctx.ui.setStatus(
          "statewright",
          `[sw] ${stateCache.state} (${stateCache.iteration}/${stateCache.maxIterations ?? "∞"})`,
        )
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
          `[sw] ${stateCache.state} (INTERRUPT → ${target})`,
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
    if (!stateCache) return
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
        `Continue working. Phase: '${stateCache.state}'. Instructions: ${instructions}. Tools: ${available}. Transitions: ${transitionHints}. Start by reading the files in the current directory if you haven't already.`,
        { deliverAs: "steer" },
      )
    }
  })
}
