#!/usr/bin/env node
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tmpRoot = process.env.XTERN_DEMO_TMP ?? '/tmp';
const prefix = process.env.XTERN_DEMO_PREFIX ?? 'xtern-ai';
const sessionName = process.env.XTERN_DEMO_SESSION ?? 'xtern-hack-the-planet';
const claudeCmd = process.env.CLAUDE_CMD ?? 'claude';
const codexCmd = process.env.CODEX_CMD ?? 'codex';
const bindHost = process.env.XTERN_DEMO_HOST ?? '0.0.0.0';
const dirtyPort = Number(process.env.XTERN_DEMO_PORT ?? 4317);
const goldPort = Number(process.env.XTERN_DEMO_GOLD_PORT ?? 4318);
const cliCommand = process.argv[2];
const prompt = `Use Statewright.
First deactivate any active Statewright workflow.
Then activate the xtern-sdlc workflow. If xtern-sdlc is not available, create it from workflows/xtern-sdlc.json and load it.
After xtern-sdlc is active, read spec.md first.
Run npm test, explain the failures, then make the backend ETL match the spec.
After tests pass, improve the Vue dashboard while preserving the API contract.`;

const state = {
  checkout: null,
  message: 'dialing indyhackers.org...',
  busy: false,
  lastKey: '',
  lastKeyAt: 0,
};

if (!cliCommand) {
  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
}

async function main() {
  if (cliCommand) return await runCliCommand();

  await refreshDefaultCheckout();
  draw();

  process.stdin.on('keypress', async (str, key) => {
    if (state.busy) return;
    if (key.ctrl && key.name === 'c') return quit();
    if (isDebounced(str, key)) return;
    if (key.name === 'q' || str === 'q') return quit();

    state.busy = true;
    try {
      if (str === 'n') return await promptCreate();
      if (str === 'c') return await promptSelect();
      if (str === 'r') return await runAction('reset starter', () => resetCheckout(checkoutPath()));
      if (str === 'g') return await runAction('apply gold', () => applyVersion(checkoutPath(), 'gold'));
      if (str === 't') return await launchTests();
      if (str === 's') return await launchServer();
      if (str === 'v') return await launchGoldServer();
      if (str === 'a') return await launchAgent('claude');
      if (str === 'x') return await launchAgent('codex');
      if (str === 'w') return await launchWarRoom();
      if (str === 'l') return await promptClone();
      if (str === '?') return help();
    } catch (error) {
      state.message = `ERR ${error.message}`;
      draw();
    } finally {
      state.busy = false;
    }
  });
}

async function runCliCommand() {
  const name = safeName(process.argv[3] ?? 'demo');

  if (cliCommand === 'create' || cliCommand === 'new') {
    const force = process.argv.includes('--force');
    await createCheckout(name, { force });
    console.log(checkoutPath(name));
    return;
  }

  if (cliCommand === 'reset') {
    await resetCheckout(checkoutPath(name));
    console.log(`reset ${checkoutPath(name)}`);
    return;
  }

  if (cliCommand === 'gold') {
    await applyVersion(checkoutPath(name), 'gold');
    console.log(`gold ${checkoutPath(name)}`);
    return;
  }

  if (cliCommand === 'path') {
    console.log(checkoutPath(name));
    return;
  }

  if (cliCommand === 'preview') {
    state.checkout = name;
    state.message = 'preview mode // no carrier required';
    draw({ clear: false });
    return;
  }

  console.error('Usage: demo-tui.mjs [create NAME --force | reset NAME | gold NAME | path NAME | preview NAME]');
  process.exit(2);
}

async function refreshDefaultCheckout() {
  const checkouts = await listCheckouts();
  if (state.checkout) return;
  state.checkout = checkouts.includes('demo') ? 'demo' : 'demo';
  if (!existsSync(checkoutPath('demo'))) {
    await writeDirtyCheckout('demo', { force: true });
    state.message = 'created dirty default arena: demo';
  }
}

async function promptCreate() {
  const name = await ask('new arena name');
  if (!name) return draw();
  await runAction(`create ${safeName(name)}`, () => createCheckout(name, { force: false }));
}

async function promptClone() {
  const name = await ask('fresh dirty arena name');
  if (!name) return draw();
  await runAction(`overwrite ${safeName(name)}`, () => createCheckout(name, { force: true }));
}

async function promptSelect() {
  const names = await listCheckouts();
  if (!names.length) {
    state.message = 'no arenas yet; press n to create one';
    return draw();
  }

  const answer = await ask(`select arena [${names.join(', ')}]`);
  const name = safeName(answer);
  if (!names.includes(name)) {
    state.message = `no such arena: ${name}`;
    return draw();
  }

  state.checkout = name;
  state.message = `jacked into /tmp/${prefix}-${name}`;
  draw();
}

async function createCheckout(name, { force }) {
  const safe = safeName(name);
  const destination = arenaPath(safe);

  await writeDirtyCheckout(safe, { force });
  state.checkout = safe;
}

async function writeDirtyCheckout(name, { force }) {
  const safe = safeName(name);
  const destination = arenaPath(safe);

  if (existsSync(destination)) {
    if (!force) throw new Error(`${safe} already exists; press l to overwrite`);
    await rm(destination, { recursive: true, force: true });
  }

  await mkdir(destination, { recursive: true });
  await cp(root, destination, {
    recursive: true,
    filter: (source) => {
      const base = basename(source);
      return !['node_modules', '.git', 'playwright-report', 'test-results', '.DS_Store'].includes(base);
    },
  });

  await applyVersion(destination, 'starter');
  return destination;
}

async function resetCheckout(path) {
  await applyVersion(path, 'starter');
}

async function applyVersion(path, version) {
  const result = spawnSync('node', ['scripts/apply-version.mjs', version], {
    cwd: path,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `apply ${version} failed`).trim());
  }
}

async function launchTests() {
  await ensureCheckout();
  tmuxJob('tests', checkoutPath(), bannerCommand('TEST MATRIX', 'npm test; printf "\\n[press enter to close] "; read _'));
  state.message = 'tests launched in full-size tmux window';
  draw();
}

async function launchServer() {
  await ensureCheckout();
  tmuxJob('server', checkoutPath(), bannerCommand(`SERVER ${bindHost}:${dirtyPort}`, serverCommand(dirtyPort)));
  state.message = `server launched on ${bindHost}:${dirtyPort}`;
  draw();
}

async function launchGoldServer() {
  await ensureCheckout();
  const goldArena = `${safeName(state.checkout)}-gold`;
  const goldPath = await writeDirtyCheckout(goldArena, { force: true });
  await applyVersion(goldPath, 'gold');
  tmuxJob('gold', goldPath, bannerCommand(`GOLD SERVER ${bindHost}:${goldPort}`, serverCommand(goldPort), { arena: goldArena, path: goldPath }), { arena: goldArena });
  state.message = `gold server launched on ${bindHost}:${goldPort}`;
  draw();
}

async function launchAgent(agent) {
  await ensureCheckout();
  await resetCheckout(checkoutPath());
  const targetName = safeName(state.checkout);
  const targetPath = checkoutPath();
  const command = agent === 'claude' ? claudeCmd : codexCmd;
  const quotedPrompt = shellQuote(prompt);
  const bootstrap = bannerCommand(
    `HACK THE PLANET // ${agent.toUpperCase()}`,
    `${command} ${quotedPrompt}`,
    { arena: targetName, path: targetPath },
  );

  tmuxJob(agent, targetPath, bootstrap, { arena: targetName });
  state.message = `${agent} launched in selected dirty arena ${targetName}`;
  draw();
}

async function launchWarRoom() {
  await ensureCheckout();
  await resetCheckout(checkoutPath());
  const path = checkoutPath();
  const base = safeName(state.checkout);
  const claudeArena = `${base}-claude`;
  const codexArena = `${base}-codex`;
  const claudePath = await writeDirtyCheckout(claudeArena, { force: true });
  const codexPath = await writeDirtyCheckout(codexArena, { force: true });

  if (process.env.TMUX) {
    tmuxJob('server', path, bannerCommand(`SERVER ${bindHost}:${dirtyPort}`, serverCommand(dirtyPort)), { select: false });
    const goldArena = `${base}-gold`;
    const goldPath = await writeDirtyCheckout(goldArena, { force: true });
    await applyVersion(goldPath, 'gold');
    tmuxJob('gold', goldPath, bannerCommand(`GOLD SERVER ${bindHost}:${goldPort}`, serverCommand(goldPort), { arena: goldArena, path: goldPath }), { select: false, arena: goldArena });
    tmuxJob('claude', claudePath, bannerCommand('CLAUDE // STATEWRIGHT RUN', `${claudeCmd} ${shellQuote(prompt)}`, { arena: claudeArena, path: claudePath }), { select: false, arena: claudeArena });
    tmuxJob('tests', claudePath, bannerCommand('CLAUDE TEST MATRIX', 'npm test; printf "\\n[press enter] "; read _', { arena: claudeArena, path: claudePath }), { select: false, arena: claudeArena });
    tmuxJob('codex', codexPath, bannerCommand('CODEX // STATEWRIGHT RUN', `${codexCmd} ${shellQuote(prompt)}`, { arena: codexArena, path: codexPath }), { select: false, arena: codexArena });
    tmuxJob('tests', codexPath, bannerCommand('CODEX TEST MATRIX', 'npm test; printf "\\n[press enter] "; read _', { arena: codexArena, path: codexPath }), { select: false, arena: codexArena });
    selectTmuxWindow(windowName('claude', claudeArena));
    state.message = `war room opened with dirty ${claudeArena} + ${codexArena}`;
    return draw();
  }

  const bootstrap = [
    `tmux new-session -d -s ${shellQuote(sessionName)} -n ${shellQuote(windowName('server'))} -c ${shellQuote(path)} ${shellQuote(bannerCommand(`SERVER ${bindHost}:${dirtyPort}`, serverCommand(dirtyPort)))}`,
    `tmux new-window -d -t ${shellQuote(sessionName)} -n ${shellQuote(windowName('claude', claudeArena))} -c ${shellQuote(claudePath)} ${shellQuote(bannerCommand('CLAUDE // STATEWRIGHT RUN', `${claudeCmd} ${shellQuote(prompt)}`, { arena: claudeArena, path: claudePath }))}`,
    `tmux new-window -d -t ${shellQuote(sessionName)} -n ${shellQuote(windowName('tests', claudeArena))} -c ${shellQuote(claudePath)} ${shellQuote(bannerCommand('CLAUDE TEST MATRIX', 'npm test; printf "\\n[press enter] "; read _', { arena: claudeArena, path: claudePath }))}`,
    `tmux new-window -d -t ${shellQuote(sessionName)} -n ${shellQuote(windowName('codex', codexArena))} -c ${shellQuote(codexPath)} ${shellQuote(bannerCommand('CODEX // STATEWRIGHT RUN', `${codexCmd} ${shellQuote(prompt)}`, { arena: codexArena, path: codexPath }))}`,
    `tmux new-window -d -t ${shellQuote(sessionName)} -n ${shellQuote(windowName('tests', codexArena))} -c ${shellQuote(codexPath)} ${shellQuote(bannerCommand('CODEX TEST MATRIX', 'npm test; printf "\\n[press enter] "; read _', { arena: codexArena, path: codexPath }))}`,
    `tmux select-window -t ${shellQuote(`${sessionName}:${windowName('claude', claudeArena)}`)}`,
    `tmux attach -t ${shellQuote(sessionName)}`,
  ].join(' && ');

  await runShell(bootstrap);
  state.message = 'returned from war room';
  draw();
}

function tmuxJob(role, cwd, command, { select = true, arena = state.checkout } = {}) {
  const name = windowName(role, arena);

  if (!process.env.TMUX) {
    const full = `tmux new-session -A -s ${shellQuote(sessionName)} -n ${shellQuote(name)} -c ${shellQuote(cwd)} ${shellQuote(command)}`;
    spawn('sh', ['-lc', full], { stdio: 'inherit' });
    return;
  }

  spawnSync('tmux', ['new-window', '-d', '-n', name, '-c', cwd, command], { stdio: 'ignore' });
  if (select) selectTmuxWindow(name);
}

function selectTmuxWindow(name) {
  spawnSync('tmux', ['select-window', '-t', name], { stdio: 'ignore' });
}

function windowName(role, arenaName = state.checkout) {
  const arena = safeName(arenaName ?? 'demo').slice(0, 16);
  return `x-${arena}-${role}`;
}

function bannerCommand(title, command, options = {}) {
  const arena = options.arena ?? state.checkout ?? 'demo';
  const path = options.path ?? checkoutPath();

  return [
    'clear',
    `printf ${shellQuote(`${title}\n`)}`,
    `printf ${shellQuote(`arena: ${arena}\npath: ${path}\n\n`)}`,
    command,
  ].join('; ');
}

function serverCommand(port) {
  return `HOST=${shellQuote(bindHost)} PORT=${port} npm start`;
}

async function ensureCheckout() {
  if (!state.checkout || !existsSync(checkoutPath())) {
    throw new Error('no arena selected; press n to create one');
  }
}

async function listCheckouts() {
  const entries = await readdir(tmpRoot, { withFileTypes: true });
  const names = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(`${prefix}-`)) continue;

    const name = entry.name.slice(prefix.length + 1);
    const packagePath = join(tmpRoot, entry.name, 'package.json');
    if (existsSync(packagePath)) names.push(name);
  }

  return names.sort((a, b) => {
    if (a === 'demo') return -1;
    if (b === 'demo') return 1;
    return a.localeCompare(b);
  });
}

function checkoutPath(name = state.checkout) {
  return arenaPath(name);
}

function arenaPath(name) {
  return join(tmpRoot, `${prefix}-${safeName(name)}`);
}

function safeName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'demo';
}

async function runAction(label, fn) {
  state.busy = true;
  state.message = `${label}...`;
  draw();

  try {
    await fn();
    state.message = `${label}: OK`;
  } catch (error) {
    state.message = `ERR ${error.message}`;
  } finally {
    state.busy = false;
    draw();
  }
}

async function ask(label) {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(`\n\x1b[38;5;121m${label}>\x1b[0m `);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question('', resolve));
  rl.close();

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  return answer;
}

async function runShell(command) {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  await new Promise((resolve) => {
    const child = spawn('sh', ['-lc', command], { stdio: 'inherit' });
    child.on('exit', resolve);
  });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function ansiC(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "'\\''")
    .replaceAll('\n', '\\n');
}

function help() {
  state.message = 'n new | c choose | l overwrite | r reset | g gold | s server | v gold server | t tests | a claude | x codex | w war room | q quit';
  draw();
}

function isDebounced(str, key) {
  const keyName = key.name ?? str ?? '';
  const now = Date.now();
  const repeated = state.lastKey === keyName && now - state.lastKeyAt < 350;
  state.lastKey = keyName;
  state.lastKeyAt = now;
  return repeated;
}

function c(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function dim(text) {
  return c('2', text);
}

function cyan(text) {
  return c('38;5;51', text);
}

function green(text) {
  return c('38;5;121', text);
}

function magenta(text) {
  return c('38;5;201', text);
}

function yellow(text) {
  return c('38;5;228', text);
}

function red(text) {
  return c('38;5;203', text);
}

function bold(text) {
  return c('1', text);
}

function box(title, lines, width = 46, color = cyan) {
  const top = `╔═ ${title} ${'═'.repeat(Math.max(0, width - title.length - 5))}╗`;
  const bottom = `╚${'═'.repeat(width - 2)}╝`;
  const body = lines.map((line) => {
    const visible = stripAnsi(line);
    const clipped = visible.length > width - 4 ? truncateAnsi(line, width - 5) : line;
    const pad = Math.max(0, width - 4 - stripAnsi(clipped).length);
    return `║ ${clipped}${' '.repeat(pad)} ║`;
  });

  return [color(top), ...body.map(color), color(bottom)].join('\n');
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}

function truncateAnsi(value, max) {
  const plain = stripAnsi(value);
  return plain.length > max ? `${plain.slice(0, Math.max(0, max - 1))}…` : value;
}

function columns(left, right, gap = 3) {
  const leftLines = left.split('\n');
  const rightLines = right.split('\n');
  const leftWidth = Math.max(...leftLines.map((line) => stripAnsi(line).length));
  const height = Math.max(leftLines.length, rightLines.length);
  const out = [];

  for (let i = 0; i < height; i += 1) {
    const l = leftLines[i] ?? '';
    const r = rightLines[i] ?? '';
    out.push(`${l}${' '.repeat(Math.max(0, leftWidth - stripAnsi(l).length + gap))}${r}`);
  }

  return out.join('\n');
}

function draw({ clear = true } = {}) {
  const path = state.checkout ? checkoutPath() : 'no arena';
  const tmux = process.env.TMUX ? 'tmux: live' : 'tmux: will attach';
  const art = [
    ' ██╗██╗  ██╗    ██████╗ ██████╗ ███████╗',
    ' ██║██║  ██║   ██╔═══██╗██╔══██╗██╔════╝',
    ' ██║███████║   ██║   ██║██████╔╝███████╗',
    ' ██║██╔══██║   ██║   ██║██╔═══╝ ╚════██║',
    ' ██║██║  ██║██╗╚██████╔╝██║     ███████║',
    ' ╚═╝╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝     ╚══════╝',
  ];

  const tower = [
    `${cyan('COMPANY STATUS')}   ${magenta('GIBSON-ISH TRAINING NODE')}`,
    `${cyan('COMPOSITE PLANTS')} ${dim('................')} ${green('OK')}`,
    `${cyan('EXPLOR. RESEARCH')} ${dim('................')} ${yellow('WATCH')}`,
    `${cyan('GEOLOGIC BUDGETS')} ${dim('................')} ${green('OK')}`,
    `${cyan('GARBAGE')}          ${magenta('> security-events.ndjson')}`,
    `${cyan('MINING DEVELOPMENT')} ${dim('..............')} ${green('OK')}`,
    `${cyan('AIRFREIGHT STATUS')}  ${dim('..............')} ${yellow('PENDING')}`,
  ];

  const hud = box('OPS HUD', [
    `${dim('arena')}  ${bold(state.checkout ?? 'none')}`,
    `${dim('path ')}  ${path}`,
    `${dim('mux  ')}  ${tmux}`,
    `${dim('ai   ')}  claude:${claudeCmd}  codex:${codexCmd}`,
    `${dim('web  ')}  ${bindHost}:${dirtyPort}  gold:${goldPort}`,
    `${dim('mode ')}  dirty starter -> tests -> agent -> gold`,
  ], 66, green);

  const menu = box('DIRECTORY', [
    `${yellow('[n]')} new dirty arena      ${yellow('[c]')} choose arena`,
    `${yellow('[l]')} overwrite arena      ${yellow('[r]')} reset starter`,
    `${yellow('[g]')} apply gold           ${yellow('[t]')} run tests pane`,
    `${yellow('[s]')} server pane          ${yellow('[v]')} gold server`,
    `${yellow('[a]')} Claude pane          ${yellow('[x]')} Codex pane`,
    `${yellow('[w]')} full war room        ${yellow('[?]')} help`,
    `${yellow('[q]')} carrier drop`,
  ], 66, cyan);

  const modem = box('CARRIER', [
    `${green(`CONNECT ${dirtyPort}`)}  ${dim(`${bindHost} incident dashboard`)}`,
    `${yellow(`GOLD ${goldPort}`)}     ${dim('completed reference build')}`,
    `${magenta('ACCESS')}      ${dim('/tmp named arenas')}`,
    `${red('WARNING')}     ${dim('do not download garbage unless it is tests')}`,
    `${cyan('STATUS')}      ${state.message}`,
  ], 66, magenta);

  if (clear) process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(`${green(art.join('\n'))}\n`);
  process.stdout.write(`${yellow('  INDY HACKERS XTERN OPS // HACK THE PLANET*')}\n`);
  process.stdout.write(`  ${dim('*ethically, locally, and mostly with failing unit tests')}\n\n`);
  process.stdout.write(`${columns(hud, box('SYSTEM TOWER', tower, 44, magenta), 3)}\n\n`);
  process.stdout.write(`${columns(menu, modem, 3)}\n`);
}

function quit() {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write('\ncarrier dropped.\n');
  process.exit(0);
}

main().catch((error) => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  console.error(error);
  process.exit(1);
});
