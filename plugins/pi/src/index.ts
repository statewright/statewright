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

// --- ANSI colors for TUI rendering ---
const SW_LOG_COLOR = "\x1b[35m"
const SW_LOG_RESET = "\x1b[0m"
const ANSI = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
  eol: "\x1b[K",                // fill to end of line with current bg
  bgGreen: "\x1b[42m\x1b[30m",  // green bg, black text
  bgRed: "\x1b[41m\x1b[37m",    // red bg, white text
  diffAdd: "\x1b[42m\x1b[30m",  // green bg for +lines
  diffDel: "\x1b[41m\x1b[37m",  // red bg for -lines
}

// 256-color helpers: \x1b[38;5;Nm (fg) and \x1b[48;5;Nm (bg)
const fg256 = (n: number) => `\x1b[38;5;${n}m`
const bg256 = (n: number) => `\x1b[48;5;${n}m`

// Powerline color palette (256-color for proper contrast)
const PL_COLORS: Record<string, { bg: number; fg: number }> = {
  recon:      { bg: 33,  fg: 255 },  // dodger blue, white
  plan:       { bg: 37,  fg: 16  },  // cyan, black
  implement:  { bg: 135, fg: 255 },  // purple, white
  verify:     { bg: 214, fg: 16  },  // orange, black
  completed:  { bg: 34,  fg: 255 },  // green, white
  failed:     { bg: 196, fg: 255 },  // red, white
  paused:     { bg: 226, fg: 16  },  // yellow, black
  model:      { bg: 238, fg: 252 },  // dark grey, light grey
  git:        { bg: 240, fg: 252 },  // medium grey, light grey
  iter:       { bg: 241, fg: 255 },  // mid grey, white
}

// Powerline separator (U+E0B0)
const PL = process.env.STATEWRIGHT_POWERLINE !== "0" ? "\uE0B0" : "|"

// Build a powerline segment with proper arrow coloring
function plSegment(text: string, colorKey: string, nextColorKey?: string): string {
  const c = PL_COLORS[colorKey] ?? PL_COLORS.recon
  const segment = `${bg256(c.bg)}${fg256(c.fg)}${ANSI.bold} ${text} ${ANSI.reset}`
  if (nextColorKey) {
    const next = PL_COLORS[nextColorKey] ?? PL_COLORS.model
    return segment + `${fg256(c.bg)}${bg256(next.bg)}${PL}${ANSI.reset}`
  }
  // Last segment: arrow to terminal default bg
  return segment + `${fg256(c.bg)}${ANSI.reset}${PL}${ANSI.reset}`
}

// Map state name to color key
function stateColorKey(s: StateCache): string {
  if (s.isFinal && s.state === "completed") return "completed"
  if (s.isFinal) return "failed"
  if (/implement|edit/i.test(s.state)) return "implement"
  if (/test|verif/i.test(s.state)) return "verify"
  if (/plan/i.test(s.state)) return "plan"
  return "recon"
}

// Track last-known model so final states still show it
let lastKnownModel: string | null = null
let lastKnownProvider: string | null = null
let pluginStepCount = 0

// Centralized status bar formatter
function formatStatusBar(s: StateCache | null, extra?: string): string {
  if (!s) return plSegment("statewright", "recon", "iter") + plSegment("inactive", "iter")
  if (extra === "paused") {
    return plSegment("statewright", "recon", "paused") + plSegment("⏸ paused", "paused")
  }

  // Track model for display in final states
  if (s.model) {
    const parts = s.model.split("/")
    lastKnownProvider = parts.length > 1 ? parts[0] : null
    lastKnownModel = parts.length > 1 ? parts.slice(1).join("/") : s.model
  }

  if (extra === "programmatic") {
    return plSegment("statewright", "recon", stateColorKey(s)) +
           plSegment(`⚡ ${s.state}`, stateColorKey(s), "model") +
           plSegment("programmatic", "model")
  }

  const colorKey = stateColorKey(s)
  const iter = `${pluginStepCount}/${s.maxIterations ?? "∞"}`

  // Separate segments: state > provider > model > thinking > iter
  const provider = lastKnownProvider ?? null
  const model = lastKnownModel ?? s.defaultModel ?? null
  const tierLabel = formatModelLabel(s.model, s.defaultModel)?.trim()
  const modelName = tierLabel || model
  const thinking = s.thinkingLevel && s.thinkingLevel !== "off" ? s.thinkingLevel : null

  let result = plSegment("statewright", "recon", colorKey)
  result += plSegment(s.state, colorKey, provider ? "git" : (modelName ? "model" : "iter"))

  if (provider) {
    result += plSegment(provider, "git", modelName ? "model" : "iter")
  }
  if (modelName) {
    result += plSegment(modelName, "model", thinking ? "paused" : "iter")
  }
  if (thinking) {
    result += plSegment(`💭${thinking}`, "paused", "iter")
  }
  result += plSegment(iter, "iter")
  return result
}
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

let lastGwError = ""

async function gwCall(
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown> | null> {
  lastGwError = ""
  const apiKey = getApiKey()
  if (!apiKey) return null

  const MAX_RETRIES = 3
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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

      if (resp.ok) {
        if (!process.env.STATEWRIGHT_BRANCH_SESSION_ID) {
          const sid = resp.headers.get("mcp-session-id")
          if (sid) sessionId = sid
        }
        const data = (await resp.json()) as JsonRpcResult
        if (data.error) {
          swLog(`gwCall] ${toolName} JSON-RPC error: ${JSON.stringify(data.error)}`)
          lastGwError = data.error.message ?? JSON.stringify(data.error)
          return null
        }
        // Check MCP tool result isError flag (gateway returns errors as successful JSON-RPC with isError: true)
        if ((data.result as Record<string, unknown>)?.isError) {
          const errText = data.result?.content?.[0]?.text ?? "unknown error"
          swLog(`gwCall] ${toolName} tool error: ${errText}`)
          lastGwError = errText
          return null
        }
        const text = data.result?.content?.[0]?.text
        if (!text) return data.result
        try { return JSON.parse(text) } catch { return { _raw: text } }
      }

      // 5xx = server error, retry. 4xx = client error, don't retry.
      if (resp.status < 500) {
        swLog(`gwCall] ${toolName} returned ${resp.status}`)
        return null
      }
      swLog(`gwCall] ${toolName} got ${resp.status}, will retry`)
    } catch (err) {
      // Network error — retry
      swLog(`gwCall] ${toolName} network error: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (attempt < MAX_RETRIES) {
      const delay = Math.min(1000 * 2 ** attempt, 8000)
      swLog(`gwCall] ${toolName} failed, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  return null
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
  const normalized = normalizeToolName(gwName)
  const target = piName.toLowerCase()
  // Exact match
  if (normalized === target) return true
  // Glob: "mcp_*" matches "mcp__plugin_foo", "Edit*" matches "EditFile"
  if (normalized.includes("*")) {
    const pattern = normalized.replace(/\*/g, ".*")
    return new RegExp(`^${pattern}$`, "i").test(target)
  }
  return false
}

// --- State cache ---

interface WorkflowMeta {
  autonomous?: boolean
  danger_level?: "safe" | "moderate" | "dangerous"
  capture_output?: boolean
  task_type?: string
  requires_human_approval?: boolean
  orchestration?: "plugin" | "agentic"
  task_description?: string
}

interface StateCache {
  state: string
  isFinal: boolean
  allowedTools: string[]
  disallowedTools: string[]
  allowedCommands: string[]
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
  runId: string | null
  meta: WorkflowMeta
}

let stateCache: StateCache | null = null
let dormant = false  // module-level: true after deactivate, suppresses all enforcement + refreshState
let lastNudgeTime = 0
let lastToolResult: { toolName: string; output: string } | null = null

function isPluginOrchestrated(): boolean {
  return stateCache?.meta?.orchestration === "plugin"
}

async function refreshState(): Promise<StateCache | null> {
  if (dormant) return null
  const raw = await gwCall("statewright_get_state")
  if (!raw?.state) {
    swLog(`refreshState] gwCall returned null — returning stale cache (state=${stateCache?.state})`)
    return stateCache
  }
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
    runId: (raw.run_id as string) ?? null,
    meta: (raw.meta as WorkflowMeta) ?? {},
    allowedCommands: raw.allowed_commands ?? [],
    disallowedTools: raw.disallowed_tools ?? [],
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
  if (!defaultModel || model === defaultModel) return ` ${shortName}`
  const tier = modelTier(model)
  const defaultTier = modelTier(defaultModel)
  if (tier < defaultTier) return ` ${shortName} \u2193`  // ↓ cheaper
  if (tier > defaultTier) return ` ${shortName} \u2191`  // ↑ more expensive
  return ` ${shortName}`
}

// --- Formatting ---

function formatContext(s: StateCache): string {
  const transitionDescs = s.transitions.map((t) => describeTransition(t, s)).join(", ")

  const toolList = s.allowedTools.map(normalizeToolName).join(", ")
  const lines = [
    `STATEWRIGHT WORKFLOW ACTIVE. Phase: ${s.state} (${s.iteration}/${s.maxIterations ?? "∞"}).`,
    `Work autonomously. Do not stop or ask the user between steps.`,
    `Tools: ${toolList}. Transitions: ${transitionDescs}.`,
    `To advance to the next phase, respond with JSON: {"transition": "EVENT_NAME", "rationale": "why"}`,
  ]
  if (s.model) lines.push(`Model for this phase: ${s.model}.`)
  if (s.instructions) lines.push(`Instructions: ${s.instructions}`)
  if (s.interruptHandler) lines.push(`IN INTERRUPT HANDLER. Return to: ${s.interruptHandler.return_state}`)
  if (s.fork?.active) lines.push(`FORK active. Branch: ${s.fork.current_branch}`)
  return lines.join(" ")
}

// --- Fresh prompt builder (plugin orchestration mode) ---
// Mirrors crates/agent/src/prompt_templates.rs:163-186
// Each LLM call gets a clean prompt with no accumulated history.
function buildFreshSystemPrompt(s: StateCache, localModelHint = false): string {
  const toolList = s.allowedTools.length > 0
    ? s.allowedTools.map(normalizeToolName).join(", ")
    : "No tools available in this state."
  const transitionsList = s.transitions
    .map(t => `  ${t.event} → ${t.target}${/fail|error|abort/i.test(t.target) ? " (UNRECOVERABLE ERROR ONLY — do NOT use when task succeeds)" : ""}`)
    .join("\n")
  const stateInstructions = s.instructions ?? "Proceed with the task."
  const taskDesc = s.meta.task_description ?? s.instructions ?? "Complete the current task."

  return [
    `You are executing a task under state machine constraints. You are in the "${s.state}" state.`,
    ``,
    `## Task`,
    taskDesc,
    ``,
    `## Current State Instructions`,
    stateInstructions,
    ``,
    `## Allowed Tools`,
    toolList,
    ``,
    `## Available Transitions`,
    transitionsList,
    ``,
    `## How to Proceed`,
    `Use your allowed tools to make progress on the task.`,
    `When ready to advance to the next phase, call statewright_transition(event="EVENT_NAME", data={"rationale": "why"}).`,
    `Use ALL tools available to you, including any MCP tools (web_fetch, search, etc.).`,
    `Do NOT skip states. Do NOT use sed/python scripts to edit files — use the edit tool.`,
    ``,
    // Local models need explicit tool signatures — large-context models use native calling
    ...(localModelHint ? [
      `## Tool Signatures (for JSON text output)`,
      `- read: {"name": "read", "args": {"path": "file.py"}}`,
      `- bash: {"name": "bash", "args": {"command": "pytest -q"}}`,
      `- edit: {"name": "edit", "args": {"path": "file.py", "old": "exact old text", "new": "replacement text"}}`,
      `- grep: {"name": "grep", "args": {"pattern": "search", "path": "."}}`,
      `- ls: {"name": "ls", "args": {"path": "."}}`,
      `- statewright_transition: {"name": "statewright_transition", "args": {"event": "EVENT", "data": {"rationale": "why"}}}`,
      ``,
      ``,
      `Respond with ONLY a JSON object, no other text.`,
      `Your response MUST contain a "tool_calls" array with at least one tool call.`,
      `A response with only "thought" and no "tool_calls" is INVALID.`,
      ``,
      `Format: {"tool_calls": [{"name": "TOOL_NAME", "args": {...}}]}`,
      `With reasoning: {"thought": "brief analysis", "tool_calls": [{"name": "tool", "args": {...}}]}`,
      ``,
      `If you need information, call read. If you know the fix, call edit. To advance phases, call statewright_transition.`,
    ] : []),
  ].join("\n")
}

// --- Helper: extract clean text from pi.exec result ---
// pi.exec returns {stdout, stderr, code} objects, not raw strings.
function execText(r: unknown): string {
  if (typeof r === "string") return r
  const obj = r as Record<string, unknown>
  if (obj?.stdout !== undefined) {
    const out = (obj.stdout as string) || ""
    const err = (obj.stderr as string) || ""
    const code = obj.code as number ?? 0
    if (code !== 0 && err) return `${out}\n[exit ${code}] ${err}`.trim()
    return out || err || "(no output)"
  }
  return JSON.stringify(r)
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
  swLog(`extractToolCalls] input (${trimmed.length} chars): ${trimmed.slice(0, 500).replace(/\n/g, "\\n")}`)

  // Pi-style tool call tags: <call:toolName{key: "value", ...}<tool_call|>
  // Gemma4 emits this format instead of structured tool calls in Pi TUI.
  const piCallRegex = /<call:(\w+)\{([^}]*)\}<tool_call\|>/g
  const piCalls: ParsedToolCall[] = []
  let piMatch
  while ((piMatch = piCallRegex.exec(trimmed)) !== null) {
    const toolName = piMatch[1]
    const argsStr = piMatch[2].trim()
    try {
      // Parse JS-object-like args: key: "value" → {"key": "value"}
      const jsonStr = argsStr.replace(/(\w+)\s*:/g, '"$1":')
      const args = JSON.parse(`{${jsonStr}}`)
      piCalls.push({ name: toolName, args })
    } catch {
      // Fallback: treat entire args string as the command for bash
      if (toolName === "bash" || toolName === "sh") {
        const cmdMatch = argsStr.match(/command:\s*"([^"]*)"/)
        if (cmdMatch) piCalls.push({ name: "bash", args: { command: cmdMatch[1] } })
      } else {
        const pathMatch = argsStr.match(/path:\s*"([^"]*)"/)
        if (pathMatch) piCalls.push({ name: toolName, args: { path: pathMatch[1] } })
      }
    }
  }
  if (piCalls.length > 0) return piCalls

  // Harmony format: to=functions.TOOL_NAME {...json...}
  // Used by gpt-oss and reasoning models that embed tool calls in commentary tokens
  const harmonyRegex = /to=functions\.(\w+)\s*(\{[\s\S]*?\})/g
  const harmonyCalls: ParsedToolCall[] = []
  let harmonyMatch
  while ((harmonyMatch = harmonyRegex.exec(trimmed)) !== null) {
    try {
      const args = JSON.parse(harmonyMatch[2])
      harmonyCalls.push({ name: harmonyMatch[1], args })
    } catch { /* invalid JSON args */ }
  }
  if (harmonyCalls.length > 0) return harmonyCalls

  // <channel|> format: Gemma4 emits <channel|> followed by JSON in a code block
  // Also handles <tool_call|> standalone tags and {"shell": "command"} objects
  const channelClean = trimmed
    .replace(/<\/?channel\|?>/g, "")
    .replace(/<\/?tool_call\|?>/g, "")
    .trim()
  if (channelClean !== trimmed) {
    // Stripped channel/tool_call tags — try parsing the remaining content
    const jsonMatch = channelClean.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    const jsonText = jsonMatch ? jsonMatch[1].trim() : channelClean
    try {
      const obj = JSON.parse(jsonText)
      // {"shell": "command"} → bash
      if (typeof obj.shell === "string") return [{ name: "bash", args: { command: obj.shell } }]
      // {"command": "..."} → bash
      if (typeof obj.command === "string") return [{ name: "bash", args: { command: obj.command } }]
      // {"name": "tool", "args": {...}} → direct
      if (typeof obj.name === "string") return [{ name: obj.name, args: obj.args ?? obj.parameters ?? {} }]
      // {"tool_calls": [...]}
      if (Array.isArray(obj.tool_calls)) {
        return obj.tool_calls.filter((tc: any) => typeof tc.name === "string")
          .map((tc: any) => ({ name: tc.name, args: tc.args ?? tc.arguments ?? {} }))
      }
    } catch { /* not JSON after stripping tags */ }
  }

  // JSON parsing FIRST — takes priority over code block extraction.
  // When model outputs {"thought": "...code...", "tool_calls": [...]},
  // code blocks inside the thought field must NOT be executed as tools.
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

  // If we found valid JSON with tool_calls or transition, use those — don't fall through to code blocks
  if (parsed) {
    // Format 1: {"tool_calls": [{"name": "...", "args": {...}}]}
    if (Array.isArray(parsed.tool_calls)) {
      return (parsed.tool_calls as Array<Record<string, unknown>>)
        .filter((tc) => typeof tc.name === "string")
        .map((tc) => ({ name: tc.name as string, args: (tc.args ?? tc.arguments ?? {}) as Record<string, unknown> }))
    }
    // Check other JSON formats below (transition, function, etc.)
  }

  // Markdown code blocks → tool calls (gemma4, small models write ```bash ... ``` instead of calling tools)
  // Only reached if JSON parsing didn't find tool_calls
  const codeBlockCalls: ParsedToolCall[] = []
  const codeBlockRegex = /```(bash|sh|shell|python|python3|node)\s*\n([\s\S]*?)```/g
  let cbMatch
  while ((cbMatch = codeBlockRegex.exec(trimmed)) !== null) {
    const lang = cbMatch[1]
    const code = cbMatch[2].trim()
    if (!code) continue
    if (lang === "bash" || lang === "sh" || lang === "shell") {
      codeBlockCalls.push({ name: "bash", args: { command: code } })
    } else if (lang === "python" || lang === "python3") {
      codeBlockCalls.push({ name: "bash", args: { command: `python3 -c ${JSON.stringify(code)}` } })
    } else if (lang === "node") {
      codeBlockCalls.push({ name: "bash", args: { command: `node -e ${JSON.stringify(code)}` } })
    }
  }
  if (codeBlockCalls.length > 0) return codeBlockCalls

  // Inline command patterns: "I'll run `ls -R`" or "Let me execute `pytest -q`"
  const inlineCmd = trimmed.match(/(?:run|execute|try|call|use)\s+`([^`]+)`/i)
  if (inlineCmd) {
    return [{ name: "bash", args: { command: inlineCmd[1] } }]
  }

  // Remaining JSON formats (only if parsed succeeded but no tool_calls found)
  if (!parsed) return []

  // Format 1 (tool_calls) already handled above — before code block extraction

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

// --- Tier 3: Local model disambiguation ---

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434"
const TIER3_MODEL = process.env.STATEWRIGHT_TIER3_MODEL || "qwen3:0.6b"
const TIER3_TIMEOUT_MS = 1500

const TIER3_REASONING_MODEL = process.env.STATEWRIGHT_TIER3_REASONING_MODEL || "qwen3:4b"
const TIER3_REASONING_TIMEOUT_MS = 5000

interface Tier3Result {
  decision: "allow" | "deny"
  reason: string
  steeringPrompt?: string  // reasoning model provides guidance on deny
}

function buildTier3Prompt(command: string, state: StateCache): string {
  return [
    `You are a security gate for an AI coding agent.`,
    `Current workflow phase: ${state.state}`,
    `Allowed commands: ${state.allowedCommands.join(", ") || "(any)"}`,
    `Phase instructions: ${state.instructions || "none"}`,
    ``,
    `The agent wants to run: ${command}`,
    ``,
    `Only approve if this command is within the declared allowed commands and is not destructive.`,
    `When in doubt, deny.`,
  ].join("\n")
}

async function callOllamaClassifier(
  model: string, prompt: string, timeout: number,
): Promise<{ decision: string; reason: string } | null> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: {
          type: "object",
          properties: {
            decision: { type: "string", enum: ["allow", "deny"] },
            reason: { type: "string" },
          },
          required: ["decision", "reason"],
        },
        options: { temperature: 0 },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(timeout),
    })
    if (!resp.ok) return null
    const data = await resp.json() as { message?: { content?: string } }
    if (!data.message?.content) return null
    return JSON.parse(data.message.content)
  } catch { return null }
}

async function consultLocalModel(
  command: string,
  state: StateCache,
): Promise<Tier3Result> {
  // Only consult if danger_level is "safe" — moderate/dangerous deny by default
  if (state.meta.danger_level && state.meta.danger_level !== "safe") {
    return { decision: "deny", reason: `danger_level is ${state.meta.danger_level}` }
  }

  const prompt = buildTier3Prompt(command, state)

  // Fast classifier: Qwen3:0.6B
  const fast = await callOllamaClassifier(TIER3_MODEL, prompt, TIER3_TIMEOUT_MS)

  if (!fast) {
    swLog(`tier3] fast model unreachable — defaulting to deny`)
    return { decision: "deny", reason: "classifier unavailable" }
  }

  if (fast.decision === "allow") {
    swLog(`tier3] ALLOW: ${command} — ${fast.reason}`)
    return { decision: "allow", reason: fast.reason }
  }

  // Fast model said deny — escalate to reasoning model for a steering prompt
  swLog(`tier3] fast DENY: ${command} — ${fast.reason}. Escalating to reasoning model.`)

  const reasoningPrompt = [
    prompt,
    ``,
    `The fast classifier DENIED this command with reason: "${fast.reason}"`,
    ``,
    `Provide a brief steering message (1-2 sentences) telling the agent what it should do instead.`,
    `Include a concrete alternative command if possible.`,
    `Format: {"decision": "deny", "reason": "your steering guidance"}`,
  ].join("\n")

  const reasoning = await callOllamaClassifier(
    TIER3_REASONING_MODEL, reasoningPrompt, TIER3_REASONING_TIMEOUT_MS,
  )

  if (reasoning) {
    swLog(`tier3] reasoning: ${reasoning.reason}`)
    return { decision: "deny", reason: fast.reason, steeringPrompt: reasoning.reason }
  }

  return { decision: "deny", reason: fast.reason }
}

// --- Command tier evaluation ---

function evaluateCommandTier(
  command: string,
  state: StateCache,
): "allow" | "deny" | "ambiguous" {
  const safePattern = /^\s*(ls|cat|head|tail|wc|file|find|tree|pwd|echo|date|which|type|env|printenv|git\s+(status|log|diff|branch|show|remote)|grep|rg|fd|ag|pytest|cargo\s+test|npm\s+test|make\s+test)\b/
  const dangerousPattern = /[>|]|&&\s*(rm|mv|cp)|;\s*(rm|mv|cp)|rm\s|rmdir|shred|truncate|mv\s|cp\s|mkdir|chmod|chown|curl|wget|sed\s+-i|dd\s|tee\s/
  const scriptPattern = /\b(python3?|node|ruby|perl|php)\b/
  const leavesDir = /\.\.\/?|^\s*cd\s/

  // Tier 1: safe read-only
  if (safePattern.test(command) && !dangerousPattern.test(command) && !leavesDir.test(command)) {
    return "allow"
  }

  // Tier 2: clearly destructive
  if (dangerousPattern.test(command) || leavesDir.test(command)) {
    return "deny"
  }

  // Tier 2b: scripting interpreter without write tools
  const hasWriteTools = state.allowedTools.some(t =>
    toolNamesMatch(t, "edit") || toolNamesMatch(t, "write"))
  if (!hasWriteTools && scriptPattern.test(command)) {
    return "deny"
  }

  // Tier 2c: check against allowed_commands if present
  if (state.allowedCommands.length > 0) {
    const matchesAllowed = state.allowedCommands.some(pattern => {
      // Support glob patterns via minimatch
      return minimatch(command, pattern, { matchBase: true }) ||
             minimatch(command.split(/\s+/)[0], pattern, { matchBase: true })
    })
    if (!matchesAllowed) return "deny"
  }

  // Tier 3: ambiguous
  return "ambiguous"
}

// --- Extension entry ---

export default async function statewrightExtension(pi: ExtensionAPI) {
  // Per-instance state tracking (scoped to this extension load, not module-level)
  let lastSwitchedModel: string | null = null
  let originalModel: unknown = null  // saved before first statewright-driven switch
  let originalTools: string[] | null = null  // saved before first tool restriction
  let lastThinkingLevel: string | null = null
  let currentRunId: string | null = null  // tracks active workflow run for log capture
  let yoloWasEnabled = false  // track if we enabled YOLO so we can restore on deactivate

  // --- Permission system integration (pi-permission-system) ---
  function setAutonomousPermissions(enabled: boolean) {
    const ps = (globalThis as any).__piPermissionSystem
    if (!ps) {
      swLog(`permissions] pi-permission-system not installed — YOLO toggle skipped`)
      return
    }
    if (enabled && !yoloWasEnabled) {
      ps.setYoloMode(true, { persist: false, source: "statewright" })
      yoloWasEnabled = true
      swLog(`permissions] YOLO enabled (autonomous workflow)`)
    } else if (!enabled && yoloWasEnabled) {
      ps.setYoloMode(false, { persist: false, source: "statewright" })
      yoloWasEnabled = false
      swLog(`permissions] YOLO disabled (workflow ended/deactivated)`)
    }
  }

  // --- Unified inactivity monitor ---
  // Single timer replaces the separate rambling watchdog + idle loop timer.
  // Fires when the model goes too long without a tool call, whether it's
  // streaming text or completely silent. Uses deliverAs to avoid "Agent is
  // already processing" errors — never bare sendUserMessage().
  const INACTIVITY_TIMEOUT_MS = 60000  // 60s base
  const MAX_NUDGES = 5
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null
  let nudgeCount = 0
  let lastNudgeTime = 0

  function deliverCorrective(msg: string) {
    if (dormant || !stateCache || stateCache.isFinal) return
    const now = Date.now()
    if (now - lastNudgeTime < 5000) return  // debounce: min 5s between correctives
    lastNudgeTime = now
    try {
      // steer interrupts mid-stream; followUp queues for next turn. Both are safe
      // during streaming — neither throws "Agent is already processing".
      pi.sendUserMessage(msg, { deliverAs: "steer" })
    } catch {
      try { pi.sendUserMessage(msg, { deliverAs: "followUp" }) } catch {
        swLog(`corrective] all delivery modes failed`)
      }
    }
  }

  function armInactivityTimer() {
    if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null }
    if (!stateCache || stateCache.isFinal || dormant) return
    const thinkingMultiplier = (stateCache.thinkingLevel && stateCache.thinkingLevel !== "off") ? 3 : 1
    // Plugin mode: 90s — model needs time to think + produce JSON tool calls.
    // Agentic mode: standard 60s timeout.
    const baseTimeout = isPluginOrchestrated() ? 90000 : INACTIVITY_TIMEOUT_MS
    const timeout = baseTimeout * thinkingMultiplier

    swLog(`inactivity] arming timer: ${timeout / 1000}s (plugin=${isPluginOrchestrated()})`)
    inactivityTimer = setTimeout(() => {
      inactivityTimer = null
      if (!stateCache || stateCache.isFinal || dormant) return

      // Abort the current stream — steer messages queue behind a running stream
      // and never get delivered. Abort kills the stream, then the corrective
      // fires as a fresh prompt via agent_end or the next turn.
      if (currentAbortCtx) {
        try {
          swLog(`inactivity] calling abort()`)
          currentAbortCtx.abort()
          swLog(`inactivity] abort() returned`)
        } catch (err) {
          swLog(`inactivity] abort() threw — clearing stale ctx`)
          currentAbortCtx = null
        }
      }

      nudgeCount++
      swLog(`inactivity] fired after ${timeout / 1000}s (nudge ${nudgeCount}/${MAX_NUDGES})`)

      if (nudgeCount > MAX_NUDGES) {
        swLog(`inactivity] max nudges exceeded — auto-transitioning FAIL`)
        const failEvent = stateCache.transitions.find(t => t.event === "FAIL")?.event ?? "FAIL"
        gwCall("statewright_transition", {
          event: failEvent,
          data: { rationale: `Agent stuck: ${nudgeCount} consecutive turns without a successful tool call` },
        }).then(async () => {
          await refreshState()
          if (stateCache) {
            swLog(`auto-FAIL] transitioned to ${stateCache.state} (isFinal=${stateCache.isFinal})`)
          }
        }).catch((err) => {
          swLog(`auto-FAIL] FAIL transition failed: ${err instanceof Error ? err.message : String(err)}`)
          // Force local state to final to break the loop even if gateway is unreachable
          if (stateCache) stateCache.isFinal = true
        })
        return
      }

      const instructions = stateCache.instructions ?? "Proceed with the task."
      const tools = stateCache.allowedTools.map(normalizeToolName).join(", ")
      const transitions = stateCache.transitions.map(t => `${t.event} -> ${t.target}`).join(", ")

      let msg: string
      if (nudgeCount <= 2) {
        msg = `State: ${stateCache.state}. Instructions: ${instructions}. Tools: ${tools}. Transitions: ${transitions}. Respond with JSON tool_calls now.`
      } else {
        msg = `FINAL WARNING (${nudgeCount}/${MAX_NUDGES}). State: ${stateCache.state}. Tools: ${tools}. Transitions: ${transitions}. Call a tool or use statewright_transition to advance. If stuck: statewright_transition(event="FAIL", data={"rationale": "why"})`
      }

      deliverCorrective(msg)
      armInactivityTimer()  // re-arm for next cycle
    }, timeout)
  }

  function disarmInactivityTimer() {
    if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null }
  }

  function resetInactivity() {
    disarmInactivityTimer()
    nudgeCount = 0
    lastNudgeTime = 0
  }

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

  // --- Text-only Ollama provider for plugin orchestration mode ---
  // When orchestration="plugin" and the model has a small context window,
  // we need full control over response parsing. Pi's built-in OpenAI-compat
  // provider tries to parse native tool_calls from the response, but small
  // Ollama models emit malformed tool calls that Pi can't execute.
  //
  // This provider wraps the same Ollama endpoint but only emits text events.
  // Our message_end recovery handler (extractToolCallsFromText) parses the
  // JSON tool calls from the text — same architecture as the Rust harness.
  //
  // Registered as "ollama-text" — use models.json to point models at it
  // or switch programmatically via pi.setModel().
  try {
    const { createAssistantMessageEventStream } = require("@earendil-works/pi-ai") as { createAssistantMessageEventStream: () => any }
    pi.registerProvider("ollama-text", {
      name: "Ollama (text-only, no native tool calls)",
      api: "openai-completions" as any,
      streamSimple(model, context, options) {
        const stream = createAssistantMessageEventStream()
        const base = (model.baseUrl || "").replace(/\/+$/, "")
        const url = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`
        const apiKey = model.apiKey || "ollama"

        const makeMessage = (text: string, stopReason: string, errorMsg?: string): any => ({
          role: "assistant",
          content: text ? [{ type: "text", text }] : [],
          api: "openai-completions",
          provider: "ollama-text",
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason,
          errorMessage: errorMsg,
          timestamp: Date.now(),
        })

        ;(async () => {
          try {
            // Convert Pi's internal messages to OpenAI chat format
            const chatMessages: Array<{role: string; content: string}> = []
            if (context.systemPrompt) chatMessages.push({ role: "system", content: context.systemPrompt })
            for (const msg of (context.messages ?? [])) {
              if (msg.role === "assistant") {
                const text = (msg.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
                if (text) chatMessages.push({ role: "assistant", content: text })
              } else if (msg.role === "user") {
                const text = typeof msg.content === "string" ? msg.content
                  : Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
                  : String(msg.content ?? "")
                if (text) chatMessages.push({ role: "user", content: text })
              } else {
                const text = typeof msg.content === "string" ? msg.content
                  : Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
                  : String(msg.content ?? "")
                if (text) chatMessages.push({ role: "user", content: text })
              }
            }

            const body = JSON.stringify({
              model: model.id,
              messages: chatMessages,
              stream: true,
            })

            const resp = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
              body,
              signal: options?.signal,
            })

            if (!resp.ok || !resp.body) {
              stream.push({ type: "error", reason: "error", error: makeMessage("", "error", `Ollama ${resp.status}`) } as any)
              return
            }

            const output: any = { role: "assistant", content: [{ type: "text", text: "" }] }
            stream.push({ type: "start", partial: output })
            stream.push({ type: "text_start", contentIndex: 0, partial: output })

            const reader = resp.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""
            let fullText = ""

            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })

              const lines = buffer.split("\n")
              buffer = lines.pop() || ""

              for (const line of lines) {
                if (!line.startsWith("data: ")) continue
                const data = line.slice(6).trim()
                if (data === "[DONE]") continue
                try {
                  const chunk = JSON.parse(data)
                  const delta = chunk.choices?.[0]?.delta?.content || ""
                  if (delta) {
                    fullText += delta
                    output.content = [{ type: "text", text: fullText }]
                    stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output })
                  }
                } catch { /* skip */ }
              }
            }

            const finalMsg = makeMessage(fullText, "stop")
            stream.push({ type: "text_end", contentIndex: 0, content: fullText, partial: output })
            stream.push({ type: "done", reason: "stop", message: finalMsg } as any)
            stream.end()
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            stream.push({ type: "error", reason: "error", error: makeMessage("", "error", errMsg) } as any)
          }
        })()

        return stream
      },
    })
    swLog(`provider] registered ollama-text (text-only Ollama provider)`)
  } catch (err) {
    swLog(`provider] could not register ollama-text: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Show status bar immediately on startup + auto-load from env
  pi.on("session_start" as any, async (_event: unknown, ctx: any) => {
    ctx.ui?.setStatus?.("!statewright", formatStatusBar(stateCache))

    // Auto-load workflow from STATEWRIGHT_WORKFLOW env var (for CI/harness/experiments)
    const autoWorkflow = process.env.STATEWRIGHT_WORKFLOW
    if (autoWorkflow && !stateCache) {
      const result = await gwCall("statewright_load_workflow", { name: autoWorkflow }) as { run_id?: string } & Record<string, unknown> | null
      if (result && !(result as Record<string, unknown>)._error) {
        dormant = false
        currentRunId = (result as { run_id?: string }).run_id ?? null
        await refreshState()
        if (stateCache) {
          swLog(`auto-load] STATEWRIGHT_WORKFLOW=${autoWorkflow} → state=${stateCache.state}`)
          ctx.ui?.setStatus?.("!statewright", formatStatusBar(stateCache))
          ctx.ui?.notify?.(`[statewright] Auto-loaded workflow: ${autoWorkflow}`, "info")

          if (stateCache.meta?.autonomous) {
            setAutonomousPermissions(true)
          }
          armInactivityTimer()
        }
      } else {
        swLog(`auto-load] STATEWRIGHT_WORKFLOW=${autoWorkflow} failed: ${(result as Record<string, unknown>)?._error || "no result"}`)
      }
    }
  })

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
      if (!state) return { content: [{ type: "text", text: "No active workflow. Use statewright_load_workflow to start one." }] }
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
      // Flag missing rationale so the model learns to include it
      if (!params.data?.rationale) {
        return {
          content: [{ type: "text", text: `Transition rejected: you MUST include data.rationale explaining WHY you are transitioning. Call again with: statewright_transition(event="${params.event}", data={"rationale": "your reason here"})` }],
          isError: true,
        }
      }

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
      const result = await gwCall("statewright_load_workflow", params) as { run_id?: string } & Record<string, unknown> | null
      if (!result) return { content: [{ type: "text", text: lastGwError || "Gateway not reachable" }], isError: true }

      dormant = false
      pluginStepCount = 0
      currentRunId = (result as { run_id?: string }).run_id ?? null
      logSequence = 0
      await refreshState()

      // If gateway didn't create a run (self-hosted, no metering), create via PB REST
      if (!currentRunId) {
        await ensureRunRecord(params.name)
      }

      // Autonomous mode: enable YOLO permissions + start idle detector
      swLog(`load] meta=${JSON.stringify(stateCache?.meta)}, autonomous=${stateCache?.meta?.autonomous}`)
      if (stateCache?.meta?.autonomous) {
        swLog(`load] autonomous mode ENABLED — YOLO + idle timer active`)
        setAutonomousPermissions(true)
        armInactivityTimer()
      }

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
      setAutonomousPermissions(false)
      disarmInactivityTimer()
      disarmInactivityTimer()
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
      disarmInactivityTimer()
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

  pi.registerTool({
    name: "statewright_search_docs",
    label: "Search Docs",
    description: "Search statewright documentation for workflow schema fields, MCP tools, patterns, and troubleshooting.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query (e.g., fork join, model routing, allowed_tools)" }),
    }),
    async execute(_id, params: { query: string }) {
      try {
        const resp = await fetch("https://docs.statewright.ai/search-index.json", {
          signal: AbortSignal.timeout(5000),
        })
        if (!resp.ok) return { content: [{ type: "text", text: "Docs not available" }] }
        const index = await resp.json() as Array<{ url: string; title: string; section: string; content: string }>
        const terms = params.query.toLowerCase().split(/\s+/)
        const scored = index
          .map((chunk) => {
            const t = chunk.title.toLowerCase()
            const s = chunk.section.toLowerCase()
            const c = chunk.content.toLowerCase()
            const titleHits = terms.filter((term) => t.includes(term) || s.includes(term)).length
            const contentHits = terms.filter((term) => c.includes(term)).length
            return { ...chunk, score: titleHits * 3 + contentHits }
          })
          .filter((c) => c.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map((c) => ({ url: c.url, title: c.title, section: c.section, snippet: c.content.slice(0, 500) }))
        if (scored.length === 0) return { content: [{ type: "text", text: "No results found." }] }
        return { content: [{ type: "text", text: JSON.stringify(scored, null, 2) }] }
      } catch {
        return { content: [{ type: "text", text: "Docs search failed." }] }
      }
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
    // Build branch system prompt with the state machine context
    const branchState = stateCache ? stateCache.allowedTools.map(normalizeToolName).join(", ") : "read, edit, write, bash"
    const systemPrompt = [
      `You are a parallel branch agent. Your branch: "${branch}".`,
      ``,
      `YOUR TASK:`,
      `${task}`,
      ``,
      `RULES:`,
      `1. The statewright workflow is already loaded. You start in the "implementing" state.`,
      `2. Available tools: ${branchState}. Use them to complete the task.`,
      `3. When your task is DONE, call: statewright_transition(event="DONE", data={rationale: "what you did"})`,
      `4. This will advance you to the terminal state and signal completion.`,
      `5. Do NOT call statewright_load_workflow or statewright_fork. Just implement and transition.`,
      `6. Work autonomously. Do not stop or ask for confirmation.`,
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
          if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192)
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
      // Suspend inactivity timer — fork execution takes minutes
      resetInactivity()
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
        if (!forkEvent) {
          return {
            content: [{ type: "text", text: `No FORK transition available from state '${stateCache.state}'. Cannot dispatch branches without a FORK transition or an active fork context.` }],
            isError: true,
          }
        }
        const forkResult = await gwCall("statewright_transition", {
          event: forkEvent,
          data: { rationale: "Dispatching parallel fork branches" },
        }) as { forked?: boolean; branches?: Record<string, unknown> } | null
        if (!forkResult?.forked || !forkResult.branches) {
          return {
            content: [{ type: "text", text: `FORK transition '${forkEvent}' fired but did not create branch sessions. The transition likely points to a target state (e.g. "FORK": "forking") instead of a fork definition (e.g. "FORK": { "fork": { "branches": {...}, "join": "all", "on_complete": "...", "on_fail": "..." } }). Fix the workflow definition so the FORK event includes branch definitions.` }],
            isError: true,
          }
        }
        gatewayBranches = Object.keys(forkResult.branches)
        swLog(`fork: engine transition fired (${forkEvent}), branches: ${gatewayBranches.join(", ")}`)
        await refreshState()
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

      // Map model tasks to gateway branch names (name match first, positional fallback)
      const branches = gatewayBranches.length > 0
        ? gatewayBranches.map((gwName, i) => {
            const nameMatch = modelBranches.find((b) => b.branch === gwName)
            return {
              branch: gwName,
              task: nameMatch?.task ?? modelBranches[i]?.task ?? `Complete the ${gwName} branch`,
              cwd: nameMatch?.cwd ?? modelBranches[i]?.cwd,
            }
          })
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
          const branchDoneArgs = {
            event: `BRANCH_DONE:${b.branch}`,
            data: {
              rationale: `Branch ${b.branch} completed`,
              branch: b.branch,
              exit_code: results[idx].exitCode,
              output_summary: results[idx].output.slice(0, 500),
            },
          }
          let doneResult = await gwCall("statewright_transition", branchDoneArgs)
          if (!doneResult) {
            // Retry once after a pause — lock contention may have caused timeout
            swLog(`fork] BRANCH_DONE:${b.branch} failed, retrying after 2s`)
            await new Promise((r) => setTimeout(r, 2000))
            doneResult = await gwCall("statewright_transition", branchDoneArgs)
          }
          if (!doneResult) {
            swLog(`fork] BRANCH_DONE:${b.branch} FAILED after retry — join may not fire`)
            results[idx].exitCode = 2  // mark as degraded
          } else {
            swLog(`fork] BRANCH_DONE:${b.branch} accepted`)
          }
        }
      })
      await Promise.all(workers)

      // Refresh state — retry until _fork is cleared (join completed)
      for (let retry = 0; retry < 5; retry++) {
        await refreshState()
        if (stateCache && !stateCache.context?._fork && !stateCache.fork?.active) break
        swLog(`fork] _fork still active after join (state=${stateCache?.state}), retrying refresh (${retry + 1}/5)`)
        await new Promise((r) => setTimeout(r, 1000 * (retry + 1)))
      }
      // Suppress watchdog for one cycle — the agent needs time to process fork results
      disarmInactivityTimer()

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
        if (!result) { ctx.ui.notify(`[statewright] ${lastGwError || "Gateway not reachable"}`, "error"); return }
        if ((result as Record<string, unknown>)._error) { ctx.ui.notify(`[statewright] ${(result as Record<string, unknown>)._error}`, "error"); return }
        dormant = false
        pluginStepCount = 0
        await refreshState()
        if (stateCache) await applyModelRouting(stateCache, ctx)

        // Autonomous mode: enable YOLO + idle detector
        if (stateCache?.meta?.autonomous) {
          setAutonomousPermissions(true)
          armInactivityTimer()
        }

        ctx.ui.notify(`[statewright] Workflow '${name}' loaded. State: ${stateCache?.state ?? "unknown"}`, "success")

        // Kick off: send the state instructions as a followUp so the model acts immediately
        if (stateCache && !stateCache.isFinal) {
          const tools = stateCache.allowedTools.map(normalizeToolName).join(", ")
          const transitions = stateCache.transitions.map(t => describeTransition(t, stateCache!)).join(", ")
          const taskHint = parts.slice(2).join(" ")  // optional task after workflow name
          const kickoff = taskHint
            ? `${taskHint}\n\nPhase: '${stateCache.state}'. Tools: ${tools}. Transitions: ${transitions}.${stateCache.instructions ? ` Instructions: ${stateCache.instructions}` : ""} Begin immediately.`
            : `Phase: '${stateCache.state}'. Tools: ${tools}. Transitions: ${transitions}.${stateCache.instructions ? ` Instructions: ${stateCache.instructions}` : ""} Begin immediately.`
          pi.sendUserMessage(kickoff, { deliverAs: "followUp" })
        }
      } else if (sub === "deactivate" || sub === "stop" || sub === "off") {
        const result = await gwCall("statewright_deactivate")
        if (!result) { ctx.ui.notify("[statewright] Gateway not reachable", "error"); return }
        dormant = true
        stateCache = null
        lastSwitchedModel = null
        lastThinkingLevel = null
        setAutonomousPermissions(false)
        disarmInactivityTimer()
        if (originalModel) {
          await pi.setModel(originalModel as Parameters<typeof pi.setModel>[0])
          originalModel = null
        }
        if (originalTools) {
          pi.setActiveTools(originalTools)
          originalTools = null
        }
        ctx.ui.setStatus("!statewright", "")
        ctx.ui.notify("[statewright] Workflow deactivated. All tools unrestricted.", "info")
      } else if (sub === "pause") {
        const result = await gwCall("statewright_pause")
        if (!result) { ctx.ui.notify("[statewright] Gateway not reachable", "error"); return }
        stateCache = null
        ctx.ui.setStatus("!statewright", formatStatusBar(stateCache, "paused"))
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
      const currentModel = ctx.model as { provider?: string; id?: string; baseUrl?: string } | undefined
      swLog(`model] state=${state.state} want=${state.model} have=${currentModel?.provider}/${currentModel?.id} lastSwitched=${lastSwitchedModel}`)

      // Plugin orchestration + Ollama model: auto-switch to text-only provider
      // This forces all responses through our extractToolCallsFromText parser
      // instead of Pi's native tool call interpretation (which breaks on small models)
      if (isPluginOrchestrated() && currentModel?.provider?.startsWith("ollama") && currentModel.provider !== "ollama-text") {
        const textModel = ctx.modelRegistry.find("ollama-text", currentModel.id)
        if (!textModel) {
          // Register the model under ollama-text dynamically
          try {
            pi.registerProvider("ollama-text", {
              name: "Ollama (text-only)",
              baseUrl: currentModel.baseUrl || `https://${currentModel.id.replace(":", "-")}.ollama.casa.enhasa.cloud/v1`,
              apiKey: "ollama",
              models: [{
                id: currentModel.id,
                name: `${currentModel.id} (text-only)`,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              }],
            })
            swLog(`model] registered ${currentModel.id} under ollama-text provider`)
          } catch { /* already registered */ }
        }
        const resolved = ctx.modelRegistry.find("ollama-text", currentModel.id)
        if (resolved) {
          swLog(`model] auto-switching to ollama-text/${currentModel.id} for plugin orchestration`)
          await pi.setModel(resolved as Parameters<typeof pi.setModel>[0])
          ctx.ui.notify(`[statewright] Text-only mode: ${currentModel.id}`, "info")
        }
      }
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

    // --- Inactivity monitor ---
    // Only arm if not already running. Recovery-triggered turns (sendUserMessage
    // from message_end) fire applyModelRouting via before_agent_start — those
    // must NOT reset the countdown or the timer never fires.
    if (!inactivityTimer) armInactivityTimer()

    ctx.ui.setStatus("!statewright", formatStatusBar(state))
  }

  // --- Context injection (before each agent turn) ---

  // Capture the latest abort context so the inactivity timer can kill runaway streams
  let currentAbortCtx: { abort: () => void } | null = null

  pi.on("before_agent_start", async (_event, ctx) => {
    if (dormant) return
    currentAbortCtx = ctx as unknown as { abort: () => void }
    pluginStepCount++
    const state = await refreshState()
    if (!state) return

    await applyModelRouting(state, ctx)

    // Arm inactivity timer only if not already running.
    // Recovery-triggered turns (sendUserMessage from message_end) fire
    // before_agent_start — those should NOT reset the countdown.
    // Only genuine tool calls through the enforcement layer reset it.
    if (!inactivityTimer) armInactivityTimer()

    if (state.isFinal) {
      // Don't restrict fresh sessions — a stale "completed" workflow from
      // a previous session should not block the current one.
      stateCache = null
      dormant = true
      ctx.ui.setStatus("!statewright", formatStatusBar(null))
      return
    }

    if (isPluginOrchestrated()) {
      // Detect context size — small models get JSON tool signatures, large models use native calling
      const ctxUsage = (ctx as unknown as { getContextUsage?: () => { contextWindow?: number } }).getContextUsage?.()
      const isSmallContext = (ctxUsage?.contextWindow ?? 33000) < LARGE_CONTEXT_THRESHOLD

      // --- Programmatic reconnaissance ---
      // Skip the LLM entirely for reconnaissance/localizing states.
      // Run tests, read source files, package results, auto-transition.
      const isReconState = /^(reconnaissance|localizing)$/i.test(state.state)
      const hasHypothesisTransition = state.transitions.some(t =>
        t.event === "HYPOTHESIS_FORMED" || t.event === "LOCALIZED"
      )
      if (isReconState && hasHypothesisTransition) {
        swLog(`programmatic] running reconnaissance — no LLM needed`)
        ctx.ui.setStatus("!statewright", formatStatusBar(state, "programmatic"))
        ctx.ui.notify("[statewright] ⚡ Programmatic reconnaissance — running tests, reading source files", "info")

        try {
          // 1. Run tests
          const testResult = await pi.exec("bash", ["-c", "pytest -q 2>&1 || npm test 2>&1 || cargo test 2>&1 || echo 'no test runner found'"])
          const testOutput = execText(testResult)
          swLog(`programmatic] test output: ${testOutput.slice(0, 200)}`)

          // 2. List source files (separate test files from source files)
          const lsResult = await pi.exec("bash", ["-c", "find . -type f \\( -name '*.py' -o -name '*.js' -o -name '*.ts' -o -name '*.rs' \\) | grep -v __pycache__ | grep -v node_modules | grep -v .git | sort"])
          const allFiles = execText(lsResult).trim().split("\n").filter(Boolean)
          const testFiles = allFiles.filter(f => /test_|_test\.|\.test\.|spec\./i.test(f))
          const sourceFiles = allFiles.filter(f => !testFiles.includes(f))
          swLog(`programmatic] found ${sourceFiles.length} source + ${testFiles.length} test files`)

          // 3. Grep-based localization: extract keywords from failures, find relevant code
          //    This mirrors the Rust harness's programmatic localizer — show ~50 lines
          //    of relevant code instead of entire files. Critical for 200+ line files.
          const keywords: string[] = []
          // Extract function/class names from test failures
          const failMatches = testOutput.matchAll(/FAILED\s+\S+::(\w+)/g)
          for (const m of failMatches) keywords.push(m[1])
          // Extract assertion targets
          const assertMatches = testOutput.matchAll(/(?:assert|Error|Exception).*?(\w{4,})/gi)
          for (const m of assertMatches) {
            if (!/^(?:assert|Error|Exception|Failed|FAILED|True|False|None|test)$/i.test(m[1])) {
              keywords.push(m[1])
            }
          }
          // Extract function names from test files
          for (const tf of testFiles) {
            try {
              const content = execText(await pi.exec("cat", [tf]))
              const fnMatches = content.matchAll(/def\s+(test_\w+)|it\s*\(\s*["']([^"']+)/g)
              for (const m of fnMatches) {
                const name = (m[1] || m[2] || "").replace(/^test_/, "")
                if (name.length > 3) keywords.push(name)
              }
            } catch { /* skip */ }
          }
          const uniqueKeywords = [...new Set(keywords)].slice(0, 10)
          swLog(`programmatic] localization keywords: ${uniqueKeywords.join(", ")}`)

          const fileContents: string[] = []

          // Tree-sitter AST localization: parse files into function/class/method chunks,
          // match against failure keywords, show only the relevant definitions.
          // Covers 10 languages via WASM grammars (web-tree-sitter + tree-sitter-wasm).
          // Grep fallback when tree-sitter isn't available or has no grammar for the language.
          const EXT_TO_LANG: Record<string, string> = {
            ".py": "python", ".js": "javascript", ".ts": "typescript", ".tsx": "typescript",
            ".rs": "rust", ".go": "go", ".java": "java", ".c": "c", ".cpp": "cpp",
            ".cs": "c_sharp", ".rb": "ruby",
          }
          const DEF_TYPES = new Set([
            "function_definition", "class_definition", "method_definition",
            "function_declaration", "class_declaration", "method_declaration",
            "function_item", "impl_item", "struct_item",
            "async_function_declaration",
          ])

          let tsParser: any = null
          const tsLangCache: Record<string, any> = {}
          try {
            const TSMod = require("web-tree-sitter")
            const { getWasmPath } = require("tree-sitter-wasm")
            await TSMod.Parser.init()
            tsParser = { mod: TSMod, getWasmPath }
            swLog(`programmatic] tree-sitter WASM initialized`)
          } catch (tsErr) {
            swLog(`programmatic] tree-sitter not available: ${tsErr instanceof Error ? tsErr.message : String(tsErr)}`)
          }

          for (const f of sourceFiles) {
            try {
              const content = execText(await pi.exec("cat", [f]))
              const lines = content.split("\n")
              const lineCount = lines.length

              if (lineCount <= 100) {
                fileContents.push(`--- ${f} (${lineCount} lines, full) ---\n${content}`)
                continue
              }

              // Try tree-sitter AST chunking
              let matched: Array<{name: string; type: string; start: number; end: number}> = []
              const ext = f.slice(f.lastIndexOf("."))
              const langName = EXT_TO_LANG[ext]

              if (tsParser && langName) {
                try {
                  if (!tsLangCache[langName]) {
                    tsLangCache[langName] = await tsParser.mod.Language.load(tsParser.getWasmPath(langName))
                  }
                  const parser = new tsParser.mod.Parser()
                  parser.setLanguage(tsLangCache[langName])
                  const tree = parser.parse(content)

                  const allChunks: typeof matched = []
                  function walk(node: any) {
                    if (DEF_TYPES.has(node.type)) {
                      const nameNode = node.childForFieldName("name")
                      if (nameNode) allChunks.push({ name: nameNode.text, type: node.type, start: node.startPosition.row + 1, end: node.endPosition.row + 1 })
                    }
                    for (let i = 0; i < node.childCount; i++) walk(node.child(i))
                  }
                  walk(tree.rootNode)

                  const kwLower = uniqueKeywords.map(k => k.toLowerCase())
                  matched = allChunks.filter(c => kwLower.some(kw => c.name.toLowerCase().includes(kw) || kw.includes(c.name.toLowerCase())))
                  swLog(`programmatic] tree-sitter ${f}: ${allChunks.length} defs, ${matched.length} matched`)
                } catch (parseErr) {
                  swLog(`programmatic] tree-sitter parse failed for ${f}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`)
                }
              }

              if (matched.length > 0) {
                const excerpts = matched.slice(0, 8).map(chunk => {
                  const s = Math.max(0, chunk.start - 4)
                  const e = Math.min(lineCount, chunk.end + 3)
                  return `  [${chunk.type} "${chunk.name}" lines ${chunk.start}-${chunk.end}]\n${lines.slice(s, e).join("\n")}`
                })
                const imports = lines.slice(0, 20).join("\n")
                fileContents.push(`--- ${f} (${lineCount} lines, tree-sitter: ${matched.length} matched defs) ---\n  [imports]\n${imports}\n  ...\n${excerpts.join("\n  ...\n")}`)
              } else {
                // Grep fallback
                const grepExcerpts: string[] = []
                for (const kw of uniqueKeywords.slice(0, 5)) {
                  for (let i = 0; i < lineCount; i++) {
                    if (lines[i].toLowerCase().includes(kw.toLowerCase()) && grepExcerpts.length < 5) {
                      const s = Math.max(0, i - 15)
                      const e = Math.min(lineCount, i + 16)
                      grepExcerpts.push(`  [lines ${s + 1}-${e}]\n${lines.slice(s, e).join("\n")}`)
                      break
                    }
                  }
                }
                if (grepExcerpts.length > 0) {
                  fileContents.push(`--- ${f} (${lineCount} lines, grep-localized) ---\n${grepExcerpts.join("\n  ...\n")}`)
                } else {
                  fileContents.push(`--- ${f} (${lineCount} lines, head only) ---\n${lines.slice(0, 50).join("\n")}`)
                }
              }
            } catch { /* skip unreadable */ }
          }

          // Always include full test files (they're small and critical for understanding expectations)
          for (const tf of testFiles) {
            try {
              const content = execText(await pi.exec("cat", [tf]))
              fileContents.push(`--- ${tf} (test file, full) ---\n${content}`)
            } catch { /* skip */ }
          }

          swLog(`programmatic] localized ${fileContents.length} file sections, ${uniqueKeywords.length} keywords`)

          // 4. Package into lastToolResult
          lastToolResult = {
            toolName: "programmatic_reconnaissance",
            output: [
              `## Test Results\n${testOutput}`,
              `## Localized Source (${sourceFiles.length} source files, ${testFiles.length} test files)\n${fileContents.join("\n\n")}`,
            ].join("\n\n").slice(0, 12000),
          }

          // 5. Show summary + auto-transition
          const failCount = (testOutput.match(/(\d+) failed/)?.[1]) ?? "?"
          const passCount = (testOutput.match(/(\d+) passed/)?.[1]) ?? "?"
          ctx.ui.notify(`[statewright] Tests: ${failCount} failed, ${passCount} passed. Localized ${sourceFiles.length} source + ${testFiles.length} test files.`, "info")

          const transEvent = state.transitions.find(t =>
            t.event === "HYPOTHESIS_FORMED" || t.event === "LOCALIZED"
          )!.event
          swLog(`programmatic] auto-transitioning ${transEvent}`)
          await gwCall("statewright_transition", {
            event: transEvent,
            data: { rationale: "Programmatic reconnaissance complete — tests run, source files read" },
          })
          await refreshState()

          if (stateCache) {
            ctx.ui.setStatus("!statewright", formatStatusBar(stateCache))
            ctx.ui.notify(`[statewright] ✓ ${state.state} → ${stateCache.state}`, "success")
            return { systemPrompt: buildFreshSystemPrompt(stateCache, isSmallContext) }
          }
        } catch (err) {
          swLog(`programmatic] reconnaissance failed: ${err instanceof Error ? err.message : String(err)}`)
          // Fall through to LLM-based handling
        }
      }

      return { systemPrompt: buildFreshSystemPrompt(state, isSmallContext) }
    }

    return { systemPrompt: formatContext(state) }
  })

  // --- Plugin orchestration: adaptive context window ---
  // Small models (< 64k context): sliding window of 6 messages to prevent accumulation.
  // Large models (>= 64k context): pass through all messages — they handle long context fine
  //   and stripping breaks OpenAI's strict tool call_id pairing.
  const PLUGIN_CONTEXT_WINDOW = 6
  const LARGE_CONTEXT_THRESHOLD = 64000  // tokens — above this, skip windowing

  pi.on("context", async (_event, _ctx) => {
    if (dormant || !stateCache || !isPluginOrchestrated()) return

    const messages = _event.messages as Array<Record<string, unknown>>

    // Check context window size — large models don't need windowing
    const usage = (_ctx as unknown as { getContextUsage?: () => { contextWindow?: number } }).getContextUsage?.()
    const contextWindow = usage?.contextWindow ?? 33000  // default to small if unknown
    if (contextWindow >= LARGE_CONTEXT_THRESHOLD) {
      // Large context: pass through, just prepend recon results if needed
      if (lastToolResult && messages.length === 0) {
        return {
          messages: [
            { role: "user", content: [{ type: "text", text: `Previous result (${lastToolResult.toolName}):\n${lastToolResult.output.slice(0, 4000)}\n\nProceed with the next action.` }] },
          ] as unknown[],
        }
      }
      return  // no modification — full context preserved
    }

    // Small context: sliding window
    const windowed = messages.slice(-PLUGIN_CONTEXT_WINDOW)

    if (lastToolResult) {
      const reconMsg = { role: "user", content: [{ type: "text", text: `Previous result (${lastToolResult.toolName}):\n${lastToolResult.output.slice(0, 4000)}\n\nProceed with the next action.` }] }
      return { messages: [reconMsg, ...windowed].slice(0, PLUGIN_CONTEXT_WINDOW + 1) as unknown[] }
    }

    return { messages: windowed as unknown[] }
  })

  // --- Provider request modifications ---
  // Gemma: rewrite role: "tool" → "tool_responses" to prevent infinite loops.
  pi.on("before_provider_request", async (_event, ctx) => {
    if (dormant || !stateCache) return
    const payload = _event.payload as Record<string, unknown>

    // Gemma role fix
    const model = (ctx as unknown as { model?: { id?: string } }).model
    const isGemma = model?.id?.toLowerCase().includes("gemma") ?? false
    if (isGemma && payload?.messages) {
      for (const msg of payload.messages) {
        if (msg.role === "tool") msg.role = "tool_responses"
      }
    }

    // Plugin orchestration + small context: strip native tool calling.
    // The system prompt already has JSON tool schemas (buildFreshSystemPrompt with localModelHint).
    // Competing native tool calling confuses small models — they produce neither format cleanly.
    // Text-based JSON tool calls are parsed by extractToolCallsFromText in message_end.
    if (isPluginOrchestrated()) {
      const ctxUsage = (ctx as unknown as { getContextUsage?: () => { contextWindow?: number } }).getContextUsage?.()
      const contextWindow = ctxUsage?.contextWindow ?? 33000
      if (contextWindow < LARGE_CONTEXT_THRESHOLD) {
        if (payload.tools) {
          swLog(`before_provider_request] stripping native tools, forcing JSON mode (${contextWindow} < ${LARGE_CONTEXT_THRESHOLD})`)
          delete payload.tools
          try { (ctx as any).ui?.notify?.("[statewright] JSON mode: native tools stripped", "info") } catch {}
        }
      }
    }

    swLog(`before_provider_request] payload keys: ${Object.keys(payload).join(", ")}`)
    return payload
  })

  // --- Tool enforcement (before each tool call) ---

  pi.on("tool_call", async (event, _ctx) => {
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

    // Disallowed tools (blacklist) — check before whitelist
    if (stateCache.disallowedTools.length > 0) {
      const isBlocked = stateCache.disallowedTools.some((t) => toolNamesMatch(t, event.toolName))
      if (isBlocked) {
        return {
          block: true,
          reason: `Tool '${event.toolName}' is blocked in the '${stateCache.state}' phase.`,
        }
      }
    }

    // Bash discernment: always applies for bash, even with empty allowed_tools.
    // If writes are disallowed (blacklist) or not in whitelist, block write-like bash commands.
    if (event.toolName === "bash" || event.toolName === "Bash") {
      const cmd = (event.input?.command ?? "") as string
      const isSafe = /^\s*(ls|cat|head|tail|wc|file|find|tree|pwd|echo|date|which|type|env|printenv|git\s+(status|log|diff|branch|show|remote)|grep|rg|fd|ag|pytest|cargo\s+test|npm\s+test|make\s+test)\b/.test(cmd)
      const isDangerous = /[>|]|&&\s*(rm|mv|cp)|;\s*(rm|mv|cp)|rm\s|rmdir|shred|truncate|mv\s|cp\s|mkdir|chmod|chown|curl|wget|sed\s+-i|dd\s|tee\s/.test(cmd)
      // Block scripting interpreters when writes are disallowed (blacklist or not in whitelist)
      const writesBlacklisted = stateCache.disallowedTools.some((t) => toolNamesMatch(t, "edit") || toolNamesMatch(t, "write"))
      const hasWriteTools = !writesBlacklisted && (
        stateCache.allowedTools.length === 0 || // empty whitelist = no restriction (unless blacklisted)
        stateCache.allowedTools.some((t) => toolNamesMatch(t, "edit") || toolNamesMatch(t, "write"))
      )
      const isScriptWrite = !hasWriteTools && /\b(python3?|node|ruby|perl|php)\b/.test(cmd)
      const leavesDir = /\.\.\/?|^\s*cd\s/.test(cmd)
      const bashAllowed = stateCache.allowedTools.length === 0 ||
        stateCache.allowedTools.some((t) => toolNamesMatch(t, "bash"))
      if (bashAllowed && !isDangerous && !isScriptWrite) {
        return // Bash allowed (or no whitelist) and command isn't destructive/write — pass through
      }
      if (!bashAllowed && isSafe && !isDangerous && !leavesDir && !isScriptWrite) {
        return // Bash not in whitelist but command is safe read-only — pass through
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

    // No whitelist = no further enforcement (blacklist + bash discernment already applied above)
    if (stateCache.allowedTools.length === 0) return

    const isAllowed = stateCache.allowedTools.some((t) => toolNamesMatch(t, event.toolName))
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

    // Tool call allowed through. Inactivity timer is NOT reset here —
    // it only resets on state transitions (via applyModelRouting).
    // A model calling tools without transitioning is still stuck.
  })

  // --- Run + log capture: submit to PocketBase ---
  let logSequence = 0
  let runCreatedLocally = false  // true = self-hosted (plugin created run); false = gateway metering
  const PB_URL = process.env.STATEWRIGHT_PB_URL || process.env.STATEWRIGHT_GATEWAY_URL?.replace(/:\d+$/, ':8090') || "https://statewright.ai"

  async function ensureRunRecord(workflowName: string): Promise<string | null> {
    // If gateway already created a run (metering enabled), use that
    if (currentRunId) return currentRunId
    const apiKey = getApiKey()
    if (!apiKey) return null
    try {
      const resp = await fetch(`${PB_URL}/api/collections/workflow_runs/records`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          workflow_name: workflowName,
          status: "running",
          started_at: new Date().toISOString(),
          transitions: [],
          transition_count: 0,
          session_id: sessionId ?? "",
        }),
        signal: AbortSignal.timeout(5000),
      })
      if (!resp.ok) return null
      const data = await resp.json() as { id?: string }
      if (data.id) {
        currentRunId = data.id
        runCreatedLocally = true
        swLog(`run] Created run ${data.id} via PB REST`)
      }
      return data.id ?? null
    } catch { return null }
  }

  async function updateRunTransition(event: string, from: string, to: string) {
    // Only update when plugin owns the run (self-hosted); gateway handles its own transitions
    const runId = currentRunId
    if (!runCreatedLocally || !runId || !getApiKey()) return
    try {
      // Fetch current, append transition, update
      const resp = await fetch(`${PB_URL}/api/collections/workflow_runs/records/${runId}`, {
        headers: { Authorization: `Bearer ${getApiKey()}` },
        signal: AbortSignal.timeout(5000),
      })
      if (!resp.ok) return
      const run = await resp.json() as { transitions?: unknown[]; transition_count?: number }
      const transitions = Array.isArray(run.transitions) ? run.transitions : []
      transitions.push({ event, from, to, timestamp: new Date().toISOString() })
      await fetch(`${PB_URL}/api/collections/workflow_runs/records/${runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getApiKey()}` },
        body: JSON.stringify({
          transitions,
          transition_count: transitions.length,
          updated: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(5000),
      })
    } catch { /* best effort */ }
  }

  async function completeRun(finalState: string, status: string) {
    // Only update when plugin owns the run (self-hosted); gateway handles its own completion
    const runId = currentRunId
    if (!runCreatedLocally || !runId || !getApiKey()) return
    try {
      await fetch(`${PB_URL}/api/collections/workflow_runs/records/${runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getApiKey()}` },
        body: JSON.stringify({
          status,
          final_state: finalState,
          completed_at: new Date().toISOString(),
          updated: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(5000),
      })
    } catch { /* best effort */ }
  }

  async function captureToolLog(toolName: string, toolInput: unknown, toolOutput: unknown) {
    if (!stateCache || dormant || !getApiKey()) return
    if (toolName.startsWith("statewright_")) return  // skip control tools
    // Only capture if a run is active
    const runId = currentRunId ?? stateCache.runId
    if (!runId) return

    logSequence++
    const payload = {
      phase: stateCache.state,
      tool_name: toolName,
      tool_input: toolInput ?? {},
      tool_output: typeof toolOutput === "string" ? toolOutput.slice(0, 102400) : JSON.stringify(toolOutput ?? "").slice(0, 102400),
      sequence: logSequence,
      duration_ms: 0,
      run_id: runId,
    }
    try {
      await fetch(`${PB_URL}/api/collections/workflow_logs/records`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getApiKey()}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      })
    } catch { /* async, best-effort */ }
  }

  // --- Post-tool: interrupt detection + state tracking ---

  pi.on("tool_result", async (event, ctx) => {
    if (dormant) return

    // Capture tool log (async, non-blocking)
    const toolOutput = (event.content ?? [])
      .filter((c: { type: string; text?: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("\n")
    captureToolLog(event.toolName, event.input, toolOutput).catch(() => {})

    // Plugin orchestration: capture last tool result + auto-transition on test outcomes
    if (isPluginOrchestrated() && stateCache && !stateCache.isFinal) {
      lastToolResult = { toolName: event.toolName, output: toolOutput.slice(0, 4000) }

      // Detect test runners and auto-transition
      const cmd = (event.toolName === "bash" || event.toolName === "Bash")
        ? ((event.input as Record<string, unknown>)?.command ?? "") as string
        : ""
      const isTestRunner = /\b(pytest|npm\s+test|cargo\s+test|make\s+test|jest|vitest|mocha)\b/i.test(cmd)

      // When test results are detected, steer the model with what to do next.
      // This is NOT an auto-transition — it's guidance so the model doesn't spiral
      // trying to reconcile "fix failing tests" with "tests now pass."
      if (isTestRunner) {
        const hasFailures = /\bfailed\b|FAILED|ERROR|error:/i.test(toolOutput)
        const hasPasses = /\bpassed\b/i.test(toolOutput)
        const nearLimit = nudgeCount >= MAX_NUDGES - 1

        if (hasPasses && !hasFailures) {
          const passEvent = stateCache.transitions.find(t => t.event === "TESTS_PASS")
          const doneEvent = stateCache.transitions.find(t => t.event === "DONE")
          const targetEvent = passEvent ?? doneEvent
          if (targetEvent) {
            if (nearLimit) {
              // Last resort: auto-transition
              swLog(`auto-transition] tests passed (last resort, nudge ${nudgeCount}/${MAX_NUDGES}) — firing ${targetEvent.event}`)
              await gwCall("statewright_transition", {
                event: targetEvent.event,
                data: { rationale: "All tests passed (auto-detected — model failed to transition after repeated nudges)" },
              })
              await refreshState()
            } else {
              // Steer: tell the model what happened and what to do
              deliverCorrective(
                `Tests PASSED. Transition now: statewright_transition(event="${targetEvent.event}", data={"rationale": "all tests passing"})`,
              )
            }
          }
        } else if (hasFailures) {
          const failEvent = stateCache.transitions.find(t => t.event === "TESTS_FAIL")
          if (failEvent) {
            if (nearLimit) {
              swLog(`auto-transition] tests failed (last resort, nudge ${nudgeCount}/${MAX_NUDGES}) — firing ${failEvent.event}`)
              await gwCall("statewright_transition", {
                event: failEvent.event,
                data: { rationale: "Tests failed (auto-detected by plugin orchestrator)" },
              })
              await refreshState()
            } else {
              deliverCorrective(
                `Tests FAILED. Transition now: statewright_transition(event="${failEvent.event}", data={"rationale": "tests still failing"})`,
              )
            }
          }
        }
      }
    }

    if (event.toolName.startsWith("statewright_")) {
      const prevState = stateCache?.state
      // For transition calls, extract event name and parse the response for from/to
      if (event.toolName === "statewright_transition") {
        const transEvent = (event.input as Record<string, unknown>)?.event as string ?? "unknown"
        // Parse the tool result content for the transition details
        const resultText = (event.content ?? []).find((c: { type: string }) => c.type === "text") as { text?: string } | undefined
        let fromState = prevState ?? "unknown"
        let toState = "unknown"
        try {
          const parsed = JSON.parse(resultText?.text ?? "{}")
          fromState = parsed.from ?? parsed.previous_state ?? fromState
          toState = parsed.state ?? parsed.to ?? toState
        } catch { /* use prevState fallback */ }
        swLog(`run] transition: ${fromState} → ${toState} (${transEvent}), runId=${currentRunId}`)
        updateRunTransition(transEvent, fromState, toState).catch(() => {})
      }

      await refreshState()
      if (stateCache) {
        await applyModelRouting(stateCache, ctx)
        if (event.toolName === "statewright_load_workflow" && stateCache.state) {
          swLog(`run] workflow loaded, initial state: ${stateCache.state}, runId=${currentRunId}`)
          updateRunTransition("LOAD", "start", stateCache.state).catch(() => {})
        }
        if (stateCache.isFinal) {
          const status = stateCache.state === "completed" ? "completed" : "failed"
          swLog(`run] final state: ${stateCache.state} (${status}), runId=${currentRunId}`)
          completeRun(stateCache.state, status).catch(() => {})
          setAutonomousPermissions(false)
          disarmInactivityTimer()
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
          "!statewright",
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

    if (toolCallParts.length > 0 && !isPluginOrchestrated()) return

    // Check all text parts for embedded tool calls
    let anyExtracted = false
    for (const part of textParts) {
      const extracted = extractToolCallsFromText(part.text as string)
      if (extracted.length === 0) {
        // Parse failed — model produced text without valid tool calls.
        // Rust harness behavior: don't nudge/steer. Just send a fresh prompt
        // with state instructions so the model gets a clean retry.
        if (isPluginOrchestrated() && !stateCache.isFinal) {
          const tools = stateCache.allowedTools.map(normalizeToolName).join(", ")
          const transitions = stateCache.transitions.map(t => `${t.event} → ${t.target}`).join(", ")
          swLog(`recovery] parse failed — sending fresh prompt (Rust harness behavior)`)
          try {
            pi.sendUserMessage(
              `State: ${stateCache.state}. Tools: ${tools}. Transitions: ${transitions}. Respond with ONLY a JSON object: {"tool_calls": [{"name": "TOOL", "args": {...}}]}`,
              { deliverAs: "followUp" },
            )
          } catch { /* followUp may fail */ }
        }
        continue
      }
      anyExtracted = true

      // After any state change in recovery, update status bar + detect final state
      const checkStateAfterTransition = () => {
        if (!stateCache) return
        _ctx.ui.setStatus("!statewright", formatStatusBar(stateCache))
        if (stateCache.isFinal) {
          const status = stateCache.state === "completed" ? "completed" : "failed"
          swLog(`recovery] workflow reached final state: ${stateCache.state}`)
          completeRun(stateCache.state, status).catch(() => {})
          setAutonomousPermissions(false)
          disarmInactivityTimer()
          _ctx.ui.notify(`[statewright] Workflow ${status}.`, status === "completed" ? "success" : "warn")
        }
      }

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
            await refreshState()
            checkStateAfterTransition()
          }
          // Transition tool — Rust harness uses {"name": "transition", "args": {"event": "PLAN_READY"}}
          // Map to statewright_transition gateway call.
          else if (name === "transition" || tc.name === "navigate" || tc.name === "state_transition") {
            const event = (args.event ?? args.transition ?? args.name) as string
            // Try to extract thought from the full message text as rationale
            let rationale = (args.rationale ?? args.reason) as string | undefined
            if (!rationale) {
              const fullText = textParts.map((c: { text?: string }) => c.text ?? "").join("\n")
              try {
                const start = fullText.indexOf("{")
                const end = fullText.lastIndexOf("}")
                if (start >= 0 && end > start) {
                  const j = JSON.parse(fullText.slice(start, end + 1))
                  if (typeof j.thought === "string") rationale = j.thought
                }
              } catch { /* ignore parse errors */ }
              rationale = rationale ?? "model-requested transition"
            }
            if (event) {
              // Fuzzy-match: if the model used a target name or partial event name,
              // resolve to the actual event. e.g. "completed" → TESTS_PASS, "PASS" → TESTS_PASS
              let resolvedEvent = event
              let fuzzyHint = ""
              if (stateCache && !stateCache.isFinal) {
                const exact = stateCache.transitions.find(t => t.event === event)
                if (!exact) {
                  // Try: model used target name → find events that lead there
                  const byTarget = stateCache.transitions.filter(t => t.target.toLowerCase() === event.toLowerCase())
                  if (byTarget.length === 1) {
                    resolvedEvent = byTarget[0].event
                    fuzzyHint = `${ANSI.dim}(resolved '${event}' → event '${resolvedEvent}' — use event names, not state names)${ANSI.reset}\n`
                    swLog(`recovery] fuzzy-matched target '${event}' → event '${resolvedEvent}'`)
                  } else if (byTarget.length > 1) {
                    // Ambiguous — multiple events lead to same target
                    const options = byTarget.map(t => t.event).join(", ")
                    result = `${ANSI.bgRed} ✗ '${event}' is a state name, not an event ${ANSI.eol}${ANSI.reset}\n${ANSI.dim}Multiple events reach '${event}': ${options}. Use the specific event name.${ANSI.reset}`
                    results.push(`${header}\n\n${result}`)
                    continue
                  } else {
                    // Try: partial event name → substring match
                    const bySubstring = stateCache.transitions.find(t =>
                      t.event.toLowerCase().includes(event.toLowerCase()) ||
                      event.toLowerCase().includes(t.event.toLowerCase())
                    )
                    if (bySubstring) {
                      resolvedEvent = bySubstring.event
                      fuzzyHint = `${ANSI.dim}(resolved '${event}' → '${resolvedEvent}')${ANSI.reset}\n`
                      swLog(`recovery] fuzzy-matched substring '${event}' → '${resolvedEvent}'`)
                    }
                  }
                }
              }

              swLog(`recovery] transition tool call: ${resolvedEvent} (rationale: ${rationale.slice(0, 200)})`)
              if (stateCache?.isFinal) {
                result = `${ANSI.dim}Workflow already complete (state: ${stateCache.state}). No further transitions possible.${ANSI.reset}`
              } else {
                const gwResult = await gwCall("statewright_transition", { event: resolvedEvent, data: { rationale } })
                if (gwResult) {
                  const r = gwResult as { from?: string; to?: string }
                  // Show rationale below transition only if it's not already visible as the formatted thought
                  const isDefaultRationale = rationale === "model-requested transition"
                  const isAlreadyDisplayed = isPluginOrchestrated()  // thought is shown above via message formatting
                  const shortRationale = (!isDefaultRationale && !isAlreadyDisplayed) ? `\n${ANSI.dim}${rationale.slice(0, 200)}${ANSI.reset}` : ""
                  result = `${fuzzyHint}${ANSI.bgGreen} ✓ ${r.from ?? "?"} → ${r.to ?? "?"} ${ANSI.eol}${ANSI.reset}${shortRationale}`
                } else {
                  const available = stateCache?.transitions.map(t => `${t.event} → ${t.target}`).join(", ") ?? "none"
                  result = `${ANSI.bgRed} ✗ '${event}' failed ${ANSI.eol}${ANSI.reset}\n${ANSI.dim}Available: ${available}${ANSI.reset}`
                }
              }
              await refreshState()
              checkStateAfterTransition()
              if (stateCache?.isFinal) break  // stop processing more tool calls
            } else {
              result = "Transition requires an 'event' argument, e.g. {\"name\": \"transition\", \"args\": {\"event\": \"PLAN_READY\"}}"
            }
          }
          // Shell-executable tools → pi.exec
          else if (name === "ls" || name === "find" || tc.name === "list_directory") {
            const path = (args.path ?? args.pattern ?? ".") as string
            const execResult = await pi.exec("ls", ["-la", path])
            result = execText(execResult)
          }
          else if (name === "read" || tc.name === "read_file") {
            const path = (args.path ?? args.file_path ?? args.filename) as string
            const execResult = await pi.exec("cat", [path])
            result = execText(execResult)
          }
          else if (name === "grep" || tc.name === "search_files") {
            const pattern = (args.pattern ?? args.query) as string
            const path = (args.path ?? args.file ?? ".") as string
            const execResult = await pi.exec("grep", ["-rn", pattern, path])
            result = execText(execResult)
          }
          else if (name === "bash" || tc.name === "run_command" || tc.name === "run_test") {
            const cmd = (args.command ?? args.cmd) as string
            // Apply the same bash discernment as the tool_call enforcement layer.
            // Recovery-executed commands must not bypass write/destructive restrictions.
            const isSafe = /^\s*(ls|cat|head|tail|wc|file|find|tree|pwd|echo|date|which|type|env|printenv|git\s+(status|log|diff|branch|show|remote)|grep|rg|fd|ag|pytest|cargo\s+test|npm\s+test|make\s+test)\b/.test(cmd)
            const isDangerous = /[>|]|&&\s*(rm|mv|cp)|;\s*(rm|mv|cp)|rm\s|rmdir|shred|truncate|mv\s|cp\s|mkdir|chmod|chown|curl|wget|sed\s+-i|dd\s|tee\s/.test(cmd)
            const hasWriteTools = stateCache.allowedTools.some(t => toolNamesMatch(t, "edit") || toolNamesMatch(t, "write"))
            const isScriptWrite = !hasWriteTools && /\b(python3?|node|ruby|perl|php)\b/.test(cmd)
            const leavesDir = /\.\.\/?|^\s*cd\s/.test(cmd)
            if (isDangerous || isScriptWrite || leavesDir || (!isSafe && !stateCache.allowedTools.some(t => toolNamesMatch(t, "bash")))) {
              result = `Bash command blocked by enforcement: "${cmd}". Only safe read-only commands are allowed in recovery mode.`
            } else {
              const execResult = await pi.exec("bash", ["-c", cmd])
              result = execText(execResult)
            }
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
                // pi.exec returns {stdout, stderr, code} — extract stdout
                let content: string
                if (typeof readResult === "string") {
                  content = readResult
                } else if (readResult && typeof readResult === "object" && "stdout" in (readResult as Record<string, unknown>)) {
                  content = (readResult as { stdout: string }).stdout
                } else {
                  content = JSON.stringify(readResult)
                }
                let applied = 0
                swLog(`edit] file content length: ${content.length}, type: ${typeof readResult}`)
                for (const edit of edits) {
                  swLog(`edit] searching for oldText (${edit.oldText.length} chars): "${edit.oldText.slice(0, 80)}..."`)
                  swLog(`edit] match: ${content.includes(edit.oldText)}`)
                  if (content.includes(edit.oldText)) {
                    content = content.replace(edit.oldText, edit.newText)
                    applied++
                  }
                }
                if (applied > 0) {
                  await pi.exec("bash", ["-c", `cat > ${JSON.stringify(editPath)} << 'STATEWRIGHT_EOF'\n${content}\nSTATEWRIGHT_EOF`])
                  // Format as colored diff
                  const diffLines: string[] = [`${ANSI.bgGreen} Applied ${applied}/${edits.length} edit(s) to ${editPath} ${ANSI.eol}${ANSI.reset}`]
                  for (const edit of edits) {
                    for (const line of edit.oldText.split("\n")) {
                      diffLines.push(`${ANSI.diffDel}- ${line}${ANSI.eol}${ANSI.reset}`)
                    }
                    for (const line of edit.newText.split("\n")) {
                      diffLines.push(`${ANSI.diffAdd}+ ${line}${ANSI.eol}${ANSI.reset}`)
                    }
                  }
                  result = diffLines.join("\n")
                } else {
                  result = `${ANSI.red}No matches found in ${editPath}. Re-read the file to get exact current content.${ANSI.reset}`
                }
              } catch (err) {
                result = `${ANSI.red}Edit failed: ${err instanceof Error ? err.message : String(err)}${ANSI.reset}`
              }
            } else {
              result = `Could not parse edit parameters. Use: edit(path="file.py", edits=[{oldText: "old", newText: "new"}])`
            }
          }
          else {
            result = `Tool '${tc.name}' not executable via recovery. Use native tool calling.`
          }

          const argSummary = Object.values(args).map(v => typeof v === "string" ? v : JSON.stringify(v)).join(" ")
          const header = `${ANSI.cyan}${ANSI.bold}$ ${tc.name}${argSummary ? " " + argSummary : ""}${ANSI.eol}${ANSI.reset}`
          results.push(`${header}\n\n${result}`)
        } catch (err) {
          results.push(`${ANSI.red}$ ${tc.name} — ERROR: ${err instanceof Error ? err.message : String(err)}${ANSI.reset}`)
        }
      }

      // Recovery executed tools — reset inactivity timer (model IS making progress)
      disarmInactivityTimer()
      armInactivityTimer()

      // Feed results back — unless workflow just completed
      if (!stateCache?.isFinal) {
        pi.sendUserMessage(
          results.join("\n\n") + "\n\nContinue with the next action.",
          { deliverAs: "steer" },
        )
      }

      // Plugin mode: reformat the raw JSON output for display after recovery processed it.
      // Replace the assistant message with a pretty version — thought + tool arrows.
      if (isPluginOrchestrated()) {
        const fullText = textParts.map((c: { text?: string }) => c.text ?? "").join("\n")
        try {
          const start = fullText.indexOf("{")
          const end = fullText.lastIndexOf("}")
          if (start >= 0 && end > start) {
            const j = JSON.parse(fullText.slice(start, end + 1))
            if (j.thought || j.tool_calls) {
              const lines: string[] = []
              if (j.thought) lines.push(`${ANSI.dim}${j.thought}${ANSI.reset}`)
              if (j.tool_calls && Array.isArray(j.tool_calls)) {
                for (const tc of j.tool_calls as Array<{ name?: string; args?: Record<string, unknown> }>) {
                  if (!tc.name) continue
                  const argStr = tc.args ? Object.values(tc.args).map((v: unknown) => typeof v === "string" ? v : JSON.stringify(v)).join(" ") : ""
                  lines.push(`${ANSI.cyan}${ANSI.bold}→ ${tc.name}${argStr ? " " + argStr : ""}${ANSI.reset}`)
                }
              }
              msg.content = [{ type: "text", text: lines.join("\n") }]
            }
          }
        } catch { /* leave original */ }
      }

      return
    }

    // Auto-continuation: nudge the model to keep working if it stalled.
    // Shares nudgeCount with the inactivity timer — both paths escalate toward
    // the same MAX_NUDGES auto-FAIL. Prevents infinite loops during upstream timeouts.
    if (!stateCache.isFinal && textParts.length > 0 && toolCallParts.length === 0) {
      const now = Date.now()
      if (now - lastNudgeTime < 30000) return

      nudgeCount++
      swLog(`auto-continuation] message_end nudge (${nudgeCount}/${MAX_NUDGES})`)

      if (nudgeCount > MAX_NUDGES) {
        swLog(`auto-continuation] max nudges exceeded — auto-transitioning FAIL`)
        const failEvent = stateCache.transitions.find(t => t.event === "FAIL")?.event ?? "FAIL"
        gwCall("statewright_transition", {
          event: failEvent,
          data: { rationale: `Agent stuck: ${nudgeCount} consecutive turns without a successful tool call` },
        }).then(async () => {
          await refreshState()
          if (stateCache) {
            swLog(`auto-FAIL] transitioned to ${stateCache.state} (isFinal=${stateCache.isFinal})`)
          }
        }).catch((err) => {
          swLog(`auto-FAIL] FAIL transition failed: ${err instanceof Error ? err.message : String(err)}`)
          // Force local state to final to break the loop even if gateway is unreachable
          if (stateCache) stateCache.isFinal = true
        })
        disarmInactivityTimer()
        return
      }

      const available = stateCache.allowedTools.map(normalizeToolName).join(", ")
      const transitions = stateCache.transitions.map(t => `${t.event} -> ${t.target}`).join(", ")
      const instructions = stateCache.instructions ?? "Proceed with the task."

      let msg: string
      if (nudgeCount <= 2) {
        msg = `State: ${stateCache.state}. Instructions: ${instructions}. Tools: ${available}. Transitions: ${transitions}. Respond with JSON tool_calls now.`
      } else {
        msg = `FINAL WARNING (${nudgeCount}/${MAX_NUDGES}). State: ${stateCache.state}. Tools: ${available}. Transitions: ${transitions}. Call a tool or use statewright_transition to advance. If stuck: statewright_transition(event="FAIL", data={"rationale": "why"})`
      }
      deliverCorrective(msg)
    }
  })

}
