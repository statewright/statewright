import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { ManagedMcpBridge, timeoutForManagedMcpRequest } from "../lib/managed-mcp-bridge.mjs";

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", resolveStart);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

test("managed MCP bridge reserves a bounded long timeout only for delegated agent runs", () => {
  assert.equal(timeoutForManagedMcpRequest(Buffer.from('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_run_agent"}}')), 300_000);
  assert.equal(timeoutForManagedMcpRequest(Buffer.from('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"statewright_get_state"}}')), 15_000);
  assert.equal(timeoutForManagedMcpRequest(Buffer.from("not json")), 15_000);
});

test("managed MCP bridge forwards one immutable client identity", async () => {
  let receivedIdentity = null;
  const upstream = await startServer(async (request, response) => {
    receivedIdentity = request.headers["x-statewright-client-id"];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"jsonrpc":"2.0","result":{"ok":true},"id":1}\n');
  });
  const bridge = await new ManagedMcpBridge({
    gatewayUrl: upstream.url,
    apiKey: "test-key",
    clientId: "swc_0123456789abcdef0123456789abcdef",
    token: "bridge-token",
  }).start();
  try {
    const response = await fetch(`${bridge.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer bridge-token" },
      body: '{"jsonrpc":"2.0","method":"tools/call","id":1}',
    });
    assert.equal(response.status, 200);
    assert.equal(receivedIdentity, "swc_0123456789abcdef0123456789abcdef");
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("successor continuity uses only the owned gateway and private native-origin proof", async t => {
  const calls=[];
  const bridge=await new ManagedMcpBridge({gatewayUrl:"https://gateway.invalid/mcp",
    apiKey:"fixture-key",clientId:"client",token:"fixture-bridge",originProof:"a".repeat(64),
    fetch:async(url,options)=>{
      calls.push({url:String(url),options});
      return Response.json({schema:"statewright/route-successor/v1",verified:true});
    }}).start();
  t.after(()=>bridge.close());
  const request=(headers={})=>fetch(bridge.url+"/route-successor",{method:"POST",
    headers:{Authorization:"Bearer fixture-bridge","Content-Type":"application/json",...headers},
    body:JSON.stringify({previous:{run_id:"old"},current:{run_id:"new"}})});
  assert.equal((await request({"X-Statewright-Client-Id":"foreign"})).status,403);
  assert.equal((await request({Authorization:"Bearer foreign"})).status,401);
  assert.equal(calls.length,0);
  assert.equal((await request()).status,200);
  assert.equal(calls[0].url,"https://gateway.invalid/api/runtime-route-successor");
  assert.equal(calls[0].options.headers["X-Statewright-Client-Id"],"client");
  assert.equal(calls[0].options.headers["x-statewright-approval-origin"],"a".repeat(64));
  assert.equal(calls[0].options.redirect,"error");
  assert(!calls[0].options.body.includes("a".repeat(64)));
});

test("managed state recovery uses only the host-bound run hint and private proof", async t => {
  const calls=[];
  let bound="owned-run";
  const bridge=await new ManagedMcpBridge({gatewayUrl:"https://gateway.invalid/mcp",
    apiKey:"fixture",clientId:"client",token:"bridge",originProof:"a".repeat(64),
    recoveryRun:async()=>bound,fetch:async(_url,options)=>{
      calls.push(JSON.parse(options.body.toString()));
      return Response.json({jsonrpc:"2.0",id:1,result:{}});
    }}).start();
  t.after(()=>bridge.close());
  const send=()=>fetch(bridge.url+"/mcp",{method:"POST",headers:{Authorization:"Bearer bridge"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",
      params:{name:"statewright_get_state",arguments:{recover_run_id:"foreign"}}})});
  assert.equal((await send()).status,200);
  assert.deepEqual(calls[0].params.arguments,{recover_run_id:"owned-run"});
  bound=null;
  assert.equal((await send()).status,200);
  assert.deepEqual(calls[1].params.arguments,{});
});

test('human interaction relay keeps the configured destination, native owner token and client boundary',async t=>{
  const calls=[];
  const bridge=await new ManagedMcpBridge({gatewayUrl:'https://gateway.invalid/mcp',apiKey:'server-key',
    clientId:'owner',token:'local-token',humanInteractionUrl:'https://staging.invalid/api/gateway/human-interactions',
    fetch:async(url,options)=>{calls.push({url,options});return Response.json({accepted_event_ids:['event']},{status:202});}}).start();
  t.after(()=>bridge.close());
  const send=(headers={})=>fetch(bridge.url+'/human-interactions',{method:'POST',
    headers:{Authorization:'Bearer local-token','X-Statewright-Client-Id':'owner',...headers},
    body:JSON.stringify({events:[{event_id:'event'}],url:'https://foreign.invalid'})});
  assert.equal((await send({Authorization:'Bearer wrong'})).status,401);
  assert.equal((await send({'X-Statewright-Client-Id':'foreign'})).status,403);
  assert.equal((await send({Origin:'https://foreign.invalid'})).status,401);
  assert.equal(calls.length,0);
  assert.equal((await send()).status,202);
  assert.equal(calls[0].url,'https://staging.invalid/api/gateway/human-interactions');
  assert.equal(calls[0].options.headers.Authorization,'Bearer server-key');
  assert.equal(calls[0].options.redirect,'error');
});

test("managed host supplies its own private proof and never follows a redirect with it", async t => {
  const proof = "a".repeat(64), calls=[];
  const bridge = await new ManagedMcpBridge({gatewayUrl:"https://gateway.example/mcp",apiKey:"key",clientId:"owner",token:"token",originProof:proof,
    fetch:async (url,options) => {calls.push({url,...options}); return Response.json({jsonrpc:"2.0",id:1,result:{ok:true}});}}).start();
  t.after(() => bridge.close());
  const response = await fetch(`${bridge.url}/mcp`,{method:"POST",headers:{Authorization:"Bearer token","x-statewright-approval-origin":"foreign"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"statewright_get_state",arguments:{}}})});
  assert.equal(response.status,200);
  assert.equal(calls.length,1);
  assert.equal(calls[0].headers["x-statewright-approval-origin"],proof);
  assert.equal(calls[0].redirect,"error");
  assert.equal(calls[0].body.includes(proof),false);
  assert.equal((await response.text()).includes(proof),false);
});

test("managed MCP bridge rejects a caller without its supervisor token", async () => {
  const upstream = await startServer((_request, response) => response.writeHead(500).end());
  const bridge = await new ManagedMcpBridge({
    gatewayUrl: upstream.url,
    apiKey: "test-key",
    clientId: "swc_0123456789abcdef0123456789abcdef",
    token: "bridge-token",
  }).start();
  try {
    const response = await fetch(`${bridge.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
      body: "{}",
    });
    assert.equal(response.status, 401);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("managed MCP bridge preserves SSE and renders typed upstream HTTP failures", async () => {
  const payload = '{ "jsonrpc":"2.0", "result":{"tools":[{"name":"statewright_get_usage"},{"name":"statewright_transition"}]}, "id":1 }\n';
  let contentType = "application/json";
  let status = 200;
  const bridge = await new ManagedMcpBridge({
    gatewayUrl: "https://gateway.example/mcp", apiKey: "test-key", clientId: "test-client", token: "bridge-token",
    fetch: async () => new Response(payload, { status, headers: { "content-type": contentType, "mcp-session-id": "session-1" } }),
  }).start();
  const call = () => fetch(`${bridge.url}/mcp`, {
    method: "POST", headers: { Authorization: "Bearer bridge-token" },
    body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
  });
  try {
    const response = await call();
    assert.equal(response.headers.get("mcp-session-id"), "session-1");
    const { result } = await response.json();
    assert.deepEqual(result.tools[0].annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    assert.equal(result.tools[1].annotations, undefined);
    contentType = "text/event-stream";
    assert.equal(await (await call()).text(), payload);
    contentType = "application/json";
    status = 500;
    const failure = await call();
    assert.equal(failure.status, 200); // bridge transport succeeded; upstream did not
    const failed = await failure.json();
    assert.equal(failed.error.data.httpStatus, 500);
    assert.equal(failed.error.data.kind, "http_error");
    assert.equal(failed.error.data.retryAllowed, false);
  } finally {
    await bridge.close();
  }
});

test("two simultaneous bridge owners isolate gateway, client, token and session; one retirement cannot reroute the other", async () => {
  const received = [];
  const make = async label => new ManagedMcpBridge({ gatewayUrl: `https://${label}.example/mcp`, apiKey: `${label}-key`, clientId: label, token: `${label}-token`,
    fetch: async (url, options) => {
      received.push({ label, url, key: options.headers.Authorization, client: options.headers["X-Statewright-Client-Id"], session: options.headers["mcp-session-id"] });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { owner: label } }), { headers: { "content-type": "application/json" } });
    } }).start();
  const a = await make("a"), b = await make("b");
  const invoke = (bridge, label, token = `${label}-token`, client = label) => fetch(`${bridge.url}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Statewright-Client-Id": client, "Mcp-Session-Id": `${label}-session` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }) });
  try {
    const results = await Promise.all([invoke(a, "a"), invoke(b, "b")]);
    assert.deepEqual(await Promise.all(results.map(r => r.json())), ["a", "b"].map(owner => ({ jsonrpc: "2.0", id: 1, result: { owner } })));
    assert.equal((await invoke(b, "b", "a-token")).status, 401);
    assert.equal((await invoke(b, "b", "b-token", "a")).status, 403);
    await a.close();
    assert.equal((await (await invoke(b, "b")).json()).result.owner, "b");
    assert.deepEqual(received.map(x => x.label).sort(), ["a", "b", "b"]);
    for (const x of received) assert.deepEqual(x, { label: x.label, url: `https://${x.label}.example/mcp`, key: `Bearer ${x.label}-key`, client: x.label, session: `${x.label}-session` });
  } finally { await a.close(); await b.close(); }
});

test("managed gateway authentication failure is typed, distinct from bridge authorization, and never replayed", async () => {
  let count = 0;
  const bridge = await new ManagedMcpBridge({ gatewayUrl: "https://a.example", apiKey: "fixture", clientId: "a", token: "token",
    fetch: async () => { count++; return new Response('Bearer private-fixture', { status: 401 }); } }).start();
  try {
    const response = await fetch(`${bridge.url}/mcp`, { method: "POST", headers: { Authorization: "Bearer token" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}' });
    const result = await response.json();
    assert.equal(result.error.data.kind, "authentication_required");
    assert.equal(result.error.data.recoveryTool, "statewright_connect");
    assert.doesNotMatch(JSON.stringify(result), /private-fixture/);
    assert.equal(count, 1);
  } finally { await bridge.close(); }
});

test("reconnected bridge rotates capability without reviving the retired owner's token", async () => {
  let count = 0;
  const options = { gatewayUrl: "https://a.example/mcp", apiKey: "fixture", clientId: "owner", fetch: async () => {
    count++;
    return new Response('{"jsonrpc":"2.0","id":1,"result":{}}');
  } };
  const old = await new ManagedMcpBridge(options).start();
  const oldToken = old.token;
  await old.close();
  const current = await new ManagedMcpBridge(options).start();
  try {
    assert.notEqual(current.token, oldToken);
    const invoke = token => fetch(`${current.url}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Statewright-Client-Id": "owner" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal((await invoke(oldToken)).status, 401);
    assert.equal((await invoke(current.token)).status, 200);
    assert.equal(count, 1);
  } finally { await current.close(); }
});


test("renewal replaces the upstream credential while the live bridge, client and native proof stay stable",async t=>{
  const calls=[];const proof="a".repeat(64);
  const bridge=await new ManagedMcpBridge({gatewayUrl:"https://gateway.example/mcp",apiKey:"expired-key",clientId:"owner",token:"native-token",originProof:proof,
    fetch:async (url,init)=>{calls.push({url,...init});return Response.json({jsonrpc:"2.0",id:1,result:{ok:true}})}}).start();
  t.after(()=>bridge.close());const url=bridge.url;
  const send=()=>fetch(`${url}/mcp`,{method:"POST",headers:{Authorization:"Bearer native-token"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})});
  await send();bridge.apiKey="renewed-key";await send();
  assert.equal(bridge.url,url);assert.equal(calls.length,2);
  assert.deepEqual(calls.map(c=>c.headers.Authorization),["Bearer expired-key","Bearer renewed-key"]);
  assert.ok(calls.every(c=>c.headers["X-Statewright-Client-Id"]==="owner"&&c.headers["x-statewright-approval-origin"]===proof));
});
