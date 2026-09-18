// SDK0.73.0 private instance binding. The enclosing adapter verifies VERSION
// and owns construction; no private SDK modules or project input capability.
export function bindPiConfigurationSelector({ component, settings, scope, tokenCurrent, uiCalls, observe, keybindings, requestRender,
  session, availableProviderCount }) {
  const input = settings ? component.getSettingsList() : component;
  if (typeof input?.handleInput !== "function" || settings && (!Array.isArray(input.items)
    || typeof input.onChange !== "function" || typeof input.onCancel !== "function")
    || !settings && ["onChange", "onPersist", "onCancel"].some(key => typeof component.callbacks?.[key] !== "function")) {
    throw new Error("Owning configuration selector binding unavailable");
  }
  let busy = false;
  let active = null;
  let cleaning = false;
  const backs = new WeakMap();
  const valid = () => tokenCurrent() && scope.owns();
  const publicationScope = Object.freeze({ ...scope, owns: valid });
  const internal = () => valid() && active && uiCalls.getStore() === active;
  const callbacks = (object, keys) => {
    for (const key of keys) {
      const original = object[key];
      if (typeof original !== "function") continue;
      object[key] = (...args) => {
        if (!(internal() || cleaning && key === "onCancel")) return;
        const result = original.apply(object, args);
        if (active && !cleaning) active.pending.push(Promise.resolve(result));
        return result;
      };
    }
  };
  const cancel = () => tokenCurrent() && scope.current() ? observe(scope, scope.cancel()) : Promise.resolve();
  const snapshot = () => {
    const keys = settings ? ["selectedIndex", "filteredItems", "submenuComponent", "submenuItemIndex"]
      : ["enabledIds", "isDirty", "selectedIndex", "filteredItems"];
    const fields = keys.map(key => [key, input[key]]);
    const values = settings ? input.items.map(item => [item, item.currentValue]) : [];
    const search = input.searchInput?.getValue();
    const submenu = settings && input.submenuComponent;
    const child = submenu && (submenu.selectList ?? submenu.settingsList);
    const childFields = child ? ["selectedIndex", "filteredItems", "submenuComponent", "submenuItemIndex"]
      .map(key => [key, child[key]]) : [];
    const childValues = child?.items?.map(item => [item, item.currentValue]) ?? [];
    const childSearch = child?.searchInput?.getValue();
    const childState = submenu?.state;
    return () => {
      for (const [key, value] of fields) input[key] = value;
      for (const [item, value] of values) item.currentValue = value;
      if (search !== undefined) input.searchInput.setValue(search);
      for (const [key, value] of childFields) child[key] = value;
      for (const [item, value] of childValues) if (value !== undefined) item.currentValue = value;
      if (childSearch !== undefined) child.searchInput.setValue(childSearch);
      if (childState !== undefined) submenu.state = childState;
    };
  };
  const nativeInput = input.handleInput.bind(input);
  const run = data => {
    if (typeof data !== "string" || !tokenCurrent() || !scope.current()) return Promise.resolve();
    const cancellation = settings ? keybindings.matches(data, "tui.select.cancel")
      : data === "\u001b" || data === "\u0003" && !component.searchInput.getValue();
    if (cancellation) {
      const submenu = settings && input.submenuComponent;
      if (submenu && !busy && scope.owns() && backs.has(submenu)) {
        // Audited native back callback: close local submenu/restore its preview,
        // no model/settings persistence. Never confer generic cleanup authority.
        return backs.get(submenu)();
      }
      return cancel();
    }
    if (busy || !valid()) return Promise.resolve();
    busy = true;
    return observe(publicationScope, scope.run(() => {
      if (!valid()) return;
      const transaction = { ...scope, owns: valid, pending: [], publications: [], deferPublications: true };
      return uiCalls.run(transaction, async () => {
        const restore = snapshot();
        active = transaction;
        let commit;
        let committed = false;
        try {
          nativeInput(data);
          commit = snapshot();
          restore(); // Hide staged local success while the SDK callback awaits.
          await Promise.all(transaction.pending);
          if (!valid()) return;
          commit();
          committed = true;
          transaction.deferPublications = false;
          for (const publish of transaction.publications) { if (!valid()) break; publish(); }
          if (valid()) requestRender(); // Native input callers do not await this handler.
        } catch (error) {
          if (!committed) restore(); // A later rendering error must not falsify an applied mutation.
          throw error;
        } finally { active = null; }
      });
    })).finally(() => { busy = false; });
  };
  input.handleInput = data => internal() ? nativeInput(data) : run(data);
  if (settings) {
    callbacks(input, ["onChange"]);
    input.onCancel = cancel;
    for (const item of input.items) {
      if (typeof item.submenu !== "function") continue;
      const create = item.submenu;
      item.submenu = (value, done) => {
        if (!internal()) return;
        const submenu = create(value, selected => { if (internal() || cleaning) done(selected); });
        const list = submenu.selectList ?? submenu.settingsList;
        if (typeof submenu.handleInput !== "function" || typeof list?.onCancel !== "function") {
          throw new Error("Owning configuration submenu binding unavailable");
        }
        if (item.id === "warnings") {
          // Native currentWarnings closes over the attempted value BEFORE its
          // persistence callback. Reopening must use current settings, not that
          // stale closure; keep the actual native component/callback behavior.
          if (!submenu.state || !Array.isArray(list.items) || list.items.length !== 1
            || list.items[0].id !== "anthropic-extra-usage"
            || typeof session.settingsManager?.getWarnings !== "function") {
            throw new Error("Owning warning submenu binding unavailable");
          }
          const warnings = session.settingsManager.getWarnings();
          submenu.state = { ...warnings };
          list.items[0].currentValue = (warnings.anthropicExtraUsage ?? true) ? "true" : "false";
        }
        const back = list.onCancel;
        callbacks(list, ["onSelect", "onChange", "onSelectionChange", "onCancel"]);
        const handle = submenu.handleInput.bind(submenu);
        submenu.handleInput = data => internal() ? handle(data) : run(data);
        backs.set(submenu, () => {
          if (!tokenCurrent() || !scope.current() || input.submenuComponent !== submenu) return Promise.resolve();
          cleaning = true;
          try { uiCalls.run(null, () => back()); } finally { cleaning = false; }
          return Promise.resolve();
        });
        return submenu;
      };
    }
  } else {
    // Native onChange awaits its private resolveModelScope then uses a sync
    // setter, with no fresh authority handoff. UI-generated IDs are literal,
    // not patterns: use public registry/session primitives and checkpoint AFTER
    // lookup, before mutation. The original SDK component/input/save stay native.
    component.callbacks.onChange = async ids => {
      const enabled = ids === null ? null : [...ids];
      const available = await session.modelRegistry.getAvailable();
      const selected = enabled?.length && enabled.length < component.allIds.length
        ? enabled.map(id => available.find(model => `${model.provider}/${model.id}` === id)).filter(Boolean) : [];
      const models = structuredClone(selected.map(model => ({ model, thinkingLevel: undefined })));
      await scope.effect(() => { if (valid()) session.setScopedModels(models); });
      if (!valid()) return;
      const visible = session.scopedModels.length ? session.scopedModels.map(value => value.model) : available;
      availableProviderCount(new Set(visible.map(model => model.provider)).size);
    };
    callbacks(component.callbacks, ["onChange", "onPersist"]);
    component.callbacks.onCancel = cancel;
    // Native refresh runs before async onChange; defer that confirmation too.
    for (const key of ["refresh", "updateList"]) {
      const original = component[key].bind(component);
      component[key] = (...args) => {
        if (!valid()) return;
        if (internal() && active.deferPublications) active.publications.push(() => original(...args));
        else return original(...args);
      };
    }
  }
  return input;
}
