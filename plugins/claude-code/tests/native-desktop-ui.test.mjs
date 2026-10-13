import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopGraph, desktopTitle } from '../hooks/desktop-ui.mjs';
import { observeJourney } from '../hooks/workflow-ui.mjs';
import DesktopAction from '../hooks/desktop-action.js';

const snapshot = (state = 'intake', count = 0) => ({ conversation_id: 'one', state: {
  state, run_id: 'run', transition_count: count, is_final: false,
  transitions: [{ event: 'NEXT', target: 'localize' }],
} });
test('Desktop graph distinguishes observed visits, gaps, current and possible branches', () => {
  const first = snapshot(), last = snapshot('validate', 3);
  const journey = observeJourney(null, first), graph = desktopGraph(last, journey);
  assert.match(graph.alt, /Visited: intake.*Unobserved gap; Current: validate.*Possible :next to localize/);
  assert.match(graph.source, /stroke-dasharray="2 5"/);
  assert.match(graph.source, /rx="14"/);
  assert.ok(!graph.alt.includes('Visited: localize'));
  assert.equal(desktopGraph(null), null);
});
test('Desktop graph bounds visits and branches and escapes external labels', () => {
  let journey;
  for (let i = 0; i < 9; i++) journey = observeJourney(journey, snapshot(`state-${i}`, i));
  const s = snapshot('state-8', 8);
  s.state.transitions = Array.from({ length: 20 }, (_, i) => ({ event: `EVENT_${i}`, target: '<script>&"\'' }));
  const graph = desktopGraph(s, journey);
  assert.equal((graph.alt.match(/Visited:/g) ?? []).length, 4);
  assert.equal((graph.alt.match(/Possible/g) ?? []).length, 4);
  assert.match(graph.alt, /16 more events/);
  assert.match(graph.source, /&lt;script&gt;&amp;&quot;&apos;/);
  assert.doesNotMatch(graph.source, /<script>|onclick=|href=/);
  assert.ok(graph.source.length < 10000);
  s.state.is_final = true;
  assert.doesNotMatch(desktopGraph(s, journey).alt, /Possible|more events/);
});
test('Desktop action emits only an intent on an actual press', () => {
  const posted = [];
  const props = { action: 'connect', label: 'Connect', primary: true, conversation: 'one', revision: 3 };
  const button = DesktopAction(props, { elements: { Button: props => props }, post: data => posted.push(data) });
  assert.equal(button.variant, 'primary'); assert.equal(posted.length, 0);
  button.onPress();
  assert.deepEqual(posted, [{ action: 'connect', revision: 3, conversation: 'one' }]);
});
test('Desktop separates saved-login checks, interactive waits and recovery', () => {
  assert.equal(desktopTitle({ busy: true }), 'Checking your saved connection…');
  assert.equal(desktopTitle({ busy: true, interactive: true }), 'Connecting to Statewright…');
  assert.equal(desktopTitle({ connected: true }), 'Connected to Statewright');
  assert.equal(desktopTitle({ error: 'failed' }), 'Connection needs attention');
});
test('Desktop status button keeps its accessible label and colored text', () => {
  const posted = [], props = { action: 'show-sidebar', label: 'Connection needs attention', color: '#FFD580', conversation: 'one', revision: 2 };
  const button = DesktopAction(props, { elements: { Button: props => props, Text: props => props }, post: data => posted.push(data) });
  assert.equal(button.label, props.label);
  assert.deepEqual(button.children, [{ color: props.color, children: [props.label] }]);
  assert.equal(posted.length, 0); button.onPress();
  assert.deepEqual(posted, [{ action: 'show-sidebar', revision: 2, conversation: 'one' }]);
});
