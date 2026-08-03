/**
 * Tests for the opencode plugin's pre-tool gateway contract.
 */

import { describe, it, expect, vi } from "vitest"
import * as Sentry from "@sentry/node"

vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  setTag: vi.fn(),
  setUser: vi.fn(),
}))

import {
  applyStateRoute,
  createStatewrightHooks,
  enforceBeforeTool,
  requireDeliveryOwner,
} from "./index"

describe("enforceBeforeTool", () => {
  it("sends tool arguments to pre-tool in one gateway request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ decision: "allow" }),
    })
    vi.stubGlobal("fetch", fetchMock)

    await enforceBeforeTool("4321", {
      tool: "bash",
      args: { command: "gh pr list --limit 5" },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4321/hooks/pre-tool",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          tool_name: "bash",
          tool_input: { command: "gh pr list --limit 5" },
        }),
      }),
    )
    vi.unstubAllGlobals()
  })

  it("surfaces a server-side command-policy denial", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        decision: "deny",
        additionalContext: "BLOCKED: command prefix collision",
      }),
    }))

    await expect(enforceBeforeTool("4321", {
      tool: "bash",
      args: { command: "ghpr list" },
    })).rejects.toThrow("command prefix collision")
    vi.unstubAllGlobals()
  })
})

describe("state routing", () => {
  it("routes the outgoing message by provider, model, and reasoning variant", () => {
    const message = {
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-6",
        variant: "low",
      },
    }

    expect(applyStateRoute({
      model: "openai/gpt-5.6-terra",
      thinkingLevel: "high",
    }, message)).toBe(true)
    expect(message.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-terra",
      variant: "high",
    })
  })

  it("rejects malformed state model routes instead of guessing a provider", () => {
    const message = {
      model: { providerID: "openai", modelID: "gpt-5.6-terra" },
    }
    expect(() => applyStateRoute({
      model: "gpt-5.6-sol",
      thinkingLevel: null,
    }, message)).toThrow("provider/model")
  })

  it("requires a real isolated-delivery owner for required workflows", () => {
    expect(() => requireDeliveryOwner(
      { deliveryRequired: true },
    )).toThrow("Statewright executor")
    expect(() => requireDeliveryOwner(
      {
        deliveryRequired: true,
        executor: { active: true, delivery: true },
      },
    )).not.toThrow()
  })
})

describe("OpenCode host contract", () => {
  it("handles lifecycle events through event and routes chat.message output", async () => {
    const showToast = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        state: "implementing",
        isFinal: false,
        iteration: 2,
        maxIterations: 5,
        allowedTools: ["Read", "Edit"],
        allowedCommands: [],
        instructions: "Implement the change",
        model: "openai/gpt-5.6-terra",
        defaultModel: "openai/gpt-5.6-terra",
        thinkingLevel: "medium",
        deliveryRequired: false,
        additionalContext: "Current state: implementing",
      }),
    }))
    const hooks = createStatewrightHooks("4321", { tui: { showToast } })

    await hooks.event({ event: { type: "session.created" } })
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ message: expect.stringContaining("implementing") }),
    }))

    const output = {
      message: {
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      },
    }
    await hooks["chat.message"]({}, output)
    expect(output.message.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-terra",
      variant: "medium",
    })
    vi.unstubAllGlobals()
  })

  it("continues a non-final executor workflow in the same OpenCode session", async () => {
    const prompt = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        state: "testing",
        isFinal: false,
        iteration: 3,
        maxIterations: 5,
        allowedTools: ["Bash"],
        allowedCommands: ["npm test"],
        instructions: "Run validation",
        model: "openai/gpt-5.6-terra",
        defaultModel: "openai/gpt-5.6-terra",
        thinkingLevel: "medium",
        deliveryRequired: false,
        pendingApproval: null,
        additionalContext: "Phase: testing.",
      }),
    }))
    const hooks = createStatewrightHooks("4321", {
      tui: { showToast: vi.fn().mockResolvedValue(undefined) },
      session: { prompt },
    })

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "session-7" } },
    })
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
    expect(prompt).toHaveBeenCalledWith({
      path: { id: "session-7" },
      body: {
        model: { providerID: "openai", modelID: "gpt-5.6-terra" },
        variant: "medium",
        parts: [{
          type: "text",
          text: "Phase: testing. Continue the active Statewright workflow now.",
        }],
      },
    })
    vi.unstubAllGlobals()
  })

  it("uses OpenCode's two-argument tool hook contract", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ deliveryRequired: false }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: "allow" }),
      })
    vi.stubGlobal("fetch", fetchMock)
    const hooks = createStatewrightHooks("4321", {
      tui: { showToast: vi.fn().mockResolvedValue(undefined) },
    })

    await hooks["tool.execute.before"](
      { tool: "bash" },
      { args: { command: "git status --short" } },
    )
    expect(fetchMock.mock.calls[1][1].body).toBe(JSON.stringify({
      tool_name: "bash",
      tool_input: { command: "git status --short" },
    }))
    vi.unstubAllGlobals()
  })

  it("keeps Statewright control tools out of workload policy and accounting", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: "testing", isFinal: false }),
    })
    vi.stubGlobal("fetch", fetchMock)
    const hooks = createStatewrightHooks("4321", {
      tui: { showToast: vi.fn().mockResolvedValue(undefined) },
    })

    await hooks["tool.execute.before"](
      { tool: "mcp_statewright_transition" },
      { args: { event: "DONE" } },
    )
    await hooks["tool.execute.after"](
      { tool: "mcp_statewright_transition", args: { event: "DONE" } },
      { output: "ok" },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain("/hooks/state")
    vi.unstubAllGlobals()
  })
})

describe("Sentry initialization", () => {
  it("calls Sentry.init with the plugins DSN on module load", () => {
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: expect.stringContaining("glitch.enhasa.cloud/12"),
        release: expect.stringMatching(/^statewright-opencode@\d+\.\d+\.\d+$/),
      })
    )
  })

  it("sets plugin and platform tags", () => {
    expect(Sentry.setTag).toHaveBeenCalledWith("plugin", "opencode")
    expect(Sentry.setTag).toHaveBeenCalledWith("platform", expect.stringMatching(/.+-.+/))
  })
})
