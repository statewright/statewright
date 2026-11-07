import assert from "node:assert/strict";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {collectCommandReferences, relevantHelp} from "../lib/command-reference.mjs";

test("each invocation receives independent static help and explicit missing evidence", async t => {
  const root = await mkdtemp(join(tmpdir(), "statewright-help-"));
  t.after(() => rm(root, {recursive:true, force:true}));
  await writeFile(join(root, "widget.help.txt"), "widget get: read records\n-v Print version only\n--delete Deletes records\n");
  await writeFile(join(root, "widget-get.help.txt"), "get reads records; global flags still apply.\n-v Print version only\n--delete Deletes records\n");
  const result = await collectCommandReferences("exec_command", {cmd:"widget get -v && absent --delete"}, {roots:[root], now:()=>123});
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].status, "available");
  assert.equal(result.entries[0].references[0].version_match, "unverified");
  assert.equal(result.entries[0].references[0].source, "widget-get.help.txt");
  assert.match(result.entries[0].references[0].excerpt, /--delete Deletes/);
  assert.deepEqual(result.entries[0].references[0].unmatched_flags, []);
  assert.equal(result.entries[1].status, "missing");
  assert.equal(result.entries[0].references[0].sha256.length, 64);
});

test("flag matching is literal and absent matches never become read evidence", () => {
  const result = relevantHelp("tool\nread by default\n", ["--erase=.*", "-v"]);
  assert.deepEqual(result.unmatched_flags, ["--erase", "-v"]);
  assert.equal(Object.hasOwn(result, "read_only"), false);
});

test("substitutions remain unsupported and documentation budget exhaustion is explicit", async () => {
  const result = await collectCommandReferences("exec_command", {cmd:"tool $(other)"}, {roots:[]});
  assert.equal(result.entries[0].status, "unsupported_invocation");
  const excerpt = relevantHelp(Array.from({length:300},()=>"-v "+"x".repeat(200)).join("\n"), ["-v"]);
  assert.equal(excerpt.completeness, "budget_exhausted");
  assert(Buffer.byteLength(excerpt.excerpt) <= 12 * 1024);
});
