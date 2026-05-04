/**
 * Statewright skill extension for Pi coding agent
 *
 * Registers statewright_transition and statewright_get_state as Pi skills,
 * hooks into tool execution for enforcement, and renders state info
 * via pi-tui components.
 *
 * Pi extensions live in ~/.pi/agent/extensions/ or project .pi/extensions/
 */

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

/**
 * Pi extension entry point.
 *
 * Pi extensions export a default function that receives the extension
 * context (project, client, tools API) and returns skill definitions
 * and lifecycle hooks.
 */
export default async function statewrightExtension(ctx: {
  defineTools: (tools: Record<string, unknown>) => void
  onToolBefore: (handler: (tool: string, args: unknown) => Promise<void>) => void
  onToolAfter: (handler: (tool: string, result: unknown) => Promise<void>) => void
}) {
  const port = getPort()
  if (!port) {
    console.warn("[statewright] Gateway not running — extension inactive")
    return
  }

  console.log("[statewright] Connected to gateway on port", port)

  // Register statewright tools as Pi skills
  ctx.defineTools({
    statewright_get_state: {
      description:
        "Get the current state machine state, available tools, transitions, and iteration count.",
      parameters: {},
      execute: async () => {
        const state = await getState(port)
        if (!state) return { error: "Gateway not reachable" }
        return state
      },
    },
    statewright_transition: {
      description:
        "Transition the state machine to a new state by emitting an event.",
      parameters: {
        event: {
          type: "string",
          description: "The transition event name (e.g., DONE, FAIL, PLAN_READY)",
          required: true,
        },
      },
      execute: async (args: { event: string }) => {
        // The MCP gateway handles the actual transition
        // This skill just provides the interface for Pi's tool system
        const resp = await hookRequest(port, "pre-tool", {
          tool_name: `statewright_transition:${args.event}`,
        })
        return resp ?? { error: "Gateway not reachable" }
      },
    },
  })

  // Hook into tool execution for enforcement
  ctx.onToolBefore(async (tool: string, _args: unknown) => {
    const resp = await hookRequest(port, "pre-tool", { tool_name: tool })
    if (!resp) return

    if (resp.decision === "deny") {
      throw new Error(
        `[statewright] BLOCKED: ${resp.additionalContext ?? "Tool not available in current phase"}`,
      )
    }

    if (resp.additionalContext) {
      console.log(`[statewright] ${resp.additionalContext}`)
    }
  })

  ctx.onToolAfter(async (tool: string, _result: unknown) => {
    const resp = await hookRequest(port, "post-tool", { tool_name: tool })
    if (!resp) return

    if (resp.transition) {
      console.log(`[statewright] ${resp.transition}`)
    }
    if (resp.completed) {
      console.log("[statewright] Workflow complete.")
    }
  })

  // Print initial state
  const state = await getState(port)
  if (state) {
    console.log(
      `[statewright] Phase: ${state.state} (${state.iteration}/${state.maxIterations ?? "∞"}) | Tools: ${state.allowedTools.join(", ")}`,
    )
  }
}
