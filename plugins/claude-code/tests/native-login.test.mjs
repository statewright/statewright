import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/native-login.exp', import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'statewright-login-pty-'));
  const receipt = join(root, 'result.json');
  // Only the harmless fake CLI is on this test PATH. Never run OAuth in tests.
  writeFileSync(join(root, 'claude'), `#!${process.execPath}\n` + `
    const fs = require('node:fs');
    fs.writeFileSync(process.env.SW_TEST_RECEIPT, JSON.stringify({
      tty: process.stdin.isTTY, args: process.argv.slice(2), pid: process.pid
    }));
    console.log('DO NOT EXPOSE CALLBACKS');
    if (process.env.SW_TEST_HOLD) setInterval(() => {}, 1000);
    else setTimeout(() => process.exit(Number(process.env.SW_TEST_EXIT)), 150);
  `, { mode: 0o700 });
  return { root, receipt, env: { ...process.env, PATH: root, SW_TEST_RECEIPT: receipt },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
for (const exitCode of [0, 7]) test(`actual OS PTY waits and propagates native exit ${exitCode}`, { skip: process.platform !== 'darwin' }, () => {
  const f = fixture();
  try {
    const result = spawnSync('/usr/bin/expect', [helper], { env: { ...f.env, SW_TEST_EXIT: String(exitCode) }, encoding: 'utf8', timeout: 4000 });
    assert.equal(result.status, exitCode, result.stderr);
    assert.equal(result.stdout, '', 'no OAuth output leaks into the mod');
    const record = JSON.parse(readFileSync(f.receipt));
    assert.equal(record.tty, true);
    assert.deepEqual(record.args, ['mcp', 'login', 'plugin:statewright:statewright']);
  } finally { f.cleanup(); }
});
for (const alias of [false, true]) test(`login skips the legacy managed shim on Desktop PATH; symlink=${alias}`, { skip: process.platform !== 'darwin' }, () => {
  const f = fixture();
  try {
    const shim = join(f.root, '.statewright/bin'); mkdirSync(shim, { recursive: true });
    writeFileSync(join(shim, 'claude'), '#!/bin/sh\nexit 91\n', { mode: 0o700 });
    const first = alias ? join(f.root, 'shim-alias') : shim;
    if (alias) symlinkSync(shim, first);
    const result = spawnSync('/usr/bin/expect', [helper], { env: { ...f.env, HOME: f.root,
      PATH: `${first}:${f.root}`, SW_TEST_EXIT: '0' }, encoding: 'utf8', timeout: 4000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(f.receipt)).tty, true);
    assert.equal(result.stdout, '');
  } finally { f.cleanup(); }
});

test('missing native CLI fails without starting the old shim', { skip: process.platform !== 'darwin' }, () => {
  const f = fixture();
  try {
    const shim = join(f.root, '.statewright/bin'); mkdirSync(shim, { recursive: true });
    writeFileSync(join(shim, 'claude'), '#!/bin/sh\nexit 91\n', { mode: 0o700 });
    const result = spawnSync('/usr/bin/expect', [helper], { env: { ...f.env, HOME: f.root, PATH: shim }, encoding: 'utf8', timeout: 4000 });
    assert.equal(result.status, 127); assert.equal(result.stdout, '');
  } finally { f.cleanup(); }
});

test('terminating the login helper closes its owned terminal and child', { skip: process.platform !== 'darwin' }, async () => {
  const f = fixture();
  const child = spawn('/usr/bin/expect', [helper], { env: { ...f.env, SW_TEST_HOLD: '1' }, stdio: 'pipe' });
  const done = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    let record;
    for (let i = 0; i < 40; i++) {
      try { record = JSON.parse(readFileSync(f.receipt)); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(record, 'fake native process started');
    child.kill('SIGTERM');
    const result = await Promise.race([done, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('helper failed to stop')), 3000); timer.unref();
    })]);
    assert.equal(result.code, 130);
    assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' });
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); f.cleanup(); }
});
