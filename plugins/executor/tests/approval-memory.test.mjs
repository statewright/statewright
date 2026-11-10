import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,readFile,writeFile,readdir} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdir} from "node:fs/promises";
import {ApprovalMemory,approvalMemoryContext} from "../lib/approval-memory.mjs";
import {ClassifierApprovalController} from "../lib/classifier-approval-controller.mjs";

const context={schema:"statewright/approval-memory-context/v1",policy_sha256:"a".repeat(64),
  invocation_sha256:"b".repeat(64),dependency_sha256:"c".repeat(64),reusable:true,
  allowed_durations:["once","2h","4h","8h","always"]};
const request=()=>({schema:"statewright/classifier-approval-request/v2",thread_id:"thread",run_id:"run",run_session_id:"session",
  state:"implement",state_epoch:4,session_generation:"generation-one",approval_memory:structuredClone(context),
  classifier_receipt:{intent_fingerprint:"intent_v1_test",invocation_fingerprint:"invocation_v1_one",
    final_denial_basis:"semantic_authorization_disabled",required_authority:"complete_structural_evidence_or_separate_approval",
    reformulation_allowed:true,exact_invocation_retry_allowed:false,separate_approval_allowed:true}});
const state=()=>({run_id:"run",run_session_id:"session",state:"implement",state_epoch:4,session_generation:"generation-one",
  approval_memory_policy:{policy_sha256:context.policy_sha256,allowed_durations:context.allowed_durations}});
async function fixture(t){const root=await mkdtemp(join(tmpdir(),"statewright-approval-memory-"));t.after(()=>rm(root,{recursive:true,force:true}));
  let now=1000;return {root,setNow:v=>{now=v;},make:(namespace="principal/project/staging")=>new ApprovalMemory({root,namespace,now:()=>now})};}

test("workflow 8h duration is disclosed and plain native allow survives reconstruction",async t=>{
  const f=await fixture(t),sent=[],value=request();
  value.approval_memory.approve_for="8h";
  const current=state();current.approval_memory_policy.approve_for="8h";
  const controller=new ClassifierApprovalController({send:v=>sent.push(v),getState:async()=>current,memory:f.make()});
  const first=await controller.begin(value);const modal=sent[0];
  assert.match(modal.params.message,/8 (?:hours|h)/i);
  assert.deepEqual(modal.params.requestedSchema.properties,{});
  controller.handleReply({id:modal.id,result:{action:"accept"}});
  assert.equal((await first.completion).duration,"8h");
  controller.close();
  const next=new ClassifierApprovalController({send:()=>assert.fail("reused grant must not prompt"),getState:async()=>current,memory:f.make()});
  value.classifier_receipt.invocation_fingerprint="invocation_v1_repeat";
  assert.equal((await next.begin(value)).response.reason,"remembered_human_approval");
});

test("workflow duration governs plain allow and an unconfigured workflow remains once",async t=>{
  for(const duration of ["once","2h","4h","8h","always"]){
    const f=await fixture(t),sent=[],value=request(),current=state();
    if(duration!=="once"){value.approval_memory.approve_for=duration;current.approval_memory_policy.approve_for=duration;}
    const controller=new ClassifierApprovalController({send:v=>sent.push(v),getState:async()=>current,memory:f.make()});
    const first=await controller.begin(value);const modal=sent[0];
    controller.handleReply({id:modal.id,result:{action:"accept"}});
    const result=await first.completion;
    assert.equal(result.action,"allow_once");
    assert.equal(result.duration,duration==="once"?undefined:duration);
    assert.equal((await f.make().list()).length,duration==="once"?0:1);
  }
});

test("configured 8h with missing provenance is visibly once only",async t=>{
  const f=await fixture(t),sent=[],value=request(),current=state();
  value.approval_memory.approve_for="8h";value.approval_memory.reusable=false;
  current.approval_memory_policy.approve_for="8h";
  const controller=new ClassifierApprovalController({send:v=>sent.push(v),getState:async()=>current,memory:f.make()});
  const first=await controller.begin(value);assert.match(sent[0].params.message,/once/);
  assert.match(sent[0].params.message,/provenance is incomplete/);
  controller.handleReply({id:sent[0].id,result:{action:"accept"}});
  assert.equal((await first.completion).action,"allow_once");assert.deepEqual(await f.make().list(),[]);
});

test("missing approval-memory context is explained before a once-only decision",async t=>{
  const f=await fixture(t),sent=[],value=request();
  delete value.approval_memory;
  const controller=new ClassifierApprovalController({send:v=>sent.push(v),getState:async()=>state(),memory:f.make()});
  const pending=await controller.begin(value);
  assert.match(sent[0].params.message,/did not include a valid approval-memory policy and binding/);
  assert.match(sent[0].params.message,/one-time approval/);
  controller.handleReply({id:sent[0].id,result:{action:"accept"}});
  assert.equal((await pending.completion).action,"allow_once");
  assert.deepEqual(await f.make().list(),[]);
});

test("invalid or conflicting duration cannot increase a native grant",async t=>{
  assert.equal(approvalMemoryContext({...context,approve_for:"9h"}),null);
  assert.equal(approvalMemoryContext({...context,approve_for:"always",allowed_durations:["once","8h"]}),null);
  const f=await fixture(t),sent=[],value=request(),current=state();
  value.approval_memory.approve_for="8h";current.approval_memory_policy.approve_for="8h";
  const controller=new ClassifierApprovalController({send:v=>sent.push(v),getState:async()=>current,memory:f.make()});
  const pending=await controller.begin(value);
  controller.handleReply({id:sent[0].id,result:{action:"accept",content:{duration:"always"}}});
  assert.equal((await pending.completion).reason,"approval_duration_invalid");
  assert.deepEqual(await f.make().list(),[]);
});

test("2h/4h/8h grants persist across reconstruction, expire exactly, and separate scopes",async t=>{
  const f=await fixture(t);
  for(const [duration,hours]of [["2h",2],["4h",4],["8h",8]]){
    f.setNow(1000);const binding={...context,invocation_sha256:String(hours).repeat(64)};
    await f.make().remember(binding,duration);
    assert.equal((await f.make().lookup(binding)).duration,duration);
    assert.equal(await f.make("different-project").lookup(binding),null);
    for(const field of ["policy_sha256","invocation_sha256","dependency_sha256"]){assert.equal(await f.make().lookup({...binding,[field]:"d".repeat(64)}),null);}
    f.setNow(1000+hours*3600_000-1);assert(await f.make().lookup(binding));
    f.setNow(1000+hours*3600_000);assert.equal(await f.make().lookup(binding),null);
  }
});
test("always is durable, revocable, and clock rollback never extends a grant",async t=>{
  const f=await fixture(t),memory=f.make();const grant=await memory.remember(context,"always");
  f.setNow(9000);assert(await f.make().lookup(context));f.setNow(1000);assert.equal(await memory.lookup(context),null);
  f.setNow(10000);assert.equal((await memory.list()).length,1);
  await f.make().revoke(grant.id);assert.equal(await memory.lookup(context),null);
  await memory.remember(context,"always");await memory.revoke("all");assert.deepEqual(await memory.list(),[]);
  await assert.rejects(memory.revoke("../../anything"));
});
test("tampered, malformed and permissive records cannot manufacture approval",async t=>{
  const f=await fixture(t),memory=f.make();const grant=await memory.remember(context,"2h");
  const path=join(memory.root,grant.id+".json"),value=JSON.parse(await readFile(path,"utf8"));
  value.grant.duration="always";value.grant.expires_at=null;await writeFile(path,JSON.stringify(value));
  await assert.rejects(memory.lookup(context),/record_invalid/);
  const bytes=await readFile(path,"utf8");assert(!bytes.includes(context.invocation_sha256));assert(!bytes.includes("principal/project"));
  assert((await readdir(memory.root)).includes("key"));
  assert.equal(approvalMemoryContext({...context,policy_sha256:null}),null);
  await assert.rejects(memory.remember(context,"once"),/duration_invalid/);
});
test("native accepted duration creates a grant; repeat uses a fresh invocation receipt without a prompt",async t=>{
  const f=await fixture(t),sent=[],events=[];const memory=f.make();
  const value=request();value.approval_memory.approve_for="4h";
  const currentState=state();currentState.approval_memory_policy.approve_for="4h";
  const controller=new ClassifierApprovalController({send:v=>sent.push(v),getState:async()=>currentState,memory,record:e=>events.push(e)});
  const first=await controller.begin(value);const modal=sent.find(v=>v.method==="mcpServer/elicitation/request");
  assert.deepEqual(modal.params.requestedSchema.properties,{});
  controller.handleReply({id:modal.id,result:{action:"accept"}});
  assert.equal((await first.completion).duration,"4h");controller.close();
  const next=new ClassifierApprovalController({send:v=>sent.push(v),getState:async()=>currentState,memory:f.make(),record:e=>events.push(e)});
  const current=structuredClone(value);current.classifier_receipt.invocation_fingerprint="invocation_v1_after-gateway-restart";
  const reused=await next.begin(current);
  assert.equal(reused.outcome,"allow");assert.equal(reused.response.reason,"remembered_human_approval");
  assert.equal(reused.response.invocation_fingerprint,current.classifier_receipt.invocation_fingerprint);
  assert.equal(sent.filter(v=>v.method==="mcpServer/elicitation/request").length,1);
  await new Promise(resolve=>setImmediate(resolve));assert(events.some(e=>e.type==="classifier_approval_memory_reused"));
});
test("decline, cancel, missing provenance and forged duration do not create reusable grants",async t=>{
  const f=await fixture(t);
  for(const action of ["decline","cancel","accept"]){const sent=[],value=request();value.approval_memory.reusable=false;
    const controller=new ClassifierApprovalController({send:v=>sent.push(v),getState:async()=>state(),memory:f.make()});
    const first=await controller.begin(value);const modal=sent[0];assert.deepEqual(modal.params.requestedSchema.properties,{});
    controller.handleReply({id:modal.id,result:{action,content:{duration:"always"}}});
    assert.equal((await first.completion).action,"deny");controller.close();
  }
  assert.deepEqual(await f.make().list(),[]);
});
test("policy/owner changes and duplicate replies cannot turn an accepted dialog into a reusable grant",async t=>{
  const f=await fixture(t),sent=[];let current=state();
  const controller=new ClassifierApprovalController({send:v=>sent.push(v),getState:async()=>current,memory:f.make()});
  const first=await controller.begin(request());const id=sent[0].id;
  current={...current,approval_memory_policy:{...current.approval_memory_policy,policy_sha256:"d".repeat(64)}};
  const reply={id,result:{action:"accept"}};controller.handleReply(reply);controller.handleReply(reply);
  assert.equal((await first.completion).reason,"approval_state_changed");assert.deepEqual(await f.make().list(),[]);
});
test("revocation or expiry during state reread is checked again at release",async t=>{
  for(const reason of ["revoke","expire"]){const f=await fixture(t),memory=f.make(),grant=await memory.remember(context,"2h");
    const value=request();value.approval_memory.approve_for="2h";const current=state();current.approval_memory_policy.approve_for="2h";
    let read=0;const controller=new ClassifierApprovalController({send:()=>assert.fail("may not prompt on an invalidated in-flight grant"),memory,
      getState:async()=>{if(++read===2){if(reason==="revoke")await f.make().revoke(grant.id);else f.setNow(1000+2*3600_000);}return current;}});
    const result=await controller.begin(value);assert.equal(result.response.action,"deny");assert.equal(result.response.reason,"approval_memory_no_longer_valid");
  }
});
test("a crashed owner's unique lock ticket is reclaimed without deleting live tickets",async t=>{
  const f=await fixture(t),memory=f.make();await memory.remember(context,"2h");
  const child=spawn(process.execPath,["-e","process.stdout.write(String(process.pid))"],{stdio:["ignore","pipe","pipe"]});
  let pid="";child.stdout.on("data",chunk=>{pid+=chunk;});await once(child,"close");
  const ticket=join(memory.root,"queue",`${pid}-12345678-1234-1234-1234-123456789abc`);
  await mkdir(ticket);await writeFile(join(ticket,"owner"),JSON.stringify({choosing:false,number:1}),{mode:0o600});
  assert(await f.make().lookup(context));assert.deepEqual(await readdir(join(memory.root,"queue")),[]);
  await Promise.all([f.make().lookup(context),f.make().list(),f.make().lookup(context)]);
});
