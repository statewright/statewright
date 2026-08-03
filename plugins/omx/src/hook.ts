/**
 * Statewright hook for Oh My Codex (OMX)
 *
 * One-shot Codex native hook command. Registered in .codex/hooks.json.
 * Input: JSON on stdin. Output: Codex hook JSON on stdout.
 * State cache: file-based in ~/.statewright/sessions/<key>/
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { minimatch } from "minimatch"

// --- Types ---

export interface StateCache {
  state: string
  isFinal: boolean
  iteration: number
  maxIterations: number | null
  allowedTools: string[]
  instructions: string | null
  transitions: Array<{ event: string; target: string }>
  context: Record<string, unknown>
  interrupts: Record<string, { file_pattern: string; target: string }>
  allowedCommands: string[]
  blockedEnv: string[]
  model?: string | null
  defaultModel?: string | null
  thinkingLevel?: string | null
  deliveryRequired?: boolean
  interruptReturn?: string
  fork?: {
    active: boolean
    currentBranch: string
    branches: Record<string, unknown>
  }
}

export interface HookInput {
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: string
  tool_result?: unknown
  is_error?: boolean
  prompt?: string
  session_id?: string
}

export interface HookOutput {
  decision?: string
  reason?: string
  hookSpecificOutput?: {
    hookEventName?: string
    additionalContext?: string
    permissionDecision?: string
    permissionDecisionReason?: string
  }
}

export interface HandlerOpts {
  apiKey: string | null
  gwUrl: string
  sessionDir: string
  adapterUrl?: string
  adapterToken?: string
}

interface AdapterState extends StateCache {
  executor?: { active?: boolean; id?: string; delivery?: boolean }
  additionalContext?: string
}

interface AdapterDecision {
  decision?: "allow" | "deny" | "block"
  reason?: string
  additional_context?: string | null
  state?: string
  completed?: boolean
  interrupt?: { to?: string } | null
}

interface GatewayState {
  state: string
  is_final?: boolean
  iteration?: number
  max_iterations?: number | null
  allowed_tools?: string[]
  instructions?: string | null
  transitions?: Array<{ event: string; target: string }>
  context?: Record<string, unknown>
  interrupts?: Record<string, { file_pattern: string; target: string }>
  allowed_commands?: string[]
  blocked_env?: string[]
  model?: string | null
  default_model?: string | null
  thinking_level?: string | null
  run_id?: string
  capture_output?: boolean
  pending_approval?: { approval_id: string; message?: string | null }
  meta?: {
    approval_mode?: string
    workspace?: { required?: boolean }
    preview?: { required?: boolean }
    promotion?: { required?: boolean }
  }
  fork?: {
    active: boolean
    current_branch: string
    branches: Record<string, unknown>
  }
}

// --- System tools that bypass enforcement ---

const SYSTEM_TOOLS = new Set([
  "TodoRead",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskStop",
  "TaskOutput",
  "Agent",
  "SendMessage",
  "AskUserQuestion",
  "ExitPlanMode",
  "ToolSearch",
  "Skill",
])

// --- Pure logic (exported for testing) ---

export function checkToolAllowed(
  toolName: string,
  cache: StateCache,
  toolInput: Record<string, unknown> = {},
): { allowed: boolean; reason?: string } {
  if (toolName.startsWith("statewright_")) return { allowed: true }
  if (toolName.includes("statewright_")) return { allowed: true }
  if (SYSTEM_TOOLS.has(toolName)) return { allowed: true }
  if (cache.allowedTools.length === 0) return { allowed: true }
  if (cache.allowedTools.includes(toolName)) return { allowed: true }

  // Codex exposes different concrete tool names than Claude Code. Treat the
  // workflow allowlist as capabilities, while keeping the concrete operation
  // no more permissive than the declared capability.
  if (
    toolName === "apply_patch" &&
    (cache.allowedTools.includes("Edit") || cache.allowedTools.includes("Write"))
  ) {
    return { allowed: true }
  }
  if (toolName === "view_image" && cache.allowedTools.includes("Read")) {
    return { allowed: true }
  }
  if (
    isCodexShellTool(toolName) &&
    typeof toolInput.command === "string" &&
    cache.allowedTools.some((tool) => ["Read", "Grep", "Glob", "LS"].includes(tool)) &&
    classifyReadOnlyShellCommand(toolInput.command).allowed
  ) {
    return { allowed: true }
  }
  if (isCodexWebRun(toolName)) {
    const required = codexWebCapabilities(toolInput)
    if (
      required.length > 0 &&
      required.every((capability) => cache.allowedTools.includes(capability))
    ) {
      return { allowed: true }
    }
  }

  const transitions = cache.transitions.map((t) => t.event).join(", ")
  return {
    allowed: false,
    reason: `Tool '${toolName}' is not available in the '${cache.state}' phase. Allowed: ${cache.allowedTools.join(", ")}.${transitions ? ` To advance, use statewright_transition with: ${transitions}.` : ""}`,
  }
}

function isCodexShellTool(toolName: string): boolean {
  // The native CLI has used both names across hook integrations. Treat these
  // as one capability, never as an unrestricted fallback.
  return toolName === "Bash" || toolName === "exec_command"
}

function isCodexWebRun(toolName: string): boolean {
  return toolName.toLowerCase().replace(/[^a-z]/g, "").endsWith("webrun")
}

function codexWebCapabilities(toolInput: Record<string, unknown>): string[] {
  const keys = new Set(Object.keys(toolInput))
  const required = new Set<string>()
  if (keys.has("search_query") || keys.has("image_query")) {
    required.add("WebSearch")
  }
  if (
    ["open", "click", "find", "screenshot", "finance", "weather", "sports", "time"].some(
      (key) => keys.has(key),
    )
  ) {
    required.add("WebFetch")
  }
  return [...required]
}

export function classifyReadOnlyShellCommand(
  command: string,
): { allowed: boolean; reason?: string } {
  // Read-only Codex shell access is intentionally conservative. Ignore only
  // redirects that discard output, then reject remaining shell write/escape
  // primitives before checking every pipeline/control-flow segment.
  const normalized = command
    .replace(/(?:^|\s)[012]?>\s*\/dev\/null\b/g, " ")
    .replace(/(?:^|\s)2>&1\b/g, " ")
    .trim()

  if (!normalized || /[\r\n<>`]|\$\(/.test(normalized)) {
    return { allowed: false, reason: "Command is not a read-only shell operation." }
  }

  const segments = normalized.split(/\s*(?:&&|\|\||;|\|)\s*/)
  if (segments.some((segment) => !isReadOnlyShellSegment(segment))) {
    return { allowed: false, reason: "Command is not a read-only shell operation." }
  }
  return { allowed: true }
}

function isReadOnlyShellSegment(segment: string): boolean {
  const trimmed = segment.trim()
  if (!trimmed || /^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) return false

  const commandMatch = trimmed.match(/^((?:\/[^\s]+\/)?[^\s]+)/)
  if (!commandMatch) return false
  const executable = commandMatch[1].split("/").pop() ?? ""
  const args = trimmed.slice(commandMatch[1].length).trim()

  if (
    [
      "cat",
      "head",
      "tail",
      "grep",
      "fd",
      "ls",
      "pwd",
      "stat",
      "file",
      "wc",
      "cut",
      "tr",
      "jq",
      "du",
      "dirname",
      "basename",
      "realpath",
      "true",
      "false",
    ].includes(executable)
  ) {
    return true
  }
  if (executable === "sort") {
    return !/(?:^|\s)(?:-o|--output)(?:\s|=)/.test(args)
  }
  if (executable === "uniq") return true
  if (executable === "rg") {
    return !/(?:^|\s)--pre(?:-glob)?(?:\s|=)/.test(args)
  }
  if (executable === "sed") {
    return /^-n\s+(['"]?)[0-9$]+(?:,[0-9$]+)?p\1(?:\s|$)/.test(args)
  }
  if (executable === "find") {
    return !/(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprint0)(?:\s|$)/.test(args)
  }
  if (executable === "test" || executable === "[") return true
  if (executable === "which") return true
  if (executable === "command") return /^-v(?:\s|$)/.test(args)
  if (executable === "git") {
    const subcommand = args.match(/^(status|diff|log|show|rev-parse|ls-files|grep|describe)(?:\s|$)/)
    if (subcommand) return true
    return /^branch(?:\s+(?:--show-current|--list))?\s*$/.test(args)
  }
  return false
}

export function classifyBashCommand(
  command: string,
  cache: StateCache,
): { allowed: boolean; reason?: string } {
  const hasWrite = cache.allowedTools.includes("Write")
  const hasEdit = cache.allowedTools.includes("Edit")

  // Destructive operations — always blocked
  if (/^\s*(rm|rmdir|shred|truncate|unlink)\s/.test(command)) {
    return {
      allowed: false,
      reason: `Destructive operation not permitted in this phase.`,
    }
  }
  if (/(&&|;)\s*(rm|rmdir|shred|truncate|unlink)\s/.test(command)) {
    return {
      allowed: false,
      reason: `Destructive operation not permitted in this phase.`,
    }
  }

  // File write via redirects when Write/Edit not allowed
  if (!hasWrite && !hasEdit) {
    if (/([^0-9])?>([^>&])|>>\s*\S/.test(command)) {
      return {
        allowed: false,
        reason: `Bash command blocked: output redirect detected but Write/Edit not in allowed tools for '${cache.state}' phase.`,
      }
    }
    if (/sed\s+-i|perl\s+-p?i/.test(command)) {
      return {
        allowed: false,
        reason: `Bash command blocked: in-place file modification detected but Edit not in allowed tools for '${cache.state}' phase.`,
      }
    }
    if (/^\s*(python|python3|ruby|node|perl|php)\s/.test(command)) {
      return {
        allowed: false,
        reason: `Bash command blocked: scripting interpreter not permitted without Write/Edit in '${cache.state}' phase.`,
      }
    }
  }

  // Allowed commands enforcement
  if (cache.allowedCommands.length > 0) {
    const ok = cache.allowedCommands.some(
      (prefix) => command === prefix || command.startsWith(prefix + " "),
    )
    if (!ok) {
      return {
        allowed: false,
        reason: `Bash command blocked: not in allowed commands for '${cache.state}' phase.`,
      }
    }
  }

  // Blocked env vars
  if (cache.blockedEnv.length > 0) {
    for (const bvar of cache.blockedEnv) {
      const pattern = new RegExp(
        `\\$${bvar}|\\$\\{${bvar}\\}|^${bvar}=| ${bvar}=`,
      )
      if (pattern.test(command)) {
        return {
          allowed: false,
          reason: `Bash command blocked: references restricted env var in this phase.`,
        }
      }
    }
  }

  return { allowed: true }
}

export function formatStateContext(cache: StateCache): string {
  const transitions = cache.transitions
    .map((t) => `${t.event} -> ${t.target}`)
    .join(", ")
  const lines = [
    `Statewright workflow active. AUTONOMOUS MODE: work continuously through each state -- use tools, complete the work, transition, and keep going. Do NOT stop or ask the user between states. Only pause at approval gates or final states.`,
    `Phase: ${cache.state} (iteration ${cache.iteration}/${cache.maxIterations ?? "none"}).`,
    `Tools: ${cache.allowedTools.join(", ")}.`,
    `Transitions: ${transitions}.`,
    `MANDATORY: Every statewright_transition call MUST include data.rationale.`,
  ]
  if (cache.instructions) lines.push(`Instructions: ${cache.instructions}`)
  if (cache.model) {
    lines.push(
      `Recommended route: model ${cache.model}, effort ${cache.thinkingLevel ?? "default"}. `
      + "OMX hooks cannot switch the active Codex model; start the session with this route when possible.",
    )
  }
  if (cache.interruptReturn)
    lines.push(`IN INTERRUPT HANDLER. Return to: ${cache.interruptReturn}`)
  if (cache.fork?.active)
    lines.push(`FORK active. Branch: ${cache.fork.currentBranch}`)
  return lines.join(" ")
}

export function checkInterrupts(
  filePath: string,
  interrupts: Record<string, { file_pattern: string; target: string }>,
  interruptReturn?: string,
): string | null {
  if (!filePath || Object.keys(interrupts).length === 0) return null
  if (interruptReturn) return null

  for (const [name, def] of Object.entries(interrupts)) {
    if (
      minimatch(filePath, def.file_pattern, { matchBase: true }) ||
      minimatch(filePath, `**/${def.file_pattern}`, { dot: true })
    ) {
      return name
    }
  }
  return null
}

// --- Gateway client ---

async function gwCall(
  gwUrl: string,
  apiKey: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<GatewayState | null> {
  try {
    const resp = await fetch(`${gwUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(process.env.STATEWRIGHT_MCP_SESSION_ID
          ? { "Mcp-Session-Id": process.env.STATEWRIGHT_MCP_SESSION_ID }
          : {}),
        ...(process.env.STATEWRIGHT_CLIENT_ID
          ? { "X-Statewright-Client-Id": process.env.STATEWRIGHT_CLIENT_ID }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as {
      result?: { content?: Array<{ type: string; text: string }> }
    }
    const text = data.result?.content?.[0]?.text
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

async function adapterCall<T>(
  opts: HandlerOpts,
  endpoint: "state" | "pre-tool" | "post-tool" | "stop",
  body?: Record<string, unknown>,
): Promise<T> {
  if (!opts.adapterUrl) throw new Error("Statewright executor bridge is not configured")
  const response = await fetch(`${opts.adapterUrl.replace(/\/$/, "")}/hooks/${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(opts.adapterToken ? { Authorization: `Bearer ${opts.adapterToken}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) {
    throw new Error(`Statewright executor bridge ${endpoint} failed with HTTP ${response.status}`)
  }
  return await response.json() as T
}

function formatAdapterState(state: AdapterState): string {
  if (state.additionalContext) return state.additionalContext
  return formatStateContext(state)
}

function executorOwnsDelivery(state: AdapterState): boolean {
  return Boolean(state.executor?.active && state.executor.delivery)
}

function parseGatewayState(raw: GatewayState): StateCache {
  return {
    state: raw.state,
    isFinal: raw.is_final ?? false,
    iteration: raw.iteration ?? 0,
    maxIterations: raw.max_iterations ?? null,
    allowedTools: raw.allowed_tools ?? [],
    instructions: raw.instructions ?? null,
    transitions: raw.transitions ?? [],
    context: raw.context ?? {},
    interrupts: raw.interrupts ?? {},
    allowedCommands: raw.allowed_commands ?? [],
    blockedEnv: raw.blocked_env ?? [],
    model: raw.model ?? null,
    defaultModel: raw.default_model ?? null,
    thinkingLevel: raw.thinking_level ?? null,
    deliveryRequired: Boolean(
      raw.meta?.workspace?.required
      || raw.meta?.preview?.required
      || raw.meta?.promotion?.required,
    ),
    interruptReturn: (raw.context?._interrupt_return as string) ?? undefined,
    fork: raw.fork
      ? {
          active: raw.fork.active,
          currentBranch: raw.fork.current_branch,
          branches: raw.fork.branches,
        }
      : undefined,
  }
}

// --- File helpers ---

function readCache(sessionDir: string): GatewayState | null {
  const cacheFile = join(sessionDir, ".state_cache")
  if (!existsSync(cacheFile)) return null
  try {
    return JSON.parse(readFileSync(cacheFile, "utf8"))
  } catch {
    return null
  }
}

function writeCache(sessionDir: string, state: GatewayState): void {
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, ".state_cache"), JSON.stringify(state))
}

function isActive(sessionDir: string): boolean {
  return existsSync(join(sessionDir, ".active"))
}

function activate(sessionDir: string): void {
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(
    join(sessionDir, ".active"),
    JSON.stringify({ activated: new Date().toISOString() }),
  )
}

function deactivate(sessionDir: string): void {
  const files = [
    ".active",
    ".state_cache",
    ".session_hinted",
    ".discovered_commands",
    ".capture_enabled",
    ".run_id",
    ".log_seq",
  ]
  for (const f of files) {
    try {
      unlinkSync(join(sessionDir, f))
    } catch {
      // ignore missing
    }
  }
}

// --- Hook handlers (exported for testing) ---

export async function handleUserPrompt(
  input: HookInput,
  opts: HandlerOpts,
): Promise<HookOutput | null> {
  if (opts.adapterUrl) {
    try {
      const state = await adapterCall<AdapterState>(opts, "state")
      if (state.deliveryRequired && !executorOwnsDelivery(state)) {
        return {
          decision: "block",
          reason: "This workflow requires isolated delivery, but the Statewright executor does not own an active delivery session.",
        }
      }
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: formatAdapterState(state),
        },
      }
    } catch (error) {
      return {
        decision: "block",
        reason: `Statewright executor bridge unavailable: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  // Key-paste detection (even without current key)
  if (!opts.apiKey) {
    const prompt = input.prompt ?? ""
    const match = prompt.match(/sw_live_[a-zA-Z0-9_-]+/)
    if (match) {
      const keyDir = join(homedir(), ".statewright")
      mkdirSync(keyDir, { recursive: true })
      writeFileSync(join(keyDir, "api_key"), match[0], { mode: 0o600 })
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext:
            "Statewright API key saved automatically. The user can now activate a workflow with: statewright_start(workflow='bugfix') or statewright_list_workflows() to see available workflows.",
        },
      }
    }

    return {
      decision: "block",
      reason:
        "Statewright plugin needs an API key. Visit https://statewright.ai/keys to sign up and generate one, then paste it here.",
    }
  }

  // Dormant: no active workflow
  if (!isActive(opts.sessionDir)) {
    const hintFile = join(opts.sessionDir, ".session_hinted")
    if (existsSync(hintFile)) return null

    mkdirSync(opts.sessionDir, { recursive: true })
    writeFileSync(hintFile, "")
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          "Statewright plugin active. No workflow running. To start one, use statewright_start(workflow='bugfix') or statewright_list_workflows() to see available workflows.",
      },
    }
  }

  // Active workflow: fetch state from gateway
  const raw = await gwCall(opts.gwUrl, opts.apiKey, "statewright_get_state")
  if (!raw?.state) {
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          "Statewright gateway unreachable. Running without workflow enforcement this turn.",
      },
    }
  }

  // Final state: auto-deactivate
  if (raw.is_final) {
    deactivate(opts.sessionDir)
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `[statewright] Workflow complete. Final state: ${raw.state}. Enforcement deactivated.`,
      },
    }
  }

  // Write cache for PreToolUse
  writeCache(opts.sessionDir, raw)

  const cache = parseGatewayState(raw)
  if (cache.deliveryRequired && process.env.STATEWRIGHT_DELIVERY_ACTIVE !== "1") {
    return {
      decision: "block",
      reason: "This workflow requires isolated delivery. Launch it through the Statewright executor so it owns the delivery lifecycle.",
    }
  }
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: formatStateContext(cache),
    },
  }
}

export async function handlePreTool(
  input: HookInput,
  opts: HandlerOpts,
): Promise<HookOutput | null> {
  if (opts.adapterUrl) {
    try {
      const decision = await adapterCall<AdapterDecision>(opts, "pre-tool", {
        tool_name: input.tool_name ?? "",
        tool_input: input.tool_input ?? {},
      })
      if (decision.decision === "deny" || decision.decision === "block") {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: decision.reason ?? "Blocked by Statewright",
          },
        }
      }
      if (decision.additional_context) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: decision.additional_context,
          },
        }
      }
      return null
    } catch (error) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Statewright executor bridge unavailable: ${error instanceof Error ? error.message : String(error)}`,
        },
      }
    }
  }

  if (!isActive(opts.sessionDir)) return null

  const toolName = input.tool_name ?? ""

  // System/statewright tools always pass
  if (toolName.includes("statewright_")) return null
  if (SYSTEM_TOOLS.has(toolName)) return null

  // Read cached state
  const raw = readCache(opts.sessionDir)
  if (!raw) return null

  const cache = parseGatewayState(raw)
  if (cache.deliveryRequired && process.env.STATEWRIGHT_DELIVERY_ACTIVE !== "1") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "This workflow requires isolated delivery. Launch it through the Statewright executor so it owns the delivery lifecycle.",
      },
    }
  }
  if (cache.allowedTools.length === 0) return null

  // Tool allowlist check
  const result = checkToolAllowed(toolName, cache, input.tool_input ?? {})
  if (!result.allowed) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: result.reason,
      },
    }
  }

  // Bash command classification (runs even when Bash is in allowedTools)
  if (isCodexShellTool(toolName) && input.tool_input?.command) {
    const bashResult = classifyBashCommand(
      input.tool_input.command as string,
      cache,
    )
    if (!bashResult.allowed) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: bashResult.reason,
        },
      }
    }
  }

  return null
}

export async function handlePostTool(
  input: HookInput,
  opts: HandlerOpts,
): Promise<HookOutput | null> {
  const toolName = input.tool_name ?? ""

  if (opts.adapterUrl) {
    try {
      if (toolName.includes("statewright_")) {
        const state = await adapterCall<AdapterState>(opts, "state")
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: formatAdapterState(state),
          },
        }
      }
      const response = await adapterCall<AdapterDecision>(opts, "post-tool", {
        tool_name: toolName,
        tool_input: input.tool_input ?? {},
        tool_response: typeof input.tool_response === "string"
          ? input.tool_response
          : JSON.stringify(input.tool_result ?? ""),
        is_error: Boolean(input.is_error),
      })
      if (response.interrupt?.to) {
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: `[statewright] Validation interrupt entered: ${response.interrupt.to}. Continue under the new Statewright phase.`,
          },
        }
      }
      if (response.completed) {
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: "[statewright] Workflow complete.",
          },
        }
      }
      if (response.additional_context) {
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: response.additional_context,
          },
        }
      }
      return null
    } catch (error) {
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `Statewright executor bridge error: ${error instanceof Error ? error.message : String(error)}. Stop before issuing another tool call.`,
        },
      }
    }
  }

  // --- Log capture: submit tool call to PocketBase workflow_logs ---
  try {
    if (
      isActive(opts.sessionDir) &&
      !toolName.includes("statewright_") &&
      opts.apiKey
    ) {
      const rawCache = readCache(opts.sessionDir)
      const runIdFile = join(opts.sessionDir, ".run_id")
      const seqFile = join(opts.sessionDir, ".log_seq")
      const runId = existsSync(runIdFile) ? readFileSync(runIdFile, "utf8").trim() : ""
      if (runId && rawCache) {
        const seq = existsSync(seqFile) ? parseInt(readFileSync(seqFile, "utf8").trim(), 10) + 1 : 1
        writeFileSync(seqFile, String(seq))
        const phase = rawCache.state ?? "unknown"
        const toolOutput = typeof input.tool_result === "string"
          ? input.tool_result.slice(0, 102400)
          : JSON.stringify(input.tool_result ?? "").slice(0, 102400)
        const pbUrl = process.env.STATEWRIGHT_PB_URL ?? "https://statewright.ai"
        // Fire and forget — don't block the hook response
        fetch(`${pbUrl}/api/collections/workflow_logs/records`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({
            phase,
            tool_name: toolName,
            tool_input: input.tool_input ?? {},
            tool_output: toolOutput,
            sequence: seq,
            duration_ms: 0,
            run_id: runId,
          }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {})
      }
    }
  } catch { /* log capture is best-effort */ }

  // Classify statewright tool action
  let swAction = ""
  if (/statewright_start|statewright_load_workflow/.test(toolName))
    swAction = "start"
  else if (
    /statewright_stop|statewright_deactivate|statewright_pause/.test(toolName)
  )
    swAction = "stop"
  else if (/statewright_transition|statewright_force_state/.test(toolName))
    swAction = "transition"
  else if (/statewright_get_state/.test(toolName)) swAction = "refresh_cache"

  // Interrupt detection for file-changing tools (when active, no sw action)
  if (!swAction && isActive(opts.sessionDir)) {
    const rawCache = readCache(opts.sessionDir)
    if (rawCache) {
      const cache = parseGatewayState(rawCache)
      const isFileEdit = [
        "Edit",
        "Write",
        "MultiEdit",
        "apply_patch",
        "edit_file",
        "write_file",
        "create_or_update_file",
      ].includes(toolName)

      if (isFileEdit) {
        const filePath =
          (input.tool_input?.file_path as string) ??
          (input.tool_input?.path as string) ??
          (input.tool_input?.file as string) ??
          ""

        if (filePath && Object.keys(cache.interrupts).length > 0) {
          const matched = checkInterrupts(
            filePath,
            cache.interrupts,
            cache.interruptReturn,
          )
          if (matched) {
            const target = cache.interrupts[matched].target
            return {
              hookSpecificOutput: {
                hookEventName: "PostToolUse",
                additionalContext: `[statewright] INTERRUPT: file '${filePath}' matched interrupt '${matched}'. You MUST immediately call statewright_transition(event='INTERRUPT:${matched}', data={'rationale': 'File edit triggered interrupt', 'trigger_file': '${filePath}'}) before doing anything else. This will transition to '${target}' for validation.`,
              },
            }
          }
        }
      }
    }
    return null
  }

  switch (swAction) {
    case "start": {
      activate(opts.sessionDir)

      // Fetch and cache initial state
      if (opts.apiKey) {
        const raw = await gwCall(
          opts.gwUrl,
          opts.apiKey,
          "statewright_get_state",
        )
        if (raw) {
          writeCache(opts.sessionDir, raw)
          const cache = parseGatewayState(raw)
          return {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: `[statewright] Workflow loaded. Phase: ${cache.state}. Tools: ${cache.allowedTools.join(", ")}. Transitions: ${cache.transitions.map((t) => `${t.event} -> ${t.target}`).join(", ")}. KEEP WORKING -- begin the ${cache.state} phase immediately. Do not stop or summarize.${cache.instructions ? ` Instructions: ${cache.instructions}` : ""}`,
            },
          }
        }
      }
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "[statewright] Workflow loaded.",
        },
      }
    }

    case "stop": {
      deactivate(opts.sessionDir)
      return null
    }

    case "transition": {
      // Read previous state
      const prevRaw = readCache(opts.sessionDir)
      const prevState = prevRaw?.state ?? ""

      // Parse tool result for fork/join info
      let parsedResult: Record<string, unknown> = {}
      if (input.tool_response) {
        try {
          const arr = JSON.parse(input.tool_response)
          if (Array.isArray(arr) && arr[0]?.text) {
            parsedResult = JSON.parse(arr[0].text)
          } else if (typeof arr === "object") {
            parsedResult = arr
          }
        } catch {
          // ignore parse errors
        }
      }

      const isForked = parsedResult.forked === true
      const isJoined = parsedResult.joined === true
      const branchDone = parsedResult.branch_completed as string | undefined

      // Refresh cache
      if (!opts.apiKey) return null
      const raw = await gwCall(
        opts.gwUrl,
        opts.apiKey,
        "statewright_get_state",
      )
      if (!raw) return null

      writeCache(opts.sessionDir, raw)
      const cache = parseGatewayState(raw)
      if (raw.pending_approval) {
        const message = raw.pending_approval.message ?? "Human review required."
        const external = raw.meta?.approval_mode === "external"
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: external
              ? "[statewright] Approval is pending on the configured external review channel. Do not continue this workflow until that reviewer resolves it."
              : `[statewright] REVIEW REQUIRED: ${message} Present this approval request to the user in the current UI. Do not continue the workflow until the user approves or rejects it.`,
          },
        }
      }

      if (isForked) {
        const branches = parsedResult.branches as Record<string, unknown>
        const branchNames = Object.keys(branches ?? {})
        const count = branchNames.length
        const current = parsedResult.current_branch as string
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: `[statewright] FORK: ${count} branches [${branchNames.join(", ")}]. For parallel: spawn ${count} fork-branch-worker agents (one per branch), then WAIT for all ${count} task-notification events before proceeding. For sequential: work branch '${current}' first.${cache.instructions ? ` Instructions: ${cache.instructions}` : ""}`,
          },
        }
      }

      if (isJoined) {
        const joinTo = parsedResult.to as string
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: `[statewright] FORK JOIN complete. All branches done. Now in ${joinTo}. Tools: ${cache.allowedTools.join(", ")}. Transitions: ${cache.transitions.map((t) => `${t.event} -> ${t.target}`).join(", ")}.`,
          },
        }
      }

      if (branchDone) {
        const nextBranch = parsedResult.next_branch as string
        const remaining = parsedResult.remaining as number
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: `[statewright] Branch '${branchDone}' done. ${remaining} remaining. Now working branch '${nextBranch}' (state: ${cache.state}). Tools: ${cache.allowedTools.join(", ")}.${cache.instructions ? ` Instructions: ${cache.instructions}` : ""}`,
          },
        }
      }

      if (cache.isFinal) {
        deactivate(opts.sessionDir)
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: `[statewright] ${prevState} => ${cache.state} (workflow complete, enforcement deactivated)`,
          },
        }
      }

      const transStr = cache.transitions
        .map((t) => `${t.event} -> ${t.target}`)
        .join(", ")
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `[statewright] ${prevState ? `${prevState} => ` : ""}${cache.state}. Tools: ${cache.allowedTools.join(", ")}. Next transitions: ${transStr}. KEEP WORKING -- do not stop or wait for user input.`,
        },
      }
    }

    case "refresh_cache": {
      if (isActive(opts.sessionDir) && opts.apiKey) {
        const raw = await gwCall(
          opts.gwUrl,
          opts.apiKey,
          "statewright_get_state",
        )
        if (raw) writeCache(opts.sessionDir, raw)
      }
      return null
    }

    default:
      return null
  }
}

export async function handleStop(
  _input: HookInput,
  opts: HandlerOpts,
): Promise<HookOutput | null> {
  if (opts.adapterUrl) {
    try {
      const response = await adapterCall<AdapterDecision>(opts, "stop", {})
      if (response.decision === "block" || response.decision === "deny") {
        return {
          decision: "block",
          reason: response.reason ?? "Continue the active Statewright workflow.",
        }
      }
      return null
    } catch (error) {
      return {
        decision: "block",
        reason: `Statewright executor bridge unavailable: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  // Approval gates are delivered by PostToolUse so Codex can present its own
  // review UI. Never suppress that UI from Stop.
  return null

  // A Stop hook fires when Codex is about to yield a final response.  Unlike
  // UserPromptSubmit, it can keep an autonomous workflow alive without a
  // human having to send another prompt.
  if (!isActive(opts.sessionDir)) return null

  // Stop hooks have a short deadline.  The post-transition handler refreshes
  // this cache, so it is the fast-path authority here.  Only consult the
  // gateway when a cache has not been established yet.
  let raw = readCache(opts.sessionDir)
  if (!raw && opts.apiKey) {
    raw = await gwCall(opts.gwUrl, opts.apiKey, "statewright_get_state")
    if (raw) writeCache(opts.sessionDir, raw)
  }

  // No state source means there is nothing reliable to enforce.  Do not trap
  // the agent in an unresolvable stop loop.
  if (!raw?.state) return null

  const cache = parseGatewayState(raw)
  if (cache.isFinal) {
    deactivate(opts.sessionDir)
    return {
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: `[statewright] Workflow complete. Final state: ${cache.state}. Enforcement deactivated.`,
      },
    }
  }

  const continuation = `${formatStateContext(cache)} CONTINUATION REQUIRED: Codex attempted to stop while Statewright is still active in '${cache.state}'. Do not send a final response or wait for a new user prompt. Continue immediately with only the state-allowed tools, complete this phase, and call statewright_transition when its exit criteria are met.`
  return {
    decision: "block",
    reason: `Statewright workflow is active in '${cache.state}'; continue until a final state.`,
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: continuation,
    },
  }
}

// --- CLI entry point ---

async function main(): Promise<void> {
  const endpoint = process.argv[2] ?? "user-prompt"

  // Read stdin
  let inputStr = ""
  for await (const chunk of process.stdin) {
    inputStr += chunk.toString()
  }
  const input: HookInput = inputStr ? JSON.parse(inputStr) : {}

  // Resolve config
  const swDir = join(homedir(), ".statewright")
  let apiKey = process.env.STATEWRIGHT_API_KEY ?? null
  if (!apiKey) {
    try {
      apiKey = readFileSync(join(swDir, "api_key"), "utf8").trim()
    } catch {
      apiKey = null
    }
  }

  const gwUrl =
    process.env.STATEWRIGHT_GATEWAY_URL ?? "https://mcp.statewright.ai"
  const sessionKey = (
    input.session_id ??
    process.env.CODEX_SESSION_ID ??
    "default"
  ).slice(0, 12)
  const sessionDir = join(swDir, "sessions", sessionKey)

  const opts: HandlerOpts = {
    apiKey,
    gwUrl,
    sessionDir,
    adapterUrl: process.env.STATEWRIGHT_ADAPTER_URL,
    adapterToken: process.env.STATEWRIGHT_ADAPTER_TOKEN,
  }

  let result: HookOutput | null = null
  switch (endpoint) {
    case "user-prompt":
      result = await handleUserPrompt(input, opts)
      break
    case "pre-tool":
      result = await handlePreTool(input, opts)
      break
    case "post-tool":
      result = await handlePostTool(input, opts)
      break
    case "stop":
      result = await handleStop(input, opts)
      break
  }

  if (result) {
    process.stdout.write(JSON.stringify(result) + "\n")
  }
}

// Run when invoked directly
const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("/hook.js") ||
    process.argv[1].endsWith("/hook.ts"))

if (isMainModule) {
  main().catch((err) => {
    console.error("[statewright] hook error:", err)
    process.exit(0) // Don't block agent on hook errors
  })
}
