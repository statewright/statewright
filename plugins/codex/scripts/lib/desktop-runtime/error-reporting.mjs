import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DEFAULT_SENTRY_DSN, diagnosticEvent, diagnosticsAllowed, formatEnvelope, sentryEndpoint, validTelemetryConsent } from './diagnostic-event.mjs';
export { DEFAULT_SENTRY_DSN, diagnosticsAllowed, formatEnvelope, sanitizeContext, sanitizeError, sentryEndpoint } from './diagnostic-event.mjs';

export function isExpectedExit({ code, signal, shuttingDown = false } = {}) {
  return shuttingDown || ['SIGINT', 'SIGTERM'].includes(signal) || [0, 130, 143, 3_221_225_786].includes(code);
}
export function isExpectedTransportClose({ side, code } = {}) {
  return ['native_close', 'upstream_close'].includes(side) && [1000, 1001, 1005].includes(code);
}
export function isExpectedPluginError(error) {
  const message = String(error instanceof Error ? error.message : error ?? '');
  return error?.name === 'AbortError' || error?.code === 'CREDENTIAL_UNLOCK_CANCELLED'
    || /^(?:--(?:host|real-bin|workflow|sandbox|approval-policy|approvals-reviewer|delivery-run-id)|Unknown option:)/.test(message)
    || /^(?:Choose either|Unsupported managed client host|Statewright cannot translate OpenAI model|Provide the task)/.test(message)
    || message.startsWith('[statewright] BLOCKED:') || message.includes('requires isolated delivery')
    || message.includes('Native-tool adapter unavailable');
}
const timeout = env => Math.min(2000, Math.max(100, Number(env.STATEWRIGHT_SENTRY_TIMEOUT_MS) || 1000));

export function createErrorReporter({ plugin, version = process.env.npm_package_version ?? 'unknown',
  environment = process.env, send = defaultSend, consent } = {}) {
  const seen = new Set(), pending = new Set();
  let last = { outcome: 'idle' }, attempts = 0, installed = false;
  const tags = { plugin, release: `statewright-${plugin}@${version}` };
  async function prepare(error, context, handled) {
    if (environment.STATEWRIGHT_SENTRY_DISABLED === 'true' || environment.STATEWRIGHT_SENTRY_ENABLED === 'false') {
      last = { outcome: 'disabled' }; return null;
    }
    const source = environment, identity = [source.STATEWRIGHT_API_KEY, source.STATEWRIGHT_PB_URL, source.STATEWRIGHT_GATEWAY_URL];
    const grant = await (consent ? consent() : readAccountConsent(environment));
    if (source !== environment || identity.some((value, i) => value !== [environment.STATEWRIGHT_API_KEY, environment.STATEWRIGHT_PB_URL, environment.STATEWRIGHT_GATEWAY_URL][i])) {
      last = { outcome: 'disabled' }; return null;
    }
    // A local withdrawal while the account request was in flight still wins.
    const enabled = diagnosticsAllowed({ enabled: environment.STATEWRIGHT_SENTRY_ENABLED,
      disabled: environment.STATEWRIGHT_SENTRY_DISABLED, consent: grant });
    if (!enabled) { last = { outcome: 'disabled' }; return null; }
    const dsn = environment.STATEWRIGHT_SENTRY_DSN ?? DEFAULT_SENTRY_DSN, endpoint = sentryEndpoint(dsn);
    if (!endpoint) { last = { outcome: 'invalid_dsn' }; return null; }
    return packet(error, context, handled, dsn, endpoint);
  }
  function packet(error, context, handled, dsn, endpoint) {
    const event = diagnosticEvent({ plugin, version, platform: `${process.platform}-${process.arch}`,
      environment: environment.NODE_ENV, eventId: randomUUID().replaceAll('-', ''), error, context, handled });
    const key = JSON.stringify(event.fingerprint);
    if (seen.has(key) || pending.has(key) || attempts >= 20) return null;
    attempts++; pending.add(key);
    return { endpoint, dsn, event, environment, key };
  }
  async function dispatch(error, context, handled) {
    let payload;
    try {
      payload = await prepare(error, context, handled);
      if (!payload) return false;
      await send(payload);
      seen.add(payload.key); last = { outcome: 'sent', eventId: payload.event.event_id };
      return true;
    } catch { last = { outcome: 'delivery_failed' }; return false; }
    finally { if (payload) pending.delete(payload.key); }
  }
  const report = (error, context = {}) => {
    const reason = error?.code === 'EACCES' || error?.code === 'EPERM' ? 'permission_refused'
      : /^DESKTOP_CONNECT_(?:UNAVAILABLE|PROTOCOL|REJECTED|EXPIRED)$/.test(error?.code ?? '') ? 'oauth_failed'
      : /^CREDENTIAL_|^DESKTOP_CONNECT_STORE$/.test(error?.code ?? '') ? 'credential_unavailable' : null;
    return dispatch(error, reason ? { ...context, reason, mechanism: 'handled' } : context, Boolean(reason));
  };
  const reportFailure = (reason, context = {}) => dispatch(null, { ...context, reason, mechanism: 'handled' }, true);
  function installProcessHandlers() {
    if (installed) return;
    installed = true;
    // Async work in this monitor is abandoned when Node exits. A bounded child
    // sends only a scrubbed envelope without swallowing the native exception.
    // A fatal path cannot refresh account consent: only explicit local opt-in.
    process.on('uncaughtExceptionMonitor', (error, origin) => {
      try {
        if (!diagnosticsAllowed({ enabled: environment.STATEWRIGHT_SENTRY_ENABLED, disabled: environment.STATEWRIGHT_SENTRY_DISABLED })) return;
        const dsn = environment.STATEWRIGHT_SENTRY_DSN ?? DEFAULT_SENTRY_DSN, endpoint = sentryEndpoint(dsn);
        if (!endpoint) return;
        const payload = packet(error, { mechanism: origin === 'unhandledRejection' ? 'unhandled_rejection' : 'uncaught_exception' }, false, dsn, endpoint);
        if (payload) sendFatal(payload);
      } catch { /* Never replace the original failure. */ }
    });
  }
  return { report, reportFailure, installProcessHandlers, tags, status: () => ({ ...last }),
    setEnvironment: value => { environment = value; } };
}
export async function readAccountConsent(environment, fetchImpl = fetch) {
  const key = environment.STATEWRIGHT_API_KEY, base = environment.STATEWRIGHT_PB_URL;
  if (!key || !base || !environment.STATEWRIGHT_GATEWAY_URL) return null;
  try {
    const url = new URL(base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    const response = await fetchImpl(`${base.replace(/\/$/, '')}/api/gateway/telemetry`, {
      headers: { Authorization: `Bearer ${key}`, 'X-Statewright-OAuth-Resource': environment.STATEWRIGHT_GATEWAY_URL },
      redirect: 'error', signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const value = await response.json();
    return validTelemetryConsent(value) ? value : null;
  } catch { return null; }
}
async function defaultSend({ endpoint, dsn, event, environment }) {
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/x-sentry-envelope' }, body: formatEnvelope({ dsn, event }),
    signal: AbortSignal.timeout(timeout(environment)) });
  await response.body?.cancel();
  if (!response.ok) throw new Error('Diagnostic delivery rejected');
}
function sendFatal({ endpoint, dsn, event, environment }) {
  const ms = timeout(environment);
  const child = `import { readFileSync } from 'node:fs';
const p = JSON.parse(readFileSync(0, 'utf8'));
try { const r = await fetch(p.endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-sentry-envelope' }, body: p.body, signal: AbortSignal.timeout(p.ms) }); await r.body?.cancel(); process.exitCode = r.ok ? 0 : 1; } catch { process.exitCode = 1; }`;
  spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    input: JSON.stringify({ endpoint, body: formatEnvelope({ dsn, event }), ms }),
    timeout: ms + 500, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
    env: { ...(environment.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: environment.NODE_EXTRA_CA_CERTS } : {}) },
  });
}
