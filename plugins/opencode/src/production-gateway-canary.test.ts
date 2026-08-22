import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

import { AdapterBridge } from "../../executor/lib/adapter-bridge.mjs"
import { RemoteStatewrightClient } from "../../executor/lib/remote-client.mjs"
import { StatewrightPlugin } from "./index"

const live = process.env.STATEWRIGHT_PLUGIN_PRODUCTION_CANARY === "1"

describe("OpenCode production gateway canary", () => {
  const testLive = live ? it : it.skip

  testLive("attests the real adapter and relays a read-only status lookup", async () => {
    const remote = new RemoteStatewrightClient({
      gatewayUrl: process.env.STATEWRIGHT_GATEWAY_URL!,
      apiKey: process.env.STATEWRIGHT_API_KEY!,
      clientId: `swc_${randomUUID().replaceAll("-", "")}`,
    })
    await remote.initialize()
    const bridge = await new AdapterBridge(remote, { host: "opencode" }).start()
    const originalUrl = process.env.STATEWRIGHT_ADAPTER_URL
    const originalToken = process.env.STATEWRIGHT_ADAPTER_TOKEN
    process.env.STATEWRIGHT_ADAPTER_URL = bridge.url!
    process.env.STATEWRIGHT_ADAPTER_TOKEN = bridge.token
    process.env.STATEWRIGHT_NO_UPDATE_CHECK = "1"

    try {
      const showToast = vi.fn().mockResolvedValue(undefined)
      const hooks = await StatewrightPlugin({ client: { tui: { showToast } } } as never)
      expect(bridge.adapterReady).toBe(true)
      expect(hooks.event).toBeTypeOf("function")
      const response = await fetch(`${bridge.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bridge.token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "statewright_get_status", arguments: {} },
        }),
      })
      expect(response.ok).toBe(true)
      expect((await response.json()).error).toBeUndefined()
    } finally {
      if (originalUrl === undefined) delete process.env.STATEWRIGHT_ADAPTER_URL
      else process.env.STATEWRIGHT_ADAPTER_URL = originalUrl
      if (originalToken === undefined) delete process.env.STATEWRIGHT_ADAPTER_TOKEN
      else process.env.STATEWRIGHT_ADAPTER_TOKEN = originalToken
      await bridge.close()
    }
  })
})
