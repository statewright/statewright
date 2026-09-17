import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { createLocalBashOperations } from "@mariozechner/pi-coding-agent";

// Private call identity, not prompt text, a model argument or the latest cache.
// Install only on a task-owned SDK session, before its first prompt.
export function createPiRequestOperations() {
  const calls = new AsyncLocalStorage();
  let session = null;
  let gate = null;
  let closed = false;
  let newestInput = null;
  let activeAgent = null;
  let activeBash = null;
  let asides = [];
  let latestResponse = null;
  const outputWaiters = new Set();
  const copy = reference => reference ? Object.freeze(structuredClone(reference)) : null;
  const context = () => session.extensionRunner.createContext();
  const reference = () => closed ? null : calls.getStore()?.reference ?? null;
  const inherited = (ref, fn) => calls.run({ kind: "inherited", reference: copy(ref) }, fn);
  const owned = ref => { try { return !closed && !!ref && gate.ownsRequest(context(), ref); } catch { return false; } };
  const explicit = (text, source, fn) => {
    if (closed || calls.getStore() || !gate.ownsNative(context())) return Promise.resolve();
    const entry = Symbol("private explicit input");
    newestInput = entry;
    latestResponse = null;
    const run = activeAgent;
    void gate.cancel("superseded").catch(() => {});
    session.clearQueue();
    asides = [];
    const abortContext = context();
    if (entry !== newestInput || !gate.ownsNative(abortContext)) return Promise.resolve();
    if (run && abortContext.signal === run.signal && isDeepStrictEqual(run.reference, gate.reference)) {
      void session.abort().catch(() => {});
    }
    return calls.run({ kind: "input", text, source, entry, reference: null }, fn);
  };
  const admitCommand = async () => {
    const call = calls.getStore();
    if (closed || !call) return false;
    if (call.reference) return owned(call.reference);
    if (call.kind !== "input" || call.entry !== newestInput) return false;
    const result = await gate.input({ text: call.text, source: call.source }, context());
    return result.action === "continue" && call.entry === newestInput && owned(call.reference);
  };
  const drainOutput = async ref => {
    while (owned(ref)) {
      const pending = [...outputWaiters].filter(waiter => isDeepStrictEqual(waiter.reference, ref));
      if (!pending.length) return;
      await Promise.all(pending.map(waiter => waiter.delivered));
    }
  };

  return {
    admit(ref) {
      const call = calls.getStore();
      if (closed || call?.kind !== "input" || call.entry !== newestInput || call.reference) throw new Error("Private explicit-input call unavailable");
      call.reference = copy(ref);
    },
    referenceFor() { return copy(reference()); },
    finalResponse() {
      return latestResponse && owned(latestResponse.reference) ? structuredClone(latestResponse.message) : null;
    },
    async command(handler, args) {
      // Extension commands precede the SDK input hook; admission belongs here.
      if (!await admitCommand()) return;
      return this.dispatch(() => handler(...args));
    },
    ownsCurrent() { return owned(reference()); },
    staleCall() {
      try { const call = calls.getStore(); return !!call?.reference && gate.isSuperseded(context(), call.reference); }
      catch { return false; }
    },
    async dispatch(effect, { observation = false, signal: supplied } = {}) {
      const ref = copy(reference());
      const unavailable = () => { throw new Error("Project request unavailable"); };
      if (supplied != null && !(supplied instanceof AbortSignal)) unavailable();
      const control = () => !closed && !calls.getStore() && (!session || gate.matchesNative(context()));
      // Only designated read-only state observation may precede admission.
      // An explicit input with no admitted reference is not bootstrap control.
      if (!ref) {
        if (!observation || !control()) unavailable();
        const result = await effect({ reference: null, signal: undefined });
        if (!control()) unavailable();
        return result;
      }
      if (!owned(ref)) unavailable();
      const epochSignal = gate.operationSignal(context(), ref);
      if (!(epochSignal instanceof AbortSignal)) unavailable();
      const signal = supplied ? AbortSignal.any([epochSignal, supplied]) : epochSignal;
      if (signal.aborted) unavailable();
      if (!observation && !await gate.checkpoint(context(), signal, ref)) unavailable();
      if (!owned(ref) || signal.aborted) unavailable();
      const result = await effect({ reference: ref, signal });
      // An old result cannot authorize its caller's next declared effect.
      if (!owned(ref) || signal.aborted) unavailable();
      return result;
    },
    hasConsumedApproval(approvalId) {
      const ref = reference();
      return owned(ref) && gate.hasConsumedApproval(context(), ref, approvalId);
    },
    bind(fn) {
      const ref = copy(reference());
      if (typeof fn !== "function" || !ref) throw new Error("Private inherited call unavailable");
      return (...args) => inherited(ref, () => fn(...args));
    },
    async input(event, ctx) {
      try {
        const call = calls.getStore();
        if (closed || !gate || !call) return { action: "handled" };
        if (call.kind === "input" && event.source === call.source) {
          // SDK slash/command lookup can await before it emits input.
          // Arrival order at this hook is not explicit invocation order.
          if (call.entry !== newestInput) return { action: "handled" };
          const result = await gate.input(event, ctx);
          return call.entry === newestInput && result.action === "continue" && gate.ownsRequest(ctx, reference()) ? result : { action: "handled" };
        }
        const ref = reference();
        if (event.source !== "extension" || !ref) return { action: "handled" };
        if (!await gate.checkpoint(ctx, undefined, ref) || !gate.ownsRequest(ctx, ref)) return { action: "handled" };
        return { action: "continue" };
      } catch { return { action: "handled" }; } // SDK input exceptions fail open.
    },
    install({ session: target, gate: requestGate }) {
      if (session || closed || typeof target?.prompt !== "function" || typeof target?.compact !== "function"
        || typeof target?.clearQueue !== "function" || typeof target?.sendCustomMessage !== "function"
        || typeof target?.extensionRunner?.createContext !== "function"
        || ["prompt", "continue", "steer", "followUp"].some(key => typeof target?.agent?.[key] !== "function")
        || ["checkpoint", "ownsNative", "ownsRequest", "cancel"].some(key => typeof requestGate?.[key] !== "function")) {
        throw new Error("Owned public SDK request boundary unavailable");
      }
      session = target;
      gate = requestGate;
      const prompt = session.prompt.bind(session);
      const compact = session.compact.bind(session);
      const custom = session.sendCustomMessage.bind(session);
      const subscribe = session.subscribe.bind(session);
      // SDK queues extension processing before public delivery/persistence.
      // These public boundaries recheck the originating ALS scope after awaits.
      subscribe(event => {
        const ref = copy(reference());
        if (event.type === "message_end" && event.message.role === "assistant" && owned(ref)) {
          latestResponse = { reference: ref, message: structuredClone(event.message) };
        }
        if (event.type === "agent_end") {
          for (const waiter of outputWaiters) if (isDeepStrictEqual(waiter.reference, ref)
            && waiter.outputToken === calls.getStore()?.outputToken) waiter.finish();
        }
      });
      session.subscribe = listener => subscribe(event => {
        if (owned(reference()) || event.type === "queue_update" && !closed && gate.matchesNative(context())) return listener(event);
      });
      for (const key of ["appendMessage", "appendCustomMessageEntry"]) {
        const append = session.sessionManager[key].bind(session.sessionManager);
        session.sessionManager[key] = (...args) => {
          if (!owned(reference())) throw new Error("Native output request unavailable");
          return append(...args);
        };
      }
      const bash = session.executeBash.bind(session);
      const recordBash = session.recordBashResult.bind(session);
      session.recordBashResult = (...args) => {
        // Never deposit reference-less results in the SDK shared pending queue.
        if (!owned(reference()) || session.isStreaming) throw new Error("Native command request unavailable");
        return recordBash(...args);
      };
      // SDK has one mutable bash controller; an older finally can clear a
      // newer one. Cancellation/status use this exact private run instead.
      Object.defineProperty(session, "isBashRunning", { configurable: true, get: () => !closed && !!activeBash });
      session.abortBash = () => {
        const ref = calls.getStore() ? reference() : copy(gate.reference);
        if (activeBash && owned(ref) && isDeepStrictEqual(activeBash.reference, ref)) {
          void gate.cancel("cancelled").catch(() => {});
        }
      };
      session.executeBash = (text, onChunk, options = {}) => {
        const execute = async () => {
          if (!await admitCommand()) throw new Error("Native command request unavailable");
          const ref = copy(reference());
          const signal = gate.operationSignal(context(), ref);
          if (!owned(ref) || !signal || session.isStreaming) throw new Error("Native command request unavailable");
          if (!await gate.checkpoint(context(), signal, ref) || !owned(ref)) throw new Error("Native command request unavailable");
          const backend = options.operations ?? createLocalBashOperations({ shellPath: session.settingsManager.getShellPath() });
          const operations = { exec: (command, cwd, sdkOptions) => {
            const combined = AbortSignal.any([signal, sdkOptions.signal]);
            if (!owned(ref) || combined.aborted) throw new Error("Native command request unavailable");
            return backend.exec(command, cwd, { ...sdkOptions, signal: combined, onData: data => {
              // Before SDK accumulation/temp-file writes and mode chunk delivery.
              if (owned(ref) && !combined.aborted) sdkOptions.onData(data);
            } });
          } };
          const run = { reference: ref };
          activeBash = run;
          try {
            const result = await bash(text, onChunk, { ...options, operations });
            if (!owned(ref) || signal.aborted) throw new Error("Native command request unavailable");
            return result;
          } finally { if (activeBash === run) activeBash = null; }
        };
        if (calls.getStore()) return execute(); // inherited calls never become human input
        return explicit(text, "interactive", execute).then(result => {
          if (!result) throw new Error("Native command request unavailable");
          return result;
        });
      };
      session.prompt = (text, options = {}) => {
        const source = options.source ?? "interactive";
        if (closed || !gate.ownsNative(context())) return Promise.resolve();
        if (source === "extension") {
          const ref = reference();
          if (!ref || !owned(ref)) return Promise.resolve();
          return inherited(ref, () => prompt(text, options));
        }
        if (!["interactive", "rpc"].includes(source)) return Promise.resolve();
        // A delayed inherited/model callback cannot assert user origin merely
        // by changing the source option. User frontends enter outside this scope.
        if (calls.getStore()) return Promise.resolve();
        return explicit(text, source, async () => {
          const value = await prompt(text, options);
          // Only the external input waits for publication. A project message
          // hook can await a nested core turn without awaiting its own queue.
          await drainOutput(copy(reference()));
          return value;
        });
      };
      session.compact = (...args) => {
        // A direct manual action captures now; nested automatic work inherits.
        // An unbound existing call cannot borrow a newer manual-action scope.
        const ref = calls.getStore() ? reference() : copy(gate.reference);
        if (!owned(ref)) return Promise.reject(new Error("Owned compaction request unavailable"));
        return inherited(ref, () => compact(...args));
      };
      session.sendCustomMessage = async (message, options) => {
        const ref = copy(reference());
        if (!owned(ref) || !await gate.checkpoint(context(), undefined, ref) || !owned(ref)) return;
        if (options?.deliverAs === "nextTurn") {
          if (asides.length >= 256) throw new Error("Private next-turn queue capacity exceeded");
          // Never put inherited asides in the SDK's unowned shared queue.
          asides.push({ reference: ref, message: structuredClone(message) });
          return;
        }
        return custom(message, options);
      };
      for (const key of ["prompt", "continue"]) {
        const start = session.agent[key].bind(session.agent);
        session.agent[key] = async (...args) => {
          const ref = copy(reference());
          if (!owned(ref) || !await gate.checkpoint(context(), undefined, ref) || !owned(ref)) return;
          if (key === "prompt" && Array.isArray(args[0])) {
            const pending = asides.filter(entry => isDeepStrictEqual(entry.reference, ref));
            asides = asides.filter(entry => !isDeepStrictEqual(entry.reference, ref));
            args[0] = [...args[0], ...pending.map(({ message }) => ({ ...message, role: "custom", timestamp: Date.now() }))];
          }
          const previousSignal = session.agent.signal;
          if (outputWaiters.size >= 256) throw new Error("Private output queue capacity exceeded");
          const outputToken = Symbol("private Agent output run");
          let resolveDelivery;
          const delivered = new Promise(resolve => { resolveDelivery = resolve; });
          const cancelSignal = gate.operationSignal(context(), ref);
          const finish = () => {
            outputWaiters.delete(waiter);
            cancelSignal.removeEventListener("abort", finish);
            resolveDelivery();
          };
          const waiter = { reference: ref, outputToken, delivered, finish };
          outputWaiters.add(waiter);
          cancelSignal.addEventListener("abort", finish, { once: true });
          let run = null;
          try {
            const result = calls.run({ kind: "agent", reference: ref, outputToken }, () => start(...args));
            const signal = session.agent.signal;
            run = signal && signal !== previousSignal ? { reference: ref, signal } : null;
            if (run) activeAgent = run;
            return await result;
          } catch (error) { finish(); throw error; } finally {
            if (run && activeAgent === run) activeAgent = null;
          }
        };
      }
      for (const key of ["steer", "followUp"]) {
        const enqueue = session.agent[key].bind(session.agent);
        session.agent[key] = (...args) => { if (owned(reference())) return enqueue(...args); };
      }
    },
    async close() {
      let nativeOwned = false;
      try { nativeOwned = !!session && gate.ownsNative(context()); } catch { /* unavailable context cannot authorize abort */ }
      closed = true;
      latestResponse = null;
      for (const waiter of outputWaiters) waiter.finish();
      asides = [];
      const cancelled = gate?.cancel("disconnected");
      if (nativeOwned) await session.abort();
      await cancelled;
      // Keep guards installed: late SDK timers must remain held after close.
    },
  };
}
