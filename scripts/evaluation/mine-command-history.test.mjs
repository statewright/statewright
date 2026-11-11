import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitize,zshCommands,eventCommands,orchestrationCommands,orchestrationEventCommands,loadParser} from './mine-command-history.mjs';
const {parse}=await loadParser();
test('credentials and opaque values are excluded, not copied into redacted output',()=>{
  for(const command of ['API_KEY=example-value tool','FOO=unknown tool','curl -H "Authorization: Bearer sample" https://example.com','tool --token sample','gopass show foo','cat ~/.ssh/id_rsa','curl https://example.com/?key=sample','tool abcdefghijklmnopqrstuvwxyz0123456789','tool abcdefghij/klmnopqrstuvwxyz0123456789','cat .env','tool login 1234','mysql -u name -psample','curl -u sample https://example.com','tool postgresql://name:sample@example.com/db'])assert(sanitize(command).skip,command);
});
test('cookie/header/config and wrapper assignments are excluded before persistence',()=>{
  for(const command of ['curl --cookie session=SYNTHETIC https://example.com','curl -b session=SYNTHETIC https://example.com','curl -bsession=SYNTHETIC https://example.com','curl -H "X-Custom: SYNTHETIC" https://example.com','curl --header "X-Custom: SYNTHETIC" https://example.com','curl -K localconfig https://example.com','env FOO=SYNTHETIC tool','sudo env FOO=SYNTHETIC tool'])assert(sanitize(command).skip,command);
});
test('safe paths are sanitized without changing shell composition',()=>{
  assert.deepEqual(sanitize('cat /Users/dev/dev/example/file && rm /Volumes/sidecar/tmp/a'),{command:'cat /fixture/home/dev/example/file && rm /fixture/sidecar/tmp/a',redactions:['home_path','sidecar_path'],evidence_loss:true});
  assert(sanitize('cat one\nrm two').skip);
  assert(sanitize('kubectl --kubeconfig=/Users/dev/.kube/cluster get pods').command);
  assert(sanitize('cat /Users/dev/.kube/config').skip);
});
test('extended zsh records preserve multiline boundaries for exclusion',()=>{
  const rows=zshCommands(': 1:0;cat file\n: 2:0;echo line\\\ncontinuation\n: 3:0;pwd\n');
  assert.equal(rows.length,3);assert.equal(rows[1].command,'echo line\\\ncontinuation');assert(sanitize(rows[1].command).skip);
});
test('only actual supported command tool records are extracted',()=>{
  assert.deepEqual(eventCommands({type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:'{"cmd":"git status"}'}}),['git status']);
  assert.deepEqual(eventCommands({message:{content:[{type:'tool_use',name:'Bash',input:{command:'npm test'}}]}}),['npm test']);
  assert.deepEqual(eventCommands({type:'response_item',payload:{type:'function_call',name:'exec',arguments:'tools.exec_command({cmd: "rm file"})'}}),[]);
});
test('orchestration extraction parses literal arguments without evaluating JS',()=>{
  assert.deepEqual(orchestrationCommands('await tools.exec_command({cmd:"git status"}); tools.exec_command({cmd:`pwd`})',parse),['git status','pwd']);
  assert.deepEqual(orchestrationCommands('tools.exec_command({cmd:"printf \\"%s\\" file"})',parse),['printf "%s" file']);
  for(const source of [
    '// tools.exec_command({cmd:"rm file"})',
    '\'tools.exec_command({cmd:"rm file"})\'',
    'other.exec_command({cmd:"rm file"})',
    'tools.exec_command({cmd:`echo ${value}`})',
    'tools.exec_command({cmd: value})',
    'tools.exec_command({cmd:"pwd", ...override})',
    'tools.exec_command({cmd:"pwd", cmd:"rm file"})',
    'tools.exec_command({[key]:"pwd"})',
  ])assert.deepEqual(orchestrationCommands(source,parse),[],source);
});
test('Codex custom-tool and function-call transport preserve literal-only provenance',()=>{
  const source='await tools.exec_command({cmd:"git status"})';
  assert.deepEqual(orchestrationEventCommands({type:'response_item',payload:{type:'custom_tool_call',name:'functions.exec',input:source}},parse),['git status']);
  assert.deepEqual(orchestrationEventCommands({type:'response_item',payload:{type:'function_call',name:'exec',arguments:source}},parse),['git status']);
  assert.equal(orchestrationEventCommands({type:'event_msg',payload:{type:'custom_tool_call',name:'functions.exec',input:source}},parse),null);
});
