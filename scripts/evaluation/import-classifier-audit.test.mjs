import test from "node:test";
import assert from "node:assert/strict";
import {auditCandidate,importAudit} from "./import-classifier-audit.mjs";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
const file="audit-12345678-1234-1234-1234-123456789abc.json";
const record=()=>({schema_version:1,record_type:"classifier_audit_simulation_intake",label:null,status:"unlabelled_pending_review",replay_ready:false,
  receipt:{environment:"staging",simulation_label:"unlabelled_pending_review",event:"classifier_would_block_uncertain",native_permissions:"deferred_to_host",
    evidence:Object.fromEntries(["workflow","policy","invocation","classifier_decision","independent_guards","native_context"].map(k=>[k,"a".repeat(64)]))},
  case:{tool_name:"exec_command",command_shape:[{executable:"git",effect:"unknown",delegates_unknown_effect:false}]}});
test("audit capture cannot manufacture a labelled or replay-complete simulation case",()=>{
  const candidate=auditCandidate(Buffer.from(JSON.stringify(record())),file);
  assert.equal(candidate.label,null);assert.equal(candidate.replay_ready,false);assert(candidate.evidence_loss.includes("full_command_unavailable"));
  assert.match(candidate.source.sha256,/^[a-f0-9]{64}$/);assert.match(candidate.id,/^[a-f0-9]{64}$/);
});
test("repeated evidence groups observations while retaining each immutable artifact hash",async t=>{
  const root=await mkdtemp(join(tmpdir(),"statewright-audit-import-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const first=record(),second={...record(),id:"a-different-event"};
  await writeFile(join(root,file),JSON.stringify(first));
  await writeFile(join(root,"audit-12345678-1234-1234-1234-123456789abd.json"),JSON.stringify(second));
  const imported=await importAudit(root);assert.equal(imported.cases.length,1);assert.equal(imported.cases[0].observation_count,2);
  assert.equal(new Set(imported.cases[0].observations.map(o=>o.sha256)).size,2);assert.equal(imported.eligible_for_accuracy_metrics,false);
});
test("production, forged labels/provenance and raw data are rejected",()=>{
  for(const mutate of [r=>{r.receipt.environment="production";},r=>{r.label=1;},r=>{r.replay_ready=true;},
    r=>{r.receipt.evidence.invocation="secret";},r=>{r.case.command="secret";},
    r=>{r.case.command_shape[0].argv=["secret"];},r=>{r.case.command_shape[0].executable="secret";}]){
    const value=record();mutate(value);assert.throws(()=>auditCandidate(Buffer.from(JSON.stringify(value)),file));
  }
});
