//! Offline integration boundary: consume real collector receipts, never execute
//! the fixture's command strings or dispatch a semantic provider.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use statewright_mcp_gateway::risk_assessment::{
    apply_native_command_evidence, assess_native_policy_rejection,
};
use std::io::{Read, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err("fixture input limit".into());
    }
    let document: Value = serde_json::from_slice(&bytes)?;
    if document["schema"] != "statewright/native-body-contract-input/v1"
        || document["classification"] != "public_synthetic"
    {
        return Err("public native-body fixture required".into());
    }
    let cases = document["cases"].as_array().ok_or("cases missing")?;
    if cases.is_empty() || cases.len() > 16 {
        return Err("fixture count limit".into());
    }
    let mut rows = Vec::new();
    for case in cases {
        let input = &case["input"];
        let assessment = apply_native_command_evidence(
            assess_native_policy_rejection(None, "exec_command", input, None),
            None,
            "exec_command",
            input,
            Some(&case["evidence"]),
        );
        rows.push(
            json!({"id":case["id"],"resolved_effect":format!("{:?}",assessment.resolve_effect()),
            "resource_bounds":assessment.complete_resource_bounds(),
            "required_capability":assessment.deterministic.evaluation_required_capability(),
            "basis":assessment.resolve_effect_with_basis().1}),
        );
    }
    let sources = [
        (
            "risk_assessment.rs",
            include_str!("../src/risk_assessment.rs"),
        ),
        (
            "effect_evidence.rs",
            include_str!("../src/effect_evidence.rs"),
        ),
        (
            "resource_effects.rs",
            include_str!("../src/resource_effects.rs"),
        ),
        (
            "utility_effects.rs",
            include_str!("../src/utility_effects.rs"),
        ),
        (
            "invocation_evidence.rs",
            include_str!("../src/invocation_evidence.rs"),
        ),
        (
            "bash_classifier.rs",
            include_str!("../src/bash_classifier.rs"),
        ),
        (
            "shell_ast_shadow.rs",
            include_str!("../src/shell_ast_shadow.rs"),
        ),
        (
            "shell_redirect.rs",
            include_str!("../src/shell_redirect.rs"),
        ),
        (
            "command_structure.rs",
            include_str!("../src/command_structure.rs"),
        ),
        ("cli_options.rs", include_str!("../src/cli_options.rs")),
        (
            "native_body_contract.rs",
            include_str!("native_body_contract.rs"),
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
    let output = json!({"schema":"statewright/native-body-contract-result/v1","enforcement":"none",
        "input_sha256":format!("{:x}",Sha256::digest(&bytes)),"compiled_source_sha256":sources,
        "fixture_commands_executed":0,"model_calls":0,"rows":rows});
    serde_json::to_writer(std::io::stdout(), &output)?;
    std::io::stdout().write_all(b"\n")?;
    Ok(())
}
