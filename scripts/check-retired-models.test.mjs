import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  findModelIdMatches,
  formatFinding,
  isPublicSurfacePath,
  loadCatalog,
  repoRootFromScript,
  scanTrackedFiles,
  shouldSkipPath,
  upcomingRetirementWarnings,
} from './check-retired-models.mjs';

const catalog = loadCatalog();
const byId = Object.fromEntries(catalog.models.map((model) => [model.id, model]));

test('catalog includes the verified Anthropic retirement and only retired or deprecated statuses', () => {
  assert.equal(byId['claude-sonnet-4-20250514'].status, 'retired');
  assert.equal(byId['claude-sonnet-4-20250514'].retired_on, '2026-06-15');
  assert.equal(byId['claude-sonnet-4-20250514'].replacement, 'claude-sonnet-5-5');
  assert.ok(catalog.models.every((model) => model.status === 'retired' || model.status === 'deprecated'));
  assert.equal(catalog.sources.find((source) => source.provider === 'anthropic').url, 'https://platform.claude.com/docs/en/about-claude/model-deprecations');
  assert.equal(catalog.sources.find((source) => source.provider === 'openai').url, 'https://developers.openai.com/api/docs/deprecations');
  assert.ok(catalog.models.every((model) => model.source === (model.provider === 'anthropic'
    ? 'https://platform.claude.com/docs/en/about-claude/model-deprecations'
    : 'https://developers.openai.com/api/docs/deprecations')));
});

test('whole-token matching rejects prefix collisions with current ids', () => {
  const models = [byId['gpt-5'], byId['gpt-4'], byId['claude-sonnet-4-20250514']];
  assert.equal(findModelIdMatches('use gpt-5.6-sol or gpt-4.1 or claude-sonnet-5-5', models).length, 0);
  assert.equal(findModelIdMatches('xxgpt-5xx', models).length, 0);
  const hits = findModelIdMatches('model gpt-5, then gpt-4.', models);
  assert.deepEqual(hits.map((hit) => `${hit.line}:${hit.id}`), ['1:gpt-4', '1:gpt-5']);
  assert.equal(findModelIdMatches('assert.match(text, /openai\\/gpt-5\\.6-terra/)', models).length, 0);
});

test('a fixture with a retired id fails with file:line:id and a replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'retired-models-'));
  const relative = 'examples/sample.json';
  writeFileSync(join(root, 'sample.json'), '{"default_model":"claude-sonnet-4-20250514"}\n');
  const findings = scanTrackedFiles(root, {
    catalog,
    entries: [relative.replace('examples/', '')],
    read: () => Buffer.from('{"default_model":"claude-sonnet-4-20250514"}\n'),
  });
  // Use a stable path name in the entries list.
  const named = scanTrackedFiles(root, {
    catalog,
    entries: [relative],
    read: () => Buffer.from('{"default_model":"claude-sonnet-4-20250514"}\n'),
  });
  assert.equal(named.length, 1);
  assert.equal(named[0].path, relative);
  assert.equal(named[0].line, 1);
  assert.equal(named[0].id, 'claude-sonnet-4-20250514');
  assert.match(formatFinding(named[0]), /examples\/sample\.json:1:claude-sonnet-4-20250514 \(retired; replace with claude-sonnet-5-5\)/);
  assert.equal(findings.length, 1);
});

test('a current id that shares a prefix of a retired id does not fail', () => {
  const findings = scanTrackedFiles('.', {
    catalog,
    entries: ['docs/example.md'],
    read: () => Buffer.from('default_model is claude-sonnet-5-5 or gpt-5.6-sol or gpt-4.1\n'),
  });
  assert.deepEqual(findings, []);
});

test('the catalog and the check fixtures are skipped', () => {
  assert.equal(shouldSkipPath('scripts/retired-model-ids.json'), true);
  assert.equal(shouldSkipPath('scripts/fixtures/pre-release-outdatedness/retired-id.txt'), true);
  assert.equal(shouldSkipPath('README.md'), false);
});

test('vendor copies are skipped and tests are warnings, not public-surface failures', () => {
  assert.equal(shouldSkipPath('docs/outreach/demo/public/vendor/vue.esm-browser.prod.js'), true);
  assert.equal(isPublicSurfacePath('README.md'), true);
  assert.equal(isPublicSurfacePath('docs/guides/pi-plugin.md'), true);
  assert.equal(isPublicSurfacePath('plugins/codex/docs/model-routing.md'), true);
  assert.equal(isPublicSurfacePath('plugins/codex/workflows/agentic-engineering-default-v1.json'), true);
  assert.equal(isPublicSurfacePath('plugins/pi/src/index.ts'), false);
  assert.equal(isPublicSurfacePath('crates/mcp-gateway/src/usage.rs'), false);
  assert.equal(isPublicSurfacePath('plugins/codex/tests/statewright-codex-tui.test.mjs'), false);
});

test('model ID matching is case-insensitive and still respects token boundaries', () => {
  const models = [byId['gpt-5'], byId['claude-sonnet-4-20250514'], byId.o1];
  const hits = findModelIdMatches('Default is GPT-5, or Claude-Sonnet-4-20250514.', models);
  assert.deepEqual(hits.map((hit) => `${hit.line}:${hit.id}`), ['1:claude-sonnet-4-20250514', '1:gpt-5']);
  assert.equal(findModelIdMatches('use GPT-5.6-sol or Claude-Sonnet-5-5', models).length, 0);
  assert.equal(findModelIdMatches('milestone codes C1, D1, O1, and P1', [byId.o1]).length, 0);
  assert.equal(findModelIdMatches('the o1 model is retired', [byId.o1]).length, 1);
});

test('the checker exits 0 against the real worktree', () => {
  const root = repoRootFromScript();
  const failures = scanTrackedFiles(root).filter((finding) => isPublicSurfacePath(finding.path));
  assert.deepEqual(failures, []);
  const result = spawnSync(process.execPath, [join(root, 'scripts/check-retired-models.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('upcoming retirement warnings use a fixed clock and a 30-day inclusive window', () => {
  const now = new Date(Date.UTC(2026, 10, 15)); // 2026-11-15
  const catalog = {
    models: [
      {id: 'retire-today', provider: 'openai', status: 'deprecated', retired_on: '2026-11-15', source: 'https://example.com', date_checked: '2026-11-18'},
      {id: 'retire-in-30', provider: 'openai', status: 'deprecated', retired_on: '2026-12-15', source: 'https://example.com', date_checked: '2026-11-18'},
      {id: 'retire-in-31', provider: 'openai', status: 'deprecated', retired_on: '2026-12-16', source: 'https://example.com', date_checked: '2026-11-18'},
      {id: 'already-past', provider: 'openai', status: 'deprecated', retired_on: '2026-11-14', source: 'https://example.com', date_checked: '2026-11-18'},
      {id: 'already-retired', provider: 'anthropic', status: 'retired', retired_on: '2026-12-01', source: 'https://example.com', date_checked: '2026-11-18'},
      {id: 'no-date', provider: 'anthropic', status: 'deprecated', retired_on: null, source: 'https://example.com', date_checked: '2026-11-18'},
    ],
  };
  const warnings = upcomingRetirementWarnings(catalog, {now});
  assert.deepEqual(warnings.map((item) => item.id), ['retire-today', 'retire-in-30']);
  assert.ok(warnings.every((item) => item.severity === 'warn'));
  assert.match(warnings[0].issue, /retires today \(2026-11-15\)/);
  assert.match(warnings[1].issue, /retires in 30 days \(2026-12-15\)/);
});
