#!/usr/bin/env node
/**
 * Deterministic, repository-local reference index for Statewright plugins.
 *
 * The index is stored below Git's private metadata, never in the worktree. On
 * each query it reuses unchanged source chunks and re-ingests only files whose
 * tracked head or stat signature changed. No repository content leaves the
 * machine.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

const INDEX_VERSION = 1;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_RESULTS = 8;
const CHUNK_LINES = 48;
const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js",
  ".jsx", ".kt", ".mjs", ".php", ".py", ".rb", ".rs", ".sh", ".swift",
  ".ts", ".tsx",
]);
const DOCUMENT_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const WORKFLOW_EXTENSIONS = new Set([".json", ".toml", ".yaml", ".yml"]);
const SKIP_DIRS = new Set([
  ".git", ".next", ".cache", "build", "coverage", "dist", "node_modules",
  "target", "vendor",
]);
const GUIDANCE_NAMES = new Set([
  "agents.md", "claude.md", "changelog.md", "contributing.md", "readme.md",
]);
const GUIDANCE_DIRS = new Set([
  ".claude", ".codex", "adr", "adrs", "docs", "plans", "skills", "specs",
]);
const WORKFLOW_DIRS = new Set(["templates", "workflows"]);
const SECRET_PATH = /(^|\/)(\.env($|\.)|auth|credentials?|private[-_]?keys?|secrets?|tokens?)(\/|$)/i;
const SECRET_CONTENT = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][A-Za-z0-9_+\/.=-]{16,}["']/i,
  /(?:postgres|mysql|mongodb(?:\+srv)?):\/\/[^\s:@]+:[^\s@]+@/i,
];

function option(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] ?? fallback : fallback;
}

function git(root, args, binary = false) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: binary ? "buffer" : "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return binary ? Buffer.alloc(0) : "";
  }
}

function sourceKind(path) {
  const normalized = path.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  const name = basename(lower);
  const extension = extname(name);
  const segments = lower.split("/");

  if (GUIDANCE_NAMES.has(name)) return "guidance";
  if (DOCUMENT_EXTENSIONS.has(extension) && segments.some((part) => GUIDANCE_DIRS.has(part))) {
    return "guidance";
  }
  if (WORKFLOW_EXTENSIONS.has(extension) && segments.some((part) => WORKFLOW_DIRS.has(part))) {
    return "workflow";
  }
  if (
    lower.includes(".statewright/evidence/") &&
    /\.(summary|validation)\.json$/.test(lower)
  ) {
    return "validation";
  }
  if (CODE_EXTENSIONS.has(extension)) return "code";
  return null;
}

function deniedPath(path) {
  const normalized = path.replaceAll("\\", "/");
  return SECRET_PATH.test(normalized) || normalized.split("/").some((part) => SKIP_DIRS.has(part));
}

function fallbackFiles(root, dir = root, output = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) fallbackFiles(root, full, output);
    } else if (entry.isFile()) {
      output.push(relative(root, full));
    }
  }
  return output;
}

function listedFiles(root) {
  const listed = git(root, ["ls-files", "-co", "--exclude-standard", "-z"], true);
  const paths = listed.length
    ? listed.toString("utf8").split("\0").filter(Boolean)
    : fallbackFiles(root);
  return [...new Set(paths)]
    .filter((path) => !deniedPath(path) && sourceKind(path))
    .sort((left, right) => left.localeCompare(right));
}

function containsSecret(content) {
  return SECRET_CONTENT.some((pattern) => pattern.test(content));
}

function headingFor(lines, previous) {
  const markdown = lines.find((line) => /^#{1,6}\s+/.test(line));
  if (markdown) return markdown.replace(/^#{1,6}\s+/, "").trim();
  const symbol = lines.find((line) =>
    /^\s*(?:pub\s+)?(?:async\s+)?(?:fn|function|class|struct|enum|interface|type|def)\s+[A-Za-z_][A-Za-z0-9_]*/.test(line),
  );
  return symbol?.trim().slice(0, 160) || previous;
}

function ingest(path, root, stat, commit) {
  const full = resolve(root, path);
  const content = readFileSync(full, "utf8");
  if (containsSecret(content)) return null;

  const sourceHash = createHash("sha256").update(content).digest("hex");
  const lines = content.split(/\r?\n/);
  const chunks = [];
  let heading = "";
  for (let start = 0; start < lines.length; start += CHUNK_LINES) {
    const section = lines.slice(start, start + CHUNK_LINES);
    heading = headingFor(section, heading);
    const text = section.join("\n").trim();
    if (!text) continue;
    chunks.push({
      source_kind: sourceKind(path),
      path,
      line_start: start + 1,
      line_end: Math.min(start + CHUNK_LINES, lines.length),
      heading,
      source_hash: sourceHash,
      commit_sha: commit || null,
      excerpt: text.slice(0, 2400),
    });
  }
  return { mtime_ms: stat.mtimeMs, size: stat.size, source_hash: sourceHash, chunks };
}

function commitChunks(root, queryHead) {
  const rows = git(root, ["log", "-n", "80", "--format=%H%x1f%s%x1e", "--name-only"]);
  if (!rows) return [];
  return rows.split("\x1e").filter(Boolean).map((row) => {
    const [header, ...paths] = row.trim().split("\n");
    const [sha, subject] = header.split("\x1f");
    const changedPaths = paths
      .filter((path) => path && !deniedPath(path) && sourceKind(path))
      .slice(0, 40);
    return {
      source_kind: "git_commit",
      path: changedPaths.join(", "),
      line_start: 1,
      line_end: 1,
      heading: subject,
      source_hash: sha,
      commit_sha: sha,
      excerpt: `${subject}\n${changedPaths.join("\n")}`,
      indexed_head: queryHead,
    };
  });
}

function cachePath(root) {
  const path = String(git(root, ["rev-parse", "--git-path", "statewright/reference-index-v1.json"])).trim();
  return path ? resolve(root, path) : null;
}

function loadCache(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const cache = JSON.parse(readFileSync(path, "utf8"));
    return cache.version === INDEX_VERSION ? cache : null;
  } catch {
    return null;
  }
}

function saveCache(path, cache) {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(cache));
    renameSync(temporary, path);
  } catch {
    // A read-only Git directory should degrade to an in-memory query, not fail.
  }
}

function buildIndex(root) {
  const head = String(git(root, ["rev-parse", "HEAD"])).trim();
  const path = cachePath(root);
  const previous = loadCache(path);
  const documents = {};

  for (const relativePath of listedFiles(root)) {
    const full = resolve(root, relativePath);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;

    const cached = previous?.documents?.[relativePath];
    if (
      previous?.head === head && cached &&
      cached.mtime_ms === stat.mtimeMs && cached.size === stat.size
    ) {
      documents[relativePath] = cached;
      continue;
    }
    const document = ingest(relativePath, root, stat, head);
    if (document) documents[relativePath] = document;
  }

  const commits = previous?.head === head && Array.isArray(previous?.commits)
    ? previous.commits
    : commitChunks(root, head);
  const index = { version: INDEX_VERSION, head, documents, commits };
  saveCache(path, index);
  return index;
}

function terms(query) {
  return [...new Set(query.toLowerCase().match(/[a-z0-9_./:-]{2,}/g) ?? [])];
}

function score(chunk, queryTerms) {
  const body = String(chunk.excerpt ?? "").toLowerCase();
  const path = String(chunk.path ?? "").toLowerCase();
  const heading = String(chunk.heading ?? "").toLowerCase();
  const reasons = [];
  let total = 0;
  for (const term of queryTerms) {
    if (path === term || path.endsWith(`/${term}`)) {
      total += 24;
      reasons.push(`path_exact:${term}`);
    } else if (path.includes(term)) {
      total += 12;
      reasons.push(`path:${term}`);
    }
    if (heading.includes(term)) {
      total += 8;
      reasons.push(`heading:${term}`);
    }
    const count = body.split(term).length - 1;
    if (count) {
      total += Math.min(count, 4) * 2;
      reasons.push(`term:${term}`);
    }
  }
  if (chunk.source_kind === "code" && reasons.some((reason) => reason.startsWith("path"))) {
    total += 4;
    reasons.push("code_path");
  }
  return { total, reasons: [...new Set(reasons)] };
}

const query = option("--query", "").trim();
const root = resolve(option("--root", process.cwd()));
const limit = Math.min(Math.max(Number(option("--limit", String(MAX_RESULTS))) || MAX_RESULTS, 1), 20);
if (!query) {
  console.log(JSON.stringify({ error: "Missing required parameter: query", results: [] }));
  process.exit(0);
}
if (!existsSync(root)) {
  console.log(JSON.stringify({ error: `Reference root does not exist: ${root}`, results: [] }));
  process.exit(0);
}

const index = buildIndex(root);
const queryTerms = terms(query);
const chunks = [
  ...Object.values(index.documents).flatMap((document) => document.chunks),
  ...index.commits,
];
const results = chunks
  .map((chunk) => ({ chunk, rank: score(chunk, queryTerms) }))
  .filter(({ rank }) => rank.total > 0)
  .map(({ chunk, rank }) => ({ ...chunk, rank: rank.total, rank_reasons: rank.reasons }))
  .sort((left, right) =>
    right.rank - left.rank || left.path.localeCompare(right.path) || left.line_start - right.line_start,
  )
  .slice(0, limit);

console.log(JSON.stringify({
  query,
  root,
  deterministic: true,
  indexed: true,
  index_version: INDEX_VERSION,
  indexed_head: index.head || null,
  document_count: Object.keys(index.documents).length,
  results,
}));
