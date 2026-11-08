import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {compatible,masks,heuristicBounds,pythonCanonical,validateBatch,rankAuc} from './score-effect-sets.mjs';
const joint=dist=>({task:'sets',status:'assessed',truncated:false,result:{answers:{effect_set:{choice:Object.keys(dist).reduce((a,b)=>dist[a]>dist[b]?a:b),probabilities:dist}}}});
const distribution=Object.fromEntries([...Object.keys(masks),'unresolved'].map(key=>[key,0]));
test('compatible mass sums permitted combinations rather than demanding one winner',()=>{
  const row=joint({...distribution,read:.52,read_write:.46,read_destroy:.01,unresolved:.01});
  assert.equal(compatible(row,1,.95).allow,false);
  assert.equal(compatible(row,3,.95).allow,true);
  assert.equal(compatible(row,7,1).allow,false);
  assert.equal(compatible(row,3,.95).mass,.98);
});
test('adding permissions is monotonic and unresolved mass remains outside all sets',()=>{
  for(let mask=0;mask<=7;mask++){
    const key=Object.keys(masks).find(key=>masks[key]===mask),row=joint({...distribution,[key]:.96,unresolved:.04});
    for(let allowed=0;allowed<=7;allowed++)assert.equal(compatible(row,allowed,.95).allow,(mask&~allowed)===0);
    assert.equal(compatible(row,7,.99).allow,false);
  }
});
test('marginals use a union bound without an independence assumption',()=>{
  const row={task:'axes',status:'assessed',truncated:false,result:{answers:Object.fromEntries(Object.entries({read:.9,write:.02,destroy:.02,unresolved:.02}).map(([key,noul])=>[key,{noul}]))}};
  assert.equal(compatible(row,1,.95).allow,false);
  assert.equal(compatible(row,3,.95).allow,true);
});
test('malformed, missing, unnormalized and truncated distributions cannot manufacture allowances',()=>{
  assert.equal(compatible({status:'abstain_truncated'},7,0).allow,false);
  assert.throws(()=>compatible(joint({...distribution,read:.8}),1,.5));
  assert.throws(()=>compatible(joint({...distribution,read:NaN}),1,.5));
  const row=joint({...distribution,read:1});delete row.result.answers.effect_set.probabilities.unresolved;
  assert.throws(()=>compatible(row,1,.5));
});
test('legacy risk buckets cannot become exact Destroy evidence',()=>{
  for(const classes of ['[Destructive]','[FileRead, FileWrite]','[FileWrite]','[SafeOutput]'])
    assert.deepEqual(heuristicBounds({classes,syntax_valid:true}),{lower:0,upper:7,complete:false,syntax_valid:true});
  assert.deepEqual(heuristicBounds({classes:'[SafeOutput]',syntax_valid:true,current_effect:'ReadOnly'}),{lower:0,upper:1,complete:true,syntax_valid:true});
});
test('ranking separates discrimination from confidence calibration and handles ties',()=>{
  assert.equal(rankAuc([[true,.6],[false,.4]]),1);
  assert.equal(rankAuc([[true,.4],[false,.6]]),0);
  assert.equal(rankAuc([[true,.5],[false,.5]]),.5);
  assert.equal(rankAuc([[true,.5]]),null);
});
test('canonical hashing preserves question/state bytes and batches reject unbound receipts',()=>{
  assert.equal(pythonCanonical({b:[true,null],a:'é'}),'{"a": "é", "b": [true, null]}');
  const corpus={cases:[]};
  assert.throws(()=>validateBatch(corpus,{input_file_hash:'other'},{sha256:'expected',document:{schema:'statewright/public-effect-set-evaluation/v1',classification:'public_command_data',source_cases:corpus,cases:[]}}),/input bytes/);
});
test('paired evidence rejects swapped tasks, changed commands, and changed questions',()=>{
  const hash=value=>createHash('sha256').update(pythonCanonical(value)).digest('hex');
  const corpus={cases:[{id:'one',command:'cat fixture.txt',mask:1}]};
  const profiles={six:Object.fromEntries(['read_only','may_write','reversible','destructive','irreversible','external_or_account_effect'].map(key=>[key,{instructions:key}])),
    axes:Object.fromEntries(['read','write','destroy','unresolved'].map(key=>[key,{instructions:key}])),
    sets:{effect_set:{criteria:{...masks,unresolved:'unknown'}}}};
  const planned={id:'one',arm:'literal_effect_axes',task:'axes',question_profile:'axes',state:{invocation:'cat fixture.txt',delegated_source:null},expected:{mask:1},heuristic:{}};
  const document={schema:'statewright/public-effect-set-evaluation/v1',classification:'public_command_data',source_cases:corpus,question_profiles:profiles,cases:[planned]};
  const receipt={input_file_hash:'frozen',rows:[{...planned,input_hash:hash(planned.state),questions_hash:hash(profiles.axes)}]};
  const input={sha256:'frozen',document};validateBatch(corpus,receipt,input);
  const wrongTask=structuredClone(receipt);wrongTask.rows[0].task='six';
  assert.throws(()=>validateBatch(corpus,wrongTask,input));
  const wrongCommand=structuredClone(input);wrongCommand.document.cases[0].state.invocation='rm fixture.txt';
  assert.throws(()=>validateBatch(corpus,receipt,wrongCommand),/state binding/);
  const wrongQuestions=structuredClone(input);wrongQuestions.document.question_profiles.axes.read.instructions='different';
  assert.throws(()=>validateBatch(corpus,receipt,wrongQuestions),/questions binding/);
});
