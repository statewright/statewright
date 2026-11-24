import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CURRENT_MCP_PROTOCOL_VERSION,
  collectMcpVersionMentions,
  extractClapLongFlags,
  formatSweepReport,
  latestTag,
  listedPluginVersions,
  sweepHasFailures,
} from './pre-release-outdatedness.mjs';
import {findModelIdMatches, loadCatalog} from './check-retired-models.mjs';

test('MCP mentions of older specs are warnings, not hard fails', () => {
  const findings = collectMcpVersionMentions(
    'docs/adr/example.md',
    `See the ${CURRENT_MCP_PROTOCOL_VERSION} path and also https://modelcontextprotocol.io/specification/2025-06-18/schema\n`,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'warn');
  assert.equal(findings[0].line, 1);
  assert.match(findings[0].issue, /2025-06-18/);
});

test('clap long flags come from explicit names and field names', () => {
  const flags = extractClapLongFlags(`
    #[arg(short, long, default_value = "x")]
    ollama_url: String,
    #[arg(long = "json-events")]
    json_events: bool,
    #[arg(short)]
    task: String,
  `);
  assert.deepEqual(flags, ['json-events', 'ollama-url']);
});

test('plugin version pins compare numerically against git tags', () => {
  assert.equal(latestTag(['claude-v0.3.8', 'claude-v0.4.0', 'codex-v0.4.0'], 'claude-v'), '0.4.0');
  const mentions = listedPluginVersions('The native Claude 0.3.8 plugin and Codex 0.3.8 adapter.');
  assert.deepEqual(mentions.map((item) => `${item.name}@${item.version}`), ['claude@0.3.8', 'codex@0.3.8']);
  assert.equal(listedPluginVersions('In Claude Code 2.1.295 or newer, run the plugin commands.').length, 0);
});

test('sweep report is a hard fail only when a model id or fail-severity finding is present', () => {
  const warnOnly = formatSweepReport({
    modelFindings: [],
    docsFindings: [{category: 'mcp-spec', path: 'docs/adr/x.md', line: 1, issue: 'old spec', severity: 'warn'}],
    dependencyFindings: [],
  });
  assert.match(warnOnly, /old spec/);
  const failed = formatSweepReport({
    modelFindings: [{category: 'model-id', path: 'README.md', line: 160, issue: 'README.md:160:claude-sonnet-4-20250514 (retired; replace with claude-sonnet-5-5)', severity: 'fail'}],
    docsFindings: [],
    dependencyFindings: [],
  });
  assert.match(failed, /README\.md:160:claude-sonnet-4-20250514/);
  assert.equal(sweepHasFailures({
    modelFindings: [{severity: 'fail'}],
    docsFindings: [],
    dependencyFindings: [],
  }), true);
  assert.equal(sweepHasFailures({
    modelFindings: [{severity: 'warn'}],
    docsFindings: [{severity: 'warn'}],
    dependencyFindings: [],
  }), false);
  const catalog = loadCatalog();
  assert.equal(findModelIdMatches('claude-sonnet-5-5', catalog.models).length, 0);
});

test('the combined sweep reports and fails on a non-current public model', () => {
  const currentModelFindings = [{
    category: 'latest-model',
    path: 'README.md',
    line: 161,
    issue: 'claude-haiku-4-5-20251001 is not latest; use claude-haiku-5-5',
    severity: 'fail',
  }];
  const result = {currentModelFindings};
  assert.equal(sweepHasFailures(result), true);
  assert.match(formatSweepReport(result), /Models that are not latest in their line: 1/);
  assert.match(formatSweepReport(result), /README\.md:161/);
});
