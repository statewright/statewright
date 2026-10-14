import { decodeCatalogConnection, connectionFailure, validName, resolveWorkflowName, gatewayTool, gatewayServer, catalogTool, catalogCall, emptyArgs, SERVER,
  NATIVE_SERVER, LOGIN_COMMAND } from './catalog.mjs';
import { createNativeControl, NATIVE_CONTROL_TOOL, NATIVE_CONNECT_TOOL, decodeNativeConnection,
  executionReadiness, progressNodes } from './native-control.mjs';
import { createExecutionAdapter, outcome } from './native-execution.mjs';
import { ARBITER_PURPLE, ARBITER_ACCENT, STATE_BACKGROUND, observeJourney, statusPresentation, graphRows, eventSymbol } from './workflow-ui.mjs';
import { registerResultUI } from './result-ui.mjs';
import { desktopGraph, desktopTitle } from './desktop-ui.mjs';
import { DEFAULT_SENTRY_DSN, diagnosticEvent, diagnosticsAllowed, formatEnvelope, observeTelemetryConsent as observeConsent } from './diagnostic-event.mjs';
import { claudeRoute, routeEvent, routeReceipt, blockedStep, routingView, fableCreditGate, fableFallback, fallbackPermitted } from './native-routing.mjs';

const PANE = 'statewright';
const PAGE_SIZE = 32; // Native Select accepts at most 64 options.
let navigationRevision = 0;
const fresh = conversation => ({ conversation, desktopNavigationRevision: ++navigationRevision, epoch: 0, busy: false, connected: false,
  names: [], workflowAliases: {}, selected: '', page: 0, notice: '', error: '', connectionIssue: null, manual: false, timer: null, paneOpen: false, handoff: false,
  checked: false, interactive: false, pending: null, prompted: false, prompting: false, powerlineOverride: null, appearanceGeneration: 0,
  native: null, control: null, controlError: '', generation: 0, requiresEnforcement: false, controlConsent: false, consentEpoch: 0,
  runningTool: null, actionBusy: false, journey: null, showGraph: true, routes: [], routeError: '', modelActivity: null, baseRequest: null, fallback: null });
let view = fresh('');
let diagnosticOptions = {};
const diagnosticSeen = new Set();
let diagnosticAttempts = 0;
function reportDiagnostic($, v, reason, operation, phase) {
  if (['auth', 'request_aborted'].includes(reason)) return; // Signed-out/cancelled is not a malfunction.
  const event = diagnosticEvent({ plugin: 'claude-code', version: '0.3.4', platform: 'claude-native',
    handled: true, context: { mechanism: 'handled', runtime: 'claude-native', reason, operation, phase } });
  const key = JSON.stringify(event.fingerprint);
  if (diagnosticSeen.has(key) || diagnosticAttempts >= 20) return;
  diagnosticSeen.add(key);
  // Sending must not stall the connection or native permission result.
  $.clock.after(0, async () => {
    let delivered = false;
    try {
      if (view !== v || diagnosticOptions.diagnostics === false) return;
      const disabled = await $.env.get('STATEWRIGHT_SENTRY_DISABLED');
      const enabled = await $.env.get('STATEWRIGHT_SENTRY_ENABLED');
      if (view !== v || !diagnosticsAllowed({ disabled, enabled,
        consent: Date.now() - (v.telemetryCheckedAt ?? 0) <= 60000 ? v.telemetryConsent : null })) return;
      diagnosticAttempts++;
      const response = await $.http.fetch('https://glitch.enhasa.cloud/api/12/envelope/?sentry_version=7&sentry_key=3c30b803a5b44d74bf9657db7a89f033', {
        method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope' },
        body: formatEnvelope({ dsn: DEFAULT_SENTRY_DSN, event }),
      });
      delivered = response.ok;
    } catch { /* Never recurse, log secrets or affect host decisions. */ }
    finally { if (!delivered) diagnosticSeen.delete(key); }
  });
}
let connectTool = '';
const workflowTools = new Map();
const permissionFrames = new Map();
let controlDiagnosticWrites = Promise.resolve();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const argumentKey = args => JSON.stringify(canonical(args));
const workflowSpecs = [
  ['statewright_get_state', 'get_state', 'Read this conversation’s current Statewright workflow.', {}],
  ['statewright_load_workflow', 'load_workflow', 'Start a named Statewright workflow in this conversation, or return its current state if that workflow is already active. Continue an active workflow; do not restart it.', { name: { type: 'string' } }],
  ['statewright_transition', 'transition', 'Take a declared workflow event. A required human decision opens a native prompt; never supply an approval yourself.', { event: { type: 'string' }, data: { type: 'object' } }],
  ['statewright_deactivate', 'deactivate', 'Turn Statewright Off when the user asks to stop or disable the workflow.', {}],
  ['statewright_request_approval', 'request_approval', 'Show the current pending workflow decision to its authorized human reviewer. No decision argument.', {}],
];
function own($, next) { return next.origin?.plugin === $.plugin.name && typeof $.plugin.name === 'string'; }
const flatArgs = ({ tool, tool_use_id, agentId, consent, requestMeta, ...args }) => args;
const CONTROL_QUESTION = 'Allow Statewright to manage workflows in this conversation? This includes workflow changes and sending tool inputs and results for workflow checks. Claude’s file and command permissions and separate workflow approvals stay in place. This permission ends when the session closes or the plugin reloads.';
const CONTROL_OPTIONS = ['Allow this session', 'Not now'];
const CONTROL_QUESTION_INPUT = { questions: [{ question: CONTROL_QUESTION, header: 'Statewright',
  options: CONTROL_OPTIONS.map(label => ({ label, description: '' })), multiSelect: false }] };
async function isControlQuestion($, e, next, input) {
  const v = await current($), q = v.controlQuestion;
  if (!q || q.generation !== v.generation || q.epoch !== v.consentEpoch || !own($, next) || e.tool !== 'AskUserQuestion' ||
      !e.tool_use_id || e.agentId || next.signal?.aborted ||
      (q.invocation && q.invocation !== e.tool_use_id) || argumentKey(input) !== argumentKey(CONTROL_QUESTION_INPUT)) return false;
  q.invocation = e.tool_use_id;
  return true;
}
async function callControl($, args, permission) {
  const v = await current($), key = argumentKey(args);
  if (args.context?.conversation_id !== v.conversation) throw new Error('The Statewright conversation changed before dispatch.');
  const frame = { v, generation: v.generation, consentEpoch: v.consentEpoch, permission, invocation: null };
  if (permissionFrames.has(key)) throw new Error('This Statewright request is already in progress.');
  permissionFrames.set(key, frame);
  try { return await $.mcp.call(NATIVE_SERVER, NATIVE_CONTROL_TOOL, args); }
  catch (error) {
    const diagnostic = frame.failure ?? controlFailure(error);
    const write = async () => {
      if (await current($) !== v || frame.generation !== v.generation) return;
      await $.store.set('latest-control-diagnostic', {
        schema: 'statewright/control-diagnostic/v1', conversation: v.conversation,
        at: Date.now(), operation: args.operation, ...diagnostic,
      });
    };
    controlDiagnosticWrites = controlDiagnosticWrites.then(write, write).catch(() => {});
    await controlDiagnosticWrites;
    reportControlDiagnostic($, v, diagnostic.code, args.operation);
    const message = diagnostic.code === 'auto_review_unavailable'
      ? 'Claude couldn’t review this workflow action.'
      : diagnostic.code === 'permission_refused' ? 'Claude did not permit this workflow action.'
      : diagnostic.code === 'tool_unavailable' ? 'Claude hasn’t loaded Statewright’s workflow tools. Restart Claude and resume this conversation.'
      : 'Statewright could not complete this workflow action. Refresh its status before trying again.';
    throw new Error(`${message} [control/${diagnostic.code}]`);
  }
  finally { if (permissionFrames.get(key) === frame) permissionFrames.delete(key); }
}
function reportControlDiagnostic($, v, code, operation) { reportDiagnostic($, v, code, operation, 'control'); }
function controlFailure(error) {
  const { code } = connectionFailure('control', error);
  // Error text is diagnostic only. Even native deny can withhold a result
  // after execution; no exception proves that a remote mutation did not run.
  return { code };
}
async function nativeRequest($, operation, input, permission, fenceRead = false, owner) {
  const v = await current($);
  if (owner && (v !== owner.view || v.generation !== owner.generation))
    throw new Error('This request was superseded by a newer workflow action.');
  const generation = v.generation;
  if (!v.control) throw new Error('Connect to Statewright first.');
  const result = await v.control.request({ operation, input,
    ...(operation === 'get_state' && !fenceRead ? {} : { expectedRevision: v.native?.revision }) }, permission);
  if (await current($) !== v || v.generation !== generation) throw new Error('This request was superseded by a newer workflow action.');
  v.native = result;
  observeConsent(v, result.telemetry_consent);
  v.journey = observeJourney(v.journey, result);
  v.requiresEnforcement = Boolean(result.state && !result.state.is_final);
  await $.store.set(`workflow-active:${v.conversation}`, v.requiresEnforcement);
  redraw($); $.ui.invalidate('prompt.context');
  return result;
}
async function workflowAction($, operation, input = {}, shownRevision, permission) {
  const v = await current($);
  if (operation !== 'deactivate' && (v.actionBusy || (v.runningTool && operation !== 'get_state')))
    throw new Error('Wait for the current tool to finish before changing the workflow.');
  if (shownRevision !== undefined && shownRevision !== v.native?.revision)
    throw new Error('The workflow changed. Refresh before choosing its next action.');
  if (!v.control) throw new Error('Connect to Statewright first.');
  if (operation === 'load_workflow' && !executionReadiness(v.native, true).available)
    throw new Error(executionReadiness(v.native, true).reason);
  v.actionBusy = true; v.controlError = ''; redraw($);
  if (operation === 'load_workflow' || operation === 'deactivate') v.generation++;
  const generation = v.generation;
  const owner = { view: v, generation };
  try {
    if (operation === 'load_workflow' && v.native?.state && !v.native.state.is_final) {
      // Sidebar Start and a later natural-language request express the same
      // intent. Read the authoritative state, not an old cached load outcome.
      // Never send a duplicate mutation or replace a different active run.
      const snapshot = await nativeRequest($, 'get_state', {}, permission, false, owner);
      if (await current($) !== v || v.generation !== generation)
        throw new Error('This request was superseded by a newer workflow action.');
      if (snapshot.state && !snapshot.state.is_final) {
        // A fresh alias map proves its targets are in the current owned catalog;
        // the connection's selectable names may predate additions or removals.
        const aliases = snapshot.workflow_aliases ?? v.workflowAliases;
        const names = snapshot.workflow_aliases === undefined ? v.names : Object.values(aliases);
        if (snapshot.state.workflow !== resolveWorkflowName(input.name, names, aliases)) return { ...snapshot, status: 'workflow_conflict',
          message: 'A different workflow is active in this conversation. Continue it, or ask the user before turning it Off and starting another.' };
        return { ...snapshot, status: 'already_active',
          message: 'This workflow is already active. Continue from the current state and follow its tools and transitions; no workflow was restarted.' };
      }
    }
    if (operation === 'deactivate') {
      // Off must not wait behind an outstanding human prompt. Read a fresh
      // revision in the same authenticated conversation, not another session.
      v.control = createNativeControl({ conversation: () => $.session.id(),
        call: (args, verdict) => callControl($, args, verdict) });
      // Include the last displayed revision on this read. The server allows
      // read-only requests with it; the exact invocation differs from an old
      // unfenced read still waiting in Claude's permission dialog.
      await nativeRequest($, 'get_state', {}, permission, true, owner);
    }
    if (operation === 'load_workflow') {
      v.requiresEnforcement = true;
      await $.store.set(`workflow-active:${v.conversation}`, true);
    }
    if (operation === 'request_approval') {
      const state = v.native?.state;
      if (!state?.pending_approval || !state.run_id) throw new Error('There is no pending review for this conversation.');
      input = { run_id: state.run_id, approval_id: state.pending_approval.approval_id };
    }
    // Storage and readback can yield while Off or a resumed conversation wins.
    // Do not let the following request recapture that newer controller.
    if (await current($) !== v || v.generation !== generation)
      throw new Error('This request was superseded by a newer workflow action.');
    let result = await nativeRequest($, operation, input, permission, false, owner);
    if (result.outcome?.isError) throw new Error(result.outcome.content.map(b => b.text).join('\n'));
    if (operation === 'deactivate') { v.controlConsent = false; v.consentEpoch++; v.controlQuestion = null; }
    // A transition's pending ticket is resolved only through authenticated MCP
    // elicitation. The model and workspace never submit approve/reject fields.
    if (operation === 'transition' && result.state?.pending_approval && result.state.run_id) {
      const pending = result.state.pending_approval;
      result = await nativeRequest($, 'request_approval', { run_id: result.state.run_id, approval_id: pending.approval_id }, permission, false, owner);
    }
    return result;
  } catch (error) {
    if (await current($) === v && v.generation === generation) {
      v.controlError = error?.message || 'Statewright could not complete this action. Refresh and try again.';
    }
    throw error;
  } finally { if (await current($) === v && v.generation === generation) { v.actionBusy = false; redraw($); } }
}
function executionFor($) {
  // Host capabilities remain statically scoped to this hooks module. The pure
  // adapter receives callbacks, never the native host object itself.
  return createExecutionAdapter({ view: () => current($), request: (_, operation, input) => nativeRequest($, operation, input),
    after: (ms, callback) => $.clock.after(ms, callback),
    fault: (v, message) => { v.controlError = message; redraw($); } });
}
// Native Claude owns OAuth and its credential store. No shell, token access or
// generic /mcp picker. The login child reads the same installed plugin and
// saved gateway configuration; it never overrides enabled plugins or policy.
// Keep one bounded login across view cancellation/resume until it settles.
let nativeSignIn = null;
function signIn($) {
  if (!nativeSignIn) nativeSignIn = Promise.resolve()
    .then(() => $.process.run(['/usr/bin/expect', `${$.plugin.root}/scripts/native-login.exp`], { timeoutMs: 330000 }))
    .then(result => {
      if (result.exitCode !== 0) throw Object.assign(new Error('Native sign-in did not complete'), { loginExit: result.exitCode });
    })
    .finally(() => { nativeSignIn = null; });
  return nativeSignIn;
}
function invalidate(v) {
  v.epoch++; v.timer?.cancel(); v.timer = null; v.busy = false;
  v.pending?.resolve(); v.pending = null;
}
async function current($) {
  const id = await $.session.id();
  if (typeof id !== 'string' || !id) throw new Error('Conversation unavailable');
  if (id !== view.conversation) { invalidate(view); view = fresh(id); }
  return view;
}
const live = async ($, v, epoch) => (await current($)) === v && v.epoch === epoch;
const redraw = $ => $.ui.invalidate('ui.render');
const desktopViewKey = v => JSON.stringify([
  v.conversation, v.epoch, v.generation, v.appearanceGeneration, v.busy,
  v.connected, v.names, v.selected, v.page, v.notice, v.error, v.connectionIssue, v.manual,
  Boolean(nativeSignIn), v.actionBusy, v.runningTool, v.controlError,
  v.native, v.journey, v.showGraph, routingView(v), v.desktopClientFailed,
]);
async function desktopAction($, conversation, revision, key) {
  const v = await current($);
  if (conversation !== v.conversation || revision !== v.desktopRevision || v.desktopKey !== desktopViewKey(v)) return;
  const action = v.desktopActions?.get(key);
  if (!action) return;
  v.connectionSurface = 'desktop';
  v.desktopRevision++; v.desktopKey = null;
  try { await action(); }
  catch { if (await current($) === v) v.controlError = 'That action did not complete. Refresh the connection and try again.'; }
  finally { if (await current($) === v) redraw($); }
}
async function* showModelRequest($, v, event, next, probe, fallback = false) {
  const activity = { model: event.model, effort: event.effort ?? null, probe, fallback };
  v.modelActivity = activity; redraw($);
  let stream, completed = false;
  try {
    stream = next(event);
    while (true) {
      const item = await stream.next();
      if (item.done) { completed = true; return item.value; }
      if (probe && item.value.kind !== 'engine') probe.semantic = true;
      yield item.value;
    }
  }
  finally {
    try { if (!completed) await stream?.return?.(); }
    finally {
      // A late stream completion cannot clear a newer session/request's display.
      if (view === v && v.modelActivity === activity) { v.modelActivity = null; redraw($); }
    }
  }
}
function* stopRoute(v, e, message) {
  v.routeError = message;
  return yield* blockedStep(e, message);
}
async function openPane($, focus = true, navigation) {
  const v = await current($);
  if (navigation && (v !== navigation.view || v.desktopNavigationRevision !== navigation.revision)) return;
  v.paneOpen = true;
  redraw($);
  return $.ui.open({ id: PANE, title: 'Statewright', ...(focus ? { focus: true } : {}), closeOnEscape: true, rows: 12 });
}
async function cancel($, v) {
  if (await current($) !== v) return;
  invalidate(v); v.connected = false;
  v.checked = true;
  v.notice = 'Connection cancelled here. You can close any open sign-in window.'; redraw($);
}
const refusals = {
  policy: 'Claude’s policy does not allow this connection. Your administrator can review it.',
  disabled: 'The Statewright server is disabled in Claude. Open /mcp to review it.',
  unapproved: 'Claude needs your permission to use this server. Open /mcp to review it.',
  unlisted: 'The Statewright connection is missing from this plugin. Reload the installed plugin.',
  failed: 'Statewright could not be reached. Check the connection and try again.',
  auth: 'Sign-in hasn’t completed. Try connecting again when you’re ready.',
};

let connectionDiagnosticWrites = Promise.resolve();
async function recordConnection($, v, epoch, stage, outcome, code, operation = 'unknown') {
  if (!await live($, v, epoch)) return;
  const diagnostic = { schema: 'statewright/connection-diagnostic/v1',
    conversation: v.conversation, attempt: epoch, at: Date.now(), stage, outcome, code, operation };
  // One bounded record, not an unbounded transcript. A storage/log failure must
  // never change connection policy or prevent Cancel/recovery from working.
  const write = async () => {
    if (await live($, v, epoch)) await $.store.set('latest-connection-diagnostic', diagnostic);
  };
  connectionDiagnosticWrites = connectionDiagnosticWrites.then(write, write).catch(() => {});
  await connectionDiagnosticWrites;
  if (outcome === 'failed' && await live($, v, epoch)) {
    reportDiagnostic($, v, code, stage === 'login' ? 'login' : 'connect', stage);
    v.connectionIssue = code;
    if (code === 'auto_review_unavailable')
      v.error = 'Claude couldn’t review this request. Choose Connect to approve this connection in Claude’s permission prompt. Your permission mode stays unchanged.';
    if (code === 'tool_unavailable')
      v.error = 'Claude hasn’t loaded Statewright’s connection tools.';
    v.error += ` [${stage}/${code}]`;
    try { await $.ui.log(`Statewright connection: ${stage}/${code} (${operation}).`); } catch { /* sidebar remains available */ }
  }
}

async function connect($, v, epoch, allowSignIn) {
  let stage = 'check';
  try {
    if (!await live($, v, epoch)) return;
    v.telemetryConsent = null; v.telemetryCheckedAt = 0;
    await recordConnection($, v, epoch, stage, 'running', 'checking');
    if (!await live($, v, epoch)) return;
    let result;
    // session.start precedes the native REPL binding. Only this explicit
    // pre-dispatch readiness error can wait; policy/auth/network refusals
    // are never retried here. Nine waits total at most 2.25 seconds.
    for (let attempt = 0; attempt < 10; attempt++) {
      try { result = await $.mcp.connect(SERVER); break; }
      catch (error) {
        if (allowSignIn || !String(error?.message).includes('no session is bound')) throw error;
        if (attempt === 9) {
          v.notice = 'Claude is still starting. Open /statewright to check your saved connection.';
          return;
        }
        await new Promise(resolve => $.clock.after(250, resolve));
        if (!await live($, v, epoch)) return;
      }
    }
    if (!await live($, v, epoch)) return;
    if (!result?.isConnected && result?.reason === 'auth' && allowSignIn) {
      v.notice = 'Opening Statewright sign-in in your browser…';
      v.manual = true;
      redraw($);
      // Leave the conversation visible while Claude waits for the browser.
      v.handoff = true;
      try {
        if (v.connectionSurface !== 'desktop') await $.ui.close({ id: PANE });
        if (!await live($, v, epoch)) return;
        await signIn($);
      }
      catch (error) {
        if (await live($, v, epoch)) v.error = error?.loginExit === 127
          ? 'Claude Code’s sign-in helper could not start. Check that the native Claude Code CLI is installed, then try again.'
          : error?.loginExit === 124
            ? 'Statewright sign-in timed out. Try connecting again and finish approval in your browser.'
            : v.connectionSurface === 'desktop'
              ? 'Sign-in didn’t complete. Try connecting again.'
              : 'Sign-in didn’t complete. Try again, or use the terminal command below.';
        await recordConnection($, v, epoch, 'login', 'failed', error?.loginExit === 127 ? 'helper_unavailable'
          : error?.loginExit === 124 ? 'login_timeout' : 'login_incomplete');
        return;
      }
      finally { v.handoff = false; }
      if (!await live($, v, epoch)) return;
      // A CLI login updates the native credential store outside this process.
      // Reconnect just this server before asking the mod connection API again.
      stage = 'reconnect';
      await $.command.run({ command: 'mcp', args: `reconnect ${NATIVE_SERVER}` });
      if (!await live($, v, epoch)) return;
      result = await $.mcp.connect(SERVER);
      if (!await live($, v, epoch)) return;
    }
    if (!result?.isConnected) {
      v.error = refusals[result?.reason] ?? refusals.failed;
      v.manual = result?.reason === 'auth';
      await recordConnection($, v, epoch, stage, 'failed', Object.hasOwn(refusals, result?.reason) ? result.reason : 'failed');
      return;
    }
    // Do not trust a foreign server identity returned by another mod.
    stage = 'identity';
    if (result.server !== NATIVE_SERVER) throw new Error('Unexpected server');
    // Authentication succeeded: a later catalog failure is not a login prompt.
    v.manual = false;
    stage = 'catalog';
    await recordConnection($, v, epoch, stage, 'running', 'reading_workflows');
    if (!await live($, v, epoch)) return;
    if (allowSignIn) { v.notice = 'Confirm the connection in Claude’s permission prompt…'; redraw($); }
    // Only a deliberate user action invokes the gateway's marked consent read.
    // Quiet startup stays on the ordinary policy path. No fallback after denial.
    const resultCatalog = allowSignIn
      ? await $.mcp.call(result.server, NATIVE_CONNECT_TOOL, { context: { version: 1, conversation_id: v.conversation } })
      : await $.mcp.call(result.server, 'statewright_list_workflows', {});
    stage = 'catalog_decode';
    const catalog = allowSignIn ? decodeNativeConnection(resultCatalog, v.conversation) : decodeCatalogConnection(resultCatalog);
    if (!await live($, v, epoch)) return;
    observeConsent(v, catalog.snapshot?.telemetry_consent ?? catalog.telemetryConsent);
    const names = catalog.workflows;
    v.names = names;
    v.workflowAliases = catalog.workflowAliases;
    if (!names.includes(v.selected)) v.selected = names.includes('agentic-engineering')
      ? 'agentic-engineering' : names[0] ?? '';
    v.page = Math.max(0, Math.floor(names.indexOf(v.selected) / PAGE_SIZE));
    v.connected = true;
    v.manual = false;
    v.notice = '';
    v.error = '';
    await recordConnection($, v, epoch, 'complete', 'connected', 'connected');
    if (!await live($, v, epoch)) return;
    if (catalog.unsupportedControl)
      v.controlError = 'Workflow status needs a newer Statewright plugin. Your workflow list is still available.';
    if (catalog.nativeControl) {
      // A catalog's legacy `active` never identifies this conversation. Read
      // only when this authenticated connection advertises the new contract.
      const control = createNativeControl({ conversation: () => $.session.id(),
        call: (args, verdict) => callControl($, args, verdict) });
      v.control = control;
      try {
        const snapshot = allowSignIn ? await control.acceptConnection(resultCatalog)
          : await control.request({ operation: 'get_state', input: {} });
        if (!await live($, v, epoch)) return;
        v.native = snapshot;
        observeConsent(v, snapshot.telemetry_consent);
        v.journey = observeJourney(v.journey, snapshot);
        v.requiresEnforcement = Boolean(snapshot.state && !snapshot.state.is_final);
        await $.store.set(`workflow-active:${v.conversation}`, v.requiresEnforcement);
        $.ui.invalidate('prompt.context');
      } catch {
        if (!await live($, v, epoch)) return;
        v.controlError = 'Couldn’t read this conversation’s workflow. Reconnect to refresh its status.';
      }
    }
    // Do not steal focus if the person closed the workspace during sign-in.
  } catch (error) {
    if (await live($, v, epoch)) {
      v.connected = false;
      v.error = stage === 'identity'
        ? 'Claude returned a different Statewright server identity. Reload plugins to refresh this connection.'
        : stage === 'check'
        ? String(error?.message).includes('no session is bound')
          ? 'Claude has not attached Statewright to this conversation yet. Reload plugins, then try connecting again.'
          : 'Claude couldn’t check your Statewright connection. Try again; if it persists, reload plugins.'
        : stage === 'reconnect'
          ? 'Sign-in finished, but Claude couldn’t refresh this connection. Reload plugins, then try again.'
          : 'Connected to Statewright. Couldn’t read your workflows from Statewright. Try connecting again.';
      const diagnostic = stage === 'catalog' && v.catalogFailure?.epoch === epoch
        ? v.catalogFailure : connectionFailure(stage, error);
      await recordConnection($, v, epoch, stage, 'failed', diagnostic.code, diagnostic.operation);
    }
  } finally {
    if (await live($, v, epoch)) {
      const initialCheck = !v.checked;
      v.busy = false;
      v.checked = true;
      if (v.error) v.notice = '';
      v.timer?.cancel(); v.timer = null;
      v.pending?.resolve(); v.pending = null;
      redraw($);
      if (v.paneOpen || (initialCheck && v.manual)) await openPane($, false);
    }
  }
}
async function schedule($, v, allowSignIn = true) {
  if (await current($) !== v || v.busy) return;
  v.busy = true; v.error = ''; v.notice = ''; v.connected = false; v.manual = false;
  v.native = null; v.controlError = '';
  v.catalogFailure = null;
  v.connectionIssue = null;
  v.interactive = allowSignIn;
  const epoch = ++v.epoch;
  const pending = { started: false };
  pending.promise = new Promise(resolve => { pending.resolve = resolve; });
  pending.start = () => {
    if (pending.started) return;
    pending.started = true;
    return connect($, v, epoch, allowSignIn);
  };
  v.pending = pending;
  v.timer = $.clock.after(allowSignIn ? 600000 : 20000, async () => {
    if (!await live($, v, epoch)) return;
    invalidate(v);
    v.checked = true;
    v.error = allowSignIn ? 'Connection timed out. You can try again; any open sign-in window can be closed.'
      : 'Statewright could not be reached in time. Open /statewright to retry.';
    redraw($);
  });
  redraw($);
  $.clock.after(0, pending.start);
}
async function restore($) {
  const v = await current($);
  if (!v.checked && !v.busy) v.requiresEnforcement = (await $.store.get(`workflow-active:${v.conversation}`)) === true;
  if (!v.checked && !v.busy) await schedule($, v, false);
}

export function register(on, options = {}) {
  diagnosticOptions = options;
  registerResultUI(on, ARBITER_PURPLE);
  on('ui.message', async ($, e, next) => {
    if (e.surface === 'desktop' && e.component === 'AbovePrompt' &&
        e.element === 'status-sidebar' && e.module === 'hooks/desktop-action.js') {
      const v = await current($), data = e.data;
      if (data?.action === 'show-sidebar' && data.conversation === v.conversation &&
          data.revision === v.desktopNavigationRevision) await openPane($, true, { view: v, revision: data.revision });
      return {};
    }
    if (e.surface !== 'desktop' || e.component !== 'Pane' || e.requestId !== PANE ||
        e.module !== 'hooks/desktop-action.js') return next(e);
    const v = await current($), data = e.data;
    if (!data || data.conversation !== v.conversation || data.revision !== v.desktopRevision ||
        e.element !== `action-${data.action}`) return {};
    // Consume the displayed action before async work; duplicate messages and
    // clicks from an obsolete conversation/revision cannot dispatch it twice.
    await desktopAction($, data.conversation, data.revision, data.action);
    return {};
  });
  on('ui.fault', async ($, e, next) => {
    if (e.surface === 'desktop' && e.component === 'AbovePrompt' && e.element === 'status-sidebar' && e.module === 'hooks/desktop-action.js') {
      const v = await current($); v.desktopStatusClientFailed = true;
      reportDiagnostic($, v, 'ui_failed', 'native_ui');
    }
    if (e.surface === 'desktop' && e.component === 'Pane' && e.requestId === PANE && e.module === 'hooks/desktop-action.js') {
      const v = await current($); v.desktopClientFailed = true;
      reportDiagnostic($, v, 'ui_failed', 'native_ui');
    }
    return next(e);
  });
  on('session.append', async ($, e, next) => {
    const activity = view.modelActivity;
    if (activity?.probe && /^claude-fable-5(?:-1)?$/.test(activity.model) && fableCreditGate(e)) activity.probe.creditGate = true;
    return next(e);
  });
  on('session.start', async ($, e, next) => {
    const v = await current($);
    // Appearance overrides are local to this live session, never the persisted
    // conversation or saved configuration (a resume may use another terminal).
    v.powerlineOverride = null;
    v.controlConsent = false;
    v.consentEpoch++;
    v.controlQuestion = null;
    v.baseRequest = null;
    v.appearanceGeneration++;
    v.desktopNavigationRevision = ++navigationRevision;
    await $.command.register({ name: 'statewright', description: 'Open your Statewright workflow or set session appearance',
      argumentHint: '[configure | powerline on|off|default]' });
    workflowTools.clear();
    for (const [name, operation, description, properties] of workflowSpecs) {
      const required = operation === 'load_workflow' ? ['name'] : operation === 'transition' ? ['event'] : [];
      const { tool } = await $.tool.register({ name, description, isDeferred: false,
        inputSchema: { type: 'object', properties, required, additionalProperties: false } });
      workflowTools.set(tool, operation);
    }
    ({ tool: connectTool } = await $.tool.register({ name: 'statewright_connect', isDeferred: false,
      description: 'Connect to Statewright and open its native workspace. If a workflow name is supplied, start it after connecting. The human completes native sign-in.',
      inputSchema: { type: 'object', properties: { workflow: { type: 'string', description: 'Optional exact workflow name requested by the user', maxLength: 200 } }, additionalProperties: false } }));
    await restore($);
    redraw($);
    return next(e);
  });
  on('classic.SessionStart', async ($, e, next) => { await restore($); redraw($); return next(e); });
  on('classic.PostModelSwitch', async ($, e, next) => { view.baseRequest = null; redraw($); return next(e); });
  on('session.end', async ($, e, next) => { invalidate(view); view = fresh(''); return next(e); });
  on('turn.start', async ($, e, next) => { view.fallback = null; return next(e); });
  on('turn.complete', async ($, e, next) => {
    if (view.fallback?.turnId === e.turnId) { view.fallback = null; redraw($); }
    return next(e);
  });
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e);
    await restore($);
    const v = await current($);
    v.baseRequest = { model: e.model, effort: e.effort ?? null };
    v.routeError = '';
    if (v.busy && !v.interactive) { const pending = v.pending; pending?.start(); await pending?.promise; }
    if (await current($) !== v) return yield* blockedStep(e, 'Statewright: the conversation changed. Retry in the current chat.');
    if (!v.requiresEnforcement && !v.native?.state) return yield* showModelRequest($, v, e, next);
    const snapshot = v.native;
    const generation = v.generation, control = v.control;
    if (!v.connected || v.busy || v.actionBusy || !snapshot || await v.control?.snapshot() !== snapshot)
      return yield* stopRoute(v, e, 'Statewright: refresh the workflow in /statewright before continuing, or turn it Off.');
    let route;
    try { route = claudeRoute(snapshot.state); }
    catch (error) { return yield* stopRoute(v, e, `Statewright: ${error.message}. Update its route or turn Statewright Off.`); }
    if (next.signal?.aborted || await current($) !== v || v.native !== snapshot ||
        v.generation !== generation || v.control !== control || v.actionBusy || v.busy || !v.connected)
      return yield* stopRoute(v, e, 'Statewright: the workflow changed before dispatch. Retry in the current state.');
    if (!route) return yield* showModelRequest($, v, e, next);
    const previous = v.routes.at(-1);
    if (previous?.status === 'mismatch' && previous.run_id === (snapshot.state.run_id ?? null) &&
        previous.state === snapshot.state.state && previous.requested_model === route.requested_model)
      return yield* stopRoute(v, e, 'Statewright: the provider answered with a different model. Update the workflow route or turn Statewright Off before another request.');
    // At most one explicitly identified pre-response Fable credit-gate fallback.
    // No exceptions, partial streams, generic missing usage or refusals replay.
    const permitsFallback = async () => fallbackPermitted(await $.settings.read(), await $.env.get('CLAUDE_CODE_NO_MODEL_FALLBACK'));
    const stillCurrent = () => view === v && !next.signal?.aborted &&
      v.native === snapshot && v.generation === generation && v.control === control && !v.actionBusy && !v.busy && v.connected;
    if (v.fallback?.turnId === e.turnId && v.fallback.runId === snapshot.state.run_id && v.fallback.generation === generation && route.model === v.fallback.from && await permitsFallback())
      route = { ...route, model: 'claude-opus-5-5', fallback_from: route.model, fallback_reason: v.fallback.reason };
    const attempts = [], probe = { creditGate: false, semantic: false };
    const record = async (result, failed = false) => {
      const last = { ...routeReceipt(e, route, result), ...(failed ? { failure: 'native_request_failed' } : {}) };
      const receipt = { ...last, workflow: snapshot.state.workflow, run_id: snapshot.state.run_id ?? null,
        state: snapshot.state.state, revision: snapshot.revision, ...(attempts.length ? { attempts: [...attempts, last] } : {}) };
      if (await current($) !== v) return;
      v.routes = [...v.routes, receipt].slice(-64);
      if (failed) v.routeError = 'The native model request failed. Retry to continue, or open /statewright.';
      try { await $.store.set(`model-routes:${v.conversation}`, v.routes); } catch { /* Never replay for receipt storage. */ }
      redraw($);
      if (receipt.status !== 'observed') $.ui.log(`Statewright model routing: ${receipt.status}; requested ${receipt.native_model}, observed ${receipt.observed_model ?? 'unavailable'}.`);
    };
    // The final predicate is synchronous in this generator, after every await.
    // An async helper returning true leaves a microtask window for Off/cancel.
    if (await current($) !== v || !stillCurrent()) return yield* stopRoute(v, e, 'Statewright: the workflow changed before dispatch. Retry in the current state.');
    let result;
    try {
      result = yield* showModelRequest($, v, routeEvent(e, route), next, probe, Boolean(route.fallback_from));
      const fallback = fableFallback(route, result, probe);
      if (fallback && await permitsFallback() && await current($) === v && stillCurrent()) {
        attempts.push(routeReceipt(e, route, result));
        v.fallback = { turnId: e.turnId, runId: snapshot.state.run_id, generation, from: route.model, reason: fallback.fallback_reason };
        $.ui.log('Statewright: Fable requires usage credits. Continuing this turn on Opus at the same effort.');
        route = fallback;
        result = yield* showModelRequest($, v, routeEvent(e, route), next, undefined, true);
      }
    } catch (error) { await record(null, true); throw error; }
    await record(result);
    return result;
  }).catch(async function* ($, e, next) {
    if (next.called) return; // Never replay a partially or fully dispatched stream.
    return yield* stopRoute(view, e, 'Statewright could not prepare the model route. Open /statewright to refresh or turn it Off.');
  });
  on('command.run', { command: 'statewright' }, async ($, e) => {
    const v = await current($);
    const args = (e.args ?? '').trim().toLowerCase();
    if (args === 'configure') {
      const generation = v.appearanceGeneration;
      // Native commands queue until idle: release this handler before opening
      // the built-in configuration dialog, and never carry it into a resume.
      $.clock.after(0, async () => {
        if (await current($) !== v || v.appearanceGeneration !== generation) return;
        try { await $.command.run({ command: 'plugin', args: 'configure statewright@statewright' }); }
        catch { await $.ui.log('Could not open Statewright preferences. Use /plugin configure statewright@statewright.'); }
      });
      return { text: 'Opening Statewright preferences…' };
    }
    if (args) {
      const match = /^powerline(?:\s+(on|off|default))?$/.exec(args);
      if (!match) return { text: 'Use /statewright to open the workspace, /statewright configure for saved preferences, or /statewright powerline on|off|default.' };
      if (match[1]) v.powerlineOverride = match[1] === 'default' ? null : match[1] === 'on';
      redraw($);
      const enabled = v.powerlineOverride ?? (options.powerline === true);
      return { text: `Powerline: ${enabled ? 'on' : 'off'}${v.powerlineOverride === null ? ' (saved default)' : ' for this session only'}. Saved preference unchanged. Desktop uses > separators.\n/statewright powerline on|off|default` };
    }
    await openPane($);
    if (!v.connected && !v.busy) await schedule($, v, false);
    return {};
  });
  on('prompt.context', async ($, e, next) => {
    const result = await next(e);
    return { ...result, blocks: [...result.blocks, { name: 'statewright-connection',
      text: `For Statewright, use this plugin’s statewright_connect, statewright_get_state, statewright_load_workflow, statewright_transition and statewright_deactivate tools. Do not search local files or run shell login commands. Statewright’s tool checks do not replace Claude’s own permissions. Native main-conversation requests use local workflow model equivalents, separately from the remote gateway's advisory model_routing flag. Inspect client_model_routing.last_request for provider evidence; a selected route alone is not proof. ${view.native?.state ? JSON.stringify(view.native.state) : 'No verified active workflow yet.'}` }] };
  });
  // Host-stamped origin admits only our scoped control calls. A genuine human
  // can authorize these controls for this view's lifetime through tool.check,
  // the supported permission extension. Never retry a refused native call or
  // confuse this grant with ordinary-tool or workflow-decision approval.
  // Separate handlers are essential: ordinary-tool checks call pre_tool, whose
  // nested MCP permission check must not be skipped as this handler's re-entry.
  on('tool.check', { tool: /^mcp__plugin[:_]statewright[:_]statewright__/ }, async ($, e, next) => {
    if (gatewayTool(e.tool)) {
      if (!own($, next) && !catalogTool(e.tool, e.input))
        return { decision: 'deny', reason: 'Use the Statewright workspace tools for this conversation.' };
      const frame = permissionFrames.get(argumentKey(e.input));
      const native = await next(e), v = await current($);
      if (native.decision === 'deny') return native;
      if (own($, next) && frame && (frame.v !== v || frame.generation !== v.generation || frame.consentEpoch !== v.consentEpoch ||
          (e.tool_use_id && frame.invocation && frame.invocation !== e.tool_use_id)))
        return { decision: 'deny', reason: 'This Statewright action was superseded. Read the current workflow before continuing.' };
      // A registered facade has no native implementation. Carry its permission
      // requirement to the exact real MCP invocation.
      let required = native;
      if (own($, next) && e.tool_use_id && frame?.v === v && frame.generation === v.generation &&
          frame.permission?.decision === 'ask' && (!frame.invocation || frame.invocation === e.tool_use_id)) {
        frame.invocation = e.tool_use_id;
        if (native.decision === 'allow') required = { ...frame.permission, decision: 'ask' };
      }
      const scoped = () => own($, next) && typeof e.tool_use_id === 'string' && !e.agentId &&
        e.tool.endsWith(`__${NATIVE_CONTROL_TOOL}`) && frame?.v === v && frame.generation === v.generation && frame.consentEpoch === v.consentEpoch &&
        (!frame.invocation || frame.invocation === e.tool_use_id) &&
        e.input?.context?.conversation_id === v.conversation && v.connected && !next.signal?.aborted;
      // Explicit ask rules/hooks and administrator ceilings keep their native
      // path, even after our session grant. Denials were already returned above.
      // A saved gateway ALLOW is not an ask constraint: a newly registered
      // facade can still require consent at this exact invocation after reload.
      if (required.decision !== 'ask' || !scoped() || e.ceiling || native.ceiling ||
          (native.decision === 'ask' && (native.rule || native.hook)) ||
          (frame.permission?.decision === 'ask' && (frame.permission.rule || frame.permission.hook)) || frame.permission?.ceiling)
        return required;
      frame.invocation = e.tool_use_id;
      if (!v.controlConsent) {
        if (v.controlQuestion) return { decision: 'deny', reason: 'A Statewright permission question is already waiting for your answer.' };
        const question = { generation: v.generation, epoch: v.consentEpoch, invocation: null };
        v.controlQuestion = question;
        let answer;
        try {
          answer = await $.ui.ask(CONTROL_QUESTION, { header: 'Statewright', options: CONTROL_OPTIONS });
        } catch { /* Dismissal, cancellation and headless hosts grant nothing. */ }
        finally { if (v.controlQuestion === question) v.controlQuestion = null; }
        if (await current($) !== v || !scoped()) return { decision: 'deny', reason: 'The Statewright request changed while awaiting your answer.' };
        if (answer !== 'Allow this session') return { decision: 'deny', reason: 'Statewright workflow controls were not approved. No action was sent.' };
        v.controlConsent = true;
      }
      return { decision: 'allow', reason: 'You approved Statewright workflow controls for this session.' };
    }
    return next(e);
  }).catch(() => ({ decision: 'deny', reason: 'Statewright could not verify this control request. Refresh its connection.' }));
  on('tool.check', { tool: /^(?!mcp__plugin[:_]statewright[:_]statewright__)/ }, async ($, e, next) => {
    if (await isControlQuestion($, e, next, e.input)) return next(e);
    if (e.tool === connectTool || workflowTools.has(e.tool)) return next(e);
    const verdict = await executionFor($).check(null, e, next);
    if (verdict?.decision === 'deny') reportDiagnostic($, await current($), 'permission_refused', 'pre_tool', 'control');
    return verdict;
  }).catch(async ($, e, next) => next.error?.kind === 're-entry' && await isControlQuestion($, e, next, e.input)
    ? next(e) : { decision: 'deny', reason: 'Statewright could not verify this tool request. Refresh its connection.' });
  on('tool.call', async ($, e, next) => {
    if (await isControlQuestion($, e, next, flatArgs(e))) return next(e);
    if (gatewayTool(e.tool)) return own($, next) || catalogCall(e) ? next(e)
      : { deny: 'Use the Statewright workspace tools for this conversation.' };
    if (workflowTools.has(e.tool)) {
      const v = await current($);
      const permission = await $.tool.check({ tool: e.tool, input: flatArgs(e) });
      if (permission.decision === 'deny') return { deny: permission.reason || 'Claude does not permit this Statewright action.' };
      if (!v.connected && !v.busy) await schedule($, v, false);
      if (v.busy && !v.interactive) { const pending = v.pending; pending?.start(); await pending?.promise; }
      if (await current($) !== v) return { deny: 'The conversation changed. Request Statewright again here.' };
      try { const result = await workflowAction($, workflowTools.get(e.tool), flatArgs(e), undefined, permission);
        return { result: JSON.stringify({ ...result, client_model_routing: routingView(v) }) }; }
      catch (error) { await openPane($, false); return { result: JSON.stringify({ status: 'action_needed', message: error.message }) }; }
    }
    if (!connectTool || e.tool !== connectTool) return executionFor($).call(null, e, next);
    const v = await current($);
    if (e.workflow !== undefined && !validName(e.workflow)) return { deny: 'Provide a valid workflow name.' };
    if (v.prompting) return { result: JSON.stringify({ status: 'awaiting_confirmation',
      message: 'The Statewright connection question is waiting for your answer. Do not start another login.', executionAvailable: false }) };
    // Check native saved authentication, not this view's initial boolean. Join
    // startup's read without waiting for a deferred timer or a browser login.
    if (!v.connected && !v.busy) await schedule($, v, false);
    if (v.busy && !v.interactive) {
      const pending = v.pending;
      pending?.start();
      await pending?.promise;
    }
    if (await current($) !== v) return { result: JSON.stringify({ status: 'cancelled',
      message: 'The conversation changed. Request Statewright again here.', executionAvailable: false }) };
    if (e.workflow && (!v.connected || v.names.includes(e.workflow))) {
      v.selected = e.workflow;
      v.page = Math.max(0, Math.floor(v.names.indexOf(v.selected) / PAGE_SIZE));
    }
    const placement = await openPane($);
    if (v.manual && !v.busy && !v.prompted) {
      v.prompted = true;
      v.prompting = true;
      const epoch = v.epoch;
      // Tool-opened panes may not be placed on narrow terminals. Native Ask
      // works independently of pane placement and waits for a real person.
      let answer;
      try { answer = await $.ui.ask('Statewright would like to connect. Open sign-in in your browser?',
        { header: 'Statewright', options: ['Connect', 'Not now'] }); } catch { /* Dismissed/headless: no consent. */ }
      finally { v.prompting = false; }
      if (!await live($, v, epoch)) return { result: JSON.stringify({ status: 'cancelled',
        message: 'The connection request changed. Open /statewright to continue.', executionAvailable: false }) };
      if (answer === 'Connect') await schedule($, v, true);
    }
    if (e.workflow && v.connected && executionReadiness(v.native, true).available && (!v.native?.state || v.native.state.is_final)) {
      const permission = await $.tool.check({ tool: e.tool, input: flatArgs(e) });
      if (permission.decision === 'deny') return { deny: permission.reason || 'Claude does not permit this Statewright action.' };
      try { await workflowAction($, 'load_workflow', { name: e.workflow }, undefined, permission); } catch { /* Pane shows the exact recovery action. */ }
    }
    const ready = executionReadiness(v.native, true);
    const loadFailed = Boolean(e.workflow && v.controlError);
    const status = loadFailed ? 'action_needed' : v.busy ? 'sign_in_in_progress' : v.connected ? v.native?.state ? 'workflow_active' : 'connected'
      : v.manual ? 'connection_required' : 'connection_error';
    return { result: JSON.stringify({ status,
      message: loadFailed ? v.controlError : v.busy ? 'Statewright sign-in is in progress. Wait for the user to finish; do not start another login.'
        : v.connected ? v.native?.state ? 'Workflow loaded. Follow its current state and declared transitions.' : 'Choose a workflow and Start when you’re ready.' : v.manual ? 'Sign-in is needed. Open /statewright and choose Connect when you’re ready.'
        : v.error || v.notice || 'Open /statewright to retry the connection.',
      paneVisible: placement?.isPlaced === true,
      workflows: v.connected ? v.names : [], selected: v.selected || null, executionAvailable: v.connected && ready.available,
      state: v.connected ? v.native?.state ?? null : null,
      capabilities: v.connected ? v.native?.capabilities ?? null : null,
      client_model_routing: routingView(v),
      executionUnavailableReason: v.controlError || ready.reason }) };
  }).catch(async ($, e, next) => next.called || (next.error?.kind === 're-entry' && await isControlQuestion($, e, next, flatArgs(e)))
    ? next(e) : { deny: 'Statewright could not handle this request. Open /statewright to retry.' });
  on('mcp.call', async ($, e, next) => {
    const catalog = gatewayServer(e.server) && ((e.tool === 'statewright_list_workflows' && emptyArgs(e.args)) ||
      (e.tool === NATIVE_CONNECT_TOOL && own($, next)));
    if (gatewayServer(e.server) && !catalog && !own($, next))
      return { deny: 'Use the Statewright workspace tools for this conversation.' };
    const v = catalog && own($, next) ? await current($) : null, epoch = v?.epoch;
    try { return await next(e); }
    catch (error) {
      // Preserve the finite cause before the existing middleware fallback turns
      // every native exception into "Statewright control is unavailable".
      if (v?.busy && await live($, v, epoch)) v.catalogFailure = { epoch, ...connectionFailure('catalog', error) };
      if (gatewayServer(e.server) && e.tool === NATIVE_CONTROL_TOOL && own($, next)) {
        const frame = permissionFrames.get(argumentKey(e.args));
        if (frame) frame.failure = controlFailure(error);
      }
      throw error;
    }
  })
    .catch(($, e, next) => gatewayServer(e.server) ? { deny: 'Statewright control is unavailable.' } : next(e));
  on('classic.PostToolUse', async ($, e, next) => { await executionFor($).observe(null, e, false); return next(e); });
  on('classic.PostToolUseFailure', async ($, e, next) => {
    await executionFor($).observe(null, e, true);
    if (['Bash', 'Shell', 'shell_command', 'exec_command'].includes(e.tool_name))
      reportDiagnostic($, await current($), 'command_failed', 'command');
    return next(e);
  });
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e), v = await current($);
    if (result?.block || v.routeError || !v.requiresEnforcement || v.native?.state?.pending_approval) return result;
    const decision = outcome(await nativeRequest($, 'stop', {}));
    return decision.decision === 'block' ? { ...result, block: decision.reason } : result;
  }).catch(() => ({ block: 'Statewright could not confirm workflow completion. Read its state or turn it Off.' }));
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      const v = await current($);
      if (!v.handoff || e.origin?.kind !== 'plugin') v.paneOpen = false;
    }
    return next(e);
  });
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await current($), { Box, Text, Button, Client, Select } = $.ui.resolve(e), rest = await next(e);
    const selectedModel = await $.session.model();
    if (await current($) !== v) return rest;
    const columns = e.props?.bodyColumns ?? 80;
    if (e.surface === 'desktop') {
      const p = statusPresentation({ ...v, selectedModel }, { surface: 'desktop' });
      const chip = (key, label, color = ARBITER_PURPLE, brand = false, control) => Box({ key,
        borderStyle: brand ? 'single' : 'round', borderColor: color,
        height: 1, paddingY: 0, alignItems: 'center',
        backgroundColor: STATE_BACKGROUND, paddingX: 1, children: [control ?? Text({ color, bold: brand, children: [label] })] });
      // Navigation is deliberately separate from the pane's consumed action
      // revisions: opening/focusing it neither connects nor grants consent.
      const revision = v.desktopNavigationRevision, color = p.attention ? '#FFD580' : ARBITER_PURPLE;
      const statusControl = v.desktopStatusClientFailed
        ? Select({ key: 'status-sidebar-fallback', label: p.status,
          options: [{ value: 'sidebar', label: 'Show Statewright sidebar' }], onSelect: async value => {
            if (value === 'sidebar' && await current($) === v && revision === v.desktopNavigationRevision)
              await openPane($, true, { view: v, revision });
          } })
        : Client({ key: 'status-sidebar', module: './desktop-action.js', props: {
          action: 'show-sidebar', label: p.status, color,
          conversation: v.conversation, revision,
        } });
      return Box({ flexDirection: 'column', children: [
        Box({ key: 'arbiter-status', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 1, children: [
          chip('arbiter-label', 'arbiter', ARBITER_ACCENT),
          chip('arbiter-brand', 'statewright.ai ∞', ARBITER_PURPLE, true),
          chip('desktop-state', p.status, color, false, statusControl),
          ...(p.model ? [chip('desktop-model', p.model, '#DAD1EC')] : []),
          ...(p.tail ? [Text({ color: ARBITER_ACCENT, children: [p.tail.trim()] })] : []),
        ] }),
        ...(rest ? [rest] : []),
      ] });
    }
    const p = statusPresentation({ ...v, selectedModel }, { surface: e.surface, powerline: v.powerlineOverride ?? (options.powerline === true), compact: columns < 55, columns });
    const narrow = p.compact;
    const brand = narrow ? 'sw∞' : 'statewright.ai ∞';
    // One native Text row owns truncation, so narrow panes do not wrap into a
    // second status line. A decision/error stays ahead of the optional events.
    const segments = p.powerline ? [
      ...(!narrow ? [Text({ key: 'arbiter-label', bold: true, color: '#171321', backgroundColor: ARBITER_ACCENT, children: [' arbiter '] }),
        Text({ color: ARBITER_ACCENT, backgroundColor: ARBITER_PURPLE, children: [''] })] : []),
      Text({ bold: true, color: '#171321', backgroundColor: ARBITER_PURPLE, children: [` ${brand} `] }),
      Text({ color: ARBITER_PURPLE, backgroundColor: STATE_BACKGROUND, children: [''] }),
      Text({ bold: true, color: p.attention ? '#FFD580' : '#FFFFFF', backgroundColor: STATE_BACKGROUND, children: [` ${p.status} `] }),
      Text({ color: STATE_BACKGROUND, children: [''] }),
    ] : [
      ...(!narrow ? [Text({ key: 'arbiter-label', bold: true, color: ARBITER_ACCENT, children: ['arbiter > '] })] : []),
      Text({ bold: true, color: ARBITER_PURPLE, children: [`${brand}${narrow ? '>' : ' >'} ${p.status}`] }),
    ];
    return Box({ flexDirection: 'column', children: [
      Box({ key: 'arbiter-status', height: 1, flexDirection: 'row', children: [
        Text({ wrap: 'truncate-end', children: [
          ...segments,
          ...(p.model ? [Text({ color: ARBITER_PURPLE,
            children: [`${p.powerline ? ' ' : ' > '}${p.model}${p.tail ? p.powerline ? ' ' : ' >' : ''}`] })] : []),
          ...(!p.model && p.tail && !p.powerline ? [Text({ color: ARBITER_PURPLE, children: [' >'] })] : []),
          ...(p.tail ? [Text({ color: '#8BD5E8', children: [p.tail] })] : []),
        ] }),
      ] }),
      ...(v.busy && v.notice ? [Text({ children: [v.notice] })] : []),
      ...(v.busy ? [Button({ key: 'cancel-connect', label: 'Cancel connection', plain: true, onPress: () => cancel($, v) })] : []),
      ...(rest ? [rest] : []),
    ] });
  });
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const v = await current($), { Box, Text, Button, Select, Svg, Client } = $.ui.resolve(e);
    const desktop = e.surface === 'desktop';
    // Client buttons survive the Desktop focus redraw that drops native Button
    // handles (#99211). Their messages still have to match the current view.
    const desktopKey = desktop ? desktopViewKey(v) : null;
    if (desktopKey && v.desktopKey !== desktopKey) {
      v.desktopKey = desktopKey; v.desktopRevision = (v.desktopRevision ?? 0) + 1;
    }
    if (desktop) v.desktopActions = new Map();
    const appearanceGeneration = v.appearanceGeneration;
    const text = value => Text({ children: [value] });
    const button = (key, label, hotkey, action) => {
      if (!desktop) return Button({ key, label, hotkey, plain: true, onPress: action });
      v.desktopActions.set(key, action);
      if (v.desktopClientFailed) {
        const revision = v.desktopRevision, choice = `${key}-${revision}`;
        return Select({ key: `action-${choice}`, label,
          options: [{ value: choice, label }], onSelect: async value => {
            if (value === choice) await desktopAction($, v.conversation, revision, key);
          } });
      }
      return Client({ key: `action-${key}`, module: './desktop-action.js', props: {
        action: key, label, primary: ['connect', 'start', 'review'].includes(key),
        conversation: v.conversation, revision: v.desktopRevision,
      } });
    };
    const rows = [desktop ? Text({ bold: true, color: ARBITER_PURPLE, children: [desktopTitle(v)] })
      : text(v.connected ? 'Connected to Statewright' : v.connectionIssue === 'auto_review_unavailable' ? 'Check Claude permissions' : 'Statewright would like to connect')];
    if (desktop && !v.connected && !v.busy && !['auto_review_unavailable', 'tool_unavailable'].includes(v.connectionIssue)) rows.push(text('Connect to see your workflows and use them in this conversation.'));
    if (desktop && v.busy) rows.push(text(v.notice || 'Checking Statewright. You can keep this conversation open.'));
    // Keep the action above explanatory copy, even in a short/narrow pane.
    if (v.busy) rows.push(button('cancel-connect', 'Cancel connection', 'c', () => cancel($, v)));
    else if (!v.connected) {
      if (v.connectionIssue !== 'tool_unavailable') rows.push(button('connect', v.connectionIssue === 'auto_review_unavailable' ? 'Connect' : v.error ? 'Try connecting again' : 'Connect', 'c', () => schedule($, v)));
    }
    else {
    if (v.native?.state) {
        const nodes = progressNodes(v.native);
        rows.push(text(v.native.state.workflow), text(`Current: ${nodes.current}`));
        if (nodes.pending) rows.push(text('This step needs your decision.'));
        const shownRevision = v.native.revision;
        const action = (operation, input = {}) => async () => {
          const generation = v.generation;
          try { await workflowAction($, operation, input, shownRevision); }
          catch (error) { if (await current($) === v && v.generation === generation) { v.controlError = error.message; redraw($); } }
        };
        if (nodes.pending && !v.actionBusy) rows.push(button('review', 'Review this step', 'a', action('request_approval')));
        if (!nodes.pending && !nodes.final && !v.actionBusy) {
          const transitions = v.native.state.transitions.slice(0, 64);
          if (transitions.length) rows.push(Select({ key: 'next-state', label: 'Next step',
            options: transitions.map(t => ({ value: t.event, label: `${eventSymbol(t.event)} → ${t.target}` })),
            onSelect: event => { if (transitions.some(t => t.event === event)) return action('transition', { event })(); },
          }));
        }
        rows.push(button('off', 'Turn Statewright Off', 'o', action('deactivate')));
        if (v.actionBusy) rows.push(text(nodes.pending ? 'Waiting for your review…' : 'Updating workflow…'));
        rows.push(button('toggle-map', v.showGraph ? 'Hide workflow map' : 'Show workflow map', 'm', async () => {
          if (await current($) !== v) return;
          v.showGraph = !v.showGraph; redraw($);
        }));
        if (v.showGraph && desktop) {
          rows.push(Box({ key: 'workflow-map', flexDirection: 'column', children: [
            Svg(desktopGraph(v.native, v.journey)),
            Text({ dimColor: true, children: ['Solid: observed path · Dashed: possible next steps or unobserved gaps.'] }),
          ] }));
        } else if (v.showGraph) rows.push(Box({ key: 'workflow-map', flexDirection: 'column', children: [
          ...graphRows(v.native, v.journey).map(row => Text({
            color: row.kind === 'current' ? ARBITER_PURPLE : undefined,
            bold: row.kind === 'current', dimColor: row.kind === 'past' || row.kind === 'edge',
            wrap: 'truncate-end', children: [row.text],
          })),
          ...(nodes.next.length ? [Text({ dimColor: true, wrap: 'wrap',
            children: ['Possible next steps; their requirements still apply.'] })] : []),
        ] }));
      }
      if (v.names.length) {
        const epoch = v.epoch;
        const pages = Math.ceil(v.names.length / PAGE_SIZE);
        const names = v.names.slice(v.page * PAGE_SIZE, (v.page + 1) * PAGE_SIZE);
        const go = page => async () => {
          if (!await live($, v, epoch) || v.busy || page < 0 || page >= pages) return;
          v.page = page; redraw($);
        };
        rows.push(Select({ key: 'workflow', label: 'Choose a workflow',
        ...(names.includes(v.selected) ? { value: v.selected } : {}),
        options: names.map(name => ({ value: name, label: name })), onSelect: async name => {
          if (!await live($, v, epoch) || v.busy || !names.includes(name)) return;
          v.selected = name; redraw($);
        } }), text(`Selected: ${v.selected}`));
        if (pages > 1) {
          rows.push(text(`Page ${v.page + 1} of ${pages} · ${v.names.length} workflows`));
          if (v.page > 0) rows.push(button('previous-page', 'Previous workflows', 'p', go(v.page - 1)));
          if (v.page + 1 < pages) rows.push(button('next-page', 'More workflows', 'n', go(v.page + 1)));
        }
      }
      else rows.push(text('No workflows are available in this account.'));
      const readiness = executionReadiness(v.native, true);
      if ((!v.native?.state || v.native.state.is_final) && v.selected && readiness.available && !v.actionBusy) {
        const shownRevision = v.native.revision, name = v.selected;
        rows.push(button('start', 'Start workflow', 's', async () => {
          try { await workflowAction($, 'load_workflow', { name }, shownRevision); }
          catch (error) { v.controlError = error.message; redraw($); }
        }));
      }
      if (!readiness.available) rows.push(text(readiness.reason));
      if (v.native?.state) {
        const routing = routingView(v);
        if (routing.error) rows.push(text(routing.error));
        else if (routing.configured) rows.push(text(`Workflow requests: ${routing.configured.model}${routing.configured.effort ? ` / ${routing.configured.effort}` : ''}. Off restores your selected model.`));
        else rows.push(text('Claude keeps its selected model; this state has no active model route.'));
        rows.push(text('Effort is the requested setting, not a measure of internal reasoning.'));
        if (routing.last_request) rows.push(text(`Last routed response: ${routing.last_request.observed_model ?? 'unavailable'} (${routing.last_request.status}).`));
      }
      if (!v.actionBusy && !v.runningTool) rows.push(button('refresh', 'Refresh workflows', 'r', () => schedule($, v)));
      if (v.controlError) rows.push(text(v.controlError));
    }
    if (!desktop && v.manual && !v.busy && !nativeSignIn) rows.push(button('copy-login', 'Copy SSH sign-in command', 's', async () => {
      if (await current($) !== v || v.busy || nativeSignIn) return;
      try {
        const result = await $.ui.copy({ text: LOGIN_COMMAND });
        if (await current($) !== v) return;
        v.notice = result.isCopied ? 'Copied. Run it in a separate terminal, then reconnect here.' : 'Clipboard unavailable. The sign-in command is below.';
      } catch { if (await current($) === v) v.notice = 'Clipboard unavailable. The sign-in command is below.'; }
      redraw($);
    }));
    if (e.surface === 'terminal') rows.push(Select({ key: 'powerline-session', label: 'Powerline · this session',
      value: v.powerlineOverride === null ? 'default' : v.powerlineOverride ? 'on' : 'off',
      options: [{ value: 'default', label: `Use saved default (${options.powerline === true ? 'On' : 'Off'})` },
        { value: 'on', label: 'On for this session' }, { value: 'off', label: 'Off for this session' }],
      onSelect: async value => {
        if (await current($) !== v || v.appearanceGeneration !== appearanceGeneration || !['default', 'on', 'off'].includes(value)) return;
        v.powerlineOverride = value === 'default' ? null : value === 'on'; redraw($);
      },
    }));
    rows.push(button('close', 'Back to conversation', 'b', async () => {
      if (await current($) !== v) return; v.paneOpen = false; await $.ui.close({ id: PANE });
    }));
    if (v.error) rows.push(text(v.error));
    if (v.connectionIssue === 'tool_unavailable') rows.push(text(desktop
      ? 'Quit and reopen Claude Desktop, then resume this conversation. If the tools are still missing, update Statewright.'
      : 'Restart Claude Code, then resume this conversation. If the tools are still missing, update Statewright.'));
    if (v.notice) rows.push(text(v.notice));
    if (!desktop && v.manual && !v.busy) rows.push(text('Sign in from another computer — in a separate terminal:'), text(LOGIN_COMMAND),
      text('Open the link there, paste the full callback URL into that terminal, then reconnect here.'));
    if (!v.connected && !v.busy && !v.error) rows.push(text('Choose Connect to sign in and see your workflows.'));
    return Box({ flexDirection: 'column', rowGap: desktop ? 1 : 0, ...(desktop ? { paddingX: 1 } : {}), children: rows });
  });
}
