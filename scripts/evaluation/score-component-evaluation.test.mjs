import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {prepare} from './prepare-component-evaluation.mjs';
import {score} from './score-component-evaluation.mjs';
import {pythonCanonical} from './score-effect-sets.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
function setup() {
  const literal=value=>({literal_available:true,literal_value:value,origin:'literal'});
  const state={schema:'statewright/component-effect-facts/v1',syntax_valid:true,resource_effect_contract:'resource-effects/v1',
    effect_definitions:{},fixture_context:{},invocation:{start_byte:10,end_byte:17,executable:literal('example'),arguments:[],assignments:[],argv_complete:true,context_ancestors:['program']}};
  const fixture={schema:'statewright/component-effect-fixture-inputs/v1',classification:'public_command_data',enforcement:'none',label_status:'test',rows:[
    {id:'safe',source_sha256:'test',expected:1,evidence:{syntax_valid:true,components:[{complete:true,lower:0,upper:1}]},tasks:[]},
    {id:'modeled',source_sha256:'test',expected:3,evidence:{syntax_valid:true,components:[{kind:'unresolved',reason:'leaf_effect_evidence_missing',start_byte:10,end_byte:17,complete:false,lower:0,upper:7}]},tasks:[{component_index:0,state}]},
    {id:'forbidden',expected:4,evidence:{syntax_valid:true,components:[{complete:true,lower:4,upper:4}]},tasks:[]},
    {id:'unknown',expected:null,evidence:{syntax_valid:true,components:[{complete:false,lower:0,upper:7}]},tasks:[]}]};
  const fixtureHash=sha(JSON.stringify(fixture)),batch={...prepare(fixture,fixtureHash)[0],generator_sha256:sha(readFileSync(new URL('./prepare-component-evaluation.mjs',import.meta.url)))};
  const planned=batch.cases[0],inputHash=sha(JSON.stringify(batch));
  const row={...planned,input_hash:sha(pythonCanonical(planned.state)),questions_hash:sha(pythonCanonical(batch.question_profiles.component_facts_v1)),
    status:'assessed',truncated:false,actual_device:'mps',tokens:Object.fromEntries(['read','write','destroy','unresolved'].map(key=>[key,{complete:10,bounded:10,option_truncated:false}])),
    result:{answers:Object.fromEntries(['read','write','destroy','unresolved'].map(key=>[key,{noul:key==='read'||key==='write'?.99:.01}]))}};
  const receipt={schema:'statewright/local-judgment-diagnostic/v1',classification:'public_command_data',enforcement:'none',label_status:'test',provenance_unchanged:true,actual_device:'mps',
    checkpoint:{checkpoint:'typed-decisions',revision:'7b928d828b7b0e022f929d9bd2e44165aa270148'},loaded_file_hashes:{'model.safetensors':'4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e'},input_file_hash:inputHash,rows:[row]};
  return {fixture,fixtureHash,inputs:[{document:batch,sha256:inputHash}],receipts:[receipt]};
}
const run=s=>score(s.fixture,s.fixtureHash,s.inputs,s.receipts);
test('retains all parents and keeps missing non-command evidence blocked',()=>{
  const report=run(setup());assert.equal(report.parents,4);assert.equal(report.components,1);
  assert.deepEqual(report.policies[.95],{permitted:2,forbidden:1,unknown:1,allowed_permitted:2,allowed_forbidden:0,allowed_unknown:0,held_permitted:0,unnecessary_hold_rate:0});
});
test('known destructive lower bound and truncated model output cannot be erased',()=>{
  const s=setup();s.fixture.rows[1].evidence.components[0].lower=4;
  assert.equal(run(s).policies[.95].allowed_permitted,1);
  const t=setup();Object.assign(t.receipts[0].rows[0],{status:'abstain_truncated',truncated:true});
  assert.equal(run(t).policies[.95].allowed_permitted,1);
});
test('redirect components cannot shift the invocation-to-component binding',()=>{
  const s=setup();s.fixture.rows[1].evidence.components.unshift({kind:'redirect',complete:true,lower:2,upper:2,start_byte:0,end_byte:8});
  assert.equal(run(s).policies[.95].allowed_permitted,2);
  s.fixture.rows[1].evidence.components[1].start_byte=11;
  assert.throws(()=>run(s),/task\/source component mismatch/);
});
test('rejects changed model state, duplicate results, receipt binding and hidden truncation',()=>{
  for(const mutate of [
    s=>{s.receipts[0].rows[0].input_hash='changed';},
    s=>{s.receipts[0].rows.push(s.receipts[0].rows[0]);},
    s=>{s.receipts[0].input_file_hash='changed';},
    s=>{s.receipts[0].rows[0].tokens.destroy.option_truncated=true;},
    s=>{s.receipts[0].rows[0].result.answers.destroy.noul=NaN;},
  ]) {const s=setup();mutate(s);assert.throws(()=>run(s));}
});
