import { createServer } from "node:http"
import { EventEmitter } from "node:events"
import { AsyncResource } from "node:async_hooks"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthStorage, InteractiveMode, SessionManager, SettingsManager, initTheme } from "@mariozechner/pi-coding-agent"
import { createPiRequestFrontend } from "./request-frontend.mjs"
import { createPiNativeReadinessPublisher } from "./request-readiness.mjs"
import { createExecutorNativeReadiness } from "../../executor/lib/executor-native-readiness.mjs"
import { AdapterBridge } from "../../executor/lib/adapter-bridge.mjs"
import { fixture, pending } from "../../executor/tests/fixtures/owned-request.mjs"
import statewrightExtension, { callStatewrightGateway } from "./index.js"
import { dispatchPiProjectEffect, fetchPiProject, isPiProjectManaged } from "./project-effects.mjs"
import { createPiRequestModeRuntime, runPiRequestMode } from "./request-mode.mjs"
import * as requestMode from "./request-mode.mjs"
import { createPiRpcInput } from "./request-rpc-input.mjs"
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@mariozechner/pi-tui"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })

// Public SDK services/runtime and actual Agent; task-owned HTTP returns inert
// SSE. Parent authority is synthetic, owner/journal/bridge are real local code.
async function frontendFixture(options: { parked?: boolean; streaming?: boolean; register?: (...args: any[]) => unknown;
  onReady?: (...args: any[]) => unknown; handshake?: boolean; acknowledgement?: (value: any) => any;
  availableModels?: () => any[] | Promise<any[]>; reasoning?: boolean;
  beforeCreate?: (fixture: any) => void; retry?: boolean; retryDelayMs?: number } = {}) {
  const f = await fixture({ after: (fn: () => unknown) => cleanup.push(fn) }, { ...options, nativeFile: options.handshake })
  const requests: any[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    if (options.retry && requests.length === 1) {
      response.writeHead(503, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "Synthetic 503 overload" } }))
      return
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    if (options.streaming) { response.flushHeaders(); return }
    const chunk = (delta: unknown, finish_reason: string | null) => JSON.stringify({
      id: "synthetic", object: "chat.completion.chunk", model: "synthetic-chat",
      choices: [{ index: 0, delta, finish_reason }],
    })
    response.end(`data: ${chunk({ role: "assistant", content: "synthetic response" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const nativeReadiness = options.handshake ? createExecutorNativeReadiness({ owner: f.owner, requestController: f.controller }) : null
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, killed: false })
  nativeReadiness?.bindChild(child)
  const bridge = await new AdapterBridge({ call: async (name: string) => {
    if (name !== "statewright_get_state") throw new Error("Unexpected fixture effect")
    return f.getState()
  } }, { host: "pi", sessionOwner: f.owner, requestController: f.controller, nativeReadiness }).start()
  cleanup.push(() => bridge.close())
  options.beforeCreate?.({ ...f, bridge })
  const call = async (action: string, body: unknown, signal?: AbortSignal) => {
    const response = await fetch(`${bridge.url}/hooks/request/${action}`, {
      method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal,
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    return action === "ready" && options.acknowledgement ? options.acknowledgement(result) : result
  }
  const cwd = options.handshake ? f.owner.record.scope.cwd : dirname(f.owner.path)
  const sessionManager = options.handshake ? SessionManager.open(f.owner.record.host_session_file, f.owner.nativeRoot, cwd) : SessionManager.inMemory(cwd)
  if (!options.handshake) sessionManager.newSession({ id: f.owner.record.host_session_id })
  const model = { id: "synthetic-chat", name: "Synthetic", api: "openai-completions", provider: "synthetic-provider",
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, reasoning: options.reasoning ?? false,
    input: ["text"], contextWindow: 65_536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  const modelRegistry = { hasConfiguredAuth: vi.fn(() => true), getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "synthetic-not-a-secret" })),
    getAll: () => [], getAvailable: options.availableModels ?? (() => [model]), find: () => model, isUsingOAuth: () => false,
    registerProvider: vi.fn(), unregisterProvider: vi.fn() }
  const onPark = vi.fn()
  const uiContext = { notify: vi.fn(), setStatus: vi.fn() }
  const publish = nativeReadiness ? createPiNativeReadinessPublisher({ challenge: nativeReadiness.challenge, sessionManager, call }) : null
  const onReady = vi.fn(async (...args: any[]) => { await options.onReady?.(...args); if (publish) await publish(args[0]) })
  const args = { nativeSessionId: f.owner.record.host_session_id, call,
    target: { cwd, agentDir: join(cwd, "agent"), sessionManager },
    servicesOptions: { authStorage: AuthStorage.inMemory(), modelRegistry,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: {
        enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: options.retryDelayMs ?? 60, provider: { maxRetries: 0 } } }) },
    resources: { noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, systemPrompt: "Synthetic fixture" },
    sessionOptions: { model, thinkingLevel: "off", noTools: "all" },
    gateOptions: { pollMs: 5, timeoutMs: 3_000, onPark }, register: options.register ?? (() => {}), onReady }
  const frontend = await createPiRequestFrontend(args)
  cleanup.push(() => frontend.close())
  return { ...f, frontend, args, requests, sessionManager, modelRegistry, onPark, onReady, nativeReadiness, child, bridge, publish,
    session: frontend.runtime.session,
    uiContext, bind: () => frontend.runtime.session.bindExtensions({ uiContext }),
  }
}

describe("owning public SDK frontend readiness", () => {
  // Actual SDK subscription wiring; renderer is inert, never calls init/run.
  function retrySubscription(f: Awaited<ReturnType<typeof frontendFixture>>, handler: (event: any) => unknown) {
    const native = new AsyncResource("fixture-native-retry-observer-control")
    cleanup.push(() => { native.emitDestroy() })
    const mode = Object.assign(Object.create(InteractiveMode.prototype), {
      runtimeHost: createPiRequestModeRuntime(f.frontend),
      handleEvent: vi.fn(async event => { if (event.type === "auto_retry_start") return await handler(event) }),
    })
    mode.subscribeToAgent()
    cleanup.push(() => mode.unsubscribe())
    return { native, mode }
  }

  it("reports current async SDK retry observer failure and closes only its owning frontend", async () => {
    const f = await frontendFixture({ retry: true })
    await f.bind()
    const errors = vi.fn()
    cleanup.push(f.session.extensionRunner!.onError(errors))
    const { mode } = retrySubscription(f, async () => { throw new Error("synthetic async native observer failure") })
    await f.session.prompt("current native retry")
    expect(mode.handleEvent.mock.calls.some(([event]: any[]) => event.type === "auto_retry_start")).toBe(true)
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.objectContaining({
      event: "auto_retry_start", error: "synthetic async native observer failure",
    })), { timeout: 500 })
    expect(f.frontend.readiness).toBeNull()
    expect(f.requests).toHaveLength(1)
    expect(f.session.retryAttempt).toBe(0)
    expect(f.session.isRetrying).toBe(false)
  })

  it("drops stale async SDK retry observer failure after a newer native command epoch", async () => {
    const command = vi.fn()
    const f = await frontendFixture({ retry: true, register: pi => pi.registerCommand("owned", { handler: command }) })
    await f.bind()
    const errors = vi.fn()
    cleanup.push(f.session.extensionRunner!.onError(errors))
    let reject!: (error: Error) => void
    const barrier = new Promise<void>((_resolve, fail) => { reject = fail })
    // Keep rejection observed even if an unrelated red assertion aborts early.
    barrier.catch(() => {})
    cleanup.push(() => reject(new Error("synthetic stale native observer failure")))
    const { mode } = retrySubscription(f, () => barrier)
    await f.session.prompt("old native retry")
    expect(mode.handleEvent.mock.calls.some(([event]: any[]) => event.type === "auto_retry_start")).toBe(true)
    expect(f.requests).toHaveLength(2)
    await f.session.prompt("/owned replacement")
    expect(command).toHaveBeenCalledTimes(1)
    expect(f.owner.record.request_epoch).toBe(2)
    const ready = f.frontend.readiness
    reject(new Error("synthetic stale native observer failure"))
    // Await the actual handler result and one turn for the SDK subscriber chain.
    await Promise.allSettled(mode.handleEvent.mock.results.map((result: any) => result.value))
    await new Promise(resolve => setImmediate(resolve))
    expect(errors).not.toHaveBeenCalled()
    expect(f.frontend.readiness).toBe(ready)
    expect(f.owner.record.request_epoch).toBe(2)
    expect(f.requests).toHaveLength(2)
  })

  it.each(["cancel", "replacement"])("owns async SDK retry-start native %s through factory mode subscription", async action => {
    const command = vi.fn()
    const f = await frontendFixture({ retry: true, register: pi => pi.registerCommand("owned", { handler: command }) })
    await f.bind()
    let control: Promise<void> | undefined
    const { native, mode } = retrySubscription(f, () => {
      control = native.runInAsyncScope(() => action === "cancel" ? mode.session.abort() : mode.session.prompt("/owned replacement"))
      return control
    })
    await f.session.prompt("old native retry")
    expect(control).toBeDefined()
    await control
    expect(f.session.retryAttempt).toBe(0)
    expect(f.session.isRetrying).toBe(false)
    expect(f.requests).toHaveLength(1)
    expect(command).toHaveBeenCalledTimes(action === "replacement" ? 1 : 0)
    expect(f.owner.record.request_epoch).toBe(action === "replacement" ? 2 : 1)
    expect(f.frontend.readiness).not.toBeNull()
  })

  it.each(["cancel", "close", "unsubscribe"])("drops async SDK retry observer fault after its own %s", async action => {
    const f = await frontendFixture({ retry: true })
    await f.bind()
    const errors = vi.fn()
    cleanup.push(f.session.extensionRunner!.onError(errors))
    let reject!: (error: Error) => void
    const barrier = new Promise<void>((_resolve, fail) => { reject = fail })
    barrier.catch(() => {})
    cleanup.push(() => reject(new Error("synthetic retired native observer failure")))
    const { mode } = retrySubscription(f, () => barrier)
    await f.session.prompt("current native retry")
    expect(mode.handleEvent.mock.calls.some(([event]: any[]) => event.type === "auto_retry_start")).toBe(true)
    expect(f.requests).toHaveLength(2)
    const ready = f.frontend.readiness
    if (action === "cancel") await f.frontend.cancelInput()
    else if (action === "close") await f.frontend.close()
    else mode.unsubscribe()
    reject(new Error("synthetic retired native observer failure"))
    await Promise.allSettled(mode.handleEvent.mock.results.map((result: any) => result.value))
    await new Promise(resolve => setImmediate(resolve))
    expect(errors).not.toHaveBeenCalled()
    expect(f.frontend.readiness).toBe(action === "close" ? null : ready)
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.requests).toHaveLength(2)
  })

  it.each(["message", "string", "stack"])("cannot publish async SDK observer fault after %s formatting reenters newer native input", async field => {
    const command = vi.fn()
    const f = await frontendFixture({ retry: true, register: pi => pi.registerCommand("owned", { handler: command }) })
    await f.bind()
    const errors = vi.fn()
    cleanup.push(f.session.extensionRunner!.onError(errors))
    let replacement: Promise<void> | undefined
    const reenter = () => {
      replacement = native.runInAsyncScope(() => f.session.prompt("/owned replacement"))
      replacement!.catch(() => {})
      return "synthetic reentrant formatted observer fault"
    }
    const failure = field === "message" ? { get message() { return reenter() } }
      : field === "string" ? { message: { [Symbol.toPrimitive]: reenter } }
        : { message: "synthetic native observer fault", get stack() { return reenter() } }
    const { native } = retrySubscription(f, async () => { throw failure })
    await f.session.prompt("old native retry")
    expect(replacement).toBeDefined()
    await replacement
    expect(command).toHaveBeenCalledTimes(1)
    expect(f.owner.record.request_epoch).toBe(2)
    expect(f.frontend.readiness).not.toBeNull()
    expect(f.requests).toHaveLength(1)
    expect(f.session.retryAttempt).toBe(0)
    expect(errors).not.toHaveBeenCalled()
  })

  it("reports unreadable async SDK observer fault details as an owning failure", async () => {
    const f = await frontendFixture({ retry: true })
    await f.bind()
    const errors = vi.fn()
    cleanup.push(f.session.extensionRunner!.onError(errors))
    retrySubscription(f, async () => { throw { get message() { throw new Error("synthetic unreadable fault details") } } })
    await f.session.prompt("current native retry")
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.objectContaining({
      event: "auto_retry_start", error: "Retry-start observer failed; fault details unavailable",
    })), { timeout: 500 })
    expect(f.frontend.readiness).toBeNull()
    expect(f.requests).toHaveLength(1)
    expect(f.session.retryAttempt).toBe(0)
    expect(f.session.isRetrying).toBe(false)
  })

  function interactiveConfiguration(f: Awaited<ReturnType<typeof frontendFixture>>) {
    initTheme("dark", false)
    const previousKeys = getKeybindings()
    // Actual public TUI key manager, task-owned app binding matching SDK0.73.0.
    // Prototype fixtures do not run SDK constructor/config or terminal startup.
    setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS,
      "app.models.save": { defaultKeys: "ctrl+s", description: "Synthetic SDK save" } }))
    cleanup.push(() => setKeybindings(previousKeys))
    Object.assign(f.modelRegistry, { refresh: vi.fn(), getError: () => undefined })
    const children: any[] = []
    const mode = Object.assign(Object.create(InteractiveMode.prototype), {
      runtimeHost: createPiRequestModeRuntime(f.frontend),
      keybindings: getKeybindings(),
      ui: { requestRender: vi.fn(), setFocus: vi.fn(), invalidate: vi.fn(), setShowHardwareCursor: vi.fn(), setClearOnShrink: vi.fn() },
      footer: { invalidate: vi.fn(), setAutoCompactEnabled: vi.fn() },
      footerDataProvider: { setAvailableProviderCount: vi.fn() },
      editor: { setText: vi.fn(), getText: vi.fn(() => ""), onAction: vi.fn() },
      editorContainer: { clear: vi.fn(() => children.splice(0)), addChild: vi.fn(x => children.push(x)) },
      chatContainer: { addChild: vi.fn(), children: [], clear: vi.fn() },
      setupAutocompleteProvider: vi.fn(), rebuildChatFromMessages: vi.fn(),
      showStatus: vi.fn(), showError: vi.fn(), showWarning: vi.fn(), updateEditorBorderColor: vi.fn(),
      maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(), checkDaxnutsEasterEgg: vi.fn(),
    })
    mode.defaultEditor = mode.editor
    mode.feedback = { showStatus: mode.showStatus, showError: mode.showError,
      chatAdd: mode.chatContainer.addChild, footerInvalidate: mode.footer.invalidate,
      footerAuto: mode.footer.setAutoCompactEnabled,
      requestRender: mode.ui.requestRender, editorText: mode.editor.setText }
    requestMode.installPiInteractiveConfiguration(mode, f.frontend.interactiveGesture)
    return { mode, children }
  }

  it.each(["/settings", "/scoped-models"])("captures actual native %s submit before clear, display or registry writes", async command => {
    const f = await frontendFixture({ parked: true })
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    mode.setupEditorSubmitHandler()
    const opened = mode.defaultEditor.onSubmit(command)
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(children).toHaveLength(0)
    expect(mode.feedback.editorText).not.toHaveBeenCalled()
    expect(f.modelRegistry.refresh).not.toHaveBeenCalled()
    f.approve()
    await opened
    expect(children[0]).toBeDefined()
    expect(children[0]).not.toBe(mode.editor)
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.requests).toHaveLength(0)
  })

  it("guards actual settings input before local success and permits only current synchronous mutation", async () => {
    const f = await frontendFixture()
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    await mode.showSettingsSelector()
    const list = children[0].getSettingsList()
    const item = list.items.find((item: any) => item.id === "autocompact")
    list.selectedIndex = list.filteredItems.indexOf(item)
    f.setLive(pending)
    const changed = list.handleInput("\r")
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(item.currentValue).toBe("false")
    expect(f.session.autoCompactionEnabled).toBe(false)
    f.approve()
    await changed
    expect(item.currentValue).toBe("true")
    expect(f.session.autoCompactionEnabled).toBe(true)
    expect(f.owner.record.request_epoch).toBe(1)
    await f.frontend.configuration({ type: "set_session_name", name: "newer settings owner" })
    await list.handleInput("\r")
    await list.onChange("autocompact", "false")
    expect(f.session.autoCompactionEnabled).toBe(true)
    expect(children).toEqual([mode.editor])
  })

  it("guards actual settings submenu and cancels its parked selection using native Escape", async () => {
    const f = await frontendFixture({ reasoning: true })
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    await mode.showSettingsSelector()
    const list = children[0].getSettingsList()
    const item = list.items.find((item: any) => item.id === "thinking")
    list.selectedIndex = list.filteredItems.indexOf(item)
    await list.handleInput("\r")
    await list.handleInput("\u001b[B")
    const oldCallback = list.submenuComponent.selectList.onSelect
    f.setLive(pending)
    const changed = list.handleInput("\r")
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(f.session.thinkingLevel).toBe("off")
    await list.handleInput("\u001b")
    await changed
    expect(children).toEqual([mode.editor])
    expect(f.owner.record.request).toMatchObject({ phase: "cancelled", reason: "cancelled" })
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    f.approve()
    await oldCallback({ value: "medium" })
    expect(f.session.thinkingLevel).toBe("off")
    expect(f.owner.record.request.consumed_approval_ids).toEqual([])
    expect(f.frontend.readiness).not.toBeNull()
  })

  it("awaits actual scoped-model callback before local UI confirmation and native save", async () => {
    let models: any[] = []
    let release!: (models: any[]) => void
    const available = vi.fn((): any => models)
    const f = await frontendFixture({ availableModels: available })
    await f.bind()
    const model = JSON.parse(JSON.stringify(f.session.model))
    models = [model, { ...model, id: "synthetic-second", name: "Second" }]
    const { mode, children } = interactiveConfiguration(f)
    await mode.showModelsSelector()
    const selector = children[0]
    available.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const changed = selector.handleInput("\r")
    await vi.waitFor(() => expect(release).toBeTypeOf("function"), { timeout: 500 })
    expect(selector.enabledIds).toBeNull()
    expect(selector.isDirty).toBe(false)
    expect(f.session.scopedModels).toEqual([])
    release(models)
    await changed
    expect(selector.enabledIds).toEqual([`${model.provider}/${model.id}`])
    expect(selector.isDirty).toBe(true)
    expect(f.session.scopedModels).toHaveLength(1)
    await selector.handleInput("\u0013")
    expect(f.session.settingsManager.getEnabledModels()).toEqual(selector.enabledIds)
    expect(selector.isDirty).toBe(false)
    expect(mode.feedback.showStatus).toHaveBeenCalledWith("Model selection saved to settings")
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.requests).toHaveLength(0)
  })

  it("denies old scoped-model awaited mutation and captured persist after replacement input", async () => {
    let models: any[] = []
    let release!: (models: any[]) => void
    const available = vi.fn((): any => models)
    const f = await frontendFixture({ availableModels: available })
    await f.bind()
    const model = JSON.parse(JSON.stringify(f.session.model))
    models = [model, { ...model, id: "synthetic-second" }]
    const { mode, children } = interactiveConfiguration(f)
    await mode.showModelsSelector()
    const old = children[0]
    const persist = old.callbacks.onPersist
    available.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const changed = old.handleInput("\r")
    await vi.waitFor(() => expect(release).toBeTypeOf("function"), { timeout: 500 })
    await f.frontend.configuration({ type: "set_session_name", name: "new scoped owner" })
    release(models)
    await changed
    await persist([`${model.provider}/${model.id}`])
    expect(f.session.scopedModels).toEqual([])
    expect(f.session.settingsManager.getEnabledModels()).toBeUndefined()
    expect(mode.feedback.showStatus).not.toHaveBeenCalled()
    expect(mode.feedback.showError).not.toHaveBeenCalled()
    expect(children).toEqual([mode.editor])
    expect(f.owner.record.request_epoch).toBe(2)
  })

  it("restores actual settings local value after a genuine current mutation failure", async () => {
    const f = await frontendFixture()
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    await mode.showSettingsSelector()
    const list = children[0].getSettingsList()
    const item = list.items.find((item: any) => item.id === "autocompact")
    list.selectedIndex = list.filteredItems.indexOf(item)
    vi.spyOn(f.session, "setAutoCompactionEnabled").mockImplementation(() => { throw new Error("synthetic settings failure") })
    await list.handleInput("\r")
    expect(item.currentValue).toBe("false")
    expect(f.session.autoCompactionEnabled).toBe(false)
    expect(mode.feedback.showError).toHaveBeenCalledWith("synthetic settings failure")
    expect(f.owner.record.request_epoch).toBe(1)
  })

  it("restores actual nested warning failure, reopen and next successful toggle", async () => {
    const f = await frontendFixture()
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    await mode.showSettingsSelector()
    const list = children[0].getSettingsList()
    const item = list.items.find((item: any) => item.id === "warnings")
    list.selectedIndex = list.filteredItems.indexOf(item)
    await list.handleInput("\r")
    const submenu = list.submenuComponent
    const persist = vi.spyOn(f.session.settingsManager, "setWarnings")
      .mockImplementationOnce(() => { throw new Error("synthetic warning failure") })
    await list.handleInput("\r")
    expect(mode.feedback.showError).toHaveBeenCalledWith("synthetic warning failure")
    expect(submenu.settingsList.items[0].currentValue).toBe("true")
    expect(submenu.state.anthropicExtraUsage ?? true).toBe(true)
    expect(f.session.settingsManager.getWarnings().anthropicExtraUsage ?? true).toBe(true)
    await list.handleInput("\u001b")
    await list.handleInput("\r")
    expect(list.submenuComponent.settingsList.items[0].currentValue).toBe("true")
    expect(list.submenuComponent.state.anthropicExtraUsage ?? true).toBe(true)
    await list.handleInput("\r")
    expect(persist).toHaveBeenCalledTimes(2)
    expect(f.session.settingsManager.getWarnings().anthropicExtraUsage).toBe(false)
    expect(list.submenuComponent.settingsList.items[0].currentValue).toBe("false")
    expect(list.submenuComponent.state.anthropicExtraUsage).toBe(false)
    await list.handleInput("\u001b")
    await list.handleInput("\r")
    expect(list.submenuComponent.settingsList.items[0].currentValue).toBe("false")
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.requests).toHaveLength(0)
  })

  it("preserves actual settings submenu back and performs only current successful selection", async () => {
    const f = await frontendFixture({ reasoning: true })
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    await mode.showSettingsSelector()
    const list = children[0].getSettingsList()
    const item = list.items.find((item: any) => item.id === "thinking")
    list.selectedIndex = list.filteredItems.indexOf(item)
    await list.handleInput("\r")
    await list.handleInput("\u001b[B")
    await list.handleInput("\u001b")
    expect(list.submenuComponent).toBeNull()
    expect(f.session.thinkingLevel).toBe("off")
    expect(children[0]).not.toBe(mode.editor)
    await list.handleInput("\r")
    await list.handleInput("\u001b[B")
    await list.handleInput("\r")
    expect(f.session.thinkingLevel).toBe("minimal")
    expect(item.currentValue).toBe("minimal")
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.requests).toHaveLength(0)
  })

  it("dismisses actual scoped-model registry wait with Escape and denies late native save", async () => {
    let models: any[] = []
    let release!: (models: any[]) => void
    const available = vi.fn((): any => models)
    const f = await frontendFixture({ availableModels: available })
    await f.bind()
    const model = JSON.parse(JSON.stringify(f.session.model))
    models = [model, { ...model, id: "synthetic-second" }]
    const { mode, children } = interactiveConfiguration(f)
    await mode.showModelsSelector()
    const old = children[0]
    available.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const changed = old.handleInput("\r")
    await vi.waitFor(() => expect(release).toBeTypeOf("function"), { timeout: 500 })
    await old.handleInput("\u001b")
    expect(f.owner.record.request).toMatchObject({ phase: "cancelled", reason: "cancelled" })
    release(models)
    await changed
    await old.handleInput("\u0013")
    expect(f.session.scopedModels).toEqual([])
    expect(f.session.settingsManager.getEnabledModels()).toBeUndefined()
    expect(children).toEqual([mode.editor])
    expect(mode.feedback.showStatus).not.toHaveBeenCalled()
    expect(mode.feedback.showError).not.toHaveBeenCalled()
    expect(f.frontend.readiness).not.toBeNull()
  })

  it("keeps actual applied settings truth after deferred UI publication fails", async () => {
    const f = await frontendFixture()
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    await mode.showSettingsSelector()
    const list = children[0].getSettingsList()
    const item = list.items.find((item: any) => item.id === "autocompact")
    list.selectedIndex = list.filteredItems.indexOf(item)
    mode.feedback.footerAuto.mockImplementation(() => { throw new Error("synthetic footer render failure") })
    await list.handleInput("\r")
    expect(f.session.autoCompactionEnabled).toBe(true)
    expect(item.currentValue).toBe("true")
    expect(mode.feedback.showError).toHaveBeenCalledWith("synthetic footer render failure")
    expect(f.owner.record.request_epoch).toBe(1)
  })

  it("rechecks actual scoped-model authority after registry wait before native scope mutation", async () => {
    let models: any[] = []
    let release!: (models: any[]) => void
    const available = vi.fn((): any => models)
    const f = await frontendFixture({ availableModels: available })
    await f.bind()
    const model = JSON.parse(JSON.stringify(f.session.model))
    models = [model, { ...model, id: "synthetic-second" }]
    const { mode, children } = interactiveConfiguration(f)
    await mode.showModelsSelector()
    const selector = children[0]
    available.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const changed = selector.handleInput("\r")
    await vi.waitFor(() => expect(release).toBeTypeOf("function"), { timeout: 500 })
    f.setLive(pending)
    release(models)
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(f.session.scopedModels).toEqual([])
    expect(selector.enabledIds).toBeNull()
    expect(selector.isDirty).toBe(false)
    f.approve()
    await changed
    expect(f.session.scopedModels).toHaveLength(1)
    expect(selector.enabledIds).toHaveLength(1)
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(1)
  })

  it("rechecks actual scoped-model display after saved-pattern registry wait before opening UI", async () => {
    let models: any[] = []
    let release!: (models: any[]) => void
    const available = vi.fn((): any => models)
    const f = await frontendFixture({ availableModels: available })
    await f.bind()
    const model = JSON.parse(JSON.stringify(f.session.model))
    models = [model, { ...model, id: "synthetic-second" }]
    f.session.settingsManager.setEnabledModels([`${model.provider}/${model.id}`])
    available.mockImplementationOnce(() => models).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const { mode, children } = interactiveConfiguration(f)
    const opened = mode.showModelsSelector()
    await vi.waitFor(() => expect(release).toBeTypeOf("function"), { timeout: 500 })
    f.setLive(pending)
    release(models)
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(children).toHaveLength(0)
    f.approve()
    await opened
    expect(children[0]).not.toBe(mode.editor)
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.requests).toHaveLength(0)
  })

  it("admits owning interactive name before native mutation and successful UI feedback", async () => {
    const f = await frontendFixture({ parked: true })
    await f.bind()
    const { mode } = interactiveConfiguration(f)
    const changed = mode.handleNameCommand("/name approved interactive name")
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(f.sessionManager.getSessionName()).toBeUndefined()
    expect(mode.feedback.chatAdd).not.toHaveBeenCalled()
    f.approve()
    await changed
    expect(f.sessionManager.getSessionName()).toBe("approved interactive name")
    expect(mode.feedback.chatAdd).toHaveBeenCalledTimes(2)
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.requests).toHaveLength(0)
  })

  it("admits actual interactive thinking/model cycle helpers without Promise-shaped success", async () => {
    const f = await frontendFixture()
    await f.bind()
    const { mode } = interactiveConfiguration(f)
    await mode.cycleThinkingLevel()
    expect(mode.feedback.showStatus).toHaveBeenCalledWith("Current model does not support thinking")
    await mode.cycleModel("forward")
    expect(mode.feedback.showStatus).toHaveBeenCalledWith("Only one model available")
    expect(f.owner.record.request_epoch).toBe(2)
    expect(mode.feedback.showError).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
  })

  it("captures interactive model search before registry await and never publishes its stale result", async () => {
    let release!: (models: any[]) => void
    const available = vi.fn(() => new Promise<any[]>(resolve => { release = resolve }))
    const f = await frontendFixture({ availableModels: available })
    await f.bind()
    const { mode } = interactiveConfiguration(f)
    const modelEntries = f.sessionManager.getEntries().filter((entry: any) => entry.type === "model_change")
    const searched = mode.handleModelCommand("synthetic-chat")
    await vi.waitFor(() => expect(available).toHaveBeenCalled(), { timeout: 500 })
    expect(f.owner.record.request_epoch).toBe(1)
    await f.frontend.configuration({ type: "set_session_name", name: "newer search owner" })
    release([f.session.model])
    await searched
    expect(f.owner.record.request_epoch).toBe(2)
    expect(mode.feedback.showStatus).not.toHaveBeenCalled()
    expect(mode.feedback.showError).not.toHaveBeenCalled()
    expect(mode.feedback.footerInvalidate).not.toHaveBeenCalled()
    expect(f.sessionManager.getEntries().filter((entry: any) => entry.type === "model_change")).toEqual(modelEntries)
  })

  it("captures native model selector before construction and guards its pre-callback default write", async () => {
    const f = await frontendFixture({ parked: true })
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    const opened = mode.showModelSelector()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(children).toHaveLength(0)
    expect(f.modelRegistry.refresh).not.toHaveBeenCalled()
    f.approve()
    await opened
    const selector = children[0]
    expect(selector).toBeDefined()
    const save = vi.spyOn(f.session.settingsManager, "setDefaultModelAndProvider")
    await selector.handleSelect(f.session.model)
    // Native selector and native Session.setModel each persist the default.
    expect(save).toHaveBeenCalledTimes(2)
    expect(mode.feedback.showStatus).toHaveBeenCalledWith("Model: synthetic-chat")
    expect(children).toEqual([mode.editor])
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.requests).toHaveLength(0)
  })

  it("revokes only old selector and denies old selection/default/render after newer native input", async () => {
    const f = await frontendFixture()
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    await mode.showModelSelector()
    const old = children[0]
    await mode.showModelSelector()
    const current = children[0]
    expect(current).not.toBe(old)
    const save = vi.spyOn(f.session.settingsManager, "setDefaultModelAndProvider")
    mode.feedback.requestRender.mockClear()
    await old.handleSelect(f.session.model)
    await old.onSelectCallback(f.session.model)
    await old.onCancelCallback()
    expect(save).not.toHaveBeenCalled()
    expect(children).toEqual([current])
    expect(mode.feedback.requestRender).not.toHaveBeenCalled()
    expect(mode.feedback.showError).not.toHaveBeenCalled()
    await current.handleSelect(f.session.model)
    expect(save).toHaveBeenCalledTimes(2)
    expect(children).toEqual([mode.editor])
    expect(f.owner.record.request_epoch).toBe(2)
  })

  it("keeps model selector registry rendering bound to its original gesture after await", async () => {
    let release!: (models: any[]) => void
    const available = vi.fn(() => new Promise<any[]>(resolve => { release = resolve }))
    const f = await frontendFixture({ availableModels: available })
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    await mode.showModelSelector()
    expect(children[0]).not.toBe(mode.editor)
    await f.frontend.configuration({ type: "set_session_name", name: "newer selector owner" })
    mode.feedback.requestRender.mockClear()
    release([f.session.model])
    await new Promise(resolve => setImmediate(resolve))
    expect(mode.feedback.requestRender).not.toHaveBeenCalled()
    expect(children).toEqual([mode.editor])
    expect(f.owner.record.request_epoch).toBe(2)
  })

  it("dismisses exact interactive selector retaining journal and denying late callbacks", async () => {
    const f = await frontendFixture({ parked: true })
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    const opened = mode.showModelSelector()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    f.approve()
    await opened
    const selector = children[0]
    const save = vi.spyOn(f.session.settingsManager, "setDefaultModelAndProvider")
    await selector.onCancelCallback()
    await selector.handleSelect(f.session.model)
    expect(f.owner.record.request).toMatchObject({ phase: "cancelled", reason: "cancelled" })
    expect(save).not.toHaveBeenCalled()
    expect(children).toEqual([mode.editor])
    expect(f.frontend.readiness).not.toBeNull()
    // Admission consumed/cleared the synthetic approval before opening. Dismiss
    // does not perform an additional journal clear or approval consumption.
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(1)
    expect(f.owner.record.request.consumed_approval_ids).toHaveLength(1)
  })

  it("cannot borrow interactive gesture admission from a project callback", async () => {
    let invoke!: () => Promise<unknown>
    let f!: Awaited<ReturnType<typeof frontendFixture>>
    f = await frontendFixture({ register: (pi, ownership) => {
      pi.registerCommand("capture-interactive", { handler: () => {
        invoke = ownership.bind(() => f.frontend.interactiveGesture("/name forged", () => f.session.setSessionName("forged")))
      } })
    } })
    await f.bind()
    await f.session.prompt("/capture-interactive")
    await expect(invoke()).rejects.toThrow("Native interactive input unavailable")
    expect(f.sessionManager.getSessionName()).toBeUndefined()
    expect(f.owner.record.request_epoch).toBe(1)
  })

  it("parks native selector before its default write and exposes pending selection to Escape cancellation", async () => {
    const f = await frontendFixture()
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    await mode.showModelSelector()
    const selector = children[0]
    const save = vi.spyOn(f.session.settingsManager, "setDefaultModelAndProvider")
    f.setLive(pending)
    const selected = selector.handleSelect(f.session.model)
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(save).not.toHaveBeenCalled()
    expect(mode.session.isStreaming).toBe(true)
    await f.frontend.cancelInput()
    await selected
    expect(f.frontend.inputPending).toBe(false)
    expect(save).not.toHaveBeenCalled()
    expect(mode.feedback.showStatus).not.toHaveBeenCalled()
    expect(children).toEqual([mode.editor])
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(0)
    expect(f.owner.record.request).toMatchObject({ phase: "cancelled", reason: "cancelled" })
    expect(f.frontend.readiness).not.toBeNull()
    f.approve()
    await selector.handleSelect(f.session.model)
    expect(save).not.toHaveBeenCalled()
    expect(f.owner.record.request.consumed_approval_ids).toEqual([])
  })

  it("permits only one native selector selection even while its checkpoint waits", async () => {
    const f = await frontendFixture()
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    await mode.showModelSelector()
    const selector = children[0]
    const save = vi.spyOn(f.session.settingsManager, "setDefaultModelAndProvider")
    f.setLive(pending)
    const first = selector.handleSelect(f.session.model)
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    await selector.handleSelect(f.session.model)
    expect(save).not.toHaveBeenCalled()
    f.approve()
    await first
    expect(save).toHaveBeenCalledTimes(2)
    expect(mode.feedback.showStatus).toHaveBeenCalledTimes(1)
    expect(children).toEqual([mode.editor])
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(1)
  })

  it.each(["/model", "/name submitted name"])("owns actual SDK editor submit %s before editor clear or configuration effects", async text => {
    const f = await frontendFixture({ parked: true })
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    mode.setupEditorSubmitHandler()
    const submitted = mode.defaultEditor.onSubmit(text)
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(mode.feedback.editorText).not.toHaveBeenCalled()
    expect(mode.feedback.chatAdd).not.toHaveBeenCalled()
    expect(f.modelRegistry.refresh).not.toHaveBeenCalled()
    f.approve()
    await submitted
    expect(mode.feedback.editorText).toHaveBeenCalledWith("")
    expect(f.owner.record.request_epoch).toBe(1)
    if (text === "/model") expect(children[0]).not.toBe(mode.editor)
    else expect(f.sessionManager.getSessionName()).toBe("submitted name")
    expect(f.requests).toHaveLength(0)
  })

  it("admits actual SDK configuration key handlers and preserves genuine current errors", async () => {
    const f = await frontendFixture()
    await f.bind()
    const { mode } = interactiveConfiguration(f)
    mode.setupKeyHandlers()
    const action = mode.defaultEditor.onAction.mock.calls.find(([name]: [string]) => name === "app.thinking.cycle")[1]
    await action()
    expect(f.owner.record.request_epoch).toBe(1)
    expect(mode.feedback.showStatus).toHaveBeenCalledWith("Current model does not support thinking")
    vi.spyOn(f.sessionManager, "appendSessionInfo").mockImplementation(() => { throw new Error("synthetic native persistence unavailable") })
    await mode.handleNameCommand("/name failed persistence")
    expect(mode.feedback.showError).toHaveBeenCalledWith("synthetic native persistence unavailable")
    expect(mode.feedback.chatAdd).not.toHaveBeenCalled()
    expect(f.owner.record.request_epoch).toBe(2)
    expect(f.frontend.readiness).not.toBeNull()
  })

  it("retires exact old model-selector UI lease when a different native selector replaces it", async () => {
    let release!: (models: any[]) => void
    const f = await frontendFixture({ availableModels: () => new Promise<any[]>(resolve => { release = resolve }) })
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    await mode.showModelSelector()
    const old = children[0]
    const other = { name: "other native selector" }
    mode.showSelector(() => ({ component: other, focus: other }))
    const save = vi.spyOn(f.session.settingsManager, "setDefaultModelAndProvider")
    mode.feedback.requestRender.mockClear()
    release([f.session.model])
    await new Promise(resolve => setImmediate(resolve))
    await old.handleSelect(f.session.model)
    await old.onSelectCallback(f.session.model)
    await old.onCancelCallback()
    expect(save).not.toHaveBeenCalled()
    expect(mode.feedback.requestRender).not.toHaveBeenCalled()
    await f.frontend.cancelInput()
    expect(children).toEqual([other])
    expect(f.owner.record.request_epoch).toBe(1)
  })

  it.each([["Escape", "\u001b"], ["Ctrl+C", "\u0003"]])("dismisses a selector selection already parked via actual SDK %s without waiting for human approval", async (_, key) => {
    const f = await frontendFixture()
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    await mode.showModelSelector()
    const selector = children[0]
    const save = vi.spyOn(f.session.settingsManager, "setDefaultModelAndProvider")
    f.setLive(pending)
    const selection = selector.handleSelect(f.session.model)
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    selector.handleInput(key)
    await vi.waitFor(() => expect(f.owner.record.request).toMatchObject({ phase: "cancelled", reason: "cancelled" }), { timeout: 500 })
    await selection
    expect(children).toEqual([mode.editor])
    expect(f.frontend.inputPending).toBe(false)
    expect(save).not.toHaveBeenCalled()
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(0)
    expect(f.owner.record.request.consumed_approval_ids).toEqual([])
    expect(f.frontend.readiness).not.toBeNull()
    f.approve()
    await selector.onSelectCallback(f.session.model)
    await selector.handleSelect(f.session.model)
    expect(save).not.toHaveBeenCalled()
  })

  it("revokes selector replaced during checkpoint before stale default write or approval consumption", async () => {
    const f = await frontendFixture()
    await f.bind()
    const { mode, children } = interactiveConfiguration(f)
    await mode.showModelSelector()
    const old = children[0]
    const save = vi.spyOn(f.session.settingsManager, "setDefaultModelAndProvider")
    f.setLive(pending)
    const selection = old.handleSelect(f.session.model)
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    const other = { name: "newer selector during old checkpoint" }
    mode.showSelector(() => ({ component: other, focus: other }))
    f.approve()
    await selection
    expect(save).not.toHaveBeenCalled()
    expect(children).toEqual([other])
    expect(mode.feedback.showStatus).not.toHaveBeenCalled()
    expect(mode.feedback.showError).not.toHaveBeenCalled()
    expect(f.owner.record.request.consumed_approval_ids).toEqual([])
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(0)
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    await vi.waitFor(() => expect(f.owner.record.request).toMatchObject({ phase: "cancelled", reason: "cancelled" }), { timeout: 500 })
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.frontend.readiness).not.toBeNull()
  })

  it("cancels owning native parked input without consuming late approval and accepts only fresh input", async () => {
    const f = await frontendFixture({ parked: true })
    await f.bind()
    const input = f.session.prompt("cancelled native input")
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    await f.frontend.cancelInput()
    await input
    expect(f.owner.record.request).toMatchObject({ phase: "cancelled", reason: "cancelled" })
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    expect(f.frontend.readiness).not.toBeNull()
    f.approve()
    expect(f.requests).toHaveLength(0)
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(0)
    expect(f.owner.record.request.consumed_approval_ids).toEqual([])
    await f.session.prompt("fresh explicit input after cancellation")
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request_epoch).toBe(2)
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(1)
  })

  it("cancels owning native configuration before parked metadata mutation", async () => {
    const f = await frontendFixture({ parked: true })
    await f.bind()
    const before = f.sessionManager.getEntries()
    const changed = f.frontend.configuration({ type: "set_session_name", name: "cancelled native name" })
    void changed.catch(() => {})
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    await f.frontend.cancelInput()
    await expect(changed).rejects.toThrow("Native configuration request unavailable")
    f.approve()
    expect(f.sessionManager.getEntries()).toEqual(before)
    expect(f.requests).toHaveLength(0)
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    expect(f.owner.record.request.consumed_approval_ids).toEqual([])
  })

  it("cancels owning native input before SDK slash lookup reaches the private input hook", async () => {
    const f = await frontendFixture()
    await f.bind()
    const input = f.session.prompt("/missing-native-command")
    await f.frontend.cancelInput()
    await input
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.requests).toHaveLength(0)
    expect(f.frontend.readiness).not.toBeNull()
  })

  it("routes the actual native SDK Escape handler to parked owning-input cancellation", async () => {
    const f = await frontendFixture({ parked: true })
    await f.bind()
    // Actual SDK key-handler/queue restoration methods, no TUI process/global
    // terminal takeover. Headed editor/rendering acceptance remains separate.
    const editor = { onAction: vi.fn(), onEscape: null as any }
    const mode = Object.assign(Object.create(InteractiveMode.prototype), {
      runtimeHost: createPiRequestModeRuntime(f.frontend), defaultEditor: editor,
      ui: {}, compactionQueuedMessages: [], updatePendingMessagesDisplay: vi.fn(),
    })
    mode.setupKeyHandlers()
    const input = f.session.prompt("native Escape cancelled input")
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(f.session.isStreaming).toBe(false)
    expect(mode.session.isStreaming).toBe(true)
    editor.onEscape()
    await input
    await vi.waitFor(() => expect(f.owner.record.request.reason).toBe("cancelled"), { timeout: 500 })
    expect(f.frontend.inputPending).toBe(false)
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    expect(f.frontend.readiness).not.toBeNull()
    expect(f.requests).toHaveLength(0)
  })

  it("denies project inheritance of the owning native cancellation capability", async () => {
    let cancel!: () => Promise<unknown>
    let f!: Awaited<ReturnType<typeof frontendFixture>>
    f = await frontendFixture({ register: (pi, ownership) => {
      pi.registerCommand("capture-cancel", { handler: () => { cancel = ownership.bind(() => f.frontend.cancelInput()) } })
      pi.registerCommand("newer-cancel-owner", { handler: () => {} })
    } })
    await f.bind()
    await f.session.prompt("/capture-cancel")
    await expect(cancel()).rejects.toThrow("Native cancellation input unavailable")
    await f.session.prompt("/newer-cancel-owner")
    await expect(cancel()).rejects.toThrow("Native cancellation input unavailable")
    expect(f.owner.record.request).toMatchObject({ phase: "active", reason: null })
    expect(f.owner.record.request_epoch).toBe(2)
    expect(f.frontend.readiness).not.toBeNull()
  })

  it("cannot lend owning native cancellation to the SDK synthesized project shortcut context", async () => {
    let invocation: Promise<unknown> | null = null
    const f = await frontendFixture({ parked: true, register: pi => {
      pi.registerShortcut("f12", { handler: ctx => { invocation = ctx.abort(); return invocation } })
    } })
    await f.bind()
    const editor = { onExtensionShortcut: null as any }
    const mode = Object.assign(Object.create(InteractiveMode.prototype), {
      runtimeHost: createPiRequestModeRuntime(f.frontend), defaultEditor: editor,
      keybindings: { getEffectiveConfig: () => ({}) }, createExtensionUIContext: () => f.uiContext,
      showError: vi.fn(),
    })
    mode.setupExtensionShortcuts(f.session.extensionRunner)
    const input = f.session.prompt("shortcut cannot cancel native approval input")
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(editor.onExtensionShortcut("\u001b[24~")).toBe(true)
    await vi.waitFor(() => expect(invocation).not.toBeNull(), { timeout: 500 })
    await expect(invocation).rejects.toThrow("Native cancellation input unavailable")
    expect(f.owner.record.request.phase).toBe("parked")
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    expect(f.frontend.readiness).not.toBeNull()
    f.approve(); await input
  })

  it("seals native project shortcut registration including a callback captured before readiness", async () => {
    let late!: (...args: any[]) => unknown
    const f = await frontendFixture({ register: pi => { late = pi.registerShortcut } })
    await f.bind()
    expect(() => late("f12", { handler: () => {} })).toThrow("Managed hook registration is sealed")
    expect(f.frontend.readiness).toBeNull()
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.requests).toHaveLength(0)
  })

  it("does not abort newer streaming input when an older native cancellation finishes", async () => {
    let arrived!: () => void; let release!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    const f = await frontendFixture({ streaming: true })
    await f.bind()
    const original = f.controller.cancel.bind(f.controller)
    vi.spyOn(f.controller, "cancel").mockImplementation(async body => {
      const result = await original(body)
      arrived(); await barrier
      return result
    })
    const older = f.session.prompt("older streaming cancellation owner")
    void older.catch(() => {})
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 500 })
    const signal = f.session.agent.signal!
    const cancelled = f.frontend.cancelInput()
    await arrival
    await older
    expect(signal.aborted).toBe(true)
    const newer = f.session.prompt("newer streaming input")
    void newer.catch(() => {})
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 500 })
    const replacement = f.session.agent.signal!
    release(); await cancelled
    expect(replacement).not.toBe(signal)
    expect(replacement.aborted).toBe(false)
    expect(f.frontend.inputPending).toBe(true)
    expect(f.frontend.readiness).not.toBeNull()
    await f.frontend.close()
    await newer
  })

  it("rejects a cancelled native model selection after its registry await without clearing newer pending visibility", async () => {
    let release!: (models: any[]) => void; let read!: () => void
    const reading = new Promise<void>(resolve => { read = resolve })
    const available = new Promise<any[]>(resolve => { release = resolve })
    const f = await frontendFixture({ streaming: true, availableModels: () => { read(); return available } })
    await f.bind()
    const previous = f.session.model
    const change = f.frontend.configuration({ type: "set_model", provider: previous.provider, modelId: "cancelled-selection" })
    void change.catch(() => {})
    await reading
    await f.frontend.cancelInput()
    const newer = f.session.prompt("newer pending native selection owner")
    void newer.catch(() => {})
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 500 })
    release([{ ...previous, id: "cancelled-selection" }])
    await expect(change).rejects.toThrow("Project request unavailable")
    expect(f.session.model).toBe(previous)
    expect(f.frontend.inputPending).toBe(true)
    expect(f.session.agent.signal!.aborted).toBe(false)
    await f.frontend.close()
    await newer
  })

  it.each([false, true])("handles only obsolete owned denial after native cancellation during awaited SDK callback (declared effect %s)", async effect => {
    let arrived!: () => void; let release!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    const subsequent = vi.fn()
    const f = await frontendFixture({ register: pi => {
      pi.on("before_agent_start", async () => {
        if (effect) { await dispatchPiProjectEffect(async () => { arrived(); await barrier }); subsequent() }
        else { arrived(); await barrier }
      })
    } })
    await f.bind()
    const input = f.session.prompt("cancelled awaited native SDK callback")
    void input.catch(() => {})
    await arrival
    await f.frontend.cancelInput()
    release()
    await input
    expect(f.requests).toHaveLength(0)
    expect(subsequent).not.toHaveBeenCalled()
    expect(f.owner.record.request).toMatchObject({ phase: "cancelled", reason: "cancelled" })
    expect(f.frontend.readiness).not.toBeNull()
  })

  it("admits a native RPC configuration gesture without allowing raw SDK mutation or inference", async () => {
    const f = await frontendFixture()
    await f.bind()
    const before = f.sessionManager.getEntries()
    expect(() => f.session.setSessionName("unowned")).toThrow("Native configuration request unavailable")
    await f.frontend.configuration({ type: "set_session_name", name: "native RPC name" })
    expect(f.sessionManager.getSessionName()).toBe("native RPC name")
    expect(f.sessionManager.getEntries().length).toBeGreaterThan(before.length)
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.requests).toHaveLength(0)
  })

  it("parks a native RPC configuration input before metadata mutation and consumes only its private release", async () => {
    const f = await frontendFixture({ parked: true })
    await f.bind()
    const before = f.sessionManager.getEntries()
    const changed = f.frontend.configuration({ type: "set_session_name", name: "approved native name" })
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(f.sessionManager.getEntries()).toEqual(before)
    expect(f.sessionManager.getSessionName()).not.toBe("approved native name")
    expect(f.requests).toHaveLength(0)
    f.approve()
    await changed
    expect(f.sessionManager.getSessionName()).toBe("approved native name")
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(1)
  })

  it("captures native RPC model input before registry lookup and rejects its superseded selection", async () => {
    let release!: (models: any[]) => void
    let read!: () => void
    const reading = new Promise<void>(resolve => { read = resolve })
    const available = new Promise<any[]>(resolve => { release = resolve })
    const f = await frontendFixture({ availableModels: () => { read(); return available }, register: pi => {
      pi.registerCommand("replacement", { handler: () => {} })
    } })
    await f.bind()
    const previous = f.session.model
    const before = f.sessionManager.getEntries()
    const change = f.frontend.configuration({ type: "set_model", provider: previous.provider, modelId: "old-selection" })
    void change.catch(() => {})
    await reading
    expect(f.owner.record.request_epoch).toBe(1)
    await f.session.prompt("/replacement")
    release([{ ...previous, id: "old-selection" }])
    await expect(change).rejects.toThrow("Project request unavailable")
    expect(f.session.model).toBe(previous)
    expect(f.sessionManager.getEntries()).toEqual(before)
    expect(f.owner.record.request_epoch).toBe(2)
    expect(f.requests).toHaveLength(0)
  })

  it("cannot turn a project inherited call into a native RPC configuration gesture", async () => {
    let invoke!: () => Promise<unknown>
    let f: Awaited<ReturnType<typeof frontendFixture>>
    f = await frontendFixture({ register: (pi, ownership) => {
      pi.registerCommand("capture-native-capability", { handler: () => {
        invoke = ownership.bind(() => f.frontend.configuration({ type: "set_session_name", name: "borrowed input" }))
      } })
    } })
    await f.bind()
    await f.session.prompt("/capture-native-capability")
    const before = f.sessionManager.getEntries()
    await expect(invoke()).rejects.toThrow("Native configuration input unavailable")
    expect(f.sessionManager.getEntries()).toEqual(before)
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.owner.record.request.phase).toBe("active")
    expect(f.requests).toHaveLength(0)
  })

  it("rechecks native RPC model input after registry lookup when approval becomes pending", async () => {
    let release!: (models: any[]) => void
    let read!: () => void
    const reading = new Promise<void>(resolve => { read = resolve })
    const available = new Promise<any[]>(resolve => { release = resolve })
    const f = await frontendFixture({ availableModels: () => { read(); return available } })
    await f.bind()
    const previous = f.session.model
    const before = f.sessionManager.getEntries()
    const change = f.frontend.configuration({ type: "set_model", provider: previous.provider, modelId: "approved-selection" })
    await reading
    f.setLive(pending)
    release([{ ...previous, id: "approved-selection" }])
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(f.session.model).toBe(previous)
    expect(f.sessionManager.getEntries()).toEqual(before)
    f.approve()
    await change
    expect(f.session.model.id).toBe("approved-selection")
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(1)
    expect(f.requests).toHaveLength(0)
  })

  it("keeps the native RPC configuration payload immutable while parked", async () => {
    const f = await frontendFixture({ parked: true })
    await f.bind()
    const command = { type: "set_session_name", name: "original selection" }
    const change = f.frontend.configuration(command)
    command.name = "replacement value"
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    f.approve()
    await change
    expect(f.sessionManager.getSessionName()).toBe("original selection")
    expect(f.owner.record.request_epoch).toBe(1)
  })

  it("rejects an older parked native RPC gesture instead of adopting a newer configuration input", async () => {
    const f = await frontendFixture({ parked: true })
    await f.bind()
    const old = f.frontend.configuration({ type: "set_session_name", name: "obsolete selection" })
    void old.catch(() => {})
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    const current = f.frontend.configuration({ type: "set_session_name", name: "current selection" })
    await vi.waitFor(() => expect(f.owner.record.request_epoch).toBe(2), { timeout: 500 })
    await expect(old).rejects.toThrow("Native configuration request unavailable")
    expect(f.sessionManager.getSessionName()).not.toBe("obsolete selection")
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    f.approve()
    await current
    expect(f.sessionManager.getSessionName()).toBe("current selection")
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(1)
    expect(f.requests).toHaveLength(0)
  })

  it("disconnects a parked native RPC inlet without writing metadata or clearing its durable approval", async () => {
    const f = await frontendFixture({ parked: true })
    await f.bind()
    const before = f.sessionManager.getEntries()
    const source = new PassThrough()
    const output = vi.fn()
    let closing: Promise<unknown> | null = null
    const router = createPiRpcInput({ input: source, configuration: f.frontend.configuration, output,
      onDisconnect: () => { closing = f.frontend.close(); return closing } })
    cleanup.push(() => { router.close(); source.destroy(); router.input.destroy() })
    router.input.resume()
    await vi.waitFor(() => expect(source.listenerCount("data")).toBe(1))
    source.write('{"type":"set_session_name","id":"disconnect","name":"never written"}\n')
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    source.destroy()
    await vi.waitFor(() => expect(closing).not.toBeNull())
    await closing
    expect(f.owner.record.request.reason).toBe("disconnected")
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    expect(f.sessionManager.getEntries()).toEqual(before)
    expect(f.requests).toHaveLength(0)
    expect(output).not.toHaveBeenCalled()
    expect(f.frontend.readiness).toBeNull()
  })

  it("parks project model configuration before native model, history and settings writes", async () => {
    let change!: () => Promise<unknown>
    let f: Awaited<ReturnType<typeof frontendFixture>>
    const model = { id: "other-model", provider: "synthetic-provider", api: "openai-completions", reasoning: false }
    f = await frontendFixture({ register: (pi, ownership) => {
      pi.registerCommand("capture-model", { handler: () => { change = ownership.bind(() => pi.setModel({ ...f.session.model, ...model })) } })
    } })
    await f.bind()
    await f.session.prompt("/capture-model")
    const before = f.sessionManager.getEntries()
    const previous = f.session.model
    f.setLive(pending)
    const changed = change()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(f.session.model).toBe(previous)
    expect(f.sessionManager.getEntries()).toEqual(before)
    f.approve()
    await changed
    expect(f.session.model.id).toBe("other-model")
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(1)
    expect(f.requests).toHaveLength(0)
  })

  it("rejects a native model cycle before state mutation after its registry await is superseded", async () => {
    let cycle!: () => Promise<unknown>
    let release!: (models: any[]) => void
    let read!: () => void
    const reading = new Promise<void>(resolve => { read = resolve })
    const available = new Promise<any[]>(resolve => { release = resolve })
    let f: Awaited<ReturnType<typeof frontendFixture>>
    f = await frontendFixture({ availableModels: () => { read(); return available }, register: (pi, ownership) => {
      pi.registerCommand("capture-cycle", { handler: () => { cycle = ownership.bind(() => f.session.cycleModel()) } })
    } })
    await f.bind()
    await f.session.prompt("/capture-cycle")
    const previous = f.session.model
    const before = f.sessionManager.getEntries()
    const changed = cycle()
    void changed.catch(() => {})
    await reading
    await f.session.prompt("/capture-cycle")
    release([previous, { ...previous, id: "obsolete-model" }])
    await expect(changed).rejects.toThrow("Project request unavailable")
    expect(f.session.model).toBe(previous)
    expect(f.sessionManager.getEntries()).toEqual(before)
    expect(f.requests).toHaveLength(0)
  })

  it("checkpoints native model cycle after its registry await before any pending mutation", async () => {
    let cycle!: () => Promise<unknown>
    let release!: (models: any[]) => void
    let read!: () => void
    const reading = new Promise<void>(resolve => { read = resolve })
    const available = new Promise<any[]>(resolve => { release = resolve })
    let f: Awaited<ReturnType<typeof frontendFixture>>
    f = await frontendFixture({ availableModels: () => { read(); return available }, register: (pi, ownership) => {
      pi.registerCommand("pending-cycle", { handler: () => { cycle = ownership.bind(() => f.session.cycleModel()) } })
    } })
    await f.bind()
    await f.session.prompt("/pending-cycle")
    const previous = f.session.model
    const before = f.sessionManager.getEntries()
    const changed = cycle()
    await reading
    f.setLive(pending)
    release([previous, { ...previous, id: "released-model" }])
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(f.session.model).toBe(previous)
    expect(f.sessionManager.getEntries()).toEqual(before)
    f.approve()
    await changed
    expect(f.session.model.id).toBe("released-model")
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(1)
    expect(f.requests).toHaveLength(0)
  })

  it("denies native metadata and configuration outside a private admitted request", async () => {
    const f = await frontendFixture()
    await f.bind()
    const before = f.sessionManager.getEntries()
    const previous = f.session.model
    expect(() => f.sessionManager.appendCustomEntry("obsolete", { fixture: true })).toThrow("Native configuration request unavailable")
    expect(() => { f.session.agent.state.model = { ...previous, id: "unowned-model" } }).toThrow("Native configuration request unavailable")
    expect(f.session.model).toBe(previous)
    expect(f.sessionManager.getEntries()).toEqual(before)
  })

  it("supports immutable SDK model records while denying writable configuration aliases", async () => {
    let change!: () => Promise<unknown>
    let selected: any
    const f = await frontendFixture({ register: (pi, ownership) => {
      pi.registerCommand("immutable-model", { handler: () => { change = ownership.bind(() => pi.setModel(selected)) } })
    } })
    await f.bind()
    expect(f.session.modelRegistry.getAvailable()).toHaveLength(1) // public read stays synchronous
    selected = Object.freeze({ ...f.session.model, id: "immutable-model", input: Object.freeze(["text"]),
      cost: Object.freeze({ ...f.session.model.cost }) })
    await f.session.prompt("/immutable-model")
    await change()
    expect(f.session.model.cost).toEqual(selected.cost)
    expect(() => { f.session.model.cost.input = 100 }).toThrow("Native configuration view is read-only")
    expect(() => { f.session.agent.state.tools.push({} as any) }).toThrow("Native configuration view is read-only")
    await f.session.prompt("synthetic immutable-model request")
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].model).toBe("immutable-model")
  })

  it("does not expose raw model, cost or native tools setters through descriptors", async () => {
    const f = await frontendFixture()
    await f.bind()
    const previous = f.session.model.id
    const cost = f.session.model.cost.input
    const model = Object.getOwnPropertyDescriptor(f.session.agent.state, "model")!
    expect(() => { model.value.id = "unowned-descriptor" }).toThrow("Native configuration view is read-only")
    const tools = Object.getOwnPropertyDescriptor(f.session.agent.state, "tools")!
    expect(() => tools.set!([{ name: "unowned-tool" }])).toThrow("Native configuration request unavailable")
    const nested = Object.getOwnPropertyDescriptor(f.session.model, "cost")!
    expect(() => { nested.value.input = 999 }).toThrow("Native configuration view is read-only")
    expect(f.session.model.id).toBe(previous)
    expect(f.session.model.cost.input).toBe(cost)
    expect(f.session.getActiveToolNames()).toEqual([])
    expect(f.requests).toHaveLength(0)
  })

  it("does not grant SDK bootstrap mutation permission to project startup callbacks", async () => {
    let f: Awaited<ReturnType<typeof frontendFixture>>
    f = await frontendFixture({ register: pi => pi.on("session_start", () => {
      f.sessionManager.appendCustomEntry("unadmitted-project", { fixture: true })
    }) })
    const before = f.sessionManager.getEntries()
    await expect(f.bind()).rejects.toThrow("Owned SDK frontend unavailable")
    expect(f.sessionManager.getEntries()).toEqual(before)
    expect(f.frontend.readiness).toBe(null)
    expect(f.onReady).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
  })

  it.each(["registerProvider", "unregisterProvider"])("privately checkpoints runtime %s before registry mutation", async key => {
    const effects: Array<() => Promise<unknown>> = []
    const f = await frontendFixture({ register: (pi, ownership) => {
      pi.registerCommand("runtime-provider", { handler: () => effects.push(ownership.bind(() =>
        pi[key]("inert-runtime-provider", { streamSimple: () => isPiProjectManaged() }))) })
    } })
    await f.bind()
    await f.session.prompt("/runtime-provider")
    const mutate = f.modelRegistry[key as "registerProvider" | "unregisterProvider"]
    f.setLive(pending)
    const changed = effects[0]()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(mutate).not.toHaveBeenCalled()
    f.approve()
    await changed
    expect(mutate).toHaveBeenCalledTimes(1)
    await f.session.prompt("/runtime-provider")
    await expect(effects[0]()).rejects.toThrow("Project request unavailable")
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(f.requests).toHaveLength(0)
  })

  it("revokes SDK bootstrap permission from native continuations after binding", async () => {
    const f = await frontendFixture()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let late!: Promise<unknown>
    const original = f.session.extendResourcesFromExtensions.bind(f.session)
    vi.spyOn(f.session, "extendResourcesFromExtensions").mockImplementation((...args) => {
      late = held.then(() => f.session.setSessionName("obsolete bootstrap"))
      return original(...args)
    })
    await f.bind()
    const before = f.sessionManager.getEntries()
    release()
    await expect(late).rejects.toThrow("Native configuration request unavailable")
    expect(f.sessionManager.getEntries()).toEqual(before)
    expect(f.frontend.readiness).not.toBe(null)
    expect(f.requests).toHaveLength(0)
  })

  it.each([
    ["setThinkingLevel", ["off"], "setThinkingLevel"],
    ["setActiveTools", [[]], "setActiveToolsByName"],
    ["appendEntry", ["owned-fixture", {}], "appendCustomEntry"],
    ["setSessionName", ["owned fixture"], "setSessionName"],
    ["setLabel", ["missing-entry", "fixture"], "appendLabelChange"],
  ])("privately parks and rejects stale project %s mutations", async (key, args, nativeKey) => {
    const effects: Array<() => Promise<unknown>> = []
    const f = await frontendFixture({ register: (pi, ownership) => {
      pi.registerCommand("configuration", { handler: async () => {
        if (key === "setLabel") await pi.appendEntry("label-target", {})
        const values = key === "setLabel" ? [f.sessionManager.getEntries().at(-1)!.id, "fixture"] : args
        effects.push(ownership.bind(() => pi[key](...values)))
      } })
    } })
    await f.bind()
    await f.session.prompt("/configuration")
    const target = key === "appendEntry" || key === "setLabel" ? f.sessionManager : f.session
    const mutate = vi.spyOn(target as any, nativeKey as string)
    f.setLive(pending)
    const changed = effects[0]()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(mutate).not.toHaveBeenCalled()
    f.approve()
    await changed
    expect(mutate).toHaveBeenCalledTimes(1)
    await f.session.prompt("/configuration")
    await expect(effects[0]()).rejects.toThrow("Project request unavailable")
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(f.requests).toHaveLength(0)
  })

  async function docsFixture(response: () => Promise<Response> | Response) {
    const keys = ["STATEWRIGHT_ADAPTER_URL", "STATEWRIGHT_ADAPTER_TOKEN", "STATEWRIGHT_WORKFLOW", "STATEWRIGHT_EXECUTOR_ID"]
    const saved = keys.map(key => process.env[key])
    cleanup.push(() => {
      for (const [index, key] of keys.entries()) {
        if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]
      }
    })
    const effects: Array<() => Promise<any>> = []
    let f: Awaited<ReturnType<typeof frontendFixture>>
    f = await frontendFixture({ beforeCreate: owner => {
      process.env.STATEWRIGHT_ADAPTER_URL = owner.bridge.url
      process.env.STATEWRIGHT_ADAPTER_TOKEN = owner.bridge.token
      process.env.STATEWRIGHT_WORKFLOW = "fixture"
      process.env.STATEWRIGHT_EXECUTOR_ID = owner.owner.record.executor_session_id
    }, register: async (pi, ownership) => {
      await statewrightExtension(pi, ownership)
      pi.registerCommand("capture-docs", { handler: () => effects.push(ownership.bind(() =>
        f.session.extensionRunner!.getToolDefinition("statewright_search_docs")!.execute("docs", { query: "ownership" }))) })
    } })
    const originalFetch = globalThis.fetch
    const docs = vi.fn(response)
    const signals: AbortSignal[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      if (String(url) === "https://docs.statewright.ai/search-index.json") {
        signals.push(init!.signal as AbortSignal)
        return Promise.resolve(docs())
      }
      return originalFetch(url, init)
    })
    await f.bind()
    await f.session.prompt("/capture-docs")
    return { ...f, docs, effects, signals }
  }

  const docsIndex = [{ url: "inert:fixture", title: "ownership", section: "fixture", content: "synthetic ownership result" }]

  it("parks secondary docs HTTP before dispatch and consumes its private release", async () => {
    const f = await docsFixture(() => Response.json(docsIndex))
    f.setLive(pending)
    const result = f.effects[0]()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    expect(f.docs).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
    f.approve()
    expect((await result).content[0].text).toContain("synthetic ownership result")
    expect(f.docs).toHaveBeenCalledTimes(1)
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(1)
  })

  it("drops a secondary docs body completed after a replacement request", async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let reading!: () => void
    const started = new Promise<void>(resolve => { reading = resolve })
    const f = await docsFixture(() => ({ ok: true, json: async () => {
      reading(); await held; return docsIndex
    } }) as Response)
    const result = f.effects[0]()
    await started
    await f.session.prompt("/capture-docs")
    release()
    expect((await result).content[0].text).toBe("Docs search failed.")
    expect(f.signals[0].aborted).toBe(true)
    expect(f.docs).toHaveBeenCalledTimes(1)
    expect(f.requests).toHaveLength(0)
  })

  it("does not let an old secondary docs callback borrow the replacement request", async () => {
    const f = await docsFixture(() => Response.json(docsIndex))
    await f.session.prompt("/capture-docs")
    expect((await f.effects[0]()).content[0].text).toBe("Docs search failed.")
    expect(f.docs).not.toHaveBeenCalled()
    expect((await f.effects[1]()).content[0].text).toContain("synthetic ownership result")
    expect(f.docs).toHaveBeenCalledTimes(1)
  })

  it("checkpoints a captured secondary body reader before reading and drops its late chunk", async () => {
    let request!: () => Promise<Response>
    let body!: ReadableStreamDefaultController<Uint8Array>
    const caller = new AbortController()
    const f = await frontendFixture({ register: (pi, ownership) => {
      pi.registerCommand("capture-http", { handler: () => { request = ownership.bind(() =>
        fetchPiProject("http://127.0.0.1:9/inert-response", { signal: caller.signal })) } })
    } })
    const originalFetch = globalThis.fetch
    const fetches = vi.fn((init: RequestInit) => {
      expect(init.redirect).toBe("error")
      expect(init.signal).not.toBe(caller.signal)
      return new Response(new ReadableStream({ start(controller) { body = controller } }))
    })
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => String(url) === "http://127.0.0.1:9/inert-response"
      ? Promise.resolve(fetches(init!)) : originalFetch(url, init))
    await f.bind()
    await f.session.prompt("/capture-http")
    const response = await request()
    expect(() => response.body!.tee()).toThrow("Unowned project body operation")
    expect(() => response.body!.getReader({ mode: "byob" })).toThrow("Unowned project body operation")
    const reader = response.clone().body!.getReader()
    f.setLive(pending)
    const chunk = reader.read()
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    body.enqueue(new TextEncoder().encode("discard old data"))
    let delivered = false
    void chunk.then(() => { delivered = true }, () => {})
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(delivered).toBe(false)
    f.approve()
    expect(new TextDecoder().decode((await chunk).value)).toBe("discard old data")
    const late = reader.read()
    void late.catch(() => {})
    await f.session.prompt("/capture-http")
    body.enqueue(new TextEncoder().encode("obsolete data"))
    await expect(late).rejects.toThrow("Project request unavailable")
    await expect(response.text()).rejects.toThrow("Project request unavailable")
    expect(fetches).toHaveBeenCalledTimes(1)
    expect(fetches.mock.calls[0][0].signal!.aborted).toBe(true)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
    body.close()
    expect(f.requests).toHaveLength(0)
  })

  it("restores provider project scope without binding its registration epoch", async () => {
    let invoke!: () => Promise<boolean>
    let configuration: any
    const f = await frontendFixture({ register: (pi, ownership) => {
      pi.registerProvider("inert-provider", { streamSimple: () => isPiProjectManaged() })
      pi.registerCommand("provider-scope", { handler: () => { invoke = ownership.bind(async () => configuration.streamSimple()) } })
    } })
    configuration = f.modelRegistry.registerProvider.mock.calls[0][1]
    await f.bind()
    await f.session.prompt("/provider-scope")
    expect(await invoke()).toBe(true)
    await f.session.prompt("/provider-scope")
    expect(await invoke()).toBe(true) // not the unadmitted registration context
    expect(f.requests).toHaveLength(0)
  })

  it.each(["headers", "body"])("cancels secondary HTTP %s even when its transport ignores the caller signal", async phase => {
    let request!: () => Promise<Response>
    const caller = new AbortController()
    const f = await frontendFixture({ register: (pi, ownership) => {
      pi.registerCommand("held-http", { handler: () => { request = ownership.bind(() =>
        fetchPiProject("inert:held", { signal: caller.signal })) } })
    } })
    const originalFetch = globalThis.fetch
    let fetched!: () => void
    const started = new Promise<void>(resolve => { fetched = resolve })
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      if (String(url) === "inert:held") {
        if (phase === "headers") { fetched(); return new Promise<Response>(() => {}) }
        return Promise.resolve({ json: () => { fetched(); return new Promise(() => {}) } } as Response)
      }
      return originalFetch(url, init)
    })
    await f.bind()
    await f.session.prompt("/held-http")
    const result = request().then(response => response.json())
    const rejected = expect(result).rejects.toThrow("Project request unavailable")
    await started
    caller.abort()
    await rejected
    expect(f.requests).toHaveLength(0)
  })

  it("cancels a parked secondary checkpoint before it can consume a later release", async () => {
    let request!: () => Promise<Response>
    const caller = new AbortController()
    const f = await frontendFixture({ register: (pi, ownership) => {
      pi.registerCommand("parked-http", { handler: () => { request = ownership.bind(() =>
        fetchPiProject("inert:parked-http", { signal: caller.signal })) } })
    } })
    const originalFetch = globalThis.fetch
    const dispatch = vi.fn(async () => Response.json({ inert: true }))
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => String(url) === "inert:parked-http"
      ? dispatch() : originalFetch(url, init))
    await f.bind()
    await f.session.prompt("/parked-http")
    f.setLive(pending)
    const result = request()
    const rejected = expect(result).rejects.toThrow("Project request unavailable")
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 500 })
    caller.abort()
    await rejected
    await vi.waitFor(() => expect(f.owner.record.request.phase).toBe("cancelled"), { timeout: 500 })
    f.approve()
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(0)
    expect(dispatch).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
  })

  it("releases secondary body iteration locks at EOF and read failure", async () => {
    let request!: () => Promise<Response>
    const f = await frontendFixture({ register: (pi, ownership) => {
      pi.registerCommand("iterated-http", { handler: () => { request = ownership.bind(() => fetchPiProject("inert:iterated-http")) } })
    } })
    const originalFetch = globalThis.fetch
    let fail!: (reason: unknown) => void
    let response = new Response("inert body")
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => String(url) === "inert:iterated-http"
      ? Promise.resolve(response) : originalFetch(url, init))
    await f.bind()
    await f.session.prompt("/iterated-http")
    const eof = await request()
    let text = ""
    for await (const chunk of eof.body!) text += new TextDecoder().decode(chunk)
    expect(text).toBe("inert body")
    expect(eof.body!.locked).toBe(false)
    response = new Response(new ReadableStream({ start(controller) { fail = reason => controller.error(reason) } }))
    const error = await request()
    const iterator = error.body!.values()
    const rejected = expect(iterator.next()).rejects.toThrow("inert reader failure")
    fail(new Error("inert reader failure"))
    await rejected
    expect(error.body!.locked).toBe(false)
    await iterator.return!()
    expect(error.body!.locked).toBe(false)
  })

  it("preserves ordinary standalone HTTP and denies managed HTTP without admission", async () => {
    const fetches = vi.fn(async () => Response.json({ inert: true }))
    vi.spyOn(globalThis, "fetch").mockImplementation(fetches)
    expect(await (await fetchPiProject("inert:standalone", { redirect: "manual" })).json()).toEqual({ inert: true })
    expect(fetches.mock.calls[0][1]).toEqual({ redirect: "manual" })
    const f = await frontendFixture({ register: async () => {
      await expect(fetchPiProject("inert:unbound")).rejects.toThrow("Private inherited call unavailable")
    } })
    expect(fetches).toHaveBeenCalledTimes(1)
    expect(f.requests).toHaveLength(0)
  })

  it("parks a native extension command before its handler, then consumes one private release", async () => {
    const handler = vi.fn()
    const f = await frontendFixture({ parked: true, register: pi => pi.registerCommand("owned", { handler }) })
    await f.bind()
    let settled = false
    const command = f.session.prompt("/owned synthetic command").finally(() => { settled = true })
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 1_000, interval: 5 })
    expect(handler).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    expect(f.requests).toHaveLength(0)
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    f.approve()
    await command
    expect(handler).toHaveBeenCalledTimes(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(1)
    expect(f.requests).toHaveLength(0)
  })

  it("parks actual native bash outside inference and denies unbound recording or inherited old execution", async () => {
    let inherited!: () => Promise<any>
    let f!: Awaited<ReturnType<typeof frontendFixture>>
    f = await frontendFixture({ handshake: true, parked: true, register: (pi, ownership) => {
      pi.registerCommand("capture", { handler: () => {
        inherited = ownership.bind(() => f.session.executeBash("obsolete inherited command", undefined,
          { operations: { exec: vi.fn() } }))
      } })
    } })
    const chunks = vi.fn()
    const exec = vi.fn(async (_command, _cwd, options) => {
      options.onData(new TextEncoder().encode("released native bash"))
      return { exitCode: 0 }
    })
    await expect(f.session.executeBash("before readiness", chunks, { operations: { exec } })).rejects.toThrow("Native command request unavailable")
    expect(() => f.session.recordBashResult("unbound", { output: "unbound", exitCode: 0, cancelled: false, truncated: false }))
      .toThrow("Native command request unavailable")
    await f.bind()
    const bash = f.session.executeBash("synthetic parked command", chunks, { operations: { exec } })
    bash.catch(() => {})
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 1_000, interval: 5 })
    expect(exec).not.toHaveBeenCalled()
    expect(chunks).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
    f.approve()
    expect((await bash).output).toBe("released native bash")
    expect(exec).toHaveBeenCalledTimes(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
    // SDK defers first history flush until an assistant exists. Prove its public
    // in-memory record now and the actual native file after a later response.
    expect(f.sessionManager.getEntries().some(entry => entry.type === "message"
      && entry.message.role === "bashExecution" && entry.message.output === "released native bash")).toBe(true)
    await f.session.prompt("/capture")
    const epoch = f.owner.record.request_epoch
    // A genuinely native external call owns a new epoch; stale inheritance cannot.
    const real = await f.session.executeBash(`${JSON.stringify(process.execPath)} -e "process.stdout.write('actual owned bash')"`)
    expect(real.output).toBe("actual owned bash")
    expect(f.owner.record.request_epoch).toBe(epoch + 1)
    await expect(inherited()).rejects.toThrow("Native command request unavailable")
    expect(f.owner.record.request_epoch).toBe(epoch + 1)
    expect(f.requests).toHaveLength(0)
    await f.session.prompt("flush legitimate current history")
    expect(await readFile(f.owner.record.host_session_file, "utf8")).toContain("released native bash")
    await f.frontend.close()
    await expect(f.session.executeBash("after close", chunks, { operations: { exec } })).rejects.toThrow("Native command request unavailable")
    expect(exec).toHaveBeenCalledTimes(1)
    expect(f.requests).toHaveLength(1)
  })

  it("does not let a superseded parked slash command run or consume the replacement release", async () => {
    const handler = vi.fn()
    const f = await frontendFixture({ parked: true, register: pi => pi.registerCommand("owned", { handler }) })
    await f.bind()
    const old = f.session.prompt("/owned old")
    await vi.waitFor(() => expect(f.owner.record.request_epoch).toBe(1), { timeout: 1_000, interval: 5 })
    // Epoch publication precedes begin's authority/journal reconciliation.
    await vi.waitFor(() => expect(f.owner.record.request.phase).toBe("parked"), { timeout: 1_000, interval: 5 })
    const newer = f.session.prompt("/owned replacement")
    await vi.waitFor(() => expect(f.owner.record.request_epoch).toBe(2), { timeout: 1_000, interval: 5 })
    await vi.waitFor(() => expect(f.owner.record.request.phase).toBe("parked"), { timeout: 1_000, interval: 5 })
    f.approve()
    await old; await newer
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toBe("replacement")
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(1)
    expect(f.requests).toHaveLength(0)
    expect(f.frontend.readiness).not.toBeNull()
  })

  it("stock SDK text mode cannot print a previous response after command-only input", async () => {
    const handler = vi.fn()
    const f = await frontendFixture({ register: pi => pi.registerCommand("owned", { handler }) })
    const output: string[] = []
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any, encoding: any, callback: any) => {
      output.push(String(chunk)); (typeof encoding === "function" ? encoding : callback)?.(); return true
    }) as any)
    expect(await runPiRequestMode(f.frontend, { mode: "text", messages: ["response owner", "/owned command-only"] })).toBe(0)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(output.join("")).not.toContain("synthetic response")
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request_epoch).toBe(2)
  })

  it("drops an old native bash chunk, result and recording after replacement input", async () => {
    let arrive!: () => void; let release!: () => void; let data!: (value: Uint8Array) => void
    const arrival = new Promise<void>(resolve => { arrive = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    const f = await frontendFixture({ handshake: true })
    await f.bind()
    const chunks = vi.fn()
    const exec = vi.fn(async (_command, _cwd, options) => {
      data = options.onData; arrive(); await barrier
      options.onData(new TextEncoder().encode("obsolete bash output"))
      return { exitCode: 0 }
    })
    const old = f.session.executeBash("synthetic command", chunks, { operations: { exec } })
    const denied = expect(old).rejects.toThrow("Native command request unavailable")
    await arrival
    data(new TextEncoder().encode("current bash output"))
    expect(chunks).toHaveBeenCalledTimes(1)
    const newer = f.session.prompt("replacement during native bash")
    release()
    await denied
    await newer
    expect(chunks).toHaveBeenCalledTimes(1)
    expect(f.session.messages.some(message => message.role === "bashExecution")).toBe(false)
    expect(await readFile(f.owner.record.host_session_file, "utf8")).not.toContain("obsolete bash output")
    expect(f.owner.record.request_epoch).toBe(2)
  })

  it("an older bash finally cannot remove cancellation or status ownership from newer native bash", async () => {
    const releases: Array<() => void> = []
    const signals: AbortSignal[] = []
    cleanup.push(() => releases.forEach(release => release()))
    const f = await frontendFixture()
    await f.bind()
    const backend = { exec: vi.fn((_command, _cwd, options) => {
      signals.push(options.signal)
      return new Promise(resolve => releases.push(() => resolve({ exitCode: 0 })))
    }) }
    const old = f.session.executeBash("old native bash", undefined, { operations: backend })
    const deniedOld = expect(old).rejects.toThrow("Native command request unavailable")
    await vi.waitFor(() => expect(signals).toHaveLength(1), { timeout: 1_000, interval: 5 })
    const newer = f.session.executeBash("new native bash", undefined, { operations: backend })
    const deniedNew = expect(newer).rejects.toThrow("Native command request unavailable")
    await vi.waitFor(() => expect(signals).toHaveLength(2), { timeout: 1_000, interval: 5 })
    expect(signals[0].aborted).toBe(true)
    releases[0]()
    await deniedOld
    expect(f.session.isBashRunning).toBe(true)
    expect(signals[1].aborted).toBe(false)
    f.session.abortBash()
    expect(signals[1].aborted).toBe(true)
    releases[1]()
    await deniedNew
    expect(f.session.isBashRunning).toBe(false)
    expect(f.session.messages.some(message => message.role === "bashExecution")).toBe(false)
    expect(f.owner.record.request_epoch).toBe(2)
    expect(f.requests).toHaveLength(0)
  })

  it("drops late SDK output and native persistence after an awaited old message hook", async () => {
    let arrive!: () => void; let release!: () => void
    const arrival = new Promise<void>(resolve => { arrive = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    let first = true
    const f = await frontendFixture({ handshake: true, register: pi => pi.on("message_end", async event => {
      if (event.message.role !== "assistant" || !first) return
      first = false; arrive(); await barrier
    }) })
    await f.bind()
    const published: any[] = []
    f.session.subscribe(event => { if (event.type === "message_end" && event.message.role === "assistant") published.push(event) })
    const old = f.session.prompt("first delayed output")
    await arrival
    const newer = f.session.prompt("replacement delayed output")
    release()
    await old; await newer
    await vi.waitFor(() => expect(published).toHaveLength(1), { timeout: 1_000, interval: 5 })
    const entries = (await readFile(f.owner.record.host_session_file, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    expect(entries.filter(entry => entry.type === "message" && entry.message.role === "assistant")).toHaveLength(1)
    expect(f.requests).toHaveLength(2)
    expect(f.frontend.readiness).not.toBeNull()
  })

  it("an awaited message hook can complete a nested owned turn without waiting for its enclosing delivery", async () => {
    let first = true; let returned = false
    let secondArrived = false; let releaseSecond!: () => void
    const secondBarrier = new Promise<void>(resolve => { releaseSecond = resolve })
    cleanup.push(() => releaseSecond())
    let f!: Awaited<ReturnType<typeof frontendFixture>>
    f = await frontendFixture({ register: pi => pi.on("message_end", async event => {
      if (event.message.role !== "assistant") return
      if (!first) { secondArrived = true; await secondBarrier; return }
      first = false
      await f.session.agent.waitForIdle()
      await f.session.sendCustomMessage({ customType: "synthetic-nested", content: "synthetic nested turn", display: false }, { triggerTurn: true })
      returned = true
    }) })
    await f.bind()
    const ends: any[] = []
    f.session.subscribe(event => { if (event.type === "agent_end") ends.push(event) })
    let settled = false
    const prompt = f.session.prompt("outer delivery owner").finally(() => { settled = true })
    cleanup.push(async () => { releaseSecond(); await f.frontend.close(); await prompt })
    await vi.waitFor(() => expect({ returned, secondArrived }).toEqual({ returned: true, secondArrived: true }), { timeout: 1_000, interval: 5 })
    expect(settled).toBe(false) // same-request first delivery cannot finish the nested output run
    expect(ends).toHaveLength(1)
    releaseSecond()
    await prompt
    expect(f.requests).toHaveLength(2)
    expect(ends).toHaveLength(2)
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.frontend.finalResponse).toMatchObject({ role: "assistant", stopReason: "stop" })
  })

  it("denies project exec after its inherited request is superseded", async () => {
    const effects: Array<() => Promise<any>> = []
    let unbound!: () => Promise<any>
    const f = await frontendFixture({ register: (pi, ownership) => {
      unbound = () => pi.exec(process.execPath, ["-e", "process.stdout.write('unbound-effect')"])
      pi.on("input", () => {
        effects.push(ownership.bind(() => pi.exec(process.execPath,
          ["-e", "process.stdout.write('task-owned-effect')"])))
      })
    } })
    await expect(unbound()).rejects.toThrow("Project request unavailable")
    await f.bind()
    await f.session.prompt("first exec owner")
    expect((await effects[0]()).stdout).toBe("task-owned-effect")
    await f.session.prompt("replacement exec owner")
    await expect(effects[0]()).rejects.toThrow("Project request unavailable")
    expect((await effects[1]()).stdout).toBe("task-owned-effect")
    await expect(unbound()).rejects.toThrow("Project request unavailable")
    await f.frontend.close()
    await expect(effects[1]()).rejects.toThrow("Project request unavailable")
  })

  it("parks a current project exec outside inference until one private release is consumed", async () => {
    let effect!: () => Promise<any>
    const f = await frontendFixture({ register: (pi, ownership) => pi.on("input", () => {
      effect = ownership.bind(() => pi.exec(process.execPath, ["-e", "process.stdout.write('released-effect')"]))
    }) })
    await f.bind()
    await f.session.prompt("initial effect owner")
    f.setLive(pending)
    let settled = false
    const execution = effect().finally(() => { settled = true })
    execution.catch(() => {}) // teardown may cancel a deliberately parked assertion path
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    expect(settled).toBe(false)
    expect(f.requests).toHaveLength(1)
    expect(await f.mirror.loadCheckpoint()).not.toBeNull()
    f.setLive({ ...pending, state: "work", pending_approval: null })
    await vi.waitFor(() => expect(f.events.filter(event => event === "read:pending").length).toBeGreaterThanOrEqual(2),
      { timeout: 2_000, interval: 5 })
    expect(settled).toBe(false)
    expect(f.requests).toHaveLength(1)
    f.approve()
    expect((await execution).stdout).toBe("released-effect")
    expect(f.owner.record.request_epoch).toBe(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
    expect(f.events.filter(event => event === "clear:approval")).toHaveLength(1)
    expect(await f.mirror.loadCheckpoint()).toBeNull()
    expect(f.requests).toHaveLength(1)
  })

  it("sends the host reference outside model arguments and retains its captured bridge on environment drift", async () => {
    const effects: Array<() => Promise<any>> = []
    const controls: Array<() => Promise<any>> = []
    const saved = process.env.STATEWRIGHT_ADAPTER_URL
    const savedToken = process.env.STATEWRIGHT_ADAPTER_TOKEN
    cleanup.push(() => {
      if (saved === undefined) delete process.env.STATEWRIGHT_ADAPTER_URL; else process.env.STATEWRIGHT_ADAPTER_URL = saved
      if (savedToken === undefined) delete process.env.STATEWRIGHT_ADAPTER_TOKEN; else process.env.STATEWRIGHT_ADAPTER_TOKEN = savedToken
    })
    const f = await frontendFixture({ beforeCreate: owner => {
      process.env.STATEWRIGHT_ADAPTER_URL = owner.bridge.url
      process.env.STATEWRIGHT_ADAPTER_TOKEN = owner.bridge.token
    }, register: (pi, ownership) => pi.on("input", () => {
      effects.push(ownership.bind(() => callStatewrightGateway("synthetic_effect", { request_reference: "model-controlled" })))
      controls.push(ownership.bind(() => callStatewrightGateway("statewright_get_state")))
    }) })
    const bodies: any[] = []
    const originalFetch = globalThis.fetch
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      if (String(url) === `${f.bridge.url}/mcp`) bodies.push(JSON.parse(String(init?.body)))
      return originalFetch(url, init)
    })
    f.bridge.client.request = vi.fn(async (_method, params) => ({ content: [{ type: "text", text: JSON.stringify(
      params.name === "statewright_get_state" ? await f.getState() : { effect: "synthetic" }) }] }))
    await f.bind()
    await f.session.prompt("first transport owner")
    expect(await effects[0]()).toEqual({ effect: "synthetic" })
    expect(bodies[0].request_reference).toMatchObject({ schema: "statewright/executor-request-ref/v1",
      request_epoch: 1, native_session_id: f.owner.record.host_session_id })
    expect(bodies[0].params.arguments.request_reference).toBe("model-controlled")
    await f.session.prompt("replacement transport owner")
    await expect(effects[0]()).rejects.toThrow("Project request unavailable")
    await expect(controls[0]()).rejects.toThrow("Project request unavailable")
    expect(bodies).toHaveLength(1)
    expect(await effects[1]()).toEqual({ effect: "synthetic" })
    expect(bodies[1].request_reference.request_epoch).toBe(2)
    expect(bodies[1].request_reference.request_id).not.toBe(bodies[0].request_reference.request_id)
    delete process.env.STATEWRIGHT_ADAPTER_URL
    process.env.STATEWRIGHT_ADAPTER_TOKEN = "changed-environment-token"
    expect(await effects[1]()).toEqual({ effect: "synthetic" })
    expect(bodies).toHaveLength(3) // captured private endpoint/token, no mutable-env retarget or direct fallback
  })

  it("denies managed gateway effects when construction has no private bridge", async () => {
    const saved = process.env.STATEWRIGHT_ADAPTER_URL
    cleanup.push(() => { if (saved === undefined) delete process.env.STATEWRIGHT_ADAPTER_URL; else process.env.STATEWRIGHT_ADAPTER_URL = saved })
    let effect!: () => Promise<any>
    const f = await frontendFixture({ beforeCreate: () => { delete process.env.STATEWRIGHT_ADAPTER_URL },
      register: (pi, ownership) => pi.on("input", () => {
        effect = ownership.bind(() => callStatewrightGateway("synthetic_effect"))
      }) })
    await f.bind()
    await f.session.prompt("effect without project bridge")
    await expect(effect()).rejects.toThrow("Managed project requires its private executor bridge")
    expect(f.requests).toHaveLength(1)
  })

  it("suppresses an awaited old project result without letting its SDK error close newer ownership", async () => {
    let arrive!: () => void; let release!: () => void
    const arrival = new Promise<void>(resolve => { arrive = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    const runs: Array<() => Promise<any>> = []
    let f!: Awaited<ReturnType<typeof frontendFixture>>
    const subsequent = vi.fn()
    f = await frontendFixture({ register: (pi, ownership) => {
      pi.on("input", () => runs.push(ownership.bind(() => f.session.extensionRunner!.emit({
        type: "tool_result", toolName: "synthetic-delayed", toolCallId: "synthetic", input: {}, content: [], isError: false,
      }))))
      pi.on("tool_result", async event => {
        if (event.toolName !== "synthetic-delayed") return
        await dispatchPiProjectEffect(async () => { arrive(); await barrier; return "obsolete" })
        subsequent()
        pi.sendUserMessage("obsolete message", { deliverAs: "followUp" })
      })
    } })
    await f.bind()
    await f.session.prompt("first awaited callback owner")
    const errors = vi.fn()
    f.session.extensionRunner!.onError(errors)
    const old = runs[0]()
    await arrival
    await f.session.prompt("replacement while awaiting callback")
    release()
    await old
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ error: "Project request unavailable" }))
    expect(subsequent).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(2)
    expect(f.frontend.readiness).not.toBeNull()
    await f.session.prompt("new ownership still usable")
    expect(f.requests).toHaveLength(3)
  })

  it("still revokes readiness for a genuine current callback error while its request is parked", async () => {
    let arrive!: () => void; let release!: () => void
    const arrival = new Promise<void>(resolve => { arrive = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    let f!: Awaited<ReturnType<typeof frontendFixture>>
    let hook!: () => Promise<any>; let effect!: () => Promise<any>
    f = await frontendFixture({ register: (pi, ownership) => {
      pi.on("input", () => {
        hook = ownership.bind(() => f.session.extensionRunner!.emit({ type: "tool_result", toolName: "synthetic-current-error",
          toolCallId: "synthetic", input: {}, content: [], isError: false }))
        effect = ownership.bind(() => pi.exec(process.execPath, ["-e", "process.stdout.write('never-run')"]))
      })
      pi.on("tool_result", async event => {
        if (event.toolName !== "synthetic-current-error") return
        arrive(); await barrier; throw new Error("Synthetic current project error")
      })
    } })
    await f.bind()
    await f.session.prompt("current callback owner")
    const callback = hook()
    await arrival
    f.setLive(pending)
    const parked = effect()
    parked.catch(() => {})
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    release()
    await callback
    expect(f.frontend.readiness).toBeNull()
    await f.frontend.close()
    await expect(parked).rejects.toThrow("Project request unavailable")
    expect(f.requests).toHaveLength(1)
  })

  it("correlates the actual project's pre/post-tool hooks with the parent request", async () => {
    const keys = ["STATEWRIGHT_ADAPTER_URL", "STATEWRIGHT_ADAPTER_TOKEN", "STATEWRIGHT_EXECUTOR_ID",
      "STATEWRIGHT_BRANCH_SESSION_ID", "STATEWRIGHT_API_KEY", "STATEWRIGHT_NO_UPDATE_CHECK", "STATEWRIGHT_WORKFLOW"]
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    cleanup.push(() => { for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]
    } })
    const events: Array<() => Promise<any>> = []
    let f!: Awaited<ReturnType<typeof frontendFixture>>
    const policyCalls: string[] = []
    const bodies: any[] = []
    let holdPost = false
    let arrive!: () => void; let release!: () => void
    const arrival = new Promise<void>(resolve => { arrive = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    f = await frontendFixture({ streaming: true, beforeCreate: owner => {
      Object.assign(process.env, { STATEWRIGHT_ADAPTER_URL: owner.bridge.url, STATEWRIGHT_ADAPTER_TOKEN: owner.bridge.token,
        STATEWRIGHT_EXECUTOR_ID: "synthetic-owner", STATEWRIGHT_BRANCH_SESSION_ID: "session",
        STATEWRIGHT_API_KEY: "synthetic-key", STATEWRIGHT_NO_UPDATE_CHECK: "1" })
      delete process.env.STATEWRIGHT_WORKFLOW
      owner.bridge.client.call = vi.fn(async name => {
        if (name === "statewright_get_state") return { ...await owner.getState(), allowed_tools: ["Read"] }
        policyCalls.push(name)
        if (holdPost && name === "statewright_adapter_post_tool") { arrive(); await barrier }
        return { decision: "allow", state: "review" }
      })
      owner.bridge.client.request = vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify(
        { ...await owner.getState(), allowed_tools: ["Read"] }) }] }))
      const originalFetch = globalThis.fetch
      vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
        if ([`${owner.bridge.url}/hooks/pre-tool`, `${owner.bridge.url}/hooks/post-tool`].includes(String(url))) {
          bodies.push(JSON.parse(String(init?.body)))
        }
        if (holdPost && String(url) === `${owner.bridge.url}/hooks/post-tool`) {
          // Simulate a non-cooperative in-flight adapter while preserving the
          // real local bridge/SDK path. The post-await ownership check must
          // protect replacement even if transport cancellation is ignored.
          return originalFetch(url, { ...init, signal: undefined })
        }
        if (!String(url).startsWith("http://127.0.0.1:")) throw new Error("Unexpected non-local fixture request")
        return originalFetch(url, init)
      })
    }, register: async (pi, ownership) => {
      await statewrightExtension(pi, ownership)
      pi.on("input", () => events.push(ownership.bind(async () => {
        const decision = await f.session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "read",
          toolCallId: "synthetic", input: { request_reference: "model-controlled" } })
        await f.session.extensionRunner!.emitToolResult({ type: "tool_result", toolName: "read", toolCallId: "synthetic",
          input: {}, content: [{ type: "text", text: "inert result" }], isError: false })
        return decision
      })))
    } })
    await f.bind()
    const first = f.session.prompt("project hook owner")
    first.catch(() => {})
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 2_000, interval: 5 })
    expect(await events[0]()).toBeUndefined()
    expect(policyCalls).toEqual(["statewright_adapter_pre_tool", "statewright_adapter_post_tool"])
    expect(bodies).toHaveLength(2)
    expect(bodies[0].request_reference).toEqual(bodies[1].request_reference)
    expect(bodies[0].request_reference.request_epoch).toBe(1)
    expect(bodies[0].tool_input.request_reference).toBe("model-controlled")
    delete process.env.STATEWRIGHT_ADAPTER_URL
    process.env.STATEWRIGHT_ADAPTER_TOKEN = "changed-environment-token"
    expect(await events[0]()).toBeUndefined()
    expect(policyCalls).toHaveLength(4)
    expect(bodies).toHaveLength(4)
    holdPost = true
    const delayed = events[0]()
    await arrival
    const replacement = f.session.prompt("new project hook owner")
    replacement.catch(() => {})
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 2_000, interval: 5 })
    const abort = vi.spyOn(f.session.agent, "abort")
    const notifications = f.uiContext.notify.mock.calls.length
    release()
    await delayed
    expect(abort).not.toHaveBeenCalled()
    expect(f.uiContext.notify).toHaveBeenCalledTimes(notifications)
    expect(f.session.agent.state.isStreaming).toBe(true)
    expect(await events[0]()).toMatchObject({ block: true })
    expect(policyCalls).toHaveLength(6)
    expect(bodies).toHaveLength(6)
    expect(f.frontend.readiness).not.toBeNull()
    await f.frontend.close()
    await Promise.all([first, replacement])
  })

  it("privately admits before project input and never lends current ownership outside its call", async () => {
    let ownership: any
    const observed: boolean[] = []
    const inherited: Array<() => boolean> = []
    const releaseProof: Array<() => boolean> = []
    const f = await frontendFixture({ parked: true, register: (pi, privateOwnership) => {
      ownership = privateOwnership
      pi.on("input", () => {
        observed.push(ownership.ownsCurrent())
        inherited.push(ownership.bind(() => ownership.ownsCurrent()))
        releaseProof.push(ownership.bind(() => ownership.hasConsumedApproval("approval")))
        expect(ownership.hasConsumedApproval("foreign-approval")).toBe(false)
        return ownership.ownsCurrent() ? { action: "continue" } : { action: "handled" }
      })
    } })
    expect(Object.isFrozen(ownership)).toBe(true)
    expect(ownership.ownsCurrent()).toBe(false)
    await f.bind()
    const input = f.session.prompt("parked project input")
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    expect(observed).toEqual([])
    expect(f.requests).toHaveLength(0)
    f.approve()
    await input
    expect(observed).toEqual([true])
    expect(f.requests).toHaveLength(1)
    expect(ownership.ownsCurrent()).toBe(false)
    expect(inherited[0]()).toBe(true)
    expect(releaseProof[0]()).toBe(true)
    expect(ownership.hasConsumedApproval("approval")).toBe(false)
    await f.session.prompt("new private input")
    expect(inherited[0]()).toBe(false)
    expect(inherited[1]()).toBe(true)
    expect(releaseProof[0]()).toBe(false)
    expect(releaseProof[1]()).toBe(false)
    await f.frontend.close()
    expect(inherited[1]()).toBe(false)
  })

  it("negotiates exact native file and fresh parent/child lifetimes before actual SDK delivery", async () => {
    const f = await frontendFixture({ handshake: true })
    expect(f.sessionManager.getSessionFile()).toBe(f.owner.record.host_session_file)
    await f.session.prompt("pre-handshake held input")
    expect(f.requests).toHaveLength(0)
    expect(f.nativeReadiness!.ready).toBe(false)
    await f.bind()
    expect(await f.bridge.waitForReady({ timeoutMs: 10 })).toBe(true)
    await f.session.prompt("private acknowledged input")
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request_epoch).toBe(1)
    await expect(f.publish!(f.frontend.readiness)).rejects.toThrow("ownership mismatch")
  })

  it("holds actual SDK input throughout private parent acknowledgement publication", async () => {
    let arrived!: () => void; let release!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    const f = await frontendFixture({ handshake: true, onReady: async () => { arrived(); await barrier } })
    const binding = f.bind()
    await arrival
    try {
      await f.session.prompt("private ack overlap")
      expect(f.nativeReadiness!.ready).toBe(false)
      expect(f.frontend.readiness).toBeNull()
      expect(f.owner.record.request_epoch).toBe(0)
      expect(f.modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled()
    } finally { release(); await binding }
    expect(f.nativeReadiness!.ready).toBe(true)
  })

  it("fails closed if the bound child exits during actual SDK startup", async () => {
    let f!: Awaited<ReturnType<typeof frontendFixture>>
    f = await frontendFixture({ handshake: true, register: pi => pi.on("session_start", () => f.child.emit("exit", 0)) })
    await expect(f.bind()).rejects.toThrow("readiness")
    await f.session.prompt("obsolete child input")
    expect(f.frontend.readiness).toBeNull()
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.requests).toHaveLength(0)
  })

  it("rejects a foreign private acknowledgement before actual SDK gate enable", async () => {
    const f = await frontendFixture({ handshake: true, acknowledgement: value => ({ ...value, child_lifetime_id: "foreign" }) })
    await expect(f.bind()).rejects.toThrow("acknowledgement")
    await f.session.prompt("forged private ack input")
    expect(f.frontend.readiness).toBeNull()
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.requests).toHaveLength(0)
  })

  it("rejects file drift before private publication and UUID-preserving descriptor substitution", async () => {
    const f = await frontendFixture({ handshake: true })
    vi.spyOn(f.sessionManager, "getSessionFile").mockReturnValue("/foreign/native.jsonl")
    await expect(f.bind()).rejects.toThrow("Owned SDK frontend unavailable")
    expect(f.nativeReadiness!.ready).toBe(false)
    expect(f.requests).toHaveLength(0)
    expect(f.owner.record.request_epoch).toBe(0)
  })

  it("rechecks exact native file after an awaited private acknowledgement", async () => {
    const f = await frontendFixture({ handshake: true, acknowledgement: value => {
      vi.spyOn(f.sessionManager, "getSessionFile").mockReturnValue("/foreign/late.jsonl")
      return value
    } })
    await expect(f.bind()).rejects.toThrow("acknowledgement")
    await f.session.prompt("late descriptor drift")
    expect(f.frontend.readiness).toBeNull()
    expect(f.requests).toHaveLength(0)
    expect(f.owner.record.request_epoch).toBe(0)
  })

  it("holds fresh input after parent lifetime close without creating a new epoch", async () => {
    const f = await frontendFixture({ handshake: true })
    await f.bind()
    await f.nativeReadiness!.close()
    await f.session.prompt("parent disconnected input")
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.requests).toHaveLength(0)
  })

  it("revokes native readiness monotonically after UUID-preserving file drift", async () => {
    const f = await frontendFixture({ handshake: true })
    await f.bind()
    const abort = vi.spyOn(f.session.agent, "abort")
    const file = vi.spyOn(f.sessionManager, "getSessionFile").mockReturnValue("/foreign/after-ready.jsonl")
    expect(f.frontend.readiness).toBeNull()
    await f.session.prompt("foreign file input")
    expect(abort).not.toHaveBeenCalled()
    expect(f.owner.record.request_epoch).toBe(0)
    file.mockRestore()
    await f.session.prompt("restored file must remain held")
    expect(f.frontend.readiness).toBeNull()
    expect(f.requests).toHaveLength(0)
  })

  it("denies actual primary HTTP after file drift during the provider auth await", async () => {
    const f = await frontendFixture({ handshake: true })
    await f.bind()
    const abort = vi.spyOn(f.session.agent, "abort")
    f.modelRegistry.getApiKeyAndHeaders.mockImplementation(async () => {
      vi.spyOn(f.sessionManager, "getSessionFile").mockReturnValue("/foreign/provider.jsonl")
      return { ok: true, apiKey: "synthetic-not-a-secret" }
    })
    await f.session.prompt("provider file drift")
    expect(f.requests).toHaveLength(0)
    expect(abort).not.toHaveBeenCalled()
    expect(f.frontend.readiness).toBeNull()
  })

  it("bounds private acknowledgement even when an injected transport ignores cancellation", async () => {
    const f = await frontendFixture({ handshake: true })
    let signal!: AbortSignal
    const publish = createPiNativeReadinessPublisher({ challenge: f.nativeReadiness!.challenge, sessionManager: f.sessionManager,
      timeoutMs: 10, call: (_action: string, _body: unknown, incoming: AbortSignal) => { signal = incoming; return new Promise(() => {}) } })
    await expect(publish({ schema: "statewright/pi-native-readiness/v1", native_session_id: f.owner.record.host_session_id }))
      .rejects.toThrow("timed out")
    expect(signal.aborted).toBe(true)
    await expect(publish({ schema: "statewright/pi-native-readiness/v1", native_session_id: f.owner.record.host_session_id }))
      .rejects.toThrow("ownership mismatch")
    expect(f.nativeReadiness!.ready).toBe(false)
  })

  it("holds actual SDK input until startup binding, then publishes exact native readiness", async () => {
    const f = await frontendFixture()
    expect(f.frontend.readiness).toBeNull()
    await f.session.prompt("before readiness")
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
    await f.bind()
    expect(f.frontend.readiness).toEqual({ schema: "statewright/pi-native-readiness/v1", native_session_id: f.owner.record.host_session_id })
    expect(Object.isFrozen(f.frontend.readiness)).toBe(true)
    expect(f.onReady).toHaveBeenCalledTimes(1)
    await f.session.prompt("owned explicit input")
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request_epoch).toBe(1)
  })

  it("keeps input held throughout an awaited session_start handler", async () => {
    let arrived!: () => void
    let release!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    const f = await frontendFixture({ register: pi => pi.on("session_start", async () => { arrived(); await barrier }) })
    const binding = f.bind()
    await arrival
    try {
      await f.session.prompt("startup overlap")
      expect(f.requests).toHaveLength(0)
      expect(f.owner.record.request_epoch).toBe(0)
      expect(f.onReady).not.toHaveBeenCalled()
    } finally { release(); await binding }
    await f.session.prompt("ready input")
    expect(f.requests).toHaveLength(1)
  })

  it("parks without HTTP through the owned frontend, then consumes synthetic approval once", async () => {
    const f = await frontendFixture({ parked: true })
    await f.bind()
    const input = f.session.prompt("parked input")
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    expect(f.requests).toHaveLength(0)
    expect(f.modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled()
    f.approve()
    await input
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
  })

  it("installs provider admission last after earlier trusted project hooks", async () => {
    let f!: Awaited<ReturnType<typeof frontendFixture>>
    let first = true
    f = await frontendFixture({ register: pi => pi.on("before_provider_request", (event: any) => {
      if (first) { first = false; f.setLive(pending) }
      return event.payload
    }) })
    await f.bind()
    const input = f.session.prompt("provider checkpoint input")
    await vi.waitFor(() => expect(f.onPark).toHaveBeenCalled(), { timeout: 2_000, interval: 5 })
    expect(f.requests).toHaveLength(0)
    f.approve()
    await input
    expect(f.requests).toHaveLength(1)
    expect(f.owner.record.request.consumed_approval_ids).toEqual(["approval"])
  })

  it("refuses a late hook even when SDK catches the startup handler exception", async () => {
    const f = await frontendFixture({ register: pi => pi.on("session_start", () => {
      pi.on("before_provider_request", () => ({ unsafe: "replacement" }))
    }) })
    await expect(f.bind()).rejects.toThrow("Owned SDK frontend unavailable")
    await f.session.prompt("held after late hook")
    expect(f.frontend.readiness).toBeNull()
    expect(f.onReady).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
  })

  it("refuses readiness after a normal startup handler error swallowed by the SDK", async () => {
    const f = await frontendFixture({ register: pi => pi.on("session_start", () => {
      throw new Error("Synthetic startup failed")
    }) })
    await expect(f.bind()).rejects.toThrow("Owned SDK frontend unavailable")
    await f.session.prompt("unsafe startup input")
    expect(f.frontend.readiness).toBeNull()
    expect(f.onReady).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
  })

  it("rejects SDK-collected extension setup errors before constructing readiness", async () => {
    await expect(frontendFixture({ register: () => { throw new Error("Synthetic registration failed") } }))
      .rejects.toThrow("Owned SDK frontend unavailable")
  })

  it("rejects extension API mutation that would shadow final guard registration", async () => {
    let failure: unknown = null
    try { await frontendFixture({ register: pi => { pi.on = () => {} } }) }
    catch (error) { failure = error }
    expect(failure).toMatchObject({ message: "Owned SDK frontend unavailable" })
  })

  it("keeps input held while the private readiness publication callback awaits", async () => {
    let arrived!: () => void
    let release!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    const f = await frontendFixture({ onReady: async () => { arrived(); await barrier } })
    const binding = f.bind()
    await arrival
    try {
      await f.session.prompt("readiness overlap")
      expect(f.frontend.readiness).toBeNull()
      expect(f.requests).toHaveLength(0)
      expect(f.owner.record.request_epoch).toBe(0)
    } finally { release(); await binding }
    await f.session.prompt("after publication")
    expect(f.requests).toHaveLength(1)
  })

  it("requires awaited resource discovery before publishing readiness", async () => {
    let arrived!: () => void
    let release!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    const f = await frontendFixture({ register: pi => pi.on("resources_discover", async () => { arrived(); await barrier; return {} }) })
    const binding = f.bind()
    await arrival
    try {
      await f.session.prompt("resources overlap")
      expect(f.requests).toHaveLength(0)
      expect(f.onReady).not.toHaveBeenCalled()
    } finally { release(); await binding }
    await f.session.prompt("ready resources")
    expect(f.requests).toHaveLength(1)
  })

  it("holds after the private readiness publication fails", async () => {
    const f = await frontendFixture({ onReady: () => { throw new Error("Synthetic readiness unavailable") } })
    await expect(f.bind()).rejects.toThrow("Synthetic readiness unavailable")
    await f.session.prompt("failed publication")
    expect(f.frontend.readiness).toBeNull()
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.requests).toHaveLength(0)
  })

  it("denies a second UI binding without changing its established native ownership", async () => {
    const f = await frontendFixture()
    await f.bind()
    await expect(f.bind()).rejects.toThrow("Owned SDK frontend unavailable")
    expect(f.onReady).toHaveBeenCalledTimes(1)
    await f.session.prompt("original binding input")
    expect(f.requests).toHaveLength(1)
  })

  it("revokes readiness for a hook captured before sealing but invoked after readiness", async () => {
    let late!: (...args: any[]) => unknown
    const f = await frontendFixture({ register: pi => { late = pi.on } })
    await f.bind()
    await f.session.prompt("owned input")
    expect(() => late("before_provider_request", () => ({}))).toThrow("Managed hook registration is sealed")
    expect(f.frontend.readiness).toBeNull()
    await f.session.prompt("after violation")
    expect(f.requests).toHaveLength(1)
  })

  it("cannot enable readiness after close interrupts awaited startup", async () => {
    let arrived!: () => void
    let release!: () => void
    const arrival = new Promise<void>(resolve => { arrived = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    cleanup.push(() => release())
    const f = await frontendFixture({ register: pi => pi.on("session_start", async () => { arrived(); await barrier }) })
    const binding = f.bind()
    const failed = expect(binding).rejects.toThrow("Owned SDK frontend unavailable")
    await arrival
    await f.frontend.close()
    release()
    await failed
    expect(f.frontend.readiness).toBeNull()
    expect(f.onReady).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
  })

  it("refuses native drift during the readiness callback", async () => {
    let f!: Awaited<ReturnType<typeof frontendFixture>>
    f = await frontendFixture({ onReady: () => { f.sessionManager.newSession() } })
    await expect(f.bind()).rejects.toThrow("Owned SDK frontend unavailable")
    await f.session.prompt("foreign input")
    expect(f.frontend.readiness).toBeNull()
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.requests).toHaveLength(0)
  })

  it("revokes readiness after observed post-binding drift and never reactivates on UUID restoration", async () => {
    const f = await frontendFixture()
    await f.bind()
    const abort = vi.spyOn(f.session.agent, "abort")
    f.sessionManager.newSession()
    await f.session.prompt("foreign native input")
    expect(f.frontend.readiness).toBeNull()
    expect(abort).not.toHaveBeenCalled()
    f.sessionManager.newSession({ id: f.owner.record.host_session_id })
    await f.session.prompt("restored UUID input")
    expect(f.frontend.readiness).toBeNull()
    expect(f.owner.record.request_epoch).toBe(0)
    expect(f.requests).toHaveLength(0)
  })

  it("revokes readiness for an unavailable native identity probe without authorizing abort", async () => {
    const f = await frontendFixture()
    await f.bind()
    const abort = vi.spyOn(f.session.agent, "abort")
    const identity = vi.spyOn(f.sessionManager, "getSessionId").mockImplementation(() => { throw new Error("Synthetic native identity unavailable") })
    expect(f.frontend.readiness).toBeNull()
    expect(abort).not.toHaveBeenCalled()
    // Probe denial is the criterion; SDK disposal itself needs its identity.
    identity.mockRestore()
    await f.session.prompt("unavailable native identity")
    expect(f.frontend.readiness).toBeNull()
    expect(f.requests).toHaveLength(0)
  })

  it("drains one owned close when a real streaming abort listener reenters close", async () => {
    const shutdown = vi.fn()
    const f = await frontendFixture({ streaming: true, register: pi => pi.on("session_shutdown", shutdown) })
    await f.bind()
    const input = f.session.prompt("owned streaming input")
    await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 2_000, interval: 5 })
    const signal = f.session.agent.signal!
    signal.addEventListener("abort", () => { void f.frontend.close() }, { once: true })
    await f.frontend.close()
    await input
    expect(signal.aborted).toBe(true)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(f.frontend.readiness).toBeNull()
    expect(f.owner.record.request.phase).toBe("cancelled")
    expect(f.owner.record.request.reason).toBe("disconnected")
  })

  it.each(["newSession", "switchSession", "fork", "importFromJsonl"])("requires fresh parent ownership before runtime %s", async method => {
    const f = await frontendFixture()
    await f.bind()
    await f.session.prompt("old input")
    await expect((f.frontend.runtime as any)[method]("/fixture-unused")).rejects.toThrow("Fresh parent/native ownership required")
    expect(f.sessionManager.getSessionId()).toBe(f.owner.record.host_session_id)
    expect(f.frontend.readiness).toBeNull()
    await f.session.prompt("held old frontend")
    expect(f.requests).toHaveLength(1)
  })

  it("holds SDK reload before it can drop the exclusive guards", async () => {
    const f = await frontendFixture()
    await f.bind()
    await f.session.prompt("old input")
    await expect(f.session.reload()).rejects.toThrow("Fresh parent/native ownership required")
    expect(f.frontend.readiness).toBeNull()
    await f.session.prompt("after denied reload")
    expect(f.requests).toHaveLength(1)
  })
})
