import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {prepareFacetCanary,verifyFacetCanary,facets} from './behavior-facet-canary.mjs';
import {pythonCanonical} from './score-effect-sets.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
function setup() {
  const input={...prepareFacetCanary(),generator_sha256:hash(readFileSync(new URL('./behavior-facet-canary.mjs',import.meta.url)))};
  const inputHash=hash(JSON.stringify(input));
  const receipt={schema:'statewright/local-judgment-diagnostic/v1',classification:'public_synthetic',enforcement:'none',provenance_unchanged:true,actual_device:'mps',input_file_hash:inputHash,
    checkpoint:{checkpoint:'typed-decisions',revision:'7b928d828b7b0e022f929d9bd2e44165aa270148'},
    loaded_file_hashes:{'model.safetensors':'4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e'},
    rows:input.cases.map(row=>({...row,status:'assessed',truncated:false,actual_device:'mps',
      input_hash:hash(pythonCanonical(row.state)),questions_hash:hash(pythonCanonical(input.question_profiles.facets)),
      tokens:Object.fromEntries(Object.keys(facets).map(key=>[key,{complete:10,bounded:10,option_truncated:false}])),
      result:{answers:Object.fromEntries(Object.keys(facets).map(key=>[key,{noul:row.expected[key]===null?.5:row.expected[key]?.9:.1}]))}}))};
  return {input,inputHash,receipt};
}
test('facets are overlapping observations; missing script effects remain unknown outside the model',()=>{
  const {input}=setup();assert.equal(input.cases.length,18);assert.equal(Object.keys(facets).length,8);
  const body=input.cases.find(row=>row.id==='execute'&&row.arm==='behavior_description');
  assert.equal(body.state.evidence_complete,false);assert.equal(body.expected.delegate_execution,true);
  assert.equal(body.expected.remove_resource,null);assert(!Object.hasOwn(body.state,'expected'));
  assert.equal(input.cases.find(row=>row.id==='permissions').expected.update_resource,true);
});
test('verified synthetic oracle has no ordering inversions without claiming qualification',()=>{
  const s=setup(),report=verifyFacetCanary(s.input,s.inputHash,s.receipt);
  for(const arm of Object.values(report.contrasts))for(const facet of Object.values(arm))assert.equal(facet.pairwise_inversions,0);
  assert.equal(report.cases,18);assert.equal(report.enforcement,'none');
});
test('changed identities, duplicate rows, truncation and invalid probabilities fail verification',()=>{
  for(const mutate of [
    s=>{s.receipt.rows[0].input_hash='changed';},
    s=>{s.receipt.rows[1]=s.receipt.rows[0];},
    s=>{s.receipt.rows[0].tokens.reset_state.complete=11;},
    s=>{s.receipt.rows[0].result.answers.remove_resource.noul=Infinity;},
    s=>{s.receipt.input_file_hash='changed';},
    s=>{s.input.cases[0].expected.reset_state=true;},
  ]) {const s=setup();mutate(s);assert.throws(()=>verifyFacetCanary(s.input,s.inputHash,s.receipt));}
});
