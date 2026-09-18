import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { compact, generateBranchSummary, VERSION } from "@mariozechner/pi-coding-agent";
import { createAssistantMessageEventStream, getApiProvider, registerApiProvider, unregisterApiProviders } from "@mariozechner/pi-ai";

// SDK Model records are JSON-like; copy through readonly SDK facades without
// structuredClone's Proxy rejection. Never retain a mutable/latest model view.
function snapshot(value) {
  if (!value || typeof value !== "object") return value;
  // Native compaction preparation contains Sets, unlike JSON-like Models.
  if (value instanceof Set) return new Set([...value].map(snapshot));
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [snapshot(key), snapshot(item)]));
  return Object.freeze(Array.isArray(value) ? value.map(snapshot)
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)])));
}
function untilAborted(fn, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return fn(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

// Owned-session public SDK aggregate boundary, not a private import/vendor patch.
// Default algorithm outputs are adapter-supplied (native fromExtension=true).
export function installPiOwnedCompaction(session, operations) {
  const runner = session.extensionRunner;
  if (VERSION !== "0.73.0" || typeof runner?.emit !== "function"
    || typeof session.modelRegistry?.getApiKeyAndHeaders !== "function"
    || typeof session.settingsManager?.getBranchSummarySettings !== "function") {
    throw new Error("Owned SDK summary boundary unavailable");
  }
  const emit = runner.emit.bind(runner);
  runner.emit = async event => {
    if (!["session_before_compact", "session_before_tree"].includes(event.type)) return emit(event);
    const kind = event.type;
    const tree = kind === "session_before_tree";
    const nativePreparation = event.preparation;
    const nativeEntries = tree ? nativePreparation.entriesToSummarize : null;
    const preparation = snapshot(nativePreparation);
    const customInstructions = snapshot(event.customInstructions);
    const nativeSignal = event.signal;
    const reference = operations.referenceFor();
    if (!reference || !operations.ownsCurrent()) return { cancel: true };
    // SDK navigateTree keeps this exact freshly collected array across emit's
    // await. Comparisons cannot protect its consumption from queued microtasks.
    // Freeze ONLY the array, not the SessionManager entries it references.
    if (tree) {
      if (!Array.isArray(nativeEntries)) throw new Error("Owned summary preparation unavailable");
      Object.freeze(nativeEntries);
    }
    // Project hooks never receive SDK-retained preparation or entry records.
    // Keep a plain detached view (including native Sets/Maps), so supported
    // result overrides and existing mutation diagnostics remain observable.
    const projectPreparation = structuredClone(preparation);
    const projectEntries = tree ? projectPreparation.entriesToSummarize : null;
    const projectEvent = { ...event, preparation: projectPreparation };
    const originalModel = snapshot(session.model);
    const thinkingLevel = session.thinkingLevel;
    const current = () => operations.ownsCurrent() && isDeepStrictEqual(operations.referenceFor(), reference);
    const options = { signal: nativeSignal };
    const unchanged = () => {
      if (event.type !== kind || event.signal !== nativeSignal
        || projectEvent.type !== kind || projectEvent.signal !== nativeSignal) throw new Error("Owned summary event changed");
      if (event.preparation !== nativePreparation
        || (tree && nativePreparation.entriesToSummarize !== nativeEntries)
        || !isDeepStrictEqual(snapshot(nativePreparation), preparation)
        || projectEvent.preparation !== projectPreparation
        || (tree && projectPreparation.entriesToSummarize !== projectEntries)
        || !isDeepStrictEqual(snapshot(projectPreparation), preparation)) throw new Error("Owned summary preparation changed");
    };
    const result = snapshot(await emit(projectEvent)); // Preserve supported aggregate results/overrides by value.
    unchanged();
    if (result?.cancel) return result;
    const output = await operations.dispatch(async ({ signal }) => {
      if (tree ? result?.summary || !preparation.userWantsSummary || !preparation.entriesToSummarize.length
        : result?.compaction) return result;
      if (!originalModel) throw new Error("Owned summary model unavailable");
      const override = snapshot(result);
      const auth = snapshot(await untilAborted(() => session.modelRegistry.getApiKeyAndHeaders(originalModel), signal));
      if (!current() || !auth?.ok || !auth.apiKey) throw new Error("Owned summary provider credentials unavailable");
      const source = randomUUID();
      const api = `statewright-summary-${source}`;
      const provider = getApiProvider(originalModel.api);
      if (typeof provider?.streamSimple !== "function") throw new Error("Owned summary API provider unavailable");
      let lease = true;
      let tail = Promise.resolve();
      const active = () => lease && current();
      const stream = (_model, context, streamOptions) => {
        const outer = createAssistantMessageEventStream();
        const sameCall = isDeepStrictEqual(operations.referenceFor(), reference);
        const messages = sameCall ? snapshot(context) : null;
        // The alias is publicly discoverable, NOT an input capability. Do not
        // bind/adopt its captured reference on calls from another/unbound scope.
        // Public compact starts split-turn summaries in parallel. Serialize
        // their dispatches so one parked checkpoint does not reject its sibling
        // merely because the same original gate is temporarily held.
        const running = sameCall ? tail.then(async () => {
          if (!sameCall || !active()) throw new Error("Owned summary request unavailable");
          await operations.dispatch(async ({ signal: streamSignal }) => {
            const inner = provider.streamSimple(originalModel, messages, { ...streamOptions, signal: streamSignal,
              maxRetries: 0, // No uncheckpointed client retry where this public option is honored.
              onPayload: async payload => {
                if (!active() || streamSignal.aborted) throw new Error("Owned summary payload unavailable");
                const body = structuredClone(payload);
                return operations.dispatch(() => {
                  const check = () => { if (!active() || streamSignal.aborted) throw new Error("Owned summary payload unavailable"); };
                  return new Proxy(body, {
                    get: (target, key, receiver) => { if (key === "then") return undefined; check(); return Reflect.get(target, key, receiver); },
                    ownKeys: target => { check(); return Reflect.ownKeys(target); },
                    getOwnPropertyDescriptor: (target, key) => { check(); return Reflect.getOwnPropertyDescriptor(target, key); },
                  });
                }, { signal: streamSignal });
              } });
            const iterator = inner[Symbol.asyncIterator]();
            try {
              for (;;) {
                const step = await untilAborted(() => iterator.next(), streamSignal);
                if (!active() || streamSignal.aborted) throw new Error("Owned summary request unavailable");
                if (step.done) break;
                outer.push(step.value);
              }
            } finally { Promise.resolve(iterator.return?.()).catch(() => {}); }
          }, { signal: streamOptions?.signal });
        }) : Promise.reject(new Error("Owned summary request unavailable"));
        if (sameCall) tail = running.catch(() => {});
        running.catch(error => {
          const message = { role: "assistant", content: [], api: originalModel.api, provider: originalModel.provider, model: originalModel.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "error", timestamp: Date.now(), errorMessage: error instanceof Error ? error.message : "Owned summary request unavailable" };
          outer.push({ type: "error", reason: "error", error: message });
          outer.end(message);
        });
        return outer;
      };
      registerApiProvider({ api, stream, streamSimple: stream }, source);
      try {
        const model = Object.freeze({ ...originalModel, api });
        let output;
        if (tree) {
          const summary = await generateBranchSummary(preparation.entriesToSummarize, { model, apiKey: auth.apiKey,
            headers: auth.headers, signal, customInstructions: override?.customInstructions ?? preparation.customInstructions,
            replaceInstructions: override?.replaceInstructions ?? preparation.replaceInstructions,
            reserveTokens: session.settingsManager.getBranchSummarySettings().reserveTokens });
          if (summary.aborted) return { cancel: true };
          if (summary.error) throw new Error(summary.error);
          output = { ...override, summary: { summary: summary.summary,
            details: { readFiles: summary.readFiles ?? [], modifiedFiles: summary.modifiedFiles ?? [] } } };
        } else {
          output = { ...override, compaction: await compact(preparation, model, auth.apiKey, auth.headers,
            customInstructions, signal, thinkingLevel) };
        }
        // The provider may finish after authority changes without a new epoch.
        // Fresh original-reference reconciliation before native persistence/UI.
        return operations.dispatch(() => output, { signal });
      } finally { lease = false; unregisterApiProviders(source); }
    }, options);
    // Diagnose hook-view mutation after owned waits. Its post-return mutation
    // cannot affect the SDK's distinct, immutable retained branch array.
    unchanged();
    return output;
  };
}
