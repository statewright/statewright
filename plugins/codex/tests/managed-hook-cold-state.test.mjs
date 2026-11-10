import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {once} from "node:events";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

async function fixture(t, {kind="active", foreign=false, pending=false, moveRootOnRead=false, removeRootOnRead=false, managed=true, missingToken=false}={}) {
  const home=await mkdtemp(join(tmpdir(),"statewright-cold-hook-"));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const clientId=`swc_${"a".repeat(32)}`, threadId="cold-hook-thread", control=join(home,"routes");
  await mkdir(control);
  await writeFile(join(control,"identity.json"),JSON.stringify({version:1,host:"codex",client_id:clientId}));
  await writeFile(join(control,"codex-root-session.json"),JSON.stringify({version:1,client_id:clientId,session_id:foreign?"foreign":threadId}));
  const state={state:"canary",workflow:"fixture",state_epoch:1,run_id:"run",run_session_id:"session",session_generation:"generation",
    is_final:kind==="terminal",context:{tool_policy_mode:"denylist_heuristic_v1"},allowed_tools:["Read"],transitions:[],
    pending_approval:pending?{approval_id:"pending"}:null};
  const requests=[];
  const server=createServer(async(req,res)=>{
    let text="";for await(const chunk of req)text+=chunk;
    const rpc=JSON.parse(text);requests.push(rpc.params.name);
    assert.equal(req.headers.authorization,"Bearer isolated-bridge");assert.equal(req.headers["x-statewright-client-id"],clientId);
    if(kind==="unavailable"){res.writeHead(503);res.end();return;}
    if(moveRootOnRead && rpc.params.name==="statewright_get_state")await writeFile(join(control,"codex-root-session.json"),JSON.stringify({version:1,client_id:clientId,session_id:"foreign"}));
    if(removeRootOnRead && rpc.params.name==="statewright_get_state")await rm(join(control,"codex-root-session.json"));
    const inactive=kind==="inactive"&&rpc.params.name==="statewright_get_state";
    const value=rpc.params.name==="statewright_get_state"?state:rpc.params.name==="statewright_get_status"
      ?{active_workflow:null,current_state:null}:{decision:"deny",reason:"Current phase permits Read only.",risk_assessment:{final_denial_basis:"workflow_capability_write_denied",separate_approval_allowed:false}};
    res.setHeader("Content-Type","application/json");
    res.end(JSON.stringify({jsonrpc:"2.0",id:rpc.id,result:{isError:inactive,content:[{type:"text",text:inactive
      ?"No active workflow. Load a workflow before requesting state.":JSON.stringify(value)}]}}));
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>new Promise(r=>server.close(r)));
  const env={...process.env};for(const key of Object.keys(env))if(/^(STATEWRIGHT_|CODEX_)/.test(key))delete env[key];
  Object.assign(env,{HOME:home,STATEWRIGHT_CLIENT_ID:clientId,STATEWRIGHT_ROUTE_CONTROL_DIR:control,STATEWRIGHT_MANAGED_CLIENT_HOST:"codex",
    STATEWRIGHT_GATEWAY_URL:"http://127.0.0.1:1",STATEWRIGHT_API_KEY:"isolated-fixture",STATEWRIGHT_MANAGED_MCP_URL:`http://127.0.0.1:${server.address().port}`,
    STATEWRIGHT_MANAGED_MCP_TOKEN:"isolated-bridge",STATEWRIGHT_NATIVE_TELEMETRY:"0"});
  if(!managed){delete env.STATEWRIGHT_MANAGED_MCP_URL;delete env.STATEWRIGHT_MANAGED_MCP_TOKEN;}
  if(missingToken)delete env.STATEWRIGHT_MANAGED_MCP_TOKEN;
  const invoke=async(endpoint="pre-tool",tool="Write")=>{
    const child=spawn("bash",[new URL("../hook.sh",import.meta.url).pathname,endpoint],{env});
    let output="";child.stdout.on("data",x=>output+=x);child.stderr.resume();
    child.stdin.end(JSON.stringify({session_id:threadId,tool_name:tool,tool_input:{file_path:"/fixture/never-written",content:"diagnostic only"}}));
    const [code]=await once(child,"exit");assert.equal(code,0);return output;
  };
  const directory=join(home,".statewright/sessions", "a".repeat(16));
  return {invoke,requests,active:join(directory,".active"),directory,state,clientId,threadId,home,control};
}

test("a missed load completion cannot make the first managed tool bypass an active workflow",async t=>{
  const f=await fixture(t);const output=JSON.parse(await f.invoke());
  assert.equal(output.hookSpecificOutput.permissionDecision,"deny");
  assert(f.requests.includes("statewright_adapter_pre_tool"));
  const active=JSON.parse(await readFile(f.active,"utf8"));assert.equal(active.run_id,f.state.run_id);
});

for(const kind of ["inactive","terminal"])test(`cold ${kind} native state remains dormant without fabricating activation`,async t=>{
  const f=await fixture(t,{kind});assert.equal(await f.invoke(),"");
  assert(f.requests.includes("statewright_get_state"));await assert.rejects(readFile(f.active),{code:"ENOENT"});
});

for(const options of [{kind:"unavailable"},{foreign:true}])test(`cold state fails closed for ${options.foreign?"foreign root":"unavailable bridge"}`,async t=>{
  const f=await fixture(t,options);assert.equal(JSON.parse(await f.invoke()).hookSpecificOutput.permissionDecision,"deny");
  await assert.rejects(readFile(f.active),{code:"ENOENT"});if(options.foreign)assert.deepEqual(f.requests,[]);
});

test("cold reconciliation preserves a pending human gate without forcing continuation",async t=>{
  const f=await fixture(t,{pending:true});assert.equal(await f.invoke("stop"),"");
  assert(f.requests.includes("statewright_get_state"));
});

test("a missing cache is rebuilt only for its matching already-bound run",async t=>{
  const f=await fixture(t);await mkdir(f.directory,{recursive:true});
  await writeFile(f.active,JSON.stringify({version:1,client_id:f.clientId,thread_id:f.threadId,run_id:"run",run_session_id:"session"}));
  assert.equal(JSON.parse(await f.invoke()).hookSpecificOutput.permissionDecision,"deny");
  assert(f.requests.includes("statewright_adapter_pre_tool"));
  assert.equal(JSON.parse(await readFile(join(f.directory,".state_cache"),"utf8")).run_id,"run");
});

test("a stale run binding cannot be silently replaced on cache loss",async t=>{
  const f=await fixture(t);await mkdir(f.directory,{recursive:true});await writeFile(join(f.directory,".run_id"),"older-run\n");
  assert.equal(JSON.parse(await f.invoke()).hookSpecificOutput.permissionDecision,"deny");
  assert.equal(await readFile(join(f.directory,".run_id"),"utf8"),"older-run\n");
  await assert.rejects(readFile(f.active),{code:"ENOENT"});
});

test("owner loss during the authoritative state read cannot publish activation",async t=>{
  const f=await fixture(t,{moveRootOnRead:true});
  assert.equal(JSON.parse(await f.invoke()).hookSpecificOutput.permissionDecision,"deny");
  await assert.rejects(readFile(f.active),{code:"ENOENT"});
});

test("native discovery remains available while ordinary tools are held",async t=>{
  const f=await fixture(t,{kind:"unavailable"});
  assert.equal(await f.invoke("pre-tool","mcp__statewright__statewright_get_state"),"");
  assert.deepEqual(f.requests,[]);
});

test("incomplete bridge configuration cannot fall back to direct credentials",async t=>{
  const f=await fixture(t,{missingToken:true});
  assert.equal(JSON.parse(await f.invoke()).hookSpecificOutput.permissionDecision,"deny");
  assert.deepEqual(f.requests,[]);
});

test("unmanaged dormant clients do not acquire a gateway workflow",async t=>{
  const f=await fixture(t,{managed:false});assert.equal(await f.invoke(),"");assert.deepEqual(f.requests,[]);
});

test("cold activation requires current generation evidence",async t=>{
  const f=await fixture(t);delete f.state.session_generation;
  assert.equal(JSON.parse(await f.invoke()).hookSpecificOutput.permissionDecision,"deny");
  await assert.rejects(readFile(f.active),{code:"ENOENT"});
});

test("a cold user prompt obtains current instructions instead of claiming no workflow",async t=>{
  const f=await fixture(t);await mkdir(join(f.home,".statewright"),{recursive:true});
  await writeFile(join(f.home,".statewright/.update_checked"),"");
  const output=await f.invoke("user-prompt");assert.match(output,/Statewright workflow active/);assert.doesNotMatch(output,/No workflow running/);
  assert.equal(JSON.parse(await readFile(f.active,"utf8")).run_id,"run");
});

test("a missing native root registration never authorizes cold adoption",async t=>{
  const f=await fixture(t);await rm(join(f.control,"codex-root-session.json"));
  assert.equal(JSON.parse(await f.invoke()).hookSpecificOutput.permissionDecision,"deny");assert.deepEqual(f.requests,[]);
});

test("a foreign web connector cannot use the local discovery exemption",async t=>{
  const f=await fixture(t,{kind:"unavailable"});
  assert.equal(JSON.parse(await f.invoke("pre-tool","mcp__codex_apps__statewright_get_state")).hookSpecificOutput.permissionDecision,"deny");
});

test("cold enforcement reconciliation preserves existing model-route bytes",async t=>{
  const f=await fixture(t),path=join(f.control,"current.route.json"),bytes='{"model":"user-original","thinking_level":null}\n';
  await writeFile(path,bytes);await f.invoke();assert.equal(await readFile(path,"utf8"),bytes);
});

for(const kind of ["inactive","terminal"])test(`an already-bound run with lost cache cleans up on authoritative ${kind}`,async t=>{
  const f=await fixture(t,{kind});await mkdir(f.directory,{recursive:true});
  await writeFile(f.active,JSON.stringify({version:1,client_id:f.clientId,thread_id:f.threadId,run_id:"run",run_session_id:"session"}));
  assert.equal(await f.invoke(),"");await assert.rejects(readFile(f.active),{code:"ENOENT"});
});

test("registration removal during the state read cannot publish activation",async t=>{
  const f=await fixture(t,{removeRootOnRead:true});
  assert.equal(JSON.parse(await f.invoke()).hookSpecificOutput.permissionDecision,"deny");
  await assert.rejects(readFile(f.active),{code:"ENOENT"});
});
