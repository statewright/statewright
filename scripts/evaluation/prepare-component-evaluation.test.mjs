import test from 'node:test';
import assert from 'node:assert/strict';
import {prepare,questions} from './prepare-component-evaluation.mjs';
function fixture(){return {schema:'statewright/component-effect-fixture-inputs/v1',classification:'public_command_data',enforcement:'none',label_status:'draft',rows:[{
  id:'case',expected:3,source_sha256:'source',tasks:[{component_index:0,state:{schema:'statewright/component-effect-facts/v1',syntax_valid:true,
    resource_effect_contract:'v1',effect_definitions:'definitions',fixture_context:{environment:'fixture'},invocation:{
      executable:{literal_available:true,literal_value:'utility'},arguments:[{literal_available:true,literal_value:''},{literal_available:false,origin:'shell_expansion'}],
      assignments:[],argv_complete:false,context_ancestors:['program']}}}]}]};}
test('labels stay outside state; empty arguments and unavailable values survive',()=>{
  const [batch]=prepare(fixture(),'input'),row=batch.cases[0];
  assert.equal(row.expected.parent_effect_mask,3);assert.equal(row.state.invocation.argv[0],'');
  assert.deepEqual(row.state.invocation.argv[1],{unavailable_value:'shell_expansion'});
  assert.equal(JSON.stringify(row.state).includes('parent_effect_mask'),false);
  assert.equal(JSON.stringify(row.state).includes('case'),false);
  assert.deepEqual(Object.keys(questions),['read','write','destroy','unresolved']);
});
test('private inputs, missing literals and duplicate tasks are rejected',()=>{
  const p=fixture();p.classification='private_sanitized_local_only';assert.throws(()=>prepare(p,'input'));
  const m=fixture();delete m.rows[0].tasks[0].state.invocation.arguments[0].literal_value;assert.throws(()=>prepare(m,'input'));
  const d=fixture();d.rows[0].tasks.push(d.rows[0].tasks[0]);assert.throws(()=>prepare(d,'input'));
});
