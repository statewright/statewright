import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HumanInteractionRecorder, approvalDisplayContext, interactionValue, interactionText} from '../lib/human-interaction.mjs';
import {createTelemetryWriter, humanInteractionOutbox} from '../lib/telemetry.mjs';

test('web approval displays the actual query and target through repeated helper projection', () => {
  const context = approvalDisplayContext({tool_name:'web.run',tool_input:{
    search_query:[{q:'documented middleware lifecycle',domains:['example.com']}],
    open:[{ref_id:'https://example.com/reference'}]}});
  assert.equal(context.details.search_query[0].q,'documented middleware lifecycle');
  assert.equal(context.details.open[0].ref_id,'https://example.com/reference');
  assert.deepEqual(approvalDisplayContext({display_context:context}),context);
  const http = approvalDisplayContext({tool_name:'http_request',tool_input:{method:'DELETE',url:'https://example.com/resource'}});
  assert.equal(http.details.method,'DELETE');
  assert.equal(http.details.url,'https://example.com/resource');
  const credentials = approvalDisplayContext({tool_name:'web.run',tool_input:{query:{token:'SYNTHETIC_TEST_TOKEN',api_key:'SYNTHETIC_TEST_KEY'}}});
  assert.equal(credentials.details.query.token,'[redacted]');
  assert.equal(credentials.details.query.api_key,'[redacted]');
  const many = approvalDisplayContext({tool_name:'web.run',tool_input:{search_query:
    Array.from({length:100},(_,i)=>({q:`query ${i}`}))}});
  assert.deepEqual(many.details.search_query.at(-1),{_statewright_omitted_items:68});
  assert.deepEqual(approvalDisplayContext({display_context:many}),many);
});

test('dialog command stays recognizable while credentials are masked', () => {
  assert.deepEqual(approvalDisplayContext({tool_name:'exec_command',tool_input:{
    cmd:'git diff -- pb/hooks/order_fulfillment.pb.js',workdir:'/workspace/project'}}),
  {tool:'exec_command',command:'git diff -- pb/hooks/order_fulfillment.pb.js',cwd:'/workspace/project'});
  const display=approvalDisplayContext({tool_input:{cmd:'TOKEN=private-one tool --api-key private-two https://user:private-three@example.invalid -H "Authorization: Bearer private-four"'}});
  assert.doesNotMatch(JSON.stringify(display),/private-(one|two|three|four)/);
  assert.match(display.command,/tool/);
});

test('credential aliases and curl authentication are masked before local persistence',()=>{
  const fields=['token','client_secret','clientSecret','ID_TOKEN','session-token','cookie','set-cookie','proxyAuthorization','private_key','STATEWRIGHT_API_KEY'];
  const result=interactionValue({action:'accept',content:Object.fromEntries(fields.map((key,index)=>[key,'sensitive-marker-'+index]))});
  assert.doesNotMatch(JSON.stringify(result),/sensitive-marker/);assert.equal(result.action,'accept');
  for(const command of [
    'curl -u user:sensitive-marker https://example.invalid/path',
    'curl -uuser:sensitive-marker https://example.invalid/path',
    'curl --user=user:sensitive-marker https://example.invalid/path',
    'curl --proxy-user "user:sensitive-marker" https://example.invalid/path',
    "curl -u 'user:sensitive-marker with spaces' https://example.invalid/path",
    'curl -fsSu user:sensitive-marker https://example.invalid/path',
    "curl -u 'user:sensitive-marker/curl' https://example.invalid/path",
    "bash -lc 'curl -u user:sensitive-marker https://example.invalid/path'",

    'curl -u user:prefix\\ sensitive-marker https://example.invalid/path',
    'curl -b "session=sensitive-marker" https://example.invalid/path',
    'curl -H "X-API-Key: sensitive-marker" https://example.invalid/path',

    'curl -u user:sensitive-marker --proxy-user proxy:sensitive-marker https://example.invalid/path',
    'curl -H "X-Feature: one;two" -u user:sensitive-marker https://example.invalid/path',
    'curl -u "user:sensitive-marker\\\"suffix" https://example.invalid/path',

  ]){
    const cleaned=interactionText(command);
    assert.doesNotMatch(cleaned,/sensitive-marker/);assert.match(cleaned,/curl/);assert.match(cleaned,/https:\/\/example.invalid\/path/);
  }
});

test('serialized token results retain nonsecret action and classification fields',()=>{
  const result=JSON.parse(interactionText(JSON.stringify({id_token:'sensitive-marker',proxyAuthorization:'sensitive-marker',passphrase:'sensitive-marker',fooToken:'sensitive-marker',action:'accept',read_only:0.99,total_tokens:17})));
  assert.doesNotMatch(JSON.stringify(result),/sensitive-marker/);assert.equal(result.id_token,'[redacted]');assert.equal(result.action,'accept');
  assert.equal(result.read_only,0.99);assert.equal(result.total_tokens,17);
});

test('serialized commands and escaped generic credential arguments retain target context',()=>{
  const result=JSON.parse(interactionText(JSON.stringify({command:'curl -u "user:sensitive-marker" https://example.invalid/path',action:'accept'})));
  assert.doesNotMatch(result.command,/sensitive-marker/);assert.match(result.command,/example.invalid\/path/);assert.equal(result.action,'accept');
  assert.doesNotMatch(interactionText('tool --token prefix\\ sensitive-marker --target public'),/sensitive-marker/);
  assert.equal(interactionText('curl -o output.txt https://example.invalid/path'),'curl -o output.txt https://example.invalid/path');
});

test('human requests, answers, cancellation and disconnect retain correlation without treating a reply as authority',async()=>{
  const events=[];const recorder=new HumanInteractionRecorder(event=>events.push(event));
  const request={id:7,method:'item/tool/requestUserInput',params:{threadId:'thread',questions:[{question:'Which target?',options:['staging','production']}]}};
  recorder.request(request);recorder.request(request);
  recorder.response({id:7,result:{answers:{target:'staging'}}});
  recorder.response({id:7,result:{answers:{target:'production'}}});
  recorder.request({id:'second',method:'mcpServer/elicitation/request',params:{threadId:'thread',message:'Approve command?'}});
  recorder.close();await new Promise(setImmediate);
  assert.deepEqual(events.map(e=>e.stage),['requested','responded','requested','interrupted']);
  assert.equal(events[0].interaction_id,events[1].interaction_id);
  assert.equal(events[1].result.answers.target,'staging');
  assert.equal(events[0].dialog.questions[0].question,'Which target?');
  assert.equal(events[1].actor_source,'native_client_reply');
});

test('human interaction outbox survives failure and reconstruction; only acknowledged IDs are removed',async t=>{
  const root=await mkdtemp(join(tmpdir(),'human-events-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'events.jsonl');const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});
  const outbox=humanInteractionOutbox(path,{endpoint:'https://staging.invalid/api/gateway/telemetry/events',apiKey:'fixture'});
  globalThis.fetch=async()=>new Response('{}',{status:503});
  const fields={schema:'statewright/human-interaction/v1',interaction_id:'interaction',
    thread_id:'thread',request_id:'request',method:'mcpServer/elicitation/request',stage:'requested',
    dialog:{message:'Allow?',command:'git diff -- file',content:{api_key:'private-value',
      id_token:'private-value',clientSecret:'private-value',cookie:'private-value',
      authentication_command:'curl -u user:private-value https://example.invalid/path'}}};
  await createTelemetryWriter(path,{endpoint:'https://staging.invalid/api/gateway/telemetry/events',apiKey:'fixture'} )('app_server_handoff_status',fields);
  assert.equal((await readdir(outbox)).length,1);
  const delivered=[];
  globalThis.fetch=async(url,options)=>{
    assert.equal(String(url),'https://staging.invalid/api/gateway/human-interactions');
    const events=JSON.parse(options.body).events;delivered.push(...events);
    return new Response(JSON.stringify({accepted_event_ids:events.map(e=>e.event_id),duplicate_event_ids:[]}));
  };
  await createTelemetryWriter(path,{endpoint:'https://staging.invalid/api/gateway/telemetry/events',apiKey:'fixture'} )('app_server_handoff_status',{...fields,stage:'responded',result:{action:'accept'}});
  assert.equal(delivered.length,2);assert.equal((await readdir(outbox)).length,0);
  assert.doesNotMatch(await readFile(path,'utf8'),/private-value/);
  assert.match(await readFile(path,'utf8'),/git diff -- file/);
  assert(delivered.some(e=>e.result?.action==='accept'));
});

test('retry queues cannot cross staging/production or account credential boundaries',()=>{
  const base={endpoint:'https://staging.invalid/api/gateway/telemetry/events',apiKey:'first'};
  const path='/fixture/events.jsonl';
  const first=humanInteractionOutbox(path,base);
  assert.equal(first,humanInteractionOutbox(path,base));
  assert.notEqual(first,humanInteractionOutbox(path,{...base,apiKey:'second'}));
  assert.notEqual(first,humanInteractionOutbox(path,{...base,endpoint:'https://production.invalid/events'}));
  assert.doesNotMatch(first,/first|staging.invalid/);
});

test('approved native command result is logged only after its exact item completes',async()=>{
  const events=[];const recorder=new HumanInteractionRecorder(event=>events.push(event));
  recorder.request({id:'approval',method:'item/commandExecution/requestApproval',
    params:{threadId:'thread',itemId:'item',command:'git diff -- file'}});
  recorder.response({id:'approval',result:{decision:'accept'}});
  recorder.observeExecution({method:'item/completed',params:{threadId:'foreign',item:{id:'item',exitCode:0}}});
  recorder.observeExecution({method:'item/completed',params:{threadId:'thread',item:{id:'item',exitCode:2,status:'completed',aggregatedOutput:'failed fixture'}}});
  await new Promise(setImmediate);
  assert.equal(events.length,3);
  assert.equal(events[2].stage,'execution_completed');
  assert.equal(events[2].result.exit_code,2);
  assert.equal(events[2].result.output,'failed fixture');
  assert.equal(events[0].interaction_id,events[2].interaction_id);
});

test('Claude classifier review records requested and resolved decisions without native App Server messages',async()=>{
  const events=[];const recorder=new HumanInteractionRecorder(event=>events.push(event));
  const common={provider:'claude-code',host:'claude-code',threadId:'session-one',run_id:'run-one',
    state:'implement',basis:'incomplete_structural_evidence',
    invocation_fingerprint:'invocation_v1_exact',policy_sha256:'a'.repeat(64),
    display_context:{command:'curl --api-key synthetic-private-value https://example.invalid'}};
  recorder.recordClassifierApproval({...common,type:'classifier_human_approval_requested',decision:'ask',approval_request_id:'tool-use-one'});
  recorder.recordClassifierApproval({...common,type:'classifier_human_approval_granted',approval_request_id:'tool-use-one',
    decision:'granted',grant_id:'grant-one',duration:'2h',expires_at:7_201_000});
  recorder.recordClassifierApproval({...common,type:'classifier_human_approval_requested',decision:'ask',approval_request_id:'tool-use-two'});
  recorder.recordClassifierApproval({...common,type:'classifier_human_approval_denied',approval_request_id:'tool-use-two',
    decision:'denied',reason:'human_declined'});
  await new Promise(setImmediate);
  assert.deepEqual(events.map(event=>event.stage),['requested','resolved','requested','resolved']);
  assert.equal(events[0].interaction_id,events[1].interaction_id);
  assert.equal(events[2].interaction_id,events[3].interaction_id);
  assert.notEqual(events[0].interaction_id,events[2].interaction_id);
  for(const event of events){
    assert.equal(event.provider,'claude-code');assert.equal(event.host,'claude-code');
    assert.equal(event.method,'statewright/classifierApproval');
    assert.equal(event.run_id,'run-one');assert.equal(event.state,'implement');
  }
  assert.equal(events[1].result.action,'allow_once');
  assert.equal(events[1].result.approval_scope,'remembered');
  assert.equal(events[1].result.duration,'2h');
  assert.equal(events[1].result.expires_at,7_201_000);
  assert.equal(events[1].result.invocation_fingerprint,'invocation_v1_exact');
  assert.equal(events[1].result.policy_sha256,'a'.repeat(64));
  assert.equal(events[3].result.action,'deny');
  assert.equal(events[3].result.reason,'human_declined');
  assert.doesNotMatch(JSON.stringify(events),/synthetic-private-value|display_context/);
});
