import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "reference-search.mjs");

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function search(root, query) {
  return JSON.parse(execFileSync("node", [script, "--root", root, "--query", query], {
    encoding: "utf8",
  }));
}

test("packaged plugin copies match the shared reference index", () => {
  const expected = readFileSync(script, "utf8");
  assert.equal(readFileSync(resolve(here, "../codex/reference-search.mjs"), "utf8"), expected);
  assert.equal(readFileSync(resolve(here, "../claude-code/reference-search.mjs"), "utf8"), expected);
});

test("index is deterministic, incremental, and excludes ignored or secret material", () => {
  const root = mkdtempSync(join(tmpdir(), "statewright-reference-index-"));
  try {
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "secrets"), { recursive: true });
    mkdirSync(join(root, "build"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "build/\n");
    writeFileSync(join(root, "docs", "decision.md"), "# Retry decision\nUse bounded exponential backoff.\n");
    writeFileSync(join(root, "src", "retry.rs"), "fn retry_budget() -> usize { 3 }\n");
    writeFileSync(join(root, "secrets", "token.md"), "# never index\nneedle-private\n");
    writeFileSync(join(root, "docs", "leak.md"), "api_key = \"this_is_a_test_credential_value\"\nneedle-leak\n");
    writeFileSync(join(root, "build", "raw.log"), "needle-build\n");

    git(root, "init", "-q");
    git(root, "config", "user.email", "test@statewright.invalid");
    git(root, "config", "user.name", "Statewright Test");
    git(root, "add", ".");
    git(root, "commit", "-qm", "seed reference corpus");

    const first = search(root, "retry decision");
    const second = search(root, "retry decision");
    assert.deepEqual(second, first);
    assert.equal(first.indexed, true);
    assert.ok(first.results.some((result) => result.path === "docs/decision.md"));
    assert.ok(first.results.some((result) => result.path === "src/retry.rs"));

    const excluded = search(root, "needle-private needle-leak needle-build");
    assert.deepEqual(excluded.results, []);

    const oldHash = first.results.find((result) => result.path === "docs/decision.md").source_hash;
    writeFileSync(join(root, "docs", "decision.md"), "# Retry decision\nUse a four-attempt bounded backoff.\n");
    const changed = search(root, "retry decision");
    const changedDoc = changed.results.find((result) => result.path === "docs/decision.md");
    assert.notEqual(changedDoc.source_hash, oldHash);
    assert.match(changedDoc.excerpt, /four-attempt/);

    const cache = git(root, "rev-parse", "--git-path", "statewright/reference-index-v1.json");
    assert.doesNotThrow(() => JSON.parse(readFileSync(resolve(root, cache), "utf8")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
