import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import { createPiRequestGate } from "./request-gate.mjs";
import { createPiRequestOperations } from "./request-operations.mjs";
import { installPiRequestGuards } from "./request-hooks.mjs";

// Additive owning SDK frontend. Not an extension-context or stock-CLI patch.
// This lifetime binds exactly one parent-owned native UUID; replacement needs
// a new parent binding, never automatic adoption of the SDK's new identity.
export async function createPiRequestFrontend({ nativeSessionId, call, target, servicesOptions = {}, resources = {},
  sessionOptions = {}, gateOptions = {}, register, onReady }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nativeSessionId ?? "")
    || target?.sessionManager?.getSessionId() !== nativeSessionId || typeof call !== "function"
    || typeof register !== "function" || typeof onReady !== "function") throw new Error("Owned SDK frontend unavailable");
  const operations = createPiRequestOperations();
  const gate = createPiRequestGate({ ...gateOptions, nativeSessionId, call, onAdmit: ref => operations.admit(ref) });
  let runtime = null;
  let dispose = null;
  let session = null;
  let closed = false;
  let created = false;
  let bindingStarted = false;
  let readiness = null;
  let closing = null;

  const native = () => { try { return !closed && session?.sessionManager.getSessionId() === nativeSessionId; } catch { return false; } };
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
                if (key !== "on") return Reflect.get(object, key, receiver);
                return (...args) => {
                  if (sealed || closed) unavailable("Managed hook registration is sealed");
                  return on(...args);
                };
              },
              set: () => unavailable("Managed extension API is read-only"),
              defineProperty: () => unavailable("Managed extension API is read-only"),
              deleteProperty: () => unavailable("Managed extension API is read-only"),
              setPrototypeOf: () => unavailable("Managed extension API is read-only"),
            });
            try {
              await register(managed, Object.freeze({ bind: fn => operations.bind(fn) }));
              on("input", (event, ctx) => operations.input(event, ctx));
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
      session.extensionRunner.onError(() => { invalidate(); void close().catch(() => {}); });
      const prompt = session.prompt.bind(session);
      session.prompt = (...args) => observeNative() ? prompt(...args) : Promise.resolve();
      const bind = session.bindExtensions.bind(session);
      session.bindExtensions = async (...args) => {
        if (!observeNative() || bindingStarted) throw new Error("Owned SDK frontend unavailable");
        bindingStarted = true;
        try {
          await bind(...args);
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
    return Object.freeze({ runtime, get readiness() { observeNative(); return readiness; }, close });
  } catch (error) {
    await close();
    // A failed constructor can own a session before the SDK runtime exists.
    if (!dispose && session) session.dispose();
    throw error;
  }
}
