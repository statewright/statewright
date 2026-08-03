/**
 * Tests for the opencode plugin's pure classification logic.
 *
 * classifyBashCommand mirrors the claude-code hook and OMX classifier:
 * destructive ops always blocked, redirect/interpreter heuristics when
 * Write/Edit aren't allowed, allowed_commands prefix matching when the
 * state defines it.
 */

import { describe, it, expect, vi } from "vitest"
import * as Sentry from "@sentry/node"

vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  setTag: vi.fn(),
  setUser: vi.fn(),
}))

import { classifyBashCommand, type StateResponse } from "./index"

function state(overrides: Partial<StateResponse> = {}): StateResponse {
  return {
    state: "triage",
    isFinal: false,
    iteration: 1,
    maxIterations: 8,
    allowedTools: ["read", "bash"],
    allowedCommands: [],
    instructions: null,
    additionalContext: "",
    ...overrides,
  }
}

describe("classifyBashCommand — destructive operations", () => {
  const cases = [
    "rm -rf /tmp/x",
    "  rm -rf /tmp/x",
    "echo hi && rm -rf /tmp/x",
    "echo hi; rm -rf /tmp/x",
    "echo hi\nrm -rf /tmp/x",
    "echo $(rm -rf /tmp/x)",
    "echo `rm -rf /tmp/x`",
    "rmdir /tmp/dir",
    "truncate -s 0 file",
  ]
  for (const cmd of cases) {
    it(`blocks: ${JSON.stringify(cmd)}`, () => {
      expect(classifyBashCommand(cmd, state()).allowed).toBe(false)
    })
  }

  it("does not block command names merely containing rm", () => {
    expect(classifyBashCommand("grep rm file.txt", state()).allowed).toBe(true)
    expect(classifyBashCommand("echo removing stale entries", state()).allowed).toBe(true)
  })
})

describe("classifyBashCommand — redirect/interpreter heuristics without Write/Edit", () => {
  it("blocks output redirects", () => {
    expect(classifyBashCommand("echo hi > file.txt", state()).allowed).toBe(false)
    expect(classifyBashCommand("echo hi >> file.txt", state()).allowed).toBe(false)
  })

  it("blocks in-place edits and interpreters", () => {
    expect(classifyBashCommand("sed -i s/a/b/ f", state()).allowed).toBe(false)
    expect(classifyBashCommand("python3 gen.py", state()).allowed).toBe(false)
  })

  it("allows redirects when write is in allowedTools (either casing)", () => {
    const lower = state({ allowedTools: ["bash", "write"] })
    const upper = state({ allowedTools: ["Bash", "Write"] })
    expect(classifyBashCommand("echo hi > file.txt", lower).allowed).toBe(true)
    expect(classifyBashCommand("echo hi > file.txt", upper).allowed).toBe(true)
  })

  it("does not treat fd duplication or numeric comparisons as redirects", () => {
    expect(classifyBashCommand("cmd 2>&1", state()).allowed).toBe(true)
  })
})

describe("classifyBashCommand — allowed_commands prefix matching", () => {
  const s = state({ allowedCommands: ["gh pr list", "git branch", "echo"] })

  it("allows exact and prefix-with-args matches", () => {
    expect(classifyBashCommand("echo", s).allowed).toBe(true)
    expect(classifyBashCommand("gh pr list --limit 5", s).allowed).toBe(true)
  })

  it("blocks out-of-phase commands", () => {
    const verdict = classifyBashCommand("git commit -m x", s)
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain("triage")
  })

  it("requires a word boundary after the prefix", () => {
    expect(classifyBashCommand("ghpr list", s).allowed).toBe(false)
  })

  it("is inert when the state defines no allowed_commands", () => {
    expect(classifyBashCommand("git commit -m x", state()).allowed).toBe(true)
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
