// Native workflow-control transport. This does NOT enforce ordinary Claude
// tools or authorize a human decision. The workspace must use executionReadiness
// before enabling Start; a connected gateway alone is insufficient.
import { validName, validWorkflowAliases, decodeCatalogConnection } from './catalog.mjs';

export const NATIVE_CONTROL_TOOL = 'statewright_native_request';
export const NATIVE_CONNECT_TOOL = 'statewright_native_connect';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) &&
  value !== '00000000-0000-0000-0000-000000000000';
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const count = value => Number.isSafeInteger(value) && value >= 0;
export function nativeReadArgs(args, conversation) {
  return uuid(conversation) && only(args, ['context', 'operation', 'input', 'expected_revision']) &&
    args.operation === 'get_state' && only(args.context, ['version', 'conversation_id']) &&
    args.context.version === 1 && args.context.conversation_id === conversation && only(args.input, []) &&
    (args.expected_revision === undefined || args.expected_revision === null);
}
export function nativeReadTool(name, args, conversation) {
  return typeof name === 'string' &&
    /^mcp__plugin[:_]statewright[:_]statewright__statewright_native_request$/.test(name) &&
    nativeReadArgs(args, conversation);
}
export function nativeReadCall({ tool, tool_use_id, agentId, requestMeta, consent, ...args }, conversation) {
  return nativeReadTool(tool, args, conversation);
}
function frozen(value) {
  if (object(value) || Array.isArray(value)) {
    for (const entry of Object.values(value)) frozen(entry);
    Object.freeze(value);
  }
  return value;
}
function toolResult(value) {
  return object(value) && (value.isError === undefined || typeof value.isError === 'boolean') &&
    Array.isArray(value.content) && value.content.length <= 100 && value.content.every(block =>
      object(block) && block.type === 'text' && typeof block.text === 'string');
}
export function decodeNativeControl(result, conversation) {
  if (!uuid(conversation) || !toolResult(result) || result.isError || result.content.length !== 1 ||
      result.content[0].text.length > 262144) throw new Error('Statewright response unavailable');
  const value = JSON.parse(result.content[0].text);
  if (value?.workflow_aliases !== undefined && !validWorkflowAliases(value.workflow_aliases))
    throw new Error('Invalid workflow aliases');
  if (!object(value) || value.protocol_version !== 1 || value.conversation_id !== conversation ||
      !uuid(value.revision) || !object(value.capabilities) ||
      !['workflow_control', 'native_tool_enforcement', 'human_approval', 'model_routing']
        .every(key => typeof value.capabilities[key] === 'boolean') ||
      (value.outcome !== null && !toolResult(value.outcome))) throw new Error('Invalid native control receipt');
  const s = value.state;
  if (s !== null && (!object(s) || !validName(s.workflow) || !validName(s.state) || typeof s.is_final !== 'boolean' ||
      !count(s.transition_count) || !Array.isArray(s.transitions) || s.transitions.length > 256 ||
      !s.transitions.every(t => object(t) && validName(t.event) && validName(t.target)) ||
      new Set(s.transitions.map(t => t.event)).size !== s.transitions.length ||
      !Array.isArray(s.allowed_tools) || s.allowed_tools.length > 1000 || !s.allowed_tools.every(validName) ||
      (s.run_id !== undefined && !validName(s.run_id)))) throw new Error('Invalid native workflow state');
  if (s?.pending_approval !== undefined && s.pending_approval !== null) {
    const p = s.pending_approval;
    if (!object(p) || ![p.approval_id, p.event, p.from_state, p.to_state].every(validName) ||
        p.from_state !== s.state || s.is_final ||
        (p.message !== null && (typeof p.message !== 'string' || p.message.length > 10000)))
      throw new Error('Invalid native pending approval');
  }
  return frozen(value);
}

// One explicitly approved connection read returns both catalog and same-chat
// status. It carries no authorization for any subsequent workflow operation.
export function decodeNativeConnection(result, conversation) {
  if (!toolResult(result) || result.isError || result.content.length !== 1 ||
      result.content[0].text.length > 393216) throw new Error('Invalid native connection receipt');
  const value = JSON.parse(result.content[0].text);
  if (!only(value, ['protocol_version', 'conversation_id', 'workflows', 'snapshot']) ||
      value.protocol_version !== 1 || value.conversation_id !== conversation)
    throw new Error('Invalid native connection identity');
  const wrap = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const snapshot = decodeNativeControl(wrap(value.snapshot), conversation);
  const { workflows, workflowAliases } = decodeCatalogConnection(wrap({ workflows: value.workflows,
    workflow_aliases: snapshot.workflow_aliases }));
  if (snapshot.outcome !== null) throw new Error('Connection must be read-only');
  return { workflows, workflowAliases, nativeControl: true, snapshot };
}

// Local enforcement is an integration prerequisite, not a server claim or a
// model-supplied argument. The shipping workspace supplies its native adapter.
export function executionReadiness(snapshot, localEnforcementReady = false) {
  if (!snapshot?.capabilities?.workflow_control) return { available: false, reason: 'Workflow controls are not available on this connection yet.' };
  if (localEnforcementReady !== true || snapshot.capabilities.native_tool_enforcement !== true)
    return { available: false, reason: 'Workflow tool restrictions are not connected yet.' };
  if (snapshot.capabilities.human_approval !== true)
    return { available: false, reason: 'Human approval is not connected yet.' };
  return { available: true, reason: '' };
}

export function progressNodes(snapshot) {
  const s = snapshot?.state;
  if (!s) return null;
  const next = [...new Set(s.transitions.map(t => t.target))];
  // Possible destinations are not proof that their guards currently pass.
  // No synthetic history: the wire contract does not yet provide visit history.
  return { current: s.state, next: next.slice(0, 4), more: Math.max(0, next.length - 4),
    final: s.is_final, pending: Boolean(s.pending_approval) };
}

function actionValid(action) {
  if (!only(action, ['operation', 'input', 'expectedRevision'])) return false;
  const i = action.input;
  switch (action.operation) {
    case 'get_state': case 'deactivate': case 'stop': return only(i, []) && Object.keys(i).length === 0;
    case 'load_workflow': return only(i, ['name']) && validName(i.name);
    case 'transition': return only(i, ['event', 'data']) && validName(i.event) &&
      (i.data === undefined || object(i.data));
    case 'request_approval': return only(i, ['run_id', 'approval_id']) && validName(i.run_id) && validName(i.approval_id);
    case 'pre_tool': return only(i, ['tool_name', 'tool_input']) && validName(i.tool_name) && object(i.tool_input);
    case 'post_tool': return only(i, ['tool_name', 'tool_input', 'tool_response', 'is_error']) &&
      validName(i.tool_name) && object(i.tool_input) && typeof i.tool_response === 'string' && typeof i.is_error === 'boolean';
    default: return false;
  }
}

export function createNativeControl({ conversation, call }) {
  let owner = '', snapshot = null, busy = false;
  async function current() {
    const id = await conversation();
    if (!uuid(id)) { owner = ''; snapshot = null; throw new Error('Native conversation unavailable'); }
    if (owner !== id) { owner = id; snapshot = null; }
    return id;
  }
  return {
    async snapshot() { await current(); return snapshot; },
    async acceptConnection(result) {
      if (busy) throw new Error('A Statewright request is already in progress');
      busy = true;
      try {
        const id = await current();
        const connection = decodeNativeConnection(result, id);
        snapshot = connection.snapshot;
        return snapshot;
      } finally { busy = false; }
    },
    async request(action, permission) {
      if (!actionValid(action)) throw new Error('Invalid native workflow action');
      if (busy) throw new Error('A Statewright request is already in progress');
      // Reserve before yielding: a second native callback cannot race dispatch.
      busy = true;
      let dispatched = false;
      try {
        const id = await current();
        const mutation = action.operation !== 'get_state';
        if (mutation && (!snapshot || !uuid(action.expectedRevision) || snapshot.revision !== action.expectedRevision))
          throw new Error('Refresh Statewright before trying this action');
        const before = snapshot?.revision;
        const args = { context: { version: 1, conversation_id: id }, operation: action.operation,
          input: action.input, expected_revision: mutation ? before : action.expectedRevision ?? null };
        dispatched = true;
        const result = await call(args, permission);
        if (await current() !== id) throw new Error('The conversation changed during this request');
        const next = decodeNativeControl(result, id);
        if ((mutation && (next.outcome === null || next.revision === before)) ||
            (!mutation && next.outcome !== null)) throw new Error('Incomplete native workflow receipt');
        // Nested isError remains visible to the caller; never turn it into a
        // successful Start/transition merely because the outer MCP call worked.
        snapshot = next;
        return next;
      } catch (error) {
        // A dispatched mutation may have succeeded remotely. No retries or
        // reuse of its old revision; a new read is required to learn the truth.
        if (dispatched) snapshot = null;
        throw error;
      } finally { busy = false; }
    },
  };
}
