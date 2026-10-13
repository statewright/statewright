import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, lstat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrationPlan, migrateFile } from '../scripts/migrate-native.mjs';

const legacy = '/workspace/statewright/plugins/claude-code';
const old = { permissions: { allow: ['Read'], deny: ['Bash(rm *)'] }, enabledPlugins: { 'statewright@statewright': true, unrelated: true },
  hooks: { PreToolUse: [{ matcher: '*', timeout: 4, hooks: [
    { type: 'command', command: `bash ${legacy}/hook.sh pre-tool` }, { type: 'command', command: 'echo other' }] }],
    Stop: [{ matcher: '*', hooks: [{ type: 'command', command: `bash "${legacy}/hook.sh" stop` }] }] } };

test('migration removes only exact owned hooks and preserves unrelated controls and order', () => {
  const before = structuredClone(old), p = migrationPlan(before, [legacy]);
  assert.deepEqual(before, old); assert.equal(p.removed.length, 2); assert.deepEqual(p.unresolved, []);
  assert.deepEqual(p.after.permissions, old.permissions); assert.deepEqual(p.after.enabledPlugins, old.enabledPlugins);
  assert.deepEqual(p.after.hooks.PreToolUse, [{ matcher: '*', timeout: 4, hooks: [{ type: 'command', command: 'echo other' }] }]);
  assert.deepEqual(p.after.hooks.Stop, []); assert.equal(migrationPlan(p.after, [legacy]).removed.length, 0);
});
test('custom syntax and foreign roots are unresolved, not guessed from a substring', () => {
  for (const command of [`bash ${legacy}/hook.sh pre-tool; echo x`, 'bash /other/statewright/hook.sh pre-tool', 'my-statewright-helper']) {
    const data = structuredClone(old); data.hooks.PreToolUse[0].hooks.push({ type: 'command', command });
    const p = migrationPlan(data, [legacy]); assert.equal(p.unresolved.length, 1);
    assert.equal(p.after.hooks.PreToolUse[0].hooks.at(-1).command, command);
  }
  assert.throws(() => migrationPlan(old, ['relative']), /absolute/);
  assert.throws(() => migrationPlan({ hooks: { PreToolUse: {} } }, [legacy]), /Unrecognized/);
});
test('dry run is byte-preserving; apply retains private backup and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sw-native-migration-')), path = join(root, 'settings.json');
  const bytes = JSON.stringify(old);
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    assert.equal((await migrateFile(path, [legacy])).applied, false); assert.equal(await readFile(path, 'utf8'), bytes);
    const done = await migrateFile(path, [legacy], { apply: true });
    assert.equal(done.applied, true); assert.equal(await readFile(done.backup, 'utf8'), bytes);
    assert.equal((await lstat(done.backup)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), migrationPlan(old, [legacy]).after);
    assert.equal((await migrateFile(path, [legacy], { apply: true })).applied, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('unresolved hooks, symlinks and another migration lock prevent replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sw-native-migration-')), path = join(root, 'settings.json');
  try {
    const data = structuredClone(old); data.hooks.Stop[0].hooks.push({ type: 'command', command: 'other-statewright' });
    await writeFile(path, JSON.stringify(data));
    await assert.rejects(migrateFile(path, [legacy], { apply: true }), /Unrecognized Statewright/);
    assert.deepEqual(JSON.parse(await readFile(path)), data);
    await writeFile(path, JSON.stringify(old)); await symlink(path, join(root, 'linked.json'));
    await assert.rejects(migrateFile(join(root, 'linked.json'), [legacy], { apply: true }), /regular file/);
    await writeFile(`${path}.statewright-migration.lock`, 'another owner');
    await assert.rejects(migrateFile(path, [legacy], { apply: true }), { code: 'EEXIST' });
    assert.equal(await readFile(`${path}.statewright-migration.lock`, 'utf8'), 'another owner');
    assert.deepEqual(JSON.parse(await readFile(path)), old);
  } finally { await rm(root, { recursive: true, force: true }); }
});
