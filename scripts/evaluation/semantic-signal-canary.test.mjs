import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {prepareSignalCanary} from './prepare-semantic-signal-canary.mjs';
import {verifySignalCanary} from './verify-semantic-signal-canary.mjs';
import {pythonCanonical} from './score-effect-sets.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
function setup() {
  const inputs={},receipts={};
  for(const [device,planned]of Object.entries(prepareSignalCanary())) {
    const document={...planned,generator_sha256:hash(readFileSync(new URL('./prepare-semantic-signal-canary.mjs',import.meta.url)))};
    inputs[device]={document,sha256:hash(JSON.stringify(document))};
    receipts[device]={schema:'statewright/local-judgment-diagnostic/v1',classification:'public_synthetic',enforcement:'none',provenance_unchanged:true,
      actual_device:device,input_file_hash:inputs[device].sha256,
      checkpoint:{checkpoint:'typed-decisions',revision:'7b928d828b7b0e022f929d9bd2e44165aa270148'},
      loaded_file_hashes:{'model.safetensors':'4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e'},
      rows:document.cases.map(row=>{
        const questions=document.question_profiles[row.question_profile];
        return {...row,status:'assessed',truncated:false,actual_device:device,input_hash:hash(pythonCanonical(row.state)),questions_hash:hash(pythonCanonical(questions)),
          tokens:Object.fromEntries(Object.keys(questions).map(key=>[key,{option_truncated:false,bounded:10,complete:10}])),
          result:{answers:Object.fromEntries(Object.keys(questions).map(key=>[key,{noul:row.expected[key]===true?.9:.1}]))}};
      })};
  }
  return {inputs,receipts};
}
test('canary freezes public counterfactuals and scalar/device overlap without mixing command accuracy',()=>{
  const s=setup(),report=verifySignalCanary(s.inputs,s.receipts);
  assert.deepEqual(report.cases,{mps:10,cpu:4});assert.equal(report.cpu_mps_max_delta,0);
  assert.equal(report.scalar_multi_max_delta,0);assert.equal(report.explicit_write_true_minus_false,.8);
  for(const document of Object.values(s.inputs).map(input=>input.document))for(const row of document.cases)assert(!Object.hasOwn(row.state,'expected'));
});
test('verifier rejects state drift, wrong device, missing rows and hidden truncation',()=>{
  for(const mutate of [
    s=>{s.receipts.mps.rows[0].input_hash='changed';},
    s=>{s.receipts.cpu.actual_device='mps';},
    s=>{s.receipts.mps.rows.pop();},
    s=>{s.receipts.mps.rows[0].tokens.switch_on.complete=11;},
    s=>{s.receipts.cpu.loaded_file_hashes['model.safetensors']='changed';},
  ]) {const s=setup();mutate(s);assert.throws(()=>verifySignalCanary(s.inputs,s.receipts));}
});
