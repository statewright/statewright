/**
 * Statewright extension for Pi coding agent
 *
 * Enforces state machine guardrails via the statewright MCP gateway's
 * hook HTTP server. Registers custom tools, blocks unauthorized tool
 * calls, injects state context before each agent turn.
 *
 * Install:
 *   ~/.pi/agent/extensions/statewright/index.ts  (global)
 *   .pi/extensions/statewright/index.ts           (project)
 *
 * Requires: statewright-gateway running with --hook-server
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { Type } from "typebox"
import { readFileSync } from "node:fs"

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

function formatStateContext(state: StateResponse): string {
  const lines = [
    `Statewright state machine is active. Current phase: ${state.state} (iteration ${state.iteration}/${state.maxIterations ?? "∞"}).`,
    `Tools available in this phase: ${state.allowedTools.join(", ")}.`,
  ]
  if (state.instructions) {
    lines.push(`Phase instructions: ${state.instructions}`)
  }
  lines.push(
    "",
    "State transition reporting convention:",
    "- Before each call to statewright_transition, output a line: **[statewright]** CURRENT_STATE => TARGET_STATE",
    "- When the workflow reaches a final state, output: **[statewright]** Workflow complete.",
    "- Call statewright_get_state at the start to confirm the current phase.",
  )
  return lines.join("\n")
}

export default async function statewrightExtension(pi: ExtensionAPI) {
  const port = getPort()
  if (!port) {
    console.warn("[statewright] Gateway not running — extension inactive")
    return
  }

  // Verify connectivity
  const initial = await getState(port)
  if (!initial) {
    console.warn("[statewright] Could not reach gateway on port", port)
    return
  }

  console.log(
    `[statewright] Phase: ${initial.state} (${initial.iteration}/${initial.maxIterations ?? "∞"}) | Tools: ${initial.allowedTools.join(", ")}`,
  )

  // --- Custom tools ---

  pi.registerTool({
    name: "statewright_get_state",
    label: "Get State",
    description:
      "Get the current state machine state, available tools, transitions, and iteration count.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const state = await getState(port)
      if (!state) return { content: [{ type: "text", text: "Gateway not reachable" }] }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(state, null, 2),
          },
        ],
      }
    },
  })

  pi.registerTool({
    name: "statewright_transition",
    label: "Transition State",
    description:
      "Transition the state machine to a new state by emitting an event (e.g., DONE, FAIL, PLAN_READY).",
    parameters: Type.Object({
      event: Type.String({
        description: "The transition event name (e.g., DONE, FAIL, PLAN_READY)",
      }),
    }),
    async execute(_toolCallId, params: { event: string }, signal) {
      const resp = await hookRequest(port, "pre-tool", {
        tool_name: `statewright_transition:${params.event}`,
      })
      if (!resp) return { content: [{ type: "text", text: "Gateway not reachable" }] }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(resp, null, 2),
          },
        ],
      }
    },
  })

  // --- Context injection (equivalent to Claude Code UserPromptSubmit) ---

  pi.on("before_agent_start", async (_event, ctx) => {
    const state = await getState(port)
    if (!state) return

    // Update status bar
    ctx.ui.setStatus(
      "statewright",
      `[statewright] ${state.state} (${state.iteration}/${state.maxIterations ?? "∞"})`,
    )

    // Inject state context as a system message
    return {
      appendSystemPrompt: formatStateContext(state),
    }
  })

  // --- Tool enforcement (equivalent to Claude Code PreToolUse) ---

  pi.on("tool_call", async (event, ctx) => {
    // Never gate statewright's own tools
    if (event.toolName.startsWith("statewright_")) return

    const resp = await hookRequest(port, "pre-tool", {
      tool_name: event.toolName,
    })
    if (!resp) return

    if (resp.decision === "deny") {
      return {
        block: true,
        reason: resp.additionalContext ?? "Tool not available in current phase",
      }
    }
  })

  // --- Post-tool tracking (equivalent to Claude Code PostToolUse) ---

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName.startsWith("statewright_")) return

    const resp = await hookRequest(port, "post-tool", {
      tool_name: event.toolName,
    })
    if (!resp) return

    // Update status on state change
    const state = await getState(port)
    if (state) {
      ctx.ui.setStatus(
        "statewright",
        `[statewright] ${state.state} (${state.iteration}/${state.maxIterations ?? "∞"})`,
      )
    }

    if (resp.completed) {
      ctx.ui.notify("[statewright] Workflow complete.", "success")
    } else if (resp.transition) {
      ctx.ui.notify(`[statewright] ${resp.transition}`, "info")
    }
  })
}
