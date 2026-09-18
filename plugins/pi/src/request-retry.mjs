import { VERSION } from "@mariozechner/pi-coding-agent";

// Public, owned-instance seams only. The SDK still owns its retry algorithm.
export function installPiOwnedRetry(session, { producer, callerCanCancel, checkpoint, current, canPublish }) {
  const runner = session.extensionRunner;
  if (VERSION !== "0.73.0" || typeof session.agent?.subscribe !== "function"
    || typeof session.abortRetry !== "function" || typeof session.waitForRetry !== "function"
    || typeof runner?.emitMessageEnd !== "function" || typeof runner?.emitError !== "function"
    || typeof canPublish !== "function") throw new Error("Owned SDK retry boundary unavailable");
  const manager = session.sessionManager;
  const id = manager.getSessionId();
  const file = manager.getSessionFile();
  const native = () => manager.getSessionId() === id && manager.getSessionFile() === file;
  const abort = session.abortRetry.bind(session);
  const wait = session.waitForRetry.bind(session);
  const completed = new WeakSet();
  const settings = session.settingsManager.getRetrySettings.bind(session.settingsManager);
  session.settingsManager.getRetrySettings = (...args) => {
    const source = producer();
    // SDK reads settings immediately before its retry mutations, outside hook
    // catches. Passive native reads have no producer and remain unchanged.
    if (source && completed.has(source) && (!native() || source.signal?.aborted || !current(source.reference))) {
      throw new Error("Native retry request unavailable");
    }
    return settings(...args);
  };
  let retry = null;
  const retire = slot => {
    if (retry !== slot || !native()) return;
    retry = null; // Claim before synchronous abort callbacks can reenter.
    slot.signal.removeEventListener("abort", slot.cancel);
    abort();
  };
  session.abortRetry = () => {
    if (!native() || !callerCanCancel(retry?.reference ?? null)) return;
    if (retry) retire(retry);
    else abort();
  };
  const subscribe = session.subscribe.bind(session);
  session.subscribe = listener => {
    let active = true;
    const unsubscribe = subscribe(event => {
      if (event.type !== "auto_retry_start") return listener(event);
      const source = producer();
      const captured = structuredClone(event);
      const eligible = () => active && source && native() && !source.signal.aborted && canPublish(source);
      const report = error => {
        // A delayed observer outcome is still the original producer's work.
        // Do not publish its fault or invalidate a newer/closed frontend.
        if (!eligible()) return;
        let details;
        try {
          const message = String(error?.message ?? error);
          if (!eligible()) return; // Getter/coercion may reenter native input.
          const stack = error?.stack;
          details = { error: message, stack: typeof stack === "string" ? stack : undefined };
        } catch {
          // Failure visibility does not depend on readable arbitrary metadata.
          // No grant, retry or success result is manufactured by this report.
          details = { error: "Retry-start observer failed; fault details unavailable" };
        }
        if (!eligible()) return;
        runner.emitError({ extensionPath: "statewright:retry-observer",
          event: "auto_retry_start", ...details });
      };
      // Native emits start BEFORE it creates its sleep controller. Projection
      // callbacks must not reenter cancellation in that unabortable interval.
      queueMicrotask(() => {
        if (!eligible()) return;
        try { Promise.resolve(listener(captured)).catch(report); }
        catch (error) { report(error); }
      });
    });
    return () => { active = false; unsubscribe(); };
  };
  session.agent.subscribe(event => {
    const kind = event.type;
    if (!["message_end", "agent_end"].includes(kind)) return;
    const source = producer();
    if (!source?.reference || !(source.signal instanceof AbortSignal)) throw new Error("Native completion producer unavailable");
    if (kind === "agent_end") completed.add(source);
    if (kind !== "agent_end" || !session.isRetrying || retry) return;
    const slot = { reference: source.reference, signal: source.signal, cancel: null };
    slot.cancel = () => retire(slot);
    retry = slot;
    const lifetime = wait(); // Capture this native promise, not a later lookup.
    const done = () => {
      slot.signal.removeEventListener("abort", slot.cancel);
      if (retry === slot) retry = null;
    };
    lifetime.then(done, done);
    slot.signal.addEventListener("abort", slot.cancel, { once: true });
    if (slot.signal.aborted) retire(slot);
  });
  for (const key of ["emit", "emitMessageEnd"]) {
    const emit = runner[key].bind(runner);
    runner[key] = async event => {
      if (!["message_end", "agent_end"].includes(event.type)) return emit(event);
      if (event.type === "message_end" && event.message?.role !== "assistant") return emit(event);
      const source = producer();
      const check = async () => {
        if (!source?.reference || !native() || source.signal?.aborted
          || !await checkpoint(source) || !current(source.reference) || source.signal.aborted) {
          throw new Error("Native completion request unavailable");
        }
      };
      await check();
      const result = await emit(event);
      await check();
      return result;
    };
  }
  return { close() { if (retry) retire(retry); } };
}
