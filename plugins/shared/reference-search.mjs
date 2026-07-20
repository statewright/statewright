#!/usr/bin/env node
/**
 * Deterministic, local reference search for Statewright plugins.
 *
 * It intentionally uses no embeddings or network services. Results are bounded
 * source chunks with path/line/hash provenance so an agent can cite evidence
 * without treating a generated summary as an index fact.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_RESULTS = 8;
const CHUNK_LINES = 48;
const EXTENSIONS = new Set([".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".toml", ".rs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".sh"]);
const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "build", "coverage", ".next", ".cache", "vendor"]);
const SECRET_NAMES = /(^|[._-])(secret|credential|password|private|token|apikey|api_key)([._-]|$)/i;

function option(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] ?? fallback : fallback;
}

function git(root, args) {
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
}

function ignored(root, file) {
  try { execFileSync("git", ["-C", root, "check-ignore", "-q", "--", file], { stdio: "ignore" }); return true; }
  catch { return false; }
}

function eligible(root, file) {
  const name = basename(file);
  return EXTENSIONS.has(extname(name).toLowerCase()) && !SECRET_NAMES.test(name) && !ignored(root, file);
}

function files(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files(root, join(dir, entry.name), out);
      continue;
    }
    const file = join(dir, entry.name);
    if (entry.isFile() && eligible(root, file) && statSync(file).size <= MAX_FILE_BYTES) out.push(file);
  }
  return out;
}

function terms(query) {
  return [...new Set(query.toLowerCase().match(/[a-z0-9_./:-]{2,}/g) ?? [])];
}

function score(text, path, heading, queryTerms) {
  const body = String(text ?? "").toLowerCase();
  const p = String(path ?? "").toLowerCase();
  const h = String(heading ?? "").toLowerCase();
  const reasons = [];
  let total = 0;
  for (const term of queryTerms) {
    if (p.includes(term)) { total += 12; reasons.push(`path:${term}`); }
    if (h.includes(term)) { total += 7; reasons.push(`heading:${term}`); }
    const count = body.split(term).length - 1;
    if (count) { total += Math.min(count, 4) * 2; reasons.push(`term:${term}`); }
  }
  return { total, reasons: [...new Set(reasons)] };
}

function chunks(root, queryTerms) {
  const commit = git(root, ["rev-parse", "HEAD"]);
  const results = [];
  for (const file of files(root)) {
    const rel = relative(root, file);
    const content = readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);
    let heading = "";
    for (let start = 0; start < lines.length; start += CHUNK_LINES) {
      const section = lines.slice(start, start + CHUNK_LINES);
      const localHeading = section.find((line) => /^#{1,6}\s+/.test(line));
      if (localHeading) heading = localHeading.replace(/^#{1,6}\s+/, "").trim();
      const text = section.join("\n").trim();
      if (!text) continue;
      const rank = score(text, rel, heading, queryTerms);
      if (!rank.total) continue;
      results.push({
        source_kind: "file",
        path: rel,
        line_start: start + 1,
        line_end: Math.min(start + CHUNK_LINES, lines.length),
        heading,
        source_hash: createHash("sha256").update(content).digest("hex"),
        commit_sha: commit || null,
        rank: rank.total,
        rank_reasons: rank.reasons,
        excerpt: text.slice(0, 2400),
      });
    }
  }
  return results;
}

function commitChunks(root, queryTerms) {
  const rows = git(root, ["log", "-n", "80", "--format=%H%x1f%s%x1e", "--name-only"]);
  if (!rows) return [];
  return rows.split("\x1e").filter(Boolean).flatMap((row) => {
    const [header, ...paths] = row.trim().split("\n");
    const [sha, subject] = header.split("\x1f");
    const text = `${subject}\n${paths.join("\n")}`;
    const rank = score(text, paths.join(" "), subject, queryTerms);
    return rank.total ? [{
      source_kind: "git_commit",
      path: paths.filter(Boolean).slice(0, 20).join(", "),
      line_start: 1, line_end: 1, heading: subject,
      source_hash: sha, commit_sha: sha, rank: rank.total,
      rank_reasons: ["commit", ...rank.reasons], excerpt: text,
    }] : [];
  });
}

const query = option("--query", "").trim();
const root = resolve(option("--root", process.cwd()));
const limit = Math.min(Number(option("--limit", String(MAX_RESULTS))) || MAX_RESULTS, 20);
if (!query) {
  console.log(JSON.stringify({ error: "Missing required parameter: query", results: [] }));
  process.exit(0);
}
if (!existsSync(root)) {
  console.log(JSON.stringify({ error: `Reference root does not exist: ${root}`, results: [] }));
  process.exit(0);
}
const queryTerms = terms(query);
const results = [...chunks(root, queryTerms), ...commitChunks(root, queryTerms)]
  .sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path) || a.line_start - b.line_start)
  .slice(0, limit);
console.log(JSON.stringify({ query, root, deterministic: true, results }));
