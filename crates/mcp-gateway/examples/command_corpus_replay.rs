//! Static analysis only: neither commands nor network targets are executed.
#[allow(dead_code)]
#[path = "../tests/fixtures/classifier-pre-deny-first.rs"]
mod historical;
use serde_json::{Value, json};
use statewright_mcp_gateway::{
    risk_assessment::{self, ResolvedEffect},
    shell_ast_shadow,
};
use std::io::{BufRead, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 {
        return Err("expected input JSONL and NEW output JSONL".into());
    }
    let input = std::fs::File::open(&args[0])?;
    let mut output = std::io::BufWriter::new(
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&args[1])?,
    );
    let tools = vec![
        "Bash".to_owned(),
        "Read".to_owned(),
        "Grep".to_owned(),
        "Glob".to_owned(),
    ];
    let mut count = 0;
    for line in std::io::BufReader::new(input).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if line.len() > 1024 * 1024 {
            return Err("oversized corpus row".into());
        }
        let row: Value = serde_json::from_str(&line)?;
        let command = row["command"].as_str().ok_or("missing command")?;
        if command.len() > 256 * 1024 {
            return Err("oversized command".into());
        }
        let started = std::time::Instant::now();
        let old = std::panic::catch_unwind(|| {
            (
                historical::classify(command),
                historical::check_against_allowed(command, &tools).is_ok(),
            )
        });
        let current = risk_assessment::assess_native_policy_rejection(
            None,
            "Bash",
            &json!({"command":command}),
            None,
        );
        let ast = shell_ast_shadow::assess(command);
        let disposition = match current.resolve_effect() {
            ResolvedEffect::ReadOnly => "allow",
            ResolvedEffect::DenyUncertain => "review",
            _ => "deny",
        };
        let (old_classes, old_disposition) = match old {
            Ok((classes, true)) => (format!("{classes:?}"), "allow"),
            Ok((classes, false)) => (format!("{classes:?}"), "deny"),
            Err(_) => ("panic".to_owned(), "error"),
        };
        writeln!(
            output,
            "{}",
            json!({"id":row["id"],"source":row["source"],"placeholders":row["placeholders"],
            "historical_classes":old_classes,"historical_disposition":old_disposition,
            "current_disposition":disposition,"current":current.visible_json(),
            "ast_status":format!("{:?}",ast.status),"ast_classes":format!("{:?}",ast.classes),
            "elapsed_us":started.elapsed().as_micros(),"policy":"fixed_read_only_capabilities",
            "scope":"classifier_effect_projection_not_full_gateway_or_native_approval","execution":"none"})
        )?;
        count += 1;
    }
    output.flush()?;
    println!("statically analyzed {count} rows; no fixture executed");
    Ok(())
}
