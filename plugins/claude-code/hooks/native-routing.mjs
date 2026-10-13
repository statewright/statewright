// Native per-request translation. Never change the session model or credentials.
const nativeFamily = model => /^(?:claude-)?(haiku|sonnet|opus|fable)(?:-[0-9][a-z0-9.-]*)?$/.exec(model)?.[1];
// turn.step bypasses the CLI alias resolver. Verified with Claude 2.1.296's
// native resolver (e2e/native-model-probe), without making provider requests.
const nativeModels = Object.freeze({ haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' });
export function claudeRoute(state) {
  if (!state || state.is_final || state.model == null || state.model === '') return null;
  if (typeof state.model !== 'string') throw new Error('Invalid workflow model');
  const parts = state.model.split('/');
  const name = parts.pop(), provider = parts.pop();
  if (parts.length || (provider && !['openai', 'openai-codex', 'anthropic'].includes(provider)))
    throw new Error('No native Claude equivalent for this workflow provider');
  const family = /^(?:gpt-\d+(?:\.\d+)?-)?(luna|terra|sol|astra)$/.exec(name)?.[1];
  const level = state.thinking_level ?? null;
  if (level !== null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(level))
    throw new Error('No native Claude equivalent for this workflow effort');
  let model;
  if (family && provider !== 'anthropic') model = family === 'luna' || (family === 'terra' && level === 'low')
    ? 'haiku' : family === 'terra' ? 'sonnet' : family === 'sol' ? 'opus' : 'fable';
  else if ((!provider || provider === 'anthropic') && nativeFamily(name)) model = name;
  else throw new Error('No native Claude equivalent for this workflow model');
  // Resolve bare aliases only; an explicit versioned native model stays pinned.
  model = nativeModels[model] ?? nativeModels[model.replace(/^claude-/, '')] ?? model;
  if (!model.startsWith('claude-')) model = `claude-${model}`;
  return { requested_model: state.model, requested_effort: level, model,
    effort: level,
    effort_note: level === null ? 'Native model default' : 'Requested effort; native model support and account policy may constrain it' };
}
export function routeEvent(event, route) {
  if (!route) return event;
  const { effort, ...base } = event;
  return { ...base, model: route.model, ...(route.effort === null ? {} : { effort: route.effort }) };
}
// Claude-only compatibility policy, never a workflow JSON setting. Match only
// a native synthetic gate observed inside the owned Fable request; ordinary
// text, null usage, generic errors and refusals are NOT availability evidence.
export function fableCreditGate(event) {
  if (event.agentId || event.door !== 'response' || event.origin?.kind !== 'model' || event.origin.model !== '<synthetic>') return false;
  const blocks = event.message?.content;
  return blocks?.length === 1 && blocks[0].type === 'text' &&
    /^Fable 5(?:\.1)? requires usage credits\./.test(blocks[0].text);
}
export function fableFallback(route, result, probe) {
  if (!/^claude-fable-5(?:-1)?$/.test(route.model) || !probe?.creditGate || probe.semantic ||
      !result || result.usage !== null || result.stopReason !== null || result.answer !== '' ||
      result.toolUses?.length !== 0 || (result.serverToolUses?.length ?? 0) !== 0) return null;
  return { ...route, model: nativeModels.opus, fallback_from: route.model, fallback_reason: 'fable_usage_credits_required' };
}
export function fallbackPermitted(settings, disabled) {
  if (['1', 'true'].includes(String(disabled).toLowerCase())) return false;
  const allowed = settings?.availableModels;
  return allowed === undefined || (Array.isArray(allowed) && allowed.some(m => m === 'opus' || m === nativeModels.opus));
}
export function routeReceipt(event, route, result) {
  const actual = typeof result?.usage?.model === 'string' ? result.usage.model : null;
  const matches = actual && actual === route.model;
  const tokens = {};
  for (const field of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const value = result?.usage?.[field];
    if (Number.isSafeInteger(value) && value >= 0) tokens[field] = value;
  }
  return { turn_id: event.turnId, step: event.index, requested_model: route.requested_model,
    requested_effort: route.requested_effort, native_model: route.model, native_effort: route.effort,
    effort_note: route.effort_note, observed_model: actual,
    ...(route.fallback_from ? { fallback_from: route.fallback_from, fallback_reason: route.fallback_reason } : {}),
    status: !actual ? 'unavailable' : matches ? 'observed' : 'mismatch', tokens };
}
export function* blockedStep(event, message) {
  yield { kind: 'text', index: 0, text: message };
  yield { kind: 'stop', stopReason: 'end_turn', usage: null };
  return { turnId: event.turnId, index: event.index, answer: message, toolUses: [], stopReason: 'end_turn', usage: null };
}
export function routingView(view) {
  let configured = null, error = null;
  try { configured = claudeRoute(view.native?.state); } catch (e) { error = e.message; }
  return { mode: 'native_request_override', scope: 'main_conversation', configured, error,
    last_request: view.routes?.at(-1) ?? null,
    note: 'The gateway model_routing flag describes the remote connector. This local mod overrides native main-conversation requests; only observed_model is execution evidence.' };
}
