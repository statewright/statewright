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

import { enforceBeforeTool } from "./index"

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
