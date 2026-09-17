import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";

// Private call identity, not prompt text, a model argument or the latest cache.
// Install only on a task-owned SDK session, before its first prompt.
export function createPiRequestOperations() {
  const calls = new AsyncLocalStorage();
  let session = null;
  let gate = null;
  let closed = false;
  let newestInput = null;
  let activeAgent = null;
  let asides = [];
  const copy = reference => reference ? Object.freeze(structuredClone(reference)) : null;
  const context = () => session.extensionRunner.createContext();
  const reference = () => closed ? null : calls.getStore()?.reference ?? null;
  const inherited = (ref, fn) => calls.run({ kind: "inherited", reference: copy(ref) }, fn);
  const owned = ref => { try { return !closed && !!ref && gate.ownsRequest(context(), ref); } catch { return false; } };

  return {
    admit(ref) {
      const call = calls.getStore();
      if (closed || call?.kind !== "input" || call.entry !== newestInput || call.reference) throw new Error("Private explicit-input call unavailable");
      call.reference = copy(ref);
    },
    referenceFor() { return copy(reference()); },
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
        const entry = Symbol("private explicit input");
        newestInput = entry;
        const run = activeAgent;
        // Explicit input invalidates before commands, expansion or preflight.
        // clearQueue is synchronous; old retries remain bound to their old call.
        void gate.cancel("superseded").catch(() => {});
        session.clearQueue();
        asides = [];
        // clearQueue emits synchronous public listeners. Their changes cannot
        // authorize an abort or SDK entry using ownership checked before them.
        const abortContext = context();
        if (entry !== newestInput || !gate.ownsNative(abortContext)) return Promise.resolve();
        // Commands may never emit input. Interrupt the known owned Agent now,
        // not only if a later SDK input hook happens to call ctx.abort().
        if (run && abortContext.signal === run.signal && isDeepStrictEqual(run.reference, gate.reference)) {
          void session.abort().catch(() => {});
        }
        return calls.run({ kind: "input", source, entry, reference: null }, () => prompt(text, options));
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
          const result = start(...args);
          const signal = session.agent.signal;
          const run = signal && signal !== previousSignal ? { reference: ref, signal } : null;
          if (run) activeAgent = run;
          try { return await result; } finally { if (run && activeAgent === run) activeAgent = null; }
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
      asides = [];
      const cancelled = gate?.cancel("disconnected");
      if (nativeOwned) await session.abort();
      await cancelled;
      // Keep guards installed: late SDK timers must remain held after close.
    },
  };
}
