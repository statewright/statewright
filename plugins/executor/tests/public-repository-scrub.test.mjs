import assert from "node:assert/strict";
import test from "node:test";
import {execFileSync} from "node:child_process";
import {readFileSync,existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {resolve,dirname} from "node:path";
const root=fileURLToPath(new URL("../../../",import.meta.url));
import {publicSourceViolations,scanTrackedPublicSources} from '../../../scripts/public-source-hygiene.mjs';

test("tracked public sources contain no private model-infrastructure references", () => {
  // This tracked Gitlink is an inert fork-test fixture, absent from plugin
  // packaging. Pin its reviewed identity; a new or changed Gitlink fails closed.
  assert.deepEqual(scanTrackedPublicSources(root,{reviewedGitlinks:{
    'self-hosted/fixtures/fork-test':'d746ba3d43ac6142439b265da72255c1314d86de',
  }}), []);
});

test('privacy guard detects mixed-case paths, filenames and binary payloads',()=>{
 const term=['/Users/','ben'].join('');
 for(const value of [term,term.toLowerCase(),term.toUpperCase()]){
  assert(publicSourceViolations('fixture',value).length);
  assert(publicSourceViolations(value,'safe').length);
  assert(publicSourceViolations('fixture',Buffer.concat([Buffer.from([0]),Buffer.from(value)])).length);
 }
 assert(publicSourceViolations('fixture',['https://INTERNAL','enhasa','cloud'].join('.')).length);
 assert.deepEqual(publicSourceViolations('fixture','https://glitch.enhasa.cloud https://umami.enhasa.cloud /Users/tester/project'),[]);
});

test('privacy guard fails closed on unreadable, conflicted or unreviewed Git objects',()=>{
 const entry='100644 '+ 'a'.repeat(40)+' 0\tfixture';
 assert.throws(()=>scanTrackedPublicSources('.',{entries:[entry],read:()=>{throw Error('unreadable');}}),/unreadable/);
 for(const mode of ['160000','040000'])assert.throws(()=>scanTrackedPublicSources('.',{entries:[entry.replace('100644',mode)],read:()=>Buffer.alloc(0)}),/Unreviewed/);
 assert.throws(()=>scanTrackedPublicSources('.',{entries:[entry.replace(' 0\t',' 1\t')],read:()=>Buffer.alloc(0)}),/Unreviewed/);
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
