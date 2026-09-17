import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createPiRpcInput, snapshotPiRpcConfiguration } from "./request-rpc-input.mjs"

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })

async function inlet(configuration = vi.fn(async () => undefined)) {
  const source = new PassThrough()
  const output = vi.fn()
  const onDisconnect = vi.fn()
  const router = createPiRpcInput({ input: source, configuration, output, onDisconnect })
  const forwarded: string[] = []
  router.input.on("data", chunk => forwarded.push(String(chunk)))
  cleanup.push(() => { router.close(); source.destroy(); router.input.destroy() })
  await vi.waitFor(() => expect(source.listenerCount("data")).toBe(1))
  return { source, output, onDisconnect, router, configuration, forwarded }
}

describe("owning native RPC configuration inlet", () => {
  it.each([false, true])("handles startup terminal input before SDK reader attachment (error=%s)", async withError => {
    const source = new PassThrough()
    const onDisconnect = vi.fn()
    const configuration = vi.fn()
    const router = createPiRpcInput({ input: source, configuration, output: vi.fn(), onDisconnect })
    cleanup.push(() => { router.close(); source.destroy(); router.input.destroy() })
    expect(source.listenerCount("data")).toBe(0)
    if (withError) expect(() => source.emit("error", new Error("synthetic startup error"))).not.toThrow()
    else source.destroy()
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledOnce(), { timeout: 500 })
    expect(configuration).not.toHaveBeenCalled()
    expect(source.listenerCount("data")).toBe(0)
    expect(source.listenerCount("close")).toBe(0)
    router.input.resume()
    await new Promise(resolve => setImmediate(resolve))
    expect(onDisconnect).toHaveBeenCalledOnce()
  })

  it("preserves LF/CRLF and fragmented UTF8 framing without treating Unicode separators as records", async () => {
    const f = await inlet()
    const wire = Buffer.from(`${JSON.stringify({ type: "set_session_name", name: "native café\u2028name\u2029end" })}\r\n{"type":"get_state"}\ninvalid\n`)
    const split = wire.indexOf(Buffer.from("é")) + 1
    f.source.write(wire.subarray(0, split))
    f.source.write(wire.subarray(split))
    await vi.waitFor(() => expect(f.output).toHaveBeenCalledOnce())
    expect(f.configuration).toHaveBeenCalledWith({ type: "set_session_name", name: "native café\u2028name\u2029end" })
    expect(f.forwarded).toEqual(['{"type":"get_state"}\n', 'invalid\n'])
  })

  it("captures synchronously at line arrival and never responds before the action settles", async () => {
    let release!: (value: unknown) => void
    const configuration = vi.fn(() => new Promise(resolve => { release = resolve }))
    const f = await inlet(configuration as any)
    f.source.write('{"type":"cycle_thinking_level","id":"native"}\n{"type":"get_state"}\n')
    expect(configuration).toHaveBeenCalledOnce()
    expect(f.output).not.toHaveBeenCalled()
    expect(f.forwarded).toEqual(['{"type":"get_state"}\n'])
    release({ level: "high" })
    await vi.waitFor(() => expect(f.output).toHaveBeenCalledOnce())
    expect(JSON.parse(f.output.mock.calls[0][0])).toEqual({ id: "native", type: "response", command: "cycle_thinking_level", success: true, data: { level: "high" } })
  })

  it.each([
    { type: "set_model", provider: "fixture", modelId: "fixture", reference: {} },
    { type: "set_session_name", name: " " },
    { type: "set_thinking_level", level: "invented" },
    { type: "cycle_model", release_nonce: "forged" },
    { type: "cycle_thinking_level", id: [] },
  ])("rejects malformed or authority-bearing configuration before capture: %j", async command => {
    const f = await inlet()
    f.source.write(`${JSON.stringify(command)}\n`)
    expect(f.configuration).not.toHaveBeenCalled()
    expect(f.forwarded).toEqual([])
    expect(JSON.parse(f.output.mock.calls[0][0])).toMatchObject({ success: false, command: command.type })
  })

  it("rejects type aliases and freezes the command snapshot", () => {
    expect(() => snapshotPiRpcConfiguration({ type: ["cycle_model"] })).toThrow("Invalid native RPC configuration")
    const command = { type: "set_session_name", name: "captured" }
    const snapshot = snapshotPiRpcConfiguration(command)
    command.name = "changed"
    expect(snapshot.name).toBe("captured")
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it("cancels on EOF, handles the final non-LF record and drops a detached late response", async () => {
    let release!: () => void
    const configuration = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const f = await inlet(configuration as any)
    f.source.end('{"type":"set_session_name","name":"last line"}')
    await vi.waitFor(() => expect(f.onDisconnect).toHaveBeenCalledOnce())
    expect(configuration).toHaveBeenCalledOnce()
    release()
    await new Promise(resolve => setImmediate(resolve))
    expect(f.output).not.toHaveBeenCalled()
    expect(f.source.listenerCount("data")).toBe(0)
  })

  it("reports a denied action as failure without blocking later SDK records", async () => {
    const f = await inlet(vi.fn(async () => { throw new Error("Project request unavailable") }))
    f.source.write('{"type":"cycle_model","id":"old"}\n{"type":"get_state"}\n')
    await vi.waitFor(() => expect(f.output).toHaveBeenCalledOnce())
    expect(JSON.parse(f.output.mock.calls[0][0])).toMatchObject({ id: "old", success: false, error: "Project request unavailable" })
    expect(f.forwarded).toEqual(['{"type":"get_state"}\n'])
  })

  it("cancels a closed input even when it emits neither EOF nor an error", async () => {
    const f = await inlet()
    f.source.destroy()
    await vi.waitFor(() => expect(f.onDisconnect).toHaveBeenCalledOnce())
    expect(f.source.listenerCount("data")).toBe(0)
    expect(f.source.listenerCount("close")).toBe(0)
    expect(f.output).not.toHaveBeenCalled()
  })
})
