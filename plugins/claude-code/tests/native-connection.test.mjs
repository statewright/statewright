import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { decodeCatalog, decodeCatalogConnection, resolveWorkflowName, gatewayTool, GATEWAY, SERVER, LOGIN_COMMAND, connectionFailure } from '../hooks/catalog.mjs';

const wire = (workflows, active = null) => ({ content: [{ type: 'text', text: JSON.stringify({ workflows, active }) }] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const CHAT = '11111111-1111-4111-8111-111111111111';
const connectionWire = (state, snapshot) => ({ content: [{ type: 'text', text: JSON.stringify({
  protocol_version: 1, conversation_id: state.session,
  workflows: JSON.parse(state.catalog.content[0].text).workflows,
  snapshot: snapshot ?? (state.native ? JSON.parse(state.native.content[0].text) : {
    protocol_version: 1, conversation_id: state.session, revision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', state: null, outcome: null,
    capabilities: { workflow_control: false, native_tool_enforcement: false, human_approval: false, model_routing: false } }),
}) }] });

test('engineering alias requires authoritative owned-catalog metadata and exact names win', () => {
  const aliases = { engineering: 'agentic-engineering' };
  assert.equal(resolveWorkflowName('engineering', ['agentic-engineering'], aliases), 'agentic-engineering');
  assert.equal(resolveWorkflowName('engineering', ['agentic-engineering', 'engineering'], aliases), 'engineering');
  assert.equal(resolveWorkflowName('engineering', [], aliases), 'engineering');
  assert.equal(resolveWorkflowName('engineering', ['agentic-engineering'], {}), 'engineering');
  const wire = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  assert.deepEqual(decodeCatalogConnection(wire({ workflows: ['agentic-engineering'], workflow_aliases: aliases })).workflowAliases, aliases);
  for (const value of [null, [], { engineering: 'other' }, { unexpected: 'agentic-engineering' }])
    assert.throws(() => decodeCatalogConnection(wire({ workflows: ['agentic-engineering'], workflow_aliases: value })));
  assert.throws(() => decodeCatalogConnection(wire({ workflows: ['agentic-engineering', 'engineering'], workflow_aliases: aliases })));
});

test('connection diagnostics classify native failures without copying messages or payloads', () => {
  for (const [message, code] of [
    ['no session is bound', 'session_unbound'],
    ['$.mcp.call: no connected MCP tool "private" on a server named "private"', 'tool_unavailable'],
    ['$.tool.call: no tool named "private" in this session', 'tool_unavailable'],
    ['$.mcp.call refused: Native tool denied', 'permission_refused'],
    ['$.mcp.call refused: Safety classifier gave no verdict for tool: the request that produced this action did not ask for one. Tell the user that auto mode could not evaluate it.', 'auto_review_unavailable'],
    ['$.mcp.call refused: Safety classifier is temporarily unavailable, so auto mode cannot determine the safety of tool right now.', 'auto_review_unavailable'],
    ['$.mcp.call refused: Auto mode classifier blocked action: unsafe', 'permission_refused'],
    ['$.mcp.call refused: The API told auto mode\'s safety classifier to wait 5 minutes from now.', 'permission_refused'],
    ['$.mcp.call refused: Statewright control is unavailable.', 'control_hook_failed'],
    ['$.mcp.call refused: a hooks module behind the call is not admitted', 'module_unavailable'],
    ['$.mcp.call refused: its hooks module does not call it (host rule)', 'capability_unavailable'],
    ['produced no result (aborted)', 'request_aborted'],
    ['PRIVATE_TOKEN https://private.example/callback?code=PRIVATE_TOKEN', 'native_error'],
  ]) {
    const value = connectionFailure('catalog', new Error(message));
    assert.equal(value.code, code);
    assert.doesNotMatch(JSON.stringify(value), /private|PRIVATE_TOKEN|https:/);
  }
  assert.equal(connectionFailure('identity', new Error('private')).code, 'server_identity');
  assert.equal(connectionFailure('catalog_decode', new SyntaxError('private')).code, 'catalog_invalid');
});

test('unavailable native Auto review offers explicit connection approval without changing mode, login or retrying', async () => {
  const h = await host();
  h.state.read = async () => { throw new Error('$.mcp.call refused: Safety classifier gave no verdict for tool: the request that produced this action did not ask for one. Tell the user that auto mode could not evaluate it. PRIVATE_TOKEN'); };
  await h.press('connect'); await h.flush();
  const diagnostic = h.stored.get('latest-connection-diagnostic');
  assert.equal(diagnostic.code, 'auto_review_unavailable');
  assert.match(h.content(await h.pane()), /permission mode stays unchanged/);
  assert.doesNotMatch(h.content(await h.pane()), /Ask permissions|Manual|changing mode/);
  const band = await h.fire('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: 100 } });
  assert.equal(h.find(band, 'status-sidebar').props.props.label, 'Check Claude permissions');
  assert.doesNotMatch(h.content(await h.pane()), /PRIVATE_TOKEN/);
  assert.equal(h.state.calls.length, 1);
  await h.flush(); assert.equal(h.state.calls.length, 1, 'no automatic retry');
  assert.deepEqual(h.state.commands, []); assert.deepEqual(h.state.slashCommands, []);
  h.state.read = null;
  await h.press('connect'); await h.flush();
  assert.match(h.content(await h.pane()), /Connected to Statewright/);
  assert.doesNotMatch(h.content(await h.pane()), /Ask permissions|auto_review_unavailable/);
});

test('failed Desktop catalog dispatch retains a safe session-bound diagnostic and does not launch OAuth', async () => {
  const h = await host();
  h.state.read = async () => { throw new Error('$.mcp.call: no connected MCP tool "private"'); };
  await h.press('connect'); await h.flush();
  const diagnostic = h.stored.get('latest-connection-diagnostic');
  assert.equal(diagnostic.schema, 'statewright/connection-diagnostic/v1');
  assert.equal(diagnostic.conversation, CHAT);
  assert.equal(diagnostic.stage, 'catalog');
  assert.equal(diagnostic.code, 'tool_unavailable');
  assert.equal(diagnostic.outcome, 'failed');
  assert.match(h.content(await h.pane()), /tool_unavailable/);
  assert.equal(h.state.commands.length, 0);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private/);
});

test('missing tool explains restart without futile retries or resetting credentials', async () => {
  const h = await host();
  h.state.read = async () => { throw new Error('$.mcp.call: no connected MCP tool "statewright_native_connect"'); };
  await h.press('connect'); await h.flush();
  assert.equal(h.state.calls.length, 1);
  assert.match(h.content(await h.pane()), /Restart Claude Code/);
  assert.equal(h.find(await h.pane(), 'connect'), undefined);
  await h.flush();
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.slashCommands.length, 0);
  assert.equal(h.state.commands.length, 0);
});

test('Desktop stale catalog recovery gives Desktop-specific restart guidance', async () => {
  const h = await host();
  h.state.read = async () => { throw new Error('$.mcp.call: no connected MCP tool "statewright_native_connect"'); };
  const render = () => h.fire('ui.render', { component: 'Pane', requestId: 'statewright', surface: 'desktop', props: {} });
  const p = h.find(await render(), 'action-connect').props.props;
  await h.fire('ui.message', { surface: 'desktop', component: 'Pane', requestId: 'statewright', element: 'action-connect', module: 'hooks/desktop-action.js',
    data: { action: 'connect', revision: p.revision, conversation: p.conversation } });
  await h.flush();
  assert.match(h.content(await render()), /Quit and reopen Claude Desktop/);
  assert.equal(h.find(await render(), 'action-connect'), undefined);
  assert.ok(h.find(await render(), 'action-close'));
});

test('quiet startup missing tools uses the rendered Desktop surface before any click', async () => {
  const h = await host({ startup: false });
  h.state.read = async () => { throw new Error('$.mcp.call: no connected MCP tool "statewright_list_workflows"'); };
  await h.flush();
  const pane = await h.fire('ui.render', { component: 'Pane', requestId: 'statewright', surface: 'desktop', props: {} });
  assert.match(h.content(pane), /Quit and reopen Claude Desktop/);
  assert.doesNotMatch(h.content(pane), /Restart Claude Code|No sign-in reset/);
  assert.equal(h.find(pane, 'action-connect'), undefined);
  assert.ok(h.find(pane, 'action-close'));
  assert.equal(h.state.commands.length, 0);
  assert.equal(h.state.slashCommands.length, 0);
});

test('diagnostic failures cannot prevent connection and late errors cannot replace a resumed session record', async () => {
  const h = await host();
  const set = h.$.store.set;
  h.$.store.set = async (key, value) => {
    if (key === 'latest-connection-diagnostic') throw new Error('fixture store unavailable');
    return set(key, value);
  };
  await h.press('connect'); await h.flush();
  assert.match(h.content(await h.pane()), /Connected to Statewright/);
  h.$.store.set = set;
  const wait = deferred();
  h.state.read = async () => { await wait.promise; throw new Error('no connected MCP tool'); };
  await h.press('refresh'); const old = h.flush();
  await new Promise(resolve => setImmediate(resolve));
  h.state.session = 'two'; h.state.read = null;
  await h.fire('session.start', {}); await h.flush();
  const record = h.stored.get('latest-connection-diagnostic');
  assert.equal(record.conversation, 'two'); assert.equal(record.outcome, 'connected');
  wait.resolve(); await old;
  assert.deepEqual(h.stored.get('latest-connection-diagnostic'), record);
});

for (const pauseStage of ['check', 'catalog']) test(`cancellation during ${pauseStage} diagnostic storage cannot dispatch`, async () => {
  const h = await host(), entered = deferred(), release = deferred();
  const set = h.$.store.set;
  h.$.store.set = async (key, value) => {
    if (key === 'latest-connection-diagnostic' && value.stage === pauseStage && value.outcome === 'running') {
      entered.resolve(); await release.promise;
    }
    return set(key, value);
  };
  await h.press('connect'); const job = h.flush(); await entered.promise;
  await h.press('cancel-connect'); release.resolve(); await job;
  assert.equal(h.state.calls.length, 0);
  assert.equal(h.state.commands.length, 0);
  assert.equal(h.state.connects, pauseStage === 'check' ? 0 : 1);
});

async function host({ startup = true, options = {} } = {}) {
  const hooks = [], timers = [], events = [], stored = new Map();
  const state = { session: CHAT, connects: 0, calls: [], commands: [], slashCommands: [], copies: [], copied: true, native: null,
    connection: { isConnected: true, server: `plugin:statewright:${SERVER}` },
    catalog: wire(['bugfix', 'plan']), connect: null, run: null, read: null,
    asks: [], answer: 'Not now', ask: null, placed: true };
  const elements = Object.fromEntries(['Text', 'Box', 'Button', 'Select', 'Client', 'Svg'].map(type => [type, props => ({ type, props })]));
  const $ = {
    plugin: { root: '/test-plugin', name: 'statewright' },
    store: { get: async key => stored.get(key), set: async (key, value) => stored.set(key, value) },
    session: { id: async () => state.sessionId ? state.sessionId() : state.session, model: async () => state.model ?? 'claude-opus-5-5' },
    settings: { read: async () => state.settings ?? {} },
    env: { get: async () => state.noFallback },
    command: { register: async () => {}, run: async args => { state.slashCommands.push(args); return {}; } },
    process: { run: async (argv, init) => { state.commands.push({ argv, init }); return { exitCode: 0, ...await state.run?.({ argv, init }) }; } },
    tool: { check: async args => state.toolPermission ? state.toolPermission(args) : { decision: 'allow' },
      register: async spec => { state.spec = spec; return { tool: `mcp__statewright__${spec.name}` }; } },
    ui: { resolve: () => elements, invalidate: () => {}, log: text => events.push(['log', text]), open: async args => { events.push(['open', args]); return { isPlaced: state.placed }; },
      ask: async (...args) => { state.asks.push(args); return state.ask ? state.ask() : state.answer; },
      copy: async args => { state.copies.push(args); return { isCopied: state.copied }; },
      close: async args => { events.push(['close', args]); await fire('ui.close', { ...args, origin: { kind: 'plugin' } }); } },
    clock: { after: (ms, callback) => { const t = { ms, callback, cancel() { this.cancelled = true; } }; timers.push(t); return t; } },
    mcp: { connect: async server => { assert.equal(server, SERVER); state.connects++; return state.connect ? state.connect() : state.connection; },
      call: async (server, tool, args) => {
        const nativeTool = `mcp__${server.replace(/:/g, '_')}__${tool}`;
        const response = await fire('mcp.call', { server, tool, args }, async () =>
          fire('tool.call', { tool: nativeTool, ...args }, async () => {
            const verdict = await fire('tool.check', { tool: nativeTool, tool_use_id: crypto.randomUUID(), input: args },
              async () => state.rpcPermission ? state.rpcPermission(args) : { decision: 'allow' }, { plugin: 'statewright' });
            if (verdict.decision !== 'allow') return { deny: verdict.reason || 'Native permission required' };
            state.calls.push({ server, tool, args });
            return { result: state.read ? await state.read({ server, tool, args }) : tool === 'statewright_native_connect' ? connectionWire(state)
              : tool === 'statewright_native_request' ? state.native : state.catalog };
          }, { plugin: 'statewright' }), { plugin: 'statewright' });
        if (response.deny) throw new Error('Native tool denied');
        return response.result;
      } },
  };
  const { register } = await import(`../hooks/connect.js?test=${crypto.randomUUID()}`);
  register((name, matcher, handler) => {
    if (typeof matcher === 'function') { handler = matcher; matcher = {}; }
    const h = { name, matcher, handler }; hooks.push(h);
    return { catch(fn) { h.fallback = fn; } };
  }, options);
  async function fire(name, e, next = async x => x, origin = {}) {
    next.origin = origin;
    const h = hooks.find(h => h.name === name && Object.entries(h.matcher).every(([k, v]) => v instanceof RegExp ? v.test(e[k]) : e[k] === v));
    return h?.handler($, e, next);
  }
  const pane = () => fire('ui.render', { component: 'Pane', requestId: 'statewright', props: {} });
  function find(tree, key) {
    if (tree?.props?.key === key) return tree;
    for (const child of tree?.props?.children ?? []) { const found = find(child, key); if (found) return found; }
  }
  const content = tree => typeof tree === 'string' ? tree : (tree?.props?.children ?? []).map(content).join(' ');
  async function press(key) { const node = find(await pane(), key); assert.ok(node, `Visible ${key}`); return node.props.onPress(); }
  async function flush(ms = 0) {
    for (const t of timers.filter(t => t.ms === ms && !t.cancelled)) { t.cancel(); await t.callback(); }
  }
  await fire('session.start', {});
  if (startup) {
    // Interactive recovery tests begin after a quiet auth-required startup.
    // Dedicated startup tests below exercise the queued check independently.
    const connection = state.connection;
    state.connection = { isConnected: false, reason: 'auth' };
    await flush(); state.connection = connection; state.connects = 0; events.length = 0;
  }
  return { $, state, hooks, timers, events, stored, fire, pane, find, content, press, flush };
}

for (const baseline of [false, true]) test(`Powerline baseline ${baseline} has memory-only on/off/default session overrides`, async () => {
  const h = await host({ options: { powerline: baseline } });
  const band = async () => h.content(await h.fire('ui.render', { component: 'AbovePrompt', surface: 'terminal', props: { bodyColumns: 120 } }));
  const run = args => h.fire('command.run', { command: 'statewright', args });
  const hasGlyph = async () => /\ue0b0/.test(await band());
  const stored = [...h.stored];
  assert.equal(await hasGlyph(), baseline);
  await run('powerline on'); assert.equal(await hasGlyph(), true);
  await h.fire('turn.start', {}); await h.fire('turn.complete', {});
  assert.equal(await hasGlyph(), true, 'ordinary turns preserve the override');
  await run('powerline off'); assert.equal(await hasGlyph(), false);
  assert.match((await band()).replace(/ +/g, ' '), /arbiter > statewright.ai ∞ > Connection needs attention/);
  await run('powerline default'); assert.equal(await hasGlyph(), baseline);
  await run(`powerline ${baseline ? 'off' : 'on'}`);
  const result = await run('powerline typo'); assert.match(result.text, /on\|off\|default/);
  assert.equal(await hasGlyph(), !baseline, 'invalid input leaves preference alone');
  assert.equal(h.state.connects, 0, 'appearance command does not connect');
  assert.equal(h.state.commands.length, 0); assert.equal(h.state.calls.length, 0);
  assert.deepEqual([...h.stored], stored, 'no durable override');
  await h.fire('session.end', {}); await h.fire('session.start', {});
  assert.equal(await hasGlyph(), baseline, 'restarting the same conversation resets the override');
  await run(`powerline ${baseline ? 'off' : 'on'}`);
  h.state.session = 'other';
  assert.equal(await hasGlyph(), baseline, 'resuming another conversation resets the override');
});

test('Powerline pane selector is terminal-only and stale callbacks cannot change another session', async () => {
  const h = await host();
  const render = surface => h.fire('ui.render', { component: 'Pane', surface, requestId: 'statewright', props: {} });
  const select = h.find(await render('terminal'), 'powerline-session');
  assert.equal(select.props.value, 'default');
  assert.match(select.props.options[0].label, /Off/);
  await select.props.onSelect('on');
  assert.equal(h.find(await render('terminal'), 'powerline-session').props.value, 'on');
  assert.equal(h.find(await render('desktop'), 'powerline-session'), undefined);
  await h.fire('session.start', {});
  await select.props.onSelect('on');
  assert.equal(h.find(await render('terminal'), 'powerline-session').props.value, 'default', 'old callback cannot undo same-ID restart');
  h.state.session = 'other';
  await select.props.onSelect('on');
  assert.equal(h.find(await render('terminal'), 'powerline-session').props.value, 'default');
  assert.equal(JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url))).userConfig.powerline.default, false);
});

test('catalog uses real gateway names, ignores active and supports empty/100 entries', () => {
  assert.deepEqual(decodeCatalog(wire(['bugfix'], 'foreign-workflow')), ['bugfix']);
  assert.deepEqual(decodeCatalog(wire([])), []);
  assert.equal(decodeCatalog(wire(Array.from({ length: 100 }, (_, n) => `workflow-${n}`))).length, 100);
  for (const result of [{ isError: true, ...wire(['ok']) }, wire(['a', 'a']), wire(['bad\nname']), wire(['\x1b[31m']),
    wire([{}]), wire(['']), { content: [{ type: 'text', text: '{' }] }, { content: [] },
    { content: [{ type: 'text', text: ' '.repeat(131073) }] }]) assert.throws(() => decodeCatalog(result));
});

test('Desktop status chips are one row high with an outlined brand; terminal is unchanged', async () => {
  const h = await host();
  const desktop = await h.fire('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: 100 } }, async () => null);
  for (const key of ['arbiter-label', 'arbiter-brand', 'desktop-state']) {
    const chip = h.find(desktop, key); assert.ok(chip, key);
    assert.equal(chip.type, 'Box'); assert.equal(chip.props.height, 1);
    assert.equal(chip.props.paddingY, 0);
  }
  assert.equal(h.find(desktop, 'arbiter-brand').props.borderStyle, 'single');
  assert.match(h.content(h.find(desktop, 'arbiter-brand')), /statewright.ai ∞/);
  const terminal = await h.fire('ui.render', { component: 'AbovePrompt', surface: 'terminal', props: { bodyColumns: 100 } }, async () => null);
  assert.equal(h.find(terminal, 'arbiter-brand'), undefined);
  assert.equal(h.find(terminal, 'arbiter-status').props.height, 1);
});

test('Desktop status opens and focuses the sidebar without connecting, including after redraw', async () => {
  const h = await host();
  const render = () => h.fire('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: {} }, async () => null);
  const control = h.find(await render(), 'status-sidebar'); assert.ok(control);
  const p = control.props.props;
  assert.equal(p.label, 'Connection needs attention');
  const event = { surface: 'desktop', component: 'AbovePrompt', element: 'status-sidebar', module: 'hooks/desktop-action.js',
    data: { action: p.action, revision: p.revision, conversation: p.conversation } };
  await h.fire('ui.render', { component: 'Pane', requestId: 'statewright', surface: 'desktop', props: { isFocused: true } });
  await render(); await h.fire('ui.message', event);
  assert.deepEqual(h.events.filter(([kind]) => kind === 'open'), [['open', {
    id: 'statewright', title: 'Statewright', focus: true, closeOnEscape: true, rows: 12,
  }]]);
  await h.flush();
  assert.equal(h.state.connects, 0); assert.equal(h.state.commands.length, 0);
  assert.equal(h.state.calls.length, 0); assert.equal(h.state.asks.length, 0);
  for (const invalid of [
    { ...event, component: 'Pane', requestId: 'statewright' },
    { ...event, element: 'action-connect' },
    { ...event, data: { ...event.data, action: 'connect' } },
    { ...event, data: { ...event.data, conversation: 'foreign' } },
  ]) await h.fire('ui.message', invalid);
  assert.equal(h.events.filter(([kind]) => kind === 'open').length, 1);
  await h.fire('session.start', {}); await h.fire('ui.message', event);
  assert.equal(h.events.filter(([kind]) => kind === 'open').length, 1, 'same-ID restart rejects old navigation');
  h.state.session = 'other'; await render(); h.state.session = CHAT; await render();
  await h.fire('ui.message', event);
  assert.equal(h.events.filter(([kind]) => kind === 'open').length, 1, 'returning to an old conversation rejects stale intent');
});

test('Desktop status Client failure retains a native sidebar entry without starting OAuth', async () => {
  const h = await host();
  const render = () => h.fire('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: {} }, async () => null);
  await render();
  await h.fire('ui.fault', { surface: 'desktop', component: 'AbovePrompt', element: 'status-sidebar', module: 'hooks/desktop-action.js', phase: 'load', reason: 'fixture CSP' });
  const fallback = h.find(await render(), 'status-sidebar-fallback'); assert.ok(fallback);
  assert.equal(fallback.type, 'Select'); assert.equal(fallback.props.label, 'Connection needs attention');
  await fallback.props.onSelect('sidebar');
  assert.equal(h.events.filter(([kind]) => kind === 'open').length, 1);
  await h.flush();
  assert.equal(h.state.connects, 0); assert.equal(h.state.commands.length, 0);
  await h.fire('session.start', {}); await fallback.props.onSelect('sidebar');
  assert.equal(h.events.filter(([kind]) => kind === 'open').length, 1);
});

for (const fallback of [false, true]) test(`Desktop sidebar rejects a same-ID restart during dispatch; fallback=${fallback}`, async () => {
  const h = await host();
  const render = () => h.fire('ui.render', { component: 'AbovePrompt', surface: 'desktop', props: {} }, async () => null);
  if (fallback) await h.fire('ui.fault', { surface: 'desktop', component: 'AbovePrompt', element: 'status-sidebar', module: 'hooks/desktop-action.js' });
  const control = h.find(await render(), fallback ? 'status-sidebar-fallback' : 'status-sidebar');
  const held = deferred(); let reads = 0;
  h.state.sessionId = () => ++reads === 2 ? held.promise : h.state.session;
  const p = control.props.props;
  const dispatch = fallback ? control.props.onSelect('sidebar') : h.fire('ui.message', {
    surface: 'desktop', component: 'AbovePrompt', element: 'status-sidebar', module: 'hooks/desktop-action.js',
    data: { action: p.action, revision: p.revision, conversation: p.conversation },
  });
  for (let i = 0; i < 20 && reads < 2; i++) await Promise.resolve();
  assert.equal(reads, 2, 'held at the final session read before opening');
  await h.fire('session.start', {});
  held.resolve(h.state.session); await dispatch;
  assert.equal(h.events.filter(([kind]) => kind === 'open').length, 0);
  assert.equal(h.state.connects, 0); assert.equal(h.state.commands.length, 0);
});

test('Desktop Client survives focus redraw, dispatches Connect once and keeps its wait visible', async () => {
  const h = await host(); h.state.connection = { isConnected: false, reason: 'auth' };
  const render = isFocused => h.fire('ui.render', { component: 'Pane', requestId: 'statewright', surface: 'desktop', props: { isFocused } });
  const first = h.find(await render(false), 'action-connect').props.props;
  assert.deepEqual(h.find(await render(true), 'action-connect').props.props, first);
  const e = { surface: 'desktop', component: 'Pane', requestId: 'statewright', element: 'action-connect', module: 'hooks/desktop-action.js',
    data: { action: 'connect', revision: first.revision, conversation: first.conversation } };
  await h.fire('ui.message', { ...e, data: { ...e.data, conversation: 'foreign' } });
  assert.equal(h.state.commands.length, 0); assert.equal(h.state.connects, 0);
  await h.fire('ui.message', e); await h.fire('ui.message', e);
  const waiting = deferred(); h.state.run = () => waiting.promise;
  const pending = h.flush();
  for (let i = 0; i < 30 && !h.state.commands.length; i++) await Promise.resolve();
  assert.equal(h.state.commands.length, 1);
  assert.ok(h.find(await render(true), 'action-cancel-connect'));
  assert.equal(h.events.filter(([kind]) => kind === 'close').length, 0, 'Desktop keeps waiting/cancel visible');
  const cancel = h.find(await render(true), 'action-cancel-connect').props.props;
  await h.fire('ui.message', { ...e, element: 'action-cancel-connect', data: { action: 'cancel-connect', revision: cancel.revision, conversation: cancel.conversation } });
  waiting.resolve({ exitCode: 1 }); await pending;
  assert.match(h.content(await render(true)), /cancelled/);
  assert.equal(h.state.calls.length, 0);
});

test('Desktop rejects obsolete action even before the next render and across resumed sessions', async () => {
  const h = await host();
  const tree = await h.fire('ui.render', { component: 'Pane', requestId: 'statewright', surface: 'desktop', props: {} });
  const p = h.find(tree, 'action-connect').props.props;
  const event = { surface: 'desktop', component: 'Pane', requestId: 'statewright', element: 'action-connect', module: 'hooks/desktop-action.js',
    data: { action: 'connect', revision: p.revision, conversation: p.conversation } };
  await h.fire('session.start', {});
  await h.fire('ui.message', event);
  assert.equal(h.state.connects, 0);
  h.state.session = 'another'; await h.fire('ui.message', event);
  assert.equal(h.state.connects, 0);
});

test('Desktop sign-in failure offers a visible retry, not a hidden terminal command', async () => {
  const h = await host(); h.state.connection = { isConnected: false, reason: 'auth' };
  h.state.run = async () => ({ exitCode: 1 });
  const render = () => h.fire('ui.render', { component: 'Pane', requestId: 'statewright', surface: 'desktop', props: {} });
  const p = h.find(await render(), 'action-connect').props.props;
  await h.fire('ui.message', { surface: 'desktop', component: 'Pane', requestId: 'statewright', element: 'action-connect', module: 'hooks/desktop-action.js',
    data: { action: 'connect', revision: p.revision, conversation: p.conversation } });
  await h.flush();
  const tree = await render();
  assert.match(h.content(tree), /Sign-in didn’t complete\. Try connecting again\./);
  assert.doesNotMatch(h.content(tree), /terminal command below/);
  assert.ok(h.find(tree, 'action-connect'));
});

for (const [exitCode, message] of [[127, /sign-in helper could not start/], [124, /sign-in timed out/]])
test(`Desktop sign-in exit ${exitCode} identifies the failed step without leaking helper output`, async () => {
  const h = await host(); h.state.connection = { isConnected: false, reason: 'auth' };
  h.state.run = async () => ({ exitCode, stderr: 'private callback and token must not be shown' });
  const render = () => h.fire('ui.render', { component: 'Pane', requestId: 'statewright', surface: 'desktop', props: {} });
  const p = h.find(await render(), 'action-connect').props.props;
  await h.fire('ui.message', { surface: 'desktop', component: 'Pane', requestId: 'statewright', element: 'action-connect', module: 'hooks/desktop-action.js',
    data: { action: 'connect', revision: p.revision, conversation: p.conversation } });
  await h.flush(); const text = h.content(await render());
  assert.match(text, message); assert.doesNotMatch(text, /private callback|token/);
  assert.equal(h.state.commands.length, 1); assert.equal(h.state.calls.length, 0);
});

for (const [detail, message] of [['no session is bound', /not attached Statewright/], ['private token in unknown failure', /couldn’t check your Statewright connection/]])
test(`connection check failure is distinct from OAuth failure: ${message}`, async () => {
  const h = await host(); h.state.connect = async () => { throw new Error(detail); };
  await h.press('connect'); await h.flush();
  assert.match(h.content(await h.pane()), message);
  assert.doesNotMatch(h.content(await h.pane()), /private token/);
  assert.equal(h.state.commands.length, 0); assert.equal(h.state.calls.length, 0);
});

test('Desktop Client load failure offers fenced native Select actions, not another broken Button', async () => {
  const h = await host();
  const render = () => h.fire('ui.render', { component: 'Pane', requestId: 'statewright', surface: 'desktop', props: {} });
  await render();
  await h.fire('ui.fault', { surface: 'desktop', component: 'Pane', requestId: 'statewright', module: 'hooks/desktop-action.js', phase: 'load', reason: 'fixture CSP refusal' });
  const find = tree => tree?.type === 'Select' && /^action-connect-/.test(tree.props.key) ? tree
    : (tree?.props?.children ?? []).map(find).find(Boolean);
  const select = find(await render()); assert.ok(select);
  assert.equal(select.props.label, 'Try connecting again');
  assert.equal(h.find(await render(), 'action-connect'), undefined);
  await select.props.onSelect(select.props.options[0].value); await h.flush();
  assert.equal(h.state.calls.length, 1);
  await select.props.onSelect(select.props.options[0].value); await h.flush();
  assert.equal(h.state.calls.length, 1, 'consumed fallback choice cannot reconnect again');
});
test('shipping manifest is configurable native HTTP OAuth with production defaults and stable identity', () => {
  const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url)));
  const config = JSON.parse(readFileSync(new URL('../.mcp.json', import.meta.url)));
  assert.equal(manifest.name, 'statewright');
  assert.equal(manifest.version, '0.3.4');
  assert.equal(manifest.userConfig.gateway_url.default, GATEWAY);
  assert.deepEqual(config.mcpServers, { [SERVER]: { type: 'http', url: '${user_config.gateway_url}',
    oauth: { clientId: 'statewright-claude', callbackPort: 54545, scopes: 'mcp' } } });
  assert.deepEqual(manifest, JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url))));
  assert.deepEqual(JSON.parse(readFileSync(new URL('../settings.json', import.meta.url))), {});
  assert.doesNotMatch(JSON.stringify({ manifest, config }), /staging|statewright-local|Bearer|api_key/);
  assert.match(LOGIN_COMMAND, /^claude mcp login plugin:statewright:statewright --no-browser$/);
});
test('native auth refusal opens sign-in once, then loads actual catalog and preserves intent', async () => {
  const h = await host();
  const registered = `mcp__statewright__${h.state.spec.name}`;
  h.state.connection = { isConnected: false, reason: 'auth', message: 'Sign in' };
  const result = await h.fire('tool.call', { tool: registered, workflow: 'bugfix' });
  assert.equal(typeof result.result, 'string');
  assert.equal(JSON.parse(result.result).status, 'connection_required');
  assert.equal(h.state.connects, 1, 'model can check saved credentials, not consent to login');
  assert.equal(h.state.commands.length, 0);
  h.state.run = async () => { h.state.connection = { isConnected: true, server: `plugin:statewright:${SERVER}` }; };
  const connect = h.find(await h.pane(), 'connect');
  await connect.props.onPress(); await connect.props.onPress(); await h.flush();
  assert.deepEqual(h.state.commands.map(c => c.argv), [['/usr/bin/expect', '/test-plugin/scripts/native-login.exp']]);
  assert.equal(h.state.commands[0].init.timeoutMs, 330000);
  assert.ok(h.state.slashCommands.every(c => c.args?.startsWith('reconnect ')), 'never open the generic picker');
  assert.equal(h.state.connects, 3);
  assert.deepEqual(h.state.calls.map(c => [c.tool, c.args]), [['statewright_native_connect', { context: { version: 1, conversation_id: CHAT } }]]);
  assert.equal(h.find(await h.pane(), 'workflow').props.value, 'bugfix');
  assert.equal(h.find(await h.pane(), 'start'), undefined);
  assert.match(h.content(await h.pane()), /Connected to Statewright/);
});
test('existing native credentials connect without opening sign-in', async () => {
  const h = await host(); await h.press('connect'); await h.flush();
  assert.equal(h.state.commands.length, 0); assert.equal(h.state.calls.length, 1);
  assert.ok(h.find(await h.pane(), 'workflow'));
  const response = await h.fire('tool.call', { tool: `mcp__statewright__${h.state.spec.name}` });
  assert.deepEqual(JSON.parse(response.result).workflows, ['bugfix', 'plan']);
  assert.equal(JSON.parse(response.result).status, 'connected');
});
test('explicit connection denial never retries through the ordinary catalog or opens OAuth', async () => {
  const h = await host();
  const checked = [];
  h.state.rpcPermission = args => { checked.push(args); return args.context ? { decision: 'deny' } : { decision: 'allow' }; };
  await h.press('connect'); await h.flush();
  assert.deepEqual(checked, [{ context: { version: 1, conversation_id: CHAT } }]);
  assert.equal(h.state.calls.length, 0);
  assert.equal(h.state.commands.length, 0);
  assert.equal(h.find(await h.pane(), 'workflow'), undefined);
  assert.ok(h.find(await h.pane(), 'connect'));
  await h.flush(); assert.equal(checked.length, 1);
});
test('quiet startup stays ordinary; explicit Refresh reads connection snapshot in one call', async () => {
  const h = await host({ startup: false }); await h.flush();
  assert.deepEqual(h.state.calls.map(c => c.tool), ['statewright_list_workflows']);
  await h.press('refresh'); await h.flush();
  assert.deepEqual(h.state.calls.map(c => c.tool), ['statewright_list_workflows', 'statewright_native_connect']);
  assert.equal(h.state.commands.length, 0);
});
test('workspace reads its own native state and shows current/next without claiming Start or model routing', async () => {
  const h = await host(); h.state.session = '11111111-1111-4111-8111-111111111111';
  h.state.catalog = { content: [{ type: 'text', text: JSON.stringify({ workflows: ['bugfix'], native_control: { version: 1 } }) }] };
  h.state.native = { content: [{ type: 'text', text: JSON.stringify({ protocol_version: 1,
    conversation_id: h.state.session, revision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    state: { workflow: 'bugfix', state: 'inspect', is_final: false, transition_count: 1,
      allowed_tools: ['Read'], transitions: [{ event: 'NEXT', target: 'plan' }] }, outcome: null,
    capabilities: { workflow_control: true, native_tool_enforcement: false, human_approval: false, model_routing: false } }) }] };
  await h.press('connect'); await h.flush();
  assert.deepEqual(h.state.calls.map(c => c.tool), ['statewright_native_connect']);
  assert.equal(h.state.calls[0].args.context.conversation_id, h.state.session);
  assert.match(h.content(await h.fire('ui.render', { component: 'AbovePrompt' }, async () => null)), /inspect.*events: :next >/);
  assert.match(h.content(await h.pane()), /:next → ○ plan/);
  assert.match(h.content(await h.pane()), /Current: inspect/);
  assert.equal(h.find(await h.pane(), 'start'), undefined);
  const response = JSON.parse((await h.fire('tool.call', { tool: `mcp__statewright__${h.state.spec.name}` })).result);
  assert.equal(response.state.state, 'inspect');
  assert.equal(response.executionAvailable, false);
  assert.equal(response.capabilities.model_routing, false);
});
test('quiet restore with malformed native state retains catalog but never prompts for another OAuth login', async () => {
  const h = await host({ startup: false }); h.state.session = '11111111-1111-4111-8111-111111111111';
  h.state.catalog = { content: [{ type: 'text', text: JSON.stringify({ workflows: ['bugfix'], native_control: { version: 1 } }) }] };
  h.state.native = { content: [] };
  await h.flush();
  assert.ok(h.find(await h.pane(), 'workflow'));
  assert.match(h.content(await h.pane()), /Couldn’t read this conversation/);
  assert.equal(h.state.commands.length, 0);
  assert.equal(h.state.asks.length, 0);
  assert.equal(h.find(await h.pane(), 'start'), undefined);
});
test('unknown native control version retains catalog and a visible upgrade message, without probing', async () => {
  const h = await host({ startup: false });
  h.state.catalog = { content: [{ type: 'text', text: JSON.stringify({ workflows: ['bugfix'], native_control: { version: 2 } }) }] };
  await h.flush();
  assert.ok(h.find(await h.pane(), 'workflow'));
  assert.match(h.content(await h.pane()), /newer Statewright plugin/);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.find(await h.pane(), 'start'), undefined);
});
test('startup restores saved credentials quietly, and resume checks the new conversation', async () => {
  const h = await host({ startup: false });
  assert.match(h.content(await h.fire('ui.render', { component: 'AbovePrompt' }, async () => null)), /Checking connection/);
  await h.flush();
  assert.equal(h.state.connects, 1); assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.commands.length, 0); assert.equal(h.state.asks.length, 0);
  assert.equal(h.events.length, 0, 'startup does not open a pane');
  await h.fire('classic.SessionStart', {}); await h.flush();
  assert.equal(h.state.calls.length, 1, 'duplicate lifecycle does not duplicate reads');
  h.state.session = 'resumed';
  await h.fire('classic.SessionStart', { source: 'resume' }); await h.flush();
  assert.equal(h.state.calls.length, 2); assert.equal(h.state.commands.length, 0);
  assert.match(h.content(await h.pane()), /Connected to Statewright/);
});
test('first tool joins pending startup, preserves intent and reports a hidden pane honestly', async () => {
  const h = await host({ startup: false }); h.state.placed = false;
  const pending = deferred(); h.state.read = () => pending.promise;
  const job = h.fire('tool.call', { tool: `mcp__statewright__${h.state.spec.name}`, workflow: 'plan' });
  await new Promise(setImmediate);
  const startup = h.flush(); pending.resolve(wire(['bugfix', 'plan']));
  const result = JSON.parse((await job).result); await startup;
  assert.equal(result.status, 'connected'); assert.equal(result.selected, 'plan');
  assert.equal(result.paneVisible, false); assert.equal(result.executionAvailable, false);
  assert.equal(h.state.connects, 1); assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.commands.length, 0); assert.equal(h.state.asks.length, 0);
});
test('quiet startup waits only for native session binding; no authentication is attempted', async () => {
  const h = await host({ startup: false });
  h.state.connect = async () => {
    if (h.state.connects < 3) throw new Error('is not available in this mode: no session is bound in this process');
    return h.state.connection;
  };
  const job = h.flush(); await new Promise(setImmediate);
  assert.equal(h.state.connects, 1);
  await h.flush(250); await new Promise(setImmediate);
  await h.flush(250); await job;
  assert.equal(h.state.connects, 3); assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.commands.length, 0); assert.equal(h.state.asks.length, 0);
});
test('unbound startup has a hard retry bound and command entry can recover later', async () => {
  const h = await host({ startup: false });
  h.state.connect = async () => { throw new Error('no session is bound'); };
  const job = h.flush(); await new Promise(setImmediate);
  for (let i = 0; i < 9; i++) { await h.flush(250); await new Promise(setImmediate); }
  await job; assert.equal(h.state.connects, 10); assert.equal(h.state.commands.length, 0);
  assert.match(h.content(await h.pane()), /Claude is still starting/);
  h.state.connect = null;
  await h.fire('command.run', { command: 'statewright' }); await h.flush();
  assert.equal(h.state.calls.length, 1);
});
test('auth-required startup stays quiet; tool asks natively even when the pane cannot be placed', async () => {
  const h = await host({ startup: false });
  h.state.connection = { isConnected: false, reason: 'auth' }; h.state.placed = false;
  await h.flush(); assert.equal(h.state.asks.length, 0); assert.equal(h.state.commands.length, 0);
  h.state.answer = 'Connect';
  const result = JSON.parse((await h.fire('tool.call', { tool: `mcp__statewright__${h.state.spec.name}` })).result);
  assert.equal(result.status, 'sign_in_in_progress'); assert.equal(result.paneVisible, false);
  assert.deepEqual(h.state.asks[0][1].options, ['Connect', 'Not now']);
  h.state.run = async () => { h.state.connection = { isConnected: true, server: `plugin:statewright:${SERVER}` }; };
  await h.flush(); assert.equal(h.state.commands.length, 1); assert.equal(h.state.calls.length, 1);
});
for (const answer of ['Not now', 'connect please', 'dismiss']) test(`${answer} does not consent to sign-in or repeat the question`, async () => {
  const h = await host(); h.state.connection = { isConnected: false, reason: 'auth' };
  h.state.answer = answer;
  if (answer === 'dismiss') h.state.ask = async () => { throw new Error('dismissed/headless'); };
  for (let i = 0; i < 2; i++) {
    const result = JSON.parse((await h.fire('tool.call', { tool: `mcp__statewright__${h.state.spec.name}` })).result);
    assert.equal(result.status, 'connection_required'); assert.match(result.message, /Open \/statewright/);
  }
  await h.flush(); assert.equal(h.state.commands.length, 0); assert.equal(h.state.asks.length, 1);
});
test('catalog failure is a connection error, not an authentication request', async () => {
  const h = await host({ startup: false }); h.state.catalog = wire(['bad\nname']);
  const result = JSON.parse((await h.fire('tool.call', { tool: `mcp__statewright__${h.state.spec.name}` })).result);
  assert.equal(result.status, 'connection_error'); assert.match(result.message, /Couldn’t read/);
  assert.equal(h.state.asks.length, 0); assert.equal(h.state.commands.length, 0);
});
test('cancel or timeout releases a first-tool waiter and ignores late connection', async () => {
  for (const stop of ['cancel', 'timeout', 'resume']) {
    const h = await host({ startup: false }), pending = deferred(); h.state.connect = () => pending.promise;
    const job = h.fire('tool.call', { tool: `mcp__statewright__${h.state.spec.name}` });
    await new Promise(setImmediate);
    if (stop === 'cancel') await h.press('cancel-connect');
    if (stop === 'timeout') await h.flush(20000);
    if (stop === 'resume') { h.state.session = 'two'; await h.fire('classic.SessionStart', {}); }
    const result = JSON.parse((await job).result);
    assert.equal(result.status, stop === 'resume' ? 'cancelled' : 'connection_error');
    pending.resolve(h.state.connection); await new Promise(setImmediate);
    assert.equal(h.state.calls.length, 0); assert.equal(h.state.commands.length, 0);
  }
});
test('answer from a previous conversation cannot start login', async () => {
  const h = await host(), question = deferred(); h.state.connection = { isConnected: false, reason: 'auth' };
  h.state.ask = () => question.promise;
  const job = h.fire('tool.call', { tool: `mcp__statewright__${h.state.spec.name}` });
  await new Promise(setImmediate); h.state.session = 'two'; await h.fire('classic.SessionStart', {});
  question.resolve('Connect'); assert.equal(JSON.parse((await job).result).status, 'cancelled');
  await h.flush(); assert.equal(h.state.commands.length, 0);
});
test('concurrent tool calls cannot invalidate an unanswered native connection question', async () => {
  const h = await host(), question = deferred(); h.state.connection = { isConnected: false, reason: 'auth' };
  h.state.ask = () => question.promise;
  const tool = `mcp__statewright__${h.state.spec.name}`;
  const first = h.fire('tool.call', { tool }); await new Promise(setImmediate);
  const connects = h.state.connects;
  assert.equal(JSON.parse((await h.fire('tool.call', { tool })).result).status, 'awaiting_confirmation');
  assert.equal(h.state.connects, connects); assert.equal(h.state.asks.length, 1);
  question.resolve('Connect'); assert.equal(JSON.parse((await first).result).status, 'sign_in_in_progress');
  await h.flush(); assert.equal(h.state.commands.length, 1);
});
for (const powerline of [false, true]) test(`Arbiter keeps weekly-usage purple with Powerline ${powerline}`, async () => {
  const h = await host({ options: { powerline } });
  const band = await h.fire('ui.render', { component: 'AbovePrompt', surface: 'terminal' }, async () => null);
  const row = h.find(band, 'arbiter-status');
  assert.equal(row.props.height, 1);
  assert.equal(row.props.children[0].props.wrap, 'truncate-end');
  assert.equal(h.find(band, 'arbiter-label').props[powerline ? 'backgroundColor' : 'color'], '#8BD5E8');
  assert.ok(row.props.children[0].props.children.some(c => c.props?.[powerline ? 'backgroundColor' : 'color'] === '#BA97ED'));
  assert.match(h.content(band), /statewright.ai ∞/);
  assert.equal(h.find(band, 'open-workspace'), undefined);
});

test('configure shortcut opens only the native saved preference dialog', async () => {
  const h = await host();
  const before = [...h.stored];
  await h.fire('command.run', { command: 'statewright', args: 'configure' });
  assert.equal(h.state.slashCommands.length, 0, 'delegate only after the current command returns');
  await h.flush();
  assert.deepEqual(h.state.slashCommands, [{ command: 'plugin', args: 'configure statewright@statewright' }]);
  assert.equal(h.state.connects, 0); assert.equal(h.state.calls.length, 0);
  assert.deepEqual([...h.stored], before);
  await h.fire('command.run', { command: 'statewright', args: 'configure' });
  await h.fire('session.start', {}); await h.flush();
  assert.equal(h.state.slashCommands.length, 1, 'restart discards a queued configuration dialog');
});
test('catalog failure after successful login does not suggest another login', async () => {
  const h = await host(); h.state.connection = { isConnected: false, reason: 'auth' };
  h.state.run = async () => { h.state.connection = { isConnected: true, server: `plugin:statewright:${SERVER}` }; };
  h.state.catalog = wire(['bad\nname']);
  await h.press('connect'); await h.flush();
  assert.match(h.content(await h.pane()), /Couldn’t read your workflows/);
  assert.equal(h.find(await h.pane(), 'copy-login'), undefined);
  assert.doesNotMatch(h.content(await h.pane()), /--no-browser/);
});
for (const reason of ['policy', 'disabled', 'unapproved', 'unlisted', 'failed']) {
  test(`${reason} refusal does not open OAuth or call a tool`, async () => {
    const h = await host(); h.state.connection = { isConnected: false, reason, message: 'private raw details' };
    await h.press('connect'); await h.flush();
    assert.equal(h.state.commands.length, 0); assert.equal(h.state.calls.length, 0);
    assert.doesNotMatch(h.content(await h.pane()), /private raw details/);
    assert.ok(h.find(await h.pane(), 'connect'));
  });
}
test('auth canceled or unfinished does not loop or claim success; retry remains explicit', async () => {
  const h = await host(); h.state.connection = { isConnected: false, reason: 'auth' };
  await h.press('connect'); await h.flush();
  assert.equal(h.state.commands.length, 1); assert.equal(h.state.calls.length, 0);
  assert.match(h.content(await h.pane()), /Sign-in hasn’t completed/);
  assert.ok(h.find(await h.pane(), 'connect'));
});
test('unavailable native sign-in panel gives supported manual path, no fallback auth helper', async () => {
  const h = await host(); h.state.connection = { isConnected: false, reason: 'auth' };
  h.state.run = async () => { throw new Error('headless'); };
  await h.press('connect'); await h.flush();
  assert.match(h.content(await h.pane()), /--no-browser/); assert.equal(h.state.calls.length, 0);
});
test('failed native login exit never claims connection or leaks process output', async () => {
  const h = await host(); h.state.connection = { isConnected: false, reason: 'auth' };
  h.state.run = async () => ({ exitCode: 1, stdout: 'private callback', stderr: 'secret details' });
  await h.press('connect'); await h.flush();
  assert.equal(h.state.connects, 1); assert.equal(h.state.calls.length, 0);
  assert.doesNotMatch(h.content(await h.pane()), /private callback|secret details/);
  assert.ok(h.find(await h.pane(), 'connect'));
});
test('browser handoff hides the pane and restores it when sign-in fails', async () => {
  const h = await host(), pending = deferred();
  await h.fire('command.run', { command: 'statewright' });
  h.state.connection = { isConnected: false, reason: 'auth' }; h.state.run = () => pending.promise;
  await h.flush(); // The command's quiet check must finish before explicit Connect.
  await h.press('connect'); const job = h.flush(); await new Promise(setImmediate);
  assert.deepEqual(h.events.at(-1), ['close', { id: 'statewright' }]);
  pending.resolve({ exitCode: 1 }); await job;
  assert.equal(h.events.at(-1)[0], 'open');
  assert.equal(h.events.at(-1)[1].focus, undefined, 'completion does not take keyboard focus');
  assert.doesNotMatch(h.content(await h.pane()), /Opening Statewright/);
});
test('person closing the workspace during sign-in prevents automatic reopening', async () => {
  const h = await host(), pending = deferred();
  await h.fire('command.run', { command: 'statewright' });
  h.state.connection = { isConnected: false, reason: 'auth' }; h.state.run = () => pending.promise;
  await h.flush();
  await h.press('connect'); const job = h.flush(); await new Promise(setImmediate);
  await h.fire('ui.close', { id: 'statewright', origin: { kind: 'person' } });
  pending.resolve({ exitCode: 1 }); await job;
  assert.equal(h.events.filter(([kind]) => kind === 'open' || kind === 'close').at(-1)[0], 'close');
});
test('short pane has Connect and Back before descriptive copy', async () => {
  const h = await host();
  const pane = await h.pane();
  assert.equal(pane.props.rowGap, 0);
  assert.equal(pane.props.children[1].props.key, 'connect');
  assert.equal(pane.props.children[2].props.key, 'copy-login');
  assert.equal(pane.props.children[3].props.key, 'close');
});
test('SSH recovery copies the complete native command before any long clipped text', async () => {
  const h = await host(); h.state.connection = { isConnected: false, reason: 'auth' };
  h.state.run = async () => ({ exitCode: 1 });
  await h.press('connect'); await h.flush();
  assert.equal((await h.pane()).props.children[2].props.key, 'copy-login');
  await h.press('copy-login');
  assert.deepEqual(h.state.copies, [{ text: LOGIN_COMMAND }]);
  assert.match(h.content(await h.pane()), /Copied\. Run/);
  h.state.copied = false; await h.press('copy-login');
  assert.match(h.content(await h.pane()), /Clipboard unavailable/);
  assert.equal(h.state.commands.length, 1, 'copying never starts another login');
});
for (const stop of ['cancel', 'resume', 'unload', 'timeout']) test(`${stop} discards late OAuth completion`, async () => {
  const h = await host(); const pending = deferred();
  h.state.connection = { isConnected: false, reason: 'auth' }; h.state.run = () => pending.promise;
  await h.press('connect'); const job = h.flush(); await new Promise(setImmediate);
  if (stop === 'cancel') await h.press('cancel-connect');
  if (stop === 'resume') { h.state.session = 'two'; await h.fire('classic.SessionStart', { source: 'resume' }); }
  if (stop === 'unload') await h.fire('session.end', {});
  if (stop === 'timeout') await h.flush(600000);
  h.state.connection = { isConnected: true, server: `plugin:statewright:${SERVER}` };
  pending.resolve({}); await job;
  assert.equal(h.state.calls.length, 0); assert.equal(h.find(await h.pane(), 'workflow'), undefined);
});
test('late catalog read cannot populate a different conversation', async () => {
  const h = await host(), pending = deferred(); h.state.read = () => pending.promise;
  await h.press('connect'); const job = h.flush(); await new Promise(setImmediate);
  h.state.session = 'two'; await h.fire('classic.SessionStart', { source: 'resume' });
  pending.resolve(wire(['foreign'])); await job;
  assert.equal(h.find(await h.pane(), 'workflow'), undefined);
});
for (const stop of ['cancel', 'resume', 'timeout']) test(`${stop} then retry shares an unresolved native sign-in`, async () => {
  const h = await host(), pending = deferred();
  h.state.connection = { isConnected: false, reason: 'auth' }; h.state.run = () => pending.promise;
  await h.press('connect'); const first = h.flush(); await new Promise(setImmediate);
  if (stop === 'cancel') await h.press('cancel-connect');
  if (stop === 'resume') { h.state.session = '22222222-2222-4222-8222-222222222222'; await h.fire('classic.SessionStart', { source: 'resume' }); }
  if (stop === 'timeout') await h.flush(600000);
  if (stop === 'resume') await h.flush(); // New view quietly checks saved native auth first.
  await h.press('connect'); const second = h.flush(); await new Promise(setImmediate);
  assert.equal(h.state.commands.length, 1, 'native sign-in must not be duplicated');
  h.state.connection = { isConnected: true, server: `plugin:statewright:${SERVER}` };
  pending.resolve({}); await Promise.all([first, second]);
  assert.equal(h.state.calls.length, 1);
  assert.ok(h.find(await h.pane(), 'workflow'));
});
test('initial selection prefers engineering, refresh preserves a deliberate choice, unavailable starter is not invented', async () => {
  const h = await host();
  h.state.catalog = wire(['aaa-custom', 'agentic-engineering', 'bugfix']);
  await h.press('connect'); await h.flush();
  assert.equal(h.find(await h.pane(), 'workflow').props.value, 'agentic-engineering');
  await h.find(await h.pane(), 'workflow').props.onSelect('aaa-custom');
  await h.press('refresh'); await h.flush();
  assert.equal(h.find(await h.pane(), 'workflow').props.value, 'aaa-custom');
  await h.find(await h.pane(), 'workflow').props.onSelect('agentic-engineering');
  h.state.catalog = wire(['aaa-custom', 'bugfix']);
  await h.press('refresh'); await h.flush();
  assert.equal(h.find(await h.pane(), 'workflow').props.value, 'aaa-custom');
});
test('local selection makes no workflow call, empty catalog shows a useful state', async () => {
  const h = await host(); await h.press('connect'); await h.flush();
  await h.find(await h.pane(), 'workflow').props.onSelect('plan');
  assert.equal(h.state.calls.length, 1); assert.equal(h.find(await h.pane(), 'workflow').props.value, 'plan');
  h.state.catalog = wire([]); await h.press('refresh'); await h.flush();
  assert.match(h.content(await h.pane()), /No workflows/); assert.equal(h.find(await h.pane(), 'workflow'), undefined);
});
test('catalog refresh invalidates retained page and selection callbacks', async () => {
  const h = await host(); h.state.catalog = wire(Array.from({ length: 67 }, (_, i) => `workflow-${i}`));
  await h.press('connect'); await h.flush();
  const old = await h.pane();
  const select = h.find(old, 'workflow').props.onSelect;
  const next = h.find(old, 'next-page').props.onPress;
  h.state.catalog = wire(['replacement']);
  await h.press('refresh'); await h.flush();
  await select('workflow-0'); await next();
  const current = h.find(await h.pane(), 'workflow').props;
  assert.equal(current.value, 'replacement');
  assert.deepEqual(current.options, [{ value: 'replacement', label: 'replacement' }]);
});
test('guard refuses non-catalog gateway tools including unknown tools; unrelated native rules unchanged', async () => {
  const h = await host();
  for (const name of ['statewright_load_workflow', 'statewright_transition', 'statewright_get_state', 'new_mutation', 'future_mutation__statewright_list_workflows', 'statewright-list-workflows']) {
    const tool = `mcp__plugin_statewright_${SERVER}__${name}`;
    assert.equal(gatewayTool(tool), true);
    const check = await h.fire('tool.check', { tool, input: {} }, async () => ({ decision: 'allow' }));
    assert.equal(check.decision, 'deny');
    assert.ok((await h.fire('tool.call', { tool }, async () => assert.fail('must not dispatch'))).deny);
  }
  const native = { decision: 'ask', reason: 'native rule' };
  assert.deepEqual(await h.fire('tool.check', { tool: 'Bash', input: {} }, async () => native), native);
  for (const name of ['tool.check', 'tool.call', 'mcp.call']) assert.equal(typeof h.hooks.find(h => h.name === name).fallback, 'function');
  const direct = await h.fire('mcp.call', { server: `plugin:statewright:${SERVER}`, tool: 'statewright_transition', args: {} }, async () => assert.fail('must not dispatch'));
  assert.ok(direct.deny);
});
test('workflow request tool remains available before auth and prompt context does not claim active workflow', async () => {
  const h = await host(); assert.equal(h.state.spec.isDeferred, false);
  const result = await h.fire('prompt.context', { blocks: [{ name: 'other', text: 'retain' }] }, async e => e);
  assert.equal(result.blocks[0].name, 'other');
  assert.match(result.blocks[1].text, /statewright_connect/);
  assert.match(result.blocks[1].text, /No verified active workflow/);
});
test('catalog allowance delegates native policy; only empty catalog arguments pass', async () => {
  const h = await host();
  const tool = `mcp__plugin_statewright_${SERVER}__statewright_list_workflows`;
  const native = { decision: 'deny', reason: 'user rule' };
  assert.deepEqual(await h.fire('tool.check', { tool, input: {} }, async () => native), native);
  assert.deepEqual(await h.fire('tool.call', { tool, tool_use_id: 'test', agentId: 'test', requestMeta: {} }, async () => ({ result: 'ok' })), { result: 'ok' });
  for (const input of [null, [], '', { mutation: true }]) {
    assert.equal((await h.fire('tool.check', { tool, input }, () => assert.fail('not empty'))).decision, 'deny');
    assert.ok((await h.fire('mcp.call', { server: SERVER, tool: 'statewright_list_workflows', args: input }, () => assert.fail('not empty'))).deny);
  }
  assert.ok((await h.fire('tool.call', { tool, mutation: true }, () => assert.fail('extra arg'))).deny);
});
test('execution package no longer installs the catalog-only command guard', () => {
  const config = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url)));
  assert.deepEqual(config, { modules: ['./connect.js'] });
});
test('all mod boundaries reject foreign native context and mutations; own reads preserve native denials', async () => {
  const h = await host(); h.state.session = '11111111-1111-4111-8111-111111111111';
  const tool = `mcp__plugin_statewright_${SERVER}__statewright_native_request`;
  const args = { context: { version: 1, conversation_id: h.state.session }, operation: 'get_state', input: {}, expected_revision: null };
  const refusal = { decision: 'deny', reason: 'Native user rule' };
  assert.deepEqual(await h.fire('tool.check', { tool, input: args }, async () => refusal, { plugin: 'statewright' }), refusal);
  assert.deepEqual(await h.fire('tool.call', { tool, ...args }, async () => ({ deny: 'Native user rule' }), { plugin: 'statewright' }), { deny: 'Native user rule' });
  for (const input of [{ ...args, context: { ...args.context, conversation_id: '22222222-2222-4222-8222-222222222222' } },
    { ...args, operation: 'load_workflow', input: { name: 'bugfix' } }, { ...args, approved: true }]) {
    assert.equal((await h.fire('tool.check', { tool, input }, () => assert.fail())).decision, 'deny');
    assert.ok((await h.fire('tool.call', { tool, ...input }, () => assert.fail())).deny);
    assert.ok((await h.fire('mcp.call', { server: SERVER, tool: 'statewright_native_request', args: input }, () => assert.fail())).deny);
  }
});

// A stateful wire fixture exercises the shipping workspace, not the older
// separate visual mock. The real Rust/native-host interoperability is separate.
async function workflowHost(catalog) {
  const h = await host();
  if (catalog) h.state.catalog = { content: [{ type: 'text', text: JSON.stringify(catalog) }] };
  h.state.session = '11111111-1111-4111-8111-111111111111';
  const snapshot = { protocol_version: 1, conversation_id: h.state.session, revision: crypto.randomUUID(), state: null, outcome: null,
    ...(catalog?.workflow_aliases ? { workflow_aliases: catalog.workflow_aliases } : {}),
    capabilities: { workflow_control: true, native_tool_enforcement: true, human_approval: true, model_routing: false } };
  const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  h.state.read = async ({ tool, args }) => {
    if (tool === 'statewright_list_workflows') return result({ workflows: ['bugfix', 'plan'], native_control: { version: 1 } });
    if (tool === 'statewright_native_connect') return connectionWire(h.state, snapshot);
    assert.equal(args.context.conversation_id, h.state.session);
    if (args.operation === 'get_state') return result({ ...snapshot, outcome: null });
    assert.equal(args.expected_revision, snapshot.revision);
    let outcome = {};
    if (args.operation === 'load_workflow') snapshot.state = { workflow: args.input.name, state: 'work', is_final: false,
      transition_count: 0, allowed_tools: ['Read'], transitions: [{ event: 'DONE', target: 'complete' }], model_routing: { enforced: false } };
    if (args.operation === 'pre_tool') outcome = { decision: args.input.tool_name === 'Read' ? 'allow' : 'deny' };
    if (args.operation === 'post_tool') outcome = { active: true };
    if (args.operation === 'stop') outcome = { decision: snapshot.state?.is_final || !snapshot.state ? 'allow' : 'block', reason: 'Finish the workflow' };
    if (args.operation === 'transition') snapshot.state = { ...snapshot.state, state: 'complete', is_final: true, transition_count: 1, transitions: [] };
    if (args.operation === 'deactivate') snapshot.state = null;
    snapshot.revision = crypto.randomUUID();
    return result({ ...snapshot, outcome: result(outcome) });
  };
  await h.press('connect'); await h.flush();
  return { ...h, snapshot };
}
test('shipping workspace journey: select, Start, check, record, next step, Off', async () => {
  const h = await workflowHost();
  assert.ok(h.find(await h.pane(), 'start'));
  await h.find(await h.pane(), 'workflow').props.onSelect('plan');
  assert.equal(h.state.calls.filter(c => c.args.operation === 'load_workflow').length, 0);
  await h.press('start');
  assert.match(h.content(await h.pane()), /Current: work/);
  assert.match(h.content(await h.pane()), /this state has no active model route/);
  const result = await h.fire('tool.call', { tool: 'Read', tool_use_id: 'actual-read', file_path: '/fixture' }, async () => {
    const verdict = await h.fire('tool.check', { tool: 'Read', tool_use_id: 'actual-read', input: { file_path: '/fixture' } }, async () => ({ decision: 'ask' }));
    assert.equal(verdict.decision, 'ask');
    await h.fire('classic.PostToolUse', { tool_name: 'Read', tool_use_id: 'actual-read', tool_input: { file_path: '/fixture' }, tool_response: 'ok' });
    return { result: 'native output' };
  });
  assert.equal(result.result, 'native output');
  assert.match((await h.fire('classic.Stop', {}, async () => ({}))).block, /Finish/);
  await h.find(await h.pane(), 'next-state').props.onSelect('DONE');
  assert.match(h.content(await h.pane()), /Current: complete/);
  assert.equal((await h.fire('classic.Stop', {}, async () => ({}))).block, undefined);
  await h.press('off');
  assert.equal(h.snapshot.state, null);
  assert.deepEqual(h.state.calls.map(c => c.args.operation).filter(Boolean),
    ['load_workflow', 'pre_tool', 'post_tool', 'stop', 'transition', 'get_state', 'deactivate']);
});
test('sidebar Start followed by the same named workflow request reads state without a duplicate load', async () => {
  const h = await workflowHost(); await h.press('start');
  const read = h.state.read;
  h.state.read = async call => {
    if (call.args.operation === 'load_workflow') return { isError: true,
      content: [{ type: 'text', text: 'A workflow is already active in this conversation' }] };
    return read(call);
  };
  const before = structuredClone(h.snapshot);
  const result = JSON.parse((await h.fire('tool.call', { tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' })).result);
  assert.equal(result.status, 'already_active');
  assert.equal(result.state.state, 'work');
  assert.equal(result.outcome, null, 'readback does not invent a load outcome');
  assert.equal(h.state.calls.filter(c => c.args.operation === 'load_workflow').length, 1);
  assert.deepEqual(h.snapshot, before, 'same workflow/run/revision preserved');
  const chunks = [];
  for await (const chunk of await h.fire('turn.step', { turnId: 'after-repeat', index: 1, model: 'claude-opus-5-5' }, async function* () {
    yield { kind: 'text', text: 'Canary continues' };
  })) chunks.push(chunk);
  assert.ok(chunks.some(c => c.text === 'Canary continues'));
  assert.ok(!chunks.some(c => /refresh the workflow/.test(c.text ?? '')));
});
test('engineering alias continues canonical native state without changing load arguments or restarting', async () => {
  const h = await workflowHost({ workflows: ['agentic-engineering'], workflow_aliases: { engineering: 'agentic-engineering' } });
  await h.press('start');
  const before = structuredClone(h.snapshot);
  const result = JSON.parse((await h.fire('tool.call', { tool: 'mcp__statewright__statewright_load_workflow', name: 'engineering' })).result);
  assert.equal(result.status, 'already_active');
  assert.equal(result.state.workflow, 'agentic-engineering');
  assert.deepEqual(h.snapshot, before);
  assert.equal(h.state.calls.filter(c => c.args.operation === 'load_workflow').length, 1);
  // Fresh server metadata can revoke an earlier alias when an exact entry is
  // created or disabled. Do not trust the connection's old enabled-name list.
  h.snapshot.workflow_aliases = {};
  const revoked = JSON.parse((await h.fire('tool.call', { tool: 'mcp__statewright__statewright_load_workflow', name: 'engineering' })).result);
  assert.equal(revoked.status, 'workflow_conflict');
  assert.equal(h.state.calls.filter(c => c.args.operation === 'load_workflow').length, 1);
});
test('engineering alias preserves the original consent-bound native load arguments', async () => {
  const h = await workflowHost({ workflows: ['agentic-engineering'], workflow_aliases: { engineering: 'agentic-engineering' } });
  await h.fire('tool.call', { tool: 'mcp__statewright__statewright_load_workflow', name: 'engineering' });
  const loads = h.state.calls.filter(c => c.args.operation === 'load_workflow');
  assert.equal(loads.length, 1);
  assert.deepEqual(loads[0].args.input, { name: 'engineering' });
});
test('fresh engineering alias identity supersedes a connection catalog containing the old exact name', async () => {
  const h = await workflowHost({ workflows: ['engineering'] });
  await h.press('start');
  h.snapshot.state.workflow = 'agentic-engineering';
  h.snapshot.workflow_aliases = { engineering: 'agentic-engineering' };
  const result = JSON.parse((await h.fire('tool.call', { tool: 'mcp__statewright__statewright_load_workflow', name: 'engineering' })).result);
  assert.equal(result.status, 'already_active');
  assert.equal(result.state.workflow, 'agentic-engineering');
  assert.equal(h.state.calls.filter(c => c.args.operation === 'load_workflow').length, 1);
});
test('requesting a different active workflow preserves the run and reports the conflict', async () => {
  const h = await workflowHost(); await h.press('start');
  const before = structuredClone(h.snapshot);
  const result = JSON.parse((await h.fire('tool.call', { tool: 'mcp__statewright__statewright_load_workflow', name: 'plan' })).result);
  assert.equal(result.status, 'workflow_conflict');
  assert.deepEqual(h.snapshot, before);
  assert.equal(result.state.workflow, 'bugfix');
  assert.equal(h.state.calls.filter(c => c.args.operation === 'load_workflow').length, 1);
});
test('duplicate Start uses authoritative readback instead of stale local workflow identity', async () => {
  const h = await workflowHost(); await h.press('start');
  h.snapshot.state = { ...h.snapshot.state, workflow: 'plan' };
  h.snapshot.revision = crypto.randomUUID();
  const result = JSON.parse((await h.fire('tool.call', { tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' })).result);
  assert.equal(result.status, 'workflow_conflict');
  assert.equal(result.state.workflow, 'plan');
  assert.equal(result.revision, h.snapshot.revision);
  assert.equal(h.state.calls.filter(c => c.args.operation === 'load_workflow').length, 1);
});
test('failed duplicate-Start readback never claims continuation or replays a load', async () => {
  const h = await workflowHost(); await h.press('start');
  const before = structuredClone(h.snapshot), read = h.state.read;
  h.state.read = call => call.args.operation === 'get_state' ? Promise.reject(new Error('Network unavailable')) : read(call);
  const result = JSON.parse((await h.fire('tool.call', { tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' })).result);
  assert.equal(result.status, 'action_needed');
  assert.deepEqual(h.snapshot, before);
  assert.equal(h.state.calls.filter(c => c.args.operation === 'load_workflow').length, 1);
  assert.equal(h.stored.get(`workflow-active:${CHAT}`), true);
});

for (const stage of ['readback-active', 'readback-empty', 'readback-final', 'before-load']) {
  for (const stop of ['resume', 'off']) test(`${stop} during duplicate Start ${stage} cannot continue the old action`, async () => {
    const h = await workflowHost(); await h.press('start');
    if (stage === 'readback-empty' || stage === 'before-load') h.snapshot.state = null;
    if (stage === 'readback-final') h.snapshot.state = { ...h.snapshot.state, is_final: true };
    const entered = deferred(), release = deferred(), set = h.$.store.set;
    let writes = 0;
    h.$.store.set = async (key, value) => {
      const result = await set(key, value);
      if (key === `workflow-active:${CHAT}` && ++writes === (stage === 'before-load' ? 2 : 1)) {
        entered.resolve(); await release.promise;
      }
      return result;
    };
    const repeat = h.fire('tool.call', { tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' });
    await entered.promise;
    if (stop === 'resume') {
      h.state.session = '22222222-2222-4222-8222-222222222222';
      h.snapshot.conversation_id = h.state.session; h.snapshot.state = null;
      await h.fire('classic.SessionStart', { source: 'resume' }); await h.flush();
    } else await h.fire('tool.call', { tool: 'mcp__statewright__statewright_deactivate' });
    release.resolve();
    const result = JSON.parse((await repeat).result);
    assert.equal(result.status, 'action_needed');
    assert.equal(h.state.calls.filter(c => c.args.operation === 'load_workflow').length, 1,
      'only the original sidebar Start reached the gateway');
    assert.equal(h.snapshot.state, null, 'the old request cannot revive a run');
  });
}

for (const stop of ['resume', 'off']) test(`${stop} during dispatch lookup cannot recapture a newer controller`, async () => {
  const h = await workflowHost(); await h.press('start'); h.snapshot.state = null;
  const entered = deferred(), release = deferred(), set = h.$.store.set;
  let armed = false, reads = 0;
  h.$.store.set = async (key, value) => {
    const result = await set(key, value);
    if (key === `workflow-active:${CHAT}` && value === true) armed = true;
    return result;
  };
  h.state.sessionId = async () => {
    if (armed && ++reads === 2) { entered.resolve(); await release.promise; }
    return h.state.session;
  };
  const repeat = h.fire('tool.call', { tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' });
  await entered.promise;
  if (stop === 'resume') {
    h.state.session = '22222222-2222-4222-8222-222222222222'; h.snapshot.conversation_id = h.state.session;
    await h.fire('classic.SessionStart', { source: 'resume' }); await h.flush();
  } else await h.fire('tool.call', { tool: 'mcp__statewright__statewright_deactivate' });
  release.resolve();
  assert.equal(JSON.parse((await repeat).result).status, 'action_needed');
  assert.equal(h.state.calls.filter(c => c.args.operation === 'load_workflow').length, 1);
  assert.equal(h.snapshot.state, null);
});

for (const entry of ['sidebar', 'load', 'connect']) test(`Start refusal explains the failure but requires readback: ${entry}`, async () => {
  const h = await workflowHost();
  const read = h.state.read;
  h.state.read = async call => {
    if (call.args.operation === 'load_workflow') throw new Error('statewright: $.mcp.call(server, statewright_native_request) refused: Safety classifier gave no verdict for tool: the request that produced this action did not ask for one. Tell the user that auto mode could not evaluate it. PRIVATE_TOKEN');
    return read(call);
  };
  if (entry === 'sidebar') await h.press('start');
  else {
    const result = await h.fire('tool.call', entry === 'load'
      ? { tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' }
      : { tool: 'mcp__statewright__statewright_connect', workflow: 'bugfix' });
    const value = JSON.parse(result.result);
    assert.equal(value.status, 'action_needed');
    assert.match(value.message, /auto_review_unavailable/);
  }
  assert.equal(h.snapshot.state, null);
  assert.equal(h.stored.get(`workflow-active:${CHAT}`), true);
  assert.equal(h.stored.get('latest-control-diagnostic').code, 'auto_review_unavailable');
  assert.doesNotMatch(h.content(await h.pane()), /PRIVATE_TOKEN|Nothing was sent/);
  const calls = [];
  async function* next(e) { calls.push(e); return {}; }
  for await (const _ of await h.fire('turn.step', { model: 'claude-opus-5-5', turnId: 'after-refusal' }, next)) {}
  assert.equal(calls.length, 0, 'A denied result does not prove a mutation did not run');
  h.state.read = read;
  await h.fire('tool.call', { tool: 'mcp__statewright__statewright_get_state' });
  assert.equal(h.stored.get(`workflow-active:${CHAT}`), false, 'Only verified readback clears provisional enforcement');
  await h.press('start');
  assert.equal(h.snapshot.state.workflow, 'bugfix', 'New explicit action uses the fresh verified revision');
});

test('uncertain Start failure retains enforcement and requires readback, without leaking the exception', async () => {
  const h = await workflowHost();
  h.state.read = async () => { throw new Error('timeout at https://private.example/?key=PRIVATE_TOKEN'); };
  await h.press('start');
  assert.equal(h.stored.get(`workflow-active:${CHAT}`), true);
  const d = h.stored.get('latest-control-diagnostic');
  assert.equal(d.code, 'request_timeout');
  assert.doesNotMatch(h.content(await h.pane()), /PRIVATE_TOKEN|private.example|Nothing was sent/);
  const calls = [];
  async function* next(e) { calls.push(e); return {}; }
  for await (const _ of await h.fire('turn.step', { model: 'claude-opus-5-5', turnId: 'after-uncertain' }, next)) {}
  assert.equal(calls.length, 0, 'An ambiguous mutation must still require readback');
});

for (const mode of ['credit', 'null-only', 'partial', 'tool', 'server-tool', 'policy', 'env', 'off', 'resume', 'abort', 'opus-error']) test(`Fable ladder: ${mode}`, async () => {
  const h = await workflowHost(); await h.press('start');
  h.snapshot.state = { ...h.snapshot.state, model: 'astra', thinking_level: 'high' };
  await h.fire('tool.call', { tool: 'mcp__statewright__statewright_get_state' });
  if (mode === 'policy') h.state.settings = { availableModels: ['fable'] };
  if (mode === 'env') h.state.noFallback = '1';
  const signal = new AbortController(); const calls = [];
  const event = { turnId: 'ladder', index: 0, model: 'claude-sonnet-5-5', effort: 'low' };
  const next = async function* (e) {
    calls.push(e);
    if (e.model === 'claude-opus-5-5') {
      if (mode === 'opus-error') throw new Error('Opus unavailable too');
      const usage = { model: e.model, input_tokens: 1, output_tokens: 1 };
      yield { kind: 'text', index: 0, text: 'done' };
      return { turnId: e.turnId, index: e.index, answer: 'done', usage, stopReason: 'end_turn', toolUses: [] };
    }
    if (mode !== 'null-only') await h.fire('session.append', { door: 'response', origin: { kind: 'model', model: '<synthetic>' },
      message: { content: [{ type: 'text', text: 'Fable 5.1 requires usage credits. Run /usage-credits to continue or switch models with /model.' }] } });
    if (mode === 'off') await h.fire('tool.call', { tool: 'mcp__statewright__statewright_deactivate' });
    if (mode === 'resume') h.state.session = '44444444-4444-4444-8444-444444444444';
    if (mode === 'abort') signal.abort();
    if (mode === 'partial') yield { kind: 'text', index: 0, text: 'partial work' };
    return { turnId: e.turnId, index: e.index, answer: '', usage: null, stopReason: null,
      toolUses: mode === 'tool' ? [{ id: 'executed' }] : [], serverToolUses: mode === 'server-tool' ? [{ id: 'executed' }] : [] };
  };
  next.signal = signal.signal;
  const stream = await h.fire('turn.step', event, next);
  if (mode === 'opus-error') {
    await assert.rejects(async () => { for await (const c of stream) {} }, /Opus unavailable/);
    assert.equal(calls.length, 2);
    const response = JSON.parse((await h.fire('tool.call', { tool: 'mcp__statewright__statewright_get_state' })).result);
    const r = response.client_model_routing.last_request;
    assert.equal(r.failure, 'native_request_failed'); assert.equal(r.status, 'unavailable');
    assert.equal(r.attempts.length, 2); assert.equal(r.attempts[1].native_model, 'claude-opus-5-5'); return;
  }
  for await (const chunk of stream) {}
  assert.equal(calls.length, mode === 'credit' ? 2 : 1);
  if (mode === 'credit') {
    assert.equal(calls[1].effort, 'high');
    const response = JSON.parse((await h.fire('tool.call', { tool: 'mcp__statewright__statewright_get_state' })).result);
    const r = response.client_model_routing.last_request;
    assert.equal(r.status, 'observed'); assert.equal(r.fallback_from, 'claude-fable-5-1');
    assert.equal(r.attempts.length, 2); assert.equal(r.attempts[0].status, 'unavailable');
    const more = await h.fire('turn.step', { ...event, index: 1 }, next); for await (const chunk of more) {}
    assert.equal(calls.length, 3); assert.equal(calls[2].model, 'claude-opus-5-5');
    const fresh = await h.fire('turn.step', { ...event, turnId: 'fresh' }, next); for await (const chunk of fresh) {}
    assert.equal(calls[3].model, 'claude-fable-5-1'); assert.equal(calls.length, 5);
  }
});
for (const fallback of [false, true]) test(`cancellation in final microtask boundary never dispatches an aborted request (fallback=${fallback})`, async () => {
  const h = await workflowHost(); await h.press('start');
  h.snapshot.state = { ...h.snapshot.state, model: 'astra', thinking_level: 'high' };
  await h.fire('tool.call', { tool: 'mcp__statewright__statewright_get_state' });
  const controller = new AbortController(); let calls = 0, reads = 0, armed = !fallback;
  h.$.session.id = async () => {
    if (armed && ++reads === (fallback ? 1 : 6)) queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => controller.abort())));
    return h.state.session;
  };
  const next = async function* (e) {
    assert.equal(controller.signal.aborted, false, 'Never dispatch after abort'); calls++;
    await h.fire('session.append', { door: 'response', origin: { kind: 'model', model: '<synthetic>' },
      message: { content: [{ type: 'text', text: 'Fable 5.1 requires usage credits. Run /usage-credits to continue or switch models with /model.' }] } });
    armed = true; reads = 0;
    return { turnId: e.turnId, index: e.index, answer: '', usage: null, stopReason: null, toolUses: [] };
  };
  next.signal = controller.signal;
  const stream = await h.fire('turn.step', { turnId: 'microtask', index: 0, model: 'opus' }, next);
  for await (const c of stream) {}
  assert.equal(controller.signal.aborted, true);
  // With the async helper removed, dispatch can occur BEFORE this queued abort.
  // The spy above rejects dispatch AFTER it; already-started work is not replay.
  assert.ok(calls <= (fallback ? 2 : 1));
});
for (const final of [false, true]) test(`native routing fences Off during the last await (final=${final})`, async () => {
  const h = await workflowHost(); await h.press('start');
  h.snapshot.state = { ...h.snapshot.state, model: 'astra', thinking_level: 'high', is_final: final };
  await h.fire('tool.call', { tool: 'mcp__statewright__statewright_get_state' });
  const reached = deferred(), release = deferred();
  const read = h.state.read;
  let off, reads = 0, called = 0;
  h.state.read = async request => {
    if (request.args.operation === 'get_state') { reached.resolve(); await release.promise; }
    return read(request);
  };
  h.$.session.id = async () => {
    if (++reads === 5) {
      off = h.fire('tool.call', { tool: 'mcp__statewright__statewright_deactivate' });
      await reached.promise; // Off holds the native request; snapshot is still old.
    }
    return h.state.session;
  };
  const stream = await h.fire('turn.step', { turnId: 'race', index: 0, model: 'opus' }, async function* () {
    called++; return { usage: { model: 'claude-fable-5' } };
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  release.resolve(); await off;
  assert.ok(off); assert.equal(called, 0);
  assert.ok(chunks.some(c => c.text?.includes('workflow changed')));
});
test('model workflow request starts through the same control path; stale Start cannot start again', async () => {
  const h = await workflowHost();
  const oldStart = h.find(await h.pane(), 'start');
  const response = await h.fire('tool.call', { tool: 'mcp__statewright__statewright_connect', workflow: 'plan' });
  assert.equal(JSON.parse(response.result).status, 'workflow_active');
  assert.equal(JSON.parse(response.result).executionAvailable, true);
  assert.equal(h.snapshot.state.workflow, 'plan');
  await oldStart.props.onPress();
  assert.equal(h.state.calls.filter(c => c.args.operation === 'load_workflow').length, 1);
  assert.match(h.content(await h.pane()), /workflow changed/);
});
test('Off during pending review does not wait for the form and late result cannot revive workflow', async () => {
  const h = await workflowHost(); await h.press('start');
  const originalRead = h.state.read, pending = deferred();
  h.snapshot.state = { ...h.snapshot.state, run_id: 'run-1', pending_approval: { approval_id: 'approval-1',
    event: 'DONE', from_state: 'work', to_state: 'complete', message: 'Review' } };
  await h.fire('tool.call', { tool: 'mcp__statewright__statewright_get_state' });
  h.state.read = async e => e.args.operation === 'request_approval' ? pending.promise : originalRead(e);
  const reviewing = h.press('review'); await new Promise(setImmediate);
  await h.press('off');
  assert.equal(h.snapshot.state, null);
  pending.resolve({ content: [{ type: 'text', text: JSON.stringify({ ...h.snapshot, revision: crypto.randomUUID(),
    state: { workflow: 'bugfix', state: 'complete', is_final: true, transition_count: 1, transitions: [], allowed_tools: [] },
    outcome: { content: [{ type: 'text', text: '{}' }] } }) }] });
  await reviewing;
  assert.equal(h.find(await h.pane(), 'off'), undefined);
  assert.ok(h.find(await h.pane(), 'start'));
  assert.doesNotMatch(h.content(await h.pane()), /superseded|complete|failed/i);
});
test('registered controls preserve native deny and carry ask to actual MCP permission settlement', async () => {
  for (const decision of ['deny', 'ask']) {
    const h = await workflowHost(), before = h.state.calls.length;
    h.state.toolPermission = () => ({ decision, reason: 'Native test rule' });
    const result = await h.fire('tool.call', { tool: 'mcp__statewright__statewright_load_workflow', name: 'plan' });
    assert.equal(h.state.calls.length, before, `${decision} did not reach gateway`);
    assert.equal(h.snapshot.state, null);
    if (decision === 'deny') assert.equal(result.deny, 'Native test rule');
    else assert.equal(JSON.parse(result.result).status, 'action_needed');
  }
});
for (const entry of ['load', 'connect']) test(`saved gateway allow does not suppress new facade consent: ${entry}`, async () => {
  const h = await workflowHost();
  h.state.rpcPermission = () => ({ decision: 'allow', rule: 'saved gateway allow' });
  h.state.toolPermission = () => ({ decision: 'ask', reason: 'New facade requires permission' });
  h.state.answer = 'Allow this session';
  const result = await h.fire('tool.call', entry === 'load'
    ? { tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' }
    : { tool: 'mcp__statewright__statewright_connect', workflow: 'bugfix' });
  assert.equal(JSON.parse(result.result).state?.state, 'work');
  assert.equal(h.state.asks.length, 1, 'permission appears at the requested action, without Refresh');
  assert.equal(h.state.calls.filter(c => c.args?.operation === 'load_workflow').length, 1);
});

for (const source of ['rule', 'hook']) test(`facade allow ${source} does not suppress a native control question`, async () => {
  const h = await workflowHost();
  h.state.rpcPermission = () => ({ decision: 'ask' });
  h.state.toolPermission = () => ({ decision: 'allow', [source]: 'allow' });
  h.state.answer = 'Allow this session';
  const result = await h.fire('tool.call', { tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' });
  assert.equal(JSON.parse(result.result).state.state, 'work');
  assert.equal(h.state.asks.length, 1);
});

test('real session consent settles ordinary control asks, never ordinary tool permission', async () => {
  const h = await workflowHost();
  h.state.rpcPermission = () => ({ decision: 'ask' });
  h.state.answer = 'Allow this session';
  const started = await h.fire('tool.call', { tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' });
  assert.equal(JSON.parse(started.result).state.state, 'work');
  assert.equal(h.state.asks.length, 1);
  assert.match(h.state.asks[0][0], /sending tool inputs and results/);
  assert.deepEqual(h.state.asks[0][1].options, ['Allow this session', 'Not now']);
  // An ordinary Read still has its own native ask, while Statewright's nested
  // pre/post/stop requests use the independently granted control permission.
  const input = { file_path: '/fixture' };
  await h.fire('tool.call', { tool: 'Read', tool_use_id: 'read-consented', ...input }, async () => {
    const permission = await h.fire('tool.check', { tool: 'Read', tool_use_id: 'read-consented', input }, async () => ({ decision: 'ask' }));
    assert.equal(permission.decision, 'ask');
    await h.fire('classic.PostToolUse', { tool_name: 'Read', tool_use_id: 'read-consented', tool_input: input, tool_response: 'fixture' });
    return { result: 'fixture' };
  });
  assert.ok((await h.fire('classic.Stop', {}, async () => ({}))).block);
  await h.fire('tool.call', { tool: 'mcp__statewright__statewright_transition', event: 'DONE' });
  assert.equal(h.snapshot.state.state, 'complete');
  assert.equal(h.state.asks.length, 1);
  assert.ok(h.state.calls.some(c => c.args.operation === 'pre_tool'));
  assert.ok(h.state.calls.some(c => c.args.operation === 'post_tool'));
  assert.equal([...h.stored.keys()].some(k => /consent|permission/.test(k)), false, 'no persisted grant');
  await h.fire('session.start', {});
  h.state.answer = 'Not now';
  const before = h.state.calls.length;
  await h.fire('tool.call', { tool: 'mcp__statewright__statewright_get_state' });
  assert.equal(h.state.asks.length, 2, 'even same-ID startup revokes the grant');
  assert.equal(h.state.calls.length, before);
});
for (const policy of [{ decision: 'deny' }, { decision: 'ask', rule: 'explicit ask' },
  { decision: 'ask', hook: 'PreToolUse' }, { decision: 'ask', ceiling: 'ask' }])
  test(`saved gateway allow preserves facade policy ${JSON.stringify(policy)}`, async () => {
    const h = await workflowHost(), before = h.state.calls.length;
    h.state.rpcPermission = () => ({ decision: 'allow', rule: 'saved gateway allow' });
    h.state.toolPermission = () => policy; h.state.answer = 'Allow this session';
    await h.fire('tool.call', { tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' });
    assert.equal(h.state.calls.length, before);
    assert.equal(h.state.asks.length, 0, 'explicit native constraints do not become session grants');
  });
test('saved gateway allow does not dispatch after refused facade consent', async () => {
  const h = await workflowHost(), before = h.state.calls.length;
  h.state.rpcPermission = () => ({ decision: 'allow', rule: 'saved gateway allow' });
  h.state.toolPermission = () => ({ decision: 'ask' }); h.state.answer = 'Not now';
  await h.fire('tool.call', { tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' });
  assert.equal(h.state.asks.length, 1); assert.equal(h.state.calls.length, before);
  assert.equal(h.snapshot.state, null);
});
for (const answer of ['Not now', 'allow this session', 'yes', 'dismiss']) test(`control consent ${answer} never dispatches`, async () => {
  const h = await workflowHost(), before = h.state.calls.length;
  h.state.rpcPermission = () => ({ decision: 'ask' });
  h.state.answer = answer;
  if (answer === 'dismiss') h.state.ask = () => { throw new Error('dismissed'); };
  await h.press('start');
  assert.equal(h.state.asks.length, 1);
  assert.equal(h.state.calls.length, before);
  assert.equal(h.snapshot.state, null);
});
for (const policy of [{ decision: 'deny' }, { decision: 'ask', rule: 'explicit ask' },
  { decision: 'ask', hook: 'PreToolUse' }, { decision: 'ask', ceiling: 'ask' }])
  test(`session consent never overrides native ${JSON.stringify(policy)}`, async () => {
    const h = await workflowHost();
    h.state.rpcPermission = () => ({ decision: 'ask' }); h.state.answer = 'Allow this session';
    await h.press('start');
    const before = h.state.calls.length;
    h.state.rpcPermission = () => policy;
    await h.fire('tool.call', { tool: 'mcp__statewright__statewright_get_state' });
    assert.equal(h.state.calls.length, before); assert.equal(h.state.asks.length, 1);
  });
test('late consent cannot authorize a resumed conversation or the old request', async () => {
  const h = await workflowHost(), pending = deferred(), entered = deferred();
  h.state.rpcPermission = () => ({ decision: 'ask' });
  h.state.ask = () => { entered.resolve(); return pending.promise; };
  const before = h.state.calls.length, start = h.press('start'); await entered.promise;
  h.state.session = '22222222-2222-4222-8222-222222222222';
  await h.fire('session.end', {});
  pending.resolve('Allow this session'); await start;
  assert.equal(h.state.calls.length, before); assert.equal(h.snapshot.state, null);
});
test('a forged own-origin check without a live frame cannot acquire consent', async () => {
  const h = await workflowHost(); h.state.answer = 'Allow this session';
  const tool = `mcp__plugin_statewright_${SERVER}__statewright_native_request`;
  const native = { decision: 'ask' };
  const result = await h.fire('tool.check', { tool, tool_use_id: 'forged', input: {
    context: { version: 1, conversation_id: CHAT }, operation: 'get_state', input: {}, expected_revision: null,
  } }, async () => native, { plugin: 'statewright' });
  assert.deepEqual(result, native); assert.equal(h.state.asks.length, 0);
});
test('same-ID session restart discards an outstanding control answer', async () => {
  const h = await workflowHost(), pending = deferred(), entered = deferred();
  h.state.rpcPermission = () => ({ decision: 'ask' });
  h.state.ask = () => { entered.resolve(); return pending.promise; };
  const before = h.state.calls.length, start = h.press('start'); await entered.promise;
  await h.fire('session.start', {});
  pending.resolve('Allow this session'); await start;
  assert.equal(h.state.calls.length, before); assert.equal(h.snapshot.state, null);
});
test('Off revokes control consent for the next workflow', async () => {
  const h = await workflowHost();
  h.state.rpcPermission = () => ({ decision: 'ask' }); h.state.answer = 'Allow this session';
  await h.press('start'); await h.press('off');
  assert.equal(h.state.asks.length, 1);
  await h.press('start'); assert.equal(h.state.asks.length, 2);
});
test('nested control question passes to native permission handling only for its exact owned invocation', async () => {
  const h = await workflowHost(), pending = deferred(), entered = deferred();
  h.state.rpcPermission = () => ({ decision: 'ask' }); h.state.ask = () => { entered.resolve(); return pending.promise; };
  const start = h.press('start'); await entered.promise;
  const input = { questions: [{ question: h.state.asks[0][0], header: 'Statewright',
    options: h.state.asks[0][1].options.map(label => ({ label, description: '' })), multiSelect: false }] };
  const handler = h.hooks.find(h => h.name === 'tool.call').fallback;
  const next = async () => ({ deny: 'Native user refused' });
  next.error = { kind: 're-entry' }; next.origin = { plugin: 'statewright' };
  const e = { tool: 'AskUserQuestion', tool_use_id: 'real-question', ...input };
  assert.deepEqual(await handler(h.$, e, next), { deny: 'Native user refused' }, 'never creates its own answer or native allow');
  for (const changed of [{ ...e, tool_use_id: 'other-question' }, { ...e, answers: { fake: 'yes' } },
    { ...e, agentId: 'subagent' }, { ...e, questions: [] }])
    assert.match((await handler(h.$, changed, next)).deny, /could not handle/);
  next.origin = { plugin: 'foreign' };
  assert.match((await handler(h.$, e, next)).deny, /could not handle/);
  pending.resolve('Not now'); await start;
});
test('a control waiting on connection cannot act in a newly resumed conversation', async () => {
  const h = await host({ startup: false }), pending = deferred();
  h.state.connect = () => pending.promise;
  const result = h.fire('tool.call', { tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' });
  await new Promise(setImmediate);
  h.state.session = 'new-chat'; await h.fire('classic.SessionStart', {});
  pending.resolve(h.state.connection);
  assert.match((await result).deny, /conversation changed/);
  assert.equal(h.state.calls.length, 0);
});
test('Off retires an old native permission check without waiting or dropping its ask', async () => {
  const h = await workflowHost(); await h.press('start');
  const wait = deferred(); let waiting = false;
  h.state.toolPermission = () => ({ decision: 'ask' });
  h.state.rpcPermission = args => {
    if (args.operation === 'get_state' && args.expected_revision === null && !waiting) { waiting = true; return wait.promise; }
    return { decision: 'allow' };
  };
  const reading = h.fire('tool.call', { tool: 'mcp__statewright__statewright_get_state' });
  await new Promise(setImmediate); assert.equal(waiting, true);
  await h.press('off');
  assert.equal(h.snapshot.state, null);
  const before = h.state.calls.length;
  wait.resolve({ decision: 'allow' }); await reading;
  assert.equal(h.state.calls.length, before, 'superseded old ask never reaches gateway');
  assert.equal(h.snapshot.state, null);
});
