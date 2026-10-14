import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { observeTelemetryConsent } from '../lib/diagnostic-event.mjs';

test('receipt ordering cannot revive withdrawal through unknown or another account', () => {
  const view = {}, grant = { version: 2, enabled: true, updated_at: '2026-10-14T12:00:00.000Z' };
  observeTelemetryConsent(view, grant); assert.equal(view.telemetryConsent.enabled, true);
  observeTelemetryConsent(view, { ...grant, enabled: false, updated_at: '2026-10-13T12:00:00.000Z' });
  assert.equal(view.telemetryConsent.enabled, false, 'even older denial from another account wins');
  observeTelemetryConsent(view, null); observeTelemetryConsent(view, grant);
  assert.equal(view.telemetryConsent, null, 'late positive cannot erase withdrawal');
  observeTelemetryConsent(view, { ...grant, updated_at: '2026-10-14T12:00:01.000Z' });
  assert.equal(view.telemetryConsent.enabled, true, 'a new affirmative decision works');
  observeTelemetryConsent(view, null);
  observeTelemetryConsent(view, { ...grant, updated_at: '2026-10-14T12:00:01.000Z' });
  assert.equal(view.telemetryConsent.enabled, true, 'fresh lookup after transient unknown works');
});
import { createErrorReporter, readAccountConsent, formatEnvelope, isExpectedExit, isExpectedPluginError, isExpectedTransportClose, sanitizeContext, sanitizeError, sentryEndpoint } from "../lib/error-reporting.mjs";

test('account preference lookup is scoped, fresh, rejects redirects and fails closed', async () => {
  const environment = { STATEWRIGHT_API_KEY: 'private-key', STATEWRIGHT_PB_URL: 'https://account.example', STATEWRIGHT_GATEWAY_URL: 'https://gateway.example/mcp' };
  const grant = { version: 2, enabled: true, updated_at: '2026-10-14T12:00:00.000Z' };
  let requests = 0;
  const fetcher = async (url, init) => {
    requests++; assert.equal(url, 'https://account.example/api/gateway/telemetry');
    assert.equal(init.headers.Authorization, 'Bearer private-key');
    assert.equal(init.headers['X-Statewright-OAuth-Resource'], environment.STATEWRIGHT_GATEWAY_URL);
    assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    return { ok: true, json: async () => ({ ...grant }) };
  };
  assert.deepEqual(await readAccountConsent(environment, fetcher), grant);
  grant.enabled = false;
  assert.equal((await readAccountConsent(environment, fetcher)).enabled, false);
  assert.equal(requests, 2);
  assert.equal(await readAccountConsent({ ...environment, STATEWRIGHT_API_KEY: '' }, fetcher), null);
  assert.equal(await readAccountConsent({ ...environment, STATEWRIGHT_PB_URL: 'https://user:secret@example.com' }, fetcher), null);
  assert.equal(requests, 2);
  assert.equal(await readAccountConsent(environment, async () => { throw Error('offline'); }), null);
  assert.equal(await readAccountConsent(environment, async () => ({ ok: true, json: async () => ({ version: 1, enabled: true }) })), null);
});

for (const change of ['disable', 'gateway', 'environment']) test(`in-flight ${change} invalidates an earlier grant`, async () => {
  let finish, sent = 0;
  const environment = {};
  const reporter = createErrorReporter({ plugin: 'codex', environment,
    consent: () => new Promise(r => { finish = r; }), send: async () => { sent++; } });
  const pending = reporter.reportFailure('oauth_failed', { operation: 'login' });
  if (change === 'disable') environment.STATEWRIGHT_SENTRY_DISABLED = 'true';
  if (change === 'gateway') environment.STATEWRIGHT_GATEWAY_URL = 'https://different.example';
  if (change === 'environment') reporter.setEnvironment({});
  finish({ version: 2, enabled: true });
  assert.equal(await pending, false); assert.equal(sent, 0);
});

test("error reporter redacts credentials and excludes arbitrary payload context", () => {
  const error = sanitizeError(new Error('Authorization: Bearer secret-token sw_live_abc123 token=also-secret payload={"prompt":"world-domination-plan"}'));
  assert.doesNotMatch(error.value, /secret-token|sw_live_abc123|also-secret|world-domination-plan/);
  assert.equal(error.value, "Unexpected plugin failure (message withheld).");
  assert.equal(error.stacktrace, undefined);
  assert.deepEqual(sanitizeContext({ mechanism: "test", prompt: "do not upload this", token: "secret", exit_code: 2 }), {
    mechanism: "test", exit_code: 2,
  });
});

test("error reporter sends one scrubbed envelope and deduplicates repeated failure", async () => {
  const sent = [];
  const reporter = createErrorReporter({
    plugin: "codex",
    version: "0.3.0",
    environment: { NODE_ENV: "test", STATEWRIGHT_SENTRY_ENABLED: "true" },
    send: async (payload) => { sent.push(payload); },
  });
  assert.equal(await reporter.report(new Error("api_key=secret"), { mechanism: "child_exit", exit_code: 2, prompt: "hidden" }), true);
  assert.equal(await reporter.report(new Error("api_key=other-secret"), { mechanism: "child_exit", exit_code: 2 }), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event.tags.plugin, "codex");
  assert.equal(sent[0].event.tags.exit_code, 2);
  assert.doesNotMatch(JSON.stringify(sent[0].event), /secret|hidden/);
});

test("Sentry endpoint preserves a self-hosted path prefix and failed delivery remains retryable", async () => {
  assert.equal(
    sentryEndpoint("https://public@example.test/sentry/12"),
    "https://example.test/sentry/api/12/envelope/?sentry_version=7&sentry_key=public",
  );
  let attempts = 0;
  const reporter = createErrorReporter({
    plugin: "codex",
    environment: { NODE_ENV: "test", STATEWRIGHT_SENTRY_ENABLED: "true" },
    send: async () => { attempts += 1; if (attempts === 1) throw new Error("offline"); },
  });
  assert.equal(await reporter.report(new Error("same failure"), { mechanism: "child_exit" }), false);
  assert.equal(await reporter.report(new Error("same failure"), { mechanism: "child_exit" }), true);
  assert.equal(attempts, 2);
  const envelope = formatEnvelope({ dsn: "https://public@example.test/12", event: { event_id: "event", timestamp: "2026-08-25T00:00:00.000Z", tags: {}, exception: { values: [{ value: "Unexpected plugin failure (message withheld)." }] } } });
  assert.doesNotMatch(envelope, /same failure|secret/);
});

test("error reporting is opt-in and the disable switch wins", async () => {
  const sent = [];
  const defaultReporter = createErrorReporter({
    plugin: "codex",
    environment: { NODE_ENV: "test" },
    send: async (payload) => { sent.push(payload); },
  });
  assert.equal(await defaultReporter.report(new Error("not opted in"), { mechanism: "test" }), false);

  const disabledReporter = createErrorReporter({
    plugin: "codex",
    environment: {
      NODE_ENV: "test",
      STATEWRIGHT_SENTRY_ENABLED: "true",
      STATEWRIGHT_SENTRY_DISABLED: "true",
    },
    send: async (payload) => { sent.push(payload); },
  });
  assert.equal(await disabledReporter.report(new Error("explicitly disabled"), { mechanism: "test" }), false);
  assert.equal(sent.length, 0);
});

test("normal exits and normal websocket closes are not error conditions", () => {
  assert.equal(isExpectedExit({ code: 0 }), true);
  assert.equal(isExpectedExit({ signal: "SIGINT" }), true);
  assert.equal(isExpectedExit({ code: 130 }), true);
  assert.equal(isExpectedExit({ code: 3_221_225_786 }), true);
  assert.equal(isExpectedExit({ code: 2 }), false);
  assert.equal(isExpectedTransportClose({ side: "native_close", code: 1000 }), true);
  assert.equal(isExpectedTransportClose({ side: "upstream_close", code: 1006 }), false);
  assert.equal(isExpectedPluginError(new Error("--host must be codex or claude.")), true);
  assert.equal(isExpectedPluginError(new Error("Unknown option: --typo")), true);
  assert.equal(isExpectedPluginError(new Error("[statewright] BLOCKED: command is not allowed")), true);
  assert.equal(isExpectedPluginError(new Error("unexpected internal failure")), false);
});

test('new grant required; explicit opt-out wins and is rechecked', async () => {
  const environment = {}, sent = [];
  let grant = { version: 1, enabled: true };
  const r = createErrorReporter({ plugin: 'codex', version: '0.3.4', environment,
    consent: () => grant, send: async p => sent.push(p) });
  assert.equal(await r.reportFailure('oauth_failed', { operation: 'login' }), false);
  grant = { version: 2, enabled: true };
  assert.equal(await r.reportFailure('oauth_failed', { operation: 'login' }), true);
  environment.STATEWRIGHT_SENTRY_DISABLED = 'true';
  assert.equal(await r.reportFailure('permission_refused', { operation: 'control' }), false);
  delete environment.STATEWRIGHT_SENTRY_DISABLED;
  grant.enabled = false;
  assert.equal(await r.reportFailure('command_failed', { operation: 'command' }), false);
  assert.equal(sent.length, 1);
});
test('arbitrary names, context, metadata and command contents cannot leave', async () => {
  const sent = [], secret = 'private_customer_prompt';
  const r = createErrorReporter({ plugin: secret, version: secret,
    environment: { STATEWRIGHT_SENTRY_ENABLED: 'true', NODE_ENV: secret }, send: async p => sent.push(p) });
  await r.report(Object.assign(new Error(secret), { name: secret }), { mechanism: secret, reason: secret, operation: secret, phase: secret, prompt: secret, signal: secret, exit_code: secret });
  await r.reportFailure(secret, { operation: 'command', command: secret });
  assert.equal(sent.length, 2);
  assert.doesNotMatch(JSON.stringify(sent.map(p => p.event)), new RegExp(secret));
  assert.match(sent[1].event.message, /command: unknown/);
});
test('concurrent identical failures send once; different operations group separately', async () => {
  const sent = [];
  const r = createErrorReporter({ plugin: 'codex', environment: { STATEWRIGHT_SENTRY_ENABLED: 'true' }, send: async p => sent.push(p) });
  await Promise.all(Array.from({ length: 10 }, () => r.reportFailure('permission_refused', { operation: 'control' })));
  await r.reportFailure('permission_refused', { operation: 'login' });
  assert.equal(sent.length, 2);
  assert.notDeepEqual(sent[0].event.fingerprint, sent[1].event.fingerprint);
  assert.equal(sent[0].event.level, 'warning');
});
test('real HTTP and fatal child delivery preserve native exit behavior', async t => {
  const received = [];
  const server = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk;
    received.push({ path: req.url, body, type: req.headers['content-type'] }); res.end('{}'); });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { ...process.env, STATEWRIGHT_SENTRY_ENABLED: 'true', STATEWRIGHT_SENTRY_DISABLED: 'false',
    STATEWRIGHT_SENTRY_DSN: `http://public@127.0.0.1:${server.address().port}/12` };
  const r = createErrorReporter({ plugin: 'codex', version: '0.3.4', environment: env });
  assert.equal(await r.reportFailure('oauth_failed', { operation: 'login' }), true);
  const module = new URL('../lib/error-reporting.mjs', import.meta.url).href;
  for (const failure of ["throw new Error('PRIVATE_PROMPT')", "Promise.reject(new Error('PRIVATE_PROMPT'))"]) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { createErrorReporter } from '${module}'; createErrorReporter({plugin:'codex',version:'0.3.4'}).installProcessHandlers(); ${failure}`], { env, stdio: 'ignore' });
    assert.equal(await new Promise(resolve => child.once('exit', resolve)), 1);
  }
  assert.equal(received.length, 3);
  for (const delivery of received) {
    assert.match(delivery.path, /api\/12\/envelope/);
    assert.equal(delivery.type, 'application/x-sentry-envelope');
    assert.doesNotMatch(delivery.body, /PRIVATE_PROMPT/);
    const [header, item, event] = delivery.body.trim().split('\n').map(JSON.parse);
    assert.equal(item.type, 'event'); assert.equal(header.event_id, event.event_id);
    assert.equal(event.release, 'statewright-codex@0.3.4');
  }
});
