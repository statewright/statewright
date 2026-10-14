import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

describe("published OMX hook", () => {
  it("bundles the privacy-safe error reporter", async () => {
    const source = await readFile(resolve("dist/hook.js"), "utf8")
    expect(source).toMatch(/Unexpected plugin failure \(message withheld\)/)
    expect(source).toMatch(/uncaughtExceptionMonitor/)
    expect(source).toContain('/api/gateway/telemetry')
    expect(source).toContain('synthetic_canary')
  })
})
