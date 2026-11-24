import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  currentCatalogAgeWarnings,
  findCurrentModelMentions,
  loadCurrentAllowlist,
  loadCurrentModels,
  scanCurrentModels,
} from './check-current-models.mjs';
import {repoRootFromScript} from './check-retired-models.mjs';

const catalog = loadCurrentModels();

test('catalog records the latest ID and official overview for each verified line', () => {
  assert.deepEqual(
    catalog.models.map(({provider, line, id}) => `${provider}/${line}:${id}`),
    [
      'anthropic/fable:claude-fable-5-2',
      'anthropic/opus:claude-opus-5-5',
      'anthropic/sonnet:claude-sonnet-5-5',
      'anthropic/haiku:claude-haiku-5-5',
      'anthropic/mythos:claude-mythos-5-2',
      'openai/astra:gpt-6.2-astra',
      'openai/sol:gpt-6.2-sol',
      'openai/terra:gpt-6.1-terra',
      'openai/luna:gpt-6-luna',
    ],
  );
  assert.ok(catalog.models.every((model) => model.date_checked === '2026-11-24'));
  assert.equal(
    catalog.models.find((model) => model.line === 'mythos').source,
    'https://platform.claude.com/docs/en/models/mythos-5-2/overview',
  );
});

test('older vendor, Bedrock, dated, and legacy-order IDs fail within their lines', () => {
  const text = [
    'anthropic/claude-opus-4-6',
    'anthropic.claude-opus-4-6-v1:0',
    'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'claude-3-5-haiku-20241022',
    'openai-codex/gpt-5.6-sol',
    'openai.gpt-6-astra',
    'gpt-6.2-sol-20261120',
  ].join('\n');
  const findings = findCurrentModelMentions(text, catalog);
  assert.deepEqual(findings.map(({line, id, latest}) => `${line}:${id}->${latest}`), [
    '1:claude-opus-4-6->claude-opus-5-5',
    '2:claude-opus-4-6->claude-opus-5-5',
    '3:claude-sonnet-4-5-20250929->claude-sonnet-5-5',
    '4:claude-3-5-haiku-20241022->claude-haiku-5-5',
    '5:gpt-5.6-sol->gpt-6.2-sol',
    '6:gpt-6-astra->gpt-6.2-astra',
    '7:gpt-6.2-sol-20261120->gpt-6.2-sol',
  ]);
});

test('current IDs and longer unrelated tokens are not reported', () => {
  const text = [
    'claude-fable-5-2 claude-opus-5-5 claude-sonnet-5-5 claude-haiku-5-5 claude-mythos-5-2',
    'anthropic.claude-opus-5-5-v1:0 openai-codex/gpt-6.2-sol gpt-6.1-terra gpt-6-luna',
    'xxgpt-5.6-solxx gpt-6.2-solar claude-opus-4-6-extra',
  ].join('\n');
  assert.deepEqual(findCurrentModelMentions(text, catalog), []);
});

test('an unqualified GPT version fails closed without inventing a replacement line', () => {
  const findings = findCurrentModelMentions('openai-codex/gpt-5.4 and GPT-5.5; gpt-6.2-sol is current.', catalog);
  assert.deepEqual(findings.map(({id, model_line, latest}) => [id, model_line, latest]), [
    ['gpt-5.4', 'unqualified', null],
    ['GPT-5.5', 'unqualified', null],
  ]);
  const scanned = scanCurrentModels('.', {
    catalog,
    allowlist: {entries: []},
    entries: ['docs/guides/example.md'],
    read: () => Buffer.from('openai-codex/gpt-5.4'),
  });
  assert.match(scanned[0].issue, /choose an exact ID from scripts\/current-models\.json/);
});

test('allowlist applies to only its named public path and ID, with its reason', () => {
  const old = 'A recorded route used gpt-5.6-sol.\n';
  const findings = scanCurrentModels('.', {
    catalog,
    allowlist: {entries: [{path: 'docs/research/result.md', id: 'gpt-5.6-sol', reason: 'Recorded 2026 experiment result'}]},
    entries: ['docs/research/result.md', 'docs/guides/live.md', 'plugins/codex/tests/route.test.mjs'],
    read: () => Buffer.from(old),
  });
  assert.deepEqual(findings.map(({path, severity}) => `${path}:${severity}`), [
    'docs/research/result.md:warn',
    'docs/guides/live.md:fail',
  ]);
  assert.match(findings[0].issue, /Recorded 2026 experiment result/);
  assert.match(findings[1].issue, /use gpt-6.2-sol/);
});

test('allowlist entries require a specific public path and a reason', () => {
  const root = mkdtempSync(join(tmpdir(), 'current-model-allowlist-'));
  const path = join(root, 'allowlist.json');
  try {
    writeFileSync(path, JSON.stringify({entries: [{path: 'README.md', id: 'gpt-5.4', reason: ''}]}));
    assert.throws(() => loadCurrentAllowlist(path), /needs a public path, id, and reason/);
    writeFileSync(path, JSON.stringify({entries: [{path: 'docs/research/result.md', id: 'gpt-5.4', reason: 'Historical result'}]}));
    assert.equal(loadCurrentAllowlist(path).entries.length, 1);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('catalog age warns only after 14 full UTC calendar days', () => {
  const models = [
    {...catalog.models[0], date_checked: '2026-11-10'},
    {...catalog.models[1], date_checked: '2026-11-09'},
  ];
  const warnings = currentCatalogAgeWarnings({models}, {now: new Date('2026-11-24T23:59:59Z')});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].issue, /anthropic\/opus was checked 15 days ago/);
  assert.equal(warnings[0].severity, 'warn');
});

test('standalone checker fails on an older public ID in a tracked temp file', () => {
  const source = repoRootFromScript();
  const root = mkdtempSync(join(tmpdir(), 'current-models-negative-'));
  try {
    writeFileSync(join(root, 'README.md'), 'Use anthropic.claude-opus-4-6-v1:0.\n');
    execFileSync('git', ['init', '-q'], {cwd: root});
    execFileSync('git', ['add', 'README.md'], {cwd: root});
    const result = spawnSync(process.execPath, [join(source, 'scripts/check-current-models.mjs'), root], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /README\.md:1: \[fail\].*use claude-opus-5-5/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
