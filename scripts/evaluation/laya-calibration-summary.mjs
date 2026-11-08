// Offline diagnostic analysis only. Never changes model or enforcement policy.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const fields=['read_only','may_write','reversible','destructive','irreversible','external_or_account_effect'];
const effects=['read','local_change','remote_change','destructive','unknown'];
const score=value=>typeof value==='number' && Number.isFinite(value) && value>=0 && value<=1;
const p95=values=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]:null;

export function summarizeCalibration(receipt) {
  assert.equal(receipt.schema,'statewright/local-judgment-diagnostic/v1');
  assert.equal(receipt.enforcement,'none');
  assert.equal(receipt.provenance_unchanged,true);
  assert.equal(receipt.label_status,'developer_draft_not_human_adjudicated');
  assert(Array.isArray(receipt.rows) && receipt.rows.length>0);
  const groups={},seen=new Set();
  for (const row of receipt.rows) {
    const identity=`${row.arm}/${row.id}`;
    assert(!seen.has(identity),'duplicate case');seen.add(identity);
    const group=groups[row.arm]??={cases:0,assessed:0,truncated:0,read_cases:0,nonread_cases:0,unknown_cases:0,
      raw_false_read:0,raw_missed_read:0,accepted_reads:0,false_read_candidates:0,unknown_read_candidates:0,
      heuristic_unresolved_read_candidates:0,read_candidates_already_proven:0,read_candidates_against_known_risk:0,
      unresolved_external_read_candidates:0,other_unresolved_read_candidates:0,
      unknown_abstentions:0,errors:[],latencies:[],read_scores:[],nonread_scores:[],read_threshold_curve:Object.fromEntries([.5,.75,.9,.95,.99].map(t=>[t,{accepted:0,false_read:0,unknown:0}]))};
    group.cases++;
    const expected=row.diagnostic_context?.draft_effect;
    assert(effects.includes(expected),'missing draft label');
    if(expected==='read')group.read_cases++;else if(expected==='unknown')group.unknown_cases++;else group.nonread_cases++;
    if(row.status==='abstain_truncated' && row.truncated===true) {group.truncated++;continue;}
    assert.equal(row.status,'assessed');assert.equal(row.truncated,false);
    assert.equal(row.actual_device,receipt.actual_device);
    assert(Number.isFinite(row.latency_ms)&&row.latency_ms>=0);
    const answers=row.result?.answers;
    assert(answers && typeof answers==='object');
    let readScore,otherSafe,rawRead,abstained;
    if(row.task==='effect') {
      assert.deepEqual(Object.keys(answers),['effect']);
      const answer=answers.effect,dist=answer.probabilities;
      assert.deepEqual(Object.keys(dist).sort(),[...effects].sort());
      assert(Object.values(dist).every(score));
      assert(Math.abs(Object.values(dist).reduce((a,b)=>a+b,0)-1)<.001);
      assert(effects.includes(answer.choice));
      assert.equal(dist[answer.choice],Math.max(...Object.values(dist)));
      readScore=dist.read;
      otherSafe=dist.read-Math.max(...effects.filter(e=>e!=='read').map(e=>dist[e]))>=.2;
      const ordered=Object.values(dist).sort((a,b)=>b-a);
      rawRead=answer.choice==='read';abstained=answer.choice==='unknown'||ordered[0]<.9||ordered[0]-ordered[1]<.2;
    } else {
      assert.equal(row.task,'command');
      assert.deepEqual(Object.keys(answers).sort(),[...fields].sort());
      for(const field of fields)assert(score(answers[field]?.noul),'invalid complete answer');
      readScore=answers.read_only.noul;
      otherSafe=answers.may_write.noul<=.1 && answers.destructive.noul<=.05
        && answers.irreversible.noul<=.05 && answers.external_or_account_effect.noul<=.05;
      rawRead=readScore>=.5;abstained=!otherSafe||readScore<.9;
    }
    group.assessed++;group.latencies.push(row.latency_ms);
    if(expected==='read')group.read_scores.push(readScore);
    else if(expected!=='unknown')group.nonread_scores.push(readScore);
    const candidate=readScore>=.9 && otherSafe;
    if(expected==='read'&&!rawRead)group.raw_missed_read++;
    if(!['read','unknown'].includes(expected)&&rawRead)group.raw_false_read++;
    if(expected==='unknown'&&abstained)group.unknown_abstentions++;
    for(const [threshold,counts] of Object.entries(group.read_threshold_curve)) {
      if(readScore<Number(threshold)||!otherSafe)continue;
      counts.accepted++;
      if(expected==='unknown')counts.unknown++;else if(expected!=='read')counts.false_read++;
    }
    if(candidate) {
      group.accepted_reads++;
      if(expected==='unknown')group.unknown_read_candidates++;
      else if(expected!=='read')group.false_read_candidates++;
      else if(row.diagnostic_context.heuristic_risk==='Low')group.read_candidates_already_proven++;
      else if(row.diagnostic_context.heuristic_risk==='Moderate' && row.diagnostic_context.heuristic_exposure==='Unknown')group.heuristic_unresolved_read_candidates++;
      else if(['High','Critical'].includes(row.diagnostic_context.heuristic_risk))group.read_candidates_against_known_risk++;
      else if(row.diagnostic_context.heuristic_exposure==='External')group.unresolved_external_read_candidates++;
      else group.other_unresolved_read_candidates++;
    }
    if((candidate&&expected!=='read')||(expected==='read'&&!candidate))group.errors.push({id:row.id,expected,read_score:readScore,candidate});
  }
  for(const group of Object.values(groups)) {
    group.p95_ms=p95(group.latencies);delete group.latencies;
    const pairs=group.read_scores.length*group.nonread_scores.length;
    group.read_rank_auc=pairs?group.read_scores.reduce((sum,r)=>sum+group.nonread_scores.reduce((n,w)=>n+(r>w?1:r===w?.5:0),0),0)/pairs:null;
    delete group.read_scores;delete group.nonread_scores;
    group.read_coverage=group.read_cases?(group.accepted_reads-group.false_read_candidates-group.unknown_read_candidates)/group.read_cases:null;
  }
  return {schema:'statewright/laya-calibration-diagnostic/v1',enforcement:'none',
    label_status:receipt.label_status,validation_status:'diagnostic_not_release_calibration',
    interpretation:'Independent uncalibrated judgments. Draft synthetic labels; no held-out human validation. Candidates are hypothetical, not permissions, and still require actual Rust structural/capability/authority checks. Threshold curves must not be used to select a production threshold on this same set.',
    read_candidate_policy:{noul:'read>=.9, local_write<=.1, destructive/irreversible/remote_change<=.05',choice:'read>=.9 and margin>=.2; diagnostic only'},
    groups};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [input,output]=process.argv.slice(2);assert(input&&output,'input receipt and new output required');
  const bytes=await readFile(input);assert(bytes.length<=4*1024*1024);
  const result={...summarizeCalibration(JSON.parse(bytes)),input_sha256:createHash('sha256').update(bytes).digest('hex')};
  await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  for(const [arm,{errors,read_threshold_curve,...counts}] of Object.entries(result.groups))console.log(JSON.stringify({arm,...counts,errors:errors.length}));
}
