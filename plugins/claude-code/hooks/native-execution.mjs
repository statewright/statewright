// Thin native hook binding to the existing gateway adapter. Claude owns tool
// execution and permissions. Permission-time rewrites are a documented host
// limitation; post observations report actual inputs, never invented effects.
const active = v => Boolean(v.requiresEnforcement || (v.native?.state && !v.native.state.is_final));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
// Adapters are created for each hook invocation. Queue ownership belongs to the
// conversation view, and the running slot includes post_tool completion.
const queues = new WeakMap();
const CANCELLED = 'This native tool call was cancelled before execution.';
const STALE = 'The conversation or workflow changed while this tool was waiting. Read the current state before continuing.';
const UNCERTAIN = 'Statewright could not record the preceding tool safely. Refresh Statewright before continuing.';
function waitForRead(v, record, signal, after) {
  const queue = queues.get(v) ?? [];
  queues.set(v, queue);
  if (v.runningTool.id === record.id || queue.some(entry => entry.record.id === record.id))
    return Promise.resolve('This tool invocation identity is already running or queued.');
  if (queue.length >= 32) return Promise.resolve('The Statewright Read queue is full (32 waiting calls).');
  return new Promise(resolve => {
    let timer, settled = false;
    const finish = reason => {
      if (settled) return;
      settled = true;
      timer?.cancel(); signal?.removeEventListener('abort', abort);
      const index = queue.indexOf(entry);
      if (index !== -1) queue.splice(index, 1);
      resolve(reason);
    };
    const abort = () => finish(CANCELLED);
    const entry = { record, finish };
    queue.push(entry);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else {
      try { timer = after(60_000, () => finish('The Statewright Read queue wait timed out. The running tool was not interrupted.')); }
      catch { finish('Statewright could not schedule this Read safely. Refresh Statewright before continuing.'); }
    }
  });
}
function release(v, record) {
  if (v.runningTool !== record) return;
  v.runningTool = null;
  const queue = queues.get(v);
  if (record.uncertain) {
    for (const entry of [...(queue ?? [])]) entry.finish(UNCERTAIN);
  } else if (queue?.length) {
    const entry = queue[0];
    // Reserve synchronously so a new call cannot overtake an existing waiter.
    v.runningTool = entry.record;
    entry.finish();
  }
}
export function outcome(snapshot) {
  if (snapshot?.outcome?.isError || snapshot?.outcome?.content?.length !== 1) throw new Error('Statewright action failed');
  return JSON.parse(snapshot.outcome.content[0].text);
}
export function createExecutionAdapter({ view, request, fault, after }) {
  return {
    async call($, e, next) {
      const v = await view($);
      if (!active(v)) return next(e);
      if (!e.tool_use_id) return { deny: 'Claude did not provide a tool invocation identity.' };
      if (next.signal?.aborted) return { deny: CANCELLED };
      const record = { id: e.tool_use_id, tool: e.tool, generation: v.generation ?? 0, input: null, checked: false, observed: null, signal: next.signal };
      if (v.runningTool) {
        if (e.tool !== 'Read' || v.runningTool.tool !== 'Read')
          return { deny: 'A Statewright tool is still running. Continue with one tool at a time.' };
        const denied = await waitForRead(v, record, next.signal, after);
        if (denied) return { deny: denied };
      } else v.runningTool = record;
      let result;
      const fail = message => { record.uncertain = true; fault(v, message); };
      try {
        if (await view($) !== v || (v.generation ?? 0) !== record.generation || !active(v)) return { deny: STALE };
        if (next.signal?.aborted) return { deny: CANCELLED };
        if (v.actionBusy || v.controlError) return { deny: 'Refresh Statewright after its current workflow action before continuing.' };
        result = await next(e); return result;
      }
      finally {
        try {
          if (await view($) === v && (v.generation ?? 0) === record.generation && active(v) && record.checked) {
            const o = record.observed;
            if (o) {
              if (!same(record.input, o.tool_input)) fail('Claude changed the tool input during permission handling. The actual result is recorded.');
              outcome(await request($, 'post_tool', { tool_name: record.tool, tool_input: o.tool_input,
                tool_response: o.response, is_error: o.failed }));
            } else if (!result?.deny) fail('Claude did not provide completion evidence for the last tool. Its effects were not counted.');
          }
        } catch { fail('Couldn’t record the last tool result. Refresh Statewright before continuing.'); }
        finally { release(v, record); }
      }
    },
    async check($, e, next) {
      // Native permission handling may wait for a human while Off or resume
      // replaces the workflow. Keep the originating owner across that await.
      const v = await view($), record = v.runningTool, generation = v.generation ?? 0;
      const enforced = active(v), owned = record?.id === e.tool_use_id && record?.tool === e.tool;
      const native = await next(e);
      if (native.decision === 'deny' || !e.tool_use_id) return native;
      if (await view($) !== v || generation !== (v.generation ?? 0) ||
          (enforced && !active(v)) || (owned && record.generation !== generation))
        return { decision: 'deny', reason: STALE };
      if ((owned && record.signal?.aborted) || next.signal?.aborted)
        return { decision: 'deny', reason: CANCELLED };
      if (!active(v)) return native;
      if (!owned || v.runningTool !== record)
        return { decision: 'deny', reason: 'Statewright could not correlate this native tool request.' };
      if (record.checked) return same(record.input, e.input) ? native : { decision: 'deny', reason: 'Tool arguments changed after the workflow check. Submit a new call.' };
      const s = await request($, 'pre_tool', { tool_name: e.tool, tool_input: e.input });
      const decision = outcome(s);
      if (await view($) !== v || record.generation !== (v.generation ?? 0) || !active(v) || v.runningTool !== record)
        return { decision: 'deny', reason: STALE };
      if (record.signal?.aborted || next.signal?.aborted) return { decision: 'deny', reason: CANCELLED };
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
