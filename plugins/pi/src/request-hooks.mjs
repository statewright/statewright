// The host must correlate each native operation with its immutable private
// request reference. A current-state cache or model arguments are not a binder.
export function installPiRequestGuards({ pi, gate, referenceFor }) {
  if (typeof pi?.on !== "function" || typeof gate?.checkpoint !== "function" || typeof gate?.canDispatch !== "function" || typeof referenceFor !== "function") {
    throw new Error("Native request guards require private operation correlation");
  }
  async function admitted(event, ctx, compaction = false) {
    try {
      const signal = compaction ? event.signal : ctx.signal;
      const reference = referenceFor(event, ctx);
      if (!await gate.checkpoint(ctx, signal, reference)) return null;
      const valid = () => gate.canDispatch(ctx, signal, reference, { compaction });
      return valid() ? valid : null;
    } catch { return null; } // SDK hook exceptions alone would fail open.
  }
  pi.on("before_provider_request", async (event, ctx) => {
    const valid = await admitted(event, ctx);
    // SDK lacks a cancel result for this hook and catches hook exceptions.
    // Delay rejection until the provider consumes its payload, outside that
    // catch. The installed primary adapter reads body.stream before HTTP;
    // serialization/spread are denied too. This is not a fallback payload.
    const denied = () => { throw new Error("Statewright request not admitted; provider dispatch blocked"); };
    // Promise assimilation probes `then` while the SDK still catches handler
    // failures. Permit only that inert probe; throw when the provider reads
    // the payload, after the runner has returned it successfully.
    const check = () => { if (!valid?.()) denied(); };
    // Recheck on actual payload use, not just before the helper's async return.
    // This remains adapter-specific evidence, not a lease across SDK internals.
    return new Proxy(valid ? event.payload : Object.create(null), {
      get: (target, key, receiver) => { if (key === "then") return undefined; check(); return Reflect.get(target, key, receiver); },
      ownKeys: target => { check(); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor: (target, key) => { check(); return Reflect.getOwnPropertyDescriptor(target, key); },
    });
  });
  pi.on("tool_call", async (event, ctx) => {
    const valid = await admitted(event, ctx);
    if (!valid?.()) return { block: true, reason: "Statewright native request is held" };
  });
  pi.on("tool_result", async (event, ctx) => { await admitted(event, ctx); });
  pi.on("session_before_compact", async (event, ctx) => {
    const valid = await admitted(event, ctx, true);
    if (!valid?.()) return { cancel: true };
  });
  pi.on("session_before_tree", async (event, ctx) => {
    const valid = await admitted(event, ctx, true);
    if (!valid?.()) return { cancel: true };
  });
}
