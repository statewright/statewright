import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  findModelIdMatches,
  formatFinding,
  isPublicSurfacePath,
  loadCatalog,
  scanTrackedFiles,
  shouldSkipPath,
} from './check-retired-models.mjs';

const catalog = loadCatalog();
const byId = Object.fromEntries(catalog.models.map((model) => [model.id, model]));

test('catalog includes the verified Anthropic retirement and only retired or deprecated statuses', () => {
  assert.equal(byId['claude-sonnet-4-20250514'].status, 'retired');
  assert.equal(byId['claude-sonnet-4-20250514'].retired_on, '2026-06-15');
  assert.equal(byId['claude-sonnet-4-20250514'].replacement, 'claude-sonnet-5-5');
  assert.ok(catalog.models.every((model) => model.status === 'retired' || model.status === 'deprecated'));
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
