import { expect, mock, test } from 'claude-code/testing';

for (const baseline of [false, true]) for (const surface of ['terminal', 'desktop'] as const)
  test(`${surface}: Powerline baseline ${baseline}, session override and reset`, { options: { powerline: baseline } }, async ($, on) => {
    const { state, clock } = setup(on); state.connected = true;
    await $.session.start({ cwd: '/work' }); await clock.settle();
    const band = await $.ui.mount({ ...pane, component: 'AbovePrompt', surface,
      props: { ...pane.props, bodyColumns: 120 } });
    const ui = await $.ui.mount({ ...pane, surface });
    const glyph = async () => Boolean(await band.find({ type: 'Text', text: '' }));
    expect(await glyph()).toBe(surface === 'terminal' && baseline);
    const calls = state.calls.length;
    await $.command.run({ command: 'statewright', args: 'powerline on' });
    expect(await glyph()).toBe(surface === 'terminal');
    await $.command.run({ command: 'statewright', args: 'powerline off' });
    expect(await glyph()).toBe(false);
    expect(await band.find({ type: 'Text', text: surface === 'desktop' ? /^arbiter$/ : /arbiter > / })).toBeDefined();
    if (surface === 'desktop') expect((await band.find({ type: 'Client', key: 'status-sidebar' }))?.props.props.label).toBe('Connected to Statewright');
    else expect(await band.find({ type: 'Text', text: /statewright.ai ∞ > Connected/ })).toBeDefined();
    await $.command.run({ command: 'statewright', args: 'powerline default' });
    expect(await glyph()).toBe(surface === 'terminal' && baseline);
    if (surface === 'terminal') {
      await ui.select({ key: 'powerline-session', value: baseline ? 'off' : 'on' });
      expect(await glyph()).toBe(!baseline);
      await ui.select({ key: 'powerline-session', value: 'default' });
      expect(await glyph()).toBe(baseline);
    } else expect(await ui.find({ key: 'powerline-session' })).toBeUndefined();
    expect(state.calls.length).toBe(calls); expect(state.commands.length).toBe(0);
    await $.command.run({ command: 'statewright', args: `powerline ${baseline ? 'off' : 'on'}` });
    await $.session.start({ cwd: '/work' });
    expect(await glyph()).toBe(surface === 'terminal' && baseline);
    await band.unmount(); await ui.unmount();
  });

for (const columns of [32, 100]) test(`desktop/${columns}: compact chips retain boxed brand and status`, async ($, on) => {
  const { state, clock } = setup(on); state.connected = true;
  await $.session.start({ cwd: '/work' }); await clock.settle();
  const band = await $.ui.mount({ ...pane, component: 'AbovePrompt', surface: 'desktop', props: { bodyColumns: columns } });
  for (const key of ['arbiter-label', 'arbiter-brand', 'desktop-state', 'desktop-model']) {
    const chip = await band.find({ type: 'Box', key });
    expect(chip?.props.height).toBe(1);
    expect(chip?.props.paddingY).toBe(0);
  }
  const brand = await band.find({ type: 'Box', key: 'arbiter-brand' });
  expect(brand?.props.borderStyle).toBe('single');
  expect(await band.find({ type: 'Text', text: 'statewright.ai ∞' })).toBeDefined();
  expect((await band.find({ type: 'Client', key: 'status-sidebar' }))?.props.props.label).toBe('Connected to Statewright');
  await band.unmount();
});

for (const connected of [false, true]) test(`desktop status opens focused sidebar without consent or retry; connected=${connected}`, async ($, on) => {
  const { state, clock } = setup(on); state.connected = connected;
  await $.session.start({ cwd: '/work' }); await clock.settle();
  const band = await $.ui.mount({ ...pane, component: 'AbovePrompt', surface: 'desktop' });
  const control = await band.find({ type: 'Client', key: 'status-sidebar' });
  expect(control?.props.props.label).toBe(connected ? 'Connected to Statewright' : 'Connection needs attention');
  const opens = state.opens.length, calls = state.calls.length;
  await band.press({ key: 'show-sidebar' });
  expect(state.opens.length).toBe(opens + 1);
  expect(state.opens.at(-1).id).toBe('statewright');
  expect(state.opens.at(-1).focus).toBe(true);
  await clock.settle();
  expect(state.calls.length).toBe(calls); expect(state.commands.length).toBe(0);
  const sidebar = await $.ui.mount({ ...pane, surface: 'desktop' });
  expect(await sidebar.find({ key: connected ? 'action-refresh' : 'action-connect' })).toBeDefined();
  await sidebar.unmount(); await band.unmount();
});

test('configure shortcut opens the exact native plugin configuration', async ($, on) => {
  const { state, clock } = setup(on); state.connected = true;
  const commands: any[] = [];
  on('command.run', { command: 'plugin' }, ($, e) => { commands.push(e); return { text: 'Native preferences' }; });
  await $.session.start({ cwd: '/work' }); await clock.settle();
  const calls = state.calls.length;
  const result = await $.command.run({ command: 'statewright', args: 'configure' });
  expect(result.text).toBe('Opening Statewright preferences…');
  await clock.settle();
  expect(commands.length).toBe(1);
  expect(commands[0].args).toBe('configure statewright@statewright');
  expect(state.calls.length).toBe(calls);
});

for (const powerline of [false, true]) for (const surface of ['terminal', 'desktop'] as const)
  test(`${surface}: event symbols and separators with Powerline ${powerline}`, { options: { powerline } }, async ($, on) => {
    const { state, clock } = setup(on); state.connected = true; state.native = true;
    await $.session.start({ cwd: '/work' }); await clock.settle();
    await $.tool.call({ tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' });
    state.workflow = { ...state.workflow, model: 'luna', thinking_level: 'low',
      transitions: [{ event: 'DONE', target: 'complete' }, { event: 'REWORK_REQUIRED', target: 'intake' }] };
    await $.tool.call({ tool: 'mcp__statewright__statewright_get_state' });
    const band = await $.ui.mount({ ...pane, component: 'AbovePrompt', surface, props: { ...pane.props, bodyColumns: 160 } });
    const separator = surface === 'terminal' && powerline ? '' : '>';
    expect(await band.find({ type: 'Text', text: `${surface === 'desktop' ? '' : ' '}events: :done | :rework_required ${separator}` })).toBeDefined();
    expect(await band.find({ type: 'Text', text: new RegExp(`next Haiku 5.5 / low${surface === 'desktop' ? '' : ` ${separator}`}`) })).toBeDefined();
    expect(await band.find({ type: 'Text', text: /next:|\(:done/ })).toBeUndefined();
    await band.unmount();
  });

for (const surface of ['terminal', 'desktop'] as const) test(`${surface}: idle and complete preserve the host model, not a stale route`, async ($, on) => {
  const { state, clock } = setup(on); state.connected = true; state.native = true;
  on('turn.step', async function* (_, e) {
    yield { kind: 'text', index: 0, text: 'fixture' };
    return { turnId: e.turnId, index: e.index, answer: 'fixture', toolUses: [], stopReason: 'end_turn', usage: null };
  });
  await $.session.start({ cwd: '/work' }); await clock.settle();
  const band = await $.ui.mount({ ...pane, component: 'AbovePrompt', surface, props: { ...pane.props, bodyColumns: 120 } });
  const visible = async (text: RegExp, stage: string) => {
    if (!await band.find({ type: 'Text', text })) throw new Error(`Missing ${text} at ${stage}`);
  };
  await visible(/Opus 5.5/, 'initial idle');
  for await (const chunk of $.turn.step({ turnId: 'idle', index: 0, model: state.model, effort: 'high', messageCount: 2 })) { /* consume */ }
  await visible(/Opus 5.5 \/ high/, 'after baseline request');
  await $.tool.call({ tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' });
  state.workflow = { ...state.workflow, state: 'complete', is_final: true, transitions: [], model: 'luna', thinking_level: 'low' };
  await $.tool.call({ tool: 'mcp__statewright__statewright_get_state' });
  await visible(/Opus 5.5 \/ high/, 'workflow completed');
  state.model = 'claude-sonnet-5-5';
  await $.tool.call({ tool: 'mcp__statewright__statewright_get_state' });
  await visible(/Sonnet 5.5/, 'selection changed');
  expect(await band.find({ type: 'Text', text: /Sonnet 5.5 \/ high|Haiku|next Opus/ })).toBeUndefined();
  state.model = 'claude-opus-5-5';
  await $.session.start({ cwd: '/work' }); await clock.settle();
  await visible(/Opus 5.5/, 'same-ID session restart');
  expect(await band.find({ type: 'Text', text: /Opus 5.5 \/ high/ })).toBeUndefined();
  await band.unmount();
});

for (const surface of ['terminal', 'desktop'] as const) test(`${surface}: tool cards summarize exact JSON, keep full result and do not alter model output`, async ($, on) => {
  const { clock } = setup(on);
  on('ui.render', { component: 'ToolResult' }, ($, e) => $.ui.resolve(e).Text({ children: ['NATIVE FULL RESULT'] }));
  on('ui.render', { component: 'ToolUse' }, ($, e) => $.ui.resolve(e).Text({ children: ['NATIVE CALL AND JSON'] }));
  await $.session.start({ cwd: '/work' }); await clock.settle();
  const first = { status: 'action_needed', message: 'Review the proposed change', customCount: 42, state: { state: 'old-state' },
    outcome: { isError: false, content: [{ type: 'text', text: '{"transitioned":true,"from":"intake","to":"old-state"}' }] } };
  const output = JSON.stringify(first);
  const target = { plugin: 'statewright', component: 'ToolUse', surface,
    props: { tool: 'mcp__statewright__statewright_transition', tool_use_id: 'first', output,
      input: { event: 'NEXT', data: { privateDetail: 123 } }, isErrored: false, isInterrupted: false, isRunning: false } } as const;
  const ui = await $.ui.mount(target);
  expect(await ui.find({ type: 'Text', text: /Review the proposed change/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /customCount|privateDetail|NATIVE CALL/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /old-state/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /intake => old-state/ })).toBeDefined();
  await ui.press({ key: 'result-details' });
  expect(await ui.find({ type: 'Text', text: /"customCount": 42/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /"privateDetail": 123/ })).toBeDefined();
  const duplicate = await $.ui.mount({ ...target, component: 'ToolResult' });
  expect(await duplicate.find({ type: 'Text', text: /NATIVE FULL RESULT|old-state/ })).toBeUndefined();
  await duplicate.unmount();
  const second = await $.ui.mount({ ...target, props: { ...target.props, tool_use_id: 'second', output: '{"message":"Second call"}' } });
  expect(await second.find({ type: 'Text', text: 'Second call' })).toBeDefined();
  expect(await second.find({ type: 'Text', text: /old-state/ })).toBeUndefined();
  await ui.press({ key: 'result-details' });
  expect(await ui.find({ type: 'Text', text: /old-state/ })).toBeDefined();
  expect(JSON.stringify(first)).toBe(output);
  let nativeCall = 0;
  for (const props of [{ ...target.props, isErrored: true }, { ...target.props, isInterrupted: true }, { ...target.props, isRunning: true },
    { ...target.props, tool: 'mcp__other__statewright_transition' }, { ...target.props, output: 'not JSON' }]) {
    const callProps = { ...props, tool_use_id: `native-${nativeCall++}` };
    const native = await $.ui.mount({ ...target, props: callProps });
    expect(await native.find({ type: 'Text', text: 'NATIVE CALL AND JSON' })).toBeDefined();
    const result = await $.ui.mount({ ...target, component: 'ToolResult', props: callProps });
    expect(await result.find({ type: 'Text', text: 'NATIVE FULL RESULT' })).toBeDefined();
    await result.unmount();
    await native.unmount();
  }
  await second.unmount(); await ui.unmount();
});

const nativeServer = 'plugin:statewright:statewright';
const pane = { plugin: 'statewright', component: 'Pane', requestId: 'statewright',
  viewport: { columns: 100, rows: 40 }, props: { title: 'Statewright', isFocused: true,
    bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const;
function setup(on) {
  const state = { session: '11111111-1111-4111-8111-111111111111', connected: false, calls: [] as any[], commands: [] as any[],
    model: 'claude-opus-5-5', opens: [] as any[],
    refusal: 'auth', completeLogin: true, selected: '', names: ['bugfix', 'plan'],
    native: false, revision: 1, workflow: null as any, failRouteStore: false,
    catalogError: false as boolean | string, diagnostic: null as any };
  const clock = mock.clock(on);
  on('session.id', () => ({ value: state.session }));
  on('session.model', () => ({ value: state.model }));
  on('command.register', () => ({ value: undefined }));
  on('tool.register', ($, e) => ({ value: { tool: `mcp__statewright__${e.name}` } }));
  on('tool.check', () => ({ decision: 'allow' }));
  on('store.get', () => ({ value: undefined }));
  on('store.set', (_, e) => {
    if (state.failRouteStore && e.key.startsWith('model-routes:')) throw new Error('fixture store unavailable');
    if (e.key === 'latest-connection-diagnostic') state.diagnostic = e.value;
    return { value: undefined };
  });
  on('session.start', () => ({ cwd: '/work' }));
  on('session.end', () => ({ sessionId: state.session }));
  on('ui.log', () => ({ value: undefined }));
  on('classic.Stop', () => ({}));
  on('classic.SessionStart', () => ({}));
  on('ui.open', (_, e) => { state.opens.push(e); return { value: { isPlaced: true } }; });
  on('ui.close', () => ({ value: undefined }));
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: [] }));
  on('ui.copy', ($, e) => {
    expect(e.text).toBe(`claude mcp login ${nativeServer} --no-browser`);
    return { value: { isCopied: true } };
  });
  on('mcp.connect', () => ({ value: state.connected
    ? { isConnected: true, server: nativeServer }
    : { isConnected: false, reason: state.refusal, message: 'Native refusal' } }));
  on('process.run', ($, e) => {
    expect(e.argv[0]).toBe('/usr/bin/expect');
    expect(e.argv[1]).toMatch(/scripts\/native-login\.exp$/);
    state.commands.push(e); state.connected = state.completeLogin;
    return { value: { exitCode: state.completeLogin ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
  });
  on('command.run', { command: 'mcp' }, ($, e) => {
    expect(e.args).toBe(`reconnect ${nativeServer}`); return {};
  });
  on('mcp.call', ($, e) => {
    if (state.catalogError && ['statewright_list_workflows', 'statewright_native_connect'].includes(e.tool))
      return { deny: typeof state.catalogError === 'string' ? state.catalogError : 'Native permission denied PRIVATE_TOKEN https://private.example' };
    state.calls.push(e);
    expect(e.server).toBe(nativeServer);
    if (e.tool === 'statewright_native_connect') {
      expect(e.args).toEqual({ context: { version: 1, conversation_id: state.session } });
      return { value: { content: [{ type: 'text', text: JSON.stringify({
        protocol_version: 1, conversation_id: state.session, workflows: state.names,
        snapshot: { protocol_version: 1, conversation_id: state.session,
          revision: `22222222-2222-4222-8222-${String(state.revision).padStart(12, '0')}`,
          capabilities: { workflow_control: state.native, native_tool_enforcement: state.native, human_approval: state.native, model_routing: false },
          state: state.workflow, outcome: null },
      }) }] } };
    }
    if (state.native && e.tool === 'statewright_native_request') {
      const action = e.args as any;
      expect(action.context.conversation_id).toBe(state.session);
      if (action.operation !== 'get_state') {
        expect(action.expected_revision).toBe(`22222222-2222-4222-8222-${String(state.revision).padStart(12, '0')}`);
        state.revision++;
      }
      if (action.operation === 'load_workflow') state.workflow = {
        workflow: action.input.name, run_id: '33333333-3333-4333-8333-333333333333', state: 'intake', is_final: false, transition_count: 0,
        allowed_tools: ['Read'], transitions: [{ event: 'DONE', target: 'complete' }],
        model_routing: { enforced: false },
      };
      if (action.operation === 'transition') {
        expect(action.input.event).toBe('DONE');
        state.workflow = { ...state.workflow, state: 'complete', is_final: true, transitions: [], transition_count: 1 };
      }
      if (action.operation === 'deactivate') state.workflow = null;
      return { value: { content: [{ type: 'text', text: JSON.stringify({
        protocol_version: 1, conversation_id: state.session,
        revision: `22222222-2222-4222-8222-${String(state.revision).padStart(12, '0')}`,
        capabilities: { workflow_control: true, native_tool_enforcement: true, human_approval: true, model_routing: false },
        state: state.workflow, outcome: action.operation === 'get_state' ? null : { content: [{ type: 'text', text: '{}' }], isError: false },
      }) }] } };
    }
    if (e.tool === 'statewright_native_request') throw new Error('Native control not available in this fixture');
    expect(e.tool).toBe('statewright_list_workflows');
    return { value: { content: [{ type: 'text', text: JSON.stringify({ workflows: state.names, active: 'foreign',
      ...(state.native ? { native_control: { version: 1 } } : {}) }) }] } };
  });
  return { state, clock };
}
test('native request hook applies all equivalents, follows state changes, records evidence and restores baseline', async ($, on) => {
  const { state, clock } = setup(on); state.connected = true; state.native = true;
  const dispatched: any[] = [];
  on('turn.step', async function* (_, e) {
    dispatched.push(e);
    // Native turn.step does NOT resolve CLI aliases before sending the request.
    expect(e.model).toMatch(/^claude-(haiku|sonnet|opus|fable)-\d/);
    const model = e.model;
    const usage = { model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    yield { kind: 'text', index: 0, text: 'fixture reply' };
    yield { kind: 'stop', stopReason: 'end_turn', usage };
    return { turnId: e.turnId, index: e.index, answer: 'fixture reply', toolUses: [], stopReason: 'end_turn', usage };
  });
  await $.session.start({ cwd: '/work' }); await clock.settle();
  await $.tool.call({ tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' });
  const baseline = { turnId: 'route-test', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 2 } as const;
  const step = async (event: any) => {
    const stream = $.turn.step(event); const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.some(c => c.kind === 'text')).toBe(true);
    return stream.result;
  };
  for (const [model, thinking_level, target] of [
    ['luna', 'low', 'claude-haiku-5-5'], ['openai-codex/gpt-5.6-terra', 'low', 'claude-haiku-5-5'],
    ['gpt-5.6-terra', 'medium', 'claude-sonnet-5-5'], ['gpt-6-sol', 'high', 'claude-opus-5-5'], ['gpt-6-astra', 'high', 'claude-fable-5-1'],
  ]) {
    state.workflow = { ...state.workflow, model, thinking_level };
    await $.tool.call({ tool: 'mcp__statewright__statewright_get_state' });
    await step(baseline);
    expect(dispatched.at(-1).model).toBe(target);
    expect(dispatched.at(-1).effort).toBe(thinking_level);
    const response = JSON.parse((await $.tool.call({ tool: 'mcp__statewright__statewright_get_state' })).result as string);
    expect(response.client_model_routing.last_request.status).toBe('observed');
    expect(response.client_model_routing.last_request.native_model).toBe(target);
    expect(response.capabilities.model_routing).toBe(false);
  }
  await step({ ...baseline, agentId: 'unrelated-child' });
  expect(dispatched.at(-1).model).toBe(baseline.model);
  state.workflow = { ...state.workflow, is_final: true };
  await $.tool.call({ tool: 'mcp__statewright__statewright_get_state' });
  await step(baseline); expect(dispatched.at(-1).model).toBe(baseline.model);
  await $.tool.call({ tool: 'mcp__statewright__statewright_deactivate' });
  await step(baseline); expect(dispatched.at(-1).effort).toBe('high');
  expect(dispatched.length).toBe(8);
});
for (const surface of ['terminal', 'desktop'] as const) test(`${surface}: idle Sonnet effort survives the narrow infinity brand`, async ($, on) => {
  const { state, clock } = setup(on); state.connected = true; state.native = true;
  await $.session.start({ cwd: '/work' }); await clock.settle();
  await $.tool.call({ tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' });
  state.workflow = { ...state.workflow, state: 'implementation-long', model: 'terra', thinking_level: 'medium' };
  await $.tool.call({ tool: 'mcp__statewright__statewright_get_state' });
  const ui = await $.ui.mount({ ...pane, surface, component: 'AbovePrompt', props: { ...pane.props, bodyColumns: 32 } });
  expect(await ui.find({ type: 'Text', text: surface === 'desktop' ? 'statewright.ai ∞' : 'sw∞' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: surface === 'desktop' ? 'next Sonnet 5.5 / medium' : '→Sonnet/medium' })).toBeDefined();
  if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: /events:/ })).toBeUndefined();
  else expect(await ui.find({ type: 'Text', text: /events: :done/ })).toBeDefined();
  await ui.unmount();
});
test('native credit gate takes one Opus fallback, displays it and preserves both attempts', async ($, on) => {
  const { state, clock } = setup(on); state.connected = true; state.native = true;
  mock.session(on); mock.env(on, {}); on('settings.read', () => ({ value: {} }));
  const calls: string[] = [];
  on('turn.step', async function* (_, e) {
    calls.push(e.model);
    if (e.model === 'claude-fable-5-1') {
      await $.session.append({ door: 'response', origin: { kind: 'model', model: '<synthetic>' }, uuid: 'native-credit-gate',
        message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'Fable 5.1 requires usage credits. Run /usage-credits to continue or switch models with /model.' }] } });
      return { turnId: e.turnId, index: e.index, answer: '', usage: null, stopReason: null, toolUses: [] };
    }
    const usage = { model: e.model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    yield { kind: 'text', index: 0, text: 'done' };
    yield { kind: 'stop', stopReason: 'end_turn', usage };
    return { turnId: e.turnId, index: e.index, answer: 'done', toolUses: [], stopReason: 'end_turn', usage };
  });
  await $.session.start({ cwd: '/work' }); await clock.settle();
  await $.tool.call({ tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' });
  state.workflow = { ...state.workflow, model: 'astra', thinking_level: 'high' };
  await $.tool.call({ tool: 'mcp__statewright__statewright_get_state' });
  const band = await $.ui.mount({ ...pane, component: 'AbovePrompt', surface: 'terminal', props: { ...pane.props, bodyColumns: 160 } });
  const stream = $.turn.step({ turnId: 'fallback', index: 0, model: 'claude-opus-5-5', effort: 'low', messageCount: 1 });
  await stream.next();
  expect(await band.find({ type: 'Text', text: /Opus 5.5 \/ high · fallback · running/ })).toBeDefined();
  for await (const c of stream) {}
  expect(calls).toEqual(['claude-fable-5-1', 'claude-opus-5-5']);
  const receipt = JSON.parse((await $.tool.call({ tool: 'mcp__statewright__statewright_get_state' })).result as string).client_model_routing.last_request;
  expect(receipt.fallback_from).toBe('claude-fable-5-1'); expect(receipt.observed_model).toBe('claude-opus-5-5');
  expect(receipt.attempts.length).toBe(2);
  await band.unmount();
});
test('unmapped native route makes no model request, and resume does not inherit it', async ($, on) => {
  const { state, clock } = setup(on); state.connected = true; state.native = true;
  let calls = 0;
  on('turn.step', async function* (_, e) {
    calls++;
    yield { kind: 'text', index: 0, text: 'baseline' };
    return { turnId: e.turnId, index: e.index, answer: 'baseline', toolUses: [], stopReason: 'end_turn', usage: null };
  });
  await $.session.start({ cwd: '/work' }); await clock.settle();
  await $.tool.call({ tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' });
  state.workflow = { ...state.workflow, model: 'unknown/model' };
  await $.tool.call({ tool: 'mcp__statewright__statewright_get_state' });
  const event = { turnId: 'blocked-route', index: 0, model: 'opus', messageCount: 2 };
  const stream = $.turn.step(event); const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(calls).toBe(0);
  expect(chunks.some(c => c.kind === 'text' && c.text.includes('No native Claude equivalent'))).toBe(true);
  const beforeStop = state.calls.length;
  await $.classic.Stop({ session_id: state.session, transcript_path: '/fixture', cwd: '/work', hook_event_name: 'Stop', stop_hook_active: false } as any);
  expect(state.calls.length).toBe(beforeStop); // No synthetic failure/Stop loop.
  await $.session.end({ reason: 'resume' });
  state.session = '44444444-4444-4444-8444-444444444444'; state.workflow = null;
  await $.session.start({ cwd: '/work' }); await clock.settle();
  for await (const chunk of $.turn.step(event)) { /* consume native stream */ }
  expect(calls).toBe(1);
});
for (const mode of ['unavailable', 'mismatch', 'store-failure', 'provider-error']) test(`native routing ${mode}: never replay a request or invent observation`, async ($, on) => {
  const { state, clock } = setup(on); state.connected = true; state.native = true;
  state.failRouteStore = mode === 'store-failure';
  let calls = 0;
  on('turn.step', async function* (_, e) {
    calls++;
    if (mode === 'provider-error') throw new Error('fixture provider unavailable');
    const usage = mode === 'unavailable' ? null : { model: mode === 'mismatch' ? 'claude-opus-5-5' : 'claude-haiku-5-5',
      input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    yield { kind: 'text', index: 0, text: 'fixture' };
    yield { kind: 'stop', stopReason: 'end_turn', usage };
    return { turnId: e.turnId, index: e.index, answer: 'fixture', toolUses: [], stopReason: 'end_turn', usage };
  });
  await $.session.start({ cwd: '/work' }); await clock.settle();
  await $.tool.call({ tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' });
  state.workflow = { ...state.workflow, model: 'luna', thinking_level: 'low' };
  await $.tool.call({ tool: 'mcp__statewright__statewright_get_state' });
  const event = { turnId: 'failure', index: 0, model: 'opus', messageCount: 2 };
  let failed = false;
  try { for await (const chunk of $.turn.step(event)) { /* consume */ } } catch { failed = true; }
  expect(calls).toBe(1);
  if (mode === 'provider-error') { expect(failed).toBe(true); return; }
  expect(failed).toBe(false);
  const receipt = JSON.parse((await $.tool.call({ tool: 'mcp__statewright__statewright_get_state' })).result as string).client_model_routing.last_request;
  expect(receipt.status).toBe(mode === 'store-failure' ? 'observed' : mode);
  if (mode === 'mismatch') {
    for await (const chunk of $.turn.step({ ...event, index: 1 })) { /* consume */ }
    expect(calls).toBe(1);
  }
});
for (const surface of ['terminal', 'desktop'] as const) test(`${surface}: live model row follows requests, transitions, Off, failures and resume`, async ($, on) => {
  const { state, clock } = setup(on); state.connected = true; state.native = true;
  let fail = false;
  on('turn.step', async function* (_, e) {
    yield { kind: 'text', index: 0, text: 'fixture' };
    if (fail) throw new Error('fixture interrupted');
    const usage = { model: e.model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    yield { kind: 'stop', stopReason: 'end_turn', usage };
    return { turnId: e.turnId, index: e.index, answer: 'fixture', toolUses: [], stopReason: 'end_turn', usage };
  });
  await $.session.start({ cwd: '/work' }); await clock.settle();
  await $.tool.call({ tool: 'mcp__statewright__statewright_load_workflow', name: 'bugfix' });
  state.workflow = { ...state.workflow, model: 'luna', thinking_level: 'low' };
  await $.tool.call({ tool: 'mcp__statewright__statewright_get_state' });
  const band = await $.ui.mount({ ...pane, component: 'AbovePrompt', surface, props: { ...pane.props, bodyColumns: 120 } });
  expect(await band.find({ type: 'Text', text: /next Haiku 5.5 \/ low/ })).toBeDefined();
  const event = { turnId: 'display', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as const;
  const stream = $.turn.step(event); await stream.next();
  expect(await band.find({ type: 'Text', text: /Haiku 5.5 \/ low · running/ })).toBeDefined();
  state.workflow = { ...state.workflow, state: 'review', model: 'astra', thinking_level: 'high' };
  await $.tool.call({ tool: 'mcp__statewright__statewright_get_state' });
  expect(await band.find({ type: 'Text', text: /Haiku 5.5 \/ low · running/ })).toBeDefined();
  for await (const chunk of stream) { /* Finish owned request. */ }
  expect(await band.find({ type: 'Text', text: /next Fable 5.1 \/ high/ })).toBeDefined();
  await $.tool.call({ tool: 'mcp__statewright__statewright_deactivate' });
  expect(await band.find({ type: 'Text', text: /Fable|Haiku/ })).toBeUndefined();
  const baseline = $.turn.step({ ...event, index: 1 }); await baseline.next();
  expect(await band.find({ type: 'Text', text: /Opus 5.5 \/ high · running/ })).toBeDefined();
  for await (const chunk of baseline) { /* Off restores native selection. */ }
  expect(await band.find({ type: 'Text', text: /running/ })).toBeUndefined();
  fail = true;
  const failed = $.turn.step({ ...event, index: 2 }); await failed.next();
  try { for await (const chunk of failed) { /* Native failure. */ } } catch { /* Expected. */ }
  expect(await band.find({ type: 'Text', text: /running/ })).toBeUndefined();
  fail = false;
  const retired = $.turn.step({ ...event, index: 3 }); await retired.next();
  await $.session.end({ reason: 'resume' }); state.session = '44444444-4444-4444-8444-444444444444';
  await $.session.start({ cwd: '/work' }); await clock.settle();
  const current = $.turn.step({ ...event, turnId: 'new-chat', model: 'claude-sonnet-5-5', effort: 'medium' }); await current.next();
  for await (const chunk of retired) { /* A late old-chat completion cannot clear current display. */ }
  expect(await band.find({ type: 'Text', text: /Sonnet 5.5 \/ medium · running/ })).toBeDefined();
  for await (const chunk of current) { /* Cleanup current request. */ }
  await band.unmount();
});
test('registered local tool returns native text, before and after catalog connection', async ($, on) => {
  const { state, clock } = setup(on);
  await $.session.start({ cwd: '/work' });
  const before = await $.tool.call({ tool: 'mcp__statewright__statewright_connect', workflow: 'bugfix' });
  expect(typeof before.result).toBe('string');
  expect(JSON.parse(before.result as string).status).toBe('connection_required');
  expect(state.commands.length).toBe(0);
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' });
  state.connected = true;
  await ui.press({ key: 'connect' }); await clock.settle();
  const after = await $.tool.call({ tool: 'mcp__statewright__statewright_connect' });
  const payload = JSON.parse(after.result as string);
  expect(payload.status).toBe('connected');
  expect(payload.workflows).toEqual(['bugfix', 'plan']);
  expect(payload.executionAvailable).toBe(false);
  await ui.unmount();
});
for (const surface of ['terminal', 'desktop'] as const) test(`${surface}: Start, next state, complete and Off use the native workspace`, async ($, on) => {
  const { state, clock } = setup(on); state.connected = true; state.native = true;
  await $.session.start({ cwd: '/work' }); await clock.settle();
  const ui = await $.ui.mount({ ...pane, surface });
  await ui.select({ key: 'workflow', value: 'plan' });
  expect(state.workflow).toBe(null);
  expect(await ui.find({ key: surface === 'desktop' ? 'action-start' : 'start' })).toBeDefined();
  await ui.press({ key: 'start' });
  expect(await ui.find({ type: 'Text', text: 'Current: intake' })).toBeDefined();
  expect(await ui.find({ key: surface === 'desktop' ? 'action-off' : 'off' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /Claude keeps its selected model/ })).toBeDefined();
  await ui.select({ key: 'next-state', value: 'DONE' });
  expect(await ui.find({ type: 'Text', text: 'Current: complete' })).toBeDefined();
  await ui.press({ key: 'off' });
  expect(state.workflow).toBe(null);
  expect(await ui.find({ key: surface === 'desktop' ? 'action-start' : 'start' })).toBeDefined();
  expect(state.commands.length).toBe(0);
  await ui.unmount();
});
for (const surface of ['terminal', 'desktop'] as const) test(`${surface}: saved login restores without Connect, and no generic Open remains`, async ($, on) => {
  const { state, clock } = setup(on); state.connected = true;
  await $.session.start({ cwd: '/work' }); await clock.settle();
  const ui = await $.ui.mount({ ...pane, surface });
  expect(await ui.find({ type: 'Text', text: 'Connected to Statewright' })).toBeDefined();
  expect(state.calls.filter(call => call.tool === 'statewright_list_workflows').length).toBe(1); expect(state.commands.length).toBe(0);
  const result = JSON.parse((await $.tool.call({ tool: 'mcp__statewright__statewright_connect', workflow: 'plan' })).result as string);
  expect(result.status).toBe('connected'); expect(result.selected).toBe('plan');
  expect(state.calls.filter(call => call.tool === 'statewright_list_workflows').length).toBe(1);
  const band = await $.ui.mount({ ...pane, component: 'AbovePrompt', surface, props: { ...pane.props, bodyColumns: 120 } });
  expect(await band.find({ key: 'open-workspace' })).toBeUndefined();
  expect(await band.find({ type: 'Text', text: surface === 'desktop' ? /^arbiter$/ : /arbiter > / })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /statewright.ai ∞/ })).toBeDefined();
  await band.unmount(); await ui.unmount();
});
for (const surface of ['terminal', 'desktop'] as const) for (const width of [32, 55, 60, 100]) test(`${surface}/${width}: compact status and connected map expose events and preserve Off`, async ($, on) => {
  const { state, clock } = setup(on); state.connected = true; state.native = true;
  await $.session.start({ cwd: '/work' }); await clock.settle();
  const ui = await $.ui.mount({ ...pane, surface, props: { ...pane.props, bodyColumns: width } });
  await ui.press({ key: 'start' });
  const middleWidth = width === 55 || width === 60;
  state.workflow = { ...state.workflow, ...(middleWidth ? { state: 'implementation-long' } : {}),
    model: middleWidth ? 'terra' : 'luna', thinking_level: middleWidth ? 'medium' : 'low' };
  await $.tool.call({ tool: 'mcp__statewright__statewright_get_state' });
  const band = await $.ui.mount({ ...pane, component: 'AbovePrompt', surface, props: { ...pane.props, bodyColumns: width } });
  if (!await band.find({ key: 'arbiter-status' })) throw new Error('Status row missing');
  if (!await band.find({ type: 'Text', text: /events: :done >/ })) throw new Error('Event summary missing');
  expect(await band.find({ type: 'Text', text: surface === 'desktop'
    ? middleWidth ? /next Sonnet 5.5 \/ medium/ : /next Haiku 5.5 \/ low/
    : middleWidth ? /→Sonnet\/medium/ : width < 55 ? /→Haiku\/low/ : /next Haiku 5.5 \/ low/ })).toBeDefined();
  expect(await band.find({ type: 'Text', text: /^Next:/ })).toBeUndefined();
  if (surface === 'desktop') {
    const svg = await ui.find({ type: 'Svg' });
    expect(svg?.props.alt).toMatch(middleWidth ? /Current: implementation-long/ : /Current: intake/);
    expect(svg?.props.alt).toMatch(/Possible :done to complete/);
  } else {
    if (!await ui.find({ type: 'Text', text: middleWidth ? '● implementation-long' : '● intake' })) throw new Error('Current graph node missing');
    if (!await ui.find({ type: 'Text', text: '└─ :done → ○ complete' })) throw new Error('Next graph branch missing');
  }
  await ui.press({ key: 'toggle-map' });
  expect(await ui.find({ type: 'Text', text: '● intake' })).toBeUndefined();
  expect(await ui.find({ key: 'workflow-map' })).toBeUndefined();
  expect(await ui.find({ key: surface === 'desktop' ? 'action-off' : 'off' })).toBeDefined();
  await ui.press({ key: 'toggle-map' });
  await ui.select({ key: 'next-state', value: 'DONE' });
  if (surface === 'desktop') {
    const svg = await ui.find({ type: 'Svg' });
    expect(svg?.props.alt).toMatch(/Visited: intake/); expect(svg?.props.alt).toMatch(/Current: complete/);
  } else {
    expect(await ui.find({ type: 'Text', text: '○ intake' })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: '● complete' })).toBeDefined();
  }
  await ui.press({ key: 'off' });
  expect(await ui.find({ key: 'workflow-map' })).toBeUndefined();
  await band.unmount(); await ui.unmount();
});
test('first native tool joins startup without waiting for the deferred clock', async ($, on) => {
  const { state, clock } = setup(on); state.connected = true;
  await $.session.start({ cwd: '/work' });
  const result = JSON.parse((await $.tool.call({ tool: 'mcp__statewright__statewright_connect', workflow: 'plan' })).result as string);
  await clock.settle();
  expect(result.status).toBe('connected'); expect(result.selected).toBe('plan');
  expect(state.calls.filter(call => call.tool === 'statewright_list_workflows').length).toBe(1); expect(state.commands.length).toBe(0);
});
for (const surface of ['terminal', 'desktop'] as const) test(`${surface}: all 67 catalog entries remain selectable within native bounds`, async ($, on) => {
  const { state, clock } = setup(on); state.connected = true;
  state.names = Array.from({ length: 67 }, (_, i) => `workflow-${i}`);
  const ui = await $.ui.mount({ ...pane, surface });
  await ui.press({ key: 'connect' }); await clock.settle();
  expect(await ui.find({ type: 'Text', text: 'Page 1 of 3' })).toBeDefined();
  await ui.press({ key: 'next-page' });
  expect(await ui.find({ type: 'Text', text: 'Page 2 of 3' })).toBeDefined();
  await ui.press({ key: 'next-page' });
  await ui.select({ key: 'workflow', value: 'workflow-66' });
  expect(await ui.find({ type: 'Text', text: 'Selected: workflow-66' })).toBeDefined();
  expect(await ui.find({ key: 'next-page' })).toBeUndefined();
  await ui.press({ key: 'previous-page' });
  expect(await ui.find({ type: 'Text', text: 'Selected: workflow-66' })).toBeDefined();
  await ui.press({ key: 'refresh' }); await clock.settle();
  expect(await ui.find({ type: 'Text', text: 'Page 3 of 3' })).toBeDefined();
  expect(state.commands.length).toBe(0);
  await ui.unmount();
});
for (const surface of ['terminal', 'desktop'] as const) for (const width of [32, 100]) {
  test(`${surface}/${width}: connect → native sign-in → real-shaped workflow selection`, async ($, on) => {
    const { state, clock } = setup(on);
    await $.command.run({ command: 'statewright' });
    await clock.settle();
    const ui = await $.ui.mount({ ...pane, surface, props: { ...pane.props, bodyColumns: width } });
    expect(await ui.find({ type: 'Text', text: surface === 'desktop' ? 'Connection needs attention' : 'Statewright would like to connect' })).toBeDefined();
    await ui.press({ key: 'connect' }); await clock.settle();
    expect(state.commands.length).toBe(1);
    expect(await ui.find({ type: 'Text', text: 'Connected to Statewright' })).toBeDefined();
    await ui.select({ key: 'workflow', value: 'plan' });
    expect(await ui.find({ type: 'Text', text: 'Selected: plan' })).toBeDefined();
    expect(await ui.find({ key: 'start' })).toBeUndefined();
    expect(state.calls.filter(call => call.tool === 'statewright_native_connect').length).toBe(1);
    expect(state.calls.filter(call => call.tool === 'statewright_native_request').length).toBe(0);
    await ui.unmount();
  });
}
test('unfinished authentication returns an explicit retry without a second login', async ($, on) => {
  const { state, clock } = setup(on); state.completeLogin = false;
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' });
  await ui.press({ key: 'connect' }); await clock.settle();
  expect(state.commands.length).toBe(1); expect(state.calls.length).toBe(0);
  expect(await ui.find({ key: 'connect' })).toBeDefined();
  await ui.press({ key: 'copy-login' });
  expect(await ui.find({ type: 'Text', text: /Copied\. Run/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /--no-browser/ })).toBeDefined();
  await ui.unmount();
});
test('native policy denial is not an OAuth failure or a sign-in prompt', async ($, on) => {
  const { state, clock } = setup(on); state.refusal = 'policy';
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' });
  await ui.press({ key: 'connect' }); await clock.settle();
  expect(state.commands.length).toBe(0); expect(state.calls.length).toBe(0);
  expect(await ui.find({ type: 'Text', text: /policy does not allow/ })).toBeDefined();
  await ui.unmount();
});

test('native permission refusal retains its finite cause, not its private message', async ($, on) => {
  const { state, clock } = setup(on); state.connected = true; state.catalogError = true;
  await $.session.start({ cwd: '/work' }); await clock.settle();
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' });
  expect(state.diagnostic.code).toBe('permission_refused');
  expect(await ui.find({ type: 'Text', text: /catalog\/permission_refused/ })).toBeDefined();
  expect(state.diagnostic.stage).toBe('catalog');
  expect(state.diagnostic.conversation).toBe(state.session);
  expect(JSON.stringify(state.diagnostic).includes('PRIVATE_TOKEN')).toBe(false);
  expect(JSON.stringify(state.diagnostic).includes('private.example')).toBe(false);
  expect(state.commands.length).toBe(0);
  await ui.unmount();
});

test('unavailable native Auto review gives Desktop recovery without a login or mode change', async ($, on) => {
  const { state, clock } = setup(on); state.connected = true;
  state.catalogError = 'Safety classifier gave no verdict for tool: the request that produced this action did not ask for one. Tell the user that auto mode could not evaluate it. PRIVATE_TOKEN';
  await $.session.start({ cwd: '/work' }); await clock.settle();
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' });
  expect(state.diagnostic.code).toBe('auto_review_unavailable');
  expect(await ui.find({ type: 'Text', text: 'Check Claude permissions' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /permission mode stays unchanged/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /Ask permissions|Manual|changing mode/ })).toBeUndefined();
  expect(state.commands.length).toBe(0); expect(state.calls.length).toBe(0);
  expect(JSON.stringify(state.diagnostic).includes('PRIVATE_TOKEN')).toBe(false);
  await ui.unmount();
});
