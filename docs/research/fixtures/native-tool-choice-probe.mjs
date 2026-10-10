// Opt-in native protocol characterization, NOT a live model or UI test.
// A credential-free loopback provider returns only a fixture tool call and text.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

if (process.env.STATEWRIGHT_NATIVE_TOOL_CHOICE_PROBE !== '1') {
  console.log('SKIP: set STATEWRIGHT_NATIVE_TOOL_CHOICE_PROBE=1 to run the isolated native probe.');
  process.exit(0);
}
const binary = process.env.STATEWRIGHT_DESKTOP_CODEX_BIN
  ?? '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const probeRoot = await mkdtemp(join(tmpdir(), 'statewright-tool-choice-native-'));
const probeHome = join(probeRoot, 'codex-home');
await mkdir(probeHome);
// Explicit allowlist: never copy auth, Statewright bindings, or parent writer IDs.
const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: probeRoot,
  CODEX_HOME: probeHome, TMPDIR: tmpdir(), LANG: 'en_US.UTF-8' };
const binaryHash = createHash('sha256').update(await readFile(binary)).digest('hex');
const version = spawnSync(binary, ['--version'], { env, encoding: 'utf8', timeout: 10000 });
assert.equal(version.status, 0);
const frames = [], pending = new Map(), cases = [];
let child, activeCase, sequence = 0, stderr = '', fatal;
const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || req.url !== '/v1/responses' || !activeCase) {
      res.writeHead(404).end(); return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const current = activeCase;
    const nth = current.requests.length;
    assert.ok(nth < 4, 'Bounded fixture request limit exceeded');
    current.requests.push({ toolChoice: body.tool_choice ?? null,
      toolCount: body.tools?.length ?? 0, keys: Object.keys(body) });
    const finish = () => {
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      const emit = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
      emit({type: 'response.created', response: {id: `response_${current.name}_${nth}`}});
      const item = nth < (current.name === 'steer_none' ? 2 : 1)
        ? {type: 'function_call', id: `fc_${current.name}_${nth}`, call_id: `call_${current.name}_${nth}`,
          name: 'fixture_ping', arguments: '{}'}
        : {type: 'message', id: `msg_${current.name}`, role: 'assistant', phase: 'final_answer',
          content: [{type: 'output_text', text: 'FIXTURE_DONE', annotations: []}]};
      emit({type: 'response.output_item.added', output_index: 0, item});
      emit({type: 'response.output_item.done', output_index: 0, item});
      emit({type: 'response.completed', response: {id: `response_${current.name}_${nth}`,
        status: 'completed', output: [item], usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}}});
      res.end();
    };
    // Hold the initial provider response until steering is acknowledged.
    if (current.name === 'steer_none' && nth === 0) current.release = finish;
    else finish();
  } catch (error) { fatal = error; res.writeHead(500).end(); }
});
async function waitFor(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fatal) throw fatal;
    const value = check(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timeout: ${label}; native stderr: ${stderr.slice(-1500)}`);
}
function send(frame) { child.stdin.write(`${JSON.stringify(frame)}\n`); }
async function rpc(method, params) {
  const id = ++sequence;
  send({id, method, params});
  const frame = await waitFor(() => pending.get(id), method);
  pending.delete(id);
  if (frame.error) throw new Error(`${method}: ${JSON.stringify(frame.error)}`);
  return frame.result;
}
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const config = [
    'model_provider="fixture"', 'model="gpt-5.6-terra"',
    `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`,
    'web_search="disabled"', 'features.api_key_model_discovery=false',
    'features.responses_websockets=false', 'features.responses_websockets_v2=false',
    'features.shell_snapshot=false', 'features.hooks=false', 'features.apps=false',
    'features.multi_agent=false', 'features.code_mode=false',
  ];
  child = spawn(binary, [...config.flatMap(v => ['-c', v]), 'app-server'],
    {cwd: probeRoot, env, stdio: ['pipe', 'pipe', 'pipe']});
  child.on('error', error => {fatal = error;});
  child.on('exit', (code, signal) => {fatal ??= new Error(`Native exited: ${code}/${signal}`);});
  child.stderr.on('data', chunk => {stderr = (stderr + chunk).slice(-8000);});
  createInterface({input: child.stdout}).on('line', line => {
    try {
      const frame = JSON.parse(line); frames.push(frame);
      if (frame.method === 'item/tool/call') {
        assert.equal(frame.params.tool, 'fixture_ping');
        activeCase.toolDispatches++;
        send({id: frame.id, result: {success: true, contentItems: [{type: 'inputText', text: 'fixture pong'}]}});
      } else if (frame.id !== undefined && !frame.method) pending.set(frame.id, frame);
      else if (frame.id !== undefined && frame.method) {
        fatal = new Error(`Unexpected server request: ${frame.method}`);
      }
    } catch (error) {fatal = error;}
  });
  await rpc('initialize', {clientInfo: {name: 'statewright-tool-choice-probe', version: '1'},
    capabilities: {experimentalApi: true}});
  send({method: 'initialized'});
  for (const name of ['control', 'start_none', 'steer_none']) {
    activeCase = {name, requests: [], toolDispatches: 0};
    const thread = await rpc('thread/start', {cwd: probeRoot, ephemeral: true,
      modelProvider: 'fixture', model: 'gpt-5.6-terra', approvalPolicy: 'never', sandbox: 'read-only',
      baseInstructions: 'Isolated deterministic protocol fixture.',
      dynamicTools: [{type: 'function', name: 'fixture_ping', description: 'Harmless fixture ping.',
        inputSchema: {type: 'object', properties: {}, additionalProperties: false}}]});
    const threadId = thread.thread.id;
    const turn = await rpc('turn/start', {threadId,
      input: [{type: 'text', text: 'Run the harmless fixture ping then finish.'}],
      ...(name === 'start_none' ? {tool_choice: 'none', toolChoice: 'none'} : {})});
    if (name === 'steer_none') {
      await waitFor(() => activeCase.release, 'held provider request');
      await rpc('turn/steer', {threadId, expectedTurnId: turn.turn.id,
        input: [{type: 'text', text: 'Finish now without tools.'}], tool_choice: 'none', toolChoice: 'none'});
      activeCase.release(); delete activeCase.release;
    }
    const terminal = await waitFor(() => frames.find(f => f.method === 'turn/completed'
      && f.params.turn.id === turn.turn.id), 'turn terminal');
    activeCase.terminalStatus = terminal.params.turn.status;
    assert.equal(activeCase.terminalStatus, 'completed');
    assert.equal(activeCase.requests.length, name === 'steer_none' ? 3 : 2);
    assert.equal(activeCase.toolDispatches, name === 'steer_none' ? 2 : 1);
    for (const request of activeCase.requests) assert.equal(request.toolChoice, 'auto');
    cases.push(activeCase);
  }
  console.log(JSON.stringify({schema: 'statewright/native-tool-choice-probe/v1',
    createdAt: new Date().toISOString(),
    outcome: 'unsupported_fields_do_not_enforce_no_tools', binary, binaryHash,
    version: version.stdout.trim(), provider: 'loopback_fixture', realInference: false,
    liveDesktop: false, probeRoot, cases}, null, 2));
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await exited; clearTimeout(timer);
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  // Retain the credential-free disposable directory as diagnostic evidence.
}
