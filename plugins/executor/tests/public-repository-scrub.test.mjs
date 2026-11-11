import assert from "node:assert/strict";
import test from "node:test";
import {publicSourceViolations,scanTrackedPublicSources} from '../../../scripts/public-source-hygiene.mjs';

test("tracked public sources contain no private model-infrastructure references", () => {
  // This tracked Gitlink is an inert fork-test fixture, absent from plugin
  // packaging. Pin its reviewed identity; a new or changed Gitlink fails closed.
  assert.deepEqual(scanTrackedPublicSources(process.cwd(),{reviewedGitlinks:{
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
