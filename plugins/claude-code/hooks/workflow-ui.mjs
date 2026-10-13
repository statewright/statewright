// Presentation only. All inputs are verified native snapshots; graph edges
// describe possible transitions, never authorization or predicted execution.
import { claudeRoute } from './native-routing.mjs';
export const ARBITER_PURPLE = '#BA97ED';
export const ARBITER_ACCENT = '#8BD5E8';
export const STATE_BACKGROUND = '#30264A';
export const eventSymbol = event => `:${event.toLowerCase()}`;

function modelName(model, compact) {
  const match = /^claude-(haiku|sonnet|opus|fable)-(\d+)-(\d+)(?:-\d{8})?$/.exec(model);
  return match ? `${match[1][0].toUpperCase()}${match[1].slice(1)}${compact ? '' : ` ${match[2]}.${match[3]}`}` : model;
}
export function modelPresentation(view, compact = false) {
  const active = view.modelActivity;
  const label = (model, effort) => `${modelName(model, compact)}${compact ? '/' : ' / '}${effort ?? 'default'}`;
  // A native request may still be streaming after one of its tools changes the
  // workflow. Show that request until it settles, not the next state's model.
  if (active) return `${label(active.model, active.effort)}${active.fallback ? compact ? '↘' : ' · fallback' : ''}${compact ? '…' : ' · running'}`;
  if (!view.connected || view.busy || view.actionBusy || view.controlError || view.routeError) return '';
  try {
    const route = claudeRoute(view.native?.state);
    if (route && view.fallback?.from === route.model && view.fallback.generation === view.generation && view.fallback.runId === view.native?.state?.run_id)
      return `${compact ? '→' : 'next '}${label('claude-opus-5-5', route.effort)}${compact ? '↘' : ' · fallback'}`;
    if (route) return `${compact ? '→' : 'next '}${label(route.model, route.effort)}`;
    // The host's current selection, not the last routed provider response.
    // Keep effort only when the last unmodified request matches that selection.
    if (typeof view.selectedModel !== 'string' || !view.selectedModel) return '';
    const effort = view.baseRequest?.model === view.selectedModel ? view.baseRequest.effort : null;
    return effort != null ? label(view.selectedModel, effort) : modelName(view.selectedModel, compact);
  } catch { return ''; }
}

export function observeJourney(previous, snapshot) {
  const s = snapshot?.state;
  if (!s) return null;
  const owner = `${snapshot.conversation_id}:${s.run_id ?? ''}`;
  const count = s.transition_count;
  const item = { state: s.state, count, gap: false };
  if (!s.run_id || !previous || previous.owner !== owner || count < previous.entries.at(-1).count)
    return { owner, entries: [item] };
  const last = previous.entries.at(-1);
  if (last.count === count && last.state === s.state) return previous;
  // A refreshed snapshot can skip visits. Do not draw a confirmed edge across
  // a gap or infer history from the workflow definition's possible next states.
  item.gap = count !== last.count + 1;
  return { owner, entries: [...previous.entries, item].slice(-5) };
}

export function statusPresentation(view, { surface = 'terminal', powerline = false, compact = false, columns = Infinity } = {}) {
  const s = view.connected ? view.native?.state : null;
  const status = view.busy ? (view.interactive ? 'Connecting…' : 'Checking connection…')
    : view.controlError || view.routeError ? 'Needs attention'
    : s?.pending_approval ? compact ? 'Review needed' : `${s.state} · Needs your decision`
    : s ? `${s.state}${s.is_final ? ' · Complete' : ''}`
    : view.connected ? 'Connected to Statewright'
    : view.connectionIssue === 'auto_review_unavailable' ? 'Check Claude permissions'
    : view.error ? compact ? 'Check connection' : 'Connection needs attention' : 'Not connected';
  const events = s && !s.is_final && !s.pending_approval && !view.controlError && !view.routeError && !view.busy
    ? s.transitions.slice(0, 16).map(t => eventSymbol(t.event)) : [];
  const usePowerline = surface === 'terminal' && powerline === true;
  const tail = events.length ? ` events: ${events.join(' | ')}${s.transitions.length > events.length ? ' | …' : ''} ${usePowerline ? '' : '>'}` : '';
  const model = modelPresentation(view, compact);
  // Reserve the mandatory state/model/effort cells before optional next events.
  // Include segment separators and native row affordance. A wider terminal must
  // not lose effort just because it crossed a fixed "wide" breakpoint.
  if (!compact && 28 + status.length + (model ? model.length + 11 : 7) > columns)
    return statusPresentation(view, { surface, powerline, compact: true, columns });
  const shownStatus = compact && model && !view.controlError && !view.routeError && !s?.pending_approval && status.length > 8
    ? `${status.slice(0, 7)}…` : status;
  // Optional events add a divider and a truncation ellipsis. Never let those
  // overwrite the final character of a model/effort that otherwise fits.
  const shownTail = model && (compact ? 3 : 28) + shownStatus.length + model.length + 10 > columns ? '' : tail;
  return { status: shownStatus, model, tail: shownTail, compact, powerline: usePowerline,
    attention: Boolean(view.controlError || view.routeError || view.error || s?.pending_approval) };
}

export function graphRows(snapshot, journey) {
  const s = snapshot?.state;
  if (!s) return [];
  const current = observeJourney(journey, snapshot);
  const rows = [];
  for (const [i, item] of current.entries.entries()) {
    if (i) rows.push({ text: item.gap ? '┊  …' : '│', kind: 'edge' });
    rows.push({ text: `${i === current.entries.length - 1 ? '●' : '○'} ${item.state}`,
      kind: i === current.entries.length - 1 ? 'current' : 'past' });
  }
  if (!s.is_final) {
    const branches = s.transitions.slice(0, 8);
    branches.forEach((t, i) => rows.push({
      text: `${i === branches.length - 1 && s.transitions.length <= 8 ? '└' : '├'}─ ${eventSymbol(t.event)} → ○ ${t.target}`,
      kind: 'next',
    }));
    if (s.transitions.length > branches.length)
      rows.push({ text: `└─ … ${s.transitions.length - branches.length} more possible transitions`, kind: 'next' });
  }
  return rows;
}
