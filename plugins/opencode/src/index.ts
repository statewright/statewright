/**
 * Statewright plugin for opencode
 *
 * Enforces state machine guardrails via the statewright MCP gateway's
 * hook HTTP server. Install by placing in .opencode/plugins/ or
 * registering in opencode.json.
 *
 * The gateway must be running (either as an MCP server via opencode's
 * mcp config, or in --hook-only mode).
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync } from "fs"

interface HookResponse {
  decision?: string
  additionalContext?: string
  statusMessage?: string
  transition?: string
  completed?: boolean
}

export interface StateResponse {
  state: string
  isFinal: boolean
  iteration: number
  maxIterations: number | null
  allowedTools: string[]
  allowedCommands: string[]
  instructions: string | null
  additionalContext: string
}

// --- Pure logic (exported for testing) ---

/**
 * Classify a bash command against the current state, mirroring the
 * claude-code hook and OMX classifier: destructive operations are always
 * blocked; write-via-redirect and interpreters are blocked when Write/Edit
 * aren't allowed; when the state defines allowed_commands, the command must
 * prefix-match one. The destructive check runs on the trimmed command and
 * treats newline as a separator (both dodge naive `^`-anchored patterns).
 */
export function classifyBashCommand(
  command: string,
  state: StateResponse,
): { allowed: boolean; reason?: string } {
  const tools = state.allowedTools ?? []
  // opencode tool ids are lowercase; accept both spellings
  const hasWrite = tools.includes("write") || tools.includes("Write")
  const hasEdit = tools.includes("edit") || tools.includes("Edit")

  // Destructive operations — always blocked, including chained (;, &&, |,
  // newline) and subshell ($(), backtick) forms
  if (
    /(^|[;&|(\n]\s*|\$\(\s*|`\s*)(rm|rmdir|shred|truncate|unlink)\s/.test(
      command.trim(),
    )
  ) {
    return {
      allowed: false,
      reason: "Destructive operation not permitted in this phase.",
    }
  }

  // File write via redirects when Write/Edit not allowed
  if (!hasWrite && !hasEdit) {
    if (/([^0-9])?>([^>&])|>>\s*\S/.test(command)) {
      return {
        allowed: false,
        reason: `Bash command blocked: output redirect detected but Write/Edit not in allowed tools for '${state.state}' phase.`,
      }
    }
    if (/sed\s+-i|perl\s+-p?i/.test(command)) {
      return {
        allowed: false,
        reason: `Bash command blocked: in-place file modification detected but Edit not in allowed tools for '${state.state}' phase.`,
      }
    }
    if (/^\s*(python|python3|ruby|node|perl|php)\s/.test(command)) {
      return {
        allowed: false,
        reason: `Bash command blocked: scripting interpreter not permitted without Write/Edit in '${state.state}' phase.`,
      }
    }
  }

  // Allowed commands enforcement (prefix match, same semantics as OMX/pi)
  const allowedCommands = state.allowedCommands ?? []
  if (allowedCommands.length > 0) {
    const cmd = command.trim()
    const ok = allowedCommands.some(
      (prefix) => cmd === prefix || cmd.startsWith(prefix + " "),
    )
    if (!ok) {
      return {
        allowed: false,
        reason: `Bash command blocked: not in allowed commands for '${state.state}' phase. Allowed: ${allowedCommands.join(", ")}.`,
      }
    }
  }

  return { allowed: true }
}

function getPort(): string | null {
  try {
    return readFileSync("/tmp/statewright-hook-port", "utf8").trim()
  } catch {
    return null
  }
}

async function hookRequest(
  port: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<HookResponse | null> {
  try {
    const url = `http://localhost:${port}/hooks/${endpoint}`
    const opts: RequestInit = body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(3000),
        }
      : { signal: AbortSignal.timeout(3000) }

    const resp = await fetch(url, opts)
    if (!resp.ok) return null
    return (await resp.json()) as HookResponse
  } catch {
    return null
  }
}

async function getState(port: string): Promise<StateResponse | null> {
  try {
    const resp = await fetch(`http://localhost:${port}/hooks/state`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!resp.ok) return null
    return (await resp.json()) as StateResponse
  } catch {
    return null
  }
}

export const StatewrightPlugin: Plugin = async ({ client }) => {
  const port = getPort()
  if (!port) {
    console.warn("[statewright] Gateway not running — plugin inactive")
    return {}
  }

  console.log("[statewright] Connected to gateway on port", port)

  return {
    // Session start — inject state context
    "session.created": async () => {
      const state = await getState(port)
      if (!state) return

      // Use tui.toast to show current state
      return {
        "tui.toast.show": {
          message: `[statewright] Phase: ${state.state} (${state.iteration}/${state.maxIterations ?? "∞"})`,
          level: "info",
        },
      }
    },

    // Before each tool call — enforce per-state tool restriction
    "tool.execute.before": async ({
      input,
    }: {
      input: { tool: string; args: Record<string, unknown> }
    }) => {
      const resp = await hookRequest(port, "pre-tool", {
        tool_name: input.tool,
      })
      if (!resp) return

      if (resp.decision === "deny") {
        throw new Error(
          `[statewright] BLOCKED: ${resp.additionalContext ?? "Tool not available in current phase"}`,
        )
      }

      // The gateway enforces at tool granularity; classify bash commands
      // client-side against the state's allowed_commands, like the
      // claude-code hook and OMX plugin do.
      const command = input.args?.command
      if (input.tool === "bash" && typeof command === "string" && command.trim().length > 0) {
        const state = await getState(port)
        if (state) {
          const verdict = classifyBashCommand(command, state)
          if (!verdict.allowed) {
            throw new Error(`[statewright] BLOCKED: ${verdict.reason}`)
          }
        }
      }

      // Log transition context if present
      if (resp.additionalContext) {
        console.log(`[statewright] ${resp.additionalContext}`)
      }
    },

    // After each tool call — track iterations, detect transitions
    "tool.execute.after": async ({
      input,
    }: {
      input: { tool: string }
    }) => {
      const resp = await hookRequest(port, "post-tool", {
        tool_name: input.tool,
      })
      if (!resp) return

      if (resp.transition) {
        console.log(`[statewright] ${resp.transition}`)
        return {
          "tui.toast.show": {
            message: `[statewright] ${resp.transition}`,
            level: "info",
          },
        }
      }

      if (resp.completed) {
        console.log("[statewright] Workflow complete.")
        return {
          "tui.toast.show": {
            message: "[statewright] Workflow complete!",
            level: "success",
          },
        }
      }
    },

    // Session idle — show state summary
    "session.idle": async () => {
      const state = await getState(port)
      if (!state) return
      const pending = (state as any).pendingApproval ?? (state as any).pending_approval
      if (pending) {
        return {
          "tui.toast.show": {
            message: `[statewright] REVIEW REQUIRED: ${pending.message ?? "Human review required."}`,
            level: "warning",
          },
        }
      }
      if (state.isFinal) {
        return {
          "tui.toast.show": {
            message: `[statewright] Workflow finished: ${state.state}`,
            level: "success",
          },
        }
      }
    },
  }
}

export default StatewrightPlugin
