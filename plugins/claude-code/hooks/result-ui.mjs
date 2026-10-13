// Render the result of THIS call, never the live workspace or another call.
// Deterministic presentation: no model request and no mutation of tool output.
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const label = key => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
const clean = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
const short = (value, max = 240) => { const s = clean(value); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
const text = v => typeof v === 'string' && v.trim() ? v : undefined;
const message = v => text(v) ?? (object(v) ? text(v.message) : undefined);
const owned = tool => /^mcp__statewright__statewright_(connect|get_state|load_workflow|transition|deactivate|request_approval)$/.test(tool);
const textEnvelope = v => Array.isArray(v.content) && v.content.length === 1 && v.content[0]?.type === 'text' && typeof v.content[0].text === 'string';
const cardKey = async ($, e) => `${await $.session.id()}:${e.surface}:${e.props.tool}:${e.props.tool_use_id}`;
export function resultSummary(output) {
  let value = output;
  // Native plugin tools return a JSON string; MCP tools may wrap text blocks.
  if (object(value) && Array.isArray(value.content)) {
    if (value.isError || !textEnvelope(value)) return null;
    value = value.content[0].text;
  }
  if (typeof value === 'string') {
    if (value.length > 131072) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!object(value)) return null;
  let outcome = value.outcome;
  let failed = value.isError === true || Boolean(value.error) || outcome?.isError === true;
  if (object(outcome) && 'content' in outcome) {
    if (!textEnvelope(outcome)) return null; // Never hide mixed/media/error detail.
    outcome = outcome.content[0].text;
  }
  if (typeof outcome === 'string') {
    if (outcome.length > 131072) return null;
    try { outcome = JSON.parse(outcome); } catch { /* A plain outcome is already readable. */ }
  }
  failed ||= outcome?.isError === true || Boolean(outcome?.error);
  const state = object(value.state) ? value.state : null;
  const pending = state?.pending_approval ?? value.pending_approval;
  const currentState = value.state === null ? 'No active workflow' : text(value.state) ?? text(state?.state) ?? text(value.current_state);
  const transition = object(outcome) ? outcome : value;
  // Only the exact successful receipt proves a move. A pending target is not
  // a completed transition, and an old/global UI snapshot cannot supply from.
  const moved = !failed && !pending && transition.transitioned === true && text(transition.from) && text(transition.to) &&
    (currentState === undefined || currentState === transition.to);
  const rows = [];
  const row = (label, value, attention = false) => { if (value !== undefined) rows.push({ label, value: short(value), attention }); };
  row('State', moved ? `${transition.from} => ${transition.to}` : currentState);
  row('Outcome', failed ? 'Error' : text(outcome?.status) ?? text(value.status) ?? (moved ? 'Transitioned' : undefined) ?? text(outcome) ??
    (value.outcome != null && !outcome?.decision && !outcome?.disposition ? message(outcome) ?? 'No outcome detail' : undefined), failed);
  const allowed = state?.allowed_tools ?? value.allowed_tools;
  if (Array.isArray(allowed) && allowed.every(t => typeof t === 'string'))
    row('Allowed tools', !allowed.length ? 'None' : allowed.slice(0, 12).join(', ') + (allowed.length > 12 ? `, … +${allowed.length - 12}` : ''));
  row('Disposition', pending ? 'Awaiting approval' : text(outcome?.disposition) ?? text(outcome?.decision) ?? text(value.disposition) ?? text(value.decision), Boolean(pending));
  const reasons = [message(value.error), message(outcome?.error), failed ? text(outcome) : undefined,
    text(outcome?.reasoning) ?? text(outcome?.reason) ?? text(outcome?.rationale) ?? message(outcome),
    text(value.reasoning) ?? text(value.reason) ?? text(value.rationale) ?? text(value.executionUnavailableReason) ?? text(value.message),
    message(pending)].filter(Boolean);
  if (reasons.length) row('Reasoning', [...new Set(reasons)].join(' · '), failed || Boolean(pending));
  return rows.length ? { rows } : null;
}
export function registerResultUI(on, purple) {
  // Keys belong to rendered historical calls, not a mutable current snapshot.
  const expanded = new Set();
  const cards = new Set();
  // Own the whole completed call, including grouped/verbose rows. Replacing
  // only ToolResult leaves the native ToolUse header/inline JSON above it.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!owned(e.props.tool)) return next(e);
    const ownership = await cardKey($, e);
    const summary = resultSummary(e.props.output);
    if (e.props.isErrored || e.props.isRunning || e.props.isInterrupted || !summary) {
      if (cards.delete(ownership)) $.ui.invalidate('ui.render');
      return next(e);
    }
    const { Box, Text, Button } = $.ui.resolve(e);
    const key = `${await $.session.id()}:${e.props.tool_use_id}`;
    const raw = expanded.has(key);
    const title = label(e.props.tool.split('__').at(-1).replace(/^statewright_/, ''));
    const card = Box({ borderStyle: 'round', borderColor: purple, flexDirection: 'column', paddingX: 1, children: [
      Text({ bold: true, color: purple, children: [`statewright.ai ∞ › ${title}`] }),
      ...(raw ? [Text({ children: [JSON.stringify({ input: e.props.input,
        output: typeof e.props.output === 'string' ? JSON.parse(e.props.output) : e.props.output }, null, 2)] })] : summary.rows.map(row => Text({ children: [
        Text({ bold: true, color: row.attention ? '#FFD580' : purple, children: [`${row.label}  `] }),
        Text({ children: [row.value] }),
      ] }))),
      Button({ key: 'result-details', label: raw ? '▾ Summary' : '▸ Details', plain: true, onPress: () => {
        if (raw) expanded.delete(key); else { if (expanded.size >= 128) expanded.delete(expanded.values().next().value); expanded.add(key); }
        $.ui.invalidate('ui.render');
      } }),
    ].filter(Boolean) });
    if (!cards.has(ownership)) {
      if (cards.size >= 512) cards.delete(cards.values().next().value);
      cards.add(ownership);
      $.ui.invalidate('ui.render');
    }
    return card;
  });
  // Standalone calls get a second result slot; the whole-call card above owns
  // its output already. Unrecognized results and native failures stay native.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) =>
    owned(e.props.tool) && !e.props.isErrored && resultSummary(e.props.output) && cards.has(await cardKey($, e))
      ? $.ui.resolve(e).Box({ children: [] }) : next(e));
}
