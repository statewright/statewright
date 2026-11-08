import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const masks={none:0,read:1,write:2,read_write:3,destroy:4,read_destroy:5,write_destroy:6,read_write_destroy:7};
const fields=['read_only','may_write','reversible','destructive','irreversible','external_or_account_effect'];
const arms=['current_provider_six','literal_six','literal_effect_axes','literal_effect_sets'];
const thresholds=[.5,.75,.9,.95,.99];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const probability=p=>typeof p==='number'&&Number.isFinite(p)&&p>=0&&p<=1;
const subset=(required,allowed)=>(required&~allowed)===0;
const profiles={current_provider_six:'six',literal_six:'six',literal_effect_axes:'axes',literal_effect_sets:'sets'};
// Match the pinned Python harness's json.dumps(sort_keys=True, ensure_ascii=False).
export const pythonCanonical=value=>Array.isArray(value)?'['+value.map(pythonCanonical).join(', ')+']':
  value!==null&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+': '+pythonCanonical(value[key])).join(', ')+'}':JSON.stringify(value);

export function heuristicBounds(raw) {
  assert(typeof raw.classes==='string');
  // Existing risk/capability labels do not establish exact resource effects:
  // Destructive includes find -exec reads; FileWrite includes rsync --delete;
  // SafeOutput includes metadata readers. Preserve the existing complete
  // read-only decision as a conservative upper bound. Other effects need a
  // future typed structural contract, not a rename of these legacy labels.
  const complete=raw.syntax_valid&&raw.current_effect==='ReadOnly';
  return {lower:0,upper:complete?1:7,complete,syntax_valid:raw.syntax_valid};
}

export function rankAuc(points) {
  const positive=points.filter(([truth])=>truth).map(([,p])=>p),negative=points.filter(([truth])=>!truth).map(([,p])=>p);
  if(!positive.length||!negative.length)return null;
  return positive.reduce((sum,a)=>sum+negative.reduce((n,b)=>n+(a>b?1:a===b?.5:0),0),0)/(positive.length*negative.length);
}

export function validateBatch(corpus,receipt,input) {
  const document=input.document;
  const privateData=corpus.classification==='private_sanitized_local_only';
  assert.equal(document.schema,privateData?'statewright/private-effect-set-evaluation/v1':'statewright/public-effect-set-evaluation/v1');
  assert.equal(document.classification,privateData?'private_sanitized_local_only':'public_command_data');
  if(privateData) {
    assert.equal(receipt.classification,'private_sanitized_local_only');
    assert.deepEqual(receipt.privacy,corpus.privacy,'private handling label changed');
  }
  assert.deepEqual(document.source_cases,corpus,'source corpus binding changed');
  assert.equal(receipt.input_file_hash,input.sha256,'receipt does not bind these input bytes');
  const planned=new Map(document.cases.map(row=>[row.arm+'/'+row.id,row]));
  assert.equal(planned.size,document.cases.length);assert.equal(receipt.rows.length,planned.size);
  assert.deepEqual(Object.keys(document.question_profiles.axes).sort(),['read','write','destroy','unresolved'].sort());
  assert.deepEqual(Object.keys(document.question_profiles.sets.effect_set.criteria).sort(),[...Object.keys(masks),'unresolved'].sort());
  assert.deepEqual(Object.keys(document.question_profiles.six).sort(),[...fields].sort());
  for(const row of receipt.rows) {
    const expected=planned.get(row.arm+'/'+row.id);assert(expected,'receipt contains unplanned case');
    const profile=profiles[row.arm];assert(profile,'unknown arm');
    assert.equal(expected.question_profile,profile);assert.equal(expected.task,profile);
    assert.equal(row.question_profile,profile);assert.equal(row.task,profile);
    assert.equal(row.input_hash,sha(pythonCanonical(expected.state)),'model state binding changed');
    assert.equal(row.questions_hash,sha(pythonCanonical(document.question_profiles[profile])),'model questions binding changed');
    assert.deepEqual(row.heuristic,expected.heuristic);assert.deepEqual(row.expected,expected.expected);
    if(row.arm!=='current_provider_six') {
      const source=corpus.cases.find(item=>item.id===row.id);assert(source);
      assert.equal(expected.state.invocation,source.command,'literal command differs from labeled source');
      assert.deepEqual(expected.state.delegated_source,source.delegated_source??null);
    }
  }
}

export function compatible(row,allowed,threshold) {
  if(row.status==='abstain_truncated')return {allow:false,mass:null};
  assert.equal(row.status,'assessed');assert.equal(row.truncated,false);
  const answers=row.result.answers;
  if(row.task==='sets') {
    assert.deepEqual(Object.keys(answers),['effect_set']);
    const answer=answers.effect_set,dist=answer.probabilities;
    assert.deepEqual(Object.keys(dist).sort(),[...Object.keys(masks),'unresolved'].sort());
    assert(Object.values(dist).every(probability));
    assert(Math.abs(Object.values(dist).reduce((n,p)=>n+p,0)-1)<.001);
    assert(Object.hasOwn(dist,answer.choice));assert(Math.abs(dist[answer.choice]-Math.max(...Object.values(dist)))<1e-6);
    const mass=Object.entries(masks).reduce((n,[key,mask])=>n+(subset(mask,allowed)?dist[key]:0),0);
    return {allow:mass>=threshold,mass};
  }
  if(row.task==='axes') {
    assert.deepEqual(Object.keys(answers).sort(),['read','write','destroy','unresolved'].sort());
    for(const answer of Object.values(answers))assert(probability(answer.noul));
    // Union bound: never pretend separately returned marginals are independent.
    const outside=Math.min(1,answers.unresolved.noul+['read','write','destroy'].reduce((n,key,i)=>n+((allowed&(1<<i))?0:answers[key].noul),0));
    return {allow:1-outside>=threshold,mass:1-outside};
  }
  assert.equal(row.task,'six');assert.deepEqual(Object.keys(answers).sort(),[...fields].sort());
  for(const answer of Object.values(answers))assert(probability(answer.noul));
  const v=Object.fromEntries(fields.map(key=>[key,answers[key].noul]));
  // Existing numeric branches, projected into the proposed permission sets.
  // Write is conservatively R+W here; this is not full Rust enforcement replay.
  const safe=v.destructive<=.05&&v.irreversible<=.05&&v.external_or_account_effect<=.05;
  const read=safe&&v.read_only>=.9&&v.may_write<=.1;
  const write=safe&&v.may_write>=.9&&v.reversible>=.8;
  return {allow:(read&&subset(1,allowed))||(write&&subset(3,allowed)),mass:null};
}

function metrics() {return {cases:0,permitted:0,forbidden:0,unknown:0,allowed_permitted:0,allowed_forbidden:0,allowed_unknown:0,held_permitted:0,model_requests:0,heuristic_allows:0,heuristic_rejects:0};}
function add(total,want,allow,origin) {
  total.cases++;total[want]++;
  if(allow)total['allowed_'+want]++;else if(want==='permitted')total.held_permitted++;
  if(origin==='model')total.model_requests++;
  if(origin==='heuristic_allow')total.heuristic_allows++;
  if(origin==='heuristic_reject')total.heuristic_rejects++;
}

export function scoreEffectSets(corpus,receipts,inputs) {
  assert.equal(corpus.schema,corpus.classification==='private_sanitized_local_only'?'statewright/private-effect-set-cases/v1':'statewright/public-effect-set-cases/v1');assert.equal(corpus.enforcement,'none');
  assert.equal(inputs.length,receipts.length);
  const cases=new Map(corpus.cases.map(row=>[row.id,row]));assert.equal(cases.size,corpus.cases.length);
  const seen=new Set(),rows=[],provenance=[];
  for(const [batch,receipt]of receipts.entries()) {
    validateBatch(corpus,receipt,inputs[batch]);
    if(batch)assert.deepEqual(inputs[batch].document.question_profiles,inputs[0].document.question_profiles,'question drift between batches');
    assert.equal(receipt.schema,'statewright/local-judgment-diagnostic/v1');
    assert.equal(receipt.enforcement,'none');assert.equal(receipt.provenance_unchanged,true);
    assert.equal(receipt.label_status,corpus.label_status);
    assert.equal(receipt.checkpoint.revision,'7b928d828b7b0e022f929d9bd2e44165aa270148');
    assert.equal(receipt.checkpoint.checkpoint,'typed-decisions');
    assert.equal(receipt.actual_device,'mps');
    const identity=JSON.stringify([receipt.harness_hash,receipt.runtime_source_hashes,receipt.loaded_file_hashes]);
    if(provenance.length)assert.equal(identity,provenance[0],'runtime/checkpoint/harness drift between batches');
    provenance.push(identity);
    for(const row of receipt.rows) {
      assert(arms.includes(row.arm));const key=row.arm+'/'+row.id;assert(!seen.has(key),'duplicate case/arm');seen.add(key);
      const expected=cases.get(row.id);assert(expected,'foreign case');assert.equal(row.expected.mask,expected.mask);
      assert.equal(row.case_kind,expected.kind);assert(row.heuristic);
      if(row.status==='assessed') {
        assert.equal(row.actual_device,'mps');
        assert(Number.isFinite(row.latency_ms)&&row.latency_ms>=0);
        compatible(row,7,.95); // Validate every result even if heuristic bypasses it.
      } else {assert.equal(row.status,'abstain_truncated');assert.equal(row.truncated,true);}
      rows.push(row);
    }
  }
  assert.equal(seen.size,cases.size*arms.length,'incomplete paired experiment');
  for(const id of cases.keys())for(const arm of arms)assert(seen.has(arm+'/'+id));
  const reports={},failures=[],heuristicErrors=[];
  const template=rows.filter(row=>row.arm===arms[0]);
  for(const row of template) {
    const expected=cases.get(row.id),h=heuristicBounds(row.heuristic);
    if(h.complete&&(expected.mask===null||!subset(expected.mask,h.upper)||!subset(h.lower,expected.mask)))heuristicErrors.push({id:row.id,command:expected.command,expected:expected.mask,heuristic:h});
  }
  for(const arm of arms) {
    const selected=rows.filter(row=>row.arm===arm),latencies=selected.filter(row=>row.status==='assessed').map(row=>row.latency_ms).sort((a,b)=>a-b);
    const report=reports[arm]={assessed:latencies.length,truncated:selected.length-latencies.length,
      p50_ms:latencies[Math.ceil(latencies.length*.5)-1]??null,p95_ms:latencies[Math.ceil(latencies.length*.95)-1]??null,
      max_tokens:Math.max(...selected.flatMap(row=>Object.values(row.tokens).map(count=>count.complete))),policies:{}};
    const known=selected.filter(row=>row.status==='assessed'&&cases.get(row.id).mask!==null);
    if(arm==='literal_effect_axes') {
      report.effect_rank_auc=Object.fromEntries(['read','write','destroy'].map((key,index)=>[key,rankAuc(known.map(row=>[(cases.get(row.id).mask&(1<<index))!==0,row.result.answers[key].noul]))]));
      report.unresolved_rank_auc=rankAuc(selected.filter(row=>row.status==='assessed').map(row=>[cases.get(row.id).mask===null,row.result.answers.unresolved.noul]));
    }
    if(arm==='literal_effect_sets') {
      report.effect_rank_auc=Object.fromEntries(['read','write','destroy'].map((key,index)=>[key,rankAuc(known.map(row=>[(cases.get(row.id).mask&(1<<index))!==0,
        Object.entries(masks).reduce((n,[name,mask])=>n+((mask&(1<<index))?row.result.answers.effect_set.probabilities[name]:0),0)]))]));
      report.unresolved_rank_auc=rankAuc(selected.filter(row=>row.status==='assessed').map(row=>[cases.get(row.id).mask===null,row.result.answers.effect_set.probabilities.unresolved]));
    }
    for(let allowed=0;allowed<=7;allowed++)for(const threshold of thresholds)for(const mode of ['model_only','heuristic_then_model']) {
      const total=metrics(),by_kind=Object.fromEntries([...new Set(corpus.cases.map(row=>row.kind))].map(kind=>[kind,metrics()]));
      for(const row of selected) {
        const expected=cases.get(row.id),want=expected.mask===null?'unknown':subset(expected.mask,allowed)?'permitted':'forbidden';
        let {allow,mass}=compatible(row,allowed,threshold),origin='model';
        // Invalid shell syntax cannot be repaired by model confidence.
        const h=heuristicBounds(row.heuristic);
        if(!h.syntax_valid){allow=false;origin='syntax_hold';}
        else if(mode==='heuristic_then_model') {
          if(!subset(h.lower,allowed)){allow=false;origin='heuristic_reject';}
          else if(h.complete&&subset(h.upper,allowed)){allow=true;origin='heuristic_allow';}
        }
        add(total,want,allow,origin);add(by_kind[expected.kind],want,allow,origin);
        if(threshold===.95&&[1,3,7].includes(allowed)&&((allow&&want!=='permitted')||(!allow&&want==='permitted')))
          failures.push({arm,mode,allowed,id:row.id,command:expected.command,expected:expected.mask,want,allow,mass,origin});
      }
      report.policies[`${allowed}/${threshold}/${mode}`]={...total,by_kind};
    }
  }
  return {schema:'statewright/effect-set-simulation/v1',classification:corpus.classification,privacy:corpus.privacy??null,enforcement:'none',label_status:corpus.label_status,
    interpretation:'Paired agent-labeled development experiment. Raw model scores are uncalibrated. Threshold sweeps are diagnostic, not a selected release policy. Heuristic fast path uses only the existing ReadOnly effect decision; legacy risk classes cannot prove the new effect bits. Numeric legacy branches omit other Rust gates. No native/installed/production acceptance.',
    cases:cases.size,requests:rows.length,thresholds,heuristic_errors:heuristicErrors,reports,failures};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [caseFile,output,...files]=process.argv.slice(2);assert(caseFile&&output&&files.length&&files.length%2===0,'expected case manifest, new report, then input/receipt path pairs');
  const caseBytes=await readFile(caseFile),receipts=[],identities=[],inputs=[];
  for(let index=0;index<files.length;index+=2){
    const inputBytes=await readFile(files[index]),bytes=await readFile(files[index+1]);
    inputs.push({document:JSON.parse(inputBytes),sha256:sha(inputBytes)});receipts.push(JSON.parse(bytes));
    identities.push({input:files[index],input_sha256:sha(inputBytes),file:files[index+1],sha256:sha(bytes)});
  }
  const report={...scoreEffectSets(JSON.parse(caseBytes),receipts,inputs),cases_sha256:sha(caseBytes),receipts:identities};
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({cases:report.cases,requests:report.requests,heuristic_errors:report.heuristic_errors.length}));
  for(const [arm,result]of Object.entries(report.reports))for(const allowed of [1,3,7])console.log(JSON.stringify({arm,allowed,threshold:.95,p95_ms:result.p95_ms,truncated:result.truncated,...result.policies[`${allowed}/0.95/heuristic_then_model`]}));
}
