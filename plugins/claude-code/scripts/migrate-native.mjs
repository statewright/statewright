#!/usr/bin/env node
// Explicit migration of manually installed hooks. Never changes credentials,
// permission rules, plugin enablement, or MCP settings. Close Claude first.
import { readFile, lstat, open, rename, unlink } from 'node:fs/promises';
import { resolve, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const actions = { UserPromptSubmit: 'user-prompt', PermissionRequest: 'permission-request',
  PreToolUse: 'pre-tool', PostToolUse: 'post-tool', Stop: 'stop', SessionEnd: 'session-end' };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function commands(roots, event) {
  const result = new Set();
  for (const root of roots) {
    const script = join(resolve(root), 'hook.sh');
    for (const path of [script, `"${script}"`, `'${script}'`])
      if (actions[event]) result.add(`bash ${path} ${actions[event]}`);
    if (event === 'PostToolUse') {
      const capture = join(resolve(root), 'capture.sh');
      for (const path of [capture, `"${capture}"`, `'${capture}'`]) result.add(`bash ${path}`);
    }
  }
  return result;
}
export function migrationPlan(before, roots) {
  if (!object(before) || (before.hooks !== undefined && !object(before.hooks)))
    throw new Error('Unrecognized Claude settings shape; nothing was changed.');
  if (!Array.isArray(roots) || !roots.length || roots.some(r => typeof r !== 'string' || !isAbsolute(r) || /[\r\n\0]/.test(r)))
    throw new Error('Provide explicit absolute legacy plugin roots.');
  const after = structuredClone(before), removed = [], unresolved = [];
  for (const [event, groups] of Object.entries(after.hooks ?? {})) {
    if (!Array.isArray(groups)) throw new Error('Unrecognized hook group; nothing was changed.');
    const allowed = commands(roots, event);
    after.hooks[event] = groups.flatMap((group, groupIndex) => {
      if (!object(group) || !Array.isArray(group.hooks)) throw new Error('Unrecognized hook entry; nothing was changed.');
      const hooks = group.hooks.filter((hook, hookIndex) => {
        if (hook?.type !== 'command' || typeof hook.command !== 'string') return true;
        if (allowed.has(hook.command)) { removed.push({ event, groupIndex, hookIndex }); return false; }
        if (/statewright/i.test(hook.command)) unresolved.push({ event, groupIndex, hookIndex });
        return true;
      });
      return hooks.length || !group.hooks.length ? [{ ...group, hooks }] : [];
    });
  }
  return { after, removed, unresolved };
}
export async function migrateFile(settingsPath, roots, { apply = false } = {}) {
  const path = resolve(settingsPath), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Settings must be a regular file, not a symlink.');
  const bytes = await readFile(path), plan = migrationPlan(JSON.parse(bytes), roots);
  const result = { settings: path, removed: plan.removed, unresolved: plan.unresolved, applied: false };
  if (!apply || !plan.removed.length) return result;
  if (plan.unresolved.length) throw new Error('Unrecognized Statewright hooks remain. Review the dry-run before applying.');
  const lockPath = `${path}.statewright-migration.lock`, lock = await open(lockPath, 'wx', 0o600);
  const id = randomUUID(), backup = `${path}.statewright-${id}.backup`, temp = `${path}.statewright-${id}.tmp`;
  let tempCreated = false;
  async function unchanged() {
    const current = await lstat(path);
    if (current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs || !(await readFile(path)).equals(bytes))
      throw new Error('Settings changed during migration; nothing was replaced.');
  }
  try {
    await unchanged();
    const saved = await open(backup, 'wx', 0o600);
    try { await saved.writeFile(bytes); await saved.sync(); } finally { await saved.close(); }
    const output = await open(temp, 'wx', 0o600); tempCreated = true;
    try { await output.writeFile(JSON.stringify(plan.after, null, 2) + '\n'); await output.sync(); } finally { await output.close(); }
    await unchanged();
    await rename(temp, path); tempCreated = false;
    return { ...result, applied: true, backup };
  } finally {
    if (tempCreated) await unlink(temp);
    await lock.close(); await unlink(lockPath);
  }
}
export async function main(args) {
  let settings, apply = false;
  const roots = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--settings') settings = args[++i];
    else if (args[i] === '--legacy-root') roots.push(args[++i]);
    else if (args[i] === '--apply') apply = true;
    else throw new Error('Usage: migrate-native.mjs --settings PATH --legacy-root PATH [--legacy-root PATH] [--apply]');
  }
  if (!settings) throw new Error('Supply --settings and each --legacy-root path.');
  return migrateFile(settings, roots, { apply });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(value => console.log(JSON.stringify(value, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
