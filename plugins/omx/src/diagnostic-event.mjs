// Portable between Node entrypoints and Claude's native hooks. This is a closed
// vocabulary, not a redactor: no message, stack, URL, path or tool input leaves.
export const DEFAULT_SENTRY_DSN = 'https://3c30b803a5b44d74bf9657db7a89f033@glitch.enhasa.cloud/12';
const words = value => new Set(value.split(' '));
const fields = {
  mechanism: words('test entrypoint child_exit child_spawn transport protocol shutdown approval_evidence unhandled_rejection uncaught_exception handled'),
  operation: words('unknown managed_client unmanaged_client managed_exec resident_tui native_tui app_server app_server_proxy resident_app_server prepare_review statewright_exec statewright_codex connect login catalog control get_state load_workflow transition deactivate request_approval pre_tool post_tool stop command native_ui canary hook mcp.connect mcp.call tool.call tool.check'),
  host: words('codex claude claude-code pi opencode omx'),
  transport: words('websocket http stdio'),
  side: words('native_close upstream_close native_error upstream_error native upstream'),
  phase: words('check login reconnect identity catalog catalog_decode complete control'),
  runtime: words('node claude-native'),
  reason: words('unknown oauth_failed credential_unavailable permission_refused auto_review_unavailable helper_unavailable login_timeout login_incomplete auth policy disabled unapproved unlisted failed session_unbound tool_unavailable control_hook_failed module_unavailable capability_unavailable request_timeout server_identity catalog_invalid native_error command_failed workflow_failed ui_failed synthetic_canary'),
  signal: words('SIGINT SIGTERM SIGKILL SIGABRT SIGSEGV SIGHUP SIGPIPE'),
};
const classes = words('Error TypeError RangeError SyntaxError ReferenceError URIError EvalError AggregateError AbortError');
const plugins = words('codex claude-code managed-client executor pi opencode omx');
export function sanitizeContext(context = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(context)) {
    if (Object.hasOwn(fields, key) && fields[key].has(value)) safe[key] = value;
    else if (['exit_code', 'close_code', 'http_status'].includes(key) && Number.isSafeInteger(value) && value >= 0 && value <= 4294967295) safe[key] = value;
  }
  return safe;
}
export function sanitizeError(error) {
  return { type: classes.has(error?.name) ? error.name : 'Error',
    value: 'Unexpected plugin failure (message withheld).' };
}
// One versioned product-improvement choice, not a host's or a historical
// recording-only consent. Unknown and explicit local opt-out never enable it.
export function diagnosticsAllowed({ enabled, disabled, consent } = {}) {
  if (disabled === true || disabled === 'true' || enabled === false || enabled === 'false') return false;
  if (consent?.version === 2 && consent.enabled === false) return false;
  return enabled === true || enabled === 'true' ||
    (consent?.version === 2 && consent?.enabled === true);
}
export function validTelemetryConsent(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => ['version', 'enabled', 'updated_at'].includes(key)) &&
    value.version === 2 && typeof value.enabled === 'boolean' &&
    typeof value.updated_at === 'string' && value.updated_at.length < 40 && Number.isFinite(Date.parse(value.updated_at));
}
export function observeTelemetryConsent(view, value, now = Date.now()) {
  const next = validTelemetryConsent(value) ? value : null;
  const stamp = next ? Date.parse(next.updated_at) : 0, watermark = view.telemetryWatermark ?? 0;
  if (!next || !next.enabled || stamp > watermark ||
      (stamp === watermark && view.telemetryWatermarkDenied !== true)) {
    view.telemetryConsent = next; view.telemetryCheckedAt = now;
    view.telemetryWatermark = Math.max(stamp, watermark);
    if (next) view.telemetryWatermarkDenied = !next.enabled;
  }
}
export function sentryEndpoint(dsn) {
  try {
    const parsed = new URL(dsn), parts = parsed.pathname.split('/').filter(Boolean), project = parts.pop();
    if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.username || !/^\d+$/.test(project ?? '') || parsed.password || parsed.search || parsed.hash) return null;
    return `${parsed.protocol}//${parsed.host}${parts.length ? `/${parts.join('/')}` : ''}/api/${project}/envelope/?sentry_version=7&sentry_key=${encodeURIComponent(parsed.username)}`;
  } catch { return null; }
}
export function diagnosticEvent({ plugin, version, platform, environment, eventId, error, context = {}, handled = false }) {
  const tags = sanitizeContext(context);
  tags.plugin = plugins.has(plugin) ? plugin : 'unknown';
  if (['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64', 'claude-native'].includes(platform)) tags.platform = platform;
  const release = `statewright-${tags.plugin}@${/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version ?? '') ? version : 'unknown'}`;
  const failure = handled ? tags.reason ?? 'unknown' : sanitizeError(error).type;
  return {
    ...(eventId ? { event_id: eventId } : {}), timestamp: new Date().toISOString(), platform: 'node',
    level: handled && tags.reason === 'permission_refused' ? 'warning' : 'error',
    release, environment: ['production', 'staging', 'development', 'test'].includes(environment) ? environment : 'production',
    tags, fingerprint: ['statewright-plugin-v1', tags.plugin, tags.operation ?? 'unknown', failure],
    ...(handled ? { message: `Statewright ${tags.operation ?? 'unknown'}: ${failure}` }
      : { exception: { values: [{ ...sanitizeError(error), mechanism: { type: tags.mechanism ?? 'generic', handled: !['uncaught_exception', 'unhandled_rejection'].includes(tags.mechanism) } }] } }),
  };
}
export function formatEnvelope({ dsn, event }) {
  return `${JSON.stringify({ ...(event.event_id ? { event_id: event.event_id } : {}), sent_at: event.timestamp, dsn, sdk: { name: 'statewright.plugin', version: '1' } })}\n${JSON.stringify({ type: 'event', content_type: 'application/json' })}\n${JSON.stringify(event)}\n`;
}
