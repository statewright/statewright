use crate::tools;
use serde::Deserialize;
use serde_json::json;
use statewright_agent::ollama_client::{OllamaClient, OllamaConfig};
use statewright_agent::prompt_templates::ChatMessage;
use statewright_agent::tool_enforcer;

#[derive(Deserialize, Debug)]
struct LlmResponse {
    #[serde(default)]
    transition: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCall>>,
    #[serde(default)]
    #[allow(dead_code)]
    error: Option<String>,
}

#[derive(Deserialize, Debug)]
struct ToolCall {
    name: String,
    #[serde(default, alias = "arguments")]
    args: serde_json::Value,
}

/// Run a TDD greenfield software creation session.
pub async fn run_tdd(task: &str, workdir: &str, client: &OllamaClient, max_cycles: u32) -> bool {
    println!("\n=== Statewright TDD: Greenfield Software Creation ===\n");
    println!("Task: {}", task);
    println!("Working dir: {}", workdir);
    println!();

    // Read requirements
    let requirements =
        tools::execute_tool("read_file", &json!({"path": "requirements.md"}), workdir);
    println!("[Requirements]\n{}\n", requirements);

    // Phase 1: Design — create stubs
    println!("--- Phase 1: Design ---");
    let stubs_created = run_creative_state(
        client, workdir,
        "designing",
        "Read requirements.md. Then use write_file to create kvstore.py with a KVStore class. Each method should just contain `pass`. You MUST call write_file to create the file.",
        &["read_file", "write_file", "list_directory"],
        5,
        &mut Vec::new(),
    ).await;

    if !stubs_created {
        println!("[FAILED] Could not create stubs");
        return false;
    }

    // Verify stubs exist
    let stub_check = tools::execute_tool("read_file", &json!({"path": "kvstore.py"}), workdir);
    if stub_check.starts_with("error") {
        println!("[FAILED] kvstore.py not created");
        return false;
    }
    println!("[Stubs created] kvstore.py exists\n");

    // Phase 2: TDD Cycles
    let req_lines: Vec<&str> = requirements
        .lines()
        .filter(|l| l.starts_with(|c: char| c.is_ascii_digit()))
        .collect();

    let total_requirements = req_lines.len().min(max_cycles as usize);
    println!(
        "--- Phase 2: TDD Cycles ({} requirements) ---\n",
        total_requirements
    );

    let mut conversation: Vec<ChatMessage> = Vec::new();
    let mut cycle = 0u32;
    let mut all_pass_count = 0u32;

    for (i, req) in req_lines.iter().enumerate().take(total_requirements) {
        cycle += 1;
        println!(
            "╔══ Cycle {}/{}: {} ══╗",
            cycle,
            total_requirements,
            req.trim()
        );

        // RED: Write a failing test
        println!("│ [RED] Writing test...");
        let test_written = run_creative_state(
            client, workdir,
            "writing_test",
            &format!(
                "Write ONE pytest test in test_kvstore.py for this requirement:\n{}\n\n\
                Import KVStore from kvstore. The test should call the method and assert the expected behavior.\n\
                If the file exists, APPEND the test — do NOT overwrite existing tests.\n\
                Use edit_line or read the file first, then write the complete file with the new test added.",
                req
            ),
            &["read_file", "write_file", "edit_line", "grep"],
            3,
            &mut conversation,
        ).await;

        if !test_written {
            println!("│ [RED] Failed to write test");
            println!("╚══ Cycle {} FAILED ══╝\n", cycle);
            continue;
        }

        // Verify RED: test must fail
        let red_result = tools::execute_tool("run_test", &json!({}), workdir);
        let red_failed = red_result.contains("failed")
            || red_result.contains("ERROR")
            || red_result.contains("error");

        if !red_failed {
            println!("│ [RED] Test didn't fail — test doesn't test new behavior");
            // Don't skip — the implementation might still be needed
        } else {
            let fail_count = red_result
                .lines()
                .find(|l| l.contains("failed"))
                .unwrap_or("? failed");
            println!("│ [RED] ✓ Test fails as expected ({})", fail_count.trim());
        }

        // Feed test failure into conversation for GREEN phase
        conversation.push(ChatMessage {
            role: "user".into(),
            content: format!("Test results (RED phase):\n{}\n\nNow implement the MINIMAL code to make all tests pass.", red_result),
        });

        // GREEN: Implement to pass
        println!("│ [GREEN] Implementing...");
        let implemented = run_creative_state(
            client,
            workdir,
            "implementing",
            &format!(
                "Make all tests pass. Implement the method for:\n{}\n\n\
                Edit kvstore.py to replace the stub with a working implementation.\n\
                Use edit_line to change specific lines. Make the MINIMAL change needed.",
                req
            ),
            &["read_file", "write_file", "edit_line", "patch_file", "grep"],
            5,
            &mut conversation,
        )
        .await;

        if !implemented {
            println!("│ [GREEN] Failed to implement");
            println!("╚══ Cycle {} FAILED ══╝\n", cycle);
            continue;
        }

        // Verify GREEN: all tests must pass
        let green_result = tools::execute_tool("run_test", &json!({}), workdir);
        let all_pass = green_result.contains("passed")
            && !green_result.contains("failed")
            && !green_result.contains("ERROR");

        if all_pass {
            all_pass_count += 1;
            let pass_count = green_result
                .lines()
                .find(|l| l.contains("passed"))
                .unwrap_or("? passed");
            println!("│ [GREEN] ✓ All tests pass ({})", pass_count.trim());
        } else {
            println!("│ [GREEN] ✗ Tests still failing");
            // Feed failure back for next cycle
            conversation.push(ChatMessage {
                role: "user".into(),
                content: format!("Tests still failing:\n{}", green_result),
            });
        }

        println!(
            "╚══ Cycle {} {} ══╝\n",
            cycle,
            if all_pass { "COMPLETE" } else { "PARTIAL" }
        );
    }

    // Final verification
    println!("--- Final Verification ---");
    let final_result = tools::execute_tool("run_test", &json!({}), workdir);
    let final_pass = final_result.contains("passed")
        && !final_result.contains("failed")
        && !final_result.contains("ERROR");

    if final_pass {
        let pass_count = final_result
            .lines()
            .find(|l| l.contains("passed"))
            .unwrap_or("? passed");
        println!(
            "[SUCCESS] {} — {}/{} cycles completed",
            pass_count.trim(),
            all_pass_count,
            cycle
        );
    } else {
        let summary: Vec<&str> = final_result
            .lines()
            .filter(|l| {
                l.contains("PASSED")
                    || l.contains("FAILED")
                    || l.contains("passed")
                    || l.contains("failed")
            })
            .take(15)
            .collect();
        println!("[RESULT]\n{}", summary.join("\n"));
    }

    // Show what was built
    println!("\n--- Generated Code ---");
    let kvstore = tools::execute_tool("read_file", &json!({"path": "kvstore.py"}), workdir);
    let test_file = tools::execute_tool("read_file", &json!({"path": "test_kvstore.py"}), workdir);
    let kv_lines = kvstore.lines().count();
    let test_lines = test_file.lines().count();
    println!("kvstore.py: {} lines", kv_lines);
    println!("test_kvstore.py: {} lines", test_lines);
    println!();

    final_pass
}

/// Run a creative state: call the LLM with tools until it transitions or max_iterations hit.
async fn run_creative_state(
    client: &OllamaClient,
    workdir: &str,
    state_name: &str,
    instructions: &str,
    allowed_tools: &[&str],
    max_iterations: u32,
    conversation: &mut Vec<ChatMessage>,
) -> bool {
    let tools_list = allowed_tools.join(", ");
    let allowed: Vec<String> = allowed_tools.iter().map(|s| s.to_string()).collect();

    for iter in 1..=max_iterations {
        let system = format!(
            r#"You build software step by step. Respond with ONLY a JSON object.

STATE: {state_name}
INSTRUCTIONS: {instructions}

To call a tool:
{{"tool_calls": [{{"name": "TOOL_NAME", "args": {{...}}}}]}}

Available tools: {tools_list}
- read_file: args: {{"path": "filename"}}
- write_file: args: {{"path": "filename", "content": "full content"}}
- edit_line: args: {{"path": "filename", "old": "line to find", "new": "replacement"}}
- patch_file: args: {{"path": "filename", "patches": [{{"old": "old", "new": "new"}}]}}
- list_directory: args: {{"path": "."}}
- grep: args: {{"pattern": "text", "file": "filename"}}

When done with this state:
{{"transition": "DONE"}}"#,
            state_name = state_name,
            instructions = instructions,
            tools_list = tools_list,
        );

        let mut messages = vec![ChatMessage {
            role: "system".into(),
            content: system,
        }];
        let hist_start = conversation.len().saturating_sub(8);
        messages.extend(conversation[hist_start..].iter().cloned());
        messages.push(ChatMessage {
            role: "user".into(),
            content: "Next action?".into(),
        });

        let raw = match client.chat(messages).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("│ [LLM ERROR] {}", e);
                return false;
            }
        };

        let response: LlmResponse = match parse_response(&raw) {
            Some(r) => r,
            None => {
                conversation.push(ChatMessage {
                    role: "assistant".into(),
                    content: raw,
                });
                conversation.push(ChatMessage {
                    role: "user".into(),
                    content: "Respond with ONLY a JSON object.".into(),
                });
                continue;
            }
        };

        conversation.push(ChatMessage {
            role: "assistant".into(),
            content: raw,
        });

        // Handle tool calls
        if let Some(calls) = &response.tool_calls {
            let mut tool_output = String::new();
            for call in calls {
                let name = &call.name;

                if name == "transition" {
                    return true;
                }

                // Enforce tools
                if !allowed.contains(&name.to_string()) {
                    tool_output.push_str(&format!(
                        "BLOCKED: '{}' not available. Use: {}\n",
                        name, tools_list
                    ));
                    continue;
                }

                let result = tools::execute_tool(name, &call.args, workdir);
                print!("│   [{}] ", name);
                let truncated: String = result.chars().take(100).collect();
                println!("{}", truncated.replace('\n', " "));

                tool_output.push_str(&format!("=== {} ===\n{}\n", name, result));
            }

            if !tool_output.is_empty() {
                conversation.push(ChatMessage {
                    role: "user".into(),
                    content: format!("Results:\n{}", tool_output),
                });
            }
        }

        // Handle transition
        if response.transition.is_some() {
            return true;
        }
    }

    // Max iterations — treat as done
    true
}

fn parse_response(raw: &str) -> Option<LlmResponse> {
    let trimmed = raw.trim();
    let cleaned = if trimmed.starts_with("```") {
        let after = trimmed
            .find('\n')
            .map(|i| &trimmed[i + 1..])
            .unwrap_or(trimmed);
        after.strip_suffix("```").unwrap_or(after).trim()
    } else {
        trimmed
    };

    if let Ok(r) = serde_json::from_str::<LlmResponse>(cleaned) {
        return Some(r);
    }

    if let Some(start) = cleaned.find('{') {
        if let Some(end) = cleaned.rfind('}') {
            if let Ok(r) = serde_json::from_str::<LlmResponse>(&cleaned[start..=end]) {
                return Some(r);
            }
        }
    }

    // Bare event
    if let Ok(obj) = serde_json::from_str::<serde_json::Value>(cleaned) {
        if let Some(event) = obj.get("event").and_then(|e| e.as_str()) {
            return Some(LlmResponse {
                transition: Some(event.to_string()),
                tool_calls: None,
                error: None,
            });
        }
    }

    None
}
