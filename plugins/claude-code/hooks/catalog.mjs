// Consumer connection identity. Native Claude owns OAuth, tokens and refresh.
export const SERVER = 'statewright';
export const GATEWAY = 'https://mcp.statewright.ai/mcp';
export const NATIVE_SERVER = `plugin:statewright:${SERVER}`;
export const LOGIN_COMMAND = `claude mcp login ${NATIVE_SERVER} --no-browser`;
export const CATALOG_ONLY = 'This connection can list and select workflows, but cannot start or change them yet.';
// Persist only a closed diagnostic vocabulary. Native exceptions can contain
// URLs, credentials, tool arguments or server responses; never copy them to UI/store.
export function connectionFailure(stage, error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const code = stage === 'identity' ? 'server_identity'
    : stage === 'catalog_decode' ? 'catalog_invalid'
    : /no session is bound/.test(message) ? 'session_unbound'
    : /no connected MCP tool|no tool named/.test(message) ? 'tool_unavailable'
    : /Statewright control is unavailable/.test(message) ? 'control_hook_failed'
    : /not admitted|withheld|not a loaded plugin/.test(message) ? 'module_unavailable'
    : /host rule|host check/.test(message) ? 'capability_unavailable'
    // Native Auto-mode unavailability is not a verdict against the action.
    // Distinguish it for guidance only; never grant permission or retry here.
    : /auto mode/i.test(message) && /gave no verdict|is temporarily unavailable/i.test(message) ? 'auto_review_unavailable'
    : /aborted|AbortError/i.test(message) ? 'request_aborted'
    : /timed? out|timeout|deadline/i.test(message) ? 'request_timeout'
    : /refused|denied|permission/i.test(message) ? 'permission_refused'
    : 'native_error';
  return { code, operation: /\$\.mcp\.connect/.test(message) ? 'mcp.connect'
    : /\$\.mcp\.call/.test(message) ? 'mcp.call'
    : /\$\.tool\.call/.test(message) ? 'tool.call'
    : /\$\.tool\.check/.test(message) ? 'tool.check' : 'unknown' };
}
export const gatewayTool = name => typeof name === 'string' &&
  name.replace(/[:-]/g, '_').startsWith(`mcp__plugin_statewright_${SERVER}__`);
export const gatewayServer = name => typeof name === 'string' &&
  [SERVER, NATIVE_SERVER, NATIVE_SERVER.replace(/:/g, '_')].includes(name);
export const emptyArgs = args => args !== null && typeof args === 'object' &&
  !Array.isArray(args) && Object.keys(args).length === 0;
export const catalogTool = (name, args) => typeof name === 'string' &&
  /^mcp__plugin[:_]statewright[:_]statewright__statewright_list_workflows$/.test(name) && emptyArgs(args);
// tool.call spreads arguments beside these engine-owned envelope fields.
export function catalogCall({ tool, tool_use_id, agentId, requestMeta, consent, ...args }) {
  return catalogTool(tool, args);
}
export function validName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 200 &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name);
}
// Use only the gateway's owned-catalog resolution. An enabled-name list alone
// cannot distinguish an absent alias from an explicitly disabled exact entry.
export function resolveWorkflowName(name, workflows, aliases = {}) {
  if (workflows.includes(name)) return name;
  return name === 'engineering' && aliases.engineering === 'agentic-engineering' &&
    workflows.includes('agentic-engineering') ? 'agentic-engineering' : name;
}
export const validWorkflowAliases = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.entries(value).every(([alias, target]) => alias === 'engineering' && target === 'agentic-engineering');
export function decodeCatalog(result) {
  return decodeCatalogConnection(result).workflows;
}
export function decodeCatalogConnection(result) {
  if (result?.isError || !Array.isArray(result?.content) || result.content.length !== 1 ||
      result.content[0]?.type !== 'text' || typeof result.content[0].text !== 'string' ||
      result.content[0].text.length > 131072) throw new Error('Invalid catalog');
  const { workflows, workflow_aliases = {}, native_control } = JSON.parse(result.content[0].text);
  if (!Array.isArray(workflows) || workflows.length > 1000 || !workflows.every(validName) ||
      new Set(workflows).size !== workflows.length) throw new Error('Invalid catalog');
  if (!validWorkflowAliases(workflow_aliases) ||
      Object.entries(workflow_aliases).some(([alias, target]) => workflows.includes(alias) || !workflows.includes(target)))
    throw new Error('Invalid workflow aliases');
  // The gateway's `active` is NOT bound to this native conversation. Never use it.
  const supported = native_control !== null && typeof native_control === 'object' &&
    !Array.isArray(native_control) && native_control.version === 1;
  return { workflows, workflowAliases: workflow_aliases, nativeControl: supported,
    unsupportedControl: native_control !== undefined && native_control !== null && !supported };
}
