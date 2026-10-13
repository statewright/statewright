// Thin native hook binding to the existing gateway adapter. Claude owns tool
// execution and permissions. Permission-time rewrites are a documented host
// limitation; post observations report actual inputs, never invented effects.
const active = v => Boolean(v.requiresEnforcement || (v.native?.state && !v.native.state.is_final));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function outcome(snapshot) {
  if (snapshot?.outcome?.isError || snapshot?.outcome?.content?.length !== 1) throw new Error('Statewright action failed');
  return JSON.parse(snapshot.outcome.content[0].text);
}
export function createExecutionAdapter({ view, request, fault }) {
  return {
    async call($, e, next) {
      const v = await view($);
      if (!active(v)) return next(e);
      if (v.runningTool) return { deny: 'A Statewright tool is still running. Continue with one tool at a time.' };
      if (!e.tool_use_id) return { deny: 'Claude did not provide a tool invocation identity.' };
      const record = { id: e.tool_use_id, tool: e.tool, generation: v.generation ?? 0, input: null, checked: false, observed: null };
      v.runningTool = record;
      let result;
      try { result = await next(e); return result; }
      finally {
        try {
          if (await view($) === v && (v.generation ?? 0) === record.generation && active(v) && record.checked) {
            const o = record.observed;
            if (o) {
              if (!same(record.input, o.tool_input)) fault(v, 'Claude changed the tool input during permission handling. The actual result is recorded.');
              outcome(await request($, 'post_tool', { tool_name: record.tool, tool_input: o.tool_input,
                tool_response: o.response, is_error: o.failed }));
            } else if (!result?.deny) fault(v, 'Claude did not provide completion evidence for the last tool. Its effects were not counted.');
          }
        } catch { fault(v, 'Couldn’t record the last tool result. Refresh Statewright before continuing.'); }
        finally { if (v.runningTool === record) v.runningTool = null; }
      }
    },
    async check($, e, next) {
      const native = await next(e);
      if (native.decision === 'deny' || !e.tool_use_id) return native;
      const v = await view($);
      if (!active(v)) return native;
      const record = v.runningTool;
      if (!record || record.id !== e.tool_use_id || record.tool !== e.tool)
        return { decision: 'deny', reason: 'Statewright could not correlate this native tool request.' };
      if (record.checked) return same(record.input, e.input) ? native : { decision: 'deny', reason: 'Tool arguments changed after the workflow check. Submit a new call.' };
      const s = await request($, 'pre_tool', { tool_name: e.tool, tool_input: e.input });
      const decision = outcome(s);
      if (decision.decision !== 'allow') return { decision: 'deny', reason: decision.reason || 'This tool is not allowed in the current workflow state.' };
      record.input = JSON.parse(JSON.stringify(e.input)); record.checked = true;
      // An allow from Statewright never replaces a native ask or organization rule.
      return native;
    },
    async observe($, e, failed) {
      const v = await view($), record = v.runningTool;
      if (!record || record.id !== e.tool_use_id || record.tool !== e.tool_name || record.observed) return;
      const raw = failed ? String(e.error ?? 'Native tool failed') : typeof e.tool_response === 'string'
        ? e.tool_response : JSON.stringify(e.tool_response ?? null);
      // Bounded context observation, no transcript or result persistence here.
      record.observed = { tool_input: e.tool_input, response: raw.slice(0, 200000), failed: failed === true };
    },
  };
}
