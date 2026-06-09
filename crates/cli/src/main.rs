mod model_registry;
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
use statewright_cli::events::{self, TuiEvent, StateInfo};

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

    /// Output JSONL events to stdout instead of pretty TUI output (for MCP gateway integration)
    #[arg(long)]
    json_events: bool,

    /// Run configuration JSON file (model routing, guardrails, workflow — for MCP gateway control)
    #[arg(long)]
    config: Option<String>,

    /// Execute a single state then exit. The TUI orchestrates, sw-agent executes one state at a time.
    /// Context (recon results, last tool output) is passed via --context-file.
    #[arg(long)]
    state: Option<String>,

    /// Context file (JSON) — passed to the agent for single-state execution.
    /// Contains recon results, previous tool outputs, etc.
    #[arg(long)]
    context_file: Option<String>,
}

/// Run configuration — written by the MCP gateway, read by the agent.
/// Per-state model routing, guardrails, and workflow definition.
#[derive(Deserialize, Debug, Default)]
struct RunConfig {
    #[serde(default)]
    task: Option<String>,
    #[serde(default)]
    workdir: Option<String>,
    #[serde(default)]
    workflow: Option<MachineDefinition>,
    #[serde(default)]
    model_routing: HashMap<String, ModelConfig>,
    #[serde(default)]
    guardrails: GuardrailConfig,
}

#[derive(Deserialize, Debug, Clone)]
struct ModelConfig {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    ollama_url: Option<String>,
    #[serde(default = "default_num_ctx")]
    num_ctx: u32,
    #[serde(default = "default_temperature")]
    temperature: f32,
    #[serde(default = "default_num_predict")]
    num_predict: u32,
    #[serde(default)]
    skip: bool,
    #[serde(default)]
    programmatic: bool,
}

fn default_num_ctx() -> u32 { 8192 }
fn default_temperature() -> f32 { 0.3 }
fn default_num_predict() -> u32 { 4096 }

#[derive(Deserialize, Debug)]
#[serde(default)]
struct GuardrailConfig {
    max_diff_lines: usize,
    max_steps: u32,
    enable_localizer: bool,
    enable_minimizer: bool,
    enable_auto_test: bool,
}

impl Default for GuardrailConfig {
    fn default() -> Self {
        Self {
            max_diff_lines: 5,
            max_steps: 20,
            enable_localizer: true,
            enable_minimizer: true,
            enable_auto_test: true,
        }
    }
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


/// Find the extent of a function/class body around a grep hit.
/// If the hit is on or near a `def`/`class` line, walk indentation to find the full body.
/// Otherwise fall back to +/-15 line window.
fn find_function_body(lines: &[&str], hit_line: usize) -> (usize, usize) {
    let idx = hit_line.saturating_sub(1); // 0-indexed
    if idx >= lines.len() {
        return (hit_line.saturating_sub(10), hit_line + 15);
    }

    // Search nearby lines (hit ± 3) for a def/class statement
    let search_start = idx.saturating_sub(3);
    let search_end = (idx + 4).min(lines.len());
    let mut def_idx = None;

    for i in search_start..search_end {
        let trimmed = lines[i].trim_start();
        if trimmed.starts_with("def ") || trimmed.starts_with("class ")
            || trimmed.starts_with("async def ")
        {
            def_idx = Some(i);
            break;
        }
    }

    let def_idx = match def_idx {
        Some(d) => d,
        None => {
            // No function/class nearby — use fixed window
            return (hit_line.saturating_sub(10), hit_line + 15);
        }
    };

    // Walk forward from def to find end of body by indentation
    let def_indent = lines[def_idx].len() - lines[def_idx].trim_start().len();
    let mut body_end = def_idx + 1;

    for i in (def_idx + 1)..lines.len() {
        let l = lines[i];
        let trimmed = l.trim();
        // Skip empty lines and comments
        if trimmed.is_empty() || trimmed.starts_with('#') {
            body_end = i + 1;
            continue;
        }
        let indent = l.len() - trimmed.len();
        if indent <= def_indent {
            // Back to same or less indentation — function ended
            body_end = i;
            break;
        }
        body_end = i + 1;
    }

    // Cap at 200 lines to avoid dumping entire classes
    let max_body = 200;
    let end = body_end.min(def_idx + max_body);

    // 1-indexed for read_file
    (def_idx.saturating_sub(1) + 1, end)
}

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
                "allowed_tools": ["read_file", "list_directory", "grep", "edit_line", "edit_block", "patch_file", "apply_patch", "write_file", "insert_between"],
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
                "allowed_tools": ["read_file", "list_directory", "grep", "run_test", "edit_line", "edit_block", "patch_file", "apply_patch", "write_file", "insert_between", "diff"],
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
    native_hint: bool,
    localization: &str,
    reasoning: bool,
) -> String {
    let tools_list = allowed_tools.join(", ");
    let reasoning_directive = if reasoning {
        "Think step by step about what the bug is and why, then provide your action as a JSON object."
    } else {
        "Respond with ONLY a JSON object, no other text."
    };
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
    } else if native_hint {
        // Native tool calling: clean prompt without JSON format noise
        let state_guidance = match current_state {
            "planning" => "Read the code and test failures to understand the bug. Use grep and read_file with start_line/end_line for large files. When you understand the bug, transition to implementing.".to_string(),
            "implementing" => {
                let mut s = "You MUST edit the code to fix the bug. Call edit_line, edit_block, or insert_between now. Do NOT just read files — you already have the information you need. Make your edit, then transition with DONE.".to_string();
                // Surface assertion hints first (most actionable)
                if localization.contains("## Assertion Hints") {
                    if let Some(hints_start) = localization.find("## Assertion Hints") {
                        let hints = &localization[hints_start..];
                        let hints_lines: Vec<&str> = hints.lines().take(5).collect();
                        s.push_str("\n\n");
                        s.push_str(&hints_lines.join("\n"));
                    }
                }
                if !localization.is_empty() {
                    s.push_str("\n\nFrom bug localization:\n");
                    let loc_lines: Vec<&str> = localization.lines().take(40).collect();
                    s.push_str(&loc_lines.join("\n"));
                }
                s
            },
            "testing" => "Run the tests. If all pass, transition TESTS_PASS. If any fail, transition TESTS_FAIL.".to_string(),
            "review" => "Call diff to review your changes. If correct and minimal, transition APPROVED. Otherwise transition REJECTED.".to_string(),
            _ => instructions.to_string(),
        };
        format!(
r#"You fix bugs in code. You are in the "{current_state}" state.

TASK: {task}
WORKING DIRECTORY: {workdir}

{state_guidance}

{nav_section}"#,
            task = task,
            current_state = current_state,
            workdir = workdir,
            state_guidance = state_guidance,
            nav_section = nav_section,
        )
    } else {
        format!(
r#"You fix bugs step by step. {reasoning_directive}

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
- edit_line: args: {{"path": "filename", "old": "line to find", "new": "replacement"}} (finds by content). To INSERT a new line: {{"path": "filename", "line": 100, "new": "new code"}} (inserts after line 100)
- patch_file: args: {{"path": "filename", "patches": [{{"old": "old line", "new": "new line"}}]}}
- insert_between: args: {{"path": "filename", "after": "line to insert after", "new": "new code"}} optionally {{"before": "line before which to insert"}}

{nav_section}"#,
            task = task,
            current_state = current_state,
            instructions = instructions,
            workdir = workdir,
            tools_list = tools_list,
            nav_section = nav_section,
            reasoning_directive = reasoning_directive,
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

    // Resolve model profile from registry
    let registry = model_registry::ModelRegistry::builtin();
    let profile = registry.resolve(&args.model);

    // Load run config from file if provided (MCP gateway writes this)
    let run_config: RunConfig = if let Some(config_path) = &args.config {
        let config_str = std::fs::read_to_string(config_path)
            .unwrap_or_else(|e| panic!("Failed to read config {}: {}", config_path, e));
        serde_json::from_str(&config_str)
            .unwrap_or_else(|e| panic!("Failed to parse config {}: {}", config_path, e))
    } else {
        RunConfig::default()
    };

    // Config overrides CLI args
    let task = run_config.task.as_deref().unwrap_or(&args.task).to_string();
    let workdir = run_config.workdir.as_deref().unwrap_or(&args.workdir).to_string();
    let max_steps = if run_config.guardrails.max_steps > 0 { run_config.guardrails.max_steps } else { args.max_steps };

    // Helper: get OllamaClient for a given state (per-state model routing)
    let make_client_for_state = |state: &str| -> OllamaClient {
        if let Some(mc) = run_config.model_routing.get(state) {
            OllamaClient::new(OllamaConfig {
                api_url: mc.ollama_url.clone().unwrap_or_else(|| args.ollama_url.clone()),
                model: mc.model.clone().unwrap_or_else(|| args.model.clone()),
                temperature: mc.temperature,
                max_tokens: mc.num_predict,
            })
        } else {
            OllamaClient::new(OllamaConfig {
                api_url: args.ollama_url.clone(),
                model: args.model.clone(),
                temperature: 0.3,
                max_tokens: 4096,
            })
        }
    };

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

    // --- Single-state execution mode ---
    // The TUI orchestrates the workflow. sw-agent executes ONE state and exits.
    // e.g.: sw-agent --state implementing --workdir /path --task "Fix the bug" --json-events
    if let Some(target_state) = &args.state {
        let json_mode = args.json_events;
        let client = make_client_for_state(target_state);

        // Load context from file if provided
        let context_json: serde_json::Value = args.context_file.as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(json!({}));

        // Use workflow from config if provided, otherwise fall back to hardcoded machine
        let definition = run_config.workflow.unwrap_or_else(hardcoded_bug_fix_machine);
        let state_def = match definition.states.get(target_state.as_str()) {
            Some(s) => s,
            None => {
                eprintln!("State '{}' not found in workflow", target_state);
                std::process::exit(1);
            }
        };

        let allowed_tools = state_def.allowed_tools.as_ref().cloned().unwrap_or_default();
        let instructions = state_def.instructions.as_deref().unwrap_or("Proceed.");
        let transitions: Vec<(String, String)> = state_def.on.iter()
            .map(|(event, t)| (event.clone(), t.target().to_string()))
            .collect();

        let mut conversation: Vec<ChatMessage> = Vec::new();

        // Inject context as initial user message
        if context_json != json!({}) {
            conversation.push(ChatMessage {
                role: "user".into(),
                content: format!("Context from previous states:\n{}", serde_json::to_string_pretty(&context_json).unwrap_or_default()),
            });
        }

        let mut step = 0u32;
        let max_iter = state_def.max_iterations.unwrap_or(10);

        loop {
            step += 1;
            if step > max_iter {
                if json_mode {
                    events::emit_json(&TuiEvent::Completed { steps: step - 1, success: false });
                }
                eprintln!("Max iterations ({}) exceeded in state '{}'", max_iter, target_state);
                break;
            }

            let system_prompt = build_system_prompt(
                &task, target_state, instructions, &allowed_tools,
                &transitions, &workdir, false, Some(max_iter - step), false, "", false,
            );
            let mut messages = vec![ChatMessage { role: "system".into(), content: system_prompt }];
            // Single-state mode: fresh prompt each step (Rust harness parity)
            messages.push(ChatMessage { role: "user".into(), content: "Proceed with the next action.".into() });

            let raw_response = match client.chat(messages).await {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("LLM error: {}", e);
                    continue;
                }
            };

            // Parse response
            let resp: LlmResponse = match serde_json::from_str(&raw_response) {
                Ok(r) => r,
                Err(_) => {
                    // Try embedded JSON
                    let start = raw_response.find('{');
                    let end = raw_response.rfind('}');
                    match (start, end) {
                        (Some(s), Some(e)) if e > s => {
                            serde_json::from_str(&raw_response[s..=e]).unwrap_or(LlmResponse {
                                transition: None, error: None, tool_calls: None, reasoning: None,
                            })
                        }
                        _ => LlmResponse { transition: None, error: None, tool_calls: None, reasoning: None },
                    }
                }
            };

            // Handle transition — validate event against state's transition map
            if let Some(event) = &resp.transition {
                let rationale = resp.error.clone().or_else(|| resp.reasoning.clone());

                // Check if this is a valid event for this state
                if let Some((_, target_name)) = transitions.iter().find(|(e, _)| e == event) {
                    if json_mode {
                        events::emit_json(&TuiEvent::Transition {
                            from: target_state.clone(), to: target_name.clone(),
                            trigger: Some(event.clone()), rationale: rationale.clone(),
                        });
                        events::emit_json(&TuiEvent::Completed { steps: step, success: true });
                    } else {
                        println!("[TRANSITION] {} -> {} (event: {})", target_state, target_name, event);
                        if let Some(r) = &rationale {
                            println!("  rationale: {}", r);
                        }
                    }
                    break;
                } else {
                    // Invalid event — tell the model to pick a valid one
                    let valid_events: Vec<String> = transitions.iter()
                        .map(|(e, t)| format!("{} → {}", e, t))
                        .collect();
                    let rejection = format!(
                        "Invalid transition event '{}'. Valid transitions from '{}' are:\n  {}\nAnalyze your results and call transition with the CORRECT event name and a rationale explaining why.",
                        event, target_state, valid_events.join("\n  ")
                    );
                    if json_mode {
                        events::emit_json(&TuiEvent::GuardBlocked {
                            tool: format!("transition({})", event),
                            state: target_state.to_string(),
                        });
                    } else {
                        eprintln!("  [REJECTED] {}", rejection);
                    }
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: rejection,
                    });
                    // Don't break — let the model retry with a valid event
                }
            }

            // Handle tool calls
            if let Some(calls) = resp.tool_calls {
                for tc in &calls {
                    if json_mode {
                        events::emit_json(&TuiEvent::ToolCall {
                            name: tc.name.clone(),
                            args_preview: serde_json::to_string(&tc.args).unwrap_or_default(),
                        });
                    }

                    let result = tools::execute_tool(&tc.name, &tc.args, &workdir);

                    if json_mode {
                        events::emit_json(&TuiEvent::ToolResult {
                            name: tc.name.clone(),
                            result_preview: result.chars().take(500).collect(),
                        });
                    } else {
                        println!("  [TOOL] {}({}) -> {}", tc.name,
                            serde_json::to_string(&tc.args).unwrap_or_default().chars().take(60).collect::<String>(),
                            result.chars().take(200).collect::<String>());
                    }

                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!("=== {} result ===\n{}", tc.name, result),
                    });
                }
            }
        }

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

    let json_mode = args.json_events;
    // emit: send a TuiEvent as JSONL if --json-events, otherwise pretty-print
    macro_rules! emit {
        ($event:expr) => {
            if json_mode { events::emit_json(&$event); }
        };
        ($event:expr, $pretty:expr) => {
            if json_mode { events::emit_json(&$event); } else { println!("{}", $pretty); }
        };
    }

    if !json_mode {
        println!("\n=== Statewright Agent ===\n");
        println!("Task: {}", task);
        println!("Working dir: {}", workdir);
        println!("Model: {}", args.model);
        println!();
    }

    // Snapshot and restore: save all files before the run, restore on exit
    let workdir_for_restore = workdir.clone();
    let originals = tools::snapshot_all(&workdir);
    let original_count = originals.len();
    emit!(TuiEvent::Setup { files_snapshotted: original_count }, format!("[Setup] Snapshotted {} file(s) for auto-restore\n", original_count));

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
    if !json_mode { println!("[Phase 2] Executing agent within state machine constraints\n"); }

    // Default client (used when no per-state routing configured)
    // Escalation model (env override or default to gpt-oss:20b)
    let escalation_url = std::env::var("SW_ESCALATION_URL")
        .unwrap_or_else(|_| "https://gpt-oss-20b.ollama.casa.enhasa.cloud/v1".into());
    let escalation_model = std::env::var("SW_ESCALATION_MODEL")
        .unwrap_or_else(|_| "gpt-oss:20b".into());

    let base_client = OllamaClient::new(OllamaConfig {
        api_url: args.ollama_url.clone(),
        model: args.model.clone(),
        temperature: 0.3,
        max_tokens: 4096,
    });
    let escalation_client = OllamaClient::new(OllamaConfig {
        api_url: escalation_url.clone(),
        model: escalation_model.clone(),
        temperature: 0.3,
        max_tokens: 4096,
    });

    let mut current_state = definition.initial.clone();
    let mut context = definition.context.clone();
    let mut step = 0u32;
    let mut steps_in_current_state = 0u32;

    // Conversation history — the model sees its own previous turns
    let mut conversation: Vec<ChatMessage> = Vec::new();

    // Escalation ladder: track failed edit attempts in implementing
    // Level 0: fast (no reasoning) → Level 1: reasoning → Level 2: bigger model → Level 3: bigger + reasoning
    let mut edit_fail_count = 0u32;
    let mut reasoning_mode = false;
    let mut escalated_model = false;

    // Read dedup: track file reads to avoid re-injecting full content
    // Key: (tool_name, canonical_args), Value: (step_number, result)
    let mut read_cache: HashMap<String, (u32, String)> = HashMap::new();
    // Track which files have been modified (edits invalidate cache)
    let mut modified_files: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Model profile drives these — no more hardcoded size thresholds
    let history_window = profile.history_window;
    let max_full_read_lines = profile.max_full_read_lines;

    // Localized regions from programmatic recon — used by context cap to suggest ranges
    // Key: filename, Value: vec of (line_num, pattern) from grep hits
    let mut localized_regions: HashMap<String, Vec<(usize, String)>> = HashMap::new();

    // Localization summary — re-injected into implementing prompt for re-grounding
    let mut localization_summary = String::new();

    loop {
        step += 1;
        steps_in_current_state += 1;

        // Per-state model routing or escalation-driven model selection
        let client = if run_config.model_routing.contains_key(&current_state) {
            make_client_for_state(&current_state)
        } else if escalated_model {
            escalation_client.clone()
        } else {
            base_client.clone()
        };

        // Don't abort during testing/review — these are quick programmatic steps
        // that shouldn't count against the LLM's step budget
        let in_endgame = current_state == "testing" || current_state == "review" || current_state == "completed";
        if step > max_steps && !in_endgame {
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
                emit!(TuiEvent::Completed { steps: step - 1, success: true }, format!("\n=== COMPLETED in {} steps ===", step - 1));
            } else {
                emit!(TuiEvent::Completed { steps: step - 1, success: false }, format!("\n=== FAILED ({}) after {} steps ===", current_state, step - 1));
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

                // Extract keywords from the task AND test output to grep for
                let task_lower = args.task.to_lowercase();
                let mut grep_patterns: Vec<String> = Vec::new();

                // Extract identifiers from the task: words with underscores or camelCase
                for word in args.task.split_whitespace() {
                    let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                    if clean.contains('_') && clean.len() > 3 {
                        grep_patterns.push(clean.to_string());
                    }
                }

                // Extract function/class names from test failures (e.g. "test_foo" → grep for "foo")
                for line in test_summary.lines() {
                    for word in line.split_whitespace() {
                        let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                        if clean.starts_with("test_") {
                            let without_test = &clean[5..];
                            if without_test.len() > 3 {
                                grep_patterns.push(without_test.to_string());
                            }
                        }
                    }
                }

                // Extract assertion targets from test output
                for line in test_output.lines() {
                    if line.contains("assert") {
                        for word in line.split_whitespace() {
                            let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != '.');
                            if clean.contains('_') && clean.len() > 3 && !clean.starts_with("assert") {
                                grep_patterns.push(clean.to_string());
                            }
                        }
                    }
                }

                // Deduplicate and fallback
                grep_patterns.sort();
                grep_patterns.dedup();
                if grep_patterns.is_empty() { grep_patterns.push("def ".to_string()); }

                let mut localized_code = String::new();

                // Find source files (not test files)
                let source_files: Vec<&str> = files.lines()
                    .filter(|f| f.ends_with(".py") && !f.starts_with("test_") && !f.contains("__"))
                    .collect();

                for src_file in &source_files {
                    let file_content = std::fs::read_to_string(
                        std::path::Path::new(&args.workdir).join(src_file)
                    ).unwrap_or_default();
                    let file_lines: Vec<&str> = file_content.lines().collect();

                    // Track function bodies we've already extracted (avoid duplicates)
                    let mut extracted_ranges: Vec<(usize, usize)> = Vec::new();

                    for pattern in &grep_patterns {
                        let grep_result = tools::execute_tool(
                            "grep",
                            &json!({"pattern": pattern, "file": src_file}),
                            &args.workdir,
                        );
                        if grep_result != "no matches found" {
                            for line in grep_result.lines().take(5) {
                                if let Some(line_num_str) = line.split(':').nth(1) {
                                    if let Ok(line_num) = line_num_str.trim().parse::<usize>() {
                                        // Skip if this line is already within an extracted range
                                        if extracted_ranges.iter().any(|(s, e)| line_num >= *s && line_num <= *e) {
                                            continue;
                                        }

                                        // Store for context cap suggestions
                                        localized_regions.entry(src_file.to_string())
                                            .or_default()
                                            .push((line_num, pattern.to_string()));

                                        // Level 1: Find the function body containing this hit
                                        let (func_start, func_end) = find_function_body(&file_lines, line_num);
                                        extracted_ranges.push((func_start, func_end));

                                        // Strip docstrings from function body for cleaner context
                                        let mut stripped_body: Vec<(usize, &str)> = Vec::new();
                                        let mut in_docstring = false;
                                        for i in func_start.saturating_sub(1)..func_end.min(file_lines.len()) {
                                            let trimmed = file_lines[i].trim();
                                            let triple_count = trimmed.matches("\"\"\"").count()
                                                + trimmed.matches("'''").count();
                                            if triple_count >= 2 {
                                                // Single-line docstring — skip it
                                                continue;
                                            }
                                            if triple_count == 1 {
                                                in_docstring = !in_docstring;
                                                continue;
                                            }
                                            if in_docstring { continue; }
                                            stripped_body.push((i + 1, file_lines[i])); // 1-indexed
                                        }

                                        // Level 2: Within the stripped body, find the hotspot
                                        let test_keywords: Vec<&str> = test_summary.split_whitespace()
                                            .filter(|w| w.len() > 3)
                                            .collect();
                                        let mut hotspot_line = line_num;
                                        let mut best_score = 0usize;
                                        for (ln, content) in &stripped_body {
                                            let score = test_keywords.iter()
                                                .filter(|kw| content.to_lowercase().contains(&kw.to_lowercase()))
                                                .count();
                                            if score > best_score {
                                                best_score = score;
                                                hotspot_line = *ln;
                                            }
                                        }

                                        // Present a focused window:
                                        // - Small function (<60 lines): show all
                                        // - Large function + hotspot found: 40 lines centered on hotspot
                                        // - Large function + no hotspot: show full body (capped at 150 lines)
                                        let func_len = func_end - func_start;
                                        let (show_start, show_end) = if func_len <= 60 {
                                            (func_start, func_end)
                                        } else if best_score >= 3 {
                                            let center = hotspot_line;
                                            let half = 20;
                                            let s = center.saturating_sub(half).max(func_start);
                                            let e = (s + 40).min(func_end);
                                            (s, e)
                                        } else {
                                            // No hotspot — show full function body, the bug could be anywhere
                                            (func_start, func_end.min(func_start + 150))
                                        };

                                        // Present stripped body (implementation only, docstrings removed)
                                        let context_lines: Vec<String> = stripped_body.iter()
                                            .filter(|(ln, _)| *ln >= show_start && *ln <= show_end)
                                            .map(|(ln, content)| format!("{:>4}: {}", ln, content))
                                            .collect();
                                        let context = if context_lines.is_empty() {
                                            tools::execute_tool(
                                                "read_file",
                                                &json!({"path": src_file, "start_line": show_start, "end_line": show_end}),
                                                &args.workdir,
                                            )
                                        } else {
                                            format!("({} lines, docstrings stripped)\n{}",
                                                context_lines.len(), context_lines.join("\n"))
                                        };
                                        if !localized_code.contains(&context) {
                                            localized_code.push_str(&format!(
                                                "\n=== {} function at L{} ===\n{}\n",
                                                src_file, func_start, context
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

                // Save localization for re-grounding in implementing state
                // Extract assertion hints: if test says assert "X" in Y, X is what the code needs
                let mut assertion_hints = Vec::new();
                for line in test_output.lines() {
                    let trimmed = line.trim();
                    // Match: assert "some code" in variable
                    if trimmed.contains("assert") && trimmed.contains("\" in ") {
                        // Extract the quoted string
                        if let Some(start) = trimmed.find('"') {
                            if let Some(end) = trimmed[start+1..].find('"') {
                                let hint = &trimmed[start+1..start+1+end];
                                if hint.len() > 3 && !hint.contains("assert") {
                                    assertion_hints.push(hint.to_string());
                                }
                            }
                        }
                    }
                    // Match: AssertionError: message containing "code"
                    if trimmed.starts_with("AssertionError:") || trimmed.starts_with("AssertionError:") {
                        for word in trimmed.split('"') {
                            let w = word.trim();
                            if w.contains('=') || w.contains('(') || w.contains('.') {
                                if w.len() > 3 {
                                    assertion_hints.push(w.to_string());
                                }
                            }
                        }
                    }
                }
                assertion_hints.sort();
                assertion_hints.dedup();

                let hint_section = if !assertion_hints.is_empty() {
                    format!("\n\n## Assertion Hints\nThe test expects this code to exist in the source:\n{}\nUse insert_between or edit_line to add the missing code.",
                        assertion_hints.iter().map(|h| format!("  - `{}`", h)).collect::<Vec<_>>().join("\n"))
                } else {
                    String::new()
                };

                localization_summary = format!(
                    "## Test Failures\n{}\n\n## Relevant Code\n{}{}",
                    test_summary, localized_code, hint_section
                );

                // Feed everything into conversation for the planning state
                conversation.push(ChatMessage {
                    role: "user".into(),
                    content: format!(
                        "Bug localization results:\n\n{}\n\nAnalyze these code sections to find the bug described in the task.",
                        localization_summary
                    ),
                });

                // Transition to planning
                let from = current_state.clone();
                current_state = "planning".into();
                steps_in_current_state = 0;
                emit!(TuiEvent::Transition { from: from, to: "planning".into(), trigger: Some("LOCALIZED".into()), rationale: Some("Programmatic localization complete".into()) }, "  [TRANSITION] localizing -> planning");
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
                    emit!(TuiEvent::AutoTest { passed: true, fail_count: 0 }, "  [AUTO-TEST] ALL PASSED");
                    // Show what changed
                    let changed = tools::all_diff_stats(&args.workdir);
                    for (file, lines_changed, total) in &changed {
                        emit!(TuiEvent::DiffStats { file: file.clone(), changed: *lines_changed, total: *total },
                            format!("  Changes: {} ({}/{} lines modified)", file, lines_changed, total));
                    }
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!("Tests ran automatically and ALL PASSED:\n{}\n\nProceeding to review.", test_result),
                    });
                    emit!(TuiEvent::Transition { from: "testing".into(), to: "review".into(), trigger: Some("TESTS_PASS".into()), rationale: Some("All tests passed".into()) }, "  [TRANSITION] testing -> review");
                    current_state = "review".into();
                    steps_in_current_state = 0;
                    continue;
                } else {
                    emit!(TuiEvent::AutoTest { passed: false, fail_count: fail_count.parse().unwrap_or(1) },
                        format!("  [AUTO-TEST] {} failing — returning to implementing", fail_count));
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

        // Determine tool calling mode — use escalation model's profile when escalated
        let active_profile = if escalated_model {
            registry.resolve(&escalation_model)
        } else {
            profile.clone()
        };
        let use_native = match args.tool_mode.as_str() {
            "native" => true,
            "raw" => false,
            _ => match active_profile.tool_mode {
                model_registry::ToolMode::Native => true,
                model_registry::ToolMode::Raw => false,
                model_registry::ToolMode::Auto => !is_checkpoint,
            },
        };

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
            use_native,
            &localization_summary,
            reasoning_mode,
        );

        let mut messages = vec![ChatMessage {
            role: "system".into(),
            content: system,
        }];

        // Add conversation history (window scaled by model size)
        let history_start = conversation.len().saturating_sub(history_window);
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
                        iters_remaining, false, &localization_summary, reasoning_mode,
                    );
                    let mut msgs = vec![ChatMessage { role: "system".into(), content: system }];
                    let hs = conversation.len().saturating_sub(history_window);
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

            emit!(TuiEvent::ToolCall {
                name: tool_name.clone(),
                args_preview: truncate_json(tool_args, 200),
            });

            // Read dedup: if this is an unranged read_file for a file we already read
            // and haven't modified since, return a cached summary instead of full content
            let is_read = tool_name == "read_file";
            let is_ranged_read = is_read && (tool_args.get("start_line").is_some() || tool_args.get("line_start").is_some());
            let cache_key = format!("{}:{}", tool_name, serde_json::to_string(tool_args).unwrap_or_default());
            let read_path = tool_args.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string();

            let result = if is_read && !is_ranged_read && !modified_files.contains(&read_path) {
                if let Some((prev_step, prev_result)) = read_cache.get(&cache_key) {
                    let line_count = prev_result.lines().count();
                    let summary = format!(
                        "(cached — already read in step {}, {} lines, unchanged)\n\
                         Use start_line/end_line to re-read specific sections, or make your edit based on the content you already have.",
                        prev_step, line_count
                    );
                    if !json_mode {
                        println!("  [DEDUP] {}({}) -> cached from step {}", tool_name,
                            truncate_json(tool_args, 60), prev_step);
                    }
                    summary
                } else {
                    // Pre-check file size before reading — block if too large
                    let full_path = std::path::Path::new(&args.workdir).join(&read_path);
                    let line_count = std::fs::read_to_string(&full_path)
                        .map(|c| c.lines().count())
                        .unwrap_or(0);

                    if line_count > max_full_read_lines {
                        // BLOCK: file too large for full read. Suggest ranges from localization.
                        if !json_mode {
                            println!("  [CONTEXT CAP] BLOCKED: {} is {} lines (max {} for this model) — use ranged read",
                                read_path, line_count, max_full_read_lines);
                        }
                        let mut suggestion = format!(
                            "BLOCKED: '{}' is {} lines — too large for full read (max {} lines for this model).\n",
                            read_path, line_count, max_full_read_lines
                        );
                        // Add specific range suggestions from localization data
                        if let Some(regions) = localized_regions.get(&read_path) {
                            suggestion.push_str("Relevant sections from bug localization:\n");
                            for (line_num, pattern) in regions {
                                let start = line_num.saturating_sub(5);
                                let end = line_num + 10;
                                suggestion.push_str(&format!(
                                    "  - '{}' at line {} → use read_file with start_line={}, end_line={}\n",
                                    pattern, line_num, start, end
                                ));
                            }
                            suggestion.push_str("Use one of these ranges, or use grep to find other sections.");
                        } else {
                            suggestion.push_str("Use grep to find the section you need, then read_file with start_line/end_line.");
                        }
                        suggestion
                    } else {
                        let r = tools::execute_tool(tool_name, tool_args, &args.workdir);
                        read_cache.insert(cache_key.clone(), (step, r.clone()));
                        r
                    }
                }
            } else if is_read && !is_ranged_read {
                // Even for modified files, block full reads of large files
                let full_path = std::path::Path::new(&args.workdir).join(&read_path);
                let line_count = std::fs::read_to_string(&full_path)
                    .map(|c| c.lines().count())
                    .unwrap_or(0);
                if line_count > max_full_read_lines {
                    if !json_mode {
                        println!("  [CONTEXT CAP] BLOCKED: {} is {} lines (max {}) — use ranged read",
                            read_path, line_count, max_full_read_lines);
                    }
                    format!(
                        "BLOCKED: '{}' is {} lines — too large. Use read_file with start_line/end_line, or grep to find sections.",
                        read_path, line_count
                    )
                } else {
                    let r = tools::execute_tool(tool_name, tool_args, &args.workdir);
                    read_cache.insert(cache_key.clone(), (step, r.clone()));
                    r
                }
            } else {
                tools::execute_tool(tool_name, tool_args, &args.workdir)
            };

            // Track file modifications to invalidate read cache
            let is_edit = tool_name.contains("edit") || tool_name.contains("patch")
                || tool_name == "write_file" || tool_name == "apply_patch";
            let edit_succeeded = is_edit && !result.contains("error") && !result.contains("not found");
            if edit_succeeded {
                // Mark the file as modified so future reads aren't cached
                if let Some(path) = tool_args.get("path").and_then(|p| p.as_str()) {
                    modified_files.insert(path.to_string());
                    // Invalidate any cached reads for this file
                    read_cache.retain(|k, _| !k.contains(path));
                }
            }

            // Post-edit auto-test: if an edit landed in implementing, run tests immediately.
            // Pass → short-circuit to completed. Fail + oversized → restore and restrict.
            if edit_succeeded && current_state == "implementing" {
                let test_result = tools::execute_tool("run_test", &serde_json::json!({}), &args.workdir);
                let all_pass = test_result.contains("passed") && !test_result.contains("FAILED")
                    && !test_result.contains("failed") && !test_result.contains("error");
                let changed = tools::all_diff_stats(&args.workdir);
                if all_pass {
                    let diff_summary: Vec<String> = changed.iter()
                        .map(|(f, c, t)| format!("{} ({}/{} lines)", f, c, t))
                        .collect();
                    println!("  [AUTO-TEST] PASS — short-circuiting to completed");
                    println!("  Changes: {}", diff_summary.join(", "));
                    emit!(TuiEvent::Transition { from: "implementing".into(), to: "completed".into(),
                        trigger: Some("AUTO_COMPLETE".into()),
                        rationale: Some("Edit + tests pass".into()) },
                        "  [TRANSITION] implementing -> completed (auto)");
                    current_state = "completed".into();
                    break;
                } else {
                    // Tests failed — if edit was oversized, restore and constrain
                    let oversized = changed.iter().any(|(_, c, _)| *c > profile.max_diff_lines);
                    if oversized {
                        println!("  [AUTO-TEST] FAIL + oversized edit — restoring snapshot");
                        tools::restore_snapshot(&args.workdir);
                        modified_files.clear();
                        read_cache.clear();
                        tool_output.push_str("Tests FAILED and your edit changed too many lines. Snapshot restored. Use edit_line for small, targeted changes. You can make multiple small edits — each one is tested automatically.\n");
                    } else {
                        // Small edit, tests failed — keep the edit, let model iterate
                        println!("  [AUTO-TEST] FAIL — edit kept, model can refine");
                        tool_output.push_str(&format!("Tests FAILED after your edit. Fix the remaining issue.\n{}\n",
                            test_result.lines().filter(|l| l.contains("FAILED") || l.contains("Error") || l.contains("assert")).take(5).collect::<Vec<_>>().join("\n")));
                    }
                    // Count failed edit for unified escalation (checked after tool loop)
                    edit_fail_count += 1;
                }
            }

            emit!(TuiEvent::ToolResult {
                name: tool_name.clone(),
                result_preview: truncate(&result, 500),
            });

            // Escape newlines for edit/patch results so TUI can parse diffs on one line
            // Don't escape read_file results — they're huge and only shown truncated
            let display_result = if is_edit {
                result.replace('\n', "\\n")
            } else {
                result.replace('\n', " ")
            };
            if !json_mode {
                println!("  [TOOL] {}({}) -> {}", tool_name,
                    truncate_json(tool_args, 60), truncate(&display_result, 300));
            }
            tool_output.push_str(&format!("=== {} result ===\n{}\n", tool_name, result));
        }

        if !tool_output.is_empty() {
            conversation.push(ChatMessage {
                role: "user".into(),
                content: format!("Tool results:\n{}", tool_output),
            });
        }

        // Escalation: also count non-edit implementing steps as stalls
        if current_state == "implementing" {
            let any_edit_this_step = tool_calls_to_process.iter()
                .any(|(name, _)| name.contains("edit") || name.contains("patch") || name == "write_file");
            if !any_edit_this_step {
                edit_fail_count += 1;
            }
            // Unified escalation check (fires from both auto-test failures and stalls)
            if edit_fail_count >= 2 && !reasoning_mode && !escalated_model {
                reasoning_mode = true;
                println!("  [ESCALATE] Level 1: reasoning mode (fail_count={})", edit_fail_count);
                conversation.clear();
            } else if edit_fail_count >= 4 && !escalated_model {
                escalated_model = true;
                reasoning_mode = false;
                println!("  [ESCALATE] Level 2: switching to {} (fail_count={})", escalation_model, edit_fail_count);
                conversation.clear();
                tools::restore_snapshot(&args.workdir);
                modified_files.clear();
            } else if edit_fail_count >= 6 && escalated_model && !reasoning_mode {
                reasoning_mode = true;
                println!("  [ESCALATE] Level 3: {} + reasoning (fail_count={})", escalation_model, edit_fail_count);
                conversation.clear();
            }
        }

        // Handle transition
        if let Some(raw_event) = &transition_event {
            // Sanitize: model might output "DONE -> testing" instead of "DONE"
            let event = raw_event.split_whitespace().next().unwrap_or(raw_event).trim();

            if event == "FAIL" {
                // Intercept FAIL: escalate instead of giving up if escalation is available
                if !escalated_model {
                    edit_fail_count = 4; // Force Level 2
                    escalated_model = true;
                    reasoning_mode = false;
                    println!("  [FAIL → ESCALATE] Model gave up — switching to {}", escalation_model);
                    conversation.clear();
                    tools::restore_snapshot(&args.workdir);
                    modified_files.clear();
                    continue;
                }
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
                        emit!(TuiEvent::Transition { from: current_state.clone(), to: result.new_state.clone(), trigger: transition_event.clone(), rationale: None },
                            format!("  [TRANSITION] {} -> {}", current_state, result.new_state));
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

                            if *changed > profile.max_diff_lines && *total > 0 {
                                println!("  [MINIMIZER] REJECTED — {} changed {} lines (max {}). Restoring and retrying.",
                                    file, changed, profile.max_diff_lines);
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
                                        changed, profile.max_diff_lines, diff_detail
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

                    emit!(TuiEvent::Transition { from: current_state.clone(), to: result.new_state.clone(), trigger: transition_event.clone(), rationale: None },
                        format!("  [TRANSITION] {} -> {}", current_state, result.new_state));
                    current_state = result.new_state;
                    context = result.new_context;
                    steps_in_current_state = 0;
                    // Reset per-state caches
                    read_cache.clear();
                    modified_files.clear();
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
