import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function scoreRows(rows,labels) {
  assert.equal(labels.schema,'statewright/classifier-pilot-labels/v1');
  const seen=new Set(),matrix={},byId=new Map();
  for(const row of rows) {
    assert(typeof row.id==='string'&&!seen.has(row.id),'missing/duplicate case ID');seen.add(row.id);byId.set(row.id,row);
    assert.equal(row.execution,'none');assert.equal(row.policy,'fixed_read_only_capabilities');
    assert(['allow','deny','error'].includes(row.historical_disposition));
    assert(['allow','deny','review'].includes(row.current_disposition));
    const key=`${row.historical_disposition}/${row.current_disposition}`;matrix[key]=(matrix[key]??0)+1;
  }
  const expected={allow:0,deny:0,review:0};
  const totals=Object.fromEntries(['historical','current'].map(name=>[name,{allowed_reads:0,needless_holds:0,forbidden_autoallow:0,unknown_autoallow:0,errors:0,exact_disposition_correct:0}]));
  const resolved=new Set(),errors=[];
  for(const [prefix,want,reason]of labels.labels) {
    assert(typeof prefix==='string'&&prefix.length>=12&&Object.hasOwn(expected,want)&&typeof reason==='string');
    const matches=[...byId.keys()].filter(id=>id.startsWith(prefix));assert.equal(matches.length,1,'label prefix must uniquely resolve');
    const id=matches[0];assert(!resolved.has(id),'duplicate label');resolved.add(id);expected[want]++;
    const row=byId.get(id);
    for(const name of ['historical','current']) {
      const actual=row[`${name}_disposition`],total=totals[name];
      if(actual==='allow'&&want==='allow')total.allowed_reads++;
      if(actual!=='allow'&&want==='allow')total.needless_holds++;
      if(actual==='allow'&&want==='deny')total.forbidden_autoallow++;
      if(actual==='allow'&&want==='review')total.unknown_autoallow++;
      if(actual==='error')total.errors++;
      if(actual===want)total.exact_disposition_correct++;
      else errors.push({id,system:name,expected:want,actual,reason});
    }
  }
  return {schema:'statewright/classifier-pilot-score/v1',execution:'none',adjudication:labels.adjudication,
    interpretation:'Agent-reviewed biased development pilot, not human-validated, blinded, held-out or population escape-rate evidence. Fixed classifier capability projection, not full gateway/native acceptance.',
    corpus_rows:rows.length,unlabelled_matrix:matrix,labelled_cases:resolved.size,expected,totals,errors};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [root,replay,labelFile,output]=process.argv.slice(2);assert(root&&replay&&labelFile&&output);
  const manifest=JSON.parse(await readFile(root+'/manifest.json'));
  const corpus=await readFile(root+'/commands.jsonl');assert.equal(sha(corpus),manifest.corpus_sha256);
  const labelBytes=await readFile(labelFile),labels=JSON.parse(labelBytes);assert.equal(labels.corpus_sha256,manifest.corpus_sha256);
  const replayBytes=await readFile(replay);assert(replayBytes.length<64*1024*1024);
  const rows=replayBytes.toString('utf8').trim().split('\n').map(line=>JSON.parse(line));
  const corpusIds=corpus.toString('utf8').trim().split('\n').map(line=>JSON.parse(line).id).sort();
  assert.deepEqual(rows.map(row=>row.id).sort(),corpusIds,'replay coverage differs from frozen corpus');
  const report={...scoreRows(rows,labels),corpus_sha256:sha(corpus),replay_sha256:sha(replayBytes),labels_sha256:sha(labelBytes)};
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  const {errors,...counts}=report;console.log(JSON.stringify({...counts,errors:errors.length}));
}
