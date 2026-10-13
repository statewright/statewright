import { ARBITER_PURPLE, ARBITER_ACCENT, observeJourney, eventSymbol } from './workflow-ui.mjs';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const short = (value, length = 30) => String(value).length > length ? `${String(value).slice(0, length - 1)}…` : String(value);

// A bounded, descriptive graph. Never invent visits or imply the next branch
// ran. Escaped labels are data, not SVG markup, links or event handlers.
export function desktopGraph(snapshot, journey) {
  const state = snapshot?.state;
  if (!state) return null;
  const visits = observeJourney(journey, snapshot).entries;
  const next = state.is_final ? [] : state.transitions.slice(0, 4);
  const height = 24 + visits.length * 42 + next.length * 60 + (state.transitions.length > next.length && !state.is_final ? 24 : 0);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="${height}" viewBox="0 0 320 ${height}" role="img">`,
    '<style>text{font-family:system-ui,sans-serif;font-size:12px}</style>'];
  const captions = [];
  visits.forEach((visit, i) => {
    const current = i === visits.length - 1, y = 12 + i * 42;
    if (i) parts.push(`<path d="M30 ${y - 14}V${y}" stroke="${visit.gap ? '#E8BC70' : '#75688E'}" stroke-width="2"${visit.gap ? ' stroke-dasharray="2 5"' : ''}/>`);
    parts.push(`<rect x="12" y="${y}" width="296" height="28" rx="14" fill="${current ? '#30264A' : '#211E2C'}" stroke="${current ? ARBITER_PURPLE : '#75688E'}"/>`,
      `<circle cx="30" cy="${y + 14}" r="4" fill="${current ? ARBITER_PURPLE : '#75688E'}"/>`,
      `<text x="44" y="${y + 19}" fill="${current ? '#F2E9FF' : '#C7BDD9'}">${escape(short(visit.state, 29))}</text>`,
      `<title>${escape(`${current ? 'Current' : 'Visited'}: ${visit.state}${visit.gap ? ' (intervening visits not observed)' : ''}`)}</title>`);
    captions.push(`${visit.gap ? 'Unobserved gap; ' : ''}${current ? 'Current' : 'Visited'}: ${visit.state}`);
  });
  const from = 12 + (visits.length - 1) * 42 + 28;
  next.forEach((transition, i) => {
    const y = 12 + visits.length * 42 + i * 60;
    parts.push(`<path d="M30 ${from}V${y + 28}H54" fill="none" stroke="${ARBITER_ACCENT}" stroke-dasharray="3 4"/>`,
      `<text x="58" y="${y + 8}" fill="${ARBITER_ACCENT}">${escape(short(eventSymbol(transition.event), 31))}</text>`,
      `<rect x="54" y="${y + 15}" width="254" height="28" rx="14" fill="#192A30" stroke="${ARBITER_ACCENT}" stroke-dasharray="3 3"/>`,
      `<text x="66" y="${y + 34}" fill="#C5EDF5">${escape(short(transition.target, 30))}</text>`);
    captions.push(`Possible ${eventSymbol(transition.event)} to ${transition.target}`);
  });
  if (!state.is_final && state.transitions.length > next.length) {
    const extra = state.transitions.length - next.length;
    parts.push(`<text x="54" y="${height - 5}" fill="${ARBITER_ACCENT}">+${extra} more events in Next step</text>`);
    captions.push(`${extra} more events in Next step`);
  }
  parts.push('</svg>');
  return { source: parts.join(''), alt: captions.join('. '), height };
}

export function desktopTitle(view) {
  if (view.busy) return view.interactive ? 'Connecting to Statewright…' : 'Checking your saved connection…';
  if (view.connected) return 'Connected to Statewright';
  if (view.connectionIssue === 'auto_review_unavailable') return 'Check Claude permissions';
  return view.error ? 'Connection needs attention' : 'Statewright would like to connect';
}
