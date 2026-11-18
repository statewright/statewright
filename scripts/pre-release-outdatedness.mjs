import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  formatFinding,
  isPublicSurfacePath,
  loadCatalog,
  repoRootFromScript,
  scanTrackedFiles,
  upcomingRetirementWarnings,
} from './check-retired-models.mjs';

export const CURRENT_MCP_PROTOCOL_VERSION = '2026-07-28';
export const CURRENT_MCP_SOURCE = 'https://modelcontextprotocol.io/specification/versioning';
export const CURRENT_MCP_DATE_CHECKED = '2026-11-18';
const KNOWN_MCP_VERSIONS = Object.freeze([
  '2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28',
]);
const PUBLIC_SURFACE_PREFIXES = Object.freeze([
  'README.md', 'docs/', 'templates/', 'examples/',
]);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.woff', '.woff2', '.ttf',
]);

export function isPublicSurface(path) {
  const normalized = path.replaceAll('\\', '/');
  return PUBLIC_SURFACE_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(prefix));
}

export function extractClapLongFlags(source) {
  const flags = new Set();
  const blocks = source.split('#[').slice(1);
  for (const block of blocks) {
    if (!block.startsWith('arg')) continue;
    const close = block.indexOf(']');
    if (close === -1) continue;
    const attr = block.slice(0, close);
    const explicit = attr.match(/\blong\s*=\s*"([^"]+)"/);
    if (explicit) {
      flags.add(explicit[1]);
      continue;
    }
    if (!/\blong\b/.test(attr)) continue;
    const rest = block.slice(close + 1);
    const field = rest.match(/^\s*(?:pub\s+)?([A-Za-z0-9_]+)\s*:/);
    if (field) flags.add(field[1].replaceAll('_', '-'));
  }
  return [...flags].sort();
}

export function extractDocumentedFlags(text) {
  const flags = new Set();
  for (const match of text.matchAll(/--([A-Za-z][A-Za-z0-9-]*)/g)) flags.add(match[1]);
  return [...flags].sort();
}

export function listedPluginVersions(text) {
  const mentions = [];
  const patterns = [
    // Plugin release pins, not host app versions such as "Claude Code 2.1.295".
    {name: 'claude', regex: /\bClaude(?!\s+Code\b)(?:\s+\/\s+Desktop Code)?(?:\s+plugin)?\s+(\d+\.\d+\.\d+)/gi, tagPrefix: 'claude-v'},
    {name: 'codex', regex: /\bCodex(?:\s+plugin)?\s+(\d+\.\d+\.\d+)/gi, tagPrefix: 'codex-v'},
    {name: 'claude', regex: /(?:claude-v|claude-)(\d+\.\d+\.\d+)/gi, tagPrefix: 'claude-v'},
    {name: 'codex', regex: /(?:codex-v|codex-)(\d+\.\d+\.\d+)/gi, tagPrefix: 'codex-v'},
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      mentions.push({name: pattern.name, version: match[1], tagPrefix: pattern.tagPrefix, index: match.index});
    }
  }
  // Supported-agents table: "| [Claude Code / Desktop Code](...) | 0.4.0 |"
  for (const match of text.matchAll(/\[\s*Claude Code[^\]]*\][^|\n]*\|\s*(\d+\.\d+\.\d+)/gi)) {
    mentions.push({name: 'claude', version: match[1], tagPrefix: 'claude-v', index: match.index});
  }
  for (const match of text.matchAll(/\[\s*Codex\s*\][^|\n]*\|\s*(\d+\.\d+\.\d+)/gi)) {
    mentions.push({name: 'codex', version: match[1], tagPrefix: 'codex-v', index: match.index});
  }
  return mentions;
}

export function latestTag(tags, prefix) {
  const matching = tags.filter((tag) => tag.startsWith(prefix)).map((tag) => tag.slice(prefix.length));
  matching.sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}));
  return matching.at(-1) ?? null;
}

export function collectMcpVersionMentions(path, text, current = CURRENT_MCP_PROTOCOL_VERSION) {
  const findings = [];
  for (const version of KNOWN_MCP_VERSIONS) {
    if (version === current) continue;
    const pattern = new RegExp(version, 'g');
    let match;
    while ((match = pattern.exec(text))) {
      const line = text.slice(0, match.index).split('\n').length;
      findings.push({
        category: 'mcp-spec',
        path,
        line,
        issue: `Documents MCP specification ${version}; current spec is ${current}`,
        source: CURRENT_MCP_SOURCE,
        severity: 'warn',
      });
    }
  }
  return findings;
}

export function collectLocalAssetIssues(root, path, text) {
  const findings = [];
  const imagePattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)|<img\b[^>]*\bsrc="([^"]+)"/gi;
  let match;
  while ((match = imagePattern.exec(text))) {
    const href = (match[1] || match[2] || '').trim();
    if (!href || /^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(href)) continue;
    const target = decodeURIComponent(href.split(/[?#]/)[0]);
    const absolute = target.startsWith('/')
      ? resolve(root, `.${target}`)
      : resolve(root, dirname(join(root, path)), target);
    // The resolve above is messy for relative paths; do it relative to the file.
    const fileDir = dirname(resolve(root, path));
    const resolved = target.startsWith('/') ? resolve(root, `.${target}`) : resolve(fileDir, target);
    if (!existsSync(resolved)) {
      findings.push({
        category: 'badge-or-asset',
        path,
        line: text.slice(0, match.index).split('\n').length,
        issue: `Missing local image or badge asset ${href}`,
        source: path,
        severity: 'fail',
      });
    }
  }
  return findings;
}

function spawnCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    cwd: options.cwd,
    env: options.env ?? process.env,
  });
  return {
    status: result.status,
    error: result.error,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function runDependencyAudits(root, {runner = spawnCapture} = {}) {
  const findings = [];
  const cargo = runner('cargo', ['audit', '--version'], {cwd: root, timeout: 15_000});
  if (cargo.error || cargo.status !== 0) {
    findings.push({
      category: 'dependencies',
      path: 'Cargo.lock',
      line: null,
      issue: 'cargo audit is not available in this environment; Rust advisory scan was skipped',
      source: 'cargo audit',
      severity: 'warn',
    });
  } else {
    const audit = runner('cargo', ['audit', '--offline', '--color', 'never'], {cwd: root});
    if (audit.error) {
      findings.push({
        category: 'dependencies',
        path: 'Cargo.lock',
        line: null,
        issue: `cargo audit could not be started (${audit.error.code || audit.error.message})`,
        source: 'cargo audit --offline',
        severity: 'warn',
      });
    } else if (audit.status !== 0) {
      const detail = (audit.stdout + '\n' + audit.stderr).trim().split('\n').slice(0, 20).join(' | ');
      findings.push({
        category: 'dependencies',
        path: 'Cargo.lock',
        line: null,
        issue: `cargo audit --offline reported issues: ${detail || 'non-zero exit'}`,
        source: 'cargo audit --offline',
        severity: 'warn',
      });
    }
  }

  const packageLocks = [];
  const walk = (dir, rel = '') => {
    let entries = [];
    try { entries = readdirSync(dir, {withFileTypes: true}); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'vendor') continue;
      const relative = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else if (entry.name === 'package-lock.json') packageLocks.push(relative);
    }
  };
  walk(root);

  for (const lock of packageLocks) {
    const cwd = dirname(resolve(root, lock));
    const audit = runner('npm', ['audit', '--offline', '--package-lock-only', '--omit=dev', '--json'], {cwd, timeout: 120_000});
    if (audit.error || (audit.status !== 0 && !(audit.stdout || '').trim())) {
      const online = runner('npm', ['audit', '--package-lock-only', '--omit=dev', '--json'], {cwd, timeout: 120_000});
      if (online.error || !(online.stdout || '').trim()) {
        findings.push({
          category: 'dependencies',
          path: lock,
          line: null,
          issue: 'npm audit could not be completed (offline and online attempts produced no report)',
          source: 'npm audit',
          severity: 'warn',
        });
        continue;
      }
      findings.push(...npmAuditFindings(lock, online.stdout, 'npm audit'));
    } else {
      findings.push(...npmAuditFindings(lock, audit.stdout, 'npm audit --offline'));
    }

    const outdated = runner('npm', ['outdated', '--json'], {cwd, timeout: 120_000});
    if (!outdated.error && (outdated.stdout || '').trim()) {
      try {
        const data = JSON.parse(outdated.stdout);
        for (const [name, info] of Object.entries(data)) {
          const current = info.current ?? '?';
          const wanted = info.wanted ?? '?';
          const latest = info.latest ?? '?';
          if (wanted === latest && (current === '?' || current === wanted)) continue;
          findings.push({
            category: 'dependencies',
            path: lock,
            line: null,
            issue: `${name} current ${current} wanted ${wanted} latest ${latest}`,
            source: 'npm outdated',
            severity: 'warn',
          });
        }
      } catch {
        // npm outdated writes a table when JSON parsing fails; keep a short warning.
        if (outdated.status !== 0) {
          findings.push({
            category: 'dependencies',
            path: lock,
            line: null,
            issue: 'npm outdated reported packages (unparsed output)',
            source: 'npm outdated',
            severity: 'warn',
          });
        }
      }
    }
  }
  return findings;
}

function npmAuditFindings(lock, stdout, source) {
  const findings = [];
  try {
    const data = JSON.parse(stdout);
    const vulns = data.vulnerabilities || data.advisories || {};
    const entries = Array.isArray(vulns) ? vulns : Object.entries(vulns);
    for (const entry of entries) {
      const name = Array.isArray(entry) ? entry[0] : entry.name;
      const info = Array.isArray(entry) ? entry[1] : entry;
      const severity = info.severity || info.via?.[0]?.severity || 'unknown';
      const via = Array.isArray(info.via) ? info.via.map((item) => item.title || item.name || item).filter(Boolean).slice(0, 3).join('; ') : '';
      findings.push({
        category: 'dependencies',
        path: `${lock}:${name}`,
        line: null,
        issue: `${severity} vulnerability${via ? ` (${via})` : ''}`,
        source,
        severity: 'warn',
      });
    }
    if (findings.length === 0 && (data.metadata?.vulnerabilities?.total || 0) > 0) {
      findings.push({
        category: 'dependencies',
        path: lock,
        line: null,
        issue: `npm audit reported ${data.metadata.vulnerabilities.total} vulnerabilities`,
        source,
        severity: 'warn',
      });
    }
  } catch {
    findings.push({
      category: 'dependencies',
      path: lock,
      line: null,
      issue: 'npm audit returned a non-JSON report; inspect manually',
      source,
      severity: 'warn',
    });
  }
  return findings;
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], {cwd: root, encoding: 'utf8'}).split('\0').filter(Boolean);
}

function rustCliSources(root) {
  return [
    'crates/cli/src/main.rs',
    'crates/tui/src/main.rs',
  ].filter((path) => existsSync(resolve(root, path)));
}

function jsCliSources(root) {
  return [
    'plugins/executor/statewright-exec.mjs',
    'plugins/executor/statewright-managed-client.mjs',
  ].filter((path) => existsSync(resolve(root, path)));
}

export function collectDocsAndPinFindings(root, {files} = {}) {
  const findings = [];
  const paths = files ?? trackedFiles(root).filter(isPublicSurface);
  const tags = execFileSync('git', ['tag'], {cwd: root, encoding: 'utf8'}).trim().split('\n').filter(Boolean);
  const latestClaude = latestTag(tags, 'claude-v');
  const latestCodex = latestTag(tags, 'codex-v');
  let cliFlags = new Set();
  for (const path of rustCliSources(root)) {
    for (const flag of extractClapLongFlags(readFileSync(resolve(root, path), 'utf8'))) cliFlags.add(flag);
  }
  for (const path of jsCliSources(root)) {
    for (const flag of extractDocumentedFlags(readFileSync(resolve(root, path), 'utf8'))) cliFlags.add(flag);
  }

  for (const path of paths) {
    const absolute = resolve(root, path);
    const lower = path.toLowerCase();
    const dot = lower.lastIndexOf('.');
    if (dot !== -1 && BINARY_EXTENSIONS.has(lower.slice(dot))) continue;
    let text;
    try { text = readFileSync(absolute, 'utf8'); }
    catch { continue; }
    if (text.includes('\0')) continue;
    findings.push(...collectMcpVersionMentions(path, text));
    findings.push(...collectLocalAssetIssues(root, path, text));

    if (cliFlags.size && path === 'README.md') {
      const otherTools = /\b(docker|compose|npm|npx|cargo|git|plugin|codex|claude)\b/i;
      for (const flag of extractDocumentedFlags(text)) {
        if (cliFlags.has(flag)) continue;
        const lineNo = text.split('\n').findIndex((row) => row.includes(`--${flag}`)) + 1;
        const line = lineNo ? text.split('\n')[lineNo - 1] : '';
        if (otherTools.test(line)) continue;
        if (!/(sw-agent|statewright TUI|binary)/i.test(text)) continue;
        findings.push({
          category: 'docs-cli',
          path,
          line: lineNo || null,
          issue: `README documents --${flag}, which was not found in sw-agent, statewright, or executor CLI flags`,
          source: 'crates/cli, crates/tui, and plugins/executor CLIs',
          severity: 'warn',
        });
      }
    }

    if (path === 'README.md') {
      for (const mention of listedPluginVersions(text)) {
        const latest = mention.name === 'claude' ? latestClaude : latestCodex;
        if (latest && mention.version !== latest) {
          const line = text.slice(0, mention.index).split('\n').length;
          findings.push({
            category: 'version-pin',
            path,
            line,
            issue: `${mention.name} ${mention.version} is documented; latest tag is ${mention.tagPrefix}${latest}`,
            source: 'git tags',
            severity: 'warn',
          });
        }
      }
    }
  }
  return findings;
}

export function runSweep(root, {includeDependencyAudits = true, catalog = loadCatalog(), now} = {}) {
  const modelFindings = scanTrackedFiles(root, {catalog}).map((finding) => ({
    category: 'model-id',
    path: finding.path,
    line: finding.line,
    issue: formatFinding(finding),
    source: finding.id && catalog.models.find((model) => model.id === finding.id)?.source,
    severity: isPublicSurfacePath(finding.path) ? 'fail' : 'warn',
    id: finding.id,
    replacement: finding.replacement,
  }));
  const retirementFindings = upcomingRetirementWarnings(catalog, now ? {now} : {});
  const docsFindings = collectDocsAndPinFindings(root);
  const dependencyFindings = includeDependencyAudits ? runDependencyAudits(root) : [];
  return {modelFindings, retirementFindings, docsFindings, dependencyFindings};
}

export function sweepHasFailures({modelFindings, retirementFindings = [], docsFindings, dependencyFindings}) {
  return [...modelFindings, ...retirementFindings, ...docsFindings, ...dependencyFindings].some((finding) => finding.severity === 'fail');
}

export function formatSweepReport({modelFindings, retirementFindings = [], docsFindings, dependencyFindings}) {
  const lines = ['Pre-release outdatedness sweep', ''];
  const sections = [
    ['Retired or deprecated model IDs', modelFindings],
    ['Upcoming retirements (within 30 days)', retirementFindings],
    ['Docs, MCP spec, CLI flags, and version pins', docsFindings],
    ['Dependencies (audit / outdated)', dependencyFindings],
  ];
  for (const [title, findings] of sections) {
    lines.push(`${title}: ${findings.length}`);
    if (findings.length === 0) {
      lines.push('  (none)');
    } else {
      for (const finding of findings) {
        const loc = finding.line ? `${finding.path}:${finding.line}` : finding.path;
        lines.push(`  [${finding.severity}] ${finding.category} ${loc} — ${finding.issue}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const skipDeps = args.includes('--skip-dependency-audits');
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const root = positional[0] ? resolve(positional[0]) : repoRootFromScript();
  const result = runSweep(root, {includeDependencyAudits: !skipDeps});
  const report = formatSweepReport(result);
  const failed = sweepHasFailures(result);
  if (failed) console.error(report);
  else console.log(report);
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main());
}
