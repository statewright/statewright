import test from "node:test";
import assert from "node:assert/strict";
import {bindCatalogue, digestJson, verifyOriginalInvocation, NativeMcpItems} from "../lib/native-mcp-approval-binding.mjs";

test("exact original MCP invocation and uniquely owned catalogue are bound", () => {
  const name = "mcp__codex_apps__github_fetch_commit";
  const input = {repo_full_name:"statewright/statewright",commit_sha:"abc"};
  const memory = {grant_policy_v2_sha256:"a".repeat(64),invocation_sha256:digestJson([name,input])};
  assert.equal(memory.invocation_sha256,"7f0d842f4df60dfc4ed2700f613774620f98383e457d0959f2cf320ca3b5076f");
  assert.equal(verifyOriginalInvocation({original_tool_name:name,original_tool_input:input},memory),name);
  assert.equal(verifyOriginalInvocation({original_tool_name:name,original_tool_input:{...input,commit_sha:"changed"}},memory),null);
  const server = {name:"codex_apps",tools:{github_fetch_commit:{name:"github_fetch_commit",inputSchema:{type:"object"}}},authStatus:"authenticated"};
  const first = bindCatalogue(name,[server],"generation-one","b".repeat(64));
  assert.match(first,/^[a-f0-9]{64}$/);
  assert.notEqual(first,bindCatalogue(name,[server],"generation-two","b".repeat(64)));
  assert.notEqual(first,bindCatalogue(name,[{...server,authStatus:"other"}],"generation-one","b".repeat(64)));
  assert.equal(bindCatalogue(name,[server,server],"generation-one","b".repeat(64)),null);
  assert.equal(bindCatalogue(name,[],"generation-one","b".repeat(64)),null);
});

test("host correlation requires a unique live matching item and retires it", () => {
  const tracker = new NativeMcpItems();
  const args = {query:"private value"};
  const identity = {threadId:"thread",turnId:"turn",toolUseId:"item",toolName:"mcp__server__search",invocation:digestJson(["mcp__server__search",args])};
  const start = {method:"item/started",params:{threadId:"thread",turnId:"turn",item:{id:"item",type:"mcpToolCall",server:"server",tool:"search",arguments:args,appContext:{connectorId:"connector",linkId:"link"}}}};
  tracker.observe(start);
  assert.equal(tracker.match(identity),null);
  tracker.observe({method:"turn/started",params:{threadId:"thread",turn:{id:"turn"}}});
  tracker.observe(start);
  assert.deepEqual(tracker.match(identity),{server:"server",connectorId:"connector",linkId:"link"});
  assert.equal(JSON.stringify([...tracker.items.values()]).includes("private value"),false);
  assert.equal(tracker.match({...identity,threadId:"foreign"}),null);
  assert.equal(tracker.match({...identity,invocation:"wrong"}),null);
  tracker.observe(start);
  assert.equal(tracker.match(identity),null);
  tracker.observe({method:"turn/started",params:{threadId:"thread",turn:{id:"turn2"}}});
  assert.equal(tracker.match(identity),null);
  tracker.observe({method:"turn/started",params:{threadId:"thread",turn:{id:"turn"}}});
  tracker.observe(start);
  tracker.observe({method:"item/completed",params:{threadId:"thread",turnId:"turn",item:{id:"item"}}});
  assert.equal(tracker.match(identity),null);
  tracker.observe(start);
  assert.equal(tracker.match(identity),null);
  tracker.observe({method:"turn/started",params:{threadId:"thread",turn:{id:"turn-new"}}});
  tracker.observe({method:"item/started",params:{threadId:"thread",turnId:"turn-new",item:{id:"other",type:"mcpToolCall",server:"other",tool:"mcp__server__search",arguments:args}}});
  assert.equal(tracker.match({...identity,turnId:"turn-new",toolUseId:"other"}),null);
});

test("canonicalization preserves key order independence and rejects missing originals", () => {
  assert.equal(digestJson(["x",{b:2,a:{z:"😀",a:1}}]),digestJson(["x",{a:{a:1,z:"😀"},b:2}]));
  assert.equal(digestJson(["mcp__x__y",{"2":2,"10":1,"\ue000":3,"\u{10000}":4}]),"9c039e5819278e9ee85f5acc4632a0a04ffba4e409b58131fb4b11f4526be37a");
  assert.equal(verifyOriginalInvocation({original_tool_name:"mcp__x__y"},{grant_policy_v2_sha256:"a".repeat(64)}),null);
});

test("duplicate and stale turn starts cannot revive a completed item", () => {
  const tracker=new NativeMcpItems({maxTurns:2});
  const args={q:"x"};
  const turn=id=>({method:"turn/started",params:{threadId:"t",turn:{id}}});
  const item=(turnId,id)=>({method:"item/started",params:{threadId:"t",turnId,item:{id,type:"mcpToolCall",server:"s",tool:"read",arguments:args}}});
  const match=(turnId,id)=>tracker.match({threadId:"t",turnId,toolUseId:id,toolName:"mcp__s__read",invocation:digestJson(["mcp__s__read",args])});
  tracker.observe(turn("one"));tracker.observe(item("one","a"));assert(match("one","a"));
  tracker.observe({method:"item/completed",params:{threadId:"t",turnId:"one",item:{id:"a"}}});
  tracker.observe(turn("one"));tracker.observe(item("one","a"));assert.equal(match("one","a"),null);
  tracker.observe({method:"turn/completed",params:{threadId:"t",turn:{id:"one"}}});
  tracker.observe(turn("one"));tracker.observe(item("one","a"));assert.equal(match("one","a"),null);
  tracker.observe(turn("two"));tracker.observe(item("two","b"));assert(match("two","b"));
  tracker.observe(turn("one"));assert(match("two","b"));assert.equal(match("one","a"),null);
  tracker.observe(turn("three"));tracker.observe(item("three","c"));
  assert.equal(match("two","b"),null);assert.equal(match("three","c"),null);
});
