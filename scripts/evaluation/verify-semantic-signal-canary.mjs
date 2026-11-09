import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {prepareSignalCanary} from './prepare-semantic-signal-canary.mjs';
import {pythonCanonical} from './score-effect-sets.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function verifySignalCanary(inputs,receipts) {
  const planned=prepareSignalCanary(),indexed={};let identity;
  for(const device of ['mps','cpu']) {
    const input=inputs[device],receipt=receipts[device];
    assert.deepEqual(input.document,{...planned[device],generator_sha256:hash(readFileSync(new URL('./prepare-semantic-signal-canary.mjs',import.meta.url)))});
    assert.equal(receipt.input_file_hash,input.sha256);assert.equal(receipt.actual_device,device);
    assert.equal(receipt.schema,'statewright/local-judgment-diagnostic/v1');assert.equal(receipt.classification,'public_synthetic');
    assert.equal(receipt.enforcement,'none');assert.equal(receipt.provenance_unchanged,true);
    assert.equal(receipt.checkpoint.revision,'7b928d828b7b0e022f929d9bd2e44165aa270148');
    assert.equal(receipt.checkpoint.checkpoint,'typed-decisions');
    assert.equal(receipt.loaded_file_hashes['model.safetensors'],'4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e');
    const current=[receipt.harness_hash,receipt.runtime_source_hashes,receipt.loaded_file_hashes];
    if(identity)assert.deepEqual(current,identity,'device comparison changed runtime/checkpoint');identity=current;
    assert.equal(receipt.rows.length,input.document.cases.length);const seen=new Set();indexed[device]=new Map();
    for(const row of receipt.rows) {
      const key=`${row.arm}/${row.id}`;assert(!seen.has(key));seen.add(key);
      const source=input.document.cases.find(c=>c.id===row.id&&c.arm===row.arm);assert(source);
      assert.equal(row.status,'assessed');assert.equal(row.truncated,false);assert.equal(row.actual_device,device);
      assert.equal(row.input_hash,hash(pythonCanonical(source.state)));assert.deepEqual(row.expected,source.expected);
      assert.equal(row.question_profile,source.question_profile);
      const questions=input.document.question_profiles[source.question_profile];
      assert.equal(row.questions_hash,hash(pythonCanonical(questions)));
      assert.deepEqual(Object.keys(row.result.answers).sort(),Object.keys(questions).sort());
      for(const name of Object.keys(questions)) {
        const value=row.result.answers[name].noul;assert(Number.isFinite(value)&&value>=0&&value<=1);
        assert.equal(row.tokens[name].option_truncated,false);assert.equal(row.tokens[name].complete,row.tokens[name].bounded);
      }
      indexed[device].set(key,row.result.answers);
    }
  }
  const get=(arm,id,axis,device='mps')=>indexed[device].get(`${arm}/${id}`)[axis].noul;
  const scalarDelta=Math.max(...[true,false].map(on=>Math.abs(get('binary_scalar',`switch-${on}`,'switch_on')-get('binary_multi',`switch-${on}`,'switch_on'))));
  let deviceDelta=0;
  for(const [key,answers]of indexed.cpu)for(const name of Object.keys(answers))deviceDelta=Math.max(deviceDelta,Math.abs(answers[name].noul-indexed.mps.get(key)[name].noul));
  return {schema:'statewright/semantic-signal-diagnostic/v1',enforcement:'none',model_identity:identity,
    cases:{mps:indexed.mps.size,cpu:indexed.cpu.size},scalar_multi_max_delta:scalarDelta,cpu_mps_max_delta:deviceDelta,
    switch_on_off_delta:get('binary_scalar','switch-true','switch_on')-get('binary_scalar','switch-false','switch_on'),
    explicit_write_true_minus_false:get('explicit_facts','facts-write','write')-get('explicit_facts','facts-read','write'),
    script_destroy_delta:get('script_evidence','script-destroy','destroy')-get('script_evidence','script-read','destroy'),
    missing_body_unresolved_delta:get('script_evidence','script-missing','unresolved')-get('script_evidence','script-read','unresolved'),
    interpretation:'Contract responsiveness diagnostic, not accuracy/calibration or model qualification. Scalar/device agreement on these controls is not proof of general runtime correctness. Inspect fact ordering and missing-evidence sensitivity before any calibration; do not lower admission thresholds to compensate.'};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const [inputPrefix,resultPrefix,output]=process.argv.slice(2);assert(inputPrefix&&resultPrefix&&output);
  const inputs={},receipts={},artifacts=[];
  for(const device of ['mps','cpu']) {
    const inputPath=`${inputPrefix}-${device}.json`,resultPath=`${resultPrefix}-${device}.json`,inputBytes=readFileSync(inputPath),resultBytes=readFileSync(resultPath);
    inputs[device]={document:JSON.parse(inputBytes),sha256:hash(inputBytes)};receipts[device]=JSON.parse(resultBytes);
    artifacts.push({device,input_path:inputPath,input_sha256:hash(inputBytes),result_path:resultPath,result_sha256:hash(resultBytes)});
  }
  const result=verifySignalCanary(inputs,receipts);
  writeFileSync(output,JSON.stringify({...result,artifacts,verifier_sha256:hash(readFileSync(fileURLToPath(import.meta.url)))},null,2)+'\n',{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify(result)+'\n');
}
