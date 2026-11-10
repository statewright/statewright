import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, mkdir, readFile, writeFile, rm, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {recordCodexHookHost, normalizeCodexHookInput} from "../lib/codex-hook-context.mjs";
import {collectCommandEvidence} from "../lib/command-evidence.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "statewright-hook-context-"));
  t.after(() => rm(root, {recursive:true,force:true}));
  const control = join(root,"routes"); await mkdir(control);
  const cwd = join(root,"actual-tool-directory"); await mkdir(cwd);
  await writeFile(join(cwd,"package.json"),JSON.stringify({name:"context-fixture",private:true,
    scripts:{canary:"mkdir -p evidence && printf 'OK\\n'"}}));
  const path = join(root,"manifest.json");
  const receipt = {pid:process.pid,clientId:"swc_fixture",proxyUrl:"ws://127.0.0.1:1234",proxyToken:"private-test-key"};
  await writeFile(path,JSON.stringify(receipt));
  await writeFile(join(control,"codex-root-session.json"),JSON.stringify({version:1,client_id:receipt.clientId,session_id:"thread-one"}));
  const environment = {STATEWRIGHT_CLASSIFIER_APPROVAL_RECEIPT:path,
    STATEWRIGHT_ROUTE_CONTROL_DIR:control,STATEWRIGHT_CLIENT_ID:receipt.clientId};
  const hook={hook_event_name:"PreToolUse",session_id:"thread-one",tool_name:"Bash",
    cwd,tool_input:{command:"npm run canary"}};
  const record = userAgent => recordCodexHookHost({receiptPath:path,clientId:receipt.clientId,proxyToken:receipt.proxyToken,userAgent});
  return {root,cwd,path,control,receipt,environment,hook,record};
}

test("native effective tool cwd produces fresh complete npm source evidence", async t => {
  const f = await fixture(t);
  assert(await f.record("codex_cli_rs/0.167.0 (test platform)"));
  assert(!String(await readFile(f.path+".host.json")).includes(f.receipt.proxyToken));
  const normalized=await normalizeCodexHookInput(f.hook,{environment:f.environment});
  assert.equal(normalized.tool_input.cwd,f.cwd);
  assert.equal(normalized.tool_input.command,f.hook.tool_input.command);
  const proof=await collectCommandEvidence(normalized.tool_name,normalized.tool_input);
  assert.equal(proof.complete,true,JSON.stringify(proof));
  assert.equal(proof.cwd,await realpath(f.cwd));
  assert(proof.files.some(file=>file.path==="package.json"));
});

test("old or absent host context never substitutes ambient cwd", async t => {
  const f=await fixture(t);
  assert.equal(await f.record("codex_cli_rs/0.160.0"),false);
  assert.deepEqual(await normalizeCodexHookInput(f.hook,{environment:f.environment}),f.hook);
  assert.equal(await f.record("not a Codex version"),false);
});

test("foreign thread/client, changed runtime token and explicit remote environment do not inherit cwd", async t => {
  const f=await fixture(t);await f.record("codex_cli_rs/0.167.0");
  for(const hook of [{...f.hook,session_id:"foreign"},{...f.hook,environment_id:"remote-one"},
    {...f.hook,tool_input:{...f.hook.tool_input,environment_id:"remote-one"}}]) {
    assert.deepEqual(await normalizeCodexHookInput(hook,{environment:f.environment}),hook);
  }
  assert.deepEqual(await normalizeCodexHookInput(f.hook,{environment:{...f.environment,STATEWRIGHT_CLIENT_ID:"foreign"}}),f.hook);
  await writeFile(f.path,JSON.stringify({...f.receipt,proxyToken:"rotated"}));
  assert.deepEqual(await normalizeCodexHookInput(f.hook,{environment:f.environment}),f.hook);
});

test("explicit per-tool cwd is preserved and publishing cannot attest another process", async t => {
  const f=await fixture(t);await f.record("codex_cli_rs/0.167.0");
  const hook={...f.hook,tool_input:{...f.hook.tool_input,workdir:f.root}};
  assert.deepEqual(await normalizeCodexHookInput(hook,{environment:f.environment}),hook);
  await writeFile(f.path,JSON.stringify({...f.receipt,pid:process.pid+1}));
  assert.equal(await f.record("codex_cli_rs/0.167.0"),false);
});
