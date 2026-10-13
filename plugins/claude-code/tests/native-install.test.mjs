import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('consumer installer invokes native plugin manager without configuration or auth overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sw-native-install-'));
  const binary = join(root, 'claude'), receipt = join(root, 'args.jsonl');
  try {
    await writeFile(binary, `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.SW_TEST_ARGS, JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o700 });
    const env = { ...process.env, STATEWRIGHT_CLAUDE_BIN: binary, SW_TEST_ARGS: receipt };
    const install = fileURLToPath(new URL('../install.sh', import.meta.url));
    for (const args of [[], ['--update']]) assert.equal(spawnSync('/bin/bash', [install, ...args], { env }).status, 0);
    assert.deepEqual((await readFile(receipt, 'utf8')).trim().split('\n').map(x => JSON.parse(x)), [
      ['plugin', 'marketplace', 'add', 'statewright/statewright'],
      ['plugin', 'install', 'statewright@statewright'], ['plugin', 'update', 'statewright@statewright'],
    ]);
    const before = await readFile(receipt, 'utf8');
    assert.equal(spawnSync('/bin/bash', [install, '--unknown'], { env }).status, 2);
    assert.equal(spawnSync('/bin/bash', [install, '--help'], { env }).status, 0);
    const setup = spawnSync('/bin/bash', [fileURLToPath(new URL('../setup.sh', import.meta.url))], { env, encoding: 'utf8' });
    assert.equal(setup.status, 1); assert.match(setup.stderr, /no longer installs hooks/);
    assert.equal(await readFile(receipt, 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
