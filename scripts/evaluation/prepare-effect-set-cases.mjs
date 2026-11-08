import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {imported,synthetic,context} from './effect-set-cases.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const [root,output]=process.argv.slice(2);assert(root&&output);
const manifestBytes=await readFile(root+'/manifest.json');
const manifest=JSON.parse(manifestBytes),bytes=await readFile(root+'/commands.jsonl');
assert.equal(sha(bytes),manifest.corpus_sha256);
const rows=bytes.toString('utf8').trim().split('\n').map(JSON.parse),seen=new Set();
const cases=imported.map(([prefix,mask,reason])=>{
  const matches=rows.filter(row=>row.id.startsWith(prefix));assert.equal(matches.length,1);
  const row=matches[0];assert(!seen.has(row.id));seen.add(row.id);
  assert.equal(row.placeholders,false);
  return {id:row.id,command:row.command,mask,reason,source:row.source,source_revision:row.revision??row.source_revision,kind:'imported'};
});
for(const[id,command,mask,delegated_source]of synthetic) {
  const key='synthetic:'+id;assert(!seen.has(key));seen.add(key);
  cases.push({id:key,command,mask,reason:'Authored composition/unknown stress case under the explicit effect-set contract.',delegated_source,kind:'synthetic',source:'authored public fixture'});
}
assert(cases.every(row=>row.mask===null||Number.isInteger(row.mask)&&row.mask>=0&&row.mask<=7));
const result={schema:'statewright/public-effect-set-cases/v1',classification:'public_command_data',enforcement:'none',
  label_status:'agent_manual_development_labels_not_human_validated_not_blind',
  selection:'50 manually selected imported examples spanning utility families plus 30 authored combination/unknown cases; development set, not representative or held out.',
  corpus_sha256:sha(bytes),source_manifest_sha256:sha(manifestBytes),
  label_source_sha256:sha(await readFile(new URL('./effect-set-cases.mjs',import.meta.url))),context,cases};
await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({cases:cases.length,imported:imported.length,synthetic:synthetic.length,
  labels:Object.fromEntries([...new Set(cases.map(row=>row.mask))].map(mask=>[mask,cases.filter(row=>row.mask===mask).length])),sha256:sha(JSON.stringify(result))}));
