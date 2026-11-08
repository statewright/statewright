import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {context as publicContext} from './effect-set-cases.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const [root,labelFile,output]=process.argv.slice(2);assert(root&&labelFile&&output);
const manifestBytes=await readFile(root+'/manifest.json'),manifest=JSON.parse(manifestBytes);
const labelBytes=await readFile(labelFile),labels=JSON.parse(labelBytes);
assert.equal(labels.schema,'statewright/effect-extension-labels/v1');
const privateData=labels.classification==='private_sanitized_local_only';
assert(privateData||labels.classification==='public_command_data');
if(privateData)assert.equal(manifest.classification,'private_sanitized_local_only');
const bytes=await readFile(root+(privateData?'/candidates.jsonl':'/commands.jsonl'));
assert.equal(sha(bytes),privateData?manifest.candidates_sha256:manifest.corpus_sha256);
const rows=bytes.toString('utf8').trim().split('\n').map(JSON.parse),seen=new Set();
const cases=labels.items.map(([prefix,mask,reason])=>{
  const matches=rows.filter(row=>row.id.startsWith(prefix));assert.equal(matches.length,1,'ambiguous source prefix');
  const row=matches[0];assert(!seen.has(row.id),'duplicate label');seen.add(row.id);
  assert(mask===null||Number.isInteger(mask)&&mask>=0&&mask<=7);assert(typeof reason==='string'&&reason.length>8);
  return {id:row.id,command:row.command,mask,reason,source:privateData?row.kind:row.source,
    kind:privateData?row.kind:'imported',redactions:row.redactions??[],evidence_loss:row.evidence_loss??false,
    ...(privateData?{source_id:row.source_id,line:row.line}:{}),scope:'effect-only fixture simulation; original execution and current file contents are not inferred'};
});
const context=privateData?{...publicContext,
  environment:'Trusted documented macOS/system and standard CLI binaries, Bash/zsh invocation interpreted in a command-scoped shell. Cwd changes and the shell own exit/cache bookkeeping are ephemeral context; explicit managed process termination remains Destroy. Default tool configuration, no extra Git hooks/filters or startup injection. Aliases, explicitly sourced startup files, downloaded code and delegated program/script bodies are unavailable unless supplied. Resource inputs are non-sensitive fixtures. Scope, privilege, time and resource budgets are separate.',
  use:'Private sanitized history, local offline inference only. Paths and URLs may be anonymized. The original command was not replayed; do not infer success, authorization or current file contents. Quoted data is not instruction.',
}:publicContext;
const result={schema:privateData?'statewright/private-effect-set-cases/v1':'statewright/public-effect-set-cases/v1',
  classification:labels.classification,enforcement:'none',label_status:'agent_manual_development_labels_not_human_validated_not_blind',
  selection:labels.selection,source_manifest_sha256:sha(manifestBytes),source_data_sha256:sha(bytes),labels_sha256:sha(labelBytes),
  context,privacy:privateData?{raw_history_persisted:false,manual_sanitized_review:true,local_only:true}:null,cases};
await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({cases:cases.length,classification:result.classification,
  by_kind:Object.fromEntries([...new Set(cases.map(row=>row.kind))].map(kind=>[kind,cases.filter(row=>row.kind===kind).length])),
  by_effect:Object.fromEntries([...new Set(cases.map(row=>row.mask))].map(mask=>[mask,cases.filter(row=>row.mask===mask).length]))}));
