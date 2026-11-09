import {readFile, readdir, lstat, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";

const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const lanes=new Set(["staging","dev","dev1","dev2","dev3"]);
export function auditCandidate(bytes,fileName) {
  if(bytes.length>32768||!/^audit-[a-f0-9-]{36}\.json$/.test(fileName))throw new Error("invalid audit artifact");
  const record=JSON.parse(bytes);
  if(record.schema_version!==1||record.record_type!=="classifier_audit_simulation_intake"
      ||record.label!==null||record.status!=="unlabelled_pending_review"||record.replay_ready!==false
      ||!lanes.has(record.receipt?.environment)||record.receipt?.simulation_label!=="unlabelled_pending_review"
      ||record.receipt?.native_permissions!=="deferred_to_host"
      ||record.receipt?.event!=="classifier_would_block_uncertain")throw new Error("invalid audit intake contract");
  const evidence=record.receipt.evidence;
  const names=["workflow","policy","invocation","classifier_decision","independent_guards","native_context"];
  if(!evidence||Object.keys(evidence).length!==names.length||names.some(k=>!/^[a-f0-9]{64}$/.test(evidence[k]??"")))throw new Error("invalid audit provenance");
  if(!record.case||Object.keys(record.case).sort().join(",")!=="command_shape,tool_name"
      ||!new Set(["Bash","bash","shell","exec_command","functions.exec_command","mcp","other"]).has(record.case.tool_name)
      ||!Array.isArray(record.case.command_shape)||record.case.command_shape.length>32)throw new Error("invalid structural case");
  const programs=new Set("git cargo npm node python sed awk rg grep find cat head tail sort uniq cut tr wc curl wget ssh shell other".split(" "));
  const effects=new Set("unknown external_unknown destructive restricted_external other_known_effect read write execute output".split(" "));
  for(const part of record.case.command_shape){
    if(!part||Object.keys(part).sort().join(",")!=="delegates_unknown_effect,effect,executable"
        ||!programs.has(part.executable)||!effects.has(part.effect)||typeof part.delegates_unknown_effect!=="boolean")throw new Error("invalid structural case");
  }
  return {id:hash(JSON.stringify([evidence.workflow,evidence.policy,evidence.invocation,evidence.classifier_decision,record.case])),
    source:{file:fileName,sha256:hash(bytes)},environment:record.receipt.environment,
    label:null,label_status:"unlabelled_pending_review",replay_ready:false,
    evidence_loss:["argument_values_omitted","operation_values_omitted","full_command_unavailable"],
    evidence,structural_case:record.case};
}
export async function importAudit(directory) {
  const entries=(await readdir(directory)).filter(name=>name.endsWith(".json")).sort();
  if(entries.length>10000)throw new Error("audit intake count limit");
  const groups=new Map();
  for(const name of entries){const path=join(directory,name),stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768)throw new Error("invalid audit artifact");
    const candidate=auditCandidate(await readFile(path),name),existing=groups.get(candidate.id);
    const observation={...candidate.source,native_context:candidate.evidence.native_context};
    if(existing){existing.observations.push(observation);existing.observation_count++;}
    else groups.set(candidate.id,{...candidate,observation_count:1,observations:[observation]});
  }
  const cases=[...groups.values()];
  return {schema:"statewright/classifier-audit-candidates/v1",classification:"sanitized_structural_metadata",
    enforcement:"none",label_status:"unlabelled_pending_review",eligible_for_accuracy_metrics:false,
    interpretation:"Structural simulation intake. Requires source review and labels before executable-command replay; capture is not evidence of safe behavior.",cases};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==4)throw new Error("expected audit intake directory and NEW candidate output");
  const result=await importAudit(process.argv[2]);
  await writeFile(process.argv[3],JSON.stringify(result,null,2)+"\n",{flag:"wx",mode:0o600});
  process.stdout.write(JSON.stringify({cases:result.cases.length,labelled:0,replay_ready:0})+"\n");
}
