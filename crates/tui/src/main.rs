mod events;
mod ui;

use std::process::Stdio;
use std::time::Duration;

use clap::Parser;
use crossterm::event::{Event as CEvent, EventStream, KeyCode};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

use events::{StateInfo, TuiEvent};
use ui::App;

#[derive(Parser)]
#[command(
    name = "statewright",
    about = "Watch a small LLM fix bugs within state machine guardrails"
)]
struct Args {
    /// Task description
    #[arg(short, long, default_value = "Fix the failing test")]
    task: String,

    /// Working directory with the buggy code
    #[arg(short, long, default_value = "crates/cli/fixtures/buggy-calc")]
    workdir: String,

    /// Ollama API URL
    #[arg(long, default_value = "http://localhost:11434/v1")]
    ollama_url: String,

    /// Model name
    #[arg(long, default_value = "gemma4:31b")]
    model: String,

    /// Tool calling mode (raw, native, auto)
    #[arg(long, default_value = "raw")]
    tool_mode: String,

    /// Max steps
    #[arg(long, default_value = "25")]
    max_steps: u32,

    /// Use control mode (no guardrails)
    #[arg(long)]
    control: bool,

    /// Plain text output (no TUI)
    #[arg(long)]
    plain: bool,

    /// Demo mode: slow down output for presentation (delay in ms between events)
    #[arg(long)]
    demo: Option<u64>,

    /// Interactive demo chooser — pick a fixture to run
    #[arg(long)]
    demo_menu: bool,
}

enum AppEvent {
    Input(CEvent),
    EngineLine(String),
    EngineDone,
}

fn find_sw_agent() -> String {
    let self_exe = std::env::current_exe().unwrap_or_default();
    let self_dir = self_exe.parent().unwrap_or(std::path::Path::new("."));
    let sw_agent = self_dir.join("sw-agent");
    if sw_agent.exists() {
        sw_agent.to_string_lossy().to_string()
    } else {
        "sw-agent".to_string()
    }
}

struct DemoChoice {
    task: String,
    workdir: String,
    demo_delay: Option<Duration>,
}

/// Embedded fixture files for demo mode
fn get_demo_fixtures() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        (
            "buggy-calc",
            "Fix the failing test in test_calc.py by finding and fixing the bug in calc.py",
            "crates/cli/fixtures/buggy-calc",
        ),
        (
            "sympy-22914",
            include_str!("../../cli/fixtures/sympy-22914/ISSUE.md"),
            "crates/cli/fixtures/sympy-22914",
        ),
        (
            "requests-1963",
            include_str!("../../cli/fixtures/requests-1963/ISSUE.md"),
            "crates/cli/fixtures/requests-1963",
        ),
        (
            "pytest-5262",
            include_str!("../../cli/fixtures/pytest-5262/ISSUE.md"),
            "crates/cli/fixtures/pytest-5262",
        ),
        (
            "sympy-21847",
            include_str!("../../cli/fixtures/sympy-21847/ISSUE.md"),
            "crates/cli/fixtures/sympy-21847",
        ),
    ]
}

async fn run_demo_menu(args: &Args) -> anyhow::Result<Option<DemoChoice>> {
    let mut terminal = ratatui::init();
    let mut selected: usize = 0;

    loop {
        terminal.draw(|f| ui::render_menu(f, selected))?;

        if let Ok(CEvent::Key(k)) = crossterm::event::read() {
            let max_idx = get_demo_fixtures().len() - 1;
            match k.code {
                KeyCode::Char('q') | KeyCode::Esc => {
                    ratatui::restore();
                    return Ok(None);
                }
                KeyCode::Up | KeyCode::Char('k') => {
                    if selected > 0 {
                        selected -= 1;
                    }
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    if selected < max_idx {
                        selected += 1;
                    }
                }
                KeyCode::Char(c) if c.is_ascii_digit() => {
                    let idx = (c as usize) - ('1' as usize);
                    if idx <= max_idx {
                        selected = idx;
                    }
                }
                KeyCode::Enter => {
                    ratatui::restore();
                    let fixtures = get_demo_fixtures();
                    let (_, task, workdir) = fixtures[selected];
                    let delay = if selected == 0 {
                        Some(Duration::from_millis(300)) // simple: slow for presentation
                    } else {
                        None // SWE-bench: full speed
                    };
                    return Ok(Some(DemoChoice {
                        task: task.to_string(),
                        workdir: workdir.to_string(),
                        demo_delay: delay,
                    }));
                }
                _ => {}
            }
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = Args::parse();

    if args.plain {
        return run_plain(&args).await;
    }

    // Demo menu: choose a fixture interactively
    if args.demo_menu {
        match run_demo_menu(&args).await? {
            Some(choice) => {
                args.task = choice.task;
                args.workdir = choice.workdir;
                args.demo = choice.demo_delay.map(|d| d.as_millis() as u64);
            }
            None => return Ok(()), // user quit
        }
    }

    let demo_delay = args.demo.map(Duration::from_millis);

    let mut terminal = ratatui::init();
    let (tx, mut rx) = mpsc::unbounded_channel::<AppEvent>();

    // Spawn crossterm input reader
    let input_tx = tx.clone();
    tokio::spawn(async move {
        use futures_lite::StreamExt;
        let mut reader = EventStream::new();
        while let Some(Ok(ev)) = reader.next().await {
            if input_tx.send(AppEvent::Input(ev)).is_err() {
                break;
            }
        }
    });

    // Spawn sw-agent as subprocess
    let engine_tx = tx.clone();
    let task = args.task.clone();
    // Make workdir absolute so subprocess doesn't depend on CWD
    let workdir = std::path::Path::new(&args.workdir)
        .canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from(&args.workdir))
        .to_string_lossy()
        .to_string();
    let ollama_url = args.ollama_url.clone();
    let model = args.model.clone();
    let tool_mode = args.tool_mode.clone();
    let max_steps = args.max_steps;
    let control = args.control;

    tokio::spawn(async move {
        let sw_demo_path = find_sw_agent();
        let mut cmd = tokio::process::Command::new(&sw_demo_path);
        if control {
            cmd.arg("--control");
        } else {
            cmd.arg("--use-hardcoded-machine");
        }
        cmd.args([
            "--task",
            &task,
            "--workdir",
            &workdir,
            "--ollama-url",
            &ollama_url,
            "--model",
            &model,
            "--tool-mode",
            &tool_mode,
            "--max-steps",
            &max_steps.to_string(),
            "--log",
        ]);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.stdin(Stdio::null()); // Disconnect stdin — raw mode would confuse the child

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = engine_tx.send(AppEvent::EngineLine(format!(
                    "[ERROR] Failed to spawn sw-agent: {}",
                    e
                )));
                let _ = engine_tx.send(AppEvent::EngineDone);
                return;
            }
        };

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        // Drain stderr in background, forward as events
        let stderr_tx = engine_tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                // Skip compiler warnings
                let trimmed = line.trim();
                if trimmed.starts_with("warning:")
                    || trimmed.starts_with("Compiling")
                    || trimmed.starts_with("Finished")
                    || trimmed.starts_with("Running")
                    || trimmed.is_empty()
                    || trimmed.starts_with("-->")
                    || trimmed.starts_with("|")
                    || trimmed.starts_with("=")
                {
                    continue;
                }
                let _ = stderr_tx.send(AppEvent::EngineLine(format!("[STDERR] {}", line)));
            }
        });

        let mut reader = BufReader::new(stdout).lines();

        while let Ok(Some(line)) = reader.next_line().await {
            if engine_tx.send(AppEvent::EngineLine(line)).is_err() {
                break;
            }
        }

        match child.wait().await {
            Ok(status) => {
                let _ = engine_tx.send(AppEvent::EngineLine(format!(
                    "[ENGINE] process exited with: {}",
                    status
                )));
            }
            Err(e) => {
                let _ = engine_tx.send(AppEvent::EngineLine(format!("[ENGINE] wait error: {}", e)));
            }
        }
        let _ = engine_tx.send(AppEvent::EngineDone);
    });

    let mut app = App::default();
    // Collect state machine definition lines as they arrive
    let mut in_machine_block = false;
    let mut machine_lines: Vec<String> = Vec::new();

    loop {
        terminal.draw(|f| ui::render(f, &app))?;

        // Use try_recv in a loop to drain multiple events per frame,
        // then block on recv when empty
        let event = if app.finished {
            // After completion, only listen for input (quit)
            rx.recv().await
        } else {
            rx.recv().await
        };

        match event {
            Some(AppEvent::Input(CEvent::Key(k))) => match k.code {
                KeyCode::Char('q') | KeyCode::Esc => break,
                KeyCode::Up | KeyCode::Char('k') => app.scroll_up(),
                KeyCode::Down | KeyCode::Char('j') => app.scroll_down(),
                KeyCode::PageUp => app.page_up(),
                KeyCode::PageDown => app.page_down(),
                KeyCode::Home | KeyCode::Char('g') => app.scroll_top(),
                KeyCode::End | KeyCode::Char('G') => app.scroll_bottom(),
                _ => {}
            },
            Some(AppEvent::EngineLine(line)) => {
                let trimmed = line.trim().to_string();

                // Collect state machine definition block
                if trimmed == "--- State Machine ---" {
                    in_machine_block = true;
                    machine_lines.clear();
                    continue;
                }
                if in_machine_block {
                    if trimmed == "---" {
                        in_machine_block = false;
                        let states = parse_machine_block(&machine_lines);
                        app.apply(TuiEvent::MachineLoaded { states });
                        if let Some(delay) = demo_delay {
                            tokio::time::sleep(delay).await;
                        }
                        continue;
                    }
                    machine_lines.push(trimmed);
                    continue;
                }

                // Skip noisy lines
                if trimmed.is_empty()
                    || trimmed.starts_with("warning:")
                    || trimmed.starts_with("Compiling")
                    || trimmed.starts_with("Finished")
                    || trimmed.starts_with("Running")
                    || trimmed.starts_with("=== Statewright")
                    || trimmed.starts_with("Task:")
                    || trimmed.starts_with("Working dir:")
                    || trimmed.starts_with("Model:")
                    || trimmed.starts_with("[Restore]")
                    // Pytest output noise — but only for UNTAGGED lines
                    // Tagged lines ([TOOL], [LLM], etc.) are handled by the parser
                    || (!trimmed.starts_with('[') && is_pytest_noise(&trimmed))
                {
                    continue;
                }

                let event = parse_engine_line(&trimmed);

                // Demo delay for visible events
                if let Some(delay) = demo_delay {
                    let should_delay = matches!(
                        event,
                        TuiEvent::StepStarted { .. }
                            | TuiEvent::ToolCall { .. }
                            | TuiEvent::ToolResult { .. }
                            | TuiEvent::GuardBlocked { .. }
                            | TuiEvent::Transition { .. }
                            | TuiEvent::AutoTest { .. }
                            | TuiEvent::DiffStats { .. }
                            | TuiEvent::MinimizerRejected { .. }
                            | TuiEvent::EditGateBlocked
                            | TuiEvent::Completed { .. }
                            | TuiEvent::AgentFailed { .. }
                            | TuiEvent::Aborted { .. }
                    );
                    app.apply(event);
                    if should_delay {
                        // Render before sleeping so the event is visible
                        terminal.draw(|f| ui::render(f, &app))?;
                        tokio::time::sleep(delay).await;
                    }
                } else {
                    app.apply(event);
                }
            }
            Some(AppEvent::EngineDone) => {
                if app.success.is_none() {
                    app.status = "engine process exited".into();
                    app.finished = true;
                }
            }
            None => break,
            _ => {}
        }
    }

    ratatui::restore();
    Ok(())
}

/// Run in plain text mode (just exec sw-agent directly)
async fn run_plain(args: &Args) -> anyhow::Result<()> {
    let sw_demo_path = find_sw_agent();
    let mut cmd = std::process::Command::new(&sw_demo_path);
    if args.control {
        cmd.arg("--control");
    } else {
        cmd.arg("--use-hardcoded-machine");
    }
    cmd.args([
        "--task",
        &args.task,
        "--workdir",
        &args.workdir,
        "--ollama-url",
        &args.ollama_url,
        "--model",
        &args.model,
        "--tool-mode",
        &args.tool_mode,
        "--max-steps",
        &args.max_steps.to_string(),
    ]);
    let status = cmd.status()?;
    std::process::exit(status.code().unwrap_or(1));
}

/// Parse the state machine definition block into StateInfo structs.
/// Input lines look like:
///   "  completed [tools: (none)]"
///   "    DONE -> testing"
///   "  implementing (max 6) [tools: read_file, edit_line, ...]"
fn parse_machine_block(lines: &[String]) -> Vec<StateInfo> {
    let mut states: Vec<StateInfo> = Vec::new();

    for line in lines {
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim();

        if indent <= 2 && trimmed.contains("[tools:") {
            // State definition line
            let name = trimmed.split_whitespace().next().unwrap_or("?").to_string();
            let max_iterations = if trimmed.contains("(max ") {
                trimmed
                    .split("(max ")
                    .nth(1)
                    .and_then(|s| s.split(')').next())
                    .and_then(|s| s.parse().ok())
            } else {
                None
            };
            let tools_str = trimmed
                .split("[tools: ")
                .nth(1)
                .and_then(|s| s.strip_suffix(']'))
                .unwrap_or("");
            let tools: Vec<String> = if tools_str == "(none)" || tools_str.is_empty() {
                vec![]
            } else {
                tools_str.split(", ").map(|s| s.to_string()).collect()
            };
            let is_final =
                tools.is_empty() && max_iterations.is_none() && !trimmed.contains("localizing");

            states.push(StateInfo {
                name,
                tools,
                transitions: Vec::new(),
                max_iterations,
                is_final,
            });
        } else if indent >= 4 && trimmed.contains(" -> ") {
            // Transition line
            if let Some(state) = states.last_mut() {
                if let Some((event, target)) = trimmed.split_once(" -> ") {
                    state
                        .transitions
                        .push((event.trim().to_string(), target.trim().to_string()));
                }
            }
        }
    }

    states
}

/// Parse a line from sw-agent stdout into a TuiEvent.
fn parse_engine_line(line: &str) -> TuiEvent {
    let trimmed = line.trim();

    // [Setup] Snapshotted N file(s)
    if let Some(rest) = strip_tag(trimmed, "[Setup]") {
        if let Some(n) = rest
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<usize>().ok())
        {
            return TuiEvent::Setup {
                files_snapshotted: n,
            };
        }
    }

    // [Phase N] ...
    if let Some(rest) = strip_tag(trimmed, "[Phase 1]") {
        return TuiEvent::LlmResponse {
            preview: format!("Phase 1: {}", rest),
        };
    }
    if let Some(rest) = strip_tag(trimmed, "[Phase 2]") {
        return TuiEvent::LlmResponse {
            preview: format!("Phase 2: {}", rest),
        };
    }

    // [Step N] HARD LIMIT — forcing X -> Y
    if trimmed.contains("HARD LIMIT") {
        if let Some((from, to)) = trimmed
            .split("forcing ")
            .nth(1)
            .and_then(|s| s.split_once(" -> "))
        {
            return TuiEvent::Transition {
                from: from.trim().to_string(),
                to: to.trim().to_string(),
                trigger: None,
                rationale: None,
            };
        }
    }

    // [Step N] ...
    if trimmed.starts_with("[Step ") {
        return parse_step_line(trimmed);
    }

    // [LOCALIZE] ...
    if let Some(rest) = strip_tag(trimmed, "[LOCALIZE]") {
        if rest.starts_with("Extracted") {
            let lines = rest
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            return TuiEvent::Localized {
                files: vec![],
                test_failures: String::new(),
                excerpt_lines: lines,
            };
        }
        if rest.starts_with("Test failures:") || rest.starts_with("Files:") {
            return TuiEvent::LlmResponse {
                preview: format!("LOCALIZE: {}", rest),
            };
        }
        return TuiEvent::LlmResponse {
            preview: format!("LOCALIZE: {}", rest),
        };
    }

    // [TOOL] name(args) -> result
    if let Some(rest) = strip_tag(trimmed, "[TOOL]") {
        if let Some((call, result)) = rest.split_once(") -> ") {
            let name = call.split('(').next().unwrap_or("?").to_string();
            // Unescape \n back to real newlines for diff parsing
            let result_unescaped = result.replace("\\n", "\n");
            return TuiEvent::ToolResult {
                name,
                result_preview: result_unescaped,
            };
        }
        let name = rest.split('(').next().unwrap_or("?").to_string();
        return TuiEvent::ToolCall {
            name,
            args_preview: rest.to_string(),
        };
    }

    // [NATIVE] name(args)
    if let Some(rest) = strip_tag(trimmed, "[NATIVE]") {
        let name = rest.split('(').next().unwrap_or("?").to_string();
        return TuiEvent::ToolCall {
            name,
            args_preview: rest.to_string(),
        };
    }

    // [GUARD] BLOCKED
    if let Some(rest) = strip_tag(trimmed, "[GUARD]") {
        if rest.starts_with("BLOCKED:") {
            let tool = rest.split('\'').nth(1).unwrap_or("?").to_string();
            let state = rest.split('\'').nth(3).unwrap_or("?").to_string();
            return TuiEvent::GuardBlocked { tool, state };
        }
    }

    // [TRANSITION] old -> new
    if let Some(rest) = strip_tag(trimmed, "[TRANSITION]") {
        if let Some((from, to)) = rest.split_once(" -> ") {
            return TuiEvent::Transition {
                from: from.trim().to_string(),
                to: to.trim().to_string(),
                trigger: None,
                rationale: None,
            };
        }
    }

    // [NAV] ...
    if let Some(rest) = strip_tag(trimmed, "[NAV]") {
        return TuiEvent::NavAction {
            action: rest.to_string(),
        };
    }

    // [AUTO-TEST]
    if let Some(rest) = strip_tag(trimmed, "[AUTO-TEST]") {
        if rest.contains("ALL PASSED") {
            return TuiEvent::AutoTest {
                passed: true,
                fail_count: 0,
            };
        }
        let count = rest
            .split_whitespace()
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1);
        return TuiEvent::AutoTest {
            passed: false,
            fail_count: count,
        };
    }

    // [DIFF]
    if let Some(rest) = strip_tag(trimmed, "[DIFF]") {
        let parts: Vec<&str> = rest.splitn(2, " — ").collect();
        if parts.len() == 2 {
            let file = parts[0].trim().to_string();
            let nums: Vec<usize> = parts[1]
                .split('/')
                .filter_map(|s| s.split_whitespace().next().and_then(|n| n.parse().ok()))
                .collect();
            if nums.len() >= 2 {
                return TuiEvent::DiffStats {
                    file,
                    changed: nums[0],
                    total: nums[1],
                };
            }
        }
    }

    // [MINIMIZER]
    if let Some(rest) = strip_tag(trimmed, "[MINIMIZER]") {
        if rest.starts_with("REJECTED") {
            let file = rest.split_whitespace().nth(2).unwrap_or("?").to_string();
            let changed = rest
                .split_whitespace()
                .nth(4)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            return TuiEvent::MinimizerRejected {
                file,
                changed,
                max: 5,
            };
        }
    }

    if trimmed.contains("[EDIT GATE]") {
        return TuiEvent::EditGateBlocked;
    }

    if let Some(rest) = strip_tag(trimmed, "[PARSE FAIL]") {
        return TuiEvent::ParseFail {
            preview: rest.to_string(),
        };
    }

    if let Some(rest) = strip_tag(trimmed, "[LLM]") {
        return TuiEvent::LlmResponse {
            preview: rest.to_string(),
        };
    }

    if trimmed.contains("[SNAPSHOT]") {
        return TuiEvent::Snapshot;
    }

    if let Some(rest) = strip_tag(trimmed, "[APPROVAL GATE]") {
        return TuiEvent::ApprovalGate {
            message: rest.to_string(),
        };
    }

    if trimmed.contains("[HUMAN]") {
        // "[HUMAN] APPROVED -> completed" — treat as a transition
        if let Some(target) = trimmed.split("-> ").nth(1) {
            return TuiEvent::Transition {
                from: "review".to_string(),
                to: target.trim().to_string(),
                trigger: None,
                rationale: None,
            };
        }
        return TuiEvent::NavAction {
            action: trimmed.to_string(),
        };
    }

    if let Some(rest) = strip_tag(trimmed, "[FAIL]") {
        return TuiEvent::AgentFailed {
            error: Some(rest.to_string()),
        };
    }

    // "=== COMPLETED in 8 steps ===" — word 3 (0-indexed) is the number
    if trimmed.starts_with("=== COMPLETED") {
        let steps = trimmed
            .split_whitespace()
            .nth(3)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        return TuiEvent::Completed {
            steps,
            success: true,
        };
    }
    // "=== FAILED (failed) after 18 steps ==="
    if trimmed.starts_with("=== FAILED") {
        let steps = trimmed
            .split_whitespace()
            .filter_map(|s| s.parse::<u32>().ok())
            .next()
            .unwrap_or(0);
        return TuiEvent::Completed {
            steps,
            success: false,
        };
    }

    if trimmed.contains("[SUCCESS]") {
        // Skip — the "=== COMPLETED ===" line already emits Completed with step count
        return TuiEvent::LlmResponse {
            preview: "all tests pass".to_string(),
        };
    }

    if let Some(rest) = strip_tag(trimmed, "[ABORT]") {
        let max = rest
            .split('(')
            .nth(1)
            .and_then(|s| s.split(')').next())
            .and_then(|s| s.parse().ok())
            .unwrap_or(25);
        return TuiEvent::Aborted { max_steps: max };
    }

    // Fallback
    TuiEvent::LlmResponse {
        preview: trimmed.to_string(),
    }
}

fn parse_step_line(line: &str) -> TuiEvent {
    let is_checkpoint = line.contains("CHECKPOINT");
    let step = line
        .split(']')
        .next()
        .and_then(|s| s.split_whitespace().last())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    if is_checkpoint {
        let state = line.split('\'').nth(1).unwrap_or("?").to_string();
        let iteration = line
            .split("iteration ")
            .nth(1)
            .and_then(|s| s.split('/').next())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let max = line
            .split("iteration ")
            .nth(1)
            .and_then(|s| s.split('/').nth(1))
            .and_then(|s| s.split(')').next())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        TuiEvent::StepStarted {
            step,
            state,
            iteration,
            max_iterations: max,
            tools: vec![],
            is_checkpoint: true,
        }
    } else {
        let state = line
            .split("State: ")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .unwrap_or("?")
            .to_string();
        let iteration = line
            .split('(')
            .nth(1)
            .and_then(|s| s.split('/').next())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let max = line
            .split('(')
            .nth(1)
            .and_then(|s| s.split('/').nth(1))
            .and_then(|s| s.split(')').next())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        TuiEvent::StepStarted {
            step,
            state,
            iteration,
            max_iterations: max,
            tools: vec![],
            is_checkpoint: false,
        }
    }
}

fn strip_tag<'a>(line: &'a str, tag: &str) -> Option<&'a str> {
    line.find(tag).map(|i| line[i + tag.len()..].trim())
}

/// Returns true if the line is pytest output noise that should be suppressed.
fn is_pytest_noise(line: &str) -> bool {
    // Separator lines
    if line.starts_with("====") || line.starts_with("____") || line.starts_with("----") {
        return true;
    }
    // Assertion detail lines
    if line.starts_with("E ") || line == "E" || line.starts_with("> ") {
        return true;
    }
    // Test result lines with percentages: "test_foo PASSED [100%]"
    if line.contains('%') && (line.contains("PASSED") || line.contains("FAILED")) {
        return true;
    }
    // Summary lines: "1 failed, 6 passed in 0.02s"
    if (line.contains("passed") || line.contains("failed"))
        && line.contains(" in ")
        && line.contains('s')
    {
        return true;
    }
    // Test location lines: "test_calc.py:24: in test_divide"
    if line.contains(".py:") && line.contains(": in ") {
        return true;
    }
    // FAILED summary: "FAILED test_calc.py::test_divide - assert..."
    if line.starts_with("FAILED ") && line.contains("::") {
        return true;
    }
    // Pytest infrastructure
    if line.starts_with("platform ")
        || line.starts_with("rootdir:")
        || line.starts_with("plugins:")
        || line.starts_with("cachedir:")
        || line.starts_with("collecting")
        || line.starts_with("collected")
        || line.starts_with("-- Docs:")
        || line.starts_with("--- Final Verification ---")
        || line.starts_with("assert ")
        || line.starts_with("Obtained:")
        || line.starts_with("Expected:")
        || line.starts_with("comparison failed")
    {
        return true;
    }
    // Bare assertion output
    if line.starts_with("+  where") || line.starts_with("   +  where") {
        return true;
    }
    // Error collection lines
    if line.contains("Interrupted:") && line.contains("error") {
        return true;
    }
    false
}
