import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { accountMigrationSource, definition } from './generate-engineering-workflow.mjs';

const pb = process.env.POCKETBASE_BIN || 'pocketbase';
const native = { skip: spawnSync(pb, ['--version']).status !== 0 ? 'PocketBase unavailable' : false };
function run(dir, args, failed = false) {
  const result = spawnSync(pb, [...args, '--dir', resolve(dir, 'data'), '--migrationsDir', resolve(dir, 'migrations'),
    '--hooksDir', resolve(dir, 'hooks')], { encoding: 'utf8', input: 'y\n', timeout: 30000 });
  const output = `${result.stdout}\n${result.stderr}\n${result.error || ''}`;
  if (failed) assert.match(output, /Error: failed to apply migration.*fixture-save-failure/s);
  else { assert.equal(result.status, 0, output); assert.doesNotMatch(output, /Error: failed to (apply|revert) migration/); }
}

function setup({ ownerless = false, empty = false, failSave = false } = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'sw-engineering-accounts-'));
  mkdirSync(resolve(dir, 'migrations')); mkdirSync(resolve(dir, 'hooks'));
  writeFileSync(resolve(dir, 'migrations/001_fixture.js'), `migrate(function(app) {
    var users=app.findCollectionByNameOrId('users');
    var templates=new Collection({name:'workflow_templates',type:'base',fields:[{name:'name',type:'text'},{name:'definition',type:'json'}]}); app.save(templates);
    var t=new Record(templates);t.set('name','agentic-engineering');t.set('definition',${JSON.stringify(definition)});app.save(t);
    var workflows=new Collection({name:'workflows',type:'base',fields:[
      {name:'name',type:'text'}, {name:'template_source',type:'text'}, {name:'definition',type:'json'}, {name:'active',type:'bool'}
      ${ownerless ? '' : ",{name:'owner',type:'relation',required:true,collectionId:users.id,maxSelect:1}"}],
      indexes:[${JSON.stringify(ownerless ? 'CREATE UNIQUE INDEX fixture_name ON workflows(name)' : 'CREATE UNIQUE INDEX fixture_owner_name ON workflows(owner,name)')}]});app.save(workflows);
    var snapshots=new Collection({name:'fixture_snapshots',type:'base',fields:[{name:'before',type:'json'}]});app.save(snapshots);
    var runs=new Collection({name:'workflow_runs',type:'base',fields:[{name:'state',type:'text'},{name:'definition',type:'json'}]});app.save(runs);
    function add(owner,name,index) {
      var wf=new Record(workflows);wf.set('name',name);if(owner)wf.set('owner',owner);
      wf.set('template_source',index%2?'custom':'bugfix');wf.set('active',index%2===0);
      wf.set('definition',{id:name,custom:index,meta:{enabled:index%2===0}});app.save(wf);
    }
    ${ownerless ? (empty ? '' : "add('','bugfix',3);") : `
    for(var i=0;i<${empty ? 0 : 205};i++) {
      var u=new Record(users);u.id='u'+('00000000000000'+i).slice(-14);u.set('email','fixture-'+i+'@example.invalid');
      // Synthetic auth records need no usable login for this migration fixture.
      app.saveNoValidate(u);
      if(i%5!==0)add(u.id,i%5===3?'custom-workflow':'bugfix',i);
      if(i===11||i===202)add(u.id,'agentic-engineering',i);
    }`}
    var rows=app.findRecordsByFilter('workflows','','id',1000,0);var before=[];
    for(var j=0;j<rows.length;j++)before.push({id:rows[j].id,owner:rows[j].getString('owner'),name:rows[j].getString('name'),source:rows[j].getString('template_source'),active:rows[j].getBool('active'),definition:rows[j].getString('definition')});
    var snap=new Record(snapshots);snap.set('before',before);app.save(snap);
    var run=new Record(runs);run.set('state','planning');run.set('definition',{id:'bugfix',evidence:'unchanged'});app.save(run);
  },function(app){});`);
  const migration = failSave ? accountMigrationSource().replace('app.save(workflow);',
    "if(owner==='u00000000000101')throw new Error('fixture-save-failure');app.save(workflow);") : accountMigrationSource();
  writeFileSync(resolve(dir, 'migrations/002_accounts.js'), migration);
  return dir;
}

function verify(dir, { ownerless = false, empty = false, failed = false } = {}) {
  const canonicalCount = failed ? 2 : ownerless ? 1 : empty ? 0 : 205;
  const addedCount = failed ? 0 : ownerless ? 1 : empty ? 0 : 203;
  writeFileSync(resolve(dir, 'migrations/003_assert.js'), `migrate(function(app) {
    function check(value,message){if(!value)throw new Error(message);}
    var snapshots=app.findRecordsByFilter('fixture_snapshots','','id',1,0);var before=JSON.parse(snapshots[0].getString('before'));
    for(var i=0;i<before.length;i++) {var old=before[i];var wf=app.findRecordById('workflows',old.id);
      check(wf.getString('name')===old.name&&wf.getString('owner')===old.owner&&wf.getString('template_source')===old.source,'identity changed');
      check(wf.getBool('active')===old.active&&wf.getString('definition')===old.definition,'old definition or active changed');
    }
    var all=app.findRecordsByFilter('workflows','','id',1000,0);check(all.length===before.length+${addedCount},'unexpected count '+all.length);
    var canonical=app.findRecordsByFilter('workflows','name="agentic-engineering"','id',1000,0);check(canonical.length===${canonicalCount},'canonical count '+canonical.length);
    for(var c=0;c<canonical.length;c++) {
      var existed=false;for(var b=0;b<before.length;b++)if(before[b].id===canonical[c].id)existed=true;
      if(!existed) {
        check(canonical[c].getBool('active')&&canonical[c].getString('template_source')==='agentic-engineering','starter metadata');
        check(canonical[c].getString('definition')===app.findFirstRecordByData('workflow_templates','name','agentic-engineering').getString('definition'),'starter content');
      }
    }
    ${!ownerless && !failed ? `var users=app.findRecordsByFilter('users','','id',1000,0);check(users.length===${empty ? 0 : 205},'account count');
    for(var j=0;j<users.length;j++)check(app.findRecordsByFilter('workflows','owner={:owner} && name="agentic-engineering"','id',2,0,{owner:users[j].id}).length===1,'missing or duplicate owner default');` : ''}
    check(app.findRecordsByFilter('workflows','name="engineering"','id',1000,0).length===0,'alias record created');
    var runs=app.findRecordsByFilter('workflow_runs','','id',10,0);check(runs.length===1&&runs[0].getString('state')==='planning','run changed');
    check(JSON.parse(runs[0].getString('definition')).evidence==='unchanged','snapshot changed');
  },function(app){});`);
  run(dir, ['migrate', 'up']);
}

test('all 205 accounts receive an additive default, including empty/custom/disabled legacy accounts', native, () => {
  const dir = setup(); run(dir, ['migrate', 'up']); verify(dir);
  run(dir, ['migrate', 'down', '2']); run(dir, ['migrate', 'up']); run(dir, ['migrate', 'up']);
});
test('an empty hosted account table creates no ownerless workflow', native, () => {
  const dir = setup({ empty: true }); run(dir, ['migrate', 'up']); verify(dir, { empty: true });
});
for (const empty of [true, false]) test(`ownerless self-hosted catalog, empty=${empty}`, native, () => {
  const dir = setup({ ownerless: true, empty }); run(dir, ['migrate', 'up']); verify(dir, { ownerless: true, empty });
  run(dir, ['migrate', 'down', '2']); run(dir, ['migrate', 'up']);
});
test('partial account backfill failure rolls back every added workflow', native, () => {
  const dir = setup({ failSave: true }); run(dir, ['migrate', 'up'], true);
  writeFileSync(resolve(dir, 'migrations/002_accounts.js'), 'migrate(function(app){},function(app){});');
  verify(dir, { failed: true });
});
