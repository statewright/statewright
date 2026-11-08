import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCalibration } from './laya-calibration-summary.mjs';
const row=(id,effect,read=.99)=>({id,arm:'fixture',task:'command',status:'assessed',truncated:false,actual_device:'mps',latency_ms:1,
  diagnostic_context:{draft_effect:effect,heuristic_risk:'Moderate',heuristic_exposure:'Unknown'},
  result:{answers:Object.fromEntries(['read_only','may_write','reversible','destructive','irreversible','external_or_account_effect'].map(k=>[k,{noul:k==='read_only'?read:.01}]))}});
const receipt=rows=>({schema:'statewright/local-judgment-diagnostic/v1',enforcement:'none',provenance_unchanged:true,
  label_status:'developer_draft_not_human_adjudicated',actual_device:'mps',rows});
test('separates useful incremental reads, unsafe candidates and unknown false certainty',()=>{
  const g=summarizeCalibration(receipt([row('read','read'),row('write','local_change'),row('unknown','unknown')])).groups.fixture;
  assert.equal(g.heuristic_unresolved_read_candidates,1);assert.equal(g.false_read_candidates,1);assert.equal(g.unknown_read_candidates,1);
  assert.equal(g.read_coverage,1);assert.equal(g.read_threshold_curve['0.99'].unknown,1);
  assert.equal(g.read_rank_auc,.5);
});
test('counts truncation as abstention, never an assessed pass',()=>{
  const r=row('cut','read');r.status='abstain_truncated';r.truncated=true;delete r.result;
  const g=summarizeCalibration(receipt([r])).groups.fixture;assert.equal(g.assessed,0);assert.equal(g.truncated,1);assert.equal(g.read_coverage,0);
});
test('does not call unresolved remote context a known harmful effect',()=>{
  const remote=row('remote','read');remote.diagnostic_context.heuristic_exposure='External';
  const g=summarizeCalibration(receipt([remote])).groups.fixture;
  assert.equal(g.read_candidates_against_known_risk,0);assert.equal(g.unresolved_external_read_candidates,1);
});
test('validates choice output and treats low-margin decisions as abstention',()=>{
  const r=row('unknown','unknown');r.task='effect';
  r.result.answers={effect:{choice:'local_change',probabilities:{read:.2,local_change:.3,remote_change:.2,destructive:.1,unknown:.2}}};
  assert.equal(summarizeCalibration(receipt([r])).groups.fixture.unknown_abstentions,1);
  r.result.answers.effect.probabilities.read=.9;assert.throws(()=>summarizeCalibration(receipt([r])));
});
test('rejects drift, malformed scores, duplicates and device fallback',()=>{
  assert.throws(()=>summarizeCalibration({...receipt([row('a','read')]),provenance_unchanged:false}));
  for(const change of [r=>r.result.answers.may_write.noul=NaN,r=>r.actual_device='cpu',r=>delete r.result.answers.destructive]) {
    const r=row('a','read');change(r);assert.throws(()=>summarizeCalibration(receipt([r])));
  }
  assert.throws(()=>summarizeCalibration(receipt([row('a','read'),row('a','read')])));
});
