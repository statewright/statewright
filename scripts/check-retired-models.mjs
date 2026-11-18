import {execFileSync} from 'node:child_process';
import {readFileSync, lstatSync, readlinkSync} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const defaultCatalogPath = join(here, 'retired-model-ids.json');
export const defaultSkipPathPrefixes = Object.freeze([
  'scripts/retired-model-ids.json',
  'scripts/fixtures/pre-release-outdatedness/',
]);
const defaultSkipPathSegments = Object.freeze(['vendor', 'node_modules']);
const hardFailPrefixes = Object.freeze([
  'README.md',
  'templates/',
  'examples/',
  'docs/',
]);
const hardFailPluginPatterns = Object.freeze([
  /^plugins\/[^/]+\/README\.md$/,
  /^plugins\/[^/]+\/docs\//,
  /^plugins\/[^/]+\/workflows\//,
]);
const binaryExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz',
  '.woff', '.woff2', '.ttf', '.eot', '.wasm', '.mp4', '.mov', '.bin',
]);

export function loadCatalog(path = defaultCatalogPath) {
  const catalog = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
    throw new Error('Retired model catalog has no models');
  }
  const seen = new Set();
  for (const model of catalog.models) {
    if (!model.id || !model.provider || !model.status || !model.source || !model.date_checked) {
      throw new Error('Retired model catalog entry is missing required fields');
    }
    if (!['retired', 'deprecated'].includes(model.status)) {
      throw new Error(`Invalid status for ${model.id}`);
    }
    if (seen.has(model.id)) throw new Error(`Duplicate model id ${model.id}`);
    seen.add(model.id);
  }
  return catalog;
}

export function isModelIdChar(ch) {
  return ch != null && /[A-Za-z0-9._-]/.test(ch);
}

export function isTokenBoundaryBefore(text, index) {
  return index === 0 || !isModelIdChar(text[index - 1]);
}

export function isTokenBoundaryAfter(text, end) {
  if (end >= text.length) return true;
  const ch = text[end];
  // In regex literals, "gpt-5\.6-sol" is the same id as gpt-5.6-sol.
  if (ch === '\\' && '._-'.includes(text[end + 1] ?? '')) return false;
  if (ch === '.' || ch === '-' || ch === '_') {
    const next = text[end + 1];
    return !next || !/[A-Za-z0-9]/.test(next);
  }
  return !isModelIdChar(ch);
}

export function findModelIdMatches(text, models) {
  const findings = [];
  for (const model of models) {
    let from = 0;
    while (from <= text.length - model.id.length) {
      const index = text.indexOf(model.id, from);
      if (index === -1) break;
      const end = index + model.id.length;
      if (isTokenBoundaryBefore(text, index) && isTokenBoundaryAfter(text, end)) {
        const line = text.slice(0, index).split('\n').length;
        findings.push({index, line, id: model.id, status: model.status, replacement: model.replacement ?? null});
      }
      from = index + 1;
    }
  }
  findings.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
  return findings;
}

export function shouldSkipPath(path, prefixes = defaultSkipPathPrefixes) {
  const normalized = path.split(sep).join('/');
  if (prefixes.some((prefix) => normalized === prefix || normalized.startsWith(prefix))) return true;
  const parts = normalized.split('/');
  return defaultSkipPathSegments.some((segment) => parts.includes(segment));
}

export function isPublicSurfacePath(path) {
  const normalized = path.split(sep).join('/');
  if (shouldSkipPath(normalized)) return false;
  if (hardFailPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(prefix))) return true;
  return hardFailPluginPatterns.some((pattern) => pattern.test(normalized));
}

function isProbablyBinary(path, bytes) {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot !== -1 && binaryExtensions.has(lower.slice(dot))) return true;
  const sample = bytes.subarray(0, 8000);
  return sample.includes(0);
}

export function formatFinding(finding) {
  const replacement = finding.replacement ? `; replace with ${finding.replacement}` : '';
  return `${finding.path}:${finding.line}:${finding.id} (${finding.status}${replacement})`;
}

export function parseLsFilesStage(row) {
  const match = row.match(/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/);
  if (!match) return {path: row, mode: '100644'};
  return {mode: match[1], path: match[4], stage: match[3]};
}

export function scanTrackedFiles(root, {
  catalog = loadCatalog(),
  skipPathPrefixes = defaultSkipPathPrefixes,
  read = (path) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return Buffer.from(readlinkSync(path));
    if (!info.isFile()) return null;
    return readFileSync(path);
  },
  entries,
} = {}) {
  const rows = entries ?? execFileSync('git', ['ls-files', '--stage', '-z'], {cwd: root, encoding: 'utf8'})
    .split('\0').filter(Boolean);
  const findings = [];
  for (const row of rows) {
    const {mode, path} = parseLsFilesStage(row);
    if (mode === '160000' || mode === '040000') continue;
    if (shouldSkipPath(path, skipPathPrefixes)) continue;
    const bytes = read(resolve(root, path));
    if (bytes == null || isProbablyBinary(path, bytes)) continue;
    const text = Buffer.from(bytes).toString('utf8');
    for (const match of findModelIdMatches(text, catalog.models)) {
      findings.push({path, ...match});
    }
  }
  return findings;
}

export function repoRootFromScript() {
  return resolve(here, '..');
}

function main(argv = process.argv.slice(2)) {
  const root = argv[0] ? resolve(argv[0]) : repoRootFromScript();
  const findings = scanTrackedFiles(root);
  const failures = findings.filter((finding) => isPublicSurfacePath(finding.path));
  const warnings = findings.filter((finding) => !isPublicSurfacePath(finding.path));
  if (warnings.length) {
    const stream = failures.length ? console.error : console.log;
    stream('Retired or deprecated LLM model IDs outside the public surface (warning):');
    for (const finding of warnings) stream(formatFinding(finding));
  }
  if (failures.length === 0) {
    if (!warnings.length) console.log('Retired/deprecated model ID check passed.');
    else console.log('Retired/deprecated model ID public-surface check passed with warnings.');
    return 0;
  }
  console.error('Retired or deprecated LLM model IDs found on the public surface:');
  for (const finding of failures) console.error(formatFinding(finding));
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main());
}
