mod tdd;
mod tdd_chain;
mod tools;

use clap::Parser;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use statewright_agent::ollama_client::{OllamaClient, OllamaConfig};
use statewright_agent::prompt_templates::ChatMessage;
use statewright_agent::tool_enforcer;
use statewright_agent::validator::validate_agent_machine;
use statewright_engine::MachineDefinition;

/// Tee stdout to a log file using a background thread.
/// All println! output automatically goes to both stdout and the file.
struct StdoutTee {
    _handle: Option<std::thread::JoinHandle<()>>,
}

impl StdoutTee {
    fn start(path: &str) -> Self {
        use std::os::unix::io::FromRawFd;
        use std::io::{BufRead, BufReader, Write};

        let log_path = path.to_string();

        // Create a pipe
        let (read_fd, write_fd) = {
            let mut fds = [0i32; 2];
            unsafe { libc::pipe(fds.as_mut_ptr()); }
            (fds[0], fds[1])
        };

        // Save original stdout fd
        let orig_stdout = unsafe { libc::dup(1) };

        // Redirect stdout to the write end of the pipe
        unsafe { libc::dup2(write_fd, 1); libc::close(write_fd); }

        // Spawn thread that reads from pipe, writes to both original stdout and file
        let handle = std::thread::spawn(move || {
            let reader = BufReader::new(unsafe { std::fs::File::from_raw_fd(read_fd) });
            let mut orig = unsafe { std::fs::File::from_raw_fd(orig_stdout) };
            let mut log = std::fs::File::create(&log_path).unwrap();

            for line in reader.lines() {
                if let Ok(line) = line {
                    let _ = writeln!(orig, "{}", line);
                    let _ = writeln!(log, "{}", line);
                }
            }
        });

        StdoutTee { _handle: Some(handle) }
    }
}

impl Drop for StdoutTee {
    fn drop(&mut self) {
        // Flush stdout so the tee thread gets everything
        use std::io::Write;
        let _ = std::io::stdout().flush();
    }
}

/// RAII guard that restores files on drop (normal exit or panic).
struct RestoreGuard {
    workdir: String,
    originals: HashMap<String, String>,
}

impl Drop for RestoreGuard {
    fn drop(&mut self) {
        for (name, content) in &self.originals {
            let path = std::path::Path::new(&self.workdir).join(name);
            if let Err(e) = std::fs::write(&path, content) {
                eprintln!("[Restore] Failed to restore {}: {}", name, e);
            }
        }
        println!("\n[Restore] {} file(s) restored to original state", self.originals.len());
    }
}

#[derive(Parser)]
#[command(name = "sw-agent", about = "Statewright agent — state machine constrained LLM executor")]
struct Args {
    /// Task description for the agent
    #[arg(short, long, default_value = "Fix the failing test in test_calc.py by finding and fixing the bug in calc.py")]
    task: String,

    /// Working directory for the agent
    #[arg(short, long, default_value = "crates/cli/fixtures/buggy-calc")]
    workdir: String,

    /// Ollama API URL
    #[arg(long, default_value = "http://localhost:11434/v1")]
    ollama_url: String,

    /// Model name
    #[arg(long, default_value = "qwen2.5-coder:32b")]
    model: String,

    /// Max retries for state machine generation
    #[arg(long, default_value = "3")]
    max_retries: u32,

    /// Max total steps before giving up
    #[arg(long, default_value = "20")]
    max_steps: u32,

    /// Skip state machine generation and use a hardcoded one (for testing without LLM)
    #[arg(long)]
    use_hardcoded_machine: bool,

    /// Tool calling mode: "native" uses Ollama's tool calling API, "raw" uses JSON prompting, "auto" tries native first
    #[arg(long, default_value = "auto")]
    tool_mode: String,

    /// Run in TDD greenfield mode instead of bug-fix mode
    #[arg(long)]
    tdd: bool,

    /// Run TDD with debug machine chaining (--tdd-chain)
    #[arg(long)]
    tdd_chain: bool,

    /// Model size in GB (for capability-gated behavior: conversation retention, tool selection)
    #[arg(long, default_value = "20.0")]
    model_size: f32,

    /// Max TDD cycles (only used with --tdd or --tdd-chain)
    #[arg(long, default_value = "10")]
    max_cycles: u32,

    /// Control mode: single state, all tools, no guardrails (no localizer, no minimizer, no auto-test)
    #[arg(long)]
    control: bool,

    /// Log all output to /tmp/statewright-<timestamp>.log
    #[arg(long)]
    log: bool,
}

#[derive(Deserialize, Debug)]
struct LlmResponse {
    #[serde(default)]
    transition: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCallRequest>>,
    #[serde(default)]
    #[allow(dead_code)]
    reasoning: Option<String>,
}

#[derive(Deserialize, Debug)]
struct ToolCallRequest {
    name: String,
    /// Tool arguments — models use either "args" or "arguments"
    #[serde(default, alias = "arguments")]
    args: serde_json::Value,
}

/// Max lines a diff can touch before the change is rejected and restored.
/// For a ~26 line file, 5 lines is generous for a single bug fix.
const MAX_DIFF_LINES: usize = 5;

fn hardcoded_bug_fix_machine() -> MachineDefinition {
    serde_json::from_value(json!({
        "id": "fix-bug",
        "initial": "localizing",
        "meta": { "task_type": "bug_fix", "danger_level": "moderate", "estimated_steps": 8 },
        "states": {
            "localizing": {
                "allowed_tools": [],
                "instructions": "PROGRAMMATIC — do not call LLM",
                "on": { "LOCALIZED": "planning", "FAIL": "failed" }
            },
            "planning": {
                "allowed_tools": ["read_file", "list_directory", "run_test", "grep"],
                "instructions": "Review the localized code sections and test failures provided. Identify the exact bug. Use grep or read_file with start_line/end_line if you need more context. Do NOT modify files yet.",
                "max_iterations": 5,
                "safe_next": "implementing",
                "on": { "PLAN_READY": "implementing", "DONE": "implementing", "FAIL": "failed" }
            },
            "implementing": {
                "allowed_tools": ["read_file", "list_directory", "grep", "edit_line", "edit_block", "patch_file", "apply_patch", "write_file"],
                "instructions": "Fix ONLY the bug. Use edit_line, edit_block, patch_file, or apply_patch. Change the fewest lines possible.",
                "max_iterations": 6,
                "safe_next": "testing",
                "on": { "DONE": "testing", "FAIL": "failed" }
            },
            "testing": {
                "allowed_tools": ["read_file", "run_test"],
                "instructions": "Run the tests with run_test. If ALL tests pass, call transition with TESTS_PASS. If any test fails, call transition with TESTS_FAIL.",
                "max_iterations": 3,
                "on": {
                    "TESTS_PASS": {
                        "target": "review",
                        "requires_approval": true,
                        "approval_message": "All tests pass. Review the changes?"
                    },
                    "TESTS_FAIL": "implementing",
                    "FAIL": "failed"
                }
            },
            "review": {
                "allowed_tools": ["read_file", "diff"],
                "instructions": "Review the changes by calling the diff tool. If the fix looks correct and minimal, call transition with APPROVED. If something is wrong, call transition with REJECTED.",
                "max_iterations": 3,
                "on": { "APPROVED": "completed", "REJECTED": "implementing" }
            },
            "completed": { "type": "final" },
            "failed": { "type": "final" }
        },
        "guards": {}
    }))
    .unwrap()
}

fn control_flat_machine() -> MachineDefinition {
    serde_json::from_value(json!({
        "id": "control-flat",
        "initial": "solving",
        "meta": { "task_type": "bug_fix", "danger_level": "safe" },
        "states": {
            "solving": {
                "allowed_tools": ["read_file", "list_directory", "grep", "run_test", "edit_line", "edit_block", "patch_file", "apply_patch", "write_file", "diff"],
                "instructions": "Fix the bug described in the task. You have all tools available. Read the code, find the bug, fix it, and run the tests to verify.",
                "max_iterations": 20,
                "on": { "DONE": "completed", "FAIL": "failed" }
            },
            "completed": { "type": "final" },
            "failed": { "type": "final" }
        },
        "guards": {}
    }))
    .unwrap()
}

/// Build the system prompt for the current state.
fn build_system_prompt(
    task: &str,
    current_state: &str,
    instructions: &str,
    allowed_tools: &[String],
    transitions: &[(String, String)],
    workdir: &str,
    is_checkpoint: bool,
    iterations_remaining: Option<u32>,
) -> String {
    let tools_list = allowed_tools.join(", ");
    let nav_section = statewright_agent::ollama_client::nav_tools_prompt_section(
        transitions, current_state, allowed_tools, iterations_remaining,
    );

    if is_checkpoint && current_state == "implementing" {
        format!(
r#"You have reached the iteration limit in the "{current_state}" state.
You MUST make your best edit NOW based on what you have read, then call the transition tool.

Use edit_line, edit_block, or patch_file to make the most likely fix. If you are unsure, make your best guess — the tests will verify. Do NOT just transition without editing.

TASK: {task}

Available tools: {tools_list}
- edit_line: args: {{"path": "filename", "old": "line to find", "new": "replacement"}}
- edit_block: args: {{"path": "filename", "old": "multi\nline\nblock", "new": "replacement\nblock"}}
- patch_file: args: {{"path": "filename", "patches": [{{"old": "old", "new": "new"}}]}}

{nav_section}

Respond with ONLY a JSON object."#,
            current_state = current_state,
            task = task,
            tools_list = tools_list,
            nav_section = nav_section,
        )
    } else if is_checkpoint {
        format!(
r#"You have reached the iteration limit in the "{current_state}" state.
You MUST call the transition tool now. No more work tools.

TASK: {task}

{nav_section}

Respond with ONLY a JSON object."#,
            current_state = current_state,
            task = task,
            nav_section = nav_section,
        )
    } else {
        format!(
r#"You fix bugs step by step. Respond with ONLY a JSON object, no other text.

TASK: {task}
STATE: {current_state}
INSTRUCTIONS: {instructions}
WORKING DIRECTORY: {workdir}

To call a tool:
{{"tool_calls": [{{"name": "TOOL_NAME", "args": {{...}}}}]}}

Available tools: {tools_list}
- read_file: args: {{"path": "filename"}} or {{"path": "filename", "start_line": 120, "end_line": 150}} for large files
- write_file: args: {{"path": "filename", "content": "full file content"}}
- list_directory: args: {{"path": "."}}
- run_test: args: {{}}
- grep: args: {{"pattern": "search term"}} or {{"pattern": "search term", "file": "filename"}}
- diff: args: {{"path": "filename"}} (shows changes vs original)
- edit_line: args: {{"path": "filename", "old": "line to find", "new": "replacement"}} (finds by content, no line number needed)
- patch_file: args: {{"path": "filename", "patches": [{{"old": "old line", "new": "new line"}}]}}

{nav_section}"#,
            task = task,
            current_state = current_state,
            instructions = instructions,
            workdir = workdir,
            tools_list = tools_list,
            nav_section = nav_section,
        )
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "sw_demo=info".into()),
        )
        .init();

    let args = Args::parse();

    // TDD chain mode — TDD with debug machine invocation
    if args.tdd_chain {
        let client = OllamaClient::new(OllamaConfig {
            api_url: args.ollama_url,
            model: args.model,
            temperature: 0.3,
            max_tokens: 4096,
        });
        tdd_chain::run_tdd_chain(&args.workdir, &client, args.max_cycles, args.model_size).await;
        return;
    }

    // TDD mode — separate entry point
    if args.tdd {
        let client = OllamaClient::new(OllamaConfig {
            api_url: args.ollama_url,
            model: args.model,
            temperature: 0.3,
            max_tokens: 4096,
        });
        let task = std::fs::read_to_string(
            std::path::Path::new(&args.workdir).join("requirements.md")
        ).unwrap_or(args.task);
        tdd::run_tdd(&task, &args.workdir, &client, args.max_cycles).await;
        return;
    }

    // Tee stdout to log file if requested
    let _tee = if args.log {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let log_path = format!("/tmp/statewright-{}.log", timestamp);
        eprintln!("[LOG] Writing to {}", log_path);
        Some(StdoutTee::start(&log_path))
    } else {
        None
    };

    println!("\n=== Statewright Demo: LLM Self-Guardrailing Agent ===\n");
    println!("Task: {}", args.task);
    println!("Working dir: {}", args.workdir);
    println!("Model: {}", args.model);
    println!();

    // Snapshot and restore: save all files before the run, restore on exit
    let workdir_for_restore = args.workdir.clone();
    let originals = tools::snapshot_all(&args.workdir);
    let original_count = originals.len();
    println!("[Setup] Snapshotted {} file(s) for auto-restore\n", original_count);

    // Restore originals on exit (panic or normal)
    let _restore_guard = RestoreGuard {
        workdir: workdir_for_restore,
        originals,
    };

    // Phase 1: Get or generate the state machine
    let definition = if args.control {
        println!("[Phase 1] CONTROL MODE — flat machine, no guardrails");
        control_flat_machine()
    } else if args.use_hardcoded_machine {
        println!("[Phase 1] Using hardcoded bug-fix state machine");
        hardcoded_bug_fix_machine()
    } else {
        println!("[Phase 1] Generating state machine via LLM...");
        let client = OllamaClient::new(OllamaConfig {
            api_url: args.ollama_url.clone(),
            model: args.model.clone(),
            temperature: 0.3,
            max_tokens: 4096,
        });

        match statewright_agent::generator::generate_machine(&client, &args.task, args.max_retries).await {
            Ok(result) => {
                println!("[Phase 1] State machine generated in {} attempt(s)", result.attempts);
                println!("[Phase 1] States: {:?}", result.definition.states.keys().collect::<Vec<_>>());
                result.definition
            }
            Err(e) => {
                eprintln!("[Phase 1] FAILED to generate state machine: {}", e);
                eprintln!("[Phase 1] Falling back to hardcoded machine");
                hardcoded_bug_fix_machine()
            }
        }
    };

    // Validate
    if let Err(e) = validate_agent_machine(&definition) {
        eprintln!("[Validation] Warnings: {:?}", e.errors);
    }

    // Print the state machine
    println!("\n--- State Machine ---");
    for (name, state_def) in &definition.states {
        let tools = state_def.allowed_tools.as_ref()
            .map(|t| t.join(", "))
            .unwrap_or_else(|| "(none)".into());
        let transitions: Vec<String> = state_def.on.iter()
            .map(|(event, t)| format!("{} -> {}", event, t.target()))
            .collect();
        let max_iter = state_def.max_iterations
            .map(|m| format!(" (max {})", m))
            .unwrap_or_default();
        println!("  {}{} [tools: {}]", name, max_iter, tools);
        for t in &transitions {
            println!("    {}", t);
        }
    }
    println!("---\n");

    // Phase 2: Execute the state machine with conversation history
    println!("[Phase 2] Executing agent within state machine constraints\n");

    let client = OllamaClient::new(OllamaConfig {
        api_url: args.ollama_url,
        model: args.model,
        temperature: 0.3,
        max_tokens: 4096,
    });

    let mut current_state = definition.initial.clone();
    let mut context = definition.context.clone();
    let mut step = 0u32;
    let mut steps_in_current_state = 0u32;

    // Conversation history — the model sees its own previous turns
    let mut conversation: Vec<ChatMessage> = Vec::new();

    loop {
        step += 1;
        steps_in_current_state += 1;

        // Don't abort during testing/review — these are quick programmatic steps
        // that shouldn't count against the LLM's step budget
        let in_endgame = current_state == "testing" || current_state == "review" || current_state == "completed";
        if step > args.max_steps && !in_endgame {
            println!("\n[ABORT] Max steps ({}) exceeded", args.max_steps);
            break;
        }
        // Hard abort if way over (prevent infinite loops even in endgame)
        if step > args.max_steps + 5 {
            println!("\n[ABORT] Max steps ({}) exceeded", args.max_steps);
            break;
        }

        let state_def = match definition.states.get(&current_state) {
            Some(s) => s,
            None => {
                eprintln!("[ERROR] State '{}' not found", current_state);
                break;
            }
        };

        // Check if final state
        if matches!(state_def.state_type, Some(statewright_engine::StateType::Final)) {
            if current_state == "completed" {
                // Summary of what happened
                let changed = tools::all_diff_stats(&args.workdir);
                if !changed.is_empty() {
                    println!("  Bug fixed. {} file(s) modified:", changed.len());
                    for (file, lines_changed, _total) in &changed {
                        println!("    {} — {} line(s) changed", file, lines_changed);
                    }
                }
                println!("\n=== COMPLETED in {} steps ===", step - 1);
            } else {
                println!("\n=== FAILED ({}) after {} steps ===", current_state, step - 1);
            }
            break;
        }

        // PROGRAMMATIC STATE ENTRY ACTIONS
        // These run automatically when entering a state — no LLM call needed.
        // The state machine does the obvious thing so the model doesn't have to.
        if steps_in_current_state == 1 {
            if current_state == "localizing" {
                // PROGRAMMATIC LOCALIZATION
                // 1. List files
                // 2. Run tests to get failure info
                // 3. Grep source files for keywords from the task/failure
                // 4. Read ±20 lines around each grep hit
                // 5. Feed focused excerpts into conversation for the planning state
                println!("[Step {}] State: localizing — programmatic bug localization", step);

                let files = tools::execute_tool("list_directory", &json!({"path": "."}), &args.workdir);
                println!("  [LOCALIZE] Files: {}", files.replace('\n', ", "));

                let test_output = tools::execute_tool("run_test", &json!({}), &args.workdir);
                let test_summary: String = test_output.lines()
                    .filter(|l| l.contains("FAILED") || l.contains("assert") || l.contains("Error") || l.contains("passed"))
                    .take(10)
                    .collect::<Vec<_>>()
                    .join("\n");
                println!("  [LOCALIZE] Test failures:\n{}", test_summary.lines().take(5).collect::<Vec<_>>().join("\n"));

                // Extract keywords from the task to grep for
                let task_lower = args.task.to_lowercase();
                let mut grep_patterns: Vec<&str> = Vec::new();
                // Look for function names mentioned in the task
                for word in ["itermonomials", "min_degree", "max_degree", "max(", "sum(", "divide", "multiply"] {
                    if task_lower.contains(&word.to_lowercase()) {
                        grep_patterns.push(word);
                    }
                }
                // Also grep for terms from the issue description
                if task_lower.contains("maximum") { grep_patterns.push("max("); }
                if task_lower.contains("sum") { grep_patterns.push("sum("); }
                if grep_patterns.is_empty() { grep_patterns.push("def "); }

                let mut localized_code = String::new();

                // Find source files (not test files)
                let source_files: Vec<&str> = files.lines()
                    .filter(|f| f.ends_with(".py") && !f.starts_with("test_") && !f.contains("__"))
                    .collect();

                for src_file in &source_files {
                    for pattern in &grep_patterns {
                        let grep_result = tools::execute_tool(
                            "grep",
                            &json!({"pattern": pattern, "file": src_file}),
                            &args.workdir,
                        );
                        if grep_result != "no matches found" {
                            // Extract line numbers from grep output and read context
                            for line in grep_result.lines().take(5) {
                                if let Some(line_num_str) = line.split(':').nth(1) {
                                    if let Ok(line_num) = line_num_str.trim().parse::<usize>() {
                                        let start = line_num.saturating_sub(10);
                                        let end = line_num + 15;
                                        let context = tools::execute_tool(
                                            "read_file",
                                            &json!({"path": src_file, "start_line": start, "end_line": end}),
                                            &args.workdir,
                                        );
                                        if !localized_code.contains(&context) {
                                            localized_code.push_str(&format!(
                                                "\n=== {} around line {} (grep: '{}') ===\n{}\n",
                                                src_file, line_num, pattern, context
                                            ));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                let excerpt_lines = localized_code.lines().count();
                println!("  [LOCALIZE] Extracted {} lines of relevant code from {} file(s)", excerpt_lines, source_files.len());

                // Feed everything into conversation for the planning state
                conversation.push(ChatMessage {
                    role: "user".into(),
                    content: format!(
                        "Bug localization results:\n\n## Test Failures\n{}\n\n## Relevant Code Sections\n{}\n\nAnalyze these code sections to find the bug described in the task.",
                        test_summary, localized_code
                    ),
                });

                // Transition to planning
                current_state = "planning".into();
                steps_in_current_state = 0;
                println!("  [TRANSITION] localizing -> planning");
                continue;
            }

            if current_state == "testing" {
                // Auto-run tests on entry — this is what testing IS
                let test_result = tools::execute_tool("run_test", &json!({}), &args.workdir);
                let passed = test_result.contains("passed") && !test_result.contains("failed");
                let fail_count = test_result.lines()
                    .find(|l| l.contains("failed"))
                    .and_then(|l| l.split_whitespace().next())
                    .unwrap_or("?");

                println!("[Step {}] State: testing — auto-running tests", step);
                // Show test summary
                let test_summary: String = test_result.lines()
                    .filter(|l| l.contains("passed") || l.contains("failed"))
                    .last()
                    .unwrap_or("tests complete")
                    .trim()
                    .to_string();
                println!("  {}", test_summary);
                if passed {
                    println!("  [AUTO-TEST] ALL PASSED");
                    // Show what changed
                    let changed = tools::all_diff_stats(&args.workdir);
                    for (file, lines_changed, total) in &changed {
                        println!("  Changes: {} ({}/{} lines modified)", file, lines_changed, total);
                    }
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!("Tests ran automatically and ALL PASSED:\n{}\n\nProceeding to review.", test_result),
                    });
                    // Transition to review — let the LLM handle the review state
                    println!("  [TRANSITION] testing -> review");
                    current_state = "review".into();
                    steps_in_current_state = 0;
                    continue;
                } else {
                    println!("  [AUTO-TEST] {} failing — returning to implementing", fail_count);
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!("Tests ran automatically and FAILED:\n{}\n\nYou are back in implementing. Fix the remaining issues.", test_result),
                    });
                    current_state = "implementing".into();
                    steps_in_current_state = 0;
                    tools::snapshot_files(&args.workdir);
                    println!("  [TRANSITION] testing -> implementing");
                    println!("  [SNAPSHOT] Working directory snapshotted");
                    continue;
                }
            }
        }

        let allowed_tools = state_def.allowed_tools.as_ref().cloned().unwrap_or_default();
        let instructions = state_def.instructions.as_deref().unwrap_or("Proceed.");
        let transitions: Vec<(String, String)> = state_def.on.iter()
            .map(|(event, t)| (event.clone(), t.target().to_string()))
            .collect();

        // Decision checkpoint: max_iterations reached
        let is_checkpoint = state_def.max_iterations
            .is_some_and(|max| steps_in_current_state > max);

        // Hard cutoff: if stuck at 3x the max iterations, force transition
        let hard_limit = state_def.max_iterations.map(|m| m * 3);
        if let Some(limit) = hard_limit {
            if steps_in_current_state > limit {
                let next = state_def.safe_next.clone()
                    .or_else(|| state_def.on.iter()
                        .find(|(e, _)| e.as_str() != "FAIL")
                        .map(|(_, t)| t.target().to_string()))
                    .unwrap_or_else(|| "failed".to_string());
                println!("[Step {}] HARD LIMIT — forcing {} -> {}", step, current_state, next);
                current_state = next;
                steps_in_current_state = 0;
                continue;
            }
        }

        if is_checkpoint {
            let hard_max = state_def.max_iterations.unwrap() * 3;
            println!("[Step {}] CHECKPOINT in '{}' — forcing decision (iteration {}/{})",
                step, current_state,
                steps_in_current_state,
                hard_max);
        } else {
            println!("[Step {}] State: {} ({}/{}) | Tools: [{}]",
                step, current_state,
                steps_in_current_state,
                state_def.max_iterations.unwrap_or(99),
                allowed_tools.join(", "));
        }

        let iters_remaining = state_def.max_iterations
            .map(|max| max.saturating_sub(steps_in_current_state));

        // Build messages: system prompt + conversation history + user nudge
        let system = build_system_prompt(
            &args.task,
            &current_state,
            instructions,
            &allowed_tools,
            &transitions,
            &args.workdir,
            is_checkpoint,
            iters_remaining,
        );

        let mut messages = vec![ChatMessage {
            role: "system".into(),
            content: system,
        }];

        // Add conversation history (last 10 turns to stay within context)
        let history_start = conversation.len().saturating_sub(10);
        messages.extend(conversation[history_start..].iter().cloned());

        // User message
        messages.push(ChatMessage {
            role: "user".into(),
            content: if is_checkpoint && current_state == "implementing" {
                "You've reached the iteration limit. Make your best edit NOW based on what you've read, then call transition with DONE. Do not skip the edit.".into()
            } else if is_checkpoint {
                "You've reached the iteration limit. Make your decision now.".into()
            } else {
                "What is your next action?".into()
            },
        });

        // Call LLM — dual mode: native tool calling or raw JSON
        let use_native = match args.tool_mode.as_str() {
            "native" => true,
            "raw" => false,
            _ => !is_checkpoint, // "auto": native for tool steps, raw for checkpoints
        };

        let mut tool_calls_to_process: Vec<(String, serde_json::Value)> = Vec::new();
        let mut transition_event: Option<String> = None;
        let mut transition_error: Option<String> = None;

        let force_native = args.tool_mode == "native";
        if use_native && (!is_checkpoint || force_native) {
            // Native tool calling path
            let tool_defs = statewright_agent::ollama_client::build_tool_definitions_with_nav(
                &allowed_tools, &transitions,
            );
            let result = match client.chat_with_tools(messages, tool_defs).await {
                Ok(r) => r,
                Err(e) => {
                    // Fall back to raw JSON on native failure
                    eprintln!("  [NATIVE FAILED] {} — falling back to raw JSON", e);
                    // Rebuild messages for raw path
                    let system = build_system_prompt(
                        &args.task, &current_state, instructions,
                        &allowed_tools, &transitions, &args.workdir, is_checkpoint,
                        iters_remaining,
                    );
                    let mut msgs = vec![ChatMessage { role: "system".into(), content: system }];
                    let hs = conversation.len().saturating_sub(10);
                    msgs.extend(conversation[hs..].iter().cloned());
                    msgs.push(ChatMessage { role: "user".into(), content: "What is your next action?".into() });

                    match client.chat(msgs).await {
                        Ok(raw) => {
                            // Parse as raw JSON
                            if let Some(resp) = parse_response(&raw) {
                                if let Some(calls) = resp.tool_calls {
                                    for c in calls { tool_calls_to_process.push((c.name, c.args)); }
                                }
                                transition_event = resp.transition;
                                transition_error = resp.error;
                                conversation.push(ChatMessage { role: "assistant".into(), content: raw });
                            }
                            // Continue to processing below
                            statewright_agent::ollama_client::ChatResult {
                                content: String::new(), tool_calls: vec![],
                                mode: statewright_agent::ollama_client::ResponseMode::RawJson,
                                reasoning: None,
                            }
                        }
                        Err(e2) => { eprintln!("  [LLM ERROR] {}", e2); break; }
                    }
                }
            };

            if result.mode == statewright_agent::ollama_client::ResponseMode::NativeToolCalling {
                // Extract native tool calls
                for tc in &result.tool_calls {
                    let args_val = match &tc.function.arguments {
                        serde_json::Value::String(s) => {
                            serde_json::from_str(s).unwrap_or(serde_json::json!({}))
                        }
                        other => other.clone(),
                    };
                    println!("  [NATIVE] {}({})", tc.function.name, truncate_json(&args_val, 60));
                    tool_calls_to_process.push((tc.function.name.clone(), args_val));
                }

                // Check if content has transitions or tool calls (some models put them in text)
                if !result.content.is_empty() {
                    if let Some(resp) = parse_response(&result.content) {
                        if resp.transition.is_some() {
                            transition_event = resp.transition;
                            transition_error = resp.error;
                        }
                        if let Some(calls) = resp.tool_calls {
                            for c in calls {
                                tool_calls_to_process.push((c.name, c.args));
                            }
                        }
                    }
                }

                // If no tool calls and no transition from native, the model gave text only
                if tool_calls_to_process.is_empty() && transition_event.is_none() && !result.content.is_empty() {
                    println!("  [LLM] {}", truncate(&result.content, 300));
                }

                conversation.push(ChatMessage {
                    role: "assistant".into(),
                    content: if result.content.is_empty() {
                        serde_json::to_string(&result.tool_calls).unwrap_or_default()
                    } else {
                        result.content
                    },
                });
            }
        } else {
            // Raw JSON path (or checkpoint)
            let raw_response = match client.chat(messages).await {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("  [LLM ERROR] {}", e);
                    break;
                }
            };

            println!("  [LLM] {}", truncate(&raw_response, 300));

            match parse_response(&raw_response) {
                Some(resp) => {
                    if let Some(calls) = resp.tool_calls {
                        for c in calls { tool_calls_to_process.push((c.name, c.args)); }
                    }
                    transition_event = resp.transition;
                    transition_error = resp.error;
                    conversation.push(ChatMessage { role: "assistant".into(), content: raw_response });
                }
                None => {
                    println!("  [PARSE FAIL] {}", truncate(&raw_response, 200));
                    conversation.push(ChatMessage { role: "assistant".into(), content: raw_response });
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: "That was not valid JSON. Respond with ONLY a JSON object.".into(),
                    });
                    continue;
                }
            }
        }

        // Process tool calls (unified for both modes)
        let mut tool_output = String::new();
        for (tool_name, tool_args) in &tool_calls_to_process {
            // Handle state machine navigation tools
            if tool_name == "transition" {
                // Handle both object args and stringified JSON args
                let resolved_args = match tool_args {
                    serde_json::Value::String(s) => {
                        serde_json::from_str::<serde_json::Value>(s).unwrap_or(serde_json::json!({}))
                    }
                    other => other.clone(),
                };
                let event = resolved_args.get("event").and_then(|e| e.as_str()).unwrap_or("DONE");
                let error = resolved_args.get("error").and_then(|e| e.as_str()).map(|s| s.to_string());
                println!("  [NAV] transition({})", event);
                transition_event = Some(event.to_string());
                transition_error = error;
                continue;
            }

            if tool_name == "get_available_actions" {
                let actions = serde_json::json!({
                    "current_state": current_state,
                    "available_tools": allowed_tools,
                    "transitions": transitions.iter().map(|(e, t)| {
                        serde_json::json!({"event": e, "target": t})
                    }).collect::<Vec<_>>(),
                    "iterations_remaining": iters_remaining,
                });
                let actions_str = serde_json::to_string_pretty(&actions).unwrap();
                println!("  [NAV] get_available_actions -> {}", truncate(&actions_str, 200));
                tool_output.push_str(&format!("=== available actions ===\n{}\n", actions_str));
                continue;
            }

            // Regular tool — enforce access
            let enforcement = tool_enforcer::enforce_tools(
                &definition, &current_state, &[tool_name.clone()],
            );

            if !enforcement.blocked.is_empty() {
                // Implicit transition: blocked tool belongs to the next state
                if let Some(event) = &enforcement.implicit_transition {
                    println!("  [NAV] {} -> implicit transition({})", tool_name, event);
                    transition_event = Some(event.clone());
                    continue;
                }
                let msg = format!(
                    "BLOCKED: '{}' is not allowed in '{}' state. Use get_available_actions to see what you can do.",
                    tool_name, current_state,
                );
                println!("  [GUARD] {}", msg);
                tool_output.push_str(&msg);
                tool_output.push('\n');
                continue;
            }

            let result = tools::execute_tool(tool_name, tool_args, &args.workdir);
            // Escape newlines for edit/patch results so TUI can parse diffs on one line
            // Don't escape read_file results — they're huge and only shown truncated
            let is_edit = tool_name.contains("edit") || tool_name.contains("patch") || tool_name == "diff";
            let display_result = if is_edit {
                result.replace('\n', "\\n")
            } else {
                result.replace('\n', " ")
            };
            println!("  [TOOL] {}({}) -> {}", tool_name,
                truncate_json(tool_args, 60), truncate(&display_result, 300));
            tool_output.push_str(&format!("=== {} result ===\n{}\n", tool_name, result));
        }

        if !tool_output.is_empty() {
            conversation.push(ChatMessage {
                role: "user".into(),
                content: format!("Tool results:\n{}", tool_output),
            });
        }

        // Handle transition
        if let Some(raw_event) = &transition_event {
            // Sanitize: model might output "DONE -> testing" instead of "DONE"
            let event = raw_event.split_whitespace().next().unwrap_or(raw_event).trim();

            if event == "FAIL" {
                let err = transition_error.unwrap_or_else(|| "agent reported failure".into());
                println!("  [FAIL] {}", err);
                current_state = "failed".into();
                steps_in_current_state = 0;
                conversation.clear();
                continue;
            }

            match statewright_engine::resolve_transition(
                &current_state,
                event,
                &serde_json::Value::Null,
                &context,
                &definition,
            ) {
                Ok(result) => {
                    if result.requires_approval {
                        let msg = result.approval_message.as_deref().unwrap_or("Approval required");
                        println!("\n  [APPROVAL GATE] {}", msg);
                        // In production, this is where the system parks and waits for human input.
                        // For the demo, transition to the approval state and let the LLM handle it.
                        println!("  [TRANSITION] {} -> {}", current_state, result.new_state);
                        current_state = result.new_state;
                        context = result.new_context;
                        steps_in_current_state = 0;
                        continue;
                    }
                    // Snapshot files before entering implementing state
                    if result.new_state == "implementing" {
                        tools::snapshot_files(&args.workdir);
                        println!("  [SNAPSHOT] Working directory snapshotted");
                    }

                    // PROGRAMMATIC EDIT GATE: block transition from implementing if nothing was edited.
                    // This is a hard constraint, not a prompt suggestion.
                    if current_state == "implementing" {
                        let changed_files = tools::all_diff_stats(&args.workdir);
                        if changed_files.is_empty() {
                            println!("  [EDIT GATE] BLOCKED — no files changed. You must edit before transitioning.");
                            conversation.push(ChatMessage {
                                role: "user".into(),
                                content: "BLOCKED: You have not edited any files. You MUST use edit_line, edit_block, or patch_file to make a change before calling transition. Do it now.".into(),
                            });
                            steps_in_current_state += 1;
                            continue;
                        }
                    }

                    // PROGRAMMATIC MINIMIZER: when leaving implementing, check diff size.
                    // If too many lines changed, restore the snapshot and bounce back.
                    if current_state == "implementing" {
                        let mut rejected = false;
                        let changed_files = tools::all_diff_stats(&args.workdir);

                        for (file, changed, total) in &changed_files {
                            println!("  [DIFF] {} — {}/{} lines changed", file, changed, total);

                            if *changed > MAX_DIFF_LINES && *total > 0 {
                                println!("  [MINIMIZER] REJECTED — {} changed {} lines (max {}). Restoring and retrying.",
                                    file, changed, MAX_DIFF_LINES);
                                tools::restore_snapshot(&args.workdir);
                                rejected = true;

                                let diff_detail = tools::execute_tool(
                                    "diff",
                                    &json!({"path": file}),
                                    &args.workdir,
                                );

                                conversation.push(ChatMessage {
                                    role: "user".into(),
                                    content: format!(
                                        "Your change was REJECTED because you modified {} lines (maximum allowed: {}). \
                                        The file has been restored to the original. You changed:\n{}\n\n\
                                        Try again. Change ONLY the line(s) with the bug. Do NOT rename variables, \
                                        remove comments, or rewrite working functions.",
                                        changed, MAX_DIFF_LINES, diff_detail
                                    ),
                                });
                                break;
                            }
                        }

                        if rejected {
                            // Stay in implementing — don't advance
                            steps_in_current_state += 1;
                            println!("  [MINIMIZER] Staying in 'implementing' — fix must be smaller");
                            continue;
                        }
                    }

                    println!("  [TRANSITION] {} -> {}", current_state, result.new_state);
                    current_state = result.new_state;
                    context = result.new_context;
                    steps_in_current_state = 0;
                }
                Err(e) => {
                    let msg = format!("Invalid transition: {}", e);
                    println!("  [TRANSITION ERROR] {}", msg);
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!("That transition was invalid: {}. Try a different action.", e),
                    });
                }
            }
        }
    }

    // Final verification
    println!("\n--- Final Verification ---");
    let test_result = tools::execute_tool("run_test", &json!({}), &args.workdir);
    if test_result.contains("passed") && !test_result.contains("failed") {
        println!("[SUCCESS] All tests pass!");
    } else {
        let lines: Vec<&str> = test_result.lines().collect();
        let summary_start = lines.iter().position(|l| l.contains("FAILED") || l.contains("passed"))
            .unwrap_or(lines.len().saturating_sub(5));
        for line in &lines[summary_start..] {
            println!("  {}", line);
        }
    }
    println!();
}

/// Normalize single-quoted JSON to double-quoted JSON.
/// Handles: {'key': 'value'} -> {"key": "value"}
/// Also escapes double quotes found inside single-quoted strings:
///   'replace("b", "")' -> "replace(\"b\", \"\")"
fn normalize_single_quotes(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut in_double_string = false;
    let mut in_single_string = false;
    let mut escape_next = false;
    for ch in input.chars() {
        if escape_next {
            result.push(ch);
            escape_next = false;
            continue;
        }
        match ch {
            '\\' => {
                result.push(ch);
                escape_next = true;
            }
            '"' if in_single_string => {
                // Double quote inside a single-quoted string — escape it
                result.push('\\');
                result.push('"');
            }
            '"' if !in_single_string => {
                in_double_string = !in_double_string;
                result.push(ch);
            }
            '\'' if !in_double_string => {
                in_single_string = !in_single_string;
                result.push('"'); // Replace single quote with double quote
            }
            _ => result.push(ch),
        }
    }
    result
}

fn parse_response(raw: &str) -> Option<LlmResponse> {
    let trimmed = raw.trim();

    // Strip code fences
    let cleaned = if trimmed.starts_with("```") {
        let after_first = trimmed.find('\n').map(|i| &trimmed[i + 1..]).unwrap_or(trimmed);
        after_first.strip_suffix("```").unwrap_or(after_first).trim()
    } else {
        trimmed
    };

    // Try direct parse — only accept if it has actual content
    if let Ok(r) = serde_json::from_str::<LlmResponse>(cleaned) {
        if r.transition.is_some() || r.tool_calls.is_some() || r.error.is_some() {
            return Some(r);
        }
    }

    // Try with single quotes normalized to double quotes (qwen-coder outputs single-quoted JSON)
    let dequoted = normalize_single_quotes(cleaned);
    if dequoted != cleaned {
        if let Ok(r) = serde_json::from_str::<LlmResponse>(&dequoted) {
            if r.transition.is_some() || r.tool_calls.is_some() || r.error.is_some() {
                return Some(r);
            }
        }
    }

    // Greedy brace-counted JSON extraction: find the first '{' and its balanced '}'
    // This handles models that output valid JSON followed by trailing reasoning text
    if let Some(start) = cleaned.find('{') {
        let bytes = cleaned.as_bytes();
        let mut depth = 0i32;
        let mut in_string = false;
        let mut escape_next = false;
        let mut end = start;

        for i in start..bytes.len() {
            if escape_next {
                escape_next = false;
                continue;
            }
            match bytes[i] {
                b'\\' if in_string => escape_next = true,
                b'"' => in_string = !in_string,
                b'{' if !in_string => depth += 1,
                b'}' if !in_string => {
                    depth -= 1;
                    if depth == 0 {
                        end = i;
                        break;
                    }
                }
                _ => {}
            }
        }

        if depth == 0 && end > start {
            if let Ok(r) = serde_json::from_str::<LlmResponse>(&cleaned[start..=end]) {
                // Only accept if it has actual content — otherwise fall through
                // to bare event/transition parsers below
                if r.transition.is_some() || r.tool_calls.is_some() || r.error.is_some() {
                    return Some(r);
                }
            }
        }
    }

    // Handle bare {"event": "..."} as a transition
    if let Ok(obj) = serde_json::from_str::<serde_json::Value>(cleaned) {
        if let Some(event) = obj.get("event").and_then(|e| e.as_str()) {
            return Some(LlmResponse {
                transition: None,
                error: obj.get("error").and_then(|e| e.as_str()).map(|s| s.to_string()),
                tool_calls: Some(vec![ToolCallRequest {
                    name: "transition".into(),
                    args: json!({"event": event}),
                }]),
                reasoning: None,
            });
        }

        // Handle {"transition":{"event":"X"}} nested format (gpt-oss)
        if let Some(transition_obj) = obj.get("transition") {
            if let Some(event) = transition_obj.get("event").and_then(|e| e.as_str()) {
                return Some(LlmResponse {
                    transition: None,
                    error: None,
                    tool_calls: Some(vec![ToolCallRequest {
                        name: "transition".into(),
                        args: json!({"event": event}),
                    }]),
                    reasoning: None,
                });
            }
        }

        // Handle {"action":"tool_name", ...args} format (gpt-oss/reasoning models)
        if let Some(action) = obj.get("action").and_then(|a| a.as_str()) {
            let mut args = obj.clone();
            if let Some(map) = args.as_object_mut() {
                map.remove("action");
            }
            return Some(LlmResponse {
                transition: None,
                error: None,
                tool_calls: Some(vec![ToolCallRequest {
                    name: action.to_string(),
                    args,
                }]),
                reasoning: None,
            });
        }

        // Handle {"name":"tool_name","args":{...}} without tool_calls wrapper
        if let Some(name) = obj.get("name").and_then(|n| n.as_str()) {
            let args = obj.get("args").cloned().unwrap_or(json!({}));
            return Some(LlmResponse {
                transition: None,
                error: None,
                tool_calls: Some(vec![ToolCallRequest {
                    name: name.to_string(),
                    args,
                }]),
                reasoning: None,
            });
        }

        // Handle {"patch":"..."} as apply_patch (gpt-oss Harmony format)
        if let Some(patch) = obj.get("patch").and_then(|p| p.as_str()) {
            return Some(LlmResponse {
                transition: None,
                error: None,
                tool_calls: Some(vec![ToolCallRequest {
                    name: "apply_patch".into(),
                    args: json!({"patch": patch}),
                }]),
                reasoning: None,
            });
        }
    }

    None
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        // Find a valid char boundary at or before max
        let mut end = max;
        while end > 0 && !s.is_char_boundary(end) { end -= 1; }
        format!("{}...", &s[..end])
    }
}

fn truncate_json(v: &serde_json::Value, max: usize) -> String {
    let s = serde_json::to_string(v).unwrap_or_default();
    truncate(&s, max)
}
