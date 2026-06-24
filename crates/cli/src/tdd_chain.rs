use crate::tools;
use serde::Deserialize;
use serde_json::json;
use statewright_agent::ollama_client::{OllamaClient, OllamaConfig};
use statewright_agent::prompt_templates::ChatMessage;

/// Conversation retention strategy based on model capability.
#[derive(Debug, Clone, Copy)]
pub enum ConversationStrategy {
    /// Clear every cycle. For ≤10B models — test suite is the memory.
    ClearPerCycle,
    /// Clear between phases (RED/GREEN/DEBUG) but keep within a phase. For 10-30B.
    ClearPerPhase,
    /// Keep full history across all cycles. For 30B+ models.
    KeepAll,
}

impl ConversationStrategy {
    /// Select strategy based on model size in GB.
    pub fn for_model_size(size_gb: f32) -> Self {
        if size_gb <= 10.0 {
            ConversationStrategy::ClearPerCycle
        } else if size_gb <= 30.0 {
            ConversationStrategy::ClearPerPhase
        } else {
            ConversationStrategy::KeepAll
        }
    }
}

/// Run TDD with debug machine chaining.
/// When GREEN fails, instead of looping back to implementing with "tests still failing,"
/// the debug machine localizes and fixes the issue.
pub async fn run_tdd_chain(
    workdir: &str,
    client: &OllamaClient,
    max_cycles: u32,
    model_size_gb: f32,
) -> bool {
    let strategy = ConversationStrategy::for_model_size(model_size_gb);
    println!("\n=== Statewright TDD + Debug Chaining ===");
    println!(
        "Conversation strategy: {:?} (model ~{:.0}GB)\n",
        strategy, model_size_gb
    );

    let requirements =
        tools::execute_tool("read_file", &json!({"path": "requirements.md"}), workdir);
    println!("[Requirements]\n{}\n", requirements);

    // Phase 1: Design stubs (or use pre-existing ones)
    let stub_check = tools::execute_tool("read_file", &json!({"path": "kvstore.py"}), workdir);
    if stub_check.starts_with("error") {
        println!("--- Phase 1: Design ---");
        let stubs = create_stubs(client, workdir).await;
        if !stubs {
            println!("[FAILED] Could not create stubs");
            return false;
        }
    } else {
        println!("--- Phase 1: Using existing stubs ---");
    }

    let req_lines: Vec<&str> = requirements
        .lines()
        .filter(|l| l.starts_with(|c: char| c.is_ascii_digit()))
        .collect();

    let total = req_lines.len().min(max_cycles as usize);
    println!(
        "\n--- Phase 2: TDD Cycles with Debug Chaining ({} requirements) ---\n",
        total
    );

    let mut conversation: Vec<ChatMessage> = Vec::new();
    let mut pass_count = 0u32;
    let mut invoke_count = 0u32;

    for (cycle_num, req) in req_lines.iter().enumerate().take(total) {
        let cycle = cycle_num + 1;
        // Conversation retention based on model capability
        match strategy {
            ConversationStrategy::ClearPerCycle => conversation.clear(),
            ConversationStrategy::ClearPerPhase => {} // cleared at phase boundaries below
            ConversationStrategy::KeepAll => {}
        }

        println!("╔══ Cycle {}/{}: {} ══╗", cycle, total, req.trim());

        // RED: Write a failing test
        println!("│ [RED] Writing test...");
        let wrote_test = call_llm_for_action(
            client, workdir,
            &format!(
                "Write ONE pytest test in test_kvstore.py for:\n{}\n\n\
                Import KVStore from kvstore. If test_kvstore.py exists, read it first and APPEND the new test.\n\
                Use write_file to create/update the file.",
                req
            ),
            &["read_file", "write_file", "edit_line"],
            3,
            &mut conversation,
        ).await;

        if !wrote_test {
            println!("│ [RED] Failed to write test");
            println!("╚══ Cycle {} FAILED ══╝\n", cycle);
            continue;
        }

        // Verify RED
        let red_result = tools::execute_tool("run_test", &json!({}), workdir);
        let has_failures = red_result.contains("failed")
            || red_result.contains("ERROR")
            || red_result.contains("error");
        if has_failures {
            println!("│ [RED] ✓ Test fails as expected");
        } else {
            println!("│ [RED] Test already passes — moving on");
        }

        conversation.push(ChatMessage {
            role: "user".into(),
            content: format!("Test results:\n{}", red_result),
        });

        // GREEN: Implement
        if matches!(strategy, ConversationStrategy::ClearPerPhase) {
            conversation.clear();
        }
        println!("│ [GREEN] Implementing...");
        let implemented = call_llm_for_action(
            client, workdir,
            &format!(
                "Make all tests pass. Implement the method for:\n{}\n\n\
                Read kvstore.py first. Use edit_line to change specific lines (e.g., replace `pass` with the implementation).\n\
                Or use write_file to rewrite the whole file if needed.",
                req
            ),
            &["read_file", "write_file", "edit_line", "edit_block", "patch_file", "grep"],
            5,
            &mut conversation,
        ).await;

        if !implemented {
            println!("│ [GREEN] Failed to implement");
            println!("╚══ Cycle {} FAILED ══╝\n", cycle);
            continue;
        }

        // Verify GREEN
        let green_result = tools::execute_tool("run_test", &json!({}), workdir);
        let all_pass = green_result.contains("passed")
            && !green_result.contains("failed")
            && !green_result.contains("ERROR");

        if all_pass {
            pass_count += 1;
            println!("│ [GREEN] ✓ All tests pass");
            println!("╚══ Cycle {} COMPLETE ══╝\n", cycle);
            continue;
        }

        // GREEN FAILED — INVOKE DEBUG MACHINE
        if matches!(strategy, ConversationStrategy::ClearPerPhase) {
            conversation.clear();
        }
        println!("│ [GREEN] ✗ Tests failing — INVOKING DEBUG MACHINE");
        invoke_count += 1;

        // The debug machine: localize → diagnose → fix
        let debug_success =
            run_debug_child(client, workdir, &green_result, &mut conversation).await;

        if debug_success {
            // Verify after debug fix
            let verify_result = tools::execute_tool("run_test", &json!({}), workdir);
            let fixed = verify_result.contains("passed")
                && !verify_result.contains("failed")
                && !verify_result.contains("ERROR");
            if fixed {
                pass_count += 1;
                println!("│ [DEBUG] ✓ Debug machine fixed the issue — all tests pass");
                println!("╚══ Cycle {} COMPLETE (via debug) ══╝\n", cycle);
                continue;
            } else {
                println!("│ [DEBUG] ✗ Debug machine couldn't fully fix it");
            }
        } else {
            println!("│ [DEBUG] ✗ Debug machine failed");
        }

        println!("╚══ Cycle {} PARTIAL ══╝\n", cycle);
    }

    // Final
    println!("--- Final Verification ---");
    let final_result = tools::execute_tool("run_test", &json!({}), workdir);
    let final_pass = final_result.contains("passed")
        && !final_result.contains("failed")
        && !final_result.contains("ERROR");

    let test_summary = final_result
        .lines()
        .filter(|l| l.contains("passed") || l.contains("failed"))
        .collect::<Vec<_>>()
        .join("\n");

    if final_pass {
        println!("[SUCCESS] {}", test_summary.trim());
    } else {
        println!("[RESULT] {}", test_summary.trim());
    }

    println!(
        "\nStats: {}/{} cycles passed, {} debug invocations",
        pass_count, total, invoke_count
    );

    // Show generated code
    let kv = tools::execute_tool("read_file", &json!({"path": "kvstore.py"}), workdir);
    let tests = tools::execute_tool("read_file", &json!({"path": "test_kvstore.py"}), workdir);
    println!(
        "Generated: kvstore.py ({} lines), test_kvstore.py ({} lines)\n",
        kv.lines().count(),
        tests.lines().count()
    );

    final_pass
}

/// The debug child machine: localize the failure, diagnose, fix.
/// This is the sub-machine that the TDD parent invokes on GREEN failure.
async fn run_debug_child(
    client: &OllamaClient,
    workdir: &str,
    test_output: &str,
    conversation: &mut Vec<ChatMessage>,
) -> bool {
    println!("│ ┌── Debug Machine ──┐");

    // Step 1: LOCALIZE (programmatic)
    println!("│ │ [LOCALIZE] Analyzing test failures...");
    let failure_lines: Vec<&str> = test_output
        .lines()
        .filter(|l| {
            l.contains("FAILED")
                || l.contains("assert")
                || l.contains("Error")
                || l.contains("raise")
        })
        .take(10)
        .collect();
    let failure_summary = failure_lines.join("\n");

    // Grep for relevant code
    let kvstore_content = tools::execute_tool("read_file", &json!({"path": "kvstore.py"}), workdir);
    println!(
        "│ │ [LOCALIZE] kvstore.py: {} lines",
        kvstore_content.lines().count()
    );

    // Feed localized info into conversation
    conversation.push(ChatMessage {
        role: "user".into(),
        content: format!(
            "DEBUG MODE: Tests are failing after your implementation.\n\n\
            Test failures:\n{}\n\n\
            Current kvstore.py:\n{}\n\n\
            Diagnose the issue and fix it. Use edit_line or write_file.",
            failure_summary, kvstore_content
        ),
    });

    // Step 2: DIAGNOSE + FIX (LLM)
    println!("│ │ [FIX] Diagnosing and fixing...");
    let fixed = call_llm_for_action(
        client,
        workdir,
        "Read the test failures and the current code. Identify what's wrong and fix it. \
        Use edit_line for targeted fixes or write_file to rewrite kvstore.py.",
        &[
            "read_file",
            "write_file",
            "edit_line",
            "edit_block",
            "patch_file",
            "grep",
        ],
        5,
        conversation,
    )
    .await;

    println!(
        "│ └── Debug Machine {} ──┘",
        if fixed { "COMPLETE" } else { "FAILED" }
    );

    fixed
}

/// Create initial stubs via LLM
async fn create_stubs(client: &OllamaClient, workdir: &str) -> bool {
    let mut conv = Vec::new();
    call_llm_for_action(
        client,
        workdir,
        "Read requirements.md. Then use write_file to create kvstore.py with a KVStore class. \
        Include __init__(self) with self._store = {}. Each method should just contain `pass`. \
        You MUST call write_file.",
        &["read_file", "write_file", "list_directory"],
        5,
        &mut conv,
    )
    .await;

    let check = tools::execute_tool("read_file", &json!({"path": "kvstore.py"}), workdir);
    !check.starts_with("error")
}

#[derive(Deserialize, Debug)]
struct LlmResponse {
    #[serde(default)]
    transition: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Deserialize, Debug)]
struct ToolCall {
    name: String,
    #[serde(default, alias = "arguments")]
    args: serde_json::Value,
}

/// Call the LLM in a loop until it transitions or hits max iterations.
async fn call_llm_for_action(
    client: &OllamaClient,
    workdir: &str,
    instructions: &str,
    allowed_tools: &[&str],
    max_iter: u32,
    conversation: &mut Vec<ChatMessage>,
) -> bool {
    let tools_list = allowed_tools.join(", ");

    for _ in 0..max_iter {
        let system = format!(
            r#"You build software step by step. Respond with ONLY a JSON object.

INSTRUCTIONS: {instructions}

To call a tool:
{{"tool_calls": [{{"name": "TOOL_NAME", "args": {{...}}}}]}}

Available tools: {tools_list}
- read_file: args: {{"path": "filename"}}
- write_file: args: {{"path": "filename", "content": "full content"}}
- edit_line: args: {{"path": "filename", "old": "line to find", "new": "replacement"}}
- edit_block: args: {{"path": "filename", "old": "def method():\n    pass", "new": "def method():\n    return 42"}} (multi-line find and replace)
- patch_file: args: {{"path": "filename", "patches": [{{"old": "old", "new": "new"}}]}}
- grep: args: {{"pattern": "text", "file": "filename"}}

When done: {{"transition": "DONE"}}"#,
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
                eprintln!("│   [LLM ERROR] {}", e);
                return false;
            }
        };

        let response: LlmResponse = match parse(&raw) {
            Some(r) => r,
            None => {
                conversation.push(ChatMessage {
                    role: "assistant".into(),
                    content: raw,
                });
                conversation.push(ChatMessage {
                    role: "user".into(),
                    content: "Respond with ONLY JSON.".into(),
                });
                continue;
            }
        };

        conversation.push(ChatMessage {
            role: "assistant".into(),
            content: raw,
        });

        if let Some(calls) = &response.tool_calls {
            let mut output = String::new();
            for call in calls {
                if call.name == "transition" {
                    return true;
                }
                if !allowed_tools.contains(&call.name.as_str()) {
                    output.push_str(&format!("BLOCKED: '{}'\n", call.name));
                    continue;
                }
                let result = tools::execute_tool(&call.name, &call.args, workdir);
                let short: String = result.chars().take(80).collect();
                println!("│   [{}] {}", call.name, short.replace('\n', " "));
                output.push_str(&format!("=== {} ===\n{}\n", call.name, result));
            }
            if !output.is_empty() {
                conversation.push(ChatMessage {
                    role: "user".into(),
                    content: format!("Results:\n{}", output),
                });
            }
        }

        if response.transition.is_some() {
            return true;
        }
    }

    true // max iterations = done
}

fn parse(raw: &str) -> Option<LlmResponse> {
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
    if let Some(s) = cleaned.find('{') {
        if let Some(e) = cleaned.rfind('}') {
            if let Ok(r) = serde_json::from_str::<LlmResponse>(&cleaned[s..=e]) {
                return Some(r);
            }
        }
    }
    None
}
