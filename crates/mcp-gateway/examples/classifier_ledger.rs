//! Offline characterization only. Reads command strings as data; never executes
//! them, calls a model, activates a workflow, or grants execution authority.
use statewright_mcp_gateway::{bash_classifier, shell_ast_shadow};
use std::io::{self, BufRead};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).ok_or("expected ledger path")?;
    let input = std::fs::File::open(path)?;
    if input.metadata()?.len() > 1024 * 1024 {
        return Err("ledger exceeds 1 MiB".into());
    }
    for (index, line) in io::BufReader::new(input).lines().enumerate() {
        let command = line?;
        if command.is_empty() {
            continue;
        }
        if command.len() > 8192 {
            return Err("command exceeds 8192 bytes".into());
        }
        let ast = shell_ast_shadow::assess(&command);
        println!(
            "{}",
            serde_json::json!({
                "schema": "statewright/static-classifier-audit/v1",
                "ledger_line": index + 1,
                "command_fingerprint": uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, command.as_bytes()).to_string(),
                "legacy_classes": format!("{:?}", bash_classifier::classify(&command)),
                "ast_classes": format!("{:?}", ast.classes),
                "ast_status": ast.status,
                "readonly_capabilities": bash_classifier::readonly_capabilities(&command),
                "execution": "not_executed", "authorization": "not_evaluated"
            })
        );
    }
    Ok(())
}
