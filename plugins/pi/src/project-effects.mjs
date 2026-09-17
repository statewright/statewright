import { AsyncLocalStorage } from "node:async_hooks";

// Trusted project callbacks inherit their owning SDK call, never the latest
// request. This does not intercept arbitrary code or establish OS isolation.
const projects = new AsyncLocalStorage();
export const withPiProjectEffects = (operations, callback, bridge) => projects.run({ operations, bridge }, callback);
export const isPiProjectManaged = () => !!projects.getStore();

export function dispatchPiProjectEffect(effect, options) {
  const owner = projects.getStore();
  return owner ? owner.operations.dispatch(context => effect({ ...context, bridge: owner.bridge }), options)
    : effect({ reference: null, signal: undefined, bridge: null });
}

// Capture at call entry, not after headers arrive or when a body is read.
// Response consumption may run outside the originating async callback.
function captureProjectEffect(owner) {
  const run = owner.operations.bind((effect, signal) => withPiProjectEffects(owner.operations,
    () => owner.operations.dispatch(effect, { signal }), owner.bridge));
  const owns = owner.operations.bind(() => owner.operations.ownsCurrent());
  return { run, assertOwned() { if (!owns()) throw new Error("Project request unavailable"); } };
}

async function awaitHttp(effect, signal) {
  if (!signal) return effect();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(new Error("Project request unavailable"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([cancelled, Promise.resolve().then(() => {
      if (signal.aborted) throw new Error("Project request unavailable");
      return effect();
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

function ownedResponse(response, captured, signal) {
  const consume = effect => awaitHttp(() => captured.run(() => awaitHttp(effect, signal), signal), signal);
  const readers = new WeakMap();
  const wrapReader = reader => {
    if (readers.has(reader)) return readers.get(reader);
    const wrapped = new Proxy(reader, { get(object, key) {
      if (key === "read") return (...args) => consume(() => object.read(...args));
      // Cancellation/releasing this response's own resources must remain possible
      // after revocation. They do not admit or publish another request's data.
      const value = Reflect.get(object, key, object);
      return typeof value === "function" ? value.bind(object) : value;
    } });
    readers.set(reader, wrapped);
    return wrapped;
  };
  const wrapBody = body => body && new Proxy(body, { get(object, key) {
    if (key === "getReader") return (options) => {
      captured.assertOwned();
      // BYOB can mutate a caller's buffer before its read promise is checked.
      // The project's HTTP consumers use default readers, not this escape path.
      if (options?.mode !== undefined) throw new Error("Unowned project body operation");
      return wrapReader(object.getReader(options));
    };
    if (key === Symbol.asyncIterator || key === "values") return (options = {}) => {
      captured.assertOwned();
      const reader = wrapReader(object.getReader());
      let finished = false;
      const release = () => { if (!finished) { finished = true; reader.releaseLock(); } };
      return { async next() {
          if (finished) return { done: true, value: undefined };
          try { const result = await reader.read(); if (result.done) release(); return result; }
          catch (error) { release(); throw error; }
        }, [Symbol.asyncIterator]() { return this; },
        async return() { if (finished) return { done: true, value: undefined };
          try { if (!options.preventCancel) await reader.cancel(); } finally { release(); }
          return { done: true, value: undefined }; } };
    };
    if (["pipeTo", "pipeThrough", "tee"].includes(key)) return () => { throw new Error("Unowned project body operation"); };
    const value = Reflect.get(object, key, object);
    return typeof value === "function" ? value.bind(object) : value;
  } });
  const body = wrapBody(response.body);
  return new Proxy(response, { get(object, key) {
    if (key === "body") return body;
    if (["json", "text", "arrayBuffer", "blob", "formData", "bytes"].includes(key)) {
      return (...args) => consume(() => object[key](...args));
    }
    if (key === "clone") return () => { captured.assertOwned(); return ownedResponse(object.clone(), captured, signal); };
    const value = Reflect.get(object, key, object);
    return typeof value === "function" ? value.bind(object) : value;
  } });
}

export async function fetchPiProject(input, init = {}) {
  const owner = projects.getStore();
  if (!owner) return fetch(input, init); // ordinary standalone behavior
  const captured = captureProjectEffect(owner);
  const supplied = init.signal;
  if (supplied != null && !(supplied instanceof AbortSignal)) throw new Error("Invalid project HTTP signal");
  const requestSignal = input instanceof Request ? input.signal : null;
  // Snapshot the declared request before a potentially parked checkpoint.
  const options = { ...init, headers: init.headers ? new Headers(init.headers) : undefined };
  const callerSignal = supplied && requestSignal ? AbortSignal.any([supplied, requestSignal]) : supplied ?? requestSignal;
  let combined;
  const response = await awaitHttp(() => captured.run(({ signal }) => {
    combined = AbortSignal.any([signal, supplied, requestSignal].filter(Boolean));
    // A redirect is another HTTP dispatch; never let fetch follow it invisibly.
    return awaitHttp(() => fetch(input, { ...options, signal: combined, redirect: "error" }), combined);
  }, callerSignal), callerSignal);
  return ownedResponse(response, captured, combined);
}

export function piProjectMethod(pi, key, operations, bridge) {
  const method = pi[key];
  const scoped = callback => (...args) => withPiProjectEffects(operations, () => callback(...args), bridge);
  if (key === "on") return (event, callback) => method.call(pi, event, scoped(callback));
  if (key === "registerTool") return tool => method.call(pi, { ...tool, execute: scoped(tool.execute) });
  if (key === "registerCommand") return (name, command) => method.call(pi, name, { ...command,
    handler: (...args) => operations.command(scoped(command.handler), args) });
  if (key === "registerProvider") return (name, configuration) => method.call(pi, name, { ...configuration,
    // A provider is invoked later by the actual Agent, not in its registration
    // epoch. Restore only the project scope; never bind an old request here.
    ...(configuration.streamSimple ? { streamSimple: scoped(configuration.streamSimple) } : {}),
    ...(configuration.stream ? { stream: scoped(configuration.stream) } : {}),
  });
  if (!["exec", "sendUserMessage", "sendMessage"].includes(key)) return method;
  return (...args) => {
    // Keep a rejection visible to awaiters while void SDK message callers do
    // not produce an unhandled rejection. Denial never invokes a fallback.
    const pending = operations.dispatch(({ signal }) => {
      if (key === "exec") {
        const options = args[2] ?? {};
        const supplied = options.signal;
        if (supplied !== undefined && !(supplied instanceof AbortSignal)) throw new Error("Invalid project exec signal");
        const combined = supplied ? AbortSignal.any([signal, supplied]) : signal;
        combined.throwIfAborted();
        return method.call(pi, args[0], args[1], { ...options, signal: combined });
      }
      return method.apply(pi, args);
    });
    pending.catch(() => {});
    return pending;
  };
}
