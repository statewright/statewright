import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {collectCommandEvidence} from '../../plugins/executor/lib/command-evidence.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const [binary,prefix]=process.argv.slice(2);assert(binary&&prefix,'owned compiled example and NEW receipt prefix required');
const identityPaths={collector:new URL('../../plugins/executor/lib/command-evidence.mjs',import.meta.url),
  harness:fileURLToPath(import.meta.url),binary};
const identities=async()=>Object.fromEntries(await Promise.all(Object.entries(identityPaths).map(async([key,path])=>[`${key}_sha256`,hash(await readFile(path))])));
const before=await identities();
const root=await mkdtemp('/Volumes/sidecar/build-tmp/statewright-native-body-contract-');
const definitions={read:['cat "$INPUT"'],write:['touch "$FILE"; cat "$INPUT"'],destroy:['rm fixture'],
  context:['PATH=/fixture/bin; cat fixture'],stale:['touch package.json','cat fixture'],unknown:['unknown-runner --inspect']};
const yaml='version: "3"\ntasks:\n'+Object.entries(definitions).map(([name,commands])=>
  `  ${name}:\n    cmds:\n`+commands.map(command=>`      - ${JSON.stringify(command)}\n`).join('')).join('');
await writeFile(`${root}/Taskfile.yml`,yaml,{flag:'wx',mode:0o600});
const cases=[];
for(const id of Object.keys(definitions)) {
  const input={cmd:`task ${id}`,workdir:root},evidence=await collectCommandEvidence('exec_command',input);
  assert.equal(evidence?.complete,true,`collector did not complete ${id}`);
  cases.push({id,input,evidence});
}
const stale=structuredClone(cases[0]);stale.id='expired';stale.evidence.collected_at_ms=0;cases.push(stale);
const bytes=JSON.stringify({schema:'statewright/native-body-contract-input/v1',classification:'public_synthetic',cases});
const inputPath=`${prefix}-input.json`;await writeFile(inputPath,bytes,{flag:'wx',mode:0o600});
const executed=spawnSync(binary,[],{input:bytes,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
assert.equal(executed.status,0,executed.stderr||executed.error?.message);
const output=JSON.parse(executed.stdout);assert.equal(output.input_sha256,hash(bytes));
assert.equal(output.schema,'statewright/native-body-contract-result/v1');
assert.equal(output.fixture_commands_executed,0);assert.equal(output.model_calls,0);
const expected={read:['BoundedLocalExecution',1],write:['LocalWriteAndBoundedLocalExecution',3],
  destroy:['DenyKnownRisk',null],context:['DenyUncertain',null],stale:['DenyUncertain',null],unknown:['DenyUncertain',null],expired:['DenyUncertain',null]};
assert.equal(output.rows.length,cases.length);const seen=new Set();
for(const row of output.rows) {
  assert(!seen.has(row.id));seen.add(row.id);assert(expected[row.id]);
  assert.equal(row.resolved_effect,expected[row.id][0],row.id);
  assert.equal(row.resource_bounds?.upper??null,expected[row.id][1],row.id);
  if(expected[row.id][1]!==null)assert(row.required_capability.includes('BoundedLocalExecution'));
}
assert.deepEqual(await identities(),before,'collector, harness or binary changed during assessment');
const receipt={...output,fixture_root:root,input_path:inputPath,input_sha256:hash(bytes),...before,
  pre_post_identity_unchanged:true,
  interpretation:'Real source collector to compiled Rust boundary on synthetic temporary files. No fixture command/workflow/model executed. Not installed/native-session/staging acceptance.'};
await writeFile(`${prefix}-result.json`,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
process.stdout.write(JSON.stringify({cases:output.rows.length,passed:true,receipt:`${prefix}-result.json`,fixture_root:root})+'\n');
