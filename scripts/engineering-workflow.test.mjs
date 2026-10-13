import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { artifacts, definition, legacyTemplate, migrationSource } from './generate-engineering-workflow.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const legacy = legacyTemplate();
test('packaged definitions and migration match the canonical portable starter', () => {
  for (const [path, contents] of artifacts()) assert.equal(readFileSync(resolve(root, path), 'utf8'), contents, path);
  assert.equal(definition.id, 'agentic-engineering');
  assert.equal(definition.meta.version, 1);
  const serialized = JSON.stringify(definition);
  assert.doesNotMatch(serialized, /(?:https?|wss?):\/\/|\/(?:Users|home|private|Volumes)\/|[A-Za-z]:\\|gpt-|claude-|STATEWRIGHT_/);
  for (const kind of ['bug fix','feature','refactor','investigation']) assert.ok(serialized.includes(kind), kind);
});

const pb = process.env.POCKETBASE_BIN || 'pocketbase';
const nativeOptions = { skip: spawnSync(pb, ['--version']).status !== 0 ? 'PocketBase unavailable' : false };
function runPB(dir, args, expectedFailure = false) {
  const r = spawnSync(pb, [...args, '--dir', resolve(dir, 'data'), '--migrationsDir', resolve(dir, 'migrations'),
    '--hooksDir', resolve(dir, 'hooks')], { encoding: 'utf8', input: 'y\n', timeout: 30000 });
  const output = `${r.stdout}\n${r.stderr}\n${r.error || ''}`;
  if (expectedFailure) assert.match(output, /Error: failed to apply migration/);
  else { assert.equal(r.status, 0, output); assert.doesNotMatch(output, /Error: failed to (apply|revert) migration/); }
  return output;
}
function setup({ customTemplate = false, failSave = false, ownerless = false } = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'sw-engineering-migration-'));
  mkdirSync(resolve(dir, 'migrations')); mkdirSync(resolve(dir, 'hooks'));
  writeFileSync(resolve(dir, 'migrations/001_fixture.js'), `migrate(function(app) {
    var old = ${JSON.stringify(legacy.definition)};
    var t = new Collection({name:'workflow_templates',type:'base',fields:[
      {name:'name',type:'text'}, {name:'description',type:'text'}, {name:'definition',type:'json'},
      {name:'active',type:'bool'}, {name:'sort_order',type:'number'}],
      indexes:['CREATE UNIQUE INDEX test_template_name ON workflow_templates (name)']}); app.save(t);
    var w = new Collection({name:'workflows',type:'base',fields:[
      {name:'name',type:'text'}, {name:'template_source',type:'text'}, {name:'definition',type:'json'},
      {name:'active',type:'bool'}${ownerless ? '' : ",{name:'owner',type:'text'}"}],
      indexes:[${JSON.stringify(ownerless ? 'CREATE UNIQUE INDEX test_wf_name ON workflows (name)' : 'CREATE UNIQUE INDEX test_wf_name ON workflows (owner,name)')}]}); app.save(w);
    var runs = new Collection({name:'workflow_runs',type:'base',fields:[{name:'definition',type:'json'}, {name:'state',type:'text'}]}); app.save(runs);
    var template = new Record(t); template.set('name','bugfix'); template.set('description',${JSON.stringify(legacy.description)});
    template.set('definition',old); template.set('active',false); template.set('sort_order',7);
    ${customTemplate ? "var ct=JSON.parse(JSON.stringify(old)); ct.states.planning.instructions='custom template'; template.set('definition',ct);" : ''} app.save(template);
    for(var i=0;i<${ownerless ? 1 : 205};i++) {
      var r=new Record(w); r.set('name','bugfix'); r.set('template_source','bugfix'); r.set('definition',old);
      ${ownerless ? '' : "r.set('owner','owner-'+i);"} r.set('active',true); app.save(r);
    }
    ${ownerless ? '' : `var custom=JSON.parse(JSON.stringify(old)); custom.states.planning.instructions='custom instructions';
    var variants=[['bugfix','bugfix',custom,'custom',true],['bugfix','other',old,'foreign',true],['my-bugfix','bugfix',old,'renamed',true],['bugfix','bugfix',old,'disabled',false],['agentic-engineering','custom',custom,'owner-100',false]];
    for(var j=0;j<variants.length;j++) {var r=new Record(w); r.set('name',variants[j][0]); r.set('template_source',variants[j][1]); r.set('definition',variants[j][2]); r.set('owner',variants[j][3]); r.set('active',variants[j][4]); app.save(r);}`}
    var run=new Record(runs); run.set('state','planning'); run.set('definition',old); app.save(run);
  }, function(app) {});`);
  const source = failSave ? migrationSource().replace('app.save(workflow);',
    "if (owner === 'owner-101') throw new Error('fixture-save-failure'); app.save(workflow);") : migrationSource();
  writeFileSync(resolve(dir, 'migrations/002_engineering.js'), source);
  return dir;
}
function verify(dir, { customTemplate = false, ownerless = false } = {}) {
  writeFileSync(resolve(dir, 'migrations/003_assert.js'), `migrate(function(app) {
    function check(ok,message) {if(!ok)throw new Error(message);}
    var t=app.findFirstRecordByData('workflow_templates','name','bugfix'); var td=JSON.parse(t.getString('definition'));
    check(td.initial==='planning','old template changed'); check(!t.getBool('active') && t.getInt('sort_order')===7,'old metadata changed');
    ${customTemplate ? "check(td.states.planning.instructions==='custom template','custom template overwritten');" : ''}
    var nt=app.findFirstRecordByData('workflow_templates','name','agentic-engineering');
    check(JSON.parse(nt.getString('definition')).id==='agentic-engineering','new template');
    var rows=app.findRecordsByFilter('workflows','','id',1000,0); check(rows.length===${ownerless ? 2 : 414},'count '+rows.length);
    var fresh=0; var old=0;
    for(var i=0;i<rows.length;i++) {var r=rows[i]; var d=JSON.parse(r.getString('definition')); var owner=r.getString('owner');
      if(r.getString('name')==='agentic-engineering' && owner!=='owner-100') {
        check(d.initial==='diagnose' && d.id==='agentic-engineering','starter identity'); check(r.getBool('active'),'starter inactive'); fresh++;
      } else {check(d.initial==='planning','old definition replaced'); old++;
        if(owner==='custom' || owner==='owner-100' && r.getString('name')==='agentic-engineering')check(d.states.planning.instructions==='custom instructions','custom content');
        if(owner==='disabled' || owner==='owner-100' && r.getString('name')==='agentic-engineering')check(!r.getBool('active'),'disabled enabled');
      }
    }
    check(fresh===${ownerless ? 1 : 204} && old===${ownerless ? 1 : 210},'pagination/collision');
    var runs=app.findRecordsByFilter('workflow_runs','','id',10,0);
    check(runs.length===1 && runs[0].getString('state')==='planning','run changed');
    check(JSON.parse(runs[0].getString('definition')).initial==='planning','snapshot changed');
  },function(app){});`);
  runPB(dir,['migrate','up']);
}
test('real PocketBase up/down/up is non-destructive and idempotent',nativeOptions,()=>{
  const dir=setup(); runPB(dir,['migrate','up']); verify(dir);
  runPB(dir,['migrate','down','2']); runPB(dir,['migrate','up']); runPB(dir,['migrate','up']);
  console.log(`PocketBase up/down/up verified: ${dir}`);
});
test('real PocketBase preserves customized templates and canonical collisions',nativeOptions,()=>{
  const dir=setup({customTemplate:true}); runPB(dir,['migrate','up']); verify(dir,{customTemplate:true});
});
test('real PocketBase supports ownerless self-hosted collections',nativeOptions,()=>{
  const dir=setup({ownerless:true}); runPB(dir,['migrate','up']); verify(dir,{ownerless:true});
});
test('real PocketBase rolls back every new record on partial failure',nativeOptions,()=>{
  const dir=setup({failSave:true}); assert.match(runPB(dir,['migrate','up'],true),/fixture-save-failure/);
  writeFileSync(resolve(dir,'migrations/002_engineering.js'),`migrate(function(app){
    if(app.findRecordsByFilter('workflow_templates','name="agentic-engineering"','id',1,0).length)throw new Error('partial template');
    if(app.findRecordsByFilter('workflows','','id',1000,0).length!==210)throw new Error('partial workflows');
  },function(app){});`); runPB(dir,['migrate','up']);
});
