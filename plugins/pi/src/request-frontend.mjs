import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import { createPiRequestGate } from "./request-gate.mjs";
import { createPiRequestOperations } from "./request-operations.mjs";
import { installPiRequestGuards } from "./request-hooks.mjs";
import { piProjectMethod, withPiProjectEffects } from "./project-effects.mjs";
import { snapshotPiRpcConfiguration } from "./request-rpc-input.mjs";

// Additive owning SDK frontend. Not an extension-context or stock-CLI patch.
// This lifetime binds exactly one parent-owned native UUID; replacement needs
// a new parent binding, never automatic adoption of the SDK's new identity.
export async function createPiRequestFrontend({ nativeSessionId, call, target, servicesOptions = {}, resources = {},
  sessionOptions = {}, gateOptions = {}, register, onReady }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nativeSessionId ?? "")
    || target?.sessionManager?.getSessionId() !== nativeSessionId || typeof call !== "function"
    || typeof register !== "function" || typeof onReady !== "function") throw new Error("Owned SDK frontend unavailable");
  const nativeSessionFile = target.sessionManager.getSessionFile();
  const operations = createPiRequestOperations();
  const projectBridge = Object.freeze({ url: process.env.STATEWRIGHT_ADAPTER_URL, token: process.env.STATEWRIGHT_ADAPTER_TOKEN });
  const bindProject = fn => {
    if (typeof fn !== "function") throw new Error("Private inherited call unavailable");
    return operations.bind((...args) => withPiProjectEffects(operations, () => fn(...args), projectBridge));
  };
  const gate = createPiRequestGate({ ...gateOptions, nativeSessionId, nativeSessionFile, call, onAdmit: ref => operations.admit(ref) });
  let runtime = null;
  let dispose = null;
  let session = null;
  let closed = false;
  let created = false;
  let bindingStarted = false;
  let readiness = null;
  let closing = null;

  const native = () => { try { return !closed && session?.sessionManager.getSessionId() === nativeSessionId
    && session.sessionManager.getSessionFile() === nativeSessionFile; } catch { return false; } };
  const invalidate = () => { closed = true; readiness = null; };
  const observeNative = () => {
    if (native()) return true;
    invalidate();
    void close().catch(() => {});
    return false;
  };
  async function close() {
    if (closing) return closing;
    invalidate();
    // Claim close before abort can synchronously call public SDK listeners.
    let finish;
    let fail;
    closing = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    void (async () => {
      try { await operations.close(); } finally {
        try { await gate.close(); } finally { if (dispose) await dispose(); }
      }
    })().then(finish, fail);
    return closing;
  }
  const freshOwnerRequired = async () => { await close(); throw new Error("Fresh parent/native ownership required"); };
  try {
    runtime = await createAgentSessionRuntime(async options => {
      if (created || closed || options.sessionManager.getSessionId() !== nativeSessionId) throw new Error("Owned SDK frontend unavailable");
      created = true;
      let registered = false;
      const services = await createAgentSessionServices({
        authStorage: servicesOptions.authStorage, settingsManager: servicesOptions.settingsManager,
        modelRegistry: servicesOptions.modelRegistry, cwd: options.cwd, agentDir: options.agentDir,
        resourceLoaderOptions: {
          noSkills: resources.noSkills, noPromptTemplates: resources.noPromptTemplates,
          noThemes: resources.noThemes, noContextFiles: resources.noContextFiles,
          systemPrompt: resources.systemPrompt, appendSystemPrompt: resources.appendSystemPrompt,
          noExtensions: true, additionalExtensionPaths: [], extensionFactories: [async pi => {
            let sealed = false;
            const on = pi.on.bind(pi);
            const unavailable = message => {
              invalidate();
              void close().catch(() => {});
              throw new Error(message);
            };
            const managed = new Proxy(pi, {
              get(object, key, receiver) {
                if (!["on", "registerTool", "registerCommand", "registerShortcut"].includes(key)) {
                  return ["exec", "sendUserMessage", "sendMessage", "registerProvider", "unregisterProvider", "setModel",
                    "setThinkingLevel", "setActiveTools", "appendEntry", "setSessionName", "setLabel"].includes(key)
                    ? piProjectMethod(object, key, operations, projectBridge) : Reflect.get(object, key, receiver);
                }
                return (...args) => {
                  if (sealed || closed) unavailable("Managed hook registration is sealed");
                  return piProjectMethod(object, key, operations, projectBridge)(...args);
                };
              },
              set: () => unavailable("Managed extension API is read-only"),
              defineProperty: () => unavailable("Managed extension API is read-only"),
              deleteProperty: () => unavailable("Managed extension API is read-only"),
              setPrototypeOf: () => unavailable("Managed extension API is read-only"),
            });
            try {
              on("input", (event, ctx) => operations.input(event, ctx));
              await withPiProjectEffects(operations, () => register(managed, Object.freeze({
                bind: bindProject, ownsCurrent: () => operations.ownsCurrent(),
                hasConsumedApproval: id => operations.hasConsumedApproval(id) })), projectBridge);
              installPiRequestGuards({ pi: { on }, gate, referenceFor: () => operations.referenceFor() });
              registered = true;
            } finally { sealed = true; }
          }],
        },
      });
      const extensions = services.resourceLoader.getExtensions();
      // SDK collects extension factory exceptions rather than failing startup.
      if (closed || !registered || extensions.errors.length || extensions.extensions.length !== 1
        || services.diagnostics.some(item => item.type === "error")) throw new Error("Owned SDK frontend unavailable");
      const result = await createAgentSessionFromServices({ ...sessionOptions, services,
        sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent });
      session = result.session;
      if (!native()) throw new Error("Owned SDK frontend unavailable");
      operations.install({ session, gate });
      // Independent public runner listener: UI bindings cannot replace it.
      // SDK catches event errors; successful bind alone is not startup proof.
      session.extensionRunner.onError(() => {
        if (operations.staleCall()) return; // obsolete/specified native-cancelled callback cannot revoke ownership
        invalidate(); void close().catch(() => {});
      });
      const prompt = session.prompt.bind(session);
      session.prompt = (...args) => observeNative() ? prompt(...args) : Promise.resolve();
      const bind = session.bindExtensions.bind(session);
      session.bindExtensions = async (...args) => {
        if (!observeNative() || bindingStarted) throw new Error("Owned SDK frontend unavailable");
        bindingStarted = true;
        try {
          await operations.bootstrap(() => bind(...args));
          if (!native()) throw new Error("Owned SDK frontend unavailable");
          const receipt = Object.freeze({ schema: "statewright/pi-native-readiness/v1", native_session_id: nativeSessionId });
          await onReady(receipt);
          if (!native()) throw new Error("Owned SDK frontend unavailable");
          readiness = receipt;
          gate.enable();
        } catch (error) { await close(); throw error; }
      };
      session.reload = freshOwnerRequired;
      return { ...result, services, diagnostics: services.diagnostics };
    }, target);
    dispose = runtime.dispose.bind(runtime);
    runtime.dispose = close;
    for (const method of ["newSession", "switchSession", "fork", "importFromJsonl"]) runtime[method] = freshOwnerRequired;
    const configuration = command => {
      const input = snapshotPiRpcConfiguration(command);
      if (!observeNative()) return Promise.reject(new Error("Native configuration input unavailable"));
      return operations.configuration(JSON.stringify(input), async () => {
        switch (input.type) {
          case "set_model": {
            const models = await session.modelRegistry.getAvailable();
            const model = models.find(value => value.provider === input.provider && value.id === input.modelId);
            if (!model) throw new Error(`Model not found: ${input.provider}/${input.modelId}`);
            await session.setModel(model);
            return model;
          }
          case "cycle_model": return await session.cycleModel() ?? null;
          case "set_thinking_level": session.setThinkingLevel(input.level); return;
          case "cycle_thinking_level": {
            const level = session.cycleThinkingLevel();
            return level ? { level } : null;
          }
          case "set_session_name": session.setSessionName(input.name.trim()); return;
        }
      });
    };
    const cancelInput = () => {
      if (!observeNative()) return Promise.reject(new Error("Native cancellation input unavailable"));
      return operations.cancelInput();
    };
    const interactiveGesture = (text, effect) => {
      if (!observeNative()) return Promise.reject(new Error("Native interactive input unavailable"));
      return operations.interactiveGesture(text, effect);
    };
    return Object.freeze({ runtime, configuration, cancelInput, interactiveGesture,
      get inputPending() { return observeNative() && operations.inputPending(); },
      get readiness() { observeNative(); return readiness; },
      get finalResponse() { return observeNative() ? operations.finalResponse() : null; }, close });
  } catch (error) {
    await close();
    // A failed constructor can own a session before the SDK runtime exists.
    if (!dispose && session) session.dispose();
    throw error;
  }
}
