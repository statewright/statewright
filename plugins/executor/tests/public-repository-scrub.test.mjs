import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import test from "node:test";

const APPROVED_PHONE_HOME_HOSTS = new Set([
  "glitch.enhasa.cloud",
  "umami.enhasa.cloud",
]);

const root = fileURLToPath(new URL("../../../", import.meta.url));

function violationsIn(text) {
  const forbiddenTerms = [
    ["ni", "nfer"].join(""),
    ["30", "90"].join(""),
    ["olla", "ma-casa"].join(""),
    ["wey", "oun"].join(""),
    ["cor", "tana"].join(""),
    ["andu", "ril"].join(""),
    ["ae", "rith"].join(""),
    ["/Users/", "ben"].join(""),
    ["auld", "wyrm"].join(""),
  ];
  const violations = [];
  for (const term of forbiddenTerms) {
    if (text.toLowerCase().includes(term.toLowerCase())) violations.push("private infrastructure reference");
  }
  for (const match of text.matchAll(/\b([a-z0-9.-]+\.enhasa\.cloud)\b/gi)) {
    const host = match[1].toLowerCase();
    if (!APPROVED_PHONE_HOME_HOSTS.has(host)) violations.push("private host reference");
  }
  return violations;
}

test("public scrub recognizes private references regardless of case", () => {
  const privatePath = ["/Users/", "ben", "/project"].join("");
  for (const value of [privatePath, privatePath.toLowerCase(), privatePath.toUpperCase()]) {
    assert.ok(violationsIn(value).length > 0);
  }
  assert.ok(violationsIn(["auld", "wyrm"].join("").toUpperCase()).length > 0);
  assert.ok(violationsIn(["private", ".enhasa.cloud"].join("")).length > 0);
});

test("public scrub permits generic examples and approved telemetry hosts", () => {
  assert.deepEqual(violationsIn("/Users/example/project https://example.test"), []);
  for (const host of APPROVED_PHONE_HOME_HOSTS) {
    assert.deepEqual(violationsIn(`https://${host.toUpperCase()}/`), []);
  }
});

test("tracked public sources contain no private model-infrastructure references", () => {
  const entries = execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(Boolean);
  const violations = [];
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    const [mode, , stage] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    assert.equal(stage, "0", `Unmerged tracked entry: ${path}`);
    if (mode === "160000") continue; // Separate Git repository, not a file in this tree.
    const contents = mode === "120000"
      ? Buffer.from(readlinkSync(resolve(root, path)))
      : readFileSync(resolve(root, path)); // Missing/unreadable tracked files fail the check.
    if (contents.includes(0)) continue;
    violations.push(...violationsIn(contents.toString("utf8")).map(rule => `${path}: ${rule}`));
  }
  assert.deepEqual(violations, []);
});

test("published denial evidence uses unique event labels and grouped session pseudonyms", () => {
  const audit = JSON.parse(readFileSync(resolve(root, "docs/research/classifier-denial-audit-20261020.json"), "utf8"));
  assert.match(audit.selection.public_identifiers, /pseudonyms/);
  assert.equal(audit.records.length, audit.record_count);
  assert.equal(new Set(audit.records.map(record => record.call_id)).size, audit.record_count);
  for (const record of audit.records) {
    assert.match(record.call_id, /^event-\d{3}$/);
    assert.match(record.source_session, /^session-\d{3}$/);
    assert.equal(record.adjudication_status, "unreviewed");
  }
  assert.equal(new Set(audit.records.map(record => record.source_session)).size, 9);
});

test("public Markdown links resolve without a developer's local checkout", () => {
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(path => path.endsWith(".md") && !path.includes("/vendor/"));
  const failures = [];
  for (const path of paths) {
    const text = readFileSync(resolve(root, path), "utf8")
      .replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
    for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
      const href = match[1].replace(/^<|>$/g, "");
      if (/^file:/i.test(href)) { failures.push(`${path}: local file URL`); continue; }
      if (/^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(href)) continue;
      const target = decodeURIComponent(href.split(/[?#]/)[0]);
      if (!target) continue;
      const absolute = target.startsWith("/")
        ? resolve(root, "." + target) : resolve(root, dirname(path), target);
      if (!existsSync(absolute)) failures.push(`${path}: unresolved ${href}`);
    }
  }
  assert.deepEqual(failures, []);
});
