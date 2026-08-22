import { describe, expect, it } from "vitest"

import { callStatewrightGateway, initializeStatewrightGateway } from "./index"

const live = process.env.STATEWRIGHT_PLUGIN_PRODUCTION_CANARY === "1"

describe("Pi production gateway canary", () => {
  const testLive = live ? it : it.skip

  testLive("uses Pi's direct authenticated transport for a read-only status lookup", async () => {
    await expect(initializeStatewrightGateway()).resolves.toBe(true)
    const status = await callStatewrightGateway("statewright_get_status")
    expect(status).toBeTruthy()
  })
})
