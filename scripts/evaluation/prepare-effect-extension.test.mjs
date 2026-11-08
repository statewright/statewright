import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

test('private preparation binds sanitized bytes and preserves privacy and unknown labels',async()=>{
  const root=await mkdtemp(join(tmpdir(),'effect-extension-test-'));
  try {
    const bytes=JSON.stringify({id:'abcdef0123456789',command:'fixture-tool --inspect',kind:'codex_orchestrator_literal',source_id:'fixture-source',line:4,redactions:[],evidence_loss:false})+'\n';
    const manifest={classification:'private_sanitized_local_only',candidates_sha256:createHash('sha256').update(bytes).digest('hex')};
    const labels={schema:'statewright/effect-extension-labels/v1',classification:'private_sanitized_local_only',selection:'Synthetic test data only',items:[['abcdef012345',null,'Unavailable fixture program body.']]};
    await writeFile(join(root,'candidates.jsonl'),bytes);
    await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));
    await writeFile(join(root,'labels.json'),JSON.stringify(labels));
    const run=output=>spawnSync(process.execPath,[new URL('./prepare-effect-extension.mjs',import.meta.url).pathname,root,join(root,'labels.json'),join(root,output)],{encoding:'utf8'});
    assert.equal(run('cases.json').status,0);
    const cases=JSON.parse(await readFile(join(root,'cases.json')));
    assert.equal(cases.classification,'private_sanitized_local_only');
    assert.deepEqual(cases.privacy,{raw_history_persisted:false,manual_sanitized_review:true,local_only:true});
    assert.equal(cases.cases[0].mask,null);assert.equal(cases.cases[0].kind,'codex_orchestrator_literal');
    assert.equal((await stat(join(root,'cases.json'))).mode&0o777,0o600);
    assert.notEqual(run('cases.json').status,0,'prior frozen output must not be overwritten');
    await writeFile(join(root,'candidates.jsonl'),bytes+' ');
    assert.notEqual(run('drift.json').status,0,'changed source bytes must fail binding');
  } finally {await rm(root,{recursive:true});}
});
