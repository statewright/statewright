import { AsyncLocalStorage } from "node:async_hooks";
import { InteractiveMode, ModelSelectorComponent, VERSION } from "@mariozechner/pi-coding-agent";

// Explicit private INSTANCE ABI, not a public SDK hook. See ADR009. Never hand
// this mode-only capability to extension/project contexts or raw SDK sessions.
export function installPiInteractiveConfiguration(mode, gesture) {
  const entries = ["cycleThinkingLevel", "cycleModel", "handleModelCommand", "showModelSelector", "handleNameCommand"];
  const publications = ["showStatus", "showError", "showWarning", "updateEditorBorderColor", "checkDaxnutsEasterEgg"];
  const targets = [[mode.ui, "requestRender"], [mode.ui, "setFocus"], [mode.footer, "invalidate"],
    [mode.chatContainer, "addChild"], [mode.defaultEditor, "setText"],
    ...(mode.editor === mode.defaultEditor ? [] : [[mode.editor, "setText"]])];
  if (VERSION !== "0.73.0" || !(mode instanceof InteractiveMode) || typeof gesture !== "function"
    || [...entries, ...publications, "showSelector", "setupEditorSubmitHandler"].some(key => typeof mode[key] !== "function")
    || targets.some(([object, key]) => typeof object?.[key] !== "function")) {
    throw new Error("Owning interactive configuration binding unavailable");
  }
  const uiCalls = new AsyncLocalStorage();
  let selectorToken = null;
  let detachSelector = null;
  const allowed = () => !uiCalls.getStore() || uiCalls.getStore().owns();
  for (const [object, key] of [...publications.map(key => [mode, key]), ...targets]) {
    const original = object[key].bind(object);
    object[key] = (...args) => { if (allowed()) return original(...args); };
  }
  const observe = (scope, promise) => {
    // Native key/component callers are void. Retain an awaitable for tests and
    // editor submitters while observing denial, never unowned retry/fallback.
    const result = Promise.resolve(promise).catch(error => {
      if (scope?.owns()) uiCalls.run(scope, () => mode.showError(error instanceof Error ? error.message : String(error)));
    });
    return result;
  };
  const invoke = (text, fn) => {
    let scope;
    return observe(null, gesture(text, captured => {
      scope = captured;
      return uiCalls.run(captured, fn);
    }).catch(error => {
      if (scope?.owns()) uiCalls.run(scope, () => mode.showError(error instanceof Error ? error.message : String(error)));
    }));
  };
  const submit = mode.setupEditorSubmitHandler.bind(mode);
  mode.setupEditorSubmitHandler = () => {
    submit();
    const original = mode.defaultEditor.onSubmit;
    if (typeof original !== "function") throw new Error("Owning interactive submit binding unavailable");
    mode.defaultEditor.onSubmit = text => {
      const command = typeof text === "string" ? text.trim() : "";
      if (!["/model", "/name"].some(name => command === name || command.startsWith(name + " "))) return original(text);
      // SDK clears the editor before /model lookup and without awaiting /name.
      // Own the outer native callback too, not just its private helper.
      return invoke(JSON.stringify({ gesture: "editor-submit", text: command }), () => original(text));
    };
  };
  const selector = mode.showSelector.bind(mode);
  mode.showSelector = create => {
    const scope = uiCalls.getStore();
    if (!scope) {
      detachSelector?.(true); // Native UI replacement dismisses the captured original gesture too.
      return selector(create); // Other settings/selectors remain outside this bounded cut.
    }
    if (!scope.owns()) return;
    detachSelector?.();
    const token = Symbol("private native selector");
    selectorToken = token;
    let rawDone;
    let selected = false;
    const finish = cleanup => {
      if (selectorToken !== token || !cleanup && !scope.owns()) return;
      detachSelector();
      // Resource cleanup is exact-token only, not permission to publish old results.
      uiCalls.run(cleanup ? null : scope, () => { rawDone(); mode.ui.requestRender(); });
    };
    const revoked = () => finish(true);
    detachSelector = (dismiss = false) => {
      scope.signal.removeEventListener("abort", revoked);
      if (selectorToken === token) { selectorToken = null; detachSelector = null; }
      // Remove the old cleanup listener BEFORE cancellation; it must never
      // restore its editor over the replacement UI. Cancel only captured work.
      if (dismiss) void observe(scope, scope.cancel());
    };
    selector(done => {
      rawDone = done;
      // Component load/render promises also retain the exact UI lease, even
      // when another non-configuration selector replaces it in the same epoch.
      const selectorScope = Object.freeze({ ...scope, owns: () => scope.owns() && selectorToken === token });
      const result = uiCalls.run(selectorScope, () => create(() => finish(false)));
      const component = result.component;
      if (!(component instanceof ModelSelectorComponent)
        || ["handleSelect", "onSelectCallback", "onCancelCallback"].some(key => typeof component[key] !== "function")) {
        detachSelector();
        throw new Error("Owning model selector binding unavailable");
      }
      const select = component.onSelectCallback.bind(component);
      const nativeSelect = component.handleSelect.bind(component);
      let selection;
      let selecting = false;
      component.onSelectCallback = model => {
        // This field is also delayed/capturable. It may enter the native
        // callback only from the checkpointed original-selector entry.
        if (!selecting || selectorToken !== token || uiCalls.getStore() !== scope || !scope.owns()) return Promise.resolve();
        selection = select(model);
        return selection;
      };
      component.handleSelect = model => {
        if (selected || selectorToken !== token || !scope.owns()) return Promise.resolve();
        selected = true;
        return observe(scope, scope.run(() => uiCalls.run(scope, async () => {
          if (selectorToken !== token || !scope.owns()) return;
          // The native helper saves the default BEFORE its callback. Admission
          // and original-reference checkpoint must therefore precede this call.
          selecting = true;
          try { nativeSelect(model); } finally { selecting = false; }
          await selection;
        })));
      };
      component.onCancelCallback = () => {
        if (selectorToken !== token || !scope.current()) return Promise.resolve();
        selected = true;
        // Selector Escape/Ctrl+C must also interrupt an already-selected
        // callback parked at checkpoint. Never wait for approval to dismiss.
        // Its signal invokes exact-token resource cleanup via revoked above.
        return observe(scope, scope.cancel());
      };
      scope.signal.addEventListener("abort", revoked, { once: true });
      return result;
    });
  };
  for (const key of entries) {
    const original = mode[key].bind(mode);
    mode[key] = (...args) => {
      const inherited = uiCalls.getStore();
      // /model opens its selector inside the same captured gesture, never a
      // second input whose admission could adopt newer work.
      if (inherited) return inherited.owns() ? original(...args) : undefined;
      return invoke(JSON.stringify({ gesture: key, args }), () => original(...args));
    };
  }
}
