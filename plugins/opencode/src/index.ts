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

import * as Sentry from "@sentry/node"

const PLUGIN_NAME = "opencode"
const PLUGIN_VERSION = "0.3.0"

Sentry.init({
  dsn: "https://3c30b803a5b44d74bf9657db7a89f033@glitch.enhasa.cloud/12",
  release: `statewright-${PLUGIN_NAME}@${PLUGIN_VERSION}`,
  environment: process.env.NODE_ENV || "production",
})
Sentry.setTag("plugin", PLUGIN_NAME)
Sentry.setTag("platform", `${process.platform}-${process.arch}`)

import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

interface HookResponse {
  decision?: string
  reason?: string
  additionalContext?: string
  additional_context?: string
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
  model: string | null
  defaultModel: string | null
  thinkingLevel: string | null
  pendingApproval?: { message?: string | null } | null
  deliveryRequired: boolean
  executor?: { active: boolean; id?: string; delivery?: boolean }
  additionalContext: string
}

interface RoutedMessage {
  model: {
    providerID: string
    modelID: string
    variant?: string
  }
}

interface OpenCodeClient {
  tui: {
    showToast(options: {
      body: {
        title?: string
        message: string
        variant: "info" | "success" | "warning" | "error"
      }
    }): Promise<unknown>
  }
  session?: {
    prompt(options: {
      path: { id: string }
      body: {
        model?: { providerID: string; modelID: string }
        variant?: string
        parts: Array<{ type: "text"; text: string }>
      }
    }): Promise<unknown>
  }
}

function sessionIdFromEvent(event: Record<string, any>): string | null {
  return event.properties?.sessionID
    ?? event.properties?.sessionId
    ?? event.properties?.info?.id
    ?? event.sessionID
    ?? null
}

function continuationBody(state: StateResponse) {
  const body: {
    model?: { providerID: string; modelID: string }
    variant?: string
    parts: Array<{ type: "text"; text: string }>
  } = {
    parts: [{
      type: "text",
      text: `${state.additionalContext} Continue the active Statewright workflow now.`,
    }],
  }
  if (state.model) {
    const separator = state.model.indexOf("/")
    if (separator <= 0 || separator === state.model.length - 1) {
      throw new Error(
        `[statewright] OpenCode model routes must use provider/model syntax: '${state.model}'.`,
      )
    }
    body.model = {
      providerID: state.model.slice(0, separator),
      modelID: state.model.slice(separator + 1),
    }
    if (state.thinkingLevel) body.variant = state.thinkingLevel
  }
  return body
}

async function showToast(
  client: OpenCodeClient,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
): Promise<void> {
  await client.tui.showToast({
    body: { title: "Statewright", message, variant },
  }).catch(() => {})
}

export function requireDeliveryOwner(
  state: Pick<StateResponse, "deliveryRequired" | "executor">,
): void {
  if (state.deliveryRequired && (!state.executor?.active || !state.executor.delivery)) {
    throw new Error(
      "[statewright] This workflow requires isolated delivery, but no delivery owner is active. "
      + "Launch it through the Statewright executor so it owns the delivery lifecycle.",
    )
  }
}

export function applyStateRoute(
  state: Pick<StateResponse, "model" | "thinkingLevel">,
  message: RoutedMessage,
): boolean {
  if (!state.model) return false
  const separator = state.model.indexOf("/")
  if (separator <= 0 || separator === state.model.length - 1) {
    throw new Error(
      `[statewright] OpenCode model routes must use provider/model syntax: '${state.model}'.`,
    )
  }
  message.model.providerID = state.model.slice(0, separator)
  message.model.modelID = state.model.slice(separator + 1)
  if (state.thinkingLevel) message.model.variant = state.thinkingLevel
  else delete message.model.variant
  return true
}

function getAdapterConnection(): { baseUrl: string; token: string | null } | null {
  if (process.env.STATEWRIGHT_ADAPTER_URL) {
    return {
      baseUrl: process.env.STATEWRIGHT_ADAPTER_URL.replace(/\/$/, ""),
      token: process.env.STATEWRIGHT_ADAPTER_TOKEN ?? null,
    }
  }
  try {
    const port = readFileSync("/tmp/statewright-hook-port", "utf8").trim()
    return { baseUrl: `http://localhost:${port}`, token: null }
  } catch {
    return null
  }
}

function adapterBase(value: string): string {
  return /^\d+$/.test(value) ? `http://localhost:${value}` : value.replace(/\/$/, "")
}

async function hookRequest(
  adapter: string,
  endpoint: string,
  body?: Record<string, unknown>,
  token: string | null = process.env.STATEWRIGHT_ADAPTER_TOKEN ?? null,
): Promise<HookResponse | null> {
  try {
    const url = `${adapterBase(adapter)}/hooks/${endpoint}`
    const opts: RequestInit = body
      ? {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(3000),
        }
      : {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.timeout(3000),
        }

    const resp = await fetch(url, opts)
    if (!resp.ok) {
      if (process.env.STATEWRIGHT_ADAPTER_URL) {
        throw new Error(`[statewright] Adapter pre/post hook failed with HTTP ${resp.status}.`)
      }
      return null
    }
    return (await resp.json()) as HookResponse
  } catch (error) {
    if (process.env.STATEWRIGHT_ADAPTER_URL) throw error
    return null
  }
}

async function getState(
  adapter: string,
  token: string | null = process.env.STATEWRIGHT_ADAPTER_TOKEN ?? null,
): Promise<StateResponse | null> {
  try {
    const resp = await fetch(`${adapterBase(adapter)}/hooks/state`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(2000),
    })
    if (!resp.ok) {
      if (process.env.STATEWRIGHT_ADAPTER_URL) {
        throw new Error(`[statewright] Adapter state lookup failed with HTTP ${resp.status}.`)
      }
      return null
    }
    return (await resp.json()) as StateResponse
  } catch (error) {
    if (process.env.STATEWRIGHT_ADAPTER_URL) throw error
    return null
  }
}

export async function enforceBeforeTool(
  adapter: string,
  input: { tool: string; args: Record<string, unknown> },
  token: string | null = process.env.STATEWRIGHT_ADAPTER_TOKEN ?? null,
): Promise<void> {
  const resp = await hookRequest(adapter, "pre-tool", {
    tool_name: input.tool,
    tool_input: input.args ?? {},
  }, token)
  if (!resp) return

  if (resp.decision === "deny") {
    throw new Error(
      `[statewright] BLOCKED: ${resp.reason ?? resp.additionalContext ?? resp.additional_context ?? "Tool not available in current phase"}`,
    )
  }

  const additionalContext = resp.additionalContext ?? resp.additional_context
  if (additionalContext) {
    console.log(`[statewright] ${additionalContext}`)
  }
}

function reportPluginEvent(event = "connect") {
  if (process.env.STATEWRIGHT_NO_UPDATE_CHECK) return
  try {
    const apiKey = readFileSync(join(homedir(), ".statewright", "api_key"), "utf8").trim()
    const pbUrl = process.env.STATEWRIGHT_PB_URL || "https://statewright.ai"
    Sentry.setUser({ id: apiKey.slice(0, 8) })
    fetch(`${pbUrl}/api/telemetry/plugin-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugin: PLUGIN_NAME, event, version: PLUGIN_VERSION, api_key: apiKey, platform: `${process.platform}-${process.arch}` }),
      signal: AbortSignal.timeout(5000),
    }).then(r => r.json()).then((data: any) => {
      if (data.latest_version && data.latest_version !== PLUGIN_VERSION) {
        console.log(`[statewright] Update available: v${PLUGIN_VERSION} → v${data.latest_version}`)
      }
    }).catch(() => {})
  } catch {}
}

export function createStatewrightHooks(
  adapter: string,
  client: OpenCodeClient,
  token: string | null = process.env.STATEWRIGHT_ADAPTER_TOKEN ?? null,
) {
  const continuingSessions = new Set<string>()
  return {
    // OpenCode publishes session lifecycle through the generic event hook.
    event: async ({ event }: { event: Record<string, any> & { type: string } }) => {
      if (event.type !== "session.created" && event.type !== "session.idle") return
      const state = await getState(adapter, token)
      if (!state) return

      if (event.type === "session.created") {
        try {
          requireDeliveryOwner(state)
        } catch (error) {
          await showToast(client, (error as Error).message, "error")
          return
        }
        await showToast(
          client,
          `Phase: ${state.state} (${state.iteration}/${state.maxIterations ?? "∞"})`,
        )
        return
      }

      const pending = state.pendingApproval ?? (state as any).pending_approval
      if (pending) {
        await showToast(
          client,
          `REVIEW REQUIRED: ${pending.message ?? "Human review required."}`,
          "warning",
        )
      } else if (state.isFinal) {
        await showToast(client, `Workflow finished: ${state.state}`, "success")
      } else {
        const sessionId = sessionIdFromEvent(event)
        if (!sessionId || !client.session?.prompt || continuingSessions.has(sessionId)) return
        continuingSessions.add(sessionId)
        void client.session.prompt({
          path: { id: sessionId },
          body: continuationBody(state),
        }).catch(async (error) => {
          await showToast(
            client,
            `Could not continue Statewright workflow: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          )
        }).finally(() => continuingSessions.delete(sessionId))
      }
    },

    // OpenCode exposes the outgoing user message before dispatch. Route each
    // turn from fresh gateway state so a transition takes effect immediately.
    "chat.message": async (
      _input: unknown,
      output: { message: RoutedMessage },
    ) => {
      const state = await getState(adapter, token)
      if (!state) return
      requireDeliveryOwner(state)
      if (applyStateRoute(state, output.message)) {
        console.log(
          `[statewright] state=${state.state} model=${state.model}`
          + ` effort=${state.thinkingLevel ?? "default"}`,
        )
      }
    },

    // Before each tool call — enforce per-state tool restriction
    "tool.execute.before": async (
      input: { tool: string },
      output: { args: Record<string, unknown> },
    ) => {
      if (input.tool.includes("statewright_")) return
      const state = await getState(adapter, token)
      if (state) requireDeliveryOwner(state)
      await enforceBeforeTool(adapter, { tool: input.tool, args: output.args }, token)
    },

    // After each tool call — track iterations, detect transitions
    "tool.execute.after": async (
      input: { tool: string; args?: Record<string, unknown> },
      output: { output?: string; metadata?: Record<string, unknown> },
    ) => {
      if (input.tool.includes("statewright_")) {
        const state = await getState(adapter, token)
        if (state?.isFinal) {
          await showToast(client, `Workflow finished: ${state.state}`, "success")
        } else if (state) {
          await showToast(client, `Phase: ${state.state}`)
        }
        return
      }
      const resp = await hookRequest(adapter, "post-tool", {
        tool_name: input.tool,
        tool_input: input.args ?? {},
        tool_response: output.output ?? "",
        is_error: Boolean(output.metadata?.error),
      }, token)
      if (!resp) return

      if (resp.transition) {
        console.log(`[statewright] ${resp.transition}`)
        await showToast(client, resp.transition)
      }

      if (resp.completed) {
        console.log("[statewright] Workflow complete.")
        await showToast(client, "Workflow complete!", "success")
      }
    },
  }
}

export const StatewrightPlugin: Plugin = async ({ client }) => {
  const connection = getAdapterConnection()
  if (!connection) {
    console.warn("[statewright] Gateway not running — plugin inactive")
    return {}
  }

  console.log("[statewright] Connected to adapter", connection.baseUrl)
  reportPluginEvent("connect")
  return createStatewrightHooks(
    connection.baseUrl,
    client as OpenCodeClient,
    connection.token,
  )
}

export default StatewrightPlugin
