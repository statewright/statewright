import test from 'node:test';import assert from 'node:assert/strict';
import {scoreRows}from'./score-command-corpus.mjs';
const row=(id,old,current)=>({id,historical_disposition:old,current_disposition:current,execution:'none',policy:'fixed_read_only_capabilities'});
const labels=values=>({schema:'statewright/classifier-pilot-labels/v1',adjudication:'agent_manual',labels:values});
test('does not confuse lower friction with fewer escapes',()=>{
  const r=scoreRows([row('aaaaaaaaaaaa','allow','allow'),row('bbbbbbbbbbbb','allow','deny'),row('cccccccccccc','allow','review')],labels([
    ['aaaaaaaaaaaa','allow','read'],['bbbbbbbbbbbb','deny','write'],['cccccccccccc','review','unknown']]));
  assert.equal(r.totals.historical.forbidden_autoallow,1);assert.equal(r.totals.historical.unknown_autoallow,1);
  assert.equal(r.totals.current.forbidden_autoallow,0);assert.equal(r.totals.current.allowed_reads,1);
});
test('rejects duplicate IDs/labels, missing cases and purported executed fixtures',()=>{
  const a=row('aaaaaaaaaaaa','allow','review');
  assert.throws(()=>scoreRows([a,a],labels([])));
  assert.throws(()=>scoreRows([a],labels([['zzzzzzzzzzzz','allow','missing']])));
  assert.throws(()=>scoreRows([a],labels([['aaaaaaaaaaaa','allow','x'],['aaaaaaaaaaaa','allow','x']])));
  assert.throws(()=>scoreRows([{...a,execution:'ran'}],labels([])));
});
