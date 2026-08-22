import { describe, expect, it } from "vitest"

import { callStatewrightGateway } from "./hook"

const live = process.env.STATEWRIGHT_PLUGIN_PRODUCTION_CANARY === "1"

describe("OMX production gateway canary", () => {
  const testLive = live ? it : it.skip

  testLive("uses OMX's authenticated MCP transport for a read-only status lookup", async () => {
    const status = await callStatewrightGateway(
      process.env.STATEWRIGHT_GATEWAY_URL!,
      process.env.STATEWRIGHT_API_KEY!,
      "statewright_get_status",
    )
    expect(status).toBeTruthy()
  })
})
