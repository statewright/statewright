import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {prepare} from './prepare-component-evaluation.mjs';
import {pythonCanonical,rankAuc} from './score-effect-sets.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const axes=['read','write','destroy','unresolved'];
const probability=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;

export function score(fixture,fixtureHash,inputs,receipts) {
  const planned=prepare(fixture,fixtureHash);
  assert.equal(inputs.length,planned.length);assert.equal(receipts.length,planned.length);
  const predictions=new Map();let identity;
  for(let i=0;i<planned.length;i++) {
    const {document,sha256}=inputs[i],receipt=receipts[i];
    assert.deepEqual(document,{...planned[i],generator_sha256:sha(readFileSync(new URL('./prepare-component-evaluation.mjs',import.meta.url)))});
    assert.equal(receipt.input_file_hash,sha256);
    assert.equal(receipt.schema,'statewright/local-judgment-diagnostic/v1');
    assert.equal(receipt.classification,'public_command_data');assert.equal(receipt.enforcement,'none');
    assert.equal(receipt.label_status,fixture.label_status);assert.equal(receipt.provenance_unchanged,true);
    assert.equal(receipt.actual_device,'mps');
    assert.equal(receipt.checkpoint.checkpoint,'typed-decisions');
    assert.equal(receipt.checkpoint.revision,'7b928d828b7b0e022f929d9bd2e44165aa270148');
    assert.equal(receipt.loaded_file_hashes['model.safetensors'],'4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e');
    const current=JSON.stringify([receipt.harness_hash,receipt.runtime_source_hashes,receipt.loaded_file_hashes]);
    if(identity!==undefined)assert.equal(current,identity,'runtime drift');identity=current;
    assert.equal(receipt.rows.length,document.cases.length);
    const cases=new Map(document.cases.map(row=>[row.id,row]));
    for(const row of receipt.rows) {
      const expected=cases.get(row.id);assert(expected,'unplanned component');
      assert(!predictions.has(row.id),'duplicate component');
      assert.equal(row.arm,expected.arm);assert.equal(row.task,'axes');assert.equal(row.question_profile,expected.question_profile);
      assert.deepEqual(row.expected,expected.expected);assert.deepEqual(row.source,expected.source);
      assert.equal(row.input_hash,sha(pythonCanonical(expected.state)));
      assert.equal(row.questions_hash,sha(pythonCanonical(document.question_profiles.component_facts_v1)));
      if(row.status==='assessed') {
        assert.equal(row.truncated,false);assert.equal(row.actual_device,'mps');
        assert.deepEqual(Object.keys(row.result.answers).sort(),[...axes].sort());
        for(const axis of axes) {
          assert(probability(row.result.answers[axis].noul));
          assert.equal(row.tokens[axis].option_truncated,false);
          assert.equal(row.tokens[axis].bounded,row.tokens[axis].complete);
        }
      } else {assert.equal(row.status,'abstain_truncated');assert.equal(row.truncated,true);}
      predictions.set(row.id,row);
    }
  }
  const parents=fixture.rows.map(parent=>{
    let outside=0,structuralMissing=!parent.evidence.syntax_valid,destroy=0,unresolved=0;
    const tasksBySpan=new Map();
    for(const task of parent.tasks) {
      const invocation=task.state.invocation;
      assert(Number.isInteger(invocation.start_byte)&&Number.isInteger(invocation.end_byte)&&invocation.end_byte>invocation.start_byte);
      const span=`${invocation.start_byte}:${invocation.end_byte}`;
      assert(!tasksBySpan.has(span),'duplicate invocation span');tasksBySpan.set(span,task);
      assert.equal(parent.evidence.components.filter(component=>component.reason==='leaf_effect_evidence_missing'&&component.start_byte===invocation.start_byte&&component.end_byte===invocation.end_byte&&!component.complete).length,1,'task/source component mismatch');
    }
    for(const component of parent.evidence.components) {
      if(component.lower&4)outside=1;
      if(component.complete) {if(component.upper&4)outside=1;continue;}
      const task=component.reason==='leaf_effect_evidence_missing'?tasksBySpan.get(`${component.start_byte}:${component.end_byte}`):undefined;
      if(!task){structuralMissing=true;continue;}
      const result=predictions.get(`${parent.id}:${task.component_index}`);assert(result,'missing component result');
      if(result.status!=='assessed'){structuralMissing=true;continue;}
      const answers=result.result.answers;
      // Union bound, not an independence/product assumption or calibrated confidence.
      outside=Math.min(1,outside+answers.destroy.noul+answers.unresolved.noul);
      destroy=Math.max(destroy,answers.destroy.noul);unresolved=Math.max(unresolved,answers.unresolved.noul);
    }
    return {id:parent.id,expected:parent.expected,structural_missing:structuralMissing,
      compatibility_score:structuralMissing?0:1-outside,destroy_score:destroy,unresolved_score:unresolved,tasks:parent.tasks.length};
  });
  const policies={};
  for(const threshold of [.5,.75,.9,.95,.99]) {
    const totals={permitted:0,forbidden:0,unknown:0,allowed_permitted:0,allowed_forbidden:0,allowed_unknown:0,held_permitted:0};
    for(const row of parents) {
      const kind=row.expected===null?'unknown':(row.expected&4)?'forbidden':'permitted';totals[kind]++;
      const allow=!row.structural_missing&&row.compatibility_score>=threshold;
      if(allow)totals[`allowed_${kind}`]++;else if(kind==='permitted')totals.held_permitted++;
    }
    totals.unnecessary_hold_rate=totals.held_permitted/totals.permitted;policies[threshold]=totals;
  }
  const modeled=parents.filter(row=>row.tasks>0);
  const ranges=Object.fromEntries(axes.map(axis=>{
    const values=[...predictions.values()].filter(row=>row.status==='assessed').map(row=>row.result.answers[axis].noul);
    return [axis,{min:Math.min(...values),max:Math.max(...values),mean:values.reduce((a,b)=>a+b,0)/values.length}];
  }));
  return {schema:'statewright/component-fact-development-score/v1',enforcement:'none',classification:'public_command_data',
    input_sha256:fixtureHash,compiled_source_sha256:fixture.compiled_source_sha256,
    model_identity:JSON.parse(identity),batch_input_sha256:inputs.map(input=>input.sha256),
    receipt_canonical_sha256:receipts.map(receipt=>sha(pythonCanonical(receipt))),
    label_status:fixture.label_status,components:predictions.size,parents:parents.length,
    assessed:[...predictions.values()].filter(row=>row.status==='assessed').length,
    ranking:{destroy_auc:rankAuc(modeled.filter(row=>row.expected!==null).map(row=>[Boolean(row.expected&4),row.destroy_score])),
      unresolved_auc:rankAuc(modeled.map(row=>[row.expected===null,row.unresolved_score]))},
    ranges,policies,rows:parents,
    interpretation:'Uncalibrated development component-effect projection only; not Rust/native authorization, independent holdout or production accuracy. All source parents retained. Other authority/location gates are not modeled.'};
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const [fixturePath,expectedHash,inputPrefix,resultPrefix,output]=process.argv.slice(2);
  assert(fixturePath&&expectedHash&&inputPrefix&&resultPrefix&&output,'expected fixture, SHA256, input prefix, result prefix, NEW output');
  const bytes=readFileSync(fixturePath);assert.equal(sha(bytes),expectedHash);
  const fixture=JSON.parse(bytes),count=prepare(fixture,expectedHash).length,inputs=[],receipts=[],artifacts=[];
  for(let i=1;i<=count;i++) {
    const data=readFileSync(`${inputPrefix}-batch-${i}.json`);
    inputs.push({document:JSON.parse(data),sha256:sha(data)});
    const receiptPath=`${resultPrefix}-batch-${i}.json`,receiptBytes=readFileSync(receiptPath);
    receipts.push(JSON.parse(receiptBytes));
    artifacts.push({input_path:`${inputPrefix}-batch-${i}.json`,input_sha256:sha(data),receipt_path:receiptPath,receipt_sha256:sha(receiptBytes)});
  }
  const report=score(fixture,expectedHash,inputs,receipts);
  writeFileSync(output,JSON.stringify({...report,artifacts,scorer_sha256:sha(readFileSync(fileURLToPath(import.meta.url)))},null,2)+'\n',{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify({components:report.components,ranking:report.ranking,ranges:report.ranges,policies:report.policies})+'\n');
}
