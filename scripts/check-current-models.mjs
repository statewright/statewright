import {execFileSync} from 'node:child_process';
import {lstatSync, readFileSync, readlinkSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  isProbablyBinary,
  isPublicSurfacePath,
  isTokenBoundaryAfter,
  isTokenBoundaryBefore,
  repoRootFromScript,
  utcDay,
} from './check-retired-models.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const defaultCurrentCatalogPath = join(here, 'current-models.json');
export const defaultCurrentAllowlistPath = join(here, 'current-model-allowlist.json');
export const CATALOG_MAX_AGE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const OFFICIAL_SOURCES = Object.freeze({
  anthropic: 'https://platform.claude.com/docs/en/about-claude/models/overview',
  openai: 'https://developers.openai.com/api/docs/models',
});
const MYTHOS_DETAIL_SOURCE = 'https://platform.claude.com/docs/en/models/mythos-5-2/overview';

function parseCheckedDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? null : date.getTime();
}

export function loadCurrentModels(path = defaultCurrentCatalogPath) {
  const catalog = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
    throw new Error('Current model catalog has no models');
  }
  const lines = new Set();
  for (const model of catalog.models) {
    if (!model.provider || !model.line || !model.id || !model.source || !model.date_checked) {
      throw new Error('Current model catalog entry is missing required fields');
    }
    const linkedMythosDetail = model.provider === 'anthropic' && model.line === 'mythos'
      && model.source === MYTHOS_DETAIL_SOURCE;
    if (model.source !== OFFICIAL_SOURCES[model.provider] && !linkedMythosDetail) {
      throw new Error(`Current model source is not the official overview for ${model.provider}`);
    }
    if (parseCheckedDate(model.date_checked) == null) {
      throw new Error(`Invalid date_checked for ${model.provider}/${model.line}`);
    }
    const key = `${model.provider}/${model.line}`;
    if (lines.has(key)) throw new Error(`Duplicate current model line ${key}`);
    lines.add(key);
  }
  return catalog;
}

export function loadCurrentAllowlist(path = defaultCurrentAllowlistPath) {
  const allowlist = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(allowlist.entries)) throw new Error('Current model allowlist needs entries');
  const keys = new Set();
  for (const entry of allowlist.entries) {
    if (typeof entry.path !== 'string' || typeof entry.id !== 'string'
      || typeof entry.reason !== 'string' || !entry.path.trim() || !entry.id.trim()
      || !entry.reason.trim() || !isPublicSurfacePath(entry.path)) {
      throw new Error('Current model allowlist entry needs a public path, id, and reason');
    }
    const key = `${entry.path}\0${entry.id.toLowerCase()}`;
    if (keys.has(key)) throw new Error(`Duplicate current model allowlist entry for ${entry.path}: ${entry.id}`);
    keys.add(key);
  }
  return allowlist;
}

const MODEL_PATTERNS = Object.freeze([
  {
    provider: 'anthropic',
    // Both claude-opus-4-6 and the older claude-3-5-sonnet-<date> order.
    regex: /claude-(?:(fable|opus|sonnet|haiku|mythos)-\d+(?:[-.]\d+)*|\d+(?:[-.]\d+)*-(fable|opus|sonnet|haiku|mythos)(?:-\d+)*)(?:-v\d+:\d+)?/gi,
  },
  {
    provider: 'openai',
    regex: /gpt-\d+(?:[-.]\d+)*-(astra|sol|terra|luna)(?:-\d{8}|-\d{4}-\d{2}-\d{2})?/gi,
  },
  {
    provider: 'openai',
    unqualified: true,
    // A bare GPT version has no verified line in the current overview.
    regex: /gpt-\d+(?:\.\d+)?(?:-\d{8}|-\d{4}-\d{2}-\d{2})?/gi,
  },
]);

function validBoundaryBefore(text, index, provider) {
  if (isTokenBoundaryBefore(text, index)) return true;
  const prefix = text.slice(Math.max(0, index - 32), index);
  return provider === 'anthropic'
    ? /\banthropic\.$/i.test(prefix)
    : /\b(?:openai|openai-codex)\.$/i.test(prefix);
}

/** Find model IDs belonging to a cataloged line, including vendor and Bedrock spellings. */
export function findCurrentModelMentions(text, catalog = loadCurrentModels()) {
  const latestByLine = new Map(catalog.models.map((model) => [`${model.provider}/${model.line}`, model]));
  const findings = [];
  for (const {provider, regex, unqualified = false} of MODEL_PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const end = match.index + match[0].length;
      if (!validBoundaryBefore(text, match.index, provider) || !isTokenBoundaryAfter(text, end)) continue;
      const line = unqualified ? 'unqualified' : provider === 'anthropic' ? (match[1] ?? match[2]) : match[1];
      const latest = unqualified ? null : latestByLine.get(`${provider}/${line.toLowerCase()}`);
      if (!unqualified && !latest) continue;
      // Bedrock's -v1:0 is a platform suffix, not a model version.
      const id = match[0].replace(/-v\d+:\d+$/i, '');
      if (latest && id.toLowerCase() === latest.id.toLowerCase()) continue;
      findings.push({
        id,
        provider,
        model_line: line.toLowerCase(),
        latest: latest?.id ?? null,
        source: latest?.source ?? OFFICIAL_SOURCES.openai,
        line: text.slice(0, match.index).split('\n').length,
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
}

export function scanCurrentModels(root, {
  catalog = loadCurrentModels(),
  allowlist = loadCurrentAllowlist(),
  entries,
  read = (path) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return Buffer.from(readlinkSync(path));
    if (!info.isFile()) return null;
    return readFileSync(path);
  },
} = {}) {
  const paths = entries ?? execFileSync('git', ['ls-files', '-z'], {cwd: root, encoding: 'utf8'})
    .split('\0').filter(Boolean);
  const allowed = new Map(allowlist.entries.map((entry) => [`${entry.path}\0${entry.id.toLowerCase()}`, entry]));
  const findings = [];
  for (const path of paths) {
    if (!isPublicSurfacePath(path)) continue;
    const bytes = read(resolve(root, path));
    if (bytes == null || isProbablyBinary(path, bytes)) continue;
    for (const mention of findCurrentModelMentions(Buffer.from(bytes).toString('utf8'), catalog)) {
      const exception = allowed.get(`${path}\0${mention.id.toLowerCase()}`);
      findings.push({
        category: 'latest-model',
        path,
        ...mention,
        severity: exception ? 'warn' : 'fail',
        issue: exception
          ? `${mention.id} is an allowed historical mention (${exception.reason})`
          : mention.latest
            ? `${mention.id} is not the latest ${mention.provider}/${mention.model_line} model; use ${mention.latest}`
            : `${mention.id} has no verified current OpenAI line; choose an exact ID from scripts/current-models.json`,
      });
    }
  }
  return findings;
}

export function currentCatalogAgeWarnings(catalog = loadCurrentModels(), {
  now = new Date(), maxAgeDays = CATALOG_MAX_AGE_DAYS,
} = {}) {
  const today = utcDay(now);
  return catalog.models.flatMap((model) => {
    const days = Math.floor((today - parseCheckedDate(model.date_checked)) / DAY_MS);
    if (days <= maxAgeDays) return [];
    return [{
      category: 'current-model-catalog-age',
      path: 'scripts/current-models.json',
      line: null,
      issue: `${model.provider}/${model.line} was checked ${days} days ago (${model.date_checked}); refresh from ${model.source}`,
      source: model.source,
      severity: 'warn',
    }];
  });
}

function main(argv = process.argv.slice(2)) {
  const root = argv[0] ? resolve(argv[0]) : repoRootFromScript();
  const catalog = loadCurrentModels();
  const findings = scanCurrentModels(root, {catalog});
  const stale = currentCatalogAgeWarnings(catalog);
  for (const finding of findings) {
    const stream = finding.severity === 'fail' ? console.error : console.log;
    stream(`${finding.path}:${finding.line}: [${finding.severity}] ${finding.issue}`);
  }
  for (const finding of stale) console.warn(`[warn] ${finding.issue}`);
  const failures = findings.filter((finding) => finding.severity === 'fail');
  console.log(`Latest-model check: ${failures.length} failure(s), ${findings.length - failures.length} allowed historical mention(s), ${stale.length} stale catalog warning(s).`);
  return failures.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main());
}
