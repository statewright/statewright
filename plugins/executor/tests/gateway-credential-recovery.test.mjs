import test from "node:test";
import assert from "node:assert/strict";
import {createGatewayCredentialRecovery} from "../lib/gateway-credential-recovery.mjs";
const gateway = "https://gateway.example/mcp", pb = "https://account.example";
function fixture(response, options = {}) {
  const reads = [], connections = [], messages = [];
  const recover = createGatewayCredentialRecovery({gatewayUrl:gateway,pbUrl:pb,apiKey:"expired-private-key",environment:{},home:"/nonexistent-fixture-home",
    fetchImpl:async (url, init)=>{reads.push({url:String(url),...init});return response},
    connect:async options=>{connections.push(options)},notify:message=>messages.push(message),...options});
  return {recover,reads,connections,messages};
}
test("confirmed expired/revoked credential starts one exact-profile browser flow for concurrent requests",async()=>{
  const f=fixture({status:401,json:async()=>({error:"API key required"})});
  await Promise.all([f.recover(),f.recover()]);
  assert.equal(f.reads.length,1);assert.equal(f.connections.length,1);
  assert.equal(f.reads[0].url,pb+"/api/gateway/workflows");assert.equal(f.reads[0].method,"GET");assert.equal(f.reads[0].redirect,"error");
  assert.equal(f.reads[0].headers["X-Statewright-OAuth-Resource"],gateway);
  await f.connections[0].showDialog({userCode:"ABCD-EFGH-IJKL",verificationUrl:pb+"/device?user_code=ABCD-EFGH-IJKL"});
  assert.equal(f.messages.length,1);assert.match(f.messages[0],/ABCD-EFGH-IJKL/);assert.doesNotMatch(f.messages[0],/ChatGPT|Desktop/);
  assert.equal(f.connections[0].state.gateway_url,gateway);assert.equal(f.connections[0].environment.STATEWRIGHT_PB_URL,pb);
});
test("missing key uses the same provisioning flow without an authenticated request",async()=>{
  const f=fixture(null,{apiKey:null});await f.recover();assert.equal(f.reads.length,0);assert.equal(f.connections.length,1);
});
for(const status of [200,403,404,429,500])test(`credential verification HTTP ${status} cannot trigger browser provisioning`,async()=>{
  const f=fixture({status});await assert.rejects(f.recover(),/could not confirm/);assert.equal(f.connections.length,0);
});
test("unrecognized 401 and offline verification do not trigger login",async()=>{
  const f=fixture({status:401,json:async()=>({error:"origin rejected"})});await assert.rejects(f.recover());assert.equal(f.connections.length,0);
  const offline=fixture(null,{fetchImpl:async()=>{throw Error("offline")}});await assert.rejects(offline.recover(),/offline/);assert.equal(offline.connections.length,0);
});
test("denied connection is not restarted by another failed request",async()=>{
  let attempts=0;const f=fixture({status:401,json:async()=>({error:"invalid_api_key"})},{connect:async()=>{attempts++;throw Error("user denied")}});
  await assert.rejects(f.recover(),/user denied/);await assert.rejects(f.recover(),/user denied/);assert.equal(attempts,1);
});

test("TUI reprovisioning completes the real device flow with terminal notice and browser, without a Desktop dialog",async()=>{
  const {connectDesktopProfile}=await import("../lib/desktop-device-connect.mjs");
  const events=[];const key="sw_live_"+"A".repeat(64);let stored;
  const fetchImpl=async (url,init)=>{
    events.push({url:String(url),method:init.method??"GET"});
    if(String(url).endsWith("/api/gateway/workflows"))return {status:stored?200:401,ok:!!stored,json:async()=>({error:"API key required"})};
    if(String(url).endsWith("/device/code"))return {ok:true,json:async()=>({device_code:"a".repeat(32),user_code:"ABCD-EFGH-IJKL",expires_in:600,interval:5,verification_uri_complete:pb+"/device?user_code=ABCD-EFGH-IJKL"})};
    if(String(url).endsWith("/device/token")){stored=key;return {ok:true,json:async()=>({access_token:key,token_type:"Bearer"})}}
    throw Error("unexpected request");
  };
  const f=fixture(null,{fetchImpl,connect:options=>connectDesktopProfile({...options,fetchImpl,
    openBrowser:async url=>events.push({browser:url}),storeCredential:async(_gateway,value)=>{assert.equal(value,key)},readCredential:async()=>key,sleep:async()=>{},now:()=>0})});
  const presentation=await f.recover();
  assert.equal(presentation.pending,true);assert.equal(presentation.userCode,"ABCD-EFGH-IJKL");
  for(let i=0;i<20;i++){await new Promise(resolve=>setImmediate(resolve));if((await f.recover()).renewed)break}
  assert.equal((await f.recover()).renewed,true);
  assert.equal(f.messages.length,1);assert.equal(events.filter(e=>e.browser).length,1);
  assert.equal(events.filter(e=>e.method==="POST").length,2);
  assert.ok(events.every(e=>!e.url||!e.url.includes("runtime-approval")));
});


test("native 401 error presents the code immediately while real device-token polling is pending",async t=>{
  const {connectDesktopProfile}=await import("../lib/desktop-device-connect.mjs");
  const {createRuntimeApprovalService}=await import("../lib/runtime-approval-service.mjs");
  const {mkdtemp,rm}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
  const root=await mkdtemp(join(tmpdir(),"tui-recovery-visible-"));t.after(()=>rm(root,{recursive:true,force:true}));
  let releasePoll,stored=false,authorized=false,nativeCalls=0,browserCalls=0;
  const key="sw_live_"+"B".repeat(64);
  const fetchImpl=async (url,init)=>{
    if(String(url).endsWith("/api/gateway/workflows"))return {status:authorized?200:401,ok:authorized,json:async()=>({error:"API key required"})};
    if(String(url).endsWith("/device/code"))return {ok:true,json:async()=>({device_code:"b".repeat(32),user_code:"ABCD-EFGH-IJKL",expires_in:600,interval:5,verification_uri_complete:pb+"/device?user_code=ABCD-EFGH-IJKL"})};
    if(String(url).endsWith("/device/token")){authorized=true;return {ok:true,json:async()=>({access_token:key,token_type:"Bearer"})}}
    throw Error("unexpected request");
  };
  const f=fixture(null,{fetchImpl,readCredential:async()=>key,onRenewed:async renewedKey=>service.updateCredential(renewedKey),connect:options=>connectDesktopProfile({...options,fetchImpl,
    openBrowser:async()=>{browserCalls++},storeCredential:async()=>{stored=true},readCredential:async()=>key,
    sleep:()=>new Promise(resolve=>{releasePoll=resolve}),now:()=>0})});
  const service=createRuntimeApprovalService({root,apiKey:"expired-key",gatewayUrl:gateway,clientId:"client",pbUrl:pb,
    fetchImpl:async(_url,options)=>{nativeCalls++;return options.headers.Authorization===`Bearer ${key}`
      ? {status:200,ok:true,json:async()=>({result:{structuredContent:{state:"review"}}})}
      : {status:401,ok:false}},reprovisionCredential:f.recover});
  await assert.rejects(service.getState(),error=>error.code==="STATEWRIGHT_CREDENTIAL_REPROVISION_PENDING"&&error.message.includes("ABCD-EFGH-IJKL")&&error.message.includes(pb+"/device?user_code="));
  assert.equal(stored,false);assert.equal(browserCalls,1);assert.equal(nativeCalls,1);
  await assert.rejects(service.getState(),error=>error.code==="STATEWRIGHT_CREDENTIAL_REPROVISION_PENDING");
  assert.equal(browserCalls,1);releasePoll();
  for(let i=0;i<20&&!stored;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stored,true);
  for(let i=0;i<20;i++){await new Promise(resolve=>setImmediate(resolve));if((await f.recover()).renewed)break}
  assert.deepEqual(await service.getState(),{state:"review"});
  assert.equal(nativeCalls,3,"only the three explicit state requests; no automatic replay");
});

test("an expired code can restart on a subsequent explicit request, never in a background loop",async()=>{
  let attempts=0,expire;
  const f=fixture({status:401,json:async()=>({error:"API key required"})},{connect:async options=>{
    attempts++;await options.showDialog({userCode:"ABCD-EFGH-IJKL",verificationUrl:pb+"/device?user_code=ABCD-EFGH-IJKL"});
    await new Promise((_,reject)=>{expire=()=>reject(Object.assign(Error("expired"),{code:"DESKTOP_CONNECT_EXPIRED"}))});
  }});
  assert.equal((await f.recover()).pending,true);expire();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(attempts,1);
  assert.equal((await f.recover()).pending,true);assert.equal(attempts,2);
  expire();await new Promise(resolve=>setImmediate(resolve));assert.equal(attempts,2);
});
