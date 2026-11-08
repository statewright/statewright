//! Offline experiment inputs. Public command strings are parsed, never executed.
use serde_json::{json, Value};
use statewright_mcp_gateway::{
    bash_classifier::OpClass, risk_assessment, semantic_contract, shell_ast_shadow,
};
use std::io::Write;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("expected public case manifest and NEW output prefix".into());
    }
    let corpus: Value = serde_json::from_slice(&std::fs::read(&args[0])?)?;
    let private_data = corpus["schema"] == "statewright/private-effect-set-cases/v1"
        && corpus["classification"] == "private_sanitized_local_only"
        && corpus["privacy"]["manual_sanitized_review"] == true
        && corpus["privacy"]["local_only"] == true;
    let public_data = corpus["schema"] == "statewright/public-effect-set-cases/v1"
        && corpus["classification"] == "public_command_data";
    if !private_data && !public_data {
        return Err("unsupported public input".into());
    }
    let axes = json!({
        "read":{"type":"noul","instructions":"Does any executed component READ existing resource content, metadata or observable state? Reading can coexist with writing or deletion. Literal printing/stream formatting alone is not resource reading."},
        "write":{"type":"noul","instructions":"Does any executed component CREATE or UPDATE resources, including normal file overwrites, edits, renames, permissions or remote updates? Ordinary content replacement is Write. Resource removal is assessed separately as Destroy."},
        "destroy":{"type":"noul","instructions":"Does any executed component REMOVE resources or explicitly DISCARD/RESET managed state, such as rm, find -delete, or remote DELETE? Ordinary edits, content replacement and renames are Write rather than automatically Destroy."},
        "unresolved":{"type":"noul","instructions":"Is there insufficient evidence to determine the complete resource effects, because program/script source or operation semantics are unavailable, syntax is malformed, or execution is dynamic? Known utility operations with fully supplied arguments are not unresolved just because they execute a program."}
    });
    let sets = json!({"effect_set":{"type":"choice","instructions":"Select the COMPLETE SET of resource effects of all executed components. Read observes existing resources; Write creates/updates resources, including normal content replacement and renames; Destroy removes resources or explicitly discards/resets managed state. Process/log bookkeeping and stdout are excluded. Quoted data is not code. Missing program source or malformed syntax is unresolved.","criteria":{
        "none":"Only literal output or stream formatting. No resource Read, Write, or Destroy.",
        "read":"Read existing resources only. No Write or Destroy.",
        "write":"Create/update resources only. No substantive Read or Destroy.",
        "read_write":"Both Read existing resources and create/update resources. No Destroy.",
        "destroy":"Remove resources only. No substantive Read or Write.",
        "read_destroy":"Both Read and remove resources. No Write.",
        "write_destroy":"Both create/update and remove resources. No substantive Read.",
        "read_write_destroy":"Read, create/update, AND remove resources.",
        "unresolved":"Effects cannot be established: missing program/script source, dynamic code, ambiguous semantics, or malformed syntax."
    }}});
    let mut cases = vec![];
    for row in corpus["cases"].as_array().ok_or("missing cases")? {
        let command = row["command"].as_str().ok_or("missing command")?;
        let assessment = risk_assessment::assess_native_policy_rejection(
            None,
            "exec_command",
            &json!({"cmd":command}),
            None,
        );
        let request = assessment
            .deterministic
            .evaluation_requests()
            .0
            .ok_or("missing request")?;
        let provider = assessment
            .deterministic
            .evaluation_provider_state(true)
            .ok_or("missing provider")?;
        let ast = shell_ast_shadow::assess(command);
        // Retain the naive legacy-class projection as diagnostic data only.
        // It is NOT an effect proof: e.g. Destructive includes find -exec reads
        // and FileWrite includes rsync --delete. The reviewed scorer ignores
        // mask/complete and uses only the existing full ReadOnly decision.
        let mut mask = 0u8;
        let mut unresolved = vec![];
        for class in &ast.classes {
            match class {
                OpClass::FileRead
                | OpClass::RemoteRead
                | OpClass::ContentSearch
                | OpClass::FileSearch
                | OpClass::GitRead => mask |= 1,
                OpClass::FileWrite | OpClass::LocalWrite | OpClass::GitLocalWrite => mask |= 2,
                OpClass::Destructive => mask |= 4,
                OpClass::SafeOutput => {}
                other => unresolved.push(format!("{other:?}")),
            }
        }
        let parsed = ast.status == shell_ast_shadow::ParseStatus::Parsed;
        let heuristic = json!({"mask":mask,"complete":parsed&&unresolved.is_empty(),"syntax_valid":parsed,
            "unresolved":unresolved,"classes":format!("{:?}",ast.classes),"current_effect":format!("{:?}",assessment.resolve_effect())});
        // The same rich evidence is supplied to all three contract experiments.
        // Labels, expected masks and heuristic mask are never sent to the model.
        let mut rich = json!({"tool":"exec_command","invocation":command,
            "environment":corpus["context"]["environment"],"scope":corpus["context"]["scope"],
            "execution_structure":request.execution_structure,
            "delegated_source":row["delegated_source"]});
        if private_data {
            rich["privacy_context"] = corpus["context"]["use"].clone();
            rich["redactions"] = row["redactions"].clone();
            rich["evidence_loss"] = row["evidence_loss"].clone();
        }
        for (arm, state, profile) in [
            ("current_provider_six", provider, "six"),
            ("literal_six", rich.clone(), "six"),
            ("literal_effect_axes", rich.clone(), "axes"),
            ("literal_effect_sets", rich, "sets"),
        ] {
            cases.push(
                json!({"id":row["id"],"arm":arm,"task":profile,"question_profile":profile,
                "state":state,"expected":{"mask":row["mask"]},"heuristic":heuristic,
                "case_kind":row["kind"],"source":row["source"]}),
            );
        }
    }
    for (index, chunk) in cases.chunks(128).enumerate() {
        let output = format!("{}-{}.json", args[1], index + 1);
        let document = json!({"schema":if private_data{"statewright/private-effect-set-evaluation/v1"}else{"statewright/public-effect-set-evaluation/v1"},"classification":corpus["classification"],
            "label_status":corpus["label_status"],"source_contract":semantic_contract::VERSION,
            "source_cases":corpus,"questions":{},"question_profiles":{"six":semantic_contract::typed_questions(),"axes":axes,"sets":sets},"cases":chunk});
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)?;
        serde_json::to_writer_pretty(&mut file, &document)?;
        writeln!(file)?;
        println!(
            "prepared batch {}: {} requests; no model or fixture executed",
            index + 1,
            chunk.len()
        );
    }
    Ok(())
}
