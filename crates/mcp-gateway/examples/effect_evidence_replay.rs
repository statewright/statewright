//! Offline source replay: no command/model execution and no runtime flag changes.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use statewright_mcp_gateway::{
    effect_evidence,
    risk_assessment::{self, ResolvedEffect},
};
use std::io::Write;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 {
        return Err("expected frozen cases and NEW output".into());
    }
    let bytes = std::fs::read(&args[0])?;
    let source_sha256 = format!("{:x}", Sha256::digest(&bytes));
    let source_files = [
        (
            "risk_assessment.rs",
            include_str!("../src/risk_assessment.rs"),
        ),
        (
            "bash_classifier.rs",
            include_str!("../src/bash_classifier.rs"),
        ),
        (
            "effect_evidence.rs",
            include_str!("../src/effect_evidence.rs"),
        ),
        ("cli_options.rs", include_str!("../src/cli_options.rs")),
        (
            "resource_effects.rs",
            include_str!("../src/resource_effects.rs"),
        ),
        (
            "invocation_evidence.rs",
            include_str!("../src/invocation_evidence.rs"),
        ),
        (
            "command_structure.rs",
            include_str!("../src/command_structure.rs"),
        ),
        (
            "semantic_contract.rs",
            include_str!("../src/semantic_contract.rs"),
        ),
        (
            "shell_redirect.rs",
            include_str!("../src/shell_redirect.rs"),
        ),
        (
            "shell_ast_shadow.rs",
            include_str!("../src/shell_ast_shadow.rs"),
        ),
        ("Cargo.lock", include_str!("../../../Cargo.lock")),
    ]
    .into_iter()
    .map(|(name, text)| {
        (
            name.to_owned(),
            json!(format!("{:x}", Sha256::digest(text.as_bytes()))),
        )
    })
    .collect::<serde_json::Map<_, _>>();
    let flags = [
        "STATEWRIGHT_SHELL_AST_SHADOW",
        "STATEWRIGHT_SHELL_AST_AUTHORITY",
    ]
    .into_iter()
    .map(|name| {
        let enabled = risk_assessment::shadow_enabled_for(std::env::var(name).ok().as_deref());
        (name.to_owned(), json!(enabled))
    })
    .collect::<serde_json::Map<_, _>>();
    let corpus: Value = serde_json::from_slice(&bytes)?;
    let private = corpus["classification"] == "private_sanitized_local_only";
    if !(private
        && corpus["privacy"]["manual_sanitized_review"] == true
        && corpus["privacy"]["local_only"] == true)
        && corpus["classification"] != "public_command_data"
    {
        return Err("unsupported case privacy contract".into());
    }
    let mut rows = Vec::new();
    let mut permitted = 0;
    let mut held = 0;
    let mut forbidden = 0;
    let mut escaped = 0;
    let mut unknown = 0;
    let mut unknown_allowed = 0;
    for case in corpus["cases"].as_array().ok_or("missing cases")? {
        let command = case["command"].as_str().ok_or("missing command")?;
        let assessment = risk_assessment::assess_native_policy_rejection(
            None,
            "exec_command",
            &json!({"cmd":command}),
            None,
        );
        let resolved = assessment.resolve_effect();
        // Current gateway capability outcomes, NOT an exact R/W/D class cast.
        // Do not grant execution/Git-specific capabilities from Read+Write.
        let allowed = matches!(
            resolved,
            ResolvedEffect::ReadOnly | ResolvedEffect::LocalWrite
        );
        let proof = effect_evidence::assess(command);
        match case["mask"].as_u64() {
            None => {
                unknown += 1;
                if allowed {
                    unknown_allowed += 1;
                }
            }
            Some(mask) if mask & 4 == 0 => {
                permitted += 1;
                if !allowed {
                    held += 1;
                }
            }
            Some(_) => {
                forbidden += 1;
                if allowed {
                    escaped += 1;
                }
            }
        }
        rows.push(json!({"id":case["id"],"expected":case["mask"],"resolved_effect":format!("{resolved:?}"),
            "basis":assessment.resolve_effect_with_basis().1,"required_capability":assessment.deterministic.evaluation_required_capability(),
            "read_write_capability_outcome":allowed,"effect_evidence":proof}));
    }
    let summary = json!({"cases":rows.len(),"permitted":permitted,"held_permitted":held,
        "held_permitted_percent":if permitted>0{Some(100.0*held as f64/permitted as f64)}else{None},
        "forbidden":forbidden,"allowed_forbidden":escaped,"unknown":unknown,"allowed_unknown":unknown_allowed});
    let result = json!({"schema":"statewright/effect-evidence-replay/v1","classification":corpus["classification"],
        "privacy":corpus["privacy"],"enforcement":"none","label_status":corpus["label_status"],"source_cases_file":args[0],"source_cases_sha256":source_sha256,
        "compiled_source_sha256":source_files,"observed_ast_flags":flags,
        "interpretation":"Current deterministic source capability projection for Read+Write. No installed/native execution, no native collected file/config evidence, no full gateway scope/identity/approval replay. Effect envelopes are separate evidence, not capability authority.",
        "summary":summary,"rows":rows});
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&args[1])?;
    serde_json::to_writer_pretty(&mut file, &result)?;
    writeln!(file)?;
    println!("{summary}");
    Ok(())
}
