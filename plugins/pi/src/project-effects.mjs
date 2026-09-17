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

export function piProjectMethod(pi, key, operations, bridge) {
  const method = pi[key];
  const scoped = callback => (...args) => withPiProjectEffects(operations, () => callback(...args), bridge);
  if (key === "on") return (event, callback) => method.call(pi, event, scoped(callback));
  if (key === "registerTool") return tool => method.call(pi, { ...tool, execute: scoped(tool.execute) });
  if (key === "registerCommand") return (name, command) => method.call(pi, name, { ...command,
    handler: (...args) => operations.command(scoped(command.handler), args) });
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
