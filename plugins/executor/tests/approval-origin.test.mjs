import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, rm, readdir, readFile, writeFile, chmod, symlink, unlink, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {approvalOriginProof, validApprovalOriginProof} from "../lib/approval-origin.mjs";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "approval-origin-"));
  t.after(() => rm(home, {recursive:true,force:true}));
  const options = {home, clientId:"owner-client", gatewayUrl:"https://staging.example/mcp"};
  return {home, options, directory:join(home,".statewright","approval-origins")};
}

test("unsupported Windows ACL storage supplies no originating exemption", {skip:process.platform !== "win32"}, async t => {
  const f = await fixture(t);
  assert.equal(await approvalOriginProof(f.options), undefined);
  await assert.rejects(readdir(f.directory), {code:"ENOENT"});
});

test("private origin survives reconnect and isolates client and gateway", {skip:process.platform === "win32"}, async t => {
  const f = await fixture(t);
  const first = await approvalOriginProof(f.options);
  assert(validApprovalOriginProof(first));
  assert.equal(await approvalOriginProof(f.options), first);
  assert.notEqual(await approvalOriginProof({...f.options,clientId:"different"}), first);
  assert.notEqual(await approvalOriginProof({...f.options,gatewayUrl:"https://production.example/mcp"}), first);
  for (const name of await readdir(f.directory)) {
    assert.match(name,/^[a-f0-9]{64}\.json$/);
    if (process.platform !== "win32") assert.equal((await stat(join(f.directory,name))).mode & 0o077,0);
  }
});

test("malformed or foreign stored origin stays preserved and cannot become a new proof", {skip:process.platform === "win32"}, async t => {
  const f = await fixture(t); await approvalOriginProof(f.options);
  const file = join(f.directory,(await readdir(f.directory))[0]);
  const original = JSON.parse(await readFile(file,"utf8"));
  for (const value of ["not json", JSON.stringify({...original,client_id:"foreign"}),
    JSON.stringify({...original,proof:"label"}), JSON.stringify({...original,extra:true})]) {
    await writeFile(file,value);
    await assert.rejects(approvalOriginProof(f.options),/provenance is unavailable/);
    assert.equal(await readFile(file,"utf8"),value);
  }
});

test("symlink and insecure origin storage never supply an approval capability", {skip:process.platform === "win32"}, async t => {
  const f = await fixture(t); await approvalOriginProof(f.options);
  const file = join(f.directory,(await readdir(f.directory))[0]);
  await chmod(file,0o644);
  await assert.rejects(approvalOriginProof(f.options),/provenance is unavailable/);
  await chmod(file,0o600);
  const bytes = await readFile(file); const target = join(f.home,"target.json");
  await writeFile(target,bytes,{mode:0o600}); await unlink(file); await symlink(target,file);
  await assert.rejects(approvalOriginProof(f.options),/provenance is unavailable/);
  assert.deepEqual(await readFile(target),bytes);
});
