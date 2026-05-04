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

interface StateResponse {
  state: string
  isFinal: boolean
  iteration: number
  maxIterations: number | null
  allowedTools: string[]
  instructions: string | null
  additionalContext: string
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
