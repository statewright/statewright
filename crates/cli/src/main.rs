mod model_registry;
mod tdd;
mod tdd_chain;
mod tools;

use clap::Parser;
use serde::Deserialize;
use serde_json::json;
use statewright_agent::ollama_client::{OllamaClient, OllamaConfig};
use statewright_agent::prompt_templates::ChatMessage;
use statewright_agent::tool_enforcer;
use statewright_agent::validator::validate_agent_machine;
use statewright_cli::events::{self, TuiEvent};
use statewright_engine::MachineDefinition;
use std::collections::HashMap;
use std::process::Command;

/// Tee stdout to a log file using a background thread.
/// All println! output automatically goes to both stdout and the file.
struct StdoutTee {
    _handle: Option<std::thread::JoinHandle<()>>,
}

impl StdoutTee {
    fn start(path: &str) -> Self {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::io::FromRawFd;

        let log_path = path.to_string();

        // Create a pipe
        let (read_fd, write_fd) = {
            let mut fds = [0i32; 2];
            unsafe {
                libc::pipe(fds.as_mut_ptr());
            }
            (fds[0], fds[1])
        };

        // Save original stdout fd
        let orig_stdout = unsafe { libc::dup(1) };

        // Redirect stdout to the write end of the pipe
        unsafe {
            libc::dup2(write_fd, 1);
            libc::close(write_fd);
        }

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

        StdoutTee {
            _handle: Some(handle),
        }
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
    originals: tools::Snapshot,
}

impl Drop for RestoreGuard {
    fn drop(&mut self) {
        tools::restore_from_snapshot(&self.workdir, &self.originals);
        println!(
            "\n[Restore] {} file(s) restored to original state",
            self.originals.len()
        );
    }
}

#[derive(Parser)]
#[command(
    name = "sw-agent",
    about = "Statewright agent — state machine constrained LLM executor"
)]
struct Args {
    /// Task description for the agent
    #[arg(
        short,
        long,
        default_value = "Fix the failing test in test_calc.py by finding and fixing the bug in calc.py"
    )]
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

    /// Use TDD greenfield state machine (understanding→tests→red→implement→green→done)
    #[arg(long)]
    tdd_greenfield: bool,

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

    /// Blind mode: no run_test tool, no auto-test feedback. Agent works from issue text only.
    #[arg(long)]
    blind: bool,

    /// Skip restoring files after completion (for capturing diffs in evaluation).
    #[arg(long)]
    no_restore: bool,

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

fn default_num_ctx() -> u32 {
    8192
}
fn default_temperature() -> f32 {
    0.3
}
fn default_num_predict() -> u32 {
    4096
}

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
        if trimmed.starts_with("def ")
            || trimmed.starts_with("class ")
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

fn extract_anchor_keywords(text: &str) -> Vec<String> {
    let stopwords = [
        "self", "return", "class", "import", "from", "None", "and", "or", "not", "the", "this",
        "that", "with", "for", "while", "if", "else", "elif", "true", "false", "null", "def",
        "async", "await",
    ];

    let mut keywords = Vec::new();
    for keyword in text
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric() && c != '_'))
        .filter(|w| w.len() > 4 && !stopwords.contains(w))
    {
        if !keywords.iter().any(|existing| existing == keyword) {
            keywords.push(keyword.to_string());
        }
        if keywords.len() >= 8 {
            break;
        }
    }
    keywords
}

fn excerpt_around_line(lines: &[&str], hit_line: usize, before: usize, after: usize) -> String {
    let idx = hit_line.saturating_sub(1).min(lines.len());
    let start = idx.saturating_sub(before);
    let end = (idx + after).min(lines.len());
    lines[start..end]
        .iter()
        .enumerate()
        .map(|(i, l)| format!("L{}: {}", start + i + 1, l))
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Clone)]
struct LocusExcerpt {
    start: usize,
    end: usize,
    score: usize,
    reason: String,
    excerpt: String,
}

fn window_bounds(lines_len: usize, hit_line: usize, before: usize, after: usize) -> (usize, usize) {
    if lines_len == 0 {
        return (0, 0);
    }
    let idx = hit_line.saturating_sub(1).min(lines_len.saturating_sub(1));
    let start = idx.saturating_sub(before) + 1;
    let end = (idx + after).min(lines_len);
    (start, end)
}

fn window_overlap(a: (usize, usize), b: (usize, usize)) -> usize {
    let start = a.0.max(b.0);
    let end = a.1.min(b.1);
    end.saturating_sub(start)
}

/// Resolve a Python dotted module path to a relative file path in the source file list.
/// "django.contrib.auth.forms" → "django/contrib/auth/forms.py" (or __init__ variant).
fn resolve_python_import(module_path: &str, source_files: &[&str]) -> Option<String> {
    let as_path = module_path.replace('.', "/");
    let candidates = [
        format!("{}.py", as_path),
        format!("{}/__init__.py", as_path),
        format!("src/{}.py", as_path),
        format!("src/{}/__init__.py", as_path),
    ];
    for c in &candidates {
        if source_files.iter().any(|f| *f == c.as_str() || f.ends_with(c.as_str())) {
            return Some(c.clone());
        }
    }
    None
}

/// Parse Python `from X import Y` and `import X` statements, returning resolved file paths.
fn extract_python_imports(content: &str, source_files: &[&str]) -> Vec<String> {
    let mut result = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("from ") {
            if let Some(module) = rest.split_whitespace().next() {
                // Strip leading dots (relative imports)
                let module = module.trim_start_matches('.');
                if !module.is_empty() {
                    if let Some(path) = resolve_python_import(module, source_files) {
                        result.push(path);
                    }
                }
            }
        } else if let Some(rest) = line.strip_prefix("import ") {
            for module in rest.split(',') {
                let base = module.trim().split(' ').next().unwrap_or("").trim_start_matches('.');
                if !base.is_empty() {
                    if let Some(path) = resolve_python_import(base, source_files) {
                        result.push(path);
                    }
                }
            }
        }
    }
    result.sort();
    result.dedup();
    result
}

fn ranked_locus_excerpts(
    file_content: &str,
    localized_regions: Option<&Vec<(usize, String)>>,
    old_arg: &str,
) -> Vec<LocusExcerpt> {
    let file_lines: Vec<&str> = file_content.lines().collect();
    if file_lines.is_empty() {
        return Vec::new();
    }

    let mut candidates: Vec<(usize, usize, usize, String)> = Vec::new();
    for token in extract_anchor_keywords(old_arg) {
        let token_lc = token.to_lowercase();
        let mut hits = 0usize;
        for (idx, line) in file_lines.iter().enumerate() {
            if line.to_lowercase().contains(&token_lc) {
                let (start, end) = window_bounds(file_lines.len(), idx + 1, 15, 25);
                candidates.push((
                    start,
                    end,
                    120usize.saturating_add(token.len()),
                    format!("token match: {}", token),
                ));
                hits += 1;
                if hits >= 3 {
                    break;
                }
            }
        }
    }

    if let Some(regions) = localized_regions {
        for (line_num, pattern) in regions.iter().take(6) {
            let (start, end) = window_bounds(file_lines.len(), *line_num, 15, 25);
            candidates.push((start, end, 90, format!("localized hit: {}", pattern)));
        }
    }

    if candidates.is_empty() {
        for (idx, line) in file_lines.iter().enumerate() {
            let trimmed = line.trim_start();
            let looks_like_symbol = trimmed.starts_with("def ")
                || trimmed.starts_with("class ")
                || trimmed.starts_with("async def ")
                || trimmed.starts_with("fn ")
                || trimmed.starts_with("struct ")
                || trimmed.starts_with("enum ")
                || trimmed.starts_with("impl ");
            if looks_like_symbol {
                let (start, end) = window_bounds(file_lines.len(), idx + 1, 2, 18);
                candidates.push((start, end, 40, "symbol skeleton fallback".into()));
            }
            if candidates.len() >= 8 {
                break;
            }
        }
    }

    if candidates.is_empty() {
        candidates.push((
            1,
            file_lines.len().min(80),
            1,
            "file prefix fallback".into(),
        ));
    }

    candidates.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));

    let mut selected: Vec<LocusExcerpt> = Vec::new();
    for (start, end, score, reason) in candidates {
        let span = end.saturating_sub(start).max(1);
        let overlaps_existing = selected.iter().any(|existing| {
            window_overlap((start, end), (existing.start, existing.end)) > span / 2
        });
        if overlaps_existing {
            continue;
        }

        let excerpt = file_lines[start.saturating_sub(1)..end.min(file_lines.len())]
            .iter()
            .enumerate()
            .map(|(i, l)| format!("L{}: {}", start + i, l))
            .collect::<Vec<_>>()
            .join("\n");
        selected.push(LocusExcerpt {
            start,
            end,
            score,
            reason,
            excerpt,
        });
        if selected.len() >= 3 {
            break;
        }
    }
    selected
}

fn format_locus_excerpts(excerpts: &[LocusExcerpt]) -> String {
    excerpts
        .iter()
        .enumerate()
        .map(|(idx, excerpt)| {
            format!(
                "Candidate {}: lines {}-{} (score {}, {})\n{}",
                idx + 1,
                excerpt.start,
                excerpt.end,
                excerpt.score,
                excerpt.reason,
                excerpt.excerpt
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn build_readable_excerpt(
    file_content: &str,
    localized_regions: Option<&Vec<(usize, String)>>,
    old_arg: &str,
) -> String {
    let file_lines: Vec<&str> = file_content.lines().collect();
    if file_lines.is_empty() {
        return String::new();
    }

    let ranked = ranked_locus_excerpts(file_content, localized_regions, old_arg);
    if !ranked.is_empty() {
        return format_locus_excerpts(&ranked);
    }

    if let Some(regions) = localized_regions {
        if let Some((line_num, _pattern)) = regions.iter().min_by_key(|(line_num, _)| *line_num) {
            return excerpt_around_line(&file_lines, *line_num, 15, 25);
        }
    }

    // Fall back to a compact numbered skeleton instead of dumping the whole file.
    let mut skeleton = Vec::new();
    let mut emitted = 0usize;
    for (idx, line) in file_lines.iter().enumerate() {
        let trimmed = line.trim_start();
        let looks_like_symbol = trimmed.starts_with("def ")
            || trimmed.starts_with("class ")
            || trimmed.starts_with("async def ")
            || trimmed.starts_with("fn ")
            || trimmed.starts_with("struct ")
            || trimmed.starts_with("enum ")
            || trimmed.starts_with("impl ");
        if looks_like_symbol {
            skeleton.push(format!("L{}: {}", idx + 1, line));
            emitted += 1;
        }
        if emitted >= 80 {
            break;
        }
    }

    if skeleton.is_empty() {
        file_lines
            .iter()
            .take(80)
            .enumerate()
            .map(|(i, l)| format!("L{}: {}", i + 1, l))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        skeleton.join("\n")
    }
}

fn env_flag(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => default,
        },
        Err(_) => default,
    }
}

fn is_bugfix_mode(args: &Args) -> bool {
    !args.control && !args.tdd && !args.tdd_greenfield && !args.tdd_chain
}

fn preferred_edit_tools(allowed_tools: &[String]) -> String {
    let preferred: Vec<&str> = [
        "edit_line",
        "insert_between",
        "edit_block",
        "patch_file",
        "apply_patch",
        "write_file",
        "create_file",
    ]
    .iter()
    .copied()
    .filter(|tool| allowed_tools.iter().any(|allowed| allowed == tool))
    .collect();
    if preferred.is_empty() {
        "edit the code".into()
    } else {
        preferred.join(", ")
    }
}

fn tool_reference_lines(allowed_tools: &[String]) -> Vec<String> {
    let mut lines = Vec::new();
    for tool in allowed_tools {
        let line = match tool.as_str() {
            "read_file" => Some(
                r#"- read_file: args: {"path": "filename"} or {"path": "filename", "start_line": 120, "end_line": 150}"#,
            ),
            "write_file" => {
                Some(r#"- write_file: args: {"path": "filename", "content": "full file content"}"#)
            }
            "create_file" => Some(r#"- create_file: args: {"path": "filename"}"#),
            "list_directory" => Some(r#"- list_directory: args: {"path": "."}"#),
            "run_test" => Some(r#"- run_test: args: {} or {"path": "tests/"}"#),
            "find_files" => Some(r#"- find_files: args: {"pattern": "*.py"}"#),
            "inspect_class" => Some(
                r#"- inspect_class: args: {"class": "ClassName"} or {"class": "ClassName", "attribute": "__slots__"}"#,
            ),
            "grep" => Some(
                r#"- grep: args: {"pattern": "search term"} or {"pattern": "search term", "file": "filename"}"#,
            ),
            "diff" => Some(r#"- diff: args: {"path": "filename"}"#),
            "edit_line" => Some(
                r#"- edit_line: args: {"path": "filename", "old": "line to find", "new": "replacement"} or {"path": "filename", "line": 100, "new": "new code"}"#,
            ),
            "edit_block" => Some(
                r#"- edit_block: args: {"path": "filename", "old": "multi\nline\nblock", "new": "replacement\nblock"}"#,
            ),
            "patch_file" => Some(
                r#"- patch_file: args: {"path": "filename", "patches": [{"old": "old line", "new": "new line"}]}"#,
            ),
            "apply_patch" => {
                Some(r#"- apply_patch: args: {"patch": "--- a/file\n+++ b/file\n@@ ..."}"#)
            }
            "insert_between" => Some(
                r#"- insert_between: args: {"path": "filename", "after": "line to insert after", "new": "new code"}"#,
            ),
            _ => None,
        };
        if let Some(line) = line {
            lines.push(line.to_string());
        }
    }
    lines
}

fn small_model_bugfix_tools() -> Vec<String> {
    [
        "read_file",
        "list_directory",
        "find_files",
        "grep",
        "run_test",
        "inspect_class",
        "edit_line",
        "insert_between",
    ]
    .iter()
    .map(|tool| tool.to_string())
    .collect()
}

fn apply_profile_tool_restrictions(
    definition: &mut MachineDefinition,
    profile: &model_registry::ResolvedTraits,
    bugfix_mode: bool,
) {
    if !bugfix_mode || !profile.small_model_edit_tools {
        return;
    }

    if let Some(state) = definition.states.get_mut("implementing") {
        state.allowed_tools = Some(small_model_bugfix_tools());
        state.instructions = Some(
            "Fix ONLY the bug. Use edit_line or insert_between for a minimal source-code edit. Change the fewest lines possible. Use run_test with a path to verify your fix.".into()
        );
    }
}

fn parse_sw_test_files() -> HashMap<String, String> {
    std::env::var("SW_TEST_FILES")
        .ok()
        .into_iter()
        .flat_map(|value| {
            value
                .split(':')
                .map(|p| p.trim().to_string())
                .collect::<Vec<_>>()
        })
        .filter(|path| !path.is_empty())
        .map(|path| (path.clone(), path.replace('\\', "/")))
        .collect()
}

/// Read SW_TEST_FILES test file(s) and return a compact excerpt for model injection.
/// Used by TEST_INJECTION (implementing state) and FORCED_REVIEW (testing state).
fn sw_test_files_excerpt(workdir: &str) -> String {
    let tf = match std::env::var("SW_TEST_FILES") {
        Ok(v) if !v.is_empty() => v,
        _ => return String::new(),
    };
    let max_lines: usize = 150;
    let mut out = String::new();
    for test_file in tf.split(':').filter(|f| !f.is_empty()) {
        let path = std::path::Path::new(workdir).join(test_file);
        if let Ok(content) = std::fs::read_to_string(&path) {
            let lines: Vec<&str> = content.lines().collect();
            let take = lines.len().min(max_lines);
            out.push_str(&format!("\n--- {} ---\n", test_file));
            out.push_str(&lines[..take].join("\n"));
            if lines.len() > max_lines {
                out.push_str(&format!(
                    "\n... ({} more lines not shown)\n",
                    lines.len() - max_lines
                ));
            }
        }
    }
    out
}

fn is_test_path(path: &str, sw_test_files: &HashMap<String, String>) -> bool {
    let normalized = path.replace('\\', "/");
    if sw_test_files.contains_key(path) || sw_test_files.values().any(|p| p == &normalized) {
        return true;
    }

    let basename = std::path::Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");

    normalized.starts_with("tests/")
        || normalized.contains("/tests/")
        || normalized.starts_with("testing/")
        || normalized.contains("/testing/")
        || basename.starts_with("test_")
        || basename.ends_with("_test.py")
        || basename.ends_with("_tests.py")
}

fn extract_patch_paths(patch: &str) -> Vec<String> {
    patch
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let candidate = trimmed
                .strip_prefix("+++ b/")
                .or_else(|| trimmed.strip_prefix("--- a/"))
                .or_else(|| trimmed.strip_prefix("+++ "))
                .or_else(|| trimmed.strip_prefix("--- "))?;
            if candidate == "/dev/null" {
                None
            } else {
                Some(candidate.to_string())
            }
        })
        .collect()
}

fn targeted_paths_for_tool(
    tool_name: &str,
    tool_args: &serde_json::Value,
    workdir: &str,
) -> Vec<String> {
    match tool_name {
        "apply_patch" => tool_args
            .get("patch")
            .and_then(|patch| patch.as_str())
            .map(extract_patch_paths)
            .unwrap_or_default()
            .into_iter()
            .map(|path| tools::resolve_repo_path(&path, workdir))
            .collect(),
        _ => tool_args
            .get("path")
            .and_then(|path| path.as_str())
            .map(|path| vec![tools::resolve_repo_path(path, workdir)])
            .unwrap_or_default(),
    }
}

fn is_write_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "edit_line"
            | "edit_block"
            | "patch_file"
            | "apply_patch"
            | "write_file"
            | "create_file"
            | "insert_between"
    )
}

fn test_exit_code(output: &str) -> Option<i32> {
    output.lines().find_map(|line| {
        line.strip_prefix("SW_TEST_EXIT_CODE=")
            .and_then(|value| value.trim().parse::<i32>().ok())
    })
}

fn test_env_unavailable(output: &str) -> bool {
    output.starts_with("TEST_ENV_UNAVAILABLE")
        || output
            .lines()
            .any(|line| line.trim() == "SW_TEST_ENV_UNAVAILABLE=1")
}

// Detects cases where the test subprocess returned non-zero but without any
// assertion failure content — indicates runner/harness error, not a code defect.
// Observed with `conda run python tests/runtests.py` on Django eval images where
// the conda wrapper adds exit overhead independent of test outcomes.
fn test_is_runner_error(output: &str) -> bool {
    let exit_nonzero = test_exit_code(output).map_or(false, |c| c != 0);
    if !exit_nonzero {
        return false;
    }
    // Any Python execution evidence = real signal, not runner overhead.
    // "Traceback (most recent call last):" is the canonical header for ALL Python
    // exceptions (NameError, OSError, ImportError, etc.) — one pattern vs. whack-a-mole.
    let has_assertion_content = output.contains("Traceback (most recent call last)")
        || output.contains("AssertionError")
        || (output.contains("FAILED") && output.contains("::")) // pytest: FAILED path::test
        || output.contains("FAIL: ") // Django runtests.py: FAIL: test_name (module.Class)
        || output.contains("ERROR: ") // Django runtests.py: ERROR: test_name (module.Class)
        || output.contains("assert ")
        || output.contains("\nE   "); // pytest failure body line prefix
    !has_assertion_content
}

fn test_has_syntax_failure(output: &str) -> bool {
    output.contains("SyntaxError")
        || output.contains("IndentationError")
        || output.contains("TabError")
}

fn test_passed(output: &str) -> bool {
    if test_env_unavailable(output) {
        return false;
    }
    let exit_code = test_exit_code(output);
    if let Some(code) = exit_code {
        if code != 0 {
            return false;
        }
    }

    let lower = output.to_ascii_lowercase();
    let has_nonzero_failed = lower.contains(" failed")
        && !lower.contains(" 0 failed")
        && !lower.contains(", 0 failed")
        && !lower.contains("= 0 failed");
    let no_fail = !output.contains("FAILED")
        && !output.contains("FAIL ")
        && !has_nonzero_failed
        && !output.contains("error:")
        && !output.contains("Error:")
        && !output.contains("Traceback")
        && !output.contains("SyntaxError")
        && !output.contains("IndentationError")
        && !output.contains("ModuleNotFoundError")
        && !output.contains("exception")
        && !output.contains("DO *NOT* COMMIT");

    // When exit code is authoritatively 0 and no failure strings, that's a pass.
    // This handles Django/unittest "Ran N tests\n\nOK" format which has no "passed" string.
    // Do NOT require has_pass when SW_TEST_EXIT_CODE=0 is present — it's the ground truth.
    if exit_code == Some(0) && no_fail {
        return true;
    }

    let has_pass = (output.contains("passed") && !output.contains("0 passed"))
        || output.contains("PASS")
        || output.contains("test result: ok")
        || output.contains("Tests  ");
    no_fail && has_pass
}

fn failure_excerpt(output: &str, limit: usize) -> String {
    output
        .lines()
        .filter(|line| {
            line.starts_with("FAILED")
                || line.starts_with("ERROR")
                || line.contains("failed")
                || line.contains("Error")
                || line.contains("AssertionError")
                || line.contains("assert ")
                || line.contains("DO *NOT* COMMIT")
        })
        .take(limit)
        .collect::<Vec<_>>()
        .join("\n")
}

fn scoped_test_file_from_env() -> Option<String> {
    std::env::var("SW_TEST_FILES").ok().and_then(|tf| {
        let files: Vec<&str> = tf.split(':').filter(|f| !f.is_empty()).collect();
        files
            .iter()
            .find(|f| f.contains("test"))
            .or_else(|| files.first())
            .map(|s| s.to_string())
    })
}

#[cfg(test)]
mod harness_result_tests {
    use super::{parse_response, ranked_locus_excerpts, test_passed};

    #[test]
    fn test_passed_requires_zero_exit_code() {
        let output = "SW_TEST_EXIT_CODE=1\n---\n42 passed, 1 exceptions\n";
        assert!(!test_passed(output));
    }

    #[test]
    fn test_passed_rejects_do_not_commit() {
        let output = "SW_TEST_EXIT_CODE=0\n---\n42 passed\nDO *NOT* COMMIT!\n";
        assert!(!test_passed(output));
    }

    #[test]
    fn test_passed_accepts_clean_zero_exit() {
        let output = "SW_TEST_EXIT_CODE=0\n---\n42 passed in 0.42s\n";
        assert!(test_passed(output));
    }

    #[test]
    fn test_passed_accepts_django_ok_format() {
        // Django runtests.py outputs "Ran N tests in Xs\n\nOK" — no "passed" string.
        // Previously test_passed returned false here, causing 0/10 on all Django instances.
        let output = "System check identified no issues (0 silenced).\n\
                      Ran 5 tests in 0.012s\n\n\
                      OK\n\
                      SW_TEST_EXIT_CODE=0\nSW_TEST_ENV_UNAVAILABLE=0\n";
        assert!(test_passed(output));
    }

    #[test]
    fn test_passed_rejects_django_fail() {
        // Django failing test: exit 1 + "FAILED" in output
        let output = "FAIL: test_bulk_update (queries.tests.BulkUpdateTests)\n\
                      AssertionError: 0 != 2\n\
                      Ran 5 tests in 0.012s\n\n\
                      FAILED (failures=1)\n\
                      SW_TEST_EXIT_CODE=1\nSW_TEST_ENV_UNAVAILABLE=0\n";
        assert!(!test_passed(output));
    }

    #[test]
    fn parse_response_heals_missing_tool_call_close_brace() {
        // qwen3:8b consistently omits the closing } for tool_call objects before ].
        // Model emits: {"tool_calls": [{"name": "insert_between", "args": {...}], "transition": "DONE"}
        //   (missing }  before ] — the tool_call object is never closed)
        let raw = r#"{"tool_calls": [{"name": "insert_between", "args": {"path": "django/db/models/enums.py", "after": "class Choices(", "new": "    do_not_call_in_templates = True"}], "transition": "DONE"}]}"#;
        let result = parse_response(raw);
        assert!(result.is_some(), "should heal missing tool_call closing brace");
        let r = result.unwrap();
        assert_eq!(r.transition.as_deref(), Some("DONE"));
        let calls = r.tool_calls.unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "insert_between");
    }

    #[test]
    fn parse_response_heals_is_idempotent_on_valid_json() {
        // Valid JSON with proper }}] should parse without healing (at direct-parse step)
        let raw = r#"{"tool_calls": [{"name": "edit_line", "args": {"path": "f.py", "old": "x", "new": "y"}}], "transition": "DONE"}"#;
        let result = parse_response(raw);
        assert!(result.is_some());
        let r = result.unwrap();
        assert_eq!(r.transition.as_deref(), Some("DONE"));
    }

    #[test]
    fn ranked_locus_excerpts_returns_diverse_anchor_windows() {
        let content = r#"
class SQLCompiler:
    def as_sql(self):
        pass

    def unrelated(self):
        return self.query

    def get_order_by(self):
        if self.query.order_by:
            return self.query.order_by
        return []

class Other:
    def get_order_by(self):
        return []
"#;
        let regions = vec![(9, "order_by".to_string()), (14, "order_by".to_string())];

        let excerpts = ranked_locus_excerpts(content, Some(&regions), "if self.union_order_by:");

        assert!(!excerpts.is_empty());
        assert!(excerpts.len() <= 3);
        assert!(
            excerpts
                .iter()
                .any(|excerpt| excerpt.reason.contains("localized hit"))
        );
    }
}

fn hardcoded_bug_fix_machine() -> MachineDefinition {
    serde_json::from_value(json!({
        "id": "fix-bug",
        "initial": "localizing",
        "meta": { "task_type": "bug_fix", "danger_level": "moderate", "estimated_steps": 20 },
        "states": {
            "localizing": {
                "allowed_tools": [],
                "instructions": "PROGRAMMATIC — do not call LLM",
                "on": { "LOCALIZED": "planning", "FAIL": "failed" }
            },
            "planning": {
                "allowed_tools": ["read_file", "list_directory", "find_files", "run_test", "grep"],
                "instructions": "Review the localized code sections and test failures provided. Identify the exact bug. Use grep or read_file with start_line/end_line if you need more context. Do NOT modify files yet.",
                "max_iterations": 10,
                "safe_next": "implementing",
                "on": { "PLAN_READY": "implementing", "DONE": "implementing", "FAIL": "failed" }
            },
            "implementing": {
                "allowed_tools": ["read_file", "list_directory", "find_files", "grep", "run_test", "inspect_class", "edit_line", "edit_block", "patch_file", "apply_patch", "write_file", "insert_between"],
                "instructions": "Fix ONLY the bug. Use edit_line, edit_block, patch_file, or apply_patch. Change the fewest lines possible. Use run_test with a path to verify your fix.",
                "max_iterations": 15,
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

fn tdd_greenfield_machine() -> MachineDefinition {
    serde_json::from_value(json!({
        "id": "tdd-greenfield",
        "initial": "understanding",
        "meta": { "task_type": "feature", "danger_level": "moderate", "estimated_steps": 50 },
        "states": {
            "understanding": {
                "allowed_tools": ["read_file", "list_directory", "find_files", "grep", "inspect_class"],
                "instructions": "Read the task instruction carefully. Explore the existing codebase to understand its structure, patterns, and conventions. Identify where new code should go and what interfaces to follow. Do NOT write any code yet.",
                "max_iterations": 5,
                "safe_next": "test_writing",
                "on": { "UNDERSTOOD": "test_writing", "DONE": "test_writing", "FAIL": "failed" }
            },
            "test_writing": {
                "allowed_tools": ["read_file", "list_directory", "find_files", "grep", "create_file", "write_file", "edit_line", "edit_block"],
                "instructions": "Write tests FIRST that encode the expected behavior from the task description. Write them in the project's test directory following existing test patterns. These tests should FAIL because no implementation exists yet. Each test should verify one specific requirement from the task. Use create_file to create new files — you'll be prompted to output the content directly.",
                "max_iterations": 8,
                "safe_next": "red_check",
                "on": { "TESTS_WRITTEN": "red_check", "DONE": "red_check", "FAIL": "failed" }
            },
            "red_check": {
                "allowed_tools": ["run_test"],
                "instructions": "Run the tests you wrote. They should FAIL because no implementation exists. If they pass, your tests are wrong — go back and write real tests. If they fail with import/syntax errors in test code, fix the tests. If they fail as expected (assertion errors), proceed to implementing.",
                "max_iterations": 3,
                "on": {
                    "TESTS_RED": "implementing",
                    "TESTS_PASS": "test_writing",
                    "DONE": "implementing",
                    "FAIL": "failed"
                }
            },
            "implementing": {
                "allowed_tools": ["read_file", "list_directory", "find_files", "grep", "run_test", "inspect_class", "create_file", "write_file", "edit_line", "edit_block", "patch_file", "apply_patch", "insert_between"],
                "instructions": "Write the implementation to make your tests pass. Follow the codebase's existing patterns and conventions. ALWAYS use create_file (not write_file) for new files — it lets you output the code directly without JSON limitations. For editing existing files, use edit_line or edit_block. Run tests frequently with run_test to check progress.",
                "max_iterations": 20,
                "safe_next": "green_check",
                "on": { "DONE": "green_check", "TESTS_PASS": "green_check", "FAIL": "failed" }
            },
            "green_check": {
                "allowed_tools": ["run_test", "read_file", "diff"],
                "instructions": "Run ALL tests (your new tests AND existing tests). If all pass, transition APPROVED. If your tests fail, go back to implementing. If existing tests broke, fix the regression.",
                "max_iterations": 3,
                "on": {
                    "APPROVED": "completed",
                    "DONE": "completed",
                    "TESTS_FAIL": "implementing",
                    "TESTS_PASS": "completed",
                    "FAIL": "failed"
                }
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
                "allowed_tools": ["read_file", "list_directory", "find_files", "grep", "run_test", "inspect_class", "edit_line", "edit_block", "patch_file", "apply_patch", "write_file", "insert_between", "diff"],
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
    let edit_tools = preferred_edit_tools(allowed_tools);
    let tool_lines = tool_reference_lines(allowed_tools).join("\n");
    let reasoning_directive = if reasoning {
        "Think step by step about what the bug is and why, then provide your action as a JSON object."
    } else {
        "Respond with ONLY a JSON object, no other text."
    };
    let nav_section = statewright_agent::ollama_client::nav_tools_prompt_section(
        transitions,
        current_state,
        allowed_tools,
        iterations_remaining,
    );

    if is_checkpoint && current_state == "implementing" {
        format!(
            r#"You have reached the iteration limit in the "{current_state}" state.
You MUST make your best edit NOW based on what you have read, then call the transition tool.

Use {edit_tools} to make the most likely fix. If you are unsure, make your best guess — the tests will verify. Do NOT just transition without editing.

TASK: {task}

Available tools: {tools_list}
{tool_lines}

{nav_section}

Respond with ONLY a JSON object."#,
            current_state = current_state,
            task = task,
            tools_list = tools_list,
            edit_tools = edit_tools,
            tool_lines = tool_lines,
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
                let mut s = format!(
                    "You MUST edit the code to fix the bug. Call {} now. Do NOT just read files — you already have the information you need. Make your edit, then transition with DONE.",
                    edit_tools
                );
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
{tool_lines}

{nav_section}"#,
            task = task,
            current_state = current_state,
            instructions = instructions,
            workdir = workdir,
            tools_list = tools_list,
            tool_lines = tool_lines,
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
    let mut profile = registry.resolve(&args.model);

    // Greenfield mode: disable the diff size limiter.
    // Bugfix = surgical edits (5 lines), greenfield = whole file writes.
    if args.tdd_greenfield {
        profile.max_diff_lines = 500;
    }

    profile.sandbox_failed_edits =
        env_flag("SW_SANDBOX_FAILED_EDITS", profile.sandbox_failed_edits);
    profile.read_only_tests = env_flag("SW_READ_ONLY_TESTS", profile.read_only_tests);
    profile.enforce_localized_edit_locus =
        env_flag("SW_ENFORCE_LOCUS", profile.enforce_localized_edit_locus);

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
    let workdir = run_config
        .workdir
        .as_deref()
        .unwrap_or(&args.workdir)
        .to_string();
    let max_steps = if run_config.guardrails.max_steps > 0 && args.config.is_some() {
        run_config.guardrails.max_steps
    } else {
        args.max_steps
    };

    // Helper: get OllamaClient for a given state (per-state model routing)
    let make_client_for_state = |state: &str| -> OllamaClient {
        if let Some(mc) = run_config.model_routing.get(state) {
            OllamaClient::new(OllamaConfig {
                api_url: mc
                    .ollama_url
                    .clone()
                    .unwrap_or_else(|| args.ollama_url.clone()),
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
        let task =
            std::fs::read_to_string(std::path::Path::new(&args.workdir).join("requirements.md"))
                .unwrap_or(args.task);
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
        let context_json: serde_json::Value = args
            .context_file
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(json!({}));

        // Use workflow from config if provided, otherwise fall back to hardcoded machine
        let mut definition = run_config
            .workflow
            .unwrap_or_else(hardcoded_bug_fix_machine);
        apply_profile_tool_restrictions(&mut definition, &profile, is_bugfix_mode(&args));
        let state_def = match definition.states.get(target_state.as_str()) {
            Some(s) => s,
            None => {
                eprintln!("State '{}' not found in workflow", target_state);
                std::process::exit(1);
            }
        };

        let allowed_tools = state_def
            .allowed_tools
            .as_ref()
            .cloned()
            .unwrap_or_default();
        let instructions = state_def.instructions.as_deref().unwrap_or("Proceed.");
        let transitions: Vec<(String, String)> = state_def
            .on
            .iter()
            .map(|(event, t)| (event.clone(), t.target().to_string()))
            .collect();

        let mut conversation: Vec<ChatMessage> = Vec::new();

        // Inject context as initial user message
        if context_json != json!({}) {
            conversation.push(ChatMessage {
                role: "user".into(),
                content: format!(
                    "Context from previous states:\n{}",
                    serde_json::to_string_pretty(&context_json).unwrap_or_default()
                ),
            });
        }

        // Programmatic localization: run tests, extract failures, read relevant code.
        // Injects focused context so the model doesn't have to navigate large files.
        {
            let test_output = tools::execute_tool("run_test", &json!({}), &workdir);
            let test_summary: String = test_output
                .lines()
                .filter(|l| {
                    l.contains("FAILED")
                        || l.contains("assert")
                        || l.contains("Error")
                        || l.contains("passed")
                })
                .take(10)
                .collect::<Vec<_>>()
                .join("\n");

            let files = tools::execute_tool("list_directory", &json!({"path": "."}), &workdir);

            // Grep for keywords from test failures
            let mut grep_results = String::new();
            let source_files: Vec<&str> = files
                .lines()
                .filter(|f| {
                    (f.ends_with(".py")
                        || f.ends_with(".rs")
                        || f.ends_with(".js")
                        || f.ends_with(".ts"))
                        && !f.starts_with("test_")
                        && !f.contains("__pycache__")
                })
                .collect();

            for line in test_summary.lines() {
                for word in line.split_whitespace() {
                    let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                    if clean.len() > 3 && (clean.contains('_') || clean.starts_with("test_")) {
                        let pattern = if clean.starts_with("test_") {
                            &clean[5..]
                        } else {
                            clean
                        };
                        for src in &source_files {
                            let result = tools::execute_tool(
                                "grep",
                                &json!({"pattern": pattern, "file": src}),
                                &workdir,
                            );
                            if result != "no matches found" {
                                grep_results.push_str(&format!(
                                    "grep '{}' in {}:\n{}\n",
                                    pattern,
                                    src,
                                    result.lines().take(5).collect::<Vec<_>>().join("\n")
                                ));
                            }
                        }
                    }
                }
            }

            // Read source files (first 200 lines or around grep hits)
            let mut source_excerpts = String::new();
            for src in &source_files {
                let content = tools::execute_tool("read_file", &json!({"path": src}), &workdir);
                let line_count = content.lines().count();
                if line_count <= 200 {
                    source_excerpts.push_str(&format!(
                        "=== {} ({} lines) ===\n{}\n",
                        src, line_count, content
                    ));
                } else {
                    source_excerpts.push_str(&format!(
                        "=== {} ({} lines, showing first 50) ===\n{}\n",
                        src,
                        line_count,
                        content.lines().take(50).collect::<Vec<_>>().join("\n")
                    ));
                }
            }

            let localization = format!(
                "## Test Results\n{}\n\n## Files\n{}\n\n## Grep Hits\n{}\n\n## Source\n{}\n",
                test_summary,
                files.lines().take(20).collect::<Vec<_>>().join(", "),
                grep_results,
                source_excerpts
            );

            if json_mode {
                events::emit_json(&TuiEvent::Localized {
                    files: source_files.iter().map(|s| s.to_string()).collect(),
                    test_failures: test_summary.clone(),
                    excerpt_lines: localization.lines().count(),
                });
            }
            eprintln!(
                "[LOCALIZE] {} source files, {} test lines, {} grep lines",
                source_files.len(),
                test_summary.lines().count(),
                grep_results.lines().count()
            );

            conversation.push(ChatMessage {
                role: "user".into(),
                content: format!("Bug localization results:\n{}", localization),
            });
        }

        let mut step = 0u32;
        let max_iter = state_def.max_iterations.unwrap_or(10);
        let mut classified = false;

        loop {
            step += 1;
            if step > max_iter {
                // Tier 1 classifier: re-prompt the model to pick a valid transition
                if !classified {
                    classified = true;
                    let valid_list = transitions
                        .iter()
                        .map(|(e, t)| format!("  {} → {}", e, t))
                        .collect::<Vec<_>>()
                        .join("\n");
                    // Use only the LAST tool result — not stale history from prior cycles
                    let last_result = conversation
                        .iter()
                        .filter(|m| m.role == "user")
                        .last()
                        .map(|m| m.content.chars().take(500).collect::<String>())
                        .unwrap_or_else(|| "No tool results.".to_string());

                    let classify_prompt = format!(
                        "State: '{}'. Instructions: {}\n\
                         Last tool result:\n{}\n\n\
                         Valid transitions:\n{}\n\n\
                         Based on the result above, which transition event is correct?\n\
                         Reply with ONLY the event name, nothing else.",
                        target_state, instructions, last_result, valid_list
                    );

                    eprintln!(
                        "[CLASSIFY] Asking model to pick a valid transition for '{}'",
                        target_state
                    );
                    let classify_response = client
                        .chat(vec![
                            ChatMessage {
                                role: "system".into(),
                                content:
                                    "Reply with ONLY the transition event name. No explanation."
                                        .into(),
                            },
                            ChatMessage {
                                role: "user".into(),
                                content: classify_prompt,
                            },
                        ])
                        .await;

                    if let Ok(raw) = classify_response {
                        // Extract event name: model may respond "TESTS_FAIL" or "TESTS_FAIL → retry" or "TESTS_FAIL."
                        let cleaned = raw.trim().trim_matches('"').trim();
                        let event = cleaned
                            .split_whitespace()
                            .next()
                            .unwrap_or(cleaned)
                            .trim_end_matches(|c: char| !c.is_alphanumeric() && c != '_');
                        if let Some((_, target_name)) = transitions.iter().find(|(e, _)| e == event)
                        {
                            eprintln!("[CLASSIFY] Model chose: {} → {}", event, target_name);
                            if json_mode {
                                events::emit_json(&TuiEvent::Transition {
                                    from: target_state.clone(),
                                    to: target_name.clone(),
                                    trigger: Some(event.to_string()),
                                    rationale: Some(
                                        "Classified by model after max_iterations".to_string(),
                                    ),
                                });
                                events::emit_json(&TuiEvent::Completed {
                                    steps: step - 1,
                                    success: true,
                                });
                            }
                            break;
                        } else {
                            eprintln!("[CLASSIFY] Model response '{}' not a valid event", event);
                        }
                    }
                }

                // Classification failed — exit with failure
                if json_mode {
                    events::emit_json(&TuiEvent::Completed {
                        steps: step - 1,
                        success: false,
                    });
                }
                eprintln!(
                    "Max iterations ({}) exceeded in state '{}', classification failed",
                    max_iter, target_state
                );
                break;
            }

            let system_prompt = build_system_prompt(
                &task,
                target_state,
                instructions,
                &allowed_tools,
                &transitions,
                &workdir,
                false,
                Some(max_iter - step),
                false,
                "",
                false,
            );
            let mut messages = vec![ChatMessage {
                role: "system".into(),
                content: system_prompt,
            }];
            // Include accumulated conversation (tool calls + results from prior steps)
            messages.extend(conversation.iter().cloned());
            messages.push(ChatMessage {
                role: "user".into(),
                content: "Proceed with the next action.".into(),
            });

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
                        (Some(s), Some(e)) if e > s => serde_json::from_str(&raw_response[s..=e])
                            .unwrap_or(LlmResponse {
                                transition: None,
                                error: None,
                                tool_calls: None,
                                reasoning: None,
                            }),
                        _ => LlmResponse {
                            transition: None,
                            error: None,
                            tool_calls: None,
                            reasoning: None,
                        },
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
                            from: target_state.clone(),
                            to: target_name.clone(),
                            trigger: Some(event.clone()),
                            rationale: rationale.clone(),
                        });
                        events::emit_json(&TuiEvent::Completed {
                            steps: step,
                            success: true,
                        });
                    } else {
                        println!(
                            "[TRANSITION] {} -> {} (event: {})",
                            target_state, target_name, event
                        );
                        if let Some(r) = &rationale {
                            println!("  rationale: {}", r);
                        }
                    }
                    break;
                } else {
                    // Invalid event — tell the model to pick a valid one
                    let valid_events: Vec<String> = transitions
                        .iter()
                        .map(|(e, t)| format!("{} → {}", e, t))
                        .collect();
                    let rejection = format!(
                        "Invalid transition event '{}'. Valid transitions from '{}' are:\n  {}\nAnalyze your results and call transition with the CORRECT event name and a rationale explaining why.",
                        event,
                        target_state,
                        valid_events.join("\n  ")
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
                let mut should_break = false;
                for tc in &calls {
                    // Intercept transition tool calls (model calls transition as a tool, not via resp.transition)
                    if tc.name == "transition" || tc.name == "statewright_transition" {
                        let event = tc
                            .args
                            .get("event")
                            .and_then(|v| v.as_str())
                            .unwrap_or("DONE");
                        let rationale = tc
                            .args
                            .get("rationale")
                            .or_else(|| tc.args.get("reason"))
                            .and_then(|v| v.as_str());
                        if let Some((_, target_name)) = transitions.iter().find(|(e, _)| e == event)
                        {
                            if json_mode {
                                events::emit_json(&TuiEvent::Transition {
                                    from: target_state.clone(),
                                    to: target_name.clone(),
                                    trigger: Some(event.to_string()),
                                    rationale: rationale.map(|s| s.to_string()),
                                });
                                events::emit_json(&TuiEvent::Completed {
                                    steps: step,
                                    success: true,
                                });
                            }
                            should_break = true;
                            break;
                        } else {
                            let valid = transitions
                                .iter()
                                .map(|(e, t)| format!("{} → {}", e, t))
                                .collect::<Vec<_>>()
                                .join(", ");
                            conversation.push(ChatMessage {
                                role: "user".into(),
                                content: format!(
                                    "Invalid event '{}'. Valid: {}. Pick the correct one.",
                                    event, valid
                                ),
                            });
                            continue;
                        }
                    }

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
                        println!(
                            "  [TOOL] {}({}) -> {}",
                            tc.name,
                            serde_json::to_string(&tc.args)
                                .unwrap_or_default()
                                .chars()
                                .take(60)
                                .collect::<String>(),
                            result.chars().take(200).collect::<String>()
                        );
                    }

                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!("=== {} result ===\n{}", tc.name, result),
                    });

                    // Auto-test: after any edit tool, run tests. If pass, auto-transition DONE/TESTS_PASS.
                    // TODO: Expose as a per-state workflow flag (e.g. "auto_test": true) so non-Rust TUIs
                    // implementing direct_execution can replicate this behavior. Currently implicit in
                    // sw-agent's --state path only.
                    let is_edit = matches!(
                        tc.name.as_str(),
                        "edit_line" | "edit_block" | "patch_file" | "apply_patch" | "write_file"
                    );
                    if is_edit && !result.starts_with("error") {
                        let test_output =
                            tools::execute_tool("run_test", &serde_json::json!({}), &workdir);
                        let tests_pass = test_output.contains("passed")
                            && !test_output.contains("failed")
                            && !test_output.contains("FAILED");
                        if json_mode {
                            events::emit_json(&TuiEvent::AutoTest {
                                passed: tests_pass,
                                fail_count: 0,
                            });
                        }
                        if tests_pass {
                            // Find the best forward transition (DONE, TESTS_PASS, or first non-FAIL)
                            let auto_event = transitions
                                .iter()
                                .find(|(e, _)| e == "DONE" || e == "TESTS_PASS")
                                .or_else(|| transitions.iter().find(|(e, _)| e != "FAIL"))
                                .map(|(e, _)| e.clone());
                            if let Some(event) = auto_event {
                                let target = transitions
                                    .iter()
                                    .find(|(e, _)| *e == event)
                                    .map(|(_, t)| t.clone())
                                    .unwrap_or("?".into());
                                if json_mode {
                                    events::emit_json(&TuiEvent::Transition {
                                        from: target_state.clone(),
                                        to: target,
                                        trigger: Some(event),
                                        rationale: Some("Auto-test pass after edit".into()),
                                    });
                                    events::emit_json(&TuiEvent::Completed {
                                        steps: step,
                                        success: true,
                                    });
                                }
                                should_break = true;
                                break;
                            }
                        }
                    }
                }
                if should_break {
                    break;
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
            if json_mode {
                events::emit_json(&$event);
            }
        };
        ($event:expr, $pretty:expr) => {
            if json_mode {
                events::emit_json(&$event);
            } else {
                println!("{}", $pretty);
            }
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
    emit!(
        TuiEvent::Setup {
            files_snapshotted: original_count
        },
        format!(
            "[Setup] Snapshotted {} file(s) for auto-restore\n",
            original_count
        )
    );

    // Restore originals on exit (panic or normal) — unless --no-restore
    let _restore_guard = if args.no_restore {
        None
    } else {
        Some(RestoreGuard {
            workdir: workdir_for_restore,
            originals,
        })
    };

    // Phase 1: Get or generate the state machine
    let mut definition = if args.control {
        println!("[Phase 1] CONTROL MODE — flat machine, no guardrails");
        control_flat_machine()
    } else if args.tdd_greenfield {
        println!("[Phase 1] TDD GREENFIELD — understanding→tests→red→implement→green→done");
        tdd_greenfield_machine()
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

        match statewright_agent::generator::generate_machine(&client, &args.task, args.max_retries)
            .await
        {
            Ok(result) => {
                println!(
                    "[Phase 1] State machine generated in {} attempt(s)",
                    result.attempts
                );
                println!(
                    "[Phase 1] States: {:?}",
                    result.definition.states.keys().collect::<Vec<_>>()
                );
                result.definition
            }
            Err(e) => {
                eprintln!("[Phase 1] FAILED to generate state machine: {}", e);
                eprintln!("[Phase 1] Falling back to hardcoded machine");
                hardcoded_bug_fix_machine()
            }
        }
    };
    apply_profile_tool_restrictions(&mut definition, &profile, is_bugfix_mode(&args));

    // Validate
    if let Err(e) = validate_agent_machine(&definition) {
        eprintln!("[Validation] Warnings: {:?}", e.errors);
    }

    // Print the state machine
    println!("\n--- State Machine ---");
    for (name, state_def) in &definition.states {
        let tools = state_def
            .allowed_tools
            .as_ref()
            .map(|t| t.join(", "))
            .unwrap_or_else(|| "(none)".into());
        let transitions: Vec<String> = state_def
            .on
            .iter()
            .map(|(event, t)| format!("{} -> {}", event, t.target()))
            .collect();
        let max_iter = state_def
            .max_iterations
            .map(|m| format!(" (max {})", m))
            .unwrap_or_default();
        println!("  {}{} [tools: {}]", name, max_iter, tools);
        for t in &transitions {
            println!("    {}", t);
        }
    }
    println!("---\n");

    // Phase 2: Execute the state machine with conversation history
    if !json_mode {
        println!("[Phase 2] Executing agent within state machine constraints\n");
    }

    // Default client (used when no per-state routing configured)
    // Escalation model (env override or default to gpt-oss:20b)
    let escalation_url = std::env::var("SW_ESCALATION_URL")
        .unwrap_or_else(|_| "https://gpt-oss-20b.ollama.casa.enhasa.cloud/v1".into());
    let escalation_model =
        std::env::var("SW_ESCALATION_MODEL").unwrap_or_else(|_| "gpt-oss:20b".into());

    // Greenfield needs higher output token limit for file writes.
    // A 200-line file with JSON escaping needs ~6500 tokens.
    let output_tokens = if args.tdd_greenfield { 16384 } else { 4096 };

    let base_client = OllamaClient::new(OllamaConfig {
        api_url: args.ollama_url.clone(),
        model: args.model.clone(),
        temperature: 0.3,
        max_tokens: output_tokens,
    });
    let escalation_client = OllamaClient::new(OllamaConfig {
        api_url: escalation_url.clone(),
        model: escalation_model.clone(),
        temperature: 0.3,
        max_tokens: output_tokens,
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
    let mut gate_fired_this_step = false; // set when GATE blocks an edit, cleared each step
    let mut reasoning_mode = false;
    let mut escalated_model = false;
    let mut persistent_hint: Option<String> = None;

    // Per-file consecutive edit_line failure counter for locus-loop detection.
    // When a file accumulates LOCUS_RESET_THRESHOLD consecutive failures, we inject
    // the full current file content into the tool result to reset the model's stale
    // mental model (it hallucinates anchor text that no longer exists after prior edits).
    let mut consecutive_locus_fails: HashMap<String, u32> = HashMap::new();
    const LOCUS_RESET_THRESHOLD: u32 = 3;

    // LOCUS GUARD block counter. After 3 hard blocks, localization is probably wrong
    // (e.g. Django fix file isn't in the grep-ranked top-5). Allow edits through but
    // keep counting misses in telemetry so we can diagnose in postmortem.
    let mut locus_block_count: u32 = 0;

    // Read dedup: track file reads to avoid re-injecting full content
    // Key: (tool_name, canonical_args), Value: (step_number, result)
    let mut read_cache: HashMap<String, (u32, String)> = HashMap::new();
    let mut read_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Track which files have been modified (edits invalidate cache)
    let mut modified_files: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Model profile drives these — no more hardcoded size thresholds
    let history_window = profile.history_window;
    let max_full_read_lines = profile.max_full_read_lines;

    // Localized regions from programmatic recon — used by context cap to suggest ranges
    // Key: filename, Value: vec of (line_num, pattern) from grep hits
    let mut localized_regions: HashMap<String, Vec<(usize, String)>> = HashMap::new();
    // Best localized excerpt per file from the recon pass.
    let mut localized_file_contexts: HashMap<String, String> = HashMap::new();
    let sw_test_files = parse_sw_test_files();

    // Localization summary — re-injected into implementing prompt for re-grounding
    let mut localization_summary = String::new();

    'agent_loop: loop {
        // Per-state model routing or escalation-driven model selection
        let client = if run_config.model_routing.contains_key(&current_state) {
            make_client_for_state(&current_state)
        } else if escalated_model {
            escalation_client.clone()
        } else {
            base_client.clone()
        };

        // Don't abort during testing/review/green_check — these are quick programmatic steps
        // that shouldn't count against the LLM's step budget
        let in_endgame = current_state == "testing"
            || current_state == "review"
            || current_state == "completed"
            || current_state == "green_check"
            || current_state == "red_check";
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
        if matches!(
            state_def.state_type,
            Some(statewright_engine::StateType::Final)
        ) {
            if current_state == "completed" {
                // Summary of what happened
                let changed = tools::all_diff_stats(&args.workdir);
                if !changed.is_empty() {
                    println!("  Bug fixed. {} file(s) modified:", changed.len());
                    for (file, lines_changed, _total) in &changed {
                        println!("    {} — {} line(s) changed", file, lines_changed);
                    }
                }
                emit!(
                    TuiEvent::Completed {
                        steps: step - 1,
                        success: true
                    },
                    format!("\n=== COMPLETED in {} steps ===", step - 1)
                );
            } else {
                emit!(
                    TuiEvent::Completed {
                        steps: step - 1,
                        success: false
                    },
                    format!(
                        "\n=== FAILED ({}) after {} steps ===",
                        current_state,
                        step - 1
                    )
                );
            }
            break;
        }

        // PROGRAMMATIC STATE ENTRY ACTIONS
        // These run automatically when entering a state — no LLM call needed.
        // The state machine does the obvious thing so the model doesn't have to.
        // Guard is == 0 so the block fires BEFORE the first LLM call in the state.
        // (steps_in_current_state is set to 0 on transition; the increment at line ~2733
        //  is below this block and only reached when we fall through to the LLM call.)
        if steps_in_current_state == 0 {
            if current_state == "localizing" {
                // PROGRAMMATIC LOCALIZATION
                // 1. List files
                // 2. Run tests to get failure info
                // 3. Grep source files for keywords from the task/failure
                // 4. Read ±20 lines around each grep hit
                // 5. Feed focused excerpts into conversation for the planning state
                println!(
                    "[Step {}] State: localizing — programmatic bug localization",
                    step
                );

                // === LIP: Language-Agnostic Localization ===

                // Step 1: Discover all source files via git ls-files (or fallback)
                let all_files: Vec<String> = {
                    let git_output = Command::new("git")
                        .args(["ls-files", "--cached", "--others", "--exclude-standard"])
                        .current_dir(&args.workdir)
                        .output();
                    match git_output {
                        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
                            .lines()
                            .map(|s| s.to_string())
                            .collect(),
                        _ => {
                            // Fallback: list_directory top-level
                            tools::execute_tool(
                                "list_directory",
                                &json!({"path": "."}),
                                &args.workdir,
                            )
                            .lines()
                            .map(|s| s.to_string())
                            .collect()
                        }
                    }
                };
                println!("  [LOCALIZE] {} files in repo", all_files.len());

                // Step 2: Detect language + filter source vs test files
                let source_extensions = [
                    "py", "rs", "js", "ts", "jsx", "tsx", "go", "java", "c", "cpp", "h", "hpp",
                    "rb", "php", "kt", "swift", "cs",
                ];
                let test_indicators = [
                    "test_", "tests/", "test/", "_test.", "_test_", ".test.", ".spec.", "__test__",
                    "spec/",
                ];

                let source_files: Vec<&str> = all_files
                    .iter()
                    .filter(|f| {
                        let ext = f.rsplit('.').next().unwrap_or("");
                        source_extensions.contains(&ext)
                            && !test_indicators.iter().any(|t| f.to_lowercase().contains(t))
                            && !f.contains("__pycache__")
                            && !f.contains("node_modules")
                            && !f.contains("/doc/")
                            && !f.contains("/docs/")
                            && !f.contains("/examples/")
                            && !f.contains("/vendor/")
                    })
                    .map(|s| s.as_str())
                    .collect();

                // Detect dominant language
                let mut ext_counts: HashMap<String, usize> = HashMap::new();
                for f in &source_files {
                    if let Some(ext) = f.rsplit('.').next() {
                        *ext_counts.entry(ext.to_string()).or_default() += 1;
                    }
                }
                let dominant_lang = ext_counts
                    .into_iter()
                    .max_by_key(|(_, c)| *c)
                    .map(|(e, _)| e)
                    .unwrap_or_else(|| "py".into());
                println!(
                    "  [LOCALIZE] {} source files, language: {}",
                    source_files.len(),
                    dominant_lang
                );

                // Step 3: Test runner — detect and run if suite is small
                let (test_cmd, test_args) = match dominant_lang.as_str() {
                    "rs" => ("cargo", vec!["test", "--", "--nocapture"]),
                    "go" => ("go", vec!["test", "-v", "./..."]),
                    "js" | "ts" | "jsx" | "tsx" => {
                        if std::path::Path::new(&args.workdir)
                            .join("package.json")
                            .exists()
                        {
                            ("npm", vec!["test", "--"])
                        } else {
                            ("echo", vec!["no test runner"])
                        }
                    }
                    _ => (
                        "python3",
                        vec!["-m", "pytest", "-xvs", "--tb=short", "--no-header", "-q"],
                    ),
                };

                // Count tests before running (pytest-specific for now, skip for others)
                let test_count = if dominant_lang == "py" {
                    let collect_output = if let Ok(test_cmd) = std::env::var("SW_TEST_CMD") {
                        if test_cmd.contains("pytest") {
                            let env_name = std::env::var("SW_TEST_CONDA_ENV")
                                .unwrap_or_else(|_| "testbed".to_string());
                            Command::new("conda")
                                .args([
                                    "run",
                                    "-n",
                                    &env_name,
                                    "--no-capture-output",
                                    "python3",
                                    "-m",
                                    "pytest",
                                    "--collect-only",
                                    "-q",
                                    "--no-header",
                                ])
                                .current_dir(&args.workdir)
                                .output()
                                .ok()
                        } else {
                            None
                        }
                    } else if std::env::var("SW_EVAL_IMAGE").ok().as_deref() == Some("1")
                        && std::process::Command::new("conda")
                            .arg("--version")
                            .output()
                            .is_ok()
                    {
                        let env_name = std::env::var("SW_TEST_CONDA_ENV")
                            .unwrap_or_else(|_| "testbed".to_string());
                        Command::new("conda")
                            .args([
                                "run",
                                "-n",
                                &env_name,
                                "--no-capture-output",
                                "python3",
                                "-m",
                                "pytest",
                                "--collect-only",
                                "-q",
                                "--no-header",
                            ])
                            .current_dir(&args.workdir)
                            .output()
                            .ok()
                    } else {
                        Command::new("python3")
                            .args(["-m", "pytest", "--collect-only", "-q", "--no-header"])
                            .current_dir(&args.workdir)
                            .output()
                            .ok()
                    };

                    collect_output
                        .and_then(|o| {
                            String::from_utf8_lossy(&o.stdout)
                                .lines()
                                .last()
                                .and_then(|l| l.split_whitespace().next())
                                .and_then(|n| n.parse::<usize>().ok())
                        })
                        .unwrap_or(0)
                } else if source_files.len() > 200 {
                    999 // Assume large repo = many tests
                } else {
                    0
                };

                // FIX 5: If SW_TEST_FILES is set (SWE-bench test patch), run those
                // specific test files instead of skipping. This gives the model test
                // feedback on large repos where the full suite would be skipped.
                let scoped_test_files = std::env::var("SW_TEST_FILES").ok();

                let (test_output, test_summary) = if let Some(ref test_files) = scoped_test_files {
                    // Run only the test files from the SWE-bench test patch
                    let files: Vec<&str> =
                        test_files.split(':').filter(|f| !f.is_empty()).collect();
                    println!("  [LOCALIZE] Running scoped tests: {:?}", files);
                    let mut combined_output = String::new();
                    for tf in &files {
                        let output =
                            tools::execute_tool("run_test", &json!({"path": tf}), &args.workdir);
                        combined_output.push_str(&output);
                        combined_output.push('\n');
                    }
                    let summary: String = combined_output
                        .lines()
                        .filter(|l| {
                            l.contains("FAILED")
                                || l.contains("assert")
                                || l.contains("Error")
                                || l.contains("passed")
                        })
                        .take(15)
                        .collect::<Vec<_>>()
                        .join("\n");
                    println!(
                        "  [LOCALIZE] Scoped test results:\n{}",
                        summary.lines().take(5).collect::<Vec<_>>().join("\n")
                    );
                    (combined_output, summary)
                } else if test_count > 100 {
                    println!(
                        "  [LOCALIZE] {} tests detected — skipping full suite",
                        test_count
                    );
                    let skip_msg = format!(
                        "{} tests — too many for full run. Use run_test with a scoped path.",
                        test_count
                    );
                    (skip_msg.clone(), skip_msg)
                } else {
                    let output = tools::execute_tool("run_test", &json!({}), &args.workdir);
                    let summary: String = output
                        .lines()
                        .filter(|l| {
                            l.contains("FAILED")
                                || l.contains("assert")
                                || l.contains("Error")
                                || l.contains("passed")
                        })
                        .take(10)
                        .collect::<Vec<_>>()
                        .join("\n");
                    println!(
                        "  [LOCALIZE] Test failures:\n{}",
                        summary.lines().take(5).collect::<Vec<_>>().join("\n")
                    );
                    (output, summary)
                };

                // Step 4: Extract grep patterns from task + test output
                let mut grep_patterns: Vec<String> = Vec::new();

                // Identifiers with underscores
                for word in args.task.split_whitespace() {
                    let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                    if clean.contains('_') && clean.len() > 3 {
                        grep_patterns.push(clean.to_string());
                    }
                }

                // Class names (capitalized words) → "class ClassName"
                let stopwords = [
                    "The",
                    "This",
                    "When",
                    "Since",
                    "In",
                    "It",
                    "But",
                    "And",
                    "For",
                    "If",
                    "We",
                    "Is",
                    "Are",
                    "Was",
                    "Has",
                    "Have",
                    "Not",
                    "No",
                    "Can",
                    "Do",
                    "Does",
                    "Did",
                    "Will",
                    "Would",
                    "Should",
                    "Could",
                    "May",
                    "Might",
                    "Must",
                    "From",
                    "To",
                    "With",
                    "At",
                    "By",
                    "On",
                    "Of",
                    "A",
                    "An",
                    "Description",
                    "Bug",
                    "Fix",
                    "Error",
                    "Issue",
                    "Version",
                    "File",
                    "Method",
                    "Function",
                    "Note",
                    "See",
                    "Also",
                    // Django/web framework ORM primitives — match everywhere, produce ranking noise
                    "QuerySet",
                    "Model",
                    "Field",
                    "Manager",
                    "View",
                    "Form",
                    "Admin",
                    "Migration",
                    "Serializer",
                    "Permission",
                    "Signal",
                    "Request",
                    "Response",
                    "Django",
                    "Python",
                ];
                // Skip class-name pattern extraction on large repos (>300 source files).
                // Capitalized words from issue descriptions are English prose on framework repos
                // and match every source file uniformly, producing noise not signal.
                if source_files.len() <= 300 {
                    for word in args.task.split_whitespace() {
                        let clean = word.trim_matches(|c: char| !c.is_alphanumeric());
                        if clean.len() > 2
                            && clean.chars().next().map_or(false, |c| c.is_uppercase())
                            && !stopwords.contains(&clean)
                        {
                            grep_patterns.push(format!("class {}", clean));
                        }
                    }
                }

                // Dunder methods (__dict__, __slots__, etc.)
                for word in args.task.split_whitespace() {
                    let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                    if clean.starts_with("__") && clean.ends_with("__") && clean.len() > 4 {
                        grep_patterns.push(clean.to_string());
                        // Complementary pattern
                        if clean == "__dict__" {
                            grep_patterns.push("__slots__".to_string());
                        }
                        if clean == "__slots__" {
                            grep_patterns.push("__dict__".to_string());
                        }
                    }
                }

                // Test function names
                for line in test_summary.lines() {
                    for word in line.split_whitespace() {
                        let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                        if clean.starts_with("test_") && clean.len() > 8 {
                            grep_patterns.push(clean[5..].to_string());
                        }
                    }
                }

                // Assertion targets from test output
                for line in test_output.lines() {
                    if line.contains("assert") {
                        for word in line.split_whitespace() {
                            let clean = word.trim_matches(|c: char| {
                                !c.is_alphanumeric() && c != '_' && c != '.'
                            });
                            if clean.contains('_')
                                && clean.len() > 3
                                && !clean.starts_with("assert")
                            {
                                grep_patterns.push(clean.to_string());
                            }
                        }
                    }
                }

                grep_patterns.sort();
                grep_patterns.dedup();
                let fallback_pattern = match dominant_lang.as_str() {
                    "rs" => "fn ",
                    "go" => "func ",
                    "js" | "ts" => "function ",
                    "rb" => "def ",
                    _ => "def ",
                };
                if grep_patterns.is_empty() {
                    grep_patterns.push(fallback_pattern.to_string());
                }
                println!(
                    "  [LOCALIZE] Patterns: {:?}",
                    &grep_patterns[..grep_patterns.len().min(5)]
                );

                // Step 5: Recursive grep + file ranking by keyword density
                let mut file_scores: HashMap<String, usize> = HashMap::new();
                for pattern in &grep_patterns {
                    // Recursive grep across entire repo (no file arg = -rn on .)
                    let grep_result =
                        tools::execute_tool("grep", &json!({"pattern": pattern}), &args.workdir);
                    if grep_result != "no matches found" {
                        for line in grep_result.lines().take(50) {
                            if let Some(file_path) = line.split(':').next() {
                                // Only count source files, not tests
                                let fp = file_path.to_string();
                                if source_files.iter().any(|&s| s == fp || fp.ends_with(s)) {
                                    *file_scores.entry(fp).or_default() += 1;
                                }
                            }
                        }
                    }
                }

                // Step 6: Language-specific enrichment
                let mut enrichment_context = String::new();

                // Extract class names from task
                let class_names: Vec<String> = args
                    .task
                    .split_whitespace()
                    .filter_map(|w| {
                        let clean = w.trim_matches(|c: char| !c.is_alphanumeric());
                        if clean.len() > 2
                            && clean.chars().next().map_or(false, |c| c.is_uppercase())
                            && !stopwords.contains(&clean)
                        {
                            Some(clean.to_string())
                        } else {
                            None
                        }
                    })
                    .collect();

                if dominant_lang == "py" && !class_names.is_empty() {
                    // Static analysis: grep-based MRO tracing
                    for class_name in &class_names {
                        let mut queue = vec![class_name.clone()];
                        let mut visited = std::collections::HashSet::new();
                        for _ in 0..4 {
                            let mut next = Vec::new();
                            for cls in &queue {
                                if visited.contains(cls) {
                                    continue;
                                }
                                visited.insert(cls.clone());
                                let grep_result = tools::execute_tool(
                                    "grep",
                                    &json!({"pattern": format!("class {}(", cls)}),
                                    &args.workdir,
                                );
                                if grep_result == "no matches found" {
                                    // Also try without parens (base classes with no parents)
                                    let grep2 = tools::execute_tool(
                                        "grep",
                                        &json!({"pattern": format!("class {}:", cls)}),
                                        &args.workdir,
                                    );
                                    if grep2 != "no matches found" {
                                        for line in grep2.lines().take(2) {
                                            if let Some(file) = line.split(':').next() {
                                                *file_scores
                                                    .entry(file.to_string())
                                                    .or_default() += 3;
                                            }
                                        }
                                    }
                                    continue;
                                }
                                for line in grep_result.lines().take(3) {
                                    let parts: Vec<&str> = line.splitn(3, ':').collect();
                                    if parts.len() < 3 {
                                        continue;
                                    }
                                    let file = parts[0];
                                    *file_scores.entry(file.to_string()).or_default() += 3;
                                    let def = parts[2];
                                    if let Some(ps) = def.find('(') {
                                        if let Some(pe) = def.find(')') {
                                            for parent in def[ps + 1..pe].split(',') {
                                                let p = parent.trim();
                                                if !p.is_empty() && p != "object" && p != "type" {
                                                    next.push(p.to_string());
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            if next.is_empty() {
                                break;
                            }
                            queue = next;
                        }
                    }

                    // Dynamic analysis: AST-based class hierarchy introspection
                    // Extract dunder attributes mentioned in the task for checking
                    // Extract dunder attributes from task for hierarchy checking
                    // Special case: __dict__ → check __slots__ (absence of __slots__ causes __dict__)
                    let check_attrs: Vec<&str> = grep_patterns
                        .iter()
                        .filter(|p| p.starts_with("__") && p.ends_with("__"))
                        .map(|s| {
                            if s.as_str() == "__dict__" {
                                "__slots__"
                            } else {
                                s.as_str()
                            }
                        })
                        .collect();

                    for class_name in &class_names {
                        // Use inspect_class tool (AST-based, no import needed)
                        let check_attr = check_attrs.first().copied().unwrap_or("");
                        let result = tools::execute_tool(
                            "inspect_class",
                            &json!({"class": class_name, "attribute": check_attr}),
                            &args.workdir,
                        );

                        if !result.contains("not found") && !result.contains("error") {
                            println!("  [LOCALIZE] Class introspection:\n{}", result.trim());
                            enrichment_context.push_str(&result);
                            enrichment_context.push('\n');
                            // Boost files with MISSING markers
                            for line in result.lines() {
                                if line.contains("MISSING") {
                                    if let Some(at_pos) = line.find(" @ ") {
                                        let file_part = &line[at_pos + 3..];
                                        let file = file_part.split(':').next().unwrap_or("").trim();
                                        if !file.is_empty() {
                                            *file_scores.entry(file.to_string()).or_default() += 10;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // Import trace: BFS from test files through Python import graph.
                // On large framework repos (Django, etc.) the fix file is often
                // transitively imported by the test, not directly grep-matchable.
                // This widens the LOCUS GUARD allowed set without grep noise.
                if dominant_lang == "py" && source_files.len() > 200 {
                    let seed_files: Vec<String> = if let Some(ref tf) = scoped_test_files {
                        tf.split(':').filter(|f| !f.is_empty()).map(|s| s.to_string()).collect()
                    } else {
                        source_files.iter()
                            .filter(|f| test_indicators.iter().any(|t| f.contains(t)))
                            .take(3)
                            .map(|s| s.to_string())
                            .collect()
                    };

                    let mut trace_visited: std::collections::HashSet<String> = std::collections::HashSet::new();
                    let mut hop_queue: std::collections::VecDeque<(String, usize)> = seed_files
                        .into_iter()
                        .map(|f| (f, 0usize))
                        .collect();

                    while let Some((file, hop)) = hop_queue.pop_front() {
                        if hop >= 3 || trace_visited.contains(&file) {
                            continue;
                        }
                        trace_visited.insert(file.clone());
                        let full_path = std::path::Path::new(&args.workdir).join(&file);
                        let content = std::fs::read_to_string(&full_path).unwrap_or_default();
                        let imported = extract_python_imports(&content, &source_files);
                        for imp in imported {
                            if !trace_visited.contains(&imp) {
                                // Score: closer hops rank higher. Don't override grep hits.
                                let trace_score = 3usize.saturating_sub(hop);
                                file_scores.entry(imp.clone()).or_insert(trace_score);
                                // Mark as import-traced so LOCUS GUARD knows about it
                                localized_file_contexts.entry(imp.clone())
                                    .or_insert_with(|| format!("[import-trace hop {}]", hop + 1));
                                hop_queue.push_back((imp, hop + 1));
                            }
                        }
                    }
                    if !trace_visited.is_empty() {
                        println!(
                            "  [IMPORT-TRACE] visited {} files, {} added to locus",
                            trace_visited.len(),
                            localized_file_contexts.len()
                        );
                    }
                }

                // Rank files by score, take top 5
                let mut ranked_files: Vec<(String, usize)> = file_scores.into_iter().collect();
                ranked_files.sort_by(|a, b| b.1.cmp(&a.1));
                let top_files: Vec<&str> = ranked_files
                    .iter()
                    .take(5)
                    .map(|(f, _)| f.as_str())
                    .collect();

                if !ranked_files.is_empty() {
                    println!("  [LOCALIZE] Top files:");
                    for (f, score) in ranked_files.iter().take(5) {
                        println!("    {} (score: {})", f, score);
                    }
                }

                // Build file ranking section for the model's context
                let file_ranking_section = if ranked_files.len() > 1 {
                    let mut s = String::from(
                        "## Most Relevant Files (ranked by keyword density — start with #1)\n",
                    );
                    for (i, (f, score)) in ranked_files.iter().take(5).enumerate() {
                        s.push_str(&format!("{}. `{}` (score: {})\n", i + 1, f, score));
                    }
                    s
                } else {
                    String::new()
                };

                // Step 7: Extract code from top-ranked files
                let mut localized_code = String::new();

                for src_file in &top_files {
                    let file_content =
                        std::fs::read_to_string(std::path::Path::new(&args.workdir).join(src_file))
                            .unwrap_or_default();
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
                                        if extracted_ranges
                                            .iter()
                                            .any(|(s, e)| line_num >= *s && line_num <= *e)
                                        {
                                            continue;
                                        }

                                        // Store for context cap suggestions
                                        localized_regions
                                            .entry(src_file.to_string())
                                            .or_default()
                                            .push((line_num, pattern.to_string()));

                                        // Level 1: Find the function body containing this hit
                                        let (func_start, func_end) =
                                            find_function_body(&file_lines, line_num);
                                        extracted_ranges.push((func_start, func_end));

                                        // Strip docstrings from function body for cleaner context
                                        let mut stripped_body: Vec<(usize, &str)> = Vec::new();
                                        let mut in_docstring = false;
                                        for i in func_start.saturating_sub(1)
                                            ..func_end.min(file_lines.len())
                                        {
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
                                            if in_docstring {
                                                continue;
                                            }
                                            stripped_body.push((i + 1, file_lines[i])); // 1-indexed
                                        }

                                        // Level 2: Within the stripped body, find the hotspot
                                        let test_keywords: Vec<&str> = test_summary
                                            .split_whitespace()
                                            .filter(|w| w.len() > 3)
                                            .collect();
                                        let mut hotspot_line = line_num;
                                        let mut best_score = 0usize;
                                        for (ln, content) in &stripped_body {
                                            let score = test_keywords
                                                .iter()
                                                .filter(|kw| {
                                                    content
                                                        .to_lowercase()
                                                        .contains(&kw.to_lowercase())
                                                })
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
                                        let context_lines: Vec<String> = stripped_body
                                            .iter()
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
                                            format!(
                                                "({} lines, docstrings stripped)\n{}",
                                                context_lines.len(),
                                                context_lines.join("\n")
                                            )
                                        };
                                        localized_file_contexts
                                            .insert(src_file.to_string(), context.clone());
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
                println!(
                    "  [LOCALIZE] Extracted {} lines of relevant code from {} file(s)",
                    excerpt_lines,
                    source_files.len()
                );

                // Save localization for re-grounding in implementing state
                // Extract assertion hints: if test says assert "X" in Y, X is what the code needs
                let mut assertion_hints = Vec::new();
                for line in test_output.lines() {
                    let trimmed = line.trim();
                    // Match: assert "some code" in variable
                    if trimmed.contains("assert") && trimmed.contains("\" in ") {
                        // Extract the quoted string
                        if let Some(start) = trimmed.find('"') {
                            if let Some(end) = trimmed[start + 1..].find('"') {
                                let hint = &trimmed[start + 1..start + 1 + end];
                                if hint.len() > 3 && !hint.contains("assert") {
                                    assertion_hints.push(hint.to_string());
                                }
                            }
                        }
                    }
                    // Match: AssertionError: message containing "code"
                    if trimmed.starts_with("AssertionError:")
                        || trimmed.starts_with("AssertionError:")
                    {
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
                    format!(
                        "\n\n## Assertion Hints\nThe test expects this code to exist in the source:\n{}\nUse insert_between or edit_line to add the missing code.",
                        assertion_hints
                            .iter()
                            .map(|h| format!("  - `{}`", h))
                            .collect::<Vec<_>>()
                            .join("\n")
                    )
                } else {
                    String::new()
                };

                let enrichment_section = if !enrichment_context.is_empty() {
                    format!("\n{}\n", enrichment_context.trim())
                } else {
                    String::new()
                };
                localization_summary = format!(
                    "{}{}\n## Test Failures\n{}\n\n## Relevant Code\n{}{}",
                    file_ranking_section,
                    enrichment_section,
                    test_summary,
                    localized_code,
                    hint_section
                );

                // TEST_INJECTION: append failing test file content so the model has a
                // machine-readable spec to implement against, not just prose description.
                let test_excerpt = sw_test_files_excerpt(&args.workdir);
                if !test_excerpt.is_empty() {
                    localization_summary.push_str(&format!(
                        "\n\n## Failing Tests (your fix must make these pass)\n{}",
                        test_excerpt
                    ));
                    println!(
                        "  [TEST_INJECT] injected {} chars of test content into localization",
                        test_excerpt.len()
                    );
                }

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
                emit!(
                    TuiEvent::Transition {
                        from: from,
                        to: "planning".into(),
                        trigger: Some("LOCALIZED".into()),
                        rationale: Some("Programmatic localization complete".into())
                    },
                    "  [TRANSITION] localizing -> planning"
                );
                continue;
            }

            if current_state == "testing" {
                // Auto-run tests on entry — scope to SW_TEST_FILES like implementing auto-test.
                let testing_scope = scoped_test_file_from_env()
                    .map(|f| json!({"path": f}))
                    .unwrap_or(json!({}));
                let test_result = tools::execute_tool("run_test", &testing_scope, &args.workdir);
                // Runner error (non-zero exit, no assertions) — stay in testing state,
                // let the model call run_test itself or call transition based on its judgment.
                // Do NOT tell the model "tests failed" when the runner is the problem.
                if test_is_runner_error(&test_result) {
                    eprintln!(
                        "  [TESTING] runner error (non-zero, no assertions) — forced review"
                    );
                    // Test runner returned non-zero with no Python traceback or assertion content —
                    // pure harness overhead. Model cannot verify via tests; force a review step
                    // against the test spec before allowing TESTS_PASS.
                    let test_excerpt = sw_test_files_excerpt(&args.workdir);
                    let review_msg = if test_excerpt.is_empty() {
                        "Tests could not run in this environment. Use read_file to carefully \
                         review your implementation against the issue requirements, then call \
                         transition(event=TESTS_PASS) if correct or transition(event=TESTS_FAIL) \
                         to return to implementing.".to_string()
                    } else {
                        format!(
                            "Tests could not run in this environment.\n\n\
                             Verify your implementation against these test requirements:\n{}\n\n\
                             Use read_file to confirm your changes satisfy what these tests expect, \
                             then call transition(event=TESTS_PASS) or transition(event=TESTS_FAIL).",
                            test_excerpt
                        )
                    };
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: review_msg,
                    });
                    // Fall through to normal model step (no continue — model drives)
                } else {
                let passed = test_passed(&test_result);
                let fail_count = test_result
                    .lines()
                    .find(|l| l.contains("failed"))
                    .and_then(|l| l.split_whitespace().next())
                    .unwrap_or("?");

                println!("[Step {}] State: testing — auto-running tests", step);
                // Show test summary
                let test_summary: String = test_result
                    .lines()
                    .filter(|l| l.contains("passed") || l.contains("failed"))
                    .last()
                    .unwrap_or("tests complete")
                    .trim()
                    .to_string();
                println!("  {}", test_summary);
                if passed {
                    emit!(
                        TuiEvent::AutoTest {
                            passed: true,
                            fail_count: 0
                        },
                        "  [AUTO-TEST] ALL PASSED"
                    );
                    // Show what changed
                    let changed = tools::all_diff_stats(&args.workdir);
                    for (file, lines_changed, total) in &changed {
                        emit!(
                            TuiEvent::DiffStats {
                                file: file.clone(),
                                changed: *lines_changed,
                                total: *total
                            },
                            format!(
                                "  Changes: {} ({}/{} lines modified)",
                                file, lines_changed, total
                            )
                        );
                    }
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!(
                            "Tests ran automatically and ALL PASSED:\n{}\n\nProceeding to review.",
                            test_result
                        ),
                    });
                    emit!(
                        TuiEvent::Transition {
                            from: "testing".into(),
                            to: "review".into(),
                            trigger: Some("TESTS_PASS".into()),
                            rationale: Some("All tests passed".into())
                        },
                        "  [TRANSITION] testing -> review"
                    );
                    current_state = "review".into();
                    steps_in_current_state = 0;
                    continue;
                } else {
                    emit!(
                        TuiEvent::AutoTest {
                            passed: false,
                            fail_count: fail_count.parse().unwrap_or(1)
                        },
                        format!(
                            "  [AUTO-TEST] {} failing — returning to implementing",
                            fail_count
                        )
                    );
                    let changed = tools::all_diff_stats(&args.workdir);
                    let oversized = changed
                        .iter()
                        .any(|(_, changed_lines, _)| *changed_lines > profile.max_diff_lines);
                    let touched_test_file = changed
                        .iter()
                        .any(|(path, _, _)| is_test_path(path, &sw_test_files));
                    let restore_required = !changed.is_empty()
                        && (oversized
                            || touched_test_file
                            || test_has_syntax_failure(&test_result));
                    if restore_required {
                        tools::restore_candidate_snapshot(&args.workdir);
                        modified_files.clear();
                        read_cache.clear();
                        read_paths.clear();
                        eprintln!("  [TESTING] structural failure — restored candidate snapshot");
                    } else {
                        eprintln!(
                            "  [TESTING] ordinary failure — keeping source diff for refinement"
                        );
                    }
                    let failure_excerpt = failure_excerpt(&test_result, 20);
                    let retry_instruction = if restore_required {
                        "The rejected candidate patch was restored because it caused a structural failure. Make a smaller source-only attempt."
                    } else if changed.is_empty() {
                        "No source diff is present. Make a source-code edit before testing again."
                    } else {
                        "Your current source diff was kept. Refine it using the failure output."
                    };
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!(
                            "Tests ran automatically and FAILED.\n\n{}\n\nFailure summary:\n{}\n\nFull output:\n{}\n\nYou are back in implementing.",
                            retry_instruction,
                            failure_excerpt,
                            &test_result[..test_result.len().min(3000)]
                        ),
                    });
                    current_state = "implementing".into();
                    steps_in_current_state = 0;
                    println!("  [TRANSITION] testing -> implementing");
                    if restore_required {
                        tools::snapshot_files(&args.workdir);
                        println!(
                            "  [SNAPSHOT] Working directory snapshotted after structural restore"
                        );
                    }
                    continue;
                }
                } // close else (not runner error)
            }
        }

        let allowed_tools = state_def
            .allowed_tools
            .as_ref()
            .cloned()
            .unwrap_or_default();
        let instructions = state_def.instructions.as_deref().unwrap_or("Proceed.");
        let transitions: Vec<(String, String)> = state_def
            .on
            .iter()
            .map(|(event, t)| (event.clone(), t.target().to_string()))
            .collect();

        // Decision checkpoint: max_iterations reached
        let is_checkpoint = state_def
            .max_iterations
            .is_some_and(|max| steps_in_current_state > max);

        // Hard cutoff: if stuck at 3x the max iterations, force transition
        let hard_limit = state_def.max_iterations.map(|m| m * 3);
        if let Some(limit) = hard_limit {
            if steps_in_current_state > limit {
                let next = state_def
                    .safe_next
                    .clone()
                    .or_else(|| {
                        state_def
                            .on
                            .iter()
                            .find(|(e, _)| e.as_str() != "FAIL")
                            .map(|(_, t)| t.target().to_string())
                    })
                    .unwrap_or_else(|| "failed".to_string());
                println!(
                    "[Step {}] HARD LIMIT — forcing {} -> {}",
                    step, current_state, next
                );
                current_state = next;
                steps_in_current_state = 0;
                continue;
            }
        }

        // Only count actual LLM steps against the global budget.
        // Programmatic steps (auto-test, edit gate, checkpoints) don't consume budget.
        step += 1;
        steps_in_current_state += 1;

        if is_checkpoint {
            let hard_max = state_def.max_iterations.unwrap() * 3;
            println!(
                "[Step {}] CHECKPOINT in '{}' — forcing decision (iteration {}/{})",
                step, current_state, steps_in_current_state, hard_max
            );
        } else {
            println!(
                "[Step {}] State: {} ({}/{}) | Tools: [{}]",
                step,
                current_state,
                steps_in_current_state,
                state_def.max_iterations.unwrap_or(99),
                allowed_tools.join(", ")
            );
        }

        let iters_remaining = state_def
            .max_iterations
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
            } else if let Some(hint) = &persistent_hint {
                format!("What is your next action?\n\nNote: {}", hint)
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
                &allowed_tools,
                &transitions,
            );
            let result = match client.chat_with_tools(messages, tool_defs).await {
                Ok(r) => r,
                Err(e) => {
                    // Fall back to raw JSON on native failure
                    eprintln!("  [NATIVE FAILED] {} — falling back to raw JSON", e);
                    // Rebuild messages for raw path
                    let system = build_system_prompt(
                        &args.task,
                        &current_state,
                        instructions,
                        &allowed_tools,
                        &transitions,
                        &args.workdir,
                        is_checkpoint,
                        iters_remaining,
                        false,
                        &localization_summary,
                        reasoning_mode,
                    );
                    let mut msgs = vec![ChatMessage {
                        role: "system".into(),
                        content: system,
                    }];
                    let hs = conversation.len().saturating_sub(history_window);
                    msgs.extend(conversation[hs..].iter().cloned());
                    msgs.push(ChatMessage {
                        role: "user".into(),
                        content: "What is your next action?".into(),
                    });

                    match client.chat(msgs).await {
                        Ok(raw) => {
                            // Parse as raw JSON
                            if let Some(resp) = parse_response(&raw) {
                                if let Some(calls) = resp.tool_calls {
                                    for c in calls {
                                        tool_calls_to_process.push((c.name, c.args));
                                    }
                                }
                                transition_event = resp.transition;
                                transition_error = resp.error;
                                conversation.push(ChatMessage {
                                    role: "assistant".into(),
                                    content: raw,
                                });
                            }
                            // Continue to processing below
                            statewright_agent::ollama_client::ChatResult {
                                content: String::new(),
                                tool_calls: vec![],
                                mode: statewright_agent::ollama_client::ResponseMode::RawJson,
                                reasoning: None,
                            }
                        }
                        Err(e2) => {
                            eprintln!("  [LLM ERROR] {}", e2);
                            break;
                        }
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
                    println!(
                        "  [NATIVE] {}({})",
                        tc.function.name,
                        truncate_json(&args_val, 60)
                    );
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
                if tool_calls_to_process.is_empty()
                    && transition_event.is_none()
                    && !result.content.is_empty()
                {
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

            // Raw file block extraction — models can write files without JSON wrapping.
            // Check BEFORE JSON parse so we don't lose content to parse failures.
            let file_blocks = tools::extract_file_blocks(&raw_response, &args.workdir);
            if !file_blocks.is_empty() {
                for (path, bytes) in &file_blocks {
                    println!("  [FILE BLOCK] wrote {} bytes to {}", bytes, path);
                    modified_files.insert(path.clone());
                }
                // Still try to parse remaining JSON for transitions
                let has_transition =
                    raw_response.contains("\"transition\"") || raw_response.contains("\"event\"");
                if has_transition {
                    if let Some(resp) = parse_response(&raw_response) {
                        transition_event = resp.transition;
                    }
                }
                conversation.push(ChatMessage {
                    role: "assistant".into(),
                    content: raw_response,
                });
                let paths: Vec<&str> = file_blocks.iter().map(|(p, _)| p.as_str()).collect();
                conversation.push(ChatMessage {
                    role: "user".into(),
                    content: format!("Files written: {}. Run tests with run_test to check, or continue writing more files.", paths.join(", ")),
                });
                // Don't fall through to JSON parse — file blocks were the action
            } else {
                let file_block_errors =
                    tools::extract_file_block_errors(&raw_response, &args.workdir);
                if !file_block_errors.is_empty() {
                    conversation.push(ChatMessage {
                        role: "assistant".into(),
                        content: raw_response,
                    });
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: file_block_errors.join("\n"),
                    });
                    continue;
                }
                match parse_response(&raw_response) {
                    Some(resp) => {
                        if let Some(calls) = resp.tool_calls {
                            for c in calls {
                                tool_calls_to_process.push((c.name, c.args));
                            }
                        }
                        transition_event = resp.transition;
                        transition_error = resp.error;
                        conversation.push(ChatMessage {
                            role: "assistant".into(),
                            content: raw_response,
                        });
                    }
                    None => {
                        println!("  [PARSE FAIL] {}", truncate(&raw_response, 200));

                        // Auto-fallback: if this was a write_file that truncated,
                        // extract the path and redo as two-phase create_file.
                        let is_write_file_attempt = raw_response.contains("write_file")
                            && raw_response.contains("\"content\"");
                        if is_write_file_attempt && args.tdd_greenfield {
                            // Extract path from the malformed JSON
                            if let Some(path) = extract_path_from_malformed(&raw_response) {
                                println!(
                                    "  [FALLBACK] write_file parse-failed → retrying as create_file for {}",
                                    path
                                );
                                let full_path =
                                    match tools::validate_new_repo_file(&path, &args.workdir) {
                                        Ok(path) => path,
                                        Err(msg) => {
                                            conversation.push(ChatMessage {
                                                role: "assistant".into(),
                                                content: raw_response,
                                            });
                                            conversation.push(ChatMessage {
                                                role: "user".into(),
                                                content: msg,
                                            });
                                            continue;
                                        }
                                    };
                                // Phase 2: get raw content
                                let recent: Vec<ChatMessage> =
                                    conversation.iter().rev().take(4).rev().cloned().collect();
                                let mut content_messages = vec![ChatMessage {
                                    role: "system".into(),
                                    content: format!(
                                        "You are writing the file {}. Output the COMPLETE file content — every function, every class, every import. \
                                     Do NOT abbreviate. Output ONLY raw code. No markdown, no fences, no JSON. Start with line 1.",
                                        path
                                    ),
                                }];
                                content_messages.extend(recent);
                                content_messages.push(ChatMessage { role: "user".into(), content: format!(
                                "Output the COMPLETE content for `{}` now. This is your ONE chance — output ALL the code.\n\nTASK: {}",
                                path, task
                            )});
                                match client.chat(content_messages).await {
                                    Ok(raw_content) => {
                                        let content = tools::strip_code_fences(&raw_content);
                                        if std::fs::write(&full_path, &content).is_ok() {
                                            let bytes = content.len();
                                            println!(
                                                "  [FALLBACK] Wrote {} bytes to {}",
                                                bytes, path
                                            );
                                            modified_files.insert(path.clone());
                                            conversation.push(ChatMessage {
                                                role: "assistant".into(),
                                                content: raw_response,
                                            });
                                            conversation.push(ChatMessage {
                                                role: "user".into(),
                                                content: format!(
                                                    "Created {} ({} bytes). Run tests or continue.",
                                                    path, bytes
                                                ),
                                            });
                                        } else {
                                            conversation.push(ChatMessage {
                                                role: "assistant".into(),
                                                content: raw_response,
                                            });
                                            conversation.push(ChatMessage {
                                            role: "user".into(),
                                            content: format!("Failed to write {}. Try create_file instead of write_file.", path),
                                        });
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("  [FALLBACK] LLM error: {}", e);
                                        conversation.push(ChatMessage {
                                            role: "assistant".into(),
                                            content: raw_response,
                                        });
                                        conversation.push(ChatMessage {
                                        role: "user".into(),
                                        content: "Your write_file was too large. Use create_file instead.".into(),
                                    });
                                    }
                                }
                                continue;
                            }
                        }

                        // FIX 2: Extract embedded tool calls from prose responses.
                        // Model outputs "Let me try...edit_line{...}" — extract and execute the JSON.
                        let extracted = extract_tool_from_prose(&raw_response);
                        if let Some((tool, args_val)) = extracted {
                            println!("  [PARSE RECOVER] Extracted {} from prose", tool);
                            tool_calls_to_process.push((tool, args_val));
                            conversation.push(ChatMessage {
                                role: "assistant".into(),
                                content: raw_response,
                            });
                            // Don't continue — fall through to tool processing
                        } else {
                            // Standard recovery for truncated writes
                            let recovered = recover_truncated_write(&raw_response, &args.workdir);
                            if let Some(ref path) = recovered {
                                println!(
                                    "  [PARSE RECOVER] Extracted partial write_file to {}",
                                    path
                                );
                                conversation.push(ChatMessage {
                                    role: "assistant".into(),
                                    content: raw_response,
                                });
                                conversation.push(ChatMessage {
                                role: "user".into(),
                                content: format!("Your response was truncated but I saved what I could to {}. Use edit_block to append remaining functions.", path),
                            });
                            } else {
                                conversation.push(ChatMessage {
                                    role: "assistant".into(),
                                    content: raw_response,
                                });
                                conversation.push(ChatMessage {
                                role: "user".into(),
                                content: "Your response was not valid JSON. Respond with ONLY a JSON object: {\"tool_calls\": [{\"name\": \"TOOL\", \"args\": {...}}]}".into(),
                            });
                            }
                            continue;
                        }
                    }
                }
            } // close else (no file blocks)
        }

        // Process tool calls (unified for both modes)
        let mut tool_output = String::new();
        for (tool_name, tool_args) in &tool_calls_to_process {
            // Handle state machine navigation tools
            if tool_name == "transition" {
                // Handle both object args and stringified JSON args
                let resolved_args = match tool_args {
                    serde_json::Value::String(s) => serde_json::from_str::<serde_json::Value>(s)
                        .unwrap_or(serde_json::json!({})),
                    other => other.clone(),
                };
                let event = resolved_args
                    .get("event")
                    .and_then(|e| e.as_str())
                    .unwrap_or("DONE");
                let error = resolved_args
                    .get("error")
                    .and_then(|e| e.as_str())
                    .map(|s| s.to_string());
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
                println!(
                    "  [NAV] get_available_actions -> {}",
                    truncate(&actions_str, 200)
                );
                tool_output.push_str(&format!("=== available actions ===\n{}\n", actions_str));
                continue;
            }

            // Regular tool — enforce access
            let enforcement =
                tool_enforcer::enforce_tools(&definition, &current_state, &[tool_name.clone()]);

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

            let writes_files = is_write_tool(tool_name);
            let targeted_paths = if writes_files {
                targeted_paths_for_tool(tool_name, tool_args, &args.workdir)
            } else {
                Vec::new()
            };

            if writes_files && current_state == "implementing" && profile.read_only_tests {
                let blocked_tests: Vec<String> = targeted_paths
                    .iter()
                    .filter(|path| is_test_path(path, &sw_test_files))
                    .cloned()
                    .collect();
                if !blocked_tests.is_empty() {
                    // Detect path-resolution mismatch: model asked for a non-test path
                    // (e.g. bare "models.py") but resolve_repo_path found only test files.
                    let original_path = tool_args.get("path").and_then(|p| p.as_str()).unwrap_or("");
                    let resolved_to_test = !is_test_path(original_path, &sw_test_files)
                        && blocked_tests.iter().all(|bt| is_test_path(bt, &sw_test_files));
                    let resolution_note = if resolved_to_test {
                        format!(
                            " Note: '{}' was auto-resolved to a test-directory path ('{}') because no source file with that name exists. The source file you need may have a different path — use find_files or list_directory to locate it.",
                            original_path,
                            blocked_tests.join(", ")
                        )
                    } else {
                        String::new()
                    };
                    let msg = format!(
                        "BLOCKED: test files are read-only in this bug-fix harness. Read tests if needed, but modify source files only. Blocked path(s): {}.{}",
                        blocked_tests.join(", "),
                        resolution_note
                    );
                    println!("  [TEST GUARD] {}", msg);
                    tool_output.push_str(&msg);
                    tool_output.push('\n');
                    continue;
                }
            }

            if writes_files
                && current_state == "implementing"
                && profile.enforce_localized_edit_locus
            {
                // Normalize paths: strip leading "./" so "django/foo.py" and
                // "./django/foo.py" compare equal regardless of which the model uses.
                let norm = |p: &str| -> String {
                    let resolved = tools::resolve_repo_path(p, &args.workdir);
                    resolved.strip_prefix("./").unwrap_or(&resolved).to_string()
                };

                let allowed_edit_paths: std::collections::HashSet<String> = localized_regions
                    .keys()
                    .chain(localized_file_contexts.keys())
                    .map(|path| norm(path))
                    .collect();

                let outside_locus: Vec<String> = targeted_paths
                    .iter()
                    .filter(|path| {
                        !allowed_edit_paths.is_empty() && !allowed_edit_paths.contains(&norm(path))
                    })
                    .cloned()
                    .collect();

                if !outside_locus.is_empty() {
                    locus_block_count += 1;
                    if locus_block_count <= 3 {
                        // Hard block for first 3 attempts — teach the model where to look
                        let mut ranked: Vec<String> = allowed_edit_paths.into_iter().collect();
                        ranked.sort();
                        let msg = format!(
                            "BLOCKED: edit target is outside the localized source locus. Requested: {}. Allowed source files: {}",
                            outside_locus.join(", "),
                            ranked.join(", ")
                        );
                        println!("  [LOCUS GUARD] block #{} {}", locus_block_count, msg);
                        tool_output.push_str(&msg);
                        tool_output.push('\n');
                        continue;
                    } else {
                        // Soft: localization is likely wrong — allow through, log miss
                        println!(
                            "  [LOCUS GUARD] block #{} — softened, allowing {} (localization likely wrong)",
                            locus_block_count,
                            outside_locus.join(", ")
                        );
                        // Don't `continue` — fall through to execute the edit
                    }
                }
            }

            if writes_files && current_state == "implementing" && profile.sandbox_failed_edits {
                tools::snapshot_candidate(&args.workdir);
            }

            let is_edit_tool = matches!(
                tool_name.as_str(),
                "edit_line"
                    | "edit_block"
                    | "patch_file"
                    | "apply_patch"
                    | "insert_between"
                    | "write_file"
            );
            if is_edit_tool && current_state == "implementing" {
                let edit_path = tool_args.get("path").and_then(|p| p.as_str()).unwrap_or("");
                let resolved_edit_path = tools::resolve_repo_path(edit_path, &args.workdir);
                let has_read = !resolved_edit_path.is_empty()
                    && read_paths.contains(&resolved_edit_path)
                    && !modified_files.contains(&resolved_edit_path);
                if !has_read && !resolved_edit_path.is_empty() {
                    let full_edit_path =
                        std::path::Path::new(&args.workdir).join(&resolved_edit_path);
                    if full_edit_path.exists() {
                        let file_content =
                            std::fs::read_to_string(&full_edit_path).unwrap_or_default();
                        let line_count = file_content.lines().count();
                        println!(
                            "  [GATE] Edit blocked — {} not read yet, injecting content",
                            resolved_edit_path
                        );

                        let old_arg = tool_args.get("old").and_then(|o| o.as_str()).unwrap_or("");
                        let content_preview = if old_arg.trim().is_empty() {
                            localized_file_contexts
                                .get(&resolved_edit_path)
                                .or_else(|| localized_file_contexts.get(edit_path))
                                .cloned()
                                .unwrap_or_else(|| {
                                    build_readable_excerpt(
                                        &file_content,
                                        localized_regions
                                            .get(&resolved_edit_path)
                                            .or_else(|| localized_regions.get(edit_path)),
                                        old_arg,
                                    )
                                })
                        } else {
                            build_readable_excerpt(
                                &file_content,
                                localized_regions
                                    .get(&resolved_edit_path)
                                    .or_else(|| localized_regions.get(edit_path)),
                                old_arg,
                            )
                        };

                        let cache_key_for_edit = format!("read_file:{}", resolved_edit_path);
                        read_cache.insert(cache_key_for_edit, (step, content_preview.clone()));
                        read_paths.insert(resolved_edit_path.clone());
                        // Injection counts as a re-read — clear modified flag so the
                        // immediately-following edit is not blocked again by the same GATE.
                        modified_files.remove(&resolved_edit_path);
                        gate_fired_this_step = true;

                        let msg = format!(
                            "BLOCKED: You haven't read {} yet. Here are the most relevant candidate loci ({} lines total):\n\n{}\n\nNow retry your edit using the EXACT current text from one candidate above.",
                            resolved_edit_path, line_count, content_preview
                        );
                        tool_output.push_str(&msg);
                        tool_output.push('\n');
                        continue;
                    }
                }
            }

            emit!(TuiEvent::ToolCall {
                name: tool_name.clone(),
                args_preview: truncate_json(tool_args, 200),
            });

            // Read dedup: if this is an unranged read_file for a file we already read
            // and haven't modified since, return a cached summary instead of full content
            let is_read = tool_name == "read_file";
            let is_ranged_read = is_read
                && (tool_args.get("start_line").is_some() || tool_args.get("line_start").is_some());
            let cache_key = format!(
                "{}:{}",
                tool_name,
                serde_json::to_string(tool_args).unwrap_or_default()
            );
            let read_path = tool_args
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("")
                .to_string();

            let mut result = if is_read && !is_ranged_read && !modified_files.contains(&read_path) {
                if let Some((prev_step, prev_result)) = read_cache.get(&cache_key) {
                    let line_count = prev_result.lines().count();
                    let summary = format!(
                        "(cached — already read in step {}, {} lines, unchanged)\n\
                         Use start_line/end_line to re-read specific sections, or make your edit based on the content you already have.",
                        prev_step, line_count
                    );
                    if !json_mode {
                        println!(
                            "  [DEDUP] {}({}) -> cached from step {}",
                            tool_name,
                            truncate_json(tool_args, 60),
                            prev_step
                        );
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
                            println!(
                                "  [CONTEXT CAP] BLOCKED: {} is {} lines (max {} for this model) — use ranged read",
                                read_path, line_count, max_full_read_lines
                            );
                        }
                        let mut suggestion = format!(
                            "BLOCKED: '{}' is {} lines — too large for full read (max {} lines for this model).\n",
                            read_path, line_count, max_full_read_lines
                        );
                        if let Some(excerpt) = localized_file_contexts.get(&read_path) {
                            suggestion.push_str("Relevant excerpt from bug localization:\n");
                            suggestion.push_str(excerpt);
                            suggestion.push('\n');
                            suggestion.push_str(
                                "Use start_line/end_line if you need to inspect adjacent lines.",
                            );
                        } else if let Some(regions) = localized_regions.get(&read_path) {
                            // Add specific range suggestions from localization data
                            suggestion.push_str("Relevant sections from bug localization:\n");
                            for (line_num, pattern) in regions {
                                let start = line_num.saturating_sub(5);
                                let end = line_num + 10;
                                suggestion.push_str(&format!(
                                    "  - '{}' at line {} → use read_file with start_line={}, end_line={}\n",
                                    pattern, line_num, start, end
                                ));
                            }
                            suggestion.push_str(
                                "Use one of these ranges, or use grep to find other sections.",
                            );
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
                        println!(
                            "  [CONTEXT CAP] BLOCKED: {} is {} lines (max {}) — use ranged read",
                            read_path, line_count, max_full_read_lines
                        );
                    }
                    if let Some(excerpt) = localized_file_contexts.get(&read_path) {
                        format!(
                            "BLOCKED: '{}' is {} lines — too large. Relevant excerpt from bug localization:\n\n{}\n\nUse read_file with start_line/end_line if you need a wider window.",
                            read_path, line_count, excerpt
                        )
                    } else {
                        format!(
                            "BLOCKED: '{}' is {} lines — too large. Use read_file with start_line/end_line, or grep to find sections.",
                            read_path, line_count
                        )
                    }
                } else {
                    let r = tools::execute_tool(tool_name, tool_args, &args.workdir);
                    read_cache.insert(cache_key.clone(), (step, r.clone()));
                    r
                }
            } else {
                tools::execute_tool(tool_name, tool_args, &args.workdir)
            };

            if is_read && !read_path.is_empty() && !result.starts_with("error") {
                let resolved_read = tools::resolve_repo_path(&read_path, &args.workdir);
                read_paths.insert(resolved_read.clone());
                // Explicit re-read of a modified file clears the stale-content flag so the
                // next edit attempt is not blocked by GATE (model has fresh content now).
                modified_files.remove(&resolved_read);
            }

            // On edit failure, inject relevant file content to help the next attempt
            let edit_failed = is_edit_tool
                && (result.contains("not found") || result.contains("error: block not found"));
            if edit_failed {
                let edit_path = tool_args.get("path").and_then(|p| p.as_str()).unwrap_or("");
                let old_arg = tool_args.get("old").and_then(|o| o.as_str()).unwrap_or("");
                if !edit_path.is_empty() && !old_arg.is_empty() {
                    let full_edit_path = std::path::Path::new(&args.workdir).join(edit_path);
                    if full_edit_path.exists() {
                        let file_content =
                            std::fs::read_to_string(&full_edit_path).unwrap_or_default();

                        // Track consecutive failures on this specific file.
                        let fail_n = consecutive_locus_fails
                            .entry(edit_path.to_string())
                            .or_insert(0);
                        *fail_n += 1;

                        if *fail_n >= LOCUS_RESET_THRESHOLD {
                            // Threshold hit: inject the full current file so the model's stale
                            // mental model is overwritten with ground truth.  Candidate loci alone
                            // are not enough — the model keeps reconstructing the wrong anchor from
                            // memory.  Showing the whole file forces a re-read.
                            let line_count = file_content.lines().count();
                            // Cap at 400 lines to avoid blowing the context window on huge files;
                            // if the file is larger, show the localized region instead.
                            let body = if line_count <= 400 {
                                file_content.clone()
                            } else {
                                // Use localized region if available, else first 200 + last 100 lines
                                if let Some(regions) = localized_regions.get(edit_path) {
                                    let lines: Vec<&str> =
                                        file_content.lines().collect();
                                    // Span from min to max localized line with ±60 line buffer
                                    let min_ln = regions.iter().map(|(l, _)| *l).min().unwrap_or(1);
                                    let max_ln = regions.iter().map(|(l, _)| *l).max().unwrap_or(1);
                                    let start = min_ln.saturating_sub(61);
                                    let end = (max_ln + 60).min(lines.len());
                                    lines[start..end].join("\n")
                                } else {
                                    let lines: Vec<&str> =
                                        file_content.lines().collect();
                                    let head = lines[..200.min(lines.len())].join("\n");
                                    let tail = lines[lines.len().saturating_sub(100)..].join("\n");
                                    format!("{}\n...[{} lines omitted]...\n{}", head, line_count - 300, tail)
                                }
                            };
                            println!(
                                "  [LOCUS RESET] {} consecutive edit failures on {} — injecting current file content",
                                fail_n, edit_path
                            );
                            result.push_str(&format!(
                                "\n\n[LOCUS RESET] {} consecutive edit failures on this file. \
                                 Your previous edits changed the file and your anchor text no longer exists. \
                                 CURRENT FILE CONTENT ({} lines):\n```\n{}\n```\n\
                                 You MUST use an exact verbatim sequence of lines from the above as your old= value. \
                                 Do NOT reconstruct from memory.",
                                fail_n, line_count, body
                            ));
                            *fail_n = 0;
                        } else {
                            // Below threshold: show candidate loci as before
                            let preview = build_readable_excerpt(
                                &file_content,
                                localized_regions.get(edit_path),
                                old_arg,
                            );
                            if !preview.is_empty() {
                                result.push_str(&format!(
                                    "\n\nEdit anchor was not found. Candidate loci using current file content:\n{}",
                                    preview
                                ));
                            }
                        }
                    }
                }
            }

            // Two-phase file write: intercept CREATE_FILE_READY sentinel.
            // Make a second LLM call for raw file content (no JSON escaping).
            if result.starts_with("CREATE_FILE_READY:") {
                let file_path = result.trim_start_matches("CREATE_FILE_READY:").to_string();
                println!(
                    "  [CREATE FILE] Phase 2: requesting raw content for {}",
                    file_path
                );

                // Build content prompt with task context for the model to work with
                let content_prompt = format!(
                    "Output the COMPLETE content for `{path}` now.\n\
                     This is your ONE chance to write this file — output ALL the code.\n\
                     Output ONLY the file content — no explanations, no code fences, no JSON.\n\
                     Start immediately with line 1 of the file.\n\n\
                     TASK: {task}",
                    path = file_path,
                    task = task,
                );
                // Include recent conversation for context (last 4 messages)
                let recent: Vec<ChatMessage> =
                    conversation.iter().rev().take(4).rev().cloned().collect();
                let mut content_messages = vec![ChatMessage {
                    role: "system".into(),
                    content: format!(
                        "You are writing the file {}. Output the COMPLETE file content — every function, every class, every import. \
                         Do NOT abbreviate, do NOT use comments like '# ... rest of implementation'. \
                         Output ONLY raw code. No markdown, no fences, no JSON. Start with line 1.",
                        file_path
                    ),
                }];
                content_messages.extend(recent);
                content_messages.push(ChatMessage {
                    role: "user".into(),
                    content: content_prompt,
                });

                match client.chat(content_messages).await {
                    Ok(raw_content) => {
                        let content = tools::strip_code_fences(&raw_content);
                        let full_path =
                            match tools::validate_new_repo_file(&file_path, &args.workdir) {
                                Ok(path) => path,
                                Err(msg) => {
                                    tool_output.push_str(&format!("{}\n", msg));
                                    continue;
                                }
                            };
                        match std::fs::write(&full_path, &content) {
                            Ok(()) => {
                                let bytes = content.len();
                                println!("  [CREATE FILE] Wrote {} bytes to {}", bytes, file_path);
                                modified_files.insert(file_path.clone());
                                tool_output.push_str(&format!(
                                    "Created {} ({} bytes)\n",
                                    file_path, bytes
                                ));
                            }
                            Err(e) => {
                                tool_output
                                    .push_str(&format!("error writing {}: {}\n", file_path, e));
                            }
                        }
                    }
                    Err(e) => {
                        tool_output.push_str(&format!("error getting file content: {}\n", e));
                    }
                }
                continue; // Skip auto-test — the file is new, tests will fail until more code is written
            }

            // Track file modifications to invalidate read cache
            let is_edit = writes_files;
            let edit_succeeded = is_edit
                && !result.contains("BLOCKED")
                && !result.contains("error")
                && !result.contains("not found");
            if edit_succeeded {
                for path in &targeted_paths {
                    consecutive_locus_fails.remove(path); // reset per-file locus counter
                    modified_files.insert(path.to_string());
                    read_cache.retain(|k, _| !k.contains(path));
                    read_paths.remove(path);
                }
            }

            // Post-edit auto-test: if an edit landed in implementing, run tests immediately.
            // Count failed edit ATTEMPTS (tool returned error) for corrective hints
            let edit_tool_failed = is_edit && !edit_succeeded && current_state == "implementing";
            if edit_tool_failed {
                edit_fail_count += 1;
                if edit_fail_count >= 2 && persistent_hint.is_none() {
                    persistent_hint = Some("Multiple edit attempts failed. The fix might be in a different file. Try: inspect_class to check inheritance hierarchies, grep to search the codebase, or find_files to locate related files.".into());
                }
            }

            // Pass → short-circuit to completed. Fail + oversized → restore and restrict.
            'auto_test: {
                if !(edit_succeeded && current_state == "implementing") {
                    break 'auto_test;
                }
                // Scope auto-test: prefer SW_TEST_FILES (SWE-bench test patch),
                // then try tests/ near the edited file, then skip on large repos.
                // If SW_TEST_FILES is set but empty (test patch failed to apply),
                // fall through to the adjacent-directory heuristic rather than
                // immediately producing an unresolvable scope.
                let sw_test_first = std::env::var("SW_TEST_FILES").ok().and_then(|tf| {
                    let files: Vec<&str> = tf.split(':').filter(|f| !f.is_empty()).collect();
                    // Prefer a file whose name contains "test" (avoids picking models.py etc.)
                    files
                        .iter()
                        .find(|f| f.contains("test"))
                        .or_else(|| files.first())
                        .map(|s| s.to_string())
                });
                let test_scope = if let Some(f) = sw_test_first {
                    json!({"path": f})
                } else if let Some(edited_path) = tool_args.get("path").and_then(|p| p.as_str()) {
                    let dir = std::path::Path::new(edited_path)
                        .parent()
                        .unwrap_or(std::path::Path::new("."));
                    let test_dir = dir.join("tests");
                    let full_test_dir = std::path::Path::new(&args.workdir).join(&test_dir);
                    if full_test_dir.is_dir() {
                        json!({"path": test_dir.to_string_lossy()})
                    } else if dir.join("test").is_dir()
                        || std::path::Path::new(&args.workdir)
                            .join(dir)
                            .join("test")
                            .is_dir()
                    {
                        json!({"path": dir.join("test").to_string_lossy()})
                    } else {
                        json!({})
                    }
                } else {
                    json!({})
                };
                // Skip auto-test when scope is unresolved — unscoped full-suite
                // runs on large repos produce truncated output with unreliable
                // pass/fail detection (false positives in scikit-learn smoke).
                if test_scope.get("path").is_none() && test_scope.get("file").is_none() {
                    eprintln!("  [AUTO-TEST] no resolvable test scope — skipping");
                    break 'auto_test;
                }
                let test_result = tools::execute_tool("run_test", &test_scope, &args.workdir);
                // If test runner is unavailable, skip feedback entirely — don't lie to the model
                if test_env_unavailable(&test_result) {
                    eprintln!(
                        "  [AUTO-TEST] test runner unavailable — skipping feedback: {}",
                        &test_result[..test_result.len().min(200)]
                    );
                    break 'auto_test;
                }
                if test_is_runner_error(&test_result) {
                    eprintln!(
                        "  [AUTO-TEST] runner error (non-zero exit, no assertions) — skipping feedback: {}",
                        &test_result[..test_result.len().min(200)]
                    );
                    break 'auto_test;
                }
                let all_pass = test_passed(&test_result);
                let changed = tools::all_diff_stats(&args.workdir);
                if changed.is_empty() {
                    eprintln!("  [AUTO-TEST] no diff after edit — skipping");
                    break 'auto_test;
                }
                if all_pass {
                    let diff_summary: Vec<String> = changed
                        .iter()
                        .map(|(f, c, t)| format!("{} ({}/{} lines)", f, c, t))
                        .collect();
                    println!("  [AUTO-TEST] PASS — short-circuiting to completed");
                    println!("  Changes: {}", diff_summary.join(", "));
                    emit!(
                        TuiEvent::Transition {
                            from: "implementing".into(),
                            to: "completed".into(),
                            trigger: Some("AUTO_COMPLETE".into()),
                            rationale: Some("Edit + tests pass".into())
                        },
                        "  [TRANSITION] implementing -> completed (auto)"
                    );
                    current_state = "completed".into();
                    continue 'agent_loop;
                } else {
                    let oversized = changed.iter().any(|(_, c, _)| *c > profile.max_diff_lines);
                    let touched_test_file = changed
                        .iter()
                        .any(|(path, _, _)| is_test_path(path, &sw_test_files));
                    let syntax_level_failure = test_has_syntax_failure(&test_result);
                    let diff_summary: Vec<String> = changed
                        .iter()
                        .map(|(f, c, t)| format!("{} ({}/{} lines)", f, c, t))
                        .collect();
                    if profile.sandbox_failed_edits
                        && (oversized || touched_test_file || syntax_level_failure)
                    {
                        let reason = if touched_test_file {
                            "test file edit"
                        } else if syntax_level_failure {
                            "syntax-level failure"
                        } else {
                            "oversized edit"
                        };
                        println!(
                            "  [AUTO-TEST] FAIL + {} — restoring candidate snapshot",
                            reason
                        );
                        tools::restore_candidate_snapshot(&args.workdir);
                        modified_files.clear();
                        read_cache.clear();
                        read_paths.clear();
                        let fail_detail = failure_excerpt(&test_result, 5);
                        tool_output.push_str(&format!(
                            "Tests FAILED after your edit. The candidate patch was reverted because it was a {}.\nRejected diff: {}\n{}\nTry a smaller source-only edit.\n",
                            reason,
                            diff_summary.join(", "),
                            fail_detail
                        ));
                    } else if oversized {
                        println!("  [AUTO-TEST] FAIL + oversized edit — restoring snapshot");
                        tools::restore_snapshot(&args.workdir);
                        modified_files.clear();
                        read_cache.clear();
                        read_paths.clear();
                        tool_output.push_str("Tests FAILED and your edit changed too many lines. Snapshot restored. Use edit_line for small, targeted changes. You can make multiple small edits — each one is tested automatically.\n");
                    } else {
                        // Small edit, tests failed — keep the edit, let model iterate
                        println!("  [AUTO-TEST] FAIL — edit kept, model can refine");
                        let fail_detail = failure_excerpt(&test_result, 5);
                        let hint = if edit_fail_count >= 2 {
                            "\n\nYou've made multiple failed attempts. The fix might be in a different file. Try: inspect_class to check inheritance hierarchies, grep to search the codebase, or find_files to locate related files."
                        } else {
                            ""
                        };
                        tool_output.push_str(&format!(
                            "Tests FAILED after your edit. Fix the remaining issue.\n{}{}\n",
                            fail_detail, hint
                        ));
                    }
                    // Count failed edit for unified escalation (checked after tool loop)
                    edit_fail_count += 1;
                }
            } // 'auto_test

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
                println!(
                    "  [TOOL] {}({}) -> {}",
                    tool_name,
                    truncate_json(tool_args, 60),
                    truncate(&display_result, 300)
                );
            }
            tool_output.push_str(&format!("=== {} result ===\n{}\n", tool_name, result));
        }

        if !tool_output.is_empty() {
            conversation.push(ChatMessage {
                role: "user".into(),
                content: format!("Tool results:\n{}", tool_output),
            });
        }

        // Escalation: also count non-edit implementing steps as stalls.
        // Exception: a step where GATE fired (blocking an edit and injecting content)
        // is not a stall — the model had a valid edit attempt and received content to work with.
        // Similarly, a step that fired GATE in the previous step (model legitimately reading
        // before re-editing) is not a stall.
        if current_state == "implementing" {
            let any_edit_this_step = tool_calls_to_process
                .iter()
                .any(|(name, _)| is_write_tool(name));
            let gate_exemption = gate_fired_this_step; // this step's GATE block
            gate_fired_this_step = false; // reset for next step
            if !any_edit_this_step && !gate_exemption {
                edit_fail_count += 1;
            }
            // Unified escalation check (fires from both auto-test failures and stalls)
            // Thresholds are intentionally high: model needs 5+ attempts to use GATE-injected
            // candidate loci from error messages before we wipe and restart.
            if edit_fail_count >= 5 && !reasoning_mode && !escalated_model {
                reasoning_mode = true;
                println!(
                    "  [ESCALATE] Level 1: reasoning mode (fail_count={})",
                    edit_fail_count
                );
                // Preserve the last tool result before clearing — it contains GATE-injected
                // candidate lines that show the model what the file actually looks like.
                let last_tool_result = conversation.last().cloned();
                conversation.clear();
                if !localization_summary.is_empty() {
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!(
                            "Previous attempts failed. Here is the localization context:\n{}",
                            localization_summary
                        ),
                    });
                }
                // Re-inject the last error so the model can see actual file content / anchor candidates
                if let Some(msg) = last_tool_result {
                    conversation.push(msg);
                }
            } else if edit_fail_count >= 10 && !escalated_model {
                escalated_model = true;
                reasoning_mode = false;
                println!(
                    "  [ESCALATE] Level 2: switching to {} (fail_count={})",
                    escalation_model, edit_fail_count
                );
                conversation.clear();
                tools::restore_snapshot(&args.workdir);
                modified_files.clear();
                read_cache.clear();
                read_paths.clear();
                if !localization_summary.is_empty() {
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!("Fresh start. Previous model failed after {} attempts. Localization context:\n{}", edit_fail_count, localization_summary),
                    });
                }
            } else if edit_fail_count >= 15 && escalated_model && !reasoning_mode {
                reasoning_mode = true;
                println!(
                    "  [ESCALATE] Level 3: {} + reasoning (fail_count={})",
                    escalation_model, edit_fail_count
                );
                conversation.clear();
                if !localization_summary.is_empty() {
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!(
                            "Last attempt. Read the target file carefully before editing.\n{}",
                            localization_summary
                        ),
                    });
                }
            }
        }

        // Handle transition
        if let Some(raw_event) = &transition_event {
            // Sanitize: model might output "DONE -> testing" instead of "DONE"
            let event = raw_event
                .split_whitespace()
                .next()
                .unwrap_or(raw_event)
                .trim();

            if event == "FAIL" {
                // Intercept FAIL: escalate instead of giving up if escalation is available
                if !escalated_model {
                    edit_fail_count = 4; // Force Level 2
                    escalated_model = true;
                    reasoning_mode = false;
                    println!(
                        "  [FAIL → ESCALATE] Model gave up — switching to {}",
                        escalation_model
                    );
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
                        let msg = result
                            .approval_message
                            .as_deref()
                            .unwrap_or("Approval required");
                        println!("\n  [APPROVAL GATE] {}", msg);
                        // In production, this is where the system parks and waits for human input.
                        // For the demo, transition to the approval state and let the LLM handle it.
                        emit!(
                            TuiEvent::Transition {
                                from: current_state.clone(),
                                to: result.new_state.clone(),
                                trigger: transition_event.clone(),
                                rationale: None
                            },
                            format!("  [TRANSITION] {} -> {}", current_state, result.new_state)
                        );
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
                            println!(
                                "  [EDIT GATE] BLOCKED — no files changed. You must edit before transitioning."
                            );
                            conversation.push(ChatMessage {
                                role: "user".into(),
                                content: format!(
                                    "BLOCKED: You have not edited any files. You MUST use {} to make a change before calling transition. Do it now.",
                                    preferred_edit_tools(&allowed_tools)
                                ),
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
                                println!(
                                    "  [MINIMIZER] REJECTED — {} changed {} lines (max {}). Restoring and retrying.",
                                    file, changed, profile.max_diff_lines
                                );
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
                            println!(
                                "  [MINIMIZER] Staying in 'implementing' — fix must be smaller"
                            );
                            continue;
                        }
                    }

                    emit!(
                        TuiEvent::Transition {
                            from: current_state.clone(),
                            to: result.new_state.clone(),
                            trigger: transition_event.clone(),
                            rationale: None
                        },
                        format!("  [TRANSITION] {} -> {}", current_state, result.new_state)
                    );
                    current_state = result.new_state;
                    context = result.new_context;
                    steps_in_current_state = 0;
                    // Reset per-state caches
                    read_cache.clear();
                    read_paths.clear();
                    modified_files.clear();
                }
                Err(e) => {
                    let msg = format!("Invalid transition: {}", e);
                    println!("  [TRANSITION ERROR] {}", msg);
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!(
                            "That transition was invalid: {}. Try a different action.",
                            e
                        ),
                    });
                }
            }
        }
    }

    // Final verification — scope to SW_TEST_FILES if available so we test the
    // same patch-specific tests that auto-test used, not the full suite.
    // An unscoped full-suite run can produce false positives on large repos
    // (the bug-specific tests may be in the truncated/middle section of output).
    println!("\n--- Final Verification ---");
    let final_test_scope = std::env::var("SW_TEST_FILES")
        .ok()
        .and_then(|tf| {
            let files: Vec<&str> = tf.split(':').filter(|f| !f.is_empty()).collect();
            files
                .iter()
                .find(|f| f.contains("test"))
                .or_else(|| files.first())
                .map(|s| s.to_string())
        })
        .map(|f| json!({"path": f}))
        .unwrap_or(json!({}));
    // Guard: if no edits were made (empty git diff), the agent didn't fix anything.
    // A passing test on an unmodified repo is not a solve.
    // Use git diff rather than the snapshot system — snapshots aren't populated
    // when --no-restore is set (SWE-bench eval-image mode).
    let git_diff_empty = std::process::Command::new("git")
        .args(["diff", "--quiet"])
        .current_dir(&args.workdir)
        .status()
        .map(|s| s.success())
        .unwrap_or(true);
    if git_diff_empty {
        println!("[FINAL_VERIFICATION] FAIL — no edits were made");
        println!("[FINAL_VERIFICATION] FAIL");
        return;
    }
    let test_result = tools::execute_tool("run_test", &final_test_scope, &args.workdir);
    if test_env_unavailable(&test_result) {
        println!("[FINAL_VERIFICATION] UNAVAILABLE");
    } else if test_passed(&test_result) {
        println!("[FINAL_VERIFICATION] PASS");
        println!("[SUCCESS] All tests pass!");
    } else {
        println!("[FINAL_VERIFICATION] FAIL");
        let lines: Vec<&str> = test_result.lines().collect();
        let summary_start = lines
            .iter()
            .position(|l| l.contains("FAILED") || l.contains("passed"))
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
        let after_first = trimmed
            .find('\n')
            .map(|i| &trimmed[i + 1..])
            .unwrap_or(trimmed);
        after_first
            .strip_suffix("```")
            .unwrap_or(after_first)
            .trim()
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
            let candidate = &cleaned[start..=end];
            if let Ok(r) = serde_json::from_str::<LlmResponse>(candidate) {
                // Only accept if it has actual content — otherwise fall through
                // to bare event/transition parsers below
                if r.transition.is_some() || r.tool_calls.is_some() || r.error.is_some() {
                    return Some(r);
                }
            } else if cleaned.contains("}]") {
                // serde_json rejected the extracted candidate.
                // Heal: qwen3:8b omits closing } for tool_call objects before ].
                // Pattern: {"tool_calls": [{"name": "...", "args": {...}], "transition": "T"}]}
                //                                                       ^--- missing } here
                // Apply }]→}}] to raw cleaned (not candidate — candidate may include
                // trailing ]} garbage that prevents the brace extractor from stopping
                // at the right }), then re-run brace extraction.
                let healed = cleaned.replacen("}]", "}}]", 1);
                if let Some(h_start) = healed.find('{') {
                    let h_bytes = healed.as_bytes();
                    let mut h_depth = 0i32;
                    let mut h_in_string = false;
                    let mut h_escape = false;
                    let mut h_end = h_start;
                    for i in h_start..h_bytes.len() {
                        if h_escape {
                            h_escape = false;
                            continue;
                        }
                        match h_bytes[i] {
                            b'\\' if h_in_string => h_escape = true,
                            b'"' => h_in_string = !h_in_string,
                            b'{' if !h_in_string => h_depth += 1,
                            b'}' if !h_in_string => {
                                h_depth -= 1;
                                if h_depth == 0 {
                                    h_end = i;
                                    break;
                                }
                            }
                            _ => {}
                        }
                    }
                    if h_depth == 0 && h_end > h_start {
                        if let Ok(r) =
                            serde_json::from_str::<LlmResponse>(&healed[h_start..=h_end])
                        {
                            if r.transition.is_some()
                                || r.tool_calls.is_some()
                                || r.error.is_some()
                            {
                                return Some(r);
                            }
                        }
                    }
                }
            }
        }
    }

    // Handle bare {"event": "..."} as a transition
    if let Ok(obj) = serde_json::from_str::<serde_json::Value>(cleaned) {
        if let Some(event) = obj.get("event").and_then(|e| e.as_str()) {
            return Some(LlmResponse {
                transition: None,
                error: obj
                    .get("error")
                    .and_then(|e| e.as_str())
                    .map(|s| s.to_string()),
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

/// Try to extract a write_file call from a truncated/malformed JSON response.
/// Returns the path written if recovery succeeded.
/// FIX 2: Extract a tool call embedded in prose.
/// Handles patterns like: "Let me try...edit_line{"path": "..."}" or "I'll use grep{"pattern": "..."}"
fn extract_tool_from_prose(raw: &str) -> Option<(String, serde_json::Value)> {
    let tool_names = [
        "edit_line",
        "edit_block",
        "patch_file",
        "grep",
        "read_file",
        "list_directory",
        "find_files",
        "run_test",
        "write_file",
        "transition",
    ];

    for tool in &tool_names {
        // Look for tool_name{ or tool_name({ patterns
        if let Some(idx) = raw
            .find(&format!("{}{{", tool))
            .or_else(|| raw.find(&format!("{}({{", tool)))
        {
            let json_start = raw[idx..].find('{')? + idx;
            // Try to find matching closing brace
            let mut depth = 0;
            let mut json_end = None;
            for (i, ch) in raw[json_start..].char_indices() {
                match ch {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            json_end = Some(json_start + i + 1);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            if let Some(end) = json_end {
                let json_str = &raw[json_start..end];
                if let Ok(args) = serde_json::from_str::<serde_json::Value>(json_str) {
                    return Some((tool.to_string(), args));
                }
            }
        }
    }

    // Also try: {"tool_calls": [...]} or {"name": "tool", "args": {...}} embedded in prose
    if let Some(idx) = raw.find("{\"tool_calls\"") {
        let mut depth = 0;
        let mut end = None;
        for (i, ch) in raw[idx..].char_indices() {
            match ch {
                '{' | '[' => depth += 1,
                '}' | ']' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(idx + i + 1);
                        break;
                    }
                }
                _ => {}
            }
        }
        if let Some(e) = end {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw[idx..e]) {
                if let Some(calls) = parsed.get("tool_calls").and_then(|c| c.as_array()) {
                    if let Some(first) = calls.first() {
                        let name = first
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("")
                            .to_string();
                        let args = first.get("args").cloned().unwrap_or(serde_json::json!({}));
                        if !name.is_empty() {
                            return Some((name, args));
                        }
                    }
                }
            }
        }
    }

    None
}

fn recover_truncated_write(raw: &str, workdir: &str) -> Option<String> {
    // Look for write_file pattern: "name": "write_file" ... "path": "..." ... "content": "..."
    if !raw.contains("write_file") {
        return None;
    }

    // Extract path
    let path_marker = r#""path":"#;
    let path_start = raw.find(path_marker)?;
    let after_path = &raw[path_start + path_marker.len()..];
    let after_path = after_path.trim_start();
    if !after_path.starts_with('"') {
        return None;
    }
    let path_end = after_path[1..].find('"')?;
    let path = &after_path[1..1 + path_end];

    // Extract content (may be truncated)
    let content_marker = r#""content":"#;
    let content_start = raw.find(content_marker)?;
    let after_content = &raw[content_start + content_marker.len()..];
    let after_content = after_content.trim_start();
    if !after_content.starts_with('"') {
        return None;
    }

    // Find the content string — it may be truncated (no closing quote)
    let content_body = &after_content[1..];
    let content = if let Some(end) = find_unescaped_quote(content_body) {
        &content_body[..end]
    } else {
        // Truncated — take everything up to the last complete line
        let last_newline = content_body.rfind("\\n").unwrap_or(content_body.len());
        &content_body[..last_newline]
    };

    // Unescape the JSON string
    let unescaped = content
        .replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace("\\\"", "\"")
        .replace("\\\\", "\\");

    if unescaped.len() < 20 {
        return None;
    } // Too small to be useful

    let full_path = match tools::validate_existing_repo_file(path, workdir) {
        Ok(path) => path,
        Err(msg) => {
            println!("  [PARSE RECOVER] {}", msg);
            return None;
        }
    };
    std::fs::write(&full_path, &unescaped).ok()?;
    println!(
        "  [PARSE RECOVER] Wrote {} bytes (possibly truncated) to {}",
        unescaped.len(),
        path
    );
    Some(path.to_string())
}

/// Extract file path from a malformed write_file JSON response.
fn extract_path_from_malformed(raw: &str) -> Option<String> {
    // Look for "path": "..." pattern
    let marker = r#""path":"#;
    let start = raw.find(marker)?;
    let after = &raw[start + marker.len()..].trim_start();
    if !after.starts_with('"') {
        return None;
    }
    let end = after[1..].find('"')?;
    let path = &after[1..1 + end];
    if path.is_empty() || path.contains("..") {
        return None;
    }
    // Strip leading ./ if present
    Some(path.trim_start_matches("./").to_string())
}

fn find_unescaped_quote(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == b'"' {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        // Find a valid char boundary at or before max
        let mut end = max;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...", &s[..end])
    }
}

fn truncate_json(v: &serde_json::Value, max: usize) -> String {
    let s = serde_json::to_string(v).unwrap_or_default();
    truncate(&s, max)
}
