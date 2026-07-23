mod baseline_qualification;
mod candidate_bank;
mod candidate_context;
mod candidate_evidence;
mod candidate_fanout;
mod candidate_strengthening;
mod candidate_validation;
mod causal_checkpoint;
mod causal_control;
mod causal_repair;
mod causal_validation;
mod locus_guard;
mod model_registry;
mod observation;
mod patch_authority;
mod recovery;
mod repair_feedback;
mod solver_test_plan;
mod task_reproducer;
mod tdd;
mod tdd_chain;
mod test_map;
mod test_runtime;
mod tools;
mod validation_oracle;

use clap::Parser;
use serde::{Deserialize, Serialize};
use serde_json::json;
use statewright_agent::ollama_client::{OllamaClient, OllamaConfig, OllamaError};
use statewright_agent::prompt_templates::ChatMessage;
use statewright_agent::tool_enforcer;
use statewright_agent::tool_protocol::{
    ProtocolConversation, ToolInvocation, ToolProtocolMessage, ToolResultMessage,
    canonicalize_native_calls, fold_reasoning_into_content, invocation_from_native,
    unstructured_invocation,
};
use statewright_agent::validator::validate_agent_machine;
use statewright_cli::events::{self, TuiEvent};
use statewright_engine::{MachineDefinition, TransitionDef};
use std::collections::{HashMap, HashSet};
use std::process::Command;

fn retryable_llm_transport_error(error: &OllamaError) -> bool {
    match error {
        OllamaError::Http(err) => {
            err.is_connect()
                || err.is_timeout()
                || err.status().is_none()
                || err
                    .status()
                    .is_some_and(|status| status.as_u16() == 429 || status.is_server_error())
        }
        OllamaError::NoResponse => true,
        OllamaError::ParseError(_) => false,
    }
}

fn llm_transport_backoff_secs(consecutive_failures: u32) -> u64 {
    if consecutive_failures == 0 {
        return 0;
    }
    let base = 15u64
        .saturating_mul(2u64.saturating_pow(consecutive_failures.saturating_sub(1)))
        .min(120);
    base + retry_jitter_secs((base / 2).min(30).max(1))
}

fn retry_jitter_secs(max_inclusive: u64) -> u64 {
    if max_inclusive == 0 {
        return 0;
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    (nanos ^ u64::from(std::process::id())) % (max_inclusive + 1)
}

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
            let mut orig_failed = false;
            let mut log_failed = false;

            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if !orig_failed {
                            if let Err(err) = writeln!(orig, "{}", line) {
                                eprintln!("[STDOUT_TEE] original stdout write failed: {err}");
                                orig_failed = true;
                            }
                        }
                        if !log_failed {
                            if let Err(err) = writeln!(log, "{}", line) {
                                eprintln!("[STDOUT_TEE] log write failed path={log_path}: {err}");
                                log_failed = true;
                            }
                        }
                    }
                    Err(err) => {
                        eprintln!("[STDOUT_TEE] pipe read failed path={log_path}: {err}");
                        break;
                    }
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
        if let Err(err) = std::io::stdout().flush() {
            eprintln!("[STDOUT_TEE] stdout flush failed: {err}");
        }
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

    /// Hardcoded bug-fix machine variant: legacy/v1 or structured/v2. Env override: SW_HARDCODED_MACHINE
    #[arg(long, default_value = "legacy")]
    hardcoded_machine: String,

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

fn load_run_config_from_path(config_path: &str) -> Result<RunConfig, String> {
    let config_str = std::fs::read_to_string(config_path)
        .map_err(|err| format!("read_failed path={} error={}", config_path, err))?;
    serde_json::from_str(&config_str)
        .map_err(|err| format!("parse_failed path={} error={}", config_path, err))
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct InspectClassLocation {
    file: String,
    line: usize,
    missing_attr: bool,
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

fn inspect_class_locations(output: &str) -> Vec<InspectClassLocation> {
    let mut locations = Vec::new();
    for line in output.lines() {
        let Some((_class_part, location_part)) = line.split_once(" @ ") else {
            continue;
        };
        let location = location_part.trim();
        let Some((file, line_part)) = location.split_once(':') else {
            continue;
        };
        let line_digits: String = line_part
            .chars()
            .take_while(|ch| ch.is_ascii_digit())
            .collect();
        let Ok(line_num) = line_digits.parse::<usize>() else {
            continue;
        };
        let file = file.trim().trim_start_matches("./");
        if file.is_empty() || file.starts_with('/') || file.contains("..") {
            continue;
        }
        let candidate = InspectClassLocation {
            file: file.to_string(),
            line: line_num,
            missing_attr: line.contains("MISSING"),
        };
        if !locations.iter().any(|existing| existing == &candidate) {
            locations.push(candidate);
        }
    }
    locations
}

fn class_introspection_excerpt(
    workdir: &str,
    file: &str,
    line_num: usize,
    class_name: &str,
) -> Option<String> {
    let file_content = read_optional_repo_file(workdir, file, "class introspection excerpt")?;
    let file_lines: Vec<&str> = file_content.lines().collect();
    if file_lines.is_empty() {
        return None;
    }

    let (start, end) = find_function_body(&file_lines, line_num);
    let start = start.max(1).min(file_lines.len());
    let end = end.max(start).min(file_lines.len());
    let context_lines: Vec<String> = file_lines[start.saturating_sub(1)..end]
        .iter()
        .enumerate()
        .map(|(idx, content)| format!("{:>4}: {}", start + idx, content))
        .collect();
    Some(format!(
        "(class introspection: {}; {} lines)\n{}",
        class_name,
        context_lines.len(),
        context_lines.join("\n")
    ))
}

fn read_optional_repo_file(workdir: &str, file: &str, context: &str) -> Option<String> {
    let path = std::path::Path::new(workdir).join(file);
    match std::fs::read_to_string(&path) {
        Ok(content) => Some(content),
        Err(err) => {
            eprintln!(
                "[LOCALIZE] optional file read failed context=\"{}\" path={} error={}",
                context,
                path.display(),
                err
            );
            None
        }
    }
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

#[derive(Clone, Debug, Default, Serialize)]
struct ProblemShapeFile {
    path: String,
    score: usize,
    reasons: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
struct ProblemShape {
    top_files: Vec<ProblemShapeFile>,
    trusted_test_scope: bool,
    advisory_test_files: Vec<String>,
    advisory_test_labels: Vec<String>,
    advisory_test_candidates: Vec<SourceTestCandidate>,
    feedback_scope_promoted: bool,
    top_file_limit: usize,
}

#[derive(Clone, Debug, Serialize)]
struct PatchHypothesis {
    id: usize,
    path: String,
    score: usize,
    reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SourceLocusIntel {
    path: String,
    source: &'static str,
    detail: String,
}

#[derive(Clone, Debug, Serialize)]
struct PatchAttemptEvent {
    event: String,
    hypothesis_id: usize,
    path: String,
    score: usize,
    reason: String,
    outcome: String,
    detail: String,
}

#[derive(Clone, Debug, Serialize)]
struct RepairTestScopeSummary {
    trusted: bool,
    feedback_promoted: bool,
    advisory_files: Vec<String>,
    advisory_labels: Vec<String>,
    advisory_candidates: Vec<SourceTestCandidate>,
}

#[derive(Clone, Debug, Serialize)]
struct RepairEvidenceGraph {
    schema_version: u32,
    artifact: &'static str,
    official_verifier_boundary: &'static str,
    problem_shape: ProblemShape,
    policy: Option<CluSolverPolicy>,
    test_scope: RepairTestScopeSummary,
    hypotheses: Vec<PatchHypothesis>,
}

#[derive(Clone, Debug, Serialize)]
struct CluGuardPolicy {
    off_hypothesis_edit_threshold: u32,
    path_argument_failure_threshold: u32,
    hypothesis_step_budget: u32,
    scope_validation_timeout_seconds: usize,
    scope_validation_total_seconds: usize,
    scope_validation_max_candidates: usize,
    candidate_bank_reanchor_quarantine_after: u32,
}

#[derive(Clone, Debug, Serialize)]
struct CluPlan {
    schema_version: u32,
    artifact: &'static str,
    scoring_boundary: &'static str,
    profile: String,
    workflow_lane: String,
    state_machine_lane: String,
    candidate_budget: usize,
    patch_tournament_mode: String,
    hypothesis_agenda: Vec<PatchHypothesis>,
    guard_policy: CluGuardPolicy,
    selection_policy: Vec<String>,
    reasons: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
struct HypothesisLedgerEntry {
    id: usize,
    path: String,
    score: usize,
    reason: String,
    status: String,
    rank: usize,
}

#[derive(Clone, Debug, Serialize)]
struct HypothesisLedger {
    schema_version: u32,
    artifact: &'static str,
    active_hypothesis_id: Option<usize>,
    exhausted: bool,
    reason: String,
    hypotheses: Vec<HypothesisLedgerEntry>,
}

#[derive(Clone, Debug, Serialize)]
struct PatchCandidateEvent {
    event: &'static str,
    candidate_id: String,
    hypothesis_id: usize,
    path: String,
    score: usize,
    reason: String,
    outcome: String,
    detail: String,
    scoring_note: &'static str,
}

#[derive(Clone, Debug, Serialize)]
struct SelectionReport {
    schema_version: u32,
    artifact: &'static str,
    scoring_note: &'static str,
    active_hypothesis_id: Option<usize>,
    active_path: Option<String>,
    exhausted: bool,
    reason: String,
    candidate_count: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct ScoutRouteDecision {
    schema_version: u32,
    artifact: &'static str,
    official_verifier_boundary: &'static str,
    enabled: bool,
    lane_escalation_enabled: bool,
    route: String,
    fanout_enabled: bool,
    original_hypothesis_count: usize,
    retained_hypothesis_count: usize,
    max_top_files: usize,
    min_ratio_percent: usize,
    max_hypotheses: usize,
    cheap_hypothesis_limit: usize,
    probe_child_timeout_seconds: u64,
    promoted_min_ratio_percent: usize,
    promoted_min_top_score: usize,
    promoted_hypothesis_limit: usize,
    progressive_hypothesis_limit: usize,
    progressive_fanout_max_candidates: usize,
    progressive_fanout_concurrency: usize,
    progressive_child_max_steps: usize,
    progressive_child_timeout_seconds: u64,
    full_hypothesis_limit: usize,
    full_fanout_max_candidates: usize,
    full_fanout_concurrency: usize,
    full_child_max_steps: usize,
    full_child_timeout_seconds: u64,
    route_fanout_wall_seconds: u64,
    route_fanout_timeout_stop_count: usize,
    escalation_lanes: Vec<ScoutLaneDecision>,
    reasons: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct ScoutLaneDecision {
    name: String,
    reason: String,
    hypothesis_limit: usize,
    max_candidates: usize,
    concurrency: usize,
    child_max_steps: usize,
    child_timeout_seconds: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ScoutRouteSettings {
    lane_escalation_enabled: bool,
    max_top_files: usize,
    min_ratio_percent: usize,
    max_hypotheses: usize,
    cheap_hypothesis_limit: usize,
    probe_child_timeout_seconds: u64,
    promoted_min_ratio_percent: usize,
    promoted_min_top_score: usize,
    promoted_hypothesis_limit: usize,
    progressive_hypothesis_limit: usize,
    progressive_fanout_max_candidates: usize,
    progressive_fanout_concurrency: usize,
    progressive_child_max_steps: usize,
    progressive_child_timeout_seconds: u64,
    full_hypothesis_limit: usize,
    full_fanout_max_candidates: usize,
    full_fanout_concurrency: usize,
    full_child_max_steps: usize,
    full_child_timeout_seconds: u64,
    route_fanout_wall_seconds: u64,
    route_fanout_timeout_stop_count: usize,
}

impl ScoutRouteSettings {
    fn from_env() -> Self {
        Self {
            lane_escalation_enabled: scout_lane_escalation_enabled(),
            max_top_files: scout_max_top_files(),
            min_ratio_percent: scout_min_ratio_percent(),
            max_hypotheses: scout_max_hypotheses(),
            cheap_hypothesis_limit: scout_cheap_hypothesis_limit(),
            probe_child_timeout_seconds: scout_probe_child_timeout_seconds(),
            promoted_min_ratio_percent: scout_promoted_min_ratio_percent(),
            promoted_min_top_score: scout_promoted_min_top_score(),
            promoted_hypothesis_limit: scout_promoted_hypothesis_limit(),
            progressive_hypothesis_limit: scout_progressive_hypothesis_limit(),
            progressive_fanout_max_candidates: scout_progressive_fanout_max_candidates(),
            progressive_fanout_concurrency: scout_progressive_fanout_concurrency(),
            progressive_child_max_steps: scout_progressive_child_max_steps(),
            progressive_child_timeout_seconds: scout_progressive_child_timeout_seconds(),
            full_hypothesis_limit: scout_full_hypothesis_limit(),
            full_fanout_max_candidates: scout_full_fanout_max_candidates(),
            full_fanout_concurrency: scout_full_fanout_concurrency(),
            full_child_max_steps: scout_full_child_max_steps(),
            full_child_timeout_seconds: scout_full_child_timeout_seconds(),
            route_fanout_wall_seconds: scout_route_fanout_wall_seconds(),
            route_fanout_timeout_stop_count: scout_route_fanout_timeout_stop_count(),
        }
    }
}

fn normalize_problem_shape_path(path: &str) -> String {
    path.trim().trim_start_matches("./").to_string()
}

fn is_problem_shape_source_path(path: &str) -> bool {
    let normalized = normalize_problem_shape_path(path);
    if normalized.is_empty() || normalized.starts_with('/') || normalized.contains("..") {
        return false;
    }
    let Some(extension) = std::path::Path::new(&normalized)
        .extension()
        .and_then(|ext| ext.to_str())
    else {
        return false;
    };
    if !matches!(extension, "py" | "pyx" | "pxd" | "c" | "h" | "cpp") {
        return false;
    }

    let lower = normalized.to_ascii_lowercase();
    let components: Vec<&str> = lower.split('/').collect();
    if components.iter().any(|part| {
        matches!(
            *part,
            "tests" | "test" | "doc" | "docs" | "release" | "releases" | ".ci" | "ci" | "bin"
        )
    }) {
        return false;
    }

    !matches!(components.last().copied(), Some("setup.py"))
}

fn update_reanchor_quarantine_for_paths(
    restore_counts: &mut HashMap<String, u32>,
    quarantined_paths: &mut HashSet<String>,
    changed_paths: &[String],
    retained_candidate_paths: &HashSet<String>,
    threshold: u32,
) -> Vec<String> {
    if threshold == 0 || retained_candidate_paths.is_empty() {
        return Vec::new();
    }

    let mut newly_quarantined = Vec::new();
    for raw_path in changed_paths {
        let path = normalize_problem_shape_path(raw_path);
        if !retained_candidate_paths.contains(&path) {
            continue;
        }

        let count = restore_counts.entry(path.clone()).or_insert(0);
        *count += 1;
        if *count >= threshold && quarantined_paths.insert(path.clone()) {
            newly_quarantined.push(path);
        }
    }
    newly_quarantined
}

impl ProblemShape {
    fn from_ranked_files(
        ranked_files: &[(String, usize)],
        explicit_source_paths: &[String],
        localized_regions: &HashMap<String, Vec<(usize, String)>>,
        localized_file_contexts: &HashMap<String, String>,
        trusted_test_scope: bool,
        advisory_test_files: &[String],
        advisory_test_labels: &[String],
        advisory_test_candidates: &[SourceTestCandidate],
        feedback_scope_promoted: bool,
        limit: usize,
    ) -> Self {
        let explicit_normalized: HashSet<String> = explicit_source_paths
            .iter()
            .map(|path| normalize_problem_shape_path(path))
            .collect();
        let mut by_path: HashMap<String, ProblemShapeFile> = HashMap::new();

        for (raw_path, score) in ranked_files {
            let normalized_path = normalize_problem_shape_path(raw_path);
            if !is_problem_shape_source_path(&normalized_path) {
                continue;
            }

            let mut adjusted_score = *score;
            let mut reasons = Vec::new();
            if explicit_normalized.contains(&normalized_path) {
                adjusted_score = adjusted_score.saturating_add(200);
                reasons.push("explicit issue path".to_string());
            }

            let regions = localized_regions
                .get(raw_path)
                .or_else(|| localized_regions.get(&normalized_path));
            if let Some(regions) = regions {
                adjusted_score = adjusted_score.saturating_add(regions.len().saturating_mul(10));
                if let Some((line, pattern)) = regions.first() {
                    reasons.push(format!("localized hit L{}: {}", line, pattern));
                }
            }

            let context = localized_file_contexts
                .get(raw_path)
                .or_else(|| localized_file_contexts.get(&normalized_path));
            if let Some(context) = context {
                if context.starts_with("[import-trace") {
                    adjusted_score = adjusted_score.saturating_add(5);
                    reasons.push(context.trim_matches(&['[', ']'][..]).to_string());
                } else if !context.trim().is_empty() {
                    adjusted_score = adjusted_score.saturating_add(3);
                    reasons.push("localized excerpt available".to_string());
                }
            }

            if reasons.is_empty() {
                reasons.push("keyword/test telemetry rank".to_string());
            }

            match by_path.get_mut(&normalized_path) {
                Some(existing) => {
                    if adjusted_score > existing.score {
                        existing.score = adjusted_score;
                    }
                    for reason in reasons {
                        if !existing.reasons.contains(&reason) {
                            existing.reasons.push(reason);
                        }
                    }
                }
                None => {
                    by_path.insert(
                        normalized_path.clone(),
                        ProblemShapeFile {
                            path: normalized_path,
                            score: adjusted_score,
                            reasons,
                        },
                    );
                }
            }
        }

        let mut files: Vec<ProblemShapeFile> = by_path.into_values().collect();
        files.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
        files.truncate(limit.max(1));
        Self {
            top_files: files,
            trusted_test_scope,
            advisory_test_files: advisory_test_files.to_vec(),
            advisory_test_labels: advisory_test_labels.to_vec(),
            advisory_test_candidates: advisory_test_candidates.to_vec(),
            feedback_scope_promoted,
            top_file_limit: limit,
        }
    }

    fn render_file_ranking_section(&self) -> String {
        if self.top_files.is_empty() {
            return String::new();
        }
        let mut section = String::from(
            "## Problem Shape\nRanked source loci from issue text, scoped test telemetry, grep, AST/class inspection, and import adjacency. Start at #1 unless fresh evidence contradicts it.\n",
        );
        for (idx, file) in self.top_files.iter().enumerate() {
            section.push_str(&format!(
                "{}. `{}` (score: {}; {})\n",
                idx + 1,
                file.path,
                file.score,
                file.reasons.join(", ")
            ));
        }
        section
    }

    fn hypotheses(&self) -> Vec<PatchHypothesis> {
        self.top_files
            .iter()
            .filter(|file| is_problem_shape_source_path(&file.path))
            .enumerate()
            .map(|(idx, file)| PatchHypothesis {
                id: idx + 1,
                path: file.path.clone(),
                score: file.score,
                reason: file.reasons.join(", "),
            })
            .collect()
    }
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
struct CluShapeMetrics {
    top_file_count: usize,
    source_file_count: usize,
    ranked_file_count: usize,
    top_score: usize,
    second_score: usize,
    score_ratio_percent: usize,
    trusted_test_scope: bool,
    feedback_scope_promoted: bool,
    advisory_test_file_count: usize,
    advisory_test_label_count: usize,
    advisory_test_candidate_count: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct CluSolverPolicy {
    profile: String,
    workflow_lane: CluWorkflowLane,
    candidate_bank_enabled: bool,
    candidate_bank_max: usize,
    candidate_bank_reanchor: bool,
    candidate_bank_early_stop: bool,
    candidate_bank_early_stop_min_score: i32,
    candidate_bank_early_stop_fail_count: u32,
    candidate_bank_reanchor_quarantine_after: u32,
    patch_tournament_enabled: bool,
    off_hypothesis_edit_threshold: u32,
    path_argument_failure_threshold: u32,
    hypothesis_step_budget: u32,
    scope_validation_timeout_seconds: usize,
    scope_validation_total_seconds: usize,
    scope_validation_max_candidates: usize,
    scope_validation_groups_last: bool,
    metrics: CluShapeMetrics,
    reasons: Vec<String>,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CluWorkflowLane {
    Retention,
    ReanchorTournament,
    AgentlessScopeFirst,
    SyntaxPathRecovery,
    Balanced,
}

impl CluWorkflowLane {
    fn as_str(self) -> &'static str {
        match self {
            Self::Retention => "retention",
            Self::ReanchorTournament => "reanchor_tournament",
            Self::AgentlessScopeFirst => "agentless_scope_first",
            Self::SyntaxPathRecovery => "syntax_path_recovery",
            Self::Balanced => "balanced",
        }
    }

    fn uses_reanchor(self) -> bool {
        matches!(
            self,
            Self::ReanchorTournament | Self::AgentlessScopeFirst | Self::Balanced
        )
    }

    fn is_retention(self) -> bool {
        matches!(self, Self::Retention)
    }

    fn repair_parse_before_switch(self) -> bool {
        matches!(self, Self::Retention | Self::SyntaxPathRecovery)
    }

    fn no_progress_threshold(self) -> u32 {
        match self {
            Self::Retention => 5,
            Self::ReanchorTournament => 2,
            Self::AgentlessScopeFirst => 2,
            Self::SyntaxPathRecovery => 2,
            Self::Balanced => 4,
        }
    }
}

impl CluSolverPolicy {
    #[allow(dead_code)]
    fn from_problem_shape(
        shape: &ProblemShape,
        source_file_count: usize,
        ranked_file_count: usize,
    ) -> Self {
        Self::from_problem_shape_with_workflow(shape, source_file_count, ranked_file_count, true)
    }

    fn from_problem_shape_with_workflow(
        shape: &ProblemShape,
        source_file_count: usize,
        ranked_file_count: usize,
        workflow_enabled: bool,
    ) -> Self {
        Self::from_problem_shape_with_options(
            shape,
            source_file_count,
            ranked_file_count,
            workflow_enabled,
            clu_aggressive_tournament_enabled(),
        )
    }

    fn from_problem_shape_with_options(
        shape: &ProblemShape,
        source_file_count: usize,
        ranked_file_count: usize,
        workflow_enabled: bool,
        aggressive_tournament: bool,
    ) -> Self {
        let top_score = shape.top_files.first().map(|file| file.score).unwrap_or(0);
        let second_score = shape.top_files.get(1).map(|file| file.score).unwrap_or(0);
        let score_ratio_percent = if second_score > 0 {
            top_score.saturating_mul(100) / second_score
        } else if top_score > 0 {
            999
        } else {
            0
        };
        let has_any_feedback_scope = shape.trusted_test_scope || shape.feedback_scope_promoted;
        let top_has_explicit_issue_path = shape
            .top_files
            .first()
            .map(|file| {
                file.reasons
                    .iter()
                    .any(|reason| reason == "explicit issue path")
            })
            .unwrap_or(false);
        let concentrated_locus =
            top_score > 0 && (shape.top_files.len() <= 2 || score_ratio_percent >= 180);
        let dominant_untrusted_source_locus = !has_any_feedback_scope
            && concentrated_locus
            && top_score >= 120
            && (top_has_explicit_issue_path || score_ratio_percent >= 250);
        let strong_promoted_source_locus = shape.feedback_scope_promoted
            && !shape.trusted_test_scope
            && top_score >= 120
            && (top_has_explicit_issue_path || score_ratio_percent >= 180);
        let flat_or_wide =
            shape.top_files.len() >= 4 || (second_score > 0 && score_ratio_percent < 140);
        let aggressive_tournament = workflow_enabled && aggressive_tournament;
        let weak_scope_should_tournament = aggressive_tournament
            && !has_any_feedback_scope
            && !dominant_untrusted_source_locus
            && (flat_or_wide
                || source_file_count >= 3
                || shape.advisory_test_candidates.len() >= 2
                || score_ratio_percent < 200
                || top_score < 160);

        let metrics = CluShapeMetrics {
            top_file_count: shape.top_files.len(),
            source_file_count,
            ranked_file_count,
            top_score,
            second_score,
            score_ratio_percent,
            trusted_test_scope: shape.trusted_test_scope,
            feedback_scope_promoted: shape.feedback_scope_promoted,
            advisory_test_file_count: shape.advisory_test_files.len(),
            advisory_test_label_count: shape.advisory_test_labels.len(),
            advisory_test_candidate_count: shape.advisory_test_candidates.len(),
        };

        let mut policy = Self {
            profile: "balanced".to_string(),
            workflow_lane: CluWorkflowLane::Balanced,
            candidate_bank_enabled: true,
            candidate_bank_max: 5,
            candidate_bank_reanchor: true,
            candidate_bank_early_stop: false,
            candidate_bank_early_stop_min_score: 60,
            candidate_bank_early_stop_fail_count: 6,
            candidate_bank_reanchor_quarantine_after: 0,
            patch_tournament_enabled: true,
            off_hypothesis_edit_threshold: 2,
            path_argument_failure_threshold: 3,
            hypothesis_step_budget: 0,
            scope_validation_timeout_seconds: 90,
            scope_validation_total_seconds: 240,
            scope_validation_max_candidates: 6,
            scope_validation_groups_last: true,
            metrics,
            reasons: Vec::new(),
        };

        if dominant_untrusted_source_locus && !workflow_enabled {
            policy.profile = "focused_source_untrusted_scope".to_string();
            policy.workflow_lane = CluWorkflowLane::Retention;
            policy.candidate_bank_max = 1;
            policy.candidate_bank_reanchor = false;
            policy.path_argument_failure_threshold = 2;
            policy.scope_validation_total_seconds = 180;
            policy.scope_validation_max_candidates = 4;
            policy.reasons.push(format!(
                "source locus is dominant/explicit without trusted scope; stay on source locus unless fresh evidence proves otherwise (ratio={}%, top_files={})",
                score_ratio_percent,
                shape.top_files.len()
            ));
        } else if weak_scope_should_tournament {
            policy.profile = "ambiguous_multi_locus".to_string();
            policy.workflow_lane = CluWorkflowLane::ReanchorTournament;
            policy.candidate_bank_max = 8;
            policy.candidate_bank_reanchor = true;
            policy.candidate_bank_reanchor_quarantine_after = 1;
            policy.scope_validation_total_seconds = 360;
            policy.scope_validation_max_candidates = 8;
            policy.reasons.push(format!(
                "aggressive CLU calibration: weak scope plus broad/low-confidence localization routes to tournament (ratio={}%, top_files={}, source_files={}, advisory_candidates={})",
                score_ratio_percent,
                shape.top_files.len(),
                source_file_count,
                shape.advisory_test_candidates.len()
            ));
        } else if !has_any_feedback_scope {
            policy.profile = "weak_scope_exploration".to_string();
            policy.workflow_lane = CluWorkflowLane::AgentlessScopeFirst;
            policy.candidate_bank_max = 6;
            policy.candidate_bank_reanchor = true;
            policy.candidate_bank_reanchor_quarantine_after = 2;
            policy.scope_validation_total_seconds = 240;
            policy.scope_validation_max_candidates = 6;
            policy.reasons.push(
                "no trusted/promoted issue-local scope; compile a localization-first repair lane and preserve alternatives while validating feedback"
                    .to_string(),
            );
        } else if strong_promoted_source_locus {
            policy.profile = "promoted_dominant_source_locus".to_string();
            policy.workflow_lane = CluWorkflowLane::AgentlessScopeFirst;
            policy.candidate_bank_max = 6;
            policy.candidate_bank_reanchor = true;
            policy.candidate_bank_reanchor_quarantine_after = 1;
            policy.path_argument_failure_threshold = 2;
            policy.scope_validation_total_seconds = 300;
            policy.scope_validation_max_candidates = 6;
            policy.reasons.push(format!(
                "promoted feedback scope is not authoritative even with a dominant source locus; prove or repair the source-derived test scope before relying on fanout (ratio={}%, top_score={}, top_files={})",
                score_ratio_percent,
                top_score,
                shape.top_files.len()
            ));
        } else if !shape.trusted_test_scope && shape.feedback_scope_promoted {
            policy.profile = "promoted_scope_exploration".to_string();
            policy.workflow_lane = CluWorkflowLane::ReanchorTournament;
            policy.candidate_bank_max = 8;
            policy.candidate_bank_reanchor = true;
            policy.candidate_bank_reanchor_quarantine_after =
                if aggressive_tournament { 1 } else { 2 };
            policy.scope_validation_total_seconds = if aggressive_tournament { 360 } else { 300 };
            policy.scope_validation_max_candidates = 8;
            policy.reasons.push(format!(
                "feedback scope was harness-promoted, not initially trusted; use tournament diversity because feedback-only validation cannot crown a candidate (ratio={}%, top_files={})",
                score_ratio_percent,
                shape.top_files.len()
            ));
        } else if concentrated_locus {
            policy.profile = "focused_validated_locus".to_string();
            policy.workflow_lane = CluWorkflowLane::Retention;
            policy.candidate_bank_max = 4;
            policy.candidate_bank_reanchor = false;
            policy.path_argument_failure_threshold = 2;
            policy.scope_validation_total_seconds = 180;
            policy.scope_validation_max_candidates = 4;
            policy.reasons.push(format!(
                "top locus is concentrated with trusted scope (ratio={}%, top_files={})",
                score_ratio_percent,
                shape.top_files.len()
            ));
        } else if flat_or_wide {
            policy.profile = "ambiguous_multi_locus".to_string();
            policy.workflow_lane = CluWorkflowLane::ReanchorTournament;
            policy.candidate_bank_max = 8;
            policy.candidate_bank_reanchor = true;
            policy.candidate_bank_reanchor_quarantine_after =
                if aggressive_tournament { 1 } else { 2 };
            policy.scope_validation_total_seconds = 360;
            policy.scope_validation_max_candidates = 8;
            policy.reasons.push(format!(
                "ranked loci are broad or flat (ratio={}%, top_files={})",
                score_ratio_percent,
                shape.top_files.len()
            ));
        } else {
            policy.workflow_lane = CluWorkflowLane::ReanchorTournament;
            policy.candidate_bank_max = if aggressive_tournament { 8 } else { 6 };
            policy.candidate_bank_reanchor = true;
            if aggressive_tournament {
                policy.candidate_bank_reanchor_quarantine_after = 1;
                policy.scope_validation_max_candidates = 8;
            }
            policy.reasons.push(format!(
                "moderate source concentration with trusted scope; use bounded tournament rather than a single mutable trajectory (ratio={}%, top_files={})",
                score_ratio_percent,
                shape.top_files.len()
            ));
        }

        if policy.workflow_lane.uses_reanchor() {
            policy.candidate_bank_reanchor = true;
        }
        if policy.workflow_lane.is_retention() {
            policy.candidate_bank_reanchor = false;
            policy.candidate_bank_early_stop = false;
        }

        if workflow_enabled && clu_evidence_refresh_enabled() {
            if policy.workflow_lane.is_retention() {
                policy.reasons.push(
                    "CLU evidence-refresh enabled but retention lane keeps conservative local persistence"
                        .to_string(),
                );
            } else {
                policy.candidate_bank_early_stop = true;
                policy.candidate_bank_early_stop_min_score = 60;
                policy.candidate_bank_early_stop_fail_count = 3;
                policy.hypothesis_step_budget = 14;
                policy.reasons.push(
                    "CLU evidence-refresh enabled: bound each hypothesis packet and restore/switch before stale edit loops compound"
                        .to_string(),
                );
            }
        }

        if shape.advisory_test_candidates.len() > policy.scope_validation_max_candidates {
            policy.reasons.push(format!(
                "scope validation capped at {} of {} source-test candidates",
                policy.scope_validation_max_candidates,
                shape.advisory_test_candidates.len()
            ));
        }

        if !workflow_enabled {
            policy.workflow_lane = match policy.profile.as_str() {
                "focused_validated_locus" | "focused_source_untrusted_scope" => {
                    CluWorkflowLane::Retention
                }
                "promoted_dominant_source_locus"
                | "weak_scope_exploration"
                | "promoted_scope_exploration" => CluWorkflowLane::AgentlessScopeFirst,
                "ambiguous_multi_locus" => CluWorkflowLane::ReanchorTournament,
                _ => CluWorkflowLane::Balanced,
            };
            if policy.profile == "focused_source_untrusted_scope" {
                policy.candidate_bank_max = 1;
                policy.candidate_bank_reanchor = false;
                policy.path_argument_failure_threshold = 2;
                policy.scope_validation_total_seconds = 180;
                policy.scope_validation_max_candidates = 4;
            }
            policy
                .reasons
                .push("SW_CLU_WORKFLOW disabled; applying scalar CLU policy only".to_string());
        }

        policy
    }

    fn apply_to_env(&self) {
        set_runtime_env("SW_CANDIDATE_BANK", bool_env(self.candidate_bank_enabled));
        set_runtime_env("SW_CANDIDATE_BANK_MAX", self.candidate_bank_max.to_string());
        set_runtime_env(
            "SW_CANDIDATE_BANK_REANCHOR",
            bool_env(self.candidate_bank_reanchor),
        );
        set_runtime_env(
            "SW_CANDIDATE_BANK_EARLY_STOP",
            bool_env(self.candidate_bank_early_stop),
        );
        set_runtime_env(
            "SW_CANDIDATE_BANK_EARLY_STOP_MIN_SCORE",
            self.candidate_bank_early_stop_min_score.to_string(),
        );
        set_runtime_env(
            "SW_CANDIDATE_BANK_EARLY_STOP_FAIL_COUNT",
            self.candidate_bank_early_stop_fail_count.to_string(),
        );
        set_runtime_env(
            "SW_CANDIDATE_BANK_REANCHOR_QUARANTINE_AFTER",
            self.candidate_bank_reanchor_quarantine_after.to_string(),
        );
        set_runtime_env(
            "SW_CANDIDATE_BANK_MODE",
            if self.patch_tournament_enabled {
                "best_of_n"
            } else {
                "sequential"
            },
        );
        set_runtime_env(
            "SW_PATCH_TOURNAMENT",
            if self.patch_tournament_enabled {
                "best_of_n"
            } else {
                "0"
            },
        );
        set_runtime_env("SW_CLU_WORKFLOW_LANE", self.workflow_lane.as_str());
        set_runtime_env(
            "SW_OFF_HYPOTHESIS_EDIT_THRESHOLD",
            self.off_hypothesis_edit_threshold.to_string(),
        );
        set_runtime_env(
            "SW_PATH_ARGUMENT_FAILURE_THRESHOLD",
            self.path_argument_failure_threshold.to_string(),
        );
        set_runtime_env(
            "SW_HYPOTHESIS_STEP_BUDGET",
            self.hypothesis_step_budget.to_string(),
        );
        set_runtime_env(
            "SW_SCOPE_VALIDATION_TIMEOUT_SECONDS",
            self.scope_validation_timeout_seconds.to_string(),
        );
        set_runtime_env(
            "SW_SCOPE_VALIDATION_TOTAL_SECONDS",
            self.scope_validation_total_seconds.to_string(),
        );
        set_runtime_env(
            "SW_SCOPE_VALIDATION_MAX_CANDIDATES",
            self.scope_validation_max_candidates.to_string(),
        );
        set_runtime_env(
            "SW_SCOPE_VALIDATION_GROUPS",
            if self.scope_validation_groups_last {
                "last"
            } else {
                "first"
            },
        );
        set_runtime_env(
            "SW_ATTEMPT_PACKET_NO_PROGRESS_THRESHOLD",
            self.workflow_lane.no_progress_threshold().to_string(),
        );
        set_runtime_env(
            "SW_ATTEMPT_PACKET_PARSE_FAIL_THRESHOLD",
            if self.workflow_lane.repair_parse_before_switch() {
                "3"
            } else {
                "2"
            },
        );
        set_runtime_env("SW_RETARGET_FEEDBACK_ONLY_SCOPE", "0");
        set_runtime_env("SW_FEEDBACK_ONLY_PASS_BRANCH", "0");
    }

    fn render_prompt_section(&self) -> String {
        format!(
            "\n\n## CLU Solver Policy\nProfile: `{}`. Workflow lane: `{}`. Candidate bank: max {}, reanchor {}, early-stop {}, reanchor quarantine after {} toxic restore(s). Patch hypotheses are {}. Hypothesis step budget: {}. Scope validation tries up to {} candidate(s), singleton scopes before grouped scopes: {}.\nReason: {}",
            self.profile,
            self.workflow_lane.as_str(),
            self.candidate_bank_max,
            self.candidate_bank_reanchor,
            self.candidate_bank_early_stop,
            self.candidate_bank_reanchor_quarantine_after,
            if self.patch_tournament_enabled {
                "enabled"
            } else {
                "disabled"
            },
            self.hypothesis_step_budget,
            self.scope_validation_max_candidates,
            self.scope_validation_groups_last,
            self.reasons.join("; ")
        )
    }
}

impl ScoutRouteDecision {
    fn from_env(policy: Option<&CluSolverPolicy>, hypothesis_count: usize) -> Self {
        let mut decision = Self::from_inputs(
            adaptive_scout_enabled(),
            policy,
            hypothesis_count,
            ScoutRouteSettings::from_env(),
        );
        let fanout_depth = candidate_fanout::process_depth_from_env();
        if fanout_depth > 0 {
            decision.route = "fanout_child_no_fanout".to_string();
            decision.fanout_enabled = false;
            decision.lane_escalation_enabled = false;
            decision.escalation_lanes.clear();
            decision.reasons.push(format!(
                "candidate fanout child depth {} disables nested scout fanout",
                fanout_depth
            ));
        }
        if !candidate_fanout::feature_enabled() {
            decision.route = "fanout_feature_disabled".to_string();
            decision.fanout_enabled = false;
            decision.lane_escalation_enabled = false;
            decision.escalation_lanes.clear();
            decision.reasons.push(
                "candidate fanout feature flag disabled; use validation-oracle route".to_string(),
            );
        }
        decision
    }

    fn from_inputs(
        enabled: bool,
        policy: Option<&CluSolverPolicy>,
        hypothesis_count: usize,
        settings: ScoutRouteSettings,
    ) -> Self {
        let mut reasons = Vec::new();
        if !enabled {
            reasons.push("adaptive scout router disabled".to_string());
            return Self::new(
                enabled,
                "off",
                true,
                hypothesis_count,
                hypothesis_count,
                settings,
                reasons,
            );
        }

        let Some(policy) = policy else {
            reasons.push("CLU policy unavailable; keep full fanout".to_string());
            return Self::new(
                enabled,
                "full_fanout",
                true,
                hypothesis_count,
                hypothesis_count,
                settings,
                reasons,
            );
        };

        let metrics = &policy.metrics;
        let focused_profile = policy.profile == "focused_validated_locus";
        let retention_lane = policy.workflow_lane.is_retention();
        let trusted_scope = metrics.trusted_test_scope;
        let not_promoted_scope = !metrics.feedback_scope_promoted;
        let concentrated_locus =
            metrics.top_file_count > 0 && metrics.top_file_count <= settings.max_top_files;
        let dominant_score = metrics.score_ratio_percent >= settings.min_ratio_percent;
        let bounded_hypotheses =
            hypothesis_count > 0 && hypothesis_count <= settings.max_hypotheses;

        let cheap_lane = focused_profile
            && retention_lane
            && trusted_scope
            && not_promoted_scope
            && concentrated_locus
            && dominant_score
            && bounded_hypotheses;

        if cheap_lane {
            reasons.push(format!(
                "focused trusted locus meets cheap-lane threshold (ratio={}%, top_files={}, hypotheses={})",
                metrics.score_ratio_percent, metrics.top_file_count, hypothesis_count
            ));
        } else {
            if !focused_profile {
                reasons.push(format!(
                    "profile {} is not a focused validated locus",
                    policy.profile
                ));
            }
            if !retention_lane {
                reasons.push(format!(
                    "workflow lane {} expects exploration",
                    policy.workflow_lane.as_str()
                ));
            }
            if !trusted_scope {
                reasons.push("trusted test scope unavailable".to_string());
            }
            if !not_promoted_scope {
                reasons.push(
                    "feedback scope was promoted; evaluate promoted-dominant lane".to_string(),
                );
            }
            if !concentrated_locus {
                reasons.push(format!(
                    "top file count {} exceeds cheap-lane max {}",
                    metrics.top_file_count, settings.max_top_files
                ));
            }
            if !dominant_score {
                reasons.push(format!(
                    "score ratio {}% below cheap-lane min {}%",
                    metrics.score_ratio_percent, settings.min_ratio_percent
                ));
            }
            if !bounded_hypotheses {
                reasons.push(format!(
                    "hypothesis count {} outside cheap-lane max {}",
                    hypothesis_count, settings.max_hypotheses
                ));
            }
        }

        let promoted_dominant_lane = !cheap_lane
            && (policy.profile == "promoted_dominant_source_locus"
                || (metrics.feedback_scope_promoted
                    && hypothesis_count > 0
                    && metrics.score_ratio_percent >= settings.promoted_min_ratio_percent
                    && metrics.top_score >= settings.promoted_min_top_score));
        let promoted_dominant_fanout = promoted_dominant_fanout_enabled();

        if !cheap_lane {
            if promoted_dominant_lane {
                reasons.push(format!(
                    "promoted scope has dominant current-instance locus (ratio={}%, top_score={}, hypotheses={})",
                    metrics.score_ratio_percent, metrics.top_score, hypothesis_count
                ));
                if promoted_dominant_fanout {
                    reasons.push(
                        "promoted-dominant untrusted scope routes to progressive fanout after focused scope evidence"
                            .to_string(),
                    );
                } else {
                    reasons.push(
                        "promoted-dominant source scope keeps focused retention by default"
                            .to_string(),
                    );
                }
            } else {
                if !metrics.feedback_scope_promoted {
                    reasons
                        .push("no promoted feedback scope for promoted-dominant lane".to_string());
                }
                if metrics.score_ratio_percent < settings.promoted_min_ratio_percent {
                    reasons.push(format!(
                        "score ratio {}% below promoted-dominant min {}%",
                        metrics.score_ratio_percent, settings.promoted_min_ratio_percent
                    ));
                }
                if metrics.top_score < settings.promoted_min_top_score {
                    reasons.push(format!(
                        "top score {} below promoted-dominant min {}",
                        metrics.top_score, settings.promoted_min_top_score
                    ));
                }
            }
        }

        let (route, fanout_enabled, retained_hypothesis_count) = if cheap_lane {
            (
                "cheap_no_fanout",
                false,
                hypothesis_count.min(settings.cheap_hypothesis_limit.max(1)),
            )
        } else if promoted_dominant_lane && !promoted_dominant_fanout {
            (
                "promoted_dominant_no_fanout",
                false,
                hypothesis_count.min(settings.promoted_hypothesis_limit.max(1)),
            )
        } else {
            reasons.push(format!(
                "progressive fanout keeps at most {} hypotheses with fanout max {} concurrency {} child_steps {}",
                settings.progressive_hypothesis_limit,
                settings.progressive_fanout_max_candidates,
                settings.progressive_fanout_concurrency,
                settings.progressive_child_max_steps
            ));
            (
                "progressive_fanout",
                true,
                hypothesis_count.min(settings.progressive_hypothesis_limit.max(1)),
            )
        };

        Self::new(
            enabled,
            route,
            fanout_enabled,
            hypothesis_count,
            retained_hypothesis_count,
            settings,
            reasons,
        )
    }

    fn new(
        enabled: bool,
        route: &str,
        fanout_enabled: bool,
        original_hypothesis_count: usize,
        retained_hypothesis_count: usize,
        settings: ScoutRouteSettings,
        reasons: Vec<String>,
    ) -> Self {
        Self {
            schema_version: 1,
            artifact: "statewright.scout_route",
            official_verifier_boundary: "route uses current-instance localization shape only; official SWE-bench verifier determines solve status",
            enabled,
            lane_escalation_enabled: settings.lane_escalation_enabled,
            route: route.to_string(),
            fanout_enabled,
            original_hypothesis_count,
            retained_hypothesis_count,
            max_top_files: settings.max_top_files,
            min_ratio_percent: settings.min_ratio_percent,
            max_hypotheses: settings.max_hypotheses,
            cheap_hypothesis_limit: settings.cheap_hypothesis_limit,
            probe_child_timeout_seconds: settings.probe_child_timeout_seconds,
            promoted_min_ratio_percent: settings.promoted_min_ratio_percent,
            promoted_min_top_score: settings.promoted_min_top_score,
            promoted_hypothesis_limit: settings.promoted_hypothesis_limit,
            progressive_hypothesis_limit: settings.progressive_hypothesis_limit,
            progressive_fanout_max_candidates: settings.progressive_fanout_max_candidates,
            progressive_fanout_concurrency: settings.progressive_fanout_concurrency,
            progressive_child_max_steps: settings.progressive_child_max_steps,
            progressive_child_timeout_seconds: settings.progressive_child_timeout_seconds,
            full_hypothesis_limit: settings.full_hypothesis_limit,
            full_fanout_max_candidates: settings.full_fanout_max_candidates,
            full_fanout_concurrency: settings.full_fanout_concurrency,
            full_child_max_steps: settings.full_child_max_steps,
            full_child_timeout_seconds: settings.full_child_timeout_seconds,
            route_fanout_wall_seconds: settings.route_fanout_wall_seconds,
            route_fanout_timeout_stop_count: settings.route_fanout_timeout_stop_count,
            escalation_lanes: Self::build_escalation_lanes(
                enabled,
                route,
                original_hypothesis_count,
                settings,
            ),
            reasons,
        }
    }

    fn build_escalation_lanes(
        enabled: bool,
        route: &str,
        hypothesis_count: usize,
        settings: ScoutRouteSettings,
    ) -> Vec<ScoutLaneDecision> {
        if !enabled
            || !settings.lane_escalation_enabled
            || hypothesis_count == 0
            || route == "fanout_feature_disabled"
        {
            return Vec::new();
        }

        let mut lanes = Vec::new();
        let probe_name = match route {
            "cheap_no_fanout" => "cheap_probe",
            "promoted_dominant_no_fanout" => "promoted_probe",
            _ => "focused_probe",
        };
        lanes.push(ScoutLaneDecision {
            name: probe_name.to_string(),
            reason: "first lane contributes a focused top-locus candidate to the shared tournament"
                .to_string(),
            hypothesis_limit: settings.cheap_hypothesis_limit.max(1),
            max_candidates: settings.cheap_hypothesis_limit.max(1),
            concurrency: 1,
            child_max_steps: settings.progressive_child_max_steps,
            child_timeout_seconds: settings.probe_child_timeout_seconds,
        });

        lanes.push(ScoutLaneDecision {
            name: "progressive_fanout".to_string(),
            reason: "middle lane contributes bounded candidate diversity to the shared tournament"
                .to_string(),
            hypothesis_limit: settings.progressive_hypothesis_limit.max(1),
            max_candidates: settings.progressive_fanout_max_candidates.max(1),
            concurrency: settings.progressive_fanout_concurrency.max(1),
            child_max_steps: settings.progressive_child_max_steps,
            child_timeout_seconds: settings.progressive_child_timeout_seconds,
        });

        lanes.push(ScoutLaneDecision {
            name: "full_fanout".to_string(),
            reason: "last lane contributes broad candidates before the shared tournament election"
                .to_string(),
            hypothesis_limit: hypothesis_count.min(settings.full_hypothesis_limit.max(1)),
            max_candidates: settings.full_fanout_max_candidates.max(1),
            concurrency: settings.full_fanout_concurrency.max(1),
            child_max_steps: settings.full_child_max_steps,
            child_timeout_seconds: settings.full_child_timeout_seconds,
        });

        lanes
    }

    fn skip_fanout(&self) -> bool {
        self.enabled && !self.fanout_enabled
    }

    fn progressive_fanout(&self) -> bool {
        self.enabled && self.route == "progressive_fanout"
    }

    fn escalation_enabled(&self) -> bool {
        self.enabled && self.lane_escalation_enabled && !self.escalation_lanes.is_empty()
    }

    fn apply_runtime_env(&self) {
        set_runtime_env("SW_SCOUT_ROUTE", &self.route);
        set_runtime_env("SW_SCOUT_FANOUT", bool_env(self.fanout_enabled));
        set_runtime_env(
            "SW_SCOUT_LANE_ESCALATION",
            bool_env(self.lane_escalation_enabled),
        );
        if !candidate_fanout::feature_enabled() {
            set_runtime_env("SW_SCOUT_FANOUT", "0");
            set_runtime_env("SW_SCOUT_LANE_ESCALATION", "0");
            set_runtime_env("SW_CANDIDATE_FANOUT", "0");
            return;
        }
        let fanout_depth = candidate_fanout::process_depth_from_env();
        let max_depth = env_usize("SW_CANDIDATE_FANOUT_MAX_DEPTH", 1, 0, 8);
        if fanout_depth > 0 || fanout_depth >= max_depth {
            set_runtime_env("SW_SCOUT_FANOUT", "0");
            set_runtime_env("SW_SCOUT_LANE_ESCALATION", "0");
            set_runtime_env("SW_CANDIDATE_FANOUT", "0");
            set_runtime_env("SW_CANDIDATE_FANOUT_DEPTH", fanout_depth.to_string());
            return;
        }
        if self.skip_fanout() {
            set_runtime_env("SW_CANDIDATE_FANOUT", "0");
        } else if self.progressive_fanout() {
            set_runtime_env("SW_CANDIDATE_FANOUT", "1");
            set_runtime_env(
                "SW_CANDIDATE_FANOUT_MAX",
                self.progressive_fanout_max_candidates.to_string(),
            );
            set_runtime_env(
                "SW_CANDIDATE_FANOUT_CONCURRENCY",
                self.progressive_fanout_concurrency.to_string(),
            );
            set_runtime_env(
                "SW_CANDIDATE_FANOUT_CHILD_MAX_STEPS",
                self.progressive_child_max_steps.to_string(),
            );
            set_runtime_env(
                "SW_CANDIDATE_FANOUT_CHILD_TIMEOUT_SECONDS",
                self.progressive_child_timeout_seconds.to_string(),
            );
        }
    }
}

fn bool_env(value: bool) -> &'static str {
    if value { "1" } else { "0" }
}

fn set_runtime_env(name: &str, value: impl AsRef<str>) {
    unsafe {
        std::env::set_var(name, value.as_ref());
    }
}

fn env_usize(name: &str, default: usize, min: usize, max: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .map(|value| value.clamp(min, max))
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64, min: u64, max: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|value| value.clamp(min, max))
        .unwrap_or(default)
}

fn problem_shape_enabled() -> bool {
    env_flag("SW_PROBLEM_SHAPE", true)
}

fn clu_enabled() -> bool {
    env_flag("SW_CLU", false)
}

fn clu_workflow_enabled() -> bool {
    env_flag("SW_CLU_WORKFLOW", false)
}

fn clu_aggressive_tournament_enabled() -> bool {
    env_flag("SW_CLU_AGGRESSIVE_TOURNAMENT", false)
}

fn clu_evidence_refresh_enabled() -> bool {
    env_flag("SW_CLU_EVIDENCE_REFRESH", false)
}

fn adaptive_scout_enabled() -> bool {
    env_flag("SW_ADAPTIVE_SCOUT", false) || env_flag("SW_SCOUT_ROUTER", false)
}

fn scout_lane_escalation_enabled() -> bool {
    env_flag("SW_SCOUT_LANE_ESCALATION", false)
}

fn scout_max_top_files() -> usize {
    env_usize("SW_SCOUT_MAX_TOP_FILES", 2, 1, 8)
}

fn scout_min_ratio_percent() -> usize {
    env_usize("SW_SCOUT_MIN_RATIO_PERCENT", 250, 100, 999)
}

fn scout_max_hypotheses() -> usize {
    env_usize("SW_SCOUT_MAX_HYPOTHESES", 2, 1, 8)
}

fn scout_cheap_hypothesis_limit() -> usize {
    env_usize("SW_SCOUT_CHEAP_HYPOTHESES", 1, 1, 4)
}

fn scout_probe_child_timeout_seconds() -> u64 {
    env_u64("SW_SCOUT_PROBE_CHILD_TIMEOUT_SECONDS", 300, 60, 1800)
}

fn scout_promoted_min_ratio_percent() -> usize {
    env_usize("SW_SCOUT_PROMOTED_MIN_RATIO_PERCENT", 250, 100, 999)
}

fn scout_promoted_min_top_score() -> usize {
    env_usize("SW_SCOUT_PROMOTED_MIN_TOP_SCORE", 20, 0, 1000)
}

fn scout_promoted_hypothesis_limit() -> usize {
    env_usize("SW_SCOUT_PROMOTED_HYPOTHESES", 2, 1, 4)
}

fn scout_progressive_hypothesis_limit() -> usize {
    env_usize("SW_SCOUT_PROGRESSIVE_HYPOTHESES", 3, 1, 8)
}

fn scout_progressive_fanout_max_candidates() -> usize {
    env_usize("SW_SCOUT_PROGRESSIVE_FANOUT_MAX", 3, 1, 8)
}

fn scout_progressive_fanout_concurrency() -> usize {
    env_usize("SW_SCOUT_PROGRESSIVE_FANOUT_CONCURRENCY", 1, 1, 4)
}

fn scout_progressive_child_max_steps() -> usize {
    env_usize("SW_SCOUT_PROGRESSIVE_CHILD_MAX_STEPS", 30, 10, 60)
}

fn scout_progressive_child_timeout_seconds() -> u64 {
    env_u64("SW_SCOUT_PROGRESSIVE_CHILD_TIMEOUT_SECONDS", 600, 60, 3600)
}

fn scout_full_hypothesis_limit() -> usize {
    env_usize("SW_SCOUT_FULL_HYPOTHESES", 7, 1, 12)
}

fn scout_full_fanout_max_candidates() -> usize {
    env_usize("SW_SCOUT_FULL_FANOUT_MAX", 7, 1, 12)
}

fn scout_full_fanout_concurrency() -> usize {
    env_usize("SW_SCOUT_FULL_FANOUT_CONCURRENCY", 2, 1, 8)
}

fn scout_full_child_max_steps() -> usize {
    env_usize("SW_SCOUT_FULL_CHILD_MAX_STEPS", 45, 10, 120)
}

fn scout_full_child_timeout_seconds() -> u64 {
    env_u64("SW_SCOUT_FULL_CHILD_TIMEOUT_SECONDS", 600, 60, 3600)
}

fn scout_route_fanout_wall_seconds() -> u64 {
    env_u64("SW_SCOUT_ROUTE_FANOUT_WALL_SECONDS", 1200, 0, 7200)
}

fn scout_route_fanout_timeout_stop_count() -> usize {
    env_usize("SW_SCOUT_ROUTE_FANOUT_TIMEOUT_STOP_COUNT", 2, 0, 24)
}

const DEFAULT_FINALIZATION_RESERVE_SECONDS: u64 = 600;

fn remaining_fanout_budget_seconds(
    pod_timeout: u64,
    finalization_reserve: u64,
    pre_agent_elapsed: u64,
) -> u64 {
    let reserve = finalization_reserve.min(pod_timeout.saturating_sub(60));
    pod_timeout
        .saturating_sub(pre_agent_elapsed)
        .saturating_sub(reserve)
}

fn pod_fanout_deadline(process_started: std::time::Instant) -> Option<std::time::Instant> {
    let pod_timeout = env_u64("SW_POD_TIMEOUT_SECONDS", 0, 0, 86_400);
    if pod_timeout == 0 {
        return None;
    }

    let reserve = env_u64(
        "SW_FINALIZATION_RESERVE_SECONDS",
        DEFAULT_FINALIZATION_RESERVE_SECONDS,
        60,
        7_200,
    );
    let pod_elapsed_now = std::env::var("SW_POD_STARTED_EPOCH_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .and_then(|started_epoch| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|now| now.as_secs().saturating_sub(started_epoch))
        })
        .unwrap_or(0);
    let pre_agent_elapsed = pod_elapsed_now.saturating_sub(process_started.elapsed().as_secs());
    let remaining = remaining_fanout_budget_seconds(pod_timeout, reserve, pre_agent_elapsed);
    Some(process_started + std::time::Duration::from_secs(remaining))
}

fn problem_shape_top_file_limit() -> usize {
    env_usize("SW_PROBLEM_SHAPE_TOP_FILES", 8, 1, 12)
}

fn problem_shape_machine_enabled() -> bool {
    env_flag("SW_PROBLEM_SHAPE_MACHINE", false)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProblemShapeMachineLane {
    Focused,
    Exploratory,
    Ambiguous,
    Balanced,
}

impl ProblemShapeMachineLane {
    fn from_policy(policy: &CluSolverPolicy) -> Self {
        match policy.workflow_lane {
            CluWorkflowLane::Retention | CluWorkflowLane::SyntaxPathRecovery => Self::Focused,
            CluWorkflowLane::AgentlessScopeFirst => Self::Exploratory,
            CluWorkflowLane::ReanchorTournament => Self::Ambiguous,
            CluWorkflowLane::Balanced => Self::Balanced,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Focused => "focused",
            Self::Exploratory => "exploratory",
            Self::Ambiguous => "ambiguous",
            Self::Balanced => "balanced",
        }
    }
}

fn set_state_max_iterations(
    definition: &mut MachineDefinition,
    state_name: &str,
    max_iterations: u32,
    changes: &mut Vec<String>,
) {
    if let Some(state) = definition.states.get_mut(state_name) {
        if state.max_iterations != Some(max_iterations) {
            let old = state
                .max_iterations
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string());
            state.max_iterations = Some(max_iterations);
            changes.push(format!(
                "{} max_iterations {} -> {}",
                state_name, old, max_iterations
            ));
        }
    }
}

fn set_state_transition_target(
    definition: &mut MachineDefinition,
    state_name: &str,
    event: &str,
    target: &str,
    changes: &mut Vec<String>,
) {
    if !definition.states.contains_key(target) {
        changes.push(format!(
            "skipped {}:{} -> {}; missing target state",
            state_name, event, target
        ));
        return;
    }

    if let Some(state) = definition.states.get_mut(state_name) {
        let old_target = state
            .on
            .get(event)
            .map(|transition| transition.target().to_string())
            .unwrap_or_else(|| "none".to_string());
        if old_target != target {
            state
                .on
                .insert(event.to_string(), TransitionDef::Simple(target.to_string()));
            changes.push(format!(
                "{}:{} {} -> {}",
                state_name, event, old_target, target
            ));
        }
    }
}

fn append_state_lane_instruction(
    definition: &mut MachineDefinition,
    state_name: &str,
    lane: ProblemShapeMachineLane,
    instruction: &str,
    changes: &mut Vec<String>,
) {
    if let Some(state) = definition.states.get_mut(state_name) {
        let marker = format!("Problem-shape machine lane: {}.", lane.as_str());
        let current = state.instructions.clone().unwrap_or_default();
        if current.contains(&marker) {
            return;
        }
        let suffix = format!("{} {}", marker, instruction);
        state.instructions = Some(if current.trim().is_empty() {
            suffix
        } else {
            format!("{}\n\n{}", current, suffix)
        });
        changes.push(format!(
            "{} appended {} lane instruction",
            state_name,
            lane.as_str()
        ));
    }
}

fn apply_problem_shape_machine_policy(
    definition: &mut MachineDefinition,
    policy: &CluSolverPolicy,
) -> Vec<String> {
    let lane = ProblemShapeMachineLane::from_policy(policy);
    let mut changes = vec![format!("profile={} lane={}", policy.profile, lane.as_str())];

    if let Some(meta) = definition.meta.as_mut() {
        meta.extra.insert(
            "statewright_problem_shape_machine".to_string(),
            json!({
                "enabled": true,
                "profile": policy.profile.as_str(),
                "workflow_lane": policy.workflow_lane.as_str(),
                "lane": lane.as_str(),
                "top_file_count": policy.metrics.top_file_count,
                "score_ratio_percent": policy.metrics.score_ratio_percent,
                "trusted_test_scope": policy.metrics.trusted_test_scope,
                "feedback_scope_promoted": policy.metrics.feedback_scope_promoted,
            }),
        );
    }

    match lane {
        ProblemShapeMachineLane::Focused => {
            set_state_max_iterations(definition, "scope_selecting", 3, &mut changes);
            set_state_max_iterations(definition, "hypothesizing", 5, &mut changes);
            set_state_max_iterations(definition, "patch_planning", 3, &mut changes);
            set_state_max_iterations(definition, "editing", 7, &mut changes);
            set_state_max_iterations(definition, "failure_triage", 3, &mut changes);
            set_state_transition_target(
                definition,
                "failure_triage",
                "SAME_FAILURE",
                "patch_planning",
                &mut changes,
            );
            set_state_transition_target(
                definition,
                "failure_triage",
                "TESTS_FAIL",
                "patch_planning",
                &mut changes,
            );
            append_state_lane_instruction(
                definition,
                "failure_triage",
                lane,
                "The workflow lane is retention-focused. Preserve the strongest focused candidate unless validation gives a concrete reason to branch; do not reanchor on weak advisory feedback alone.",
                &mut changes,
            );
        }
        ProblemShapeMachineLane::Exploratory => {
            set_state_max_iterations(definition, "scope_selecting", 7, &mut changes);
            set_state_max_iterations(definition, "hypothesizing", 6, &mut changes);
            set_state_max_iterations(definition, "patch_planning", 4, &mut changes);
            set_state_max_iterations(definition, "editing", 5, &mut changes);
            set_state_max_iterations(definition, "failure_triage", 5, &mut changes);
            set_state_transition_target(
                definition,
                "patch_planning",
                "NEED_EVIDENCE",
                "scope_selecting",
                &mut changes,
            );
            set_state_transition_target(
                definition,
                "failure_triage",
                "SAME_FAILURE",
                "scope_selecting",
                &mut changes,
            );
            set_state_transition_target(
                definition,
                "failure_triage",
                "TESTS_FAIL",
                "hypothesizing",
                &mut changes,
            );
            set_state_transition_target(
                definition,
                "failure_triage",
                "DONE",
                "scope_selecting",
                &mut changes,
            );
            append_state_lane_instruction(
                definition,
                "scope_selecting",
                lane,
                "The workflow lane is localization-first. Build or validate a source/test feedback window before spending edit attempts; advisory test passes are not completion proof.",
                &mut changes,
            );
            append_state_lane_instruction(
                definition,
                "failure_triage",
                lane,
                "Same-failure loops are treated as scope debt first. Return to source/test mapping unless the latest output identifies a concrete syntax or import repair.",
                &mut changes,
            );
        }
        ProblemShapeMachineLane::Ambiguous => {
            set_state_max_iterations(definition, "scope_selecting", 5, &mut changes);
            set_state_max_iterations(definition, "hypothesizing", 6, &mut changes);
            set_state_max_iterations(definition, "patch_planning", 4, &mut changes);
            set_state_max_iterations(definition, "editing", 6, &mut changes);
            set_state_max_iterations(definition, "failure_triage", 5, &mut changes);
            set_state_transition_target(
                definition,
                "failure_triage",
                "SAME_FAILURE",
                "hypothesizing",
                &mut changes,
            );
            set_state_transition_target(
                definition,
                "failure_triage",
                "TESTS_FAIL",
                "hypothesizing",
                &mut changes,
            );
            append_state_lane_instruction(
                definition,
                "hypothesizing",
                lane,
                "The workflow lane is a candidate tournament. Keep candidate packets independent; compare top candidate behaviors and choose one falsifiable source hypothesis before editing.",
                &mut changes,
            );
            append_state_lane_instruction(
                definition,
                "failure_triage",
                lane,
                "A repeated failure should fork back to hypothesis comparison unless the latest output names a concrete syntax/import repair.",
                &mut changes,
            );
        }
        ProblemShapeMachineLane::Balanced => {
            set_state_max_iterations(definition, "scope_selecting", 4, &mut changes);
            set_state_max_iterations(definition, "hypothesizing", 5, &mut changes);
            set_state_max_iterations(definition, "patch_planning", 3, &mut changes);
            set_state_max_iterations(definition, "editing", 7, &mut changes);
            set_state_max_iterations(definition, "failure_triage", 4, &mut changes);
            append_state_lane_instruction(
                definition,
                "failure_triage",
                lane,
                "Use the latest validation failure to choose between a patch-plan repair and a renewed scope pass.",
                &mut changes,
            );
        }
    }

    changes
}

fn patch_tournament_enabled() -> bool {
    match std::env::var("SW_PATCH_TOURNAMENT") {
        Ok(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true"
                | "yes"
                | "on"
                | "seq"
                | "sequential"
                | "best_of_n"
                | "best-of-n"
                | "parallel"
                | "tournament"
        ),
        Err(_) => false,
    }
}

fn attempt_packet_reset_enabled() -> bool {
    env_flag("SW_ATTEMPT_PACKET_RESET", false)
}

fn attempt_packet_parse_fail_threshold() -> u32 {
    env_usize("SW_ATTEMPT_PACKET_PARSE_FAIL_THRESHOLD", 3, 2, 8) as u32
}

fn attempt_packet_no_progress_threshold() -> u32 {
    env_usize("SW_ATTEMPT_PACKET_NO_PROGRESS_THRESHOLD", 4, 2, 10) as u32
}

fn causal_reproducer_edit_blocks() -> u32 {
    env_usize("SW_CAUSAL_REPRODUCER_EDIT_BLOCKS", 2, 0, 4) as u32
}

fn causal_safety_edit_budget() -> u32 {
    env_usize("SW_CAUSAL_SAFETY_EDIT_BUDGET", 6, 2, 20) as u32
}

fn off_hypothesis_edit_threshold() -> u32 {
    env_usize("SW_OFF_HYPOTHESIS_EDIT_THRESHOLD", 2, 1, 6) as u32
}

fn path_argument_failure_threshold() -> u32 {
    env_usize("SW_PATH_ARGUMENT_FAILURE_THRESHOLD", 3, 1, 8) as u32
}

fn hypothesis_step_budget() -> u32 {
    env_usize("SW_HYPOTHESIS_STEP_BUDGET", 0, 0, 80) as u32
}

fn source_locus_intel_enabled() -> bool {
    env_flag("SW_SOURCE_LOCUS_INTEL", false)
}

fn feedback_only_pass_branch_enabled() -> bool {
    env_flag("SW_FEEDBACK_ONLY_PASS_BRANCH", false)
}

fn deprecated_preserve_unavailable_validation_enabled() -> bool {
    env_flag("DEPRECATED_SW_PRESERVE_UNAVAILABLE_VALIDATION", false)
}

fn deprecated_feedback_only_auto_continue_enabled() -> bool {
    env_flag("DEPRECATED_SW_FEEDBACK_ONLY_AUTO_CONTINUE", false)
}

fn deprecated_native_raw_fallback_enabled() -> bool {
    env_flag("DEPRECATED_SW_NATIVE_RAW_FALLBACK", false)
}

fn tool_protocol_retries() -> u32 {
    std::env::var("SW_TOOL_PROTOCOL_RETRIES")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(2)
        .min(5)
}

fn promoted_dominant_fanout_enabled() -> bool {
    env_flag("SW_SCOUT_PROMOTED_DOMINANT_FANOUT", true)
        && !env_flag("DEPRECATED_SW_PROMOTED_DOMINANT_NO_FANOUT", false)
}

fn candidate_bank_reanchor_quarantine_after() -> u32 {
    env_usize("SW_CANDIDATE_BANK_REANCHOR_QUARANTINE_AFTER", 0, 0, 8) as u32
}

fn evidence_refresh_state_name(definition: &MachineDefinition) -> String {
    if definition.states.contains_key("patch_planning") {
        "patch_planning".to_string()
    } else if definition.states.contains_key("hypothesizing") {
        "hypothesizing".to_string()
    } else {
        implementation_state_name(definition)
    }
}

fn artifact_dir_from_env() -> Option<std::path::PathBuf> {
    std::env::var("SW_ARTIFACT_DIR")
        .ok()
        .or_else(|| std::env::var("STATEWRIGHT_ARTIFACT_DIR").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
}

fn write_json_artifact<T: Serialize>(name: &str, value: &T) {
    let Some(dir) = artifact_dir_from_env() else {
        return;
    };
    if let Err(err) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "  [ARTIFACT] mkdir failed path={} error={}",
            dir.display(),
            err
        );
        return;
    }
    let path = dir.join(name);
    let file = match std::fs::File::create(&path) {
        Ok(file) => file,
        Err(err) => {
            eprintln!(
                "  [ARTIFACT] create failed path={} error={}",
                path.display(),
                err
            );
            return;
        }
    };
    if let Err(err) = serde_json::to_writer_pretty(file, value) {
        eprintln!(
            "  [ARTIFACT] serialize failed path={} error={}",
            path.display(),
            err
        );
    }
}

fn record_causal_event(
    controller: &mut Option<causal_repair::CausalRepairController>,
    event: causal_repair::CausalEvent,
) {
    let Some(controller) = controller.as_mut() else {
        return;
    };
    let event_debug = format!("{event:?}");
    let transition = controller.record(event);
    println!(
        "[CAUSAL_REPAIR] event={} {} -> {} accepted={}",
        event_debug,
        transition.from.as_str(),
        transition.to.as_str(),
        transition.accepted
    );
}

fn causal_reason_from_tool_output(output: &str) -> String {
    output
        .lines()
        .find(|line| line.contains("reason="))
        .or_else(|| output.lines().next())
        .unwrap_or("no detail")
        .chars()
        .take(240)
        .collect()
}

fn causal_task_reproducer_delta(output: &str) -> Option<validation_oracle::TestDelta> {
    output
        .lines()
        .find_map(|line| line.strip_prefix("SW_TASK_REPRODUCER_DELTA="))
        .and_then(validation_oracle::TestDelta::parse)
}

fn task_evidence_transition_for_output(output: &str) -> &'static str {
    match causal_task_reproducer_delta(output) {
        Some(validation_oracle::TestDelta::Fixed) => "TASK_EVIDENCE_FIXED",
        Some(validation_oracle::TestDelta::ChangedFail) => "TASK_EVIDENCE_CHANGED",
        Some(validation_oracle::TestDelta::Regressed)
        | Some(validation_oracle::TestDelta::UnchangedFail) => "TASK_EVIDENCE_REPAIR",
        Some(validation_oracle::TestDelta::UnchangedPass)
        | Some(validation_oracle::TestDelta::Invalid)
        | Some(validation_oracle::TestDelta::Unavailable)
        | None => "TASK_EVIDENCE_UNAVAILABLE",
    }
}

fn task_evidence_budget_exhausted(state: &str, steps_in_state: u32) -> bool {
    state == "task_evidence_acquisition" && steps_in_state >= 2
}

fn task_evidence_fail_must_audit(causal_one_pass: bool, state: &str, event: &str) -> bool {
    causal_one_pass && state == "task_evidence_acquisition" && event == "FAIL"
}

fn record_causal_checkpoint_update(update: causal_checkpoint::CheckpointUpdate) {
    match update {
        causal_checkpoint::CheckpointUpdate::Captured { fingerprint } => {
            println!("[CAUSAL_CHECKPOINT] captured fingerprint={fingerprint}");
        }
        causal_checkpoint::CheckpointUpdate::Retained { fingerprint } => {
            println!("[CAUSAL_CHECKPOINT] retained fingerprint={fingerprint}");
        }
        causal_checkpoint::CheckpointUpdate::Skipped { reason } => {
            println!("[CAUSAL_CHECKPOINT] skipped reason={reason}");
        }
    }
}

fn record_causal_reproducer_result(
    controller: &mut Option<causal_repair::CausalRepairController>,
    checkpoints: &mut Option<causal_checkpoint::CausalCheckpointStore>,
    workdir: &str,
    tool_name: &str,
    output: &str,
) {
    match tool_name {
        "write_task_reproducer" if output.contains("SW_TASK_REPRODUCER_STATUS=qualified") => {
            record_causal_event(controller, causal_repair::CausalEvent::ReproducerQualified);
            record_causal_event(
                controller,
                causal_repair::CausalEvent::RepairPlanned {
                    reason: "baseline-qualified task reproducer".to_string(),
                },
            );
        }
        "write_task_reproducer"
            if output.contains("SW_TASK_REPRODUCER_STATUS=no_causal_oracle") =>
        {
            record_causal_event(
                controller,
                causal_repair::CausalEvent::NoCausalOracle {
                    reason: causal_reason_from_tool_output(output),
                },
            );
            record_causal_event(
                controller,
                causal_repair::CausalEvent::RepairPlanned {
                    reason: "direct repair after reproducer qualification failed".to_string(),
                },
            );
        }
        "run_task_reproducer" => {
            let Some(delta) = causal_task_reproducer_delta(output) else {
                record_causal_event(
                    controller,
                    causal_repair::CausalEvent::StructuralUnavailable {
                        reason: causal_reason_from_tool_output(output),
                    },
                );
                return;
            };
            match delta {
                validation_oracle::TestDelta::Invalid => record_causal_event(
                    controller,
                    causal_repair::CausalEvent::StructuralFailure {
                        reason: causal_reason_from_tool_output(output),
                    },
                ),
                validation_oracle::TestDelta::Unavailable => record_causal_event(
                    controller,
                    causal_repair::CausalEvent::StructuralUnavailable {
                        reason: causal_reason_from_tool_output(output),
                    },
                ),
                _ => {
                    record_causal_event(controller, causal_repair::CausalEvent::StructuralPass);
                    record_causal_event(
                        controller,
                        causal_repair::CausalEvent::ReproducerDelta { delta },
                    );
                    if let Some(checkpoints) = checkpoints.as_mut() {
                        record_causal_checkpoint_update(
                            checkpoints.observe_reproducer(workdir, delta),
                        );
                    }
                }
            }
        }
        _ => {}
    }
}

fn record_post_patch_task_evidence_result(
    controller: &mut Option<causal_repair::CausalRepairController>,
    checkpoints: &mut Option<causal_checkpoint::CausalCheckpointStore>,
    workdir: &str,
    tool_name: &str,
    output: &str,
) {
    let delta = causal_task_reproducer_delta(output);
    let signal = match (tool_name, delta) {
        ("write_task_reproducer", _)
            if output.contains("SW_TASK_REPRODUCER_STATUS=qualified") =>
        {
            "post_patch_task_reproducer_qualified"
        }
        ("write_task_reproducer", _) => "post_patch_task_reproducer_unavailable",
        ("run_task_reproducer", Some(_)) => "post_patch_task_reproducer_delta",
        ("run_task_reproducer", None) => "post_patch_task_reproducer_unavailable",
        _ => "post_patch_task_evidence_observed",
    };
    let detail = delta
        .map(|delta| format!("delta={}", delta.as_str()))
        .unwrap_or_else(|| causal_reason_from_tool_output(output));
    record_causal_event(
        controller,
        causal_repair::CausalEvent::ValidationObserved {
            signal: signal.to_string(),
            detail,
        },
    );
    if let (Some(delta), Some(checkpoints)) = (delta, checkpoints.as_mut()) {
        record_causal_checkpoint_update(checkpoints.observe_reproducer(workdir, delta));
    }
}

fn prepare_causal_patch(
    controller: &mut Option<causal_repair::CausalRepairController>,
    checkpoints: &mut Option<causal_checkpoint::CausalCheckpointStore>,
    patch_fingerprint: String,
) {
    if let Some(checkpoints) = checkpoints.as_mut() {
        checkpoints.begin_patch(&patch_fingerprint);
    }
    let Some(state) = controller
        .as_ref()
        .map(causal_repair::CausalRepairController::state)
    else {
        return;
    };
    if state == causal_repair::CausalState::BaselineMapped {
        record_causal_event(
            controller,
            causal_repair::CausalEvent::NoCausalOracle {
                reason: "production edit began before a task reproducer was qualified".to_string(),
            },
        );
    }
    if controller
        .as_ref()
        .is_some_and(|controller| controller.state() != causal_repair::CausalState::RepairPlanned)
    {
        record_causal_event(
            controller,
            causal_repair::CausalEvent::RepairPlanned {
                reason: "production edit accepted".to_string(),
            },
        );
    }
    record_causal_event(
        controller,
        causal_repair::CausalEvent::PatchApplied { patch_fingerprint },
    );
}

/// Record one sandboxed TestSpec execution as a typed, baseline-relative
/// causal observation. This is repair control data only: the canonical
/// SWE-bench evaluator remains the sole outcome authority.
fn record_causal_scope_validation(
    controller: &mut Option<causal_repair::CausalRepairController>,
    checkpoints: &mut Option<causal_checkpoint::CausalCheckpointStore>,
    workdir: &str,
    scope: &serde_json::Value,
    scope_desc: &str,
    output: &str,
    changed_files: &[(String, usize, usize)],
) -> causal_validation::CausalScopeAssessment {
    let assessment = causal_validation::assess(scope, output, changed_files);
    let detail = assessment.trace_detail(scope_desc);
    record_causal_event(
        controller,
        causal_repair::CausalEvent::ValidationObserved {
            signal: assessment.signal.as_str().to_string(),
            detail,
        },
    );

    let state = controller
        .as_ref()
        .map(causal_repair::CausalRepairController::state);
    match assessment.signal {
        causal_validation::CausalScopeSignal::RegressionPass => {
            if state == Some(causal_repair::CausalState::PatchApplied) {
                record_causal_event(controller, causal_repair::CausalEvent::StructuralPass);
            }
            record_causal_event(controller, causal_repair::CausalEvent::RegressionPass);
        }
        causal_validation::CausalScopeSignal::RegressionFailure => {
            record_causal_event(
                controller,
                causal_repair::CausalEvent::RegressionFailure {
                    reason: assessment.validation.decision.reason.clone(),
                },
            );
        }
        causal_validation::CausalScopeSignal::TaskScopeImproved
        | causal_validation::CausalScopeSignal::StructuralPass => {
            if state == Some(causal_repair::CausalState::PatchApplied) {
                record_causal_event(controller, causal_repair::CausalEvent::StructuralPass);
            }
        }
        causal_validation::CausalScopeSignal::StructuralFailure => {
            record_causal_event(
                controller,
                causal_repair::CausalEvent::StructuralFailure {
                    reason: assessment.validation.decision.reason.clone(),
                },
            );
        }
        causal_validation::CausalScopeSignal::Unavailable => {
            record_causal_event(
                controller,
                causal_repair::CausalEvent::StructuralUnavailable {
                    reason: assessment.validation.decision.reason.clone(),
                },
            );
        }
        causal_validation::CausalScopeSignal::TaskScopeStillFailing
        | causal_validation::CausalScopeSignal::FeedbackFailure => {
            record_causal_event(
                controller,
                causal_repair::CausalEvent::RepairPlanned {
                    reason: format!(
                        "{}: {}",
                        assessment.signal.as_str(),
                        assessment.validation.decision.reason
                    ),
                },
            );
        }
    }
    if let Some(checkpoints) = checkpoints.as_mut() {
        record_causal_checkpoint_update(checkpoints.observe_scope(workdir, assessment.signal));
    }
    assessment
}

fn record_causal_validation_unavailable(
    controller: &mut Option<causal_repair::CausalRepairController>,
    scope_desc: &str,
    reason: impl Into<String>,
) {
    let reason = reason.into();
    record_causal_event(
        controller,
        causal_repair::CausalEvent::ValidationObserved {
            signal: "unavailable".to_string(),
            detail: format!("scope={scope_desc} reason={reason}"),
        },
    );
    record_causal_event(
        controller,
        causal_repair::CausalEvent::StructuralUnavailable { reason },
    );
}

fn causal_post_edit_guard_failure(
    workdir: &str,
    changed: &[(String, usize, usize)],
    max_diff_lines: usize,
    sw_test_files: &HashMap<String, String>,
) -> Option<String> {
    if let Some(reason) = patch_shape_violation(changed, max_diff_lines) {
        return Some(reason);
    }
    let changed_tests: Vec<&str> = changed
        .iter()
        .map(|(path, _, _)| path.as_str())
        .filter(|path| is_test_path(path, sw_test_files))
        .collect();
    if !changed_tests.is_empty() {
        return Some(format!(
            "test-file edit is not an admissible production repair: {}",
            changed_tests.join(", ")
        ));
    }
    pre_completion_python_syntax_guard(workdir)
}

fn record_causal_structural_checkpoint(
    controller: &mut Option<causal_repair::CausalRepairController>,
    checkpoints: &mut Option<causal_checkpoint::CausalCheckpointStore>,
    workdir: &str,
) {
    record_causal_event(controller, causal_repair::CausalEvent::StructuralPass);
    if let Some(checkpoints) = checkpoints.as_mut() {
        record_causal_checkpoint_update(checkpoints.observe_scope(
            workdir,
            causal_validation::CausalScopeSignal::StructuralPass,
        ));
    }
}

fn causal_post_edit_can_audit(
    has_qualified_reproducer: bool,
    reproducer_delta: Option<validation_oracle::TestDelta>,
    scope_signal: causal_validation::CausalScopeSignal,
) -> bool {
    causal_control::evidence_tier(has_qualified_reproducer, reproducer_delta, scope_signal)
        == causal_control::EvidenceTier::Efficacy
}

/// CLU policy may set legacy exploration variables while it tunes bounded
/// localization. The causal controller keeps its repair trajectory serial,
/// regardless of those policy defaults.
fn enforce_causal_serial_env() {
    unsafe {
        std::env::set_var("SW_CANDIDATE_FANOUT_DISABLED", "1");
        std::env::set_var("SW_CANDIDATE_FANOUT", "0");
        std::env::set_var("SW_SCOUT_LANE_ESCALATION", "0");
        std::env::set_var("SW_CANDIDATE_BANK", "0");
        std::env::set_var("SW_PATCH_TOURNAMENT", "0");
    }
}

fn append_jsonl_artifact<T: Serialize>(name: &str, value: &T) {
    let Some(dir) = artifact_dir_from_env() else {
        return;
    };
    if let Err(err) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "  [ARTIFACT] mkdir failed path={} error={}",
            dir.display(),
            err
        );
        return;
    }
    let path = dir.join(name);
    let mut file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(err) => {
            eprintln!(
                "  [ARTIFACT] open failed path={} error={}",
                path.display(),
                err
            );
            return;
        }
    };
    let line = match serde_json::to_string(value) {
        Ok(line) => line,
        Err(err) => {
            eprintln!(
                "  [ARTIFACT] serialize failed path={} error={}",
                path.display(),
                err
            );
            return;
        }
    };
    use std::io::Write;
    if let Err(err) = writeln!(file, "{}", line) {
        eprintln!(
            "  [ARTIFACT] append failed path={} error={}",
            path.display(),
            err
        );
    }
}

fn write_problem_shape_artifact(shape: &ProblemShape) {
    write_json_artifact("problem-shape.json", shape);
}

fn write_clu_policy_artifact(policy: &CluSolverPolicy) {
    write_json_artifact("clu-policy.json", policy);
}

fn write_scout_route_artifact(route: &ScoutRouteDecision) {
    write_json_artifact("scout-route.json", route);
}

fn write_repair_evidence_graph_artifact(
    shape: &ProblemShape,
    policy: Option<&CluSolverPolicy>,
    hypotheses: &[PatchHypothesis],
) {
    let graph = RepairEvidenceGraph {
        schema_version: 1,
        artifact: "statewright.repair_evidence_graph",
        official_verifier_boundary: "telemetry_only; official SWE-bench verifier determines solve status",
        problem_shape: shape.clone(),
        policy: policy.cloned(),
        test_scope: RepairTestScopeSummary {
            trusted: shape.trusted_test_scope,
            feedback_promoted: shape.feedback_scope_promoted,
            advisory_files: shape.advisory_test_files.clone(),
            advisory_labels: shape.advisory_test_labels.clone(),
            advisory_candidates: shape.advisory_test_candidates.clone(),
        },
        hypotheses: hypotheses.to_vec(),
    };
    write_json_artifact("evidence-graph.json", &graph);
}

fn write_clu_plan_artifact(policy: &CluSolverPolicy, hypotheses: &[PatchHypothesis]) {
    let machine_lane = ProblemShapeMachineLane::from_policy(policy);
    let plan = CluPlan {
        schema_version: 1,
        artifact: "statewright.clu_plan",
        scoring_boundary: "local plan and scoped validation rank candidates only; official SWE-bench verifier is authoritative",
        profile: policy.profile.clone(),
        workflow_lane: policy.workflow_lane.as_str().to_string(),
        state_machine_lane: machine_lane.as_str().to_string(),
        candidate_budget: policy.candidate_bank_max,
        patch_tournament_mode: candidate_fanout::plan_mode_from_env(
            policy.patch_tournament_enabled,
        )
        .to_string(),
        hypothesis_agenda: hypotheses.to_vec(),
        guard_policy: CluGuardPolicy {
            off_hypothesis_edit_threshold: policy.off_hypothesis_edit_threshold,
            path_argument_failure_threshold: policy.path_argument_failure_threshold,
            hypothesis_step_budget: policy.hypothesis_step_budget,
            scope_validation_timeout_seconds: policy.scope_validation_timeout_seconds,
            scope_validation_total_seconds: policy.scope_validation_total_seconds,
            scope_validation_max_candidates: policy.scope_validation_max_candidates,
            candidate_bank_reanchor_quarantine_after: policy
                .candidate_bank_reanchor_quarantine_after,
        },
        selection_policy: vec![
            "prefer official verifier pass when available".to_string(),
            "treat scoped/internal test pass as ranking telemetry only".to_string(),
            "reject repeated same-failure candidates without fresh source evidence".to_string(),
            "restore or advance before allowing stale edits to compound".to_string(),
        ],
        reasons: policy.reasons.clone(),
    };
    write_json_artifact("clu-plan.json", &plan);
}

fn write_hypothesis_ledger_artifact(
    hypotheses: &[PatchHypothesis],
    active_index: usize,
    exhausted: bool,
    reason: &str,
) {
    let active_hypothesis_id = if exhausted {
        None
    } else {
        hypotheses.get(active_index).map(|hypothesis| hypothesis.id)
    };
    let entries = hypotheses
        .iter()
        .enumerate()
        .map(|(idx, hypothesis)| {
            let status = if exhausted {
                "exhausted"
            } else if idx == active_index {
                "active"
            } else if idx < active_index {
                "rejected"
            } else {
                "queued"
            };
            HypothesisLedgerEntry {
                id: hypothesis.id,
                path: hypothesis.path.clone(),
                score: hypothesis.score,
                reason: hypothesis.reason.clone(),
                status: status.to_string(),
                rank: idx + 1,
            }
        })
        .collect();
    let ledger = HypothesisLedger {
        schema_version: 1,
        artifact: "statewright.hypothesis_ledger",
        active_hypothesis_id,
        exhausted,
        reason: reason.to_string(),
        hypotheses: entries,
    };
    write_json_artifact("hypothesis-ledger.json", &ledger);
}

fn write_selection_report_artifact(
    hypotheses: &[PatchHypothesis],
    active_index: usize,
    exhausted: bool,
    reason: &str,
) {
    let active = if exhausted {
        None
    } else {
        hypotheses.get(active_index)
    };
    let report = SelectionReport {
        schema_version: 1,
        artifact: "statewright.selection_report",
        scoring_note: "local candidate selection telemetry only; official SWE-bench verifier determines benchmark solve status",
        active_hypothesis_id: active.map(|hypothesis| hypothesis.id),
        active_path: active.map(|hypothesis| hypothesis.path.clone()),
        exhausted,
        reason: reason.to_string(),
        candidate_count: hypotheses.len(),
    };
    write_json_artifact("selection-report.json", &report);
}

fn write_candidate_state_artifacts(
    hypotheses: &[PatchHypothesis],
    active_index: usize,
    exhausted: bool,
    reason: &str,
) {
    write_hypothesis_ledger_artifact(hypotheses, active_index, exhausted, reason);
    write_selection_report_artifact(hypotheses, active_index, exhausted, reason);
}

fn append_patch_candidate_artifact(hypothesis: &PatchHypothesis, outcome: &str, detail: &str) {
    append_jsonl_artifact(
        "patch-candidates.jsonl",
        &PatchCandidateEvent {
            event: "candidate_lifecycle",
            candidate_id: format!("h{}", hypothesis.id),
            hypothesis_id: hypothesis.id,
            path: hypothesis.path.clone(),
            score: hypothesis.score,
            reason: hypothesis.reason.clone(),
            outcome: outcome.to_string(),
            detail: detail.to_string(),
            scoring_note: "candidate lifecycle telemetry only; official SWE-bench verifier determines solve status",
        },
    );
}

fn append_patch_attempt_artifact(event: &PatchAttemptEvent) {
    append_jsonl_artifact("patch-attempts.jsonl", event);
}

fn render_patch_hypothesis_prompt(hypothesis: &PatchHypothesis, total: usize) -> String {
    format!(
        "Patch hypothesis {}/{}: focus first on `{}` (score {}, {}). Read that file before editing. Apply one minimal source-only patch in that locus unless concrete repo evidence proves a different source file is required. Do not keep applying stale edits from a previous hypothesis.",
        hypothesis.id, total, hypothesis.path, hypothesis.score, hypothesis.reason
    )
}

fn log_patch_attempt(hypothesis: &PatchHypothesis, outcome: &str, detail: &str) {
    let detail = truncate(detail, 220).replace('\n', " ");
    println!(
        "  [PATCH-ATTEMPT] hypothesis={} path={} outcome={} detail={}",
        hypothesis.id, hypothesis.path, outcome, detail
    );
    append_patch_attempt_artifact(&PatchAttemptEvent {
        event: "patch_attempt".to_string(),
        hypothesis_id: hypothesis.id,
        path: hypothesis.path.clone(),
        score: hypothesis.score,
        reason: hypothesis.reason.clone(),
        outcome: outcome.to_string(),
        detail: detail.clone(),
    });
    append_patch_candidate_artifact(hypothesis, outcome, &detail);
}

fn advance_patch_hypothesis(
    hypotheses: &[PatchHypothesis],
    active_index: &mut usize,
    rejected_outcome: &str,
    detail: &str,
) -> Option<String> {
    let rejected = hypotheses.get(*active_index)?;
    log_patch_attempt(rejected, rejected_outcome, detail);
    if *active_index + 1 >= hypotheses.len() {
        println!(
            "  [STAGNATION] action=exhausted_hypotheses reason={} count={}",
            rejected_outcome,
            hypotheses.len()
        );
        write_candidate_state_artifacts(hypotheses, *active_index, true, rejected_outcome);
        return None;
    }
    *active_index += 1;
    let next = hypotheses.get(*active_index)?;
    println!(
        "  [STAGNATION] action=next_hypothesis reason={} next={} path={}",
        rejected_outcome, next.id, next.path
    );
    log_patch_attempt(next, "selected", rejected_outcome);
    write_candidate_state_artifacts(hypotheses, *active_index, false, rejected_outcome);
    Some(render_patch_hypothesis_prompt(next, hypotheses.len()))
}

fn should_repair_parse_fail_on_active_hypothesis(
    policy: Option<&CluSolverPolicy>,
    hypotheses: &[PatchHypothesis],
    active_index: usize,
) -> bool {
    let Some(active) = hypotheses.get(active_index) else {
        return false;
    };
    if policy
        .map(|policy| policy.workflow_lane.repair_parse_before_switch())
        .unwrap_or(false)
    {
        return true;
    }

    let next_score = hypotheses
        .iter()
        .enumerate()
        .filter(|(idx, _)| *idx != active_index)
        .map(|(_, hypothesis)| hypothesis.score)
        .max()
        .unwrap_or(0);
    active.score >= 120
        && (next_score == 0 || active.score.saturating_mul(100) / next_score.max(1) >= 250)
}

fn path_argument_failures_should_switch_hypothesis(policy: Option<&CluSolverPolicy>) -> bool {
    policy
        .map(|policy| !policy.workflow_lane.is_retention())
        .unwrap_or(true)
}

fn no_progress_hypothesis_threshold(policy: Option<&CluSolverPolicy>, configured: u32) -> u32 {
    policy
        .map(|policy| policy.workflow_lane.no_progress_threshold())
        .unwrap_or(configured)
}

fn promote_patch_hypothesis_path(
    hypotheses: &mut Vec<PatchHypothesis>,
    active_index: &mut usize,
    path: &str,
    reason: &str,
) -> Option<String> {
    let normalized_path = normalize_problem_shape_path(path);
    if normalized_path.is_empty() || !is_problem_shape_source_path(&normalized_path) {
        return None;
    }
    if let Some((idx, hypothesis)) = hypotheses
        .iter()
        .enumerate()
        .find(|(_, hypothesis)| normalize_problem_shape_path(&hypothesis.path) == normalized_path)
    {
        if idx < *active_index {
            log_patch_attempt(
                hypothesis,
                "revisit_blocked",
                "previously exhausted hypothesis requires a new evidence packet, not a stale path promotion",
            );
            println!(
                "  [STAGNATION] action=blocked_exhausted_hypothesis path={} exhausted_index={} active_index={}",
                hypothesis.path, idx, *active_index
            );
            return None;
        }
        *active_index = idx;
        log_patch_attempt(hypothesis, "selected", reason);
        write_candidate_state_artifacts(hypotheses, *active_index, false, reason);
        return Some(render_patch_hypothesis_prompt(hypothesis, hypotheses.len()));
    }

    let score = hypotheses
        .get(*active_index)
        .map(|hypothesis| hypothesis.score.saturating_sub(1).max(1))
        .unwrap_or(1);
    let hypothesis = PatchHypothesis {
        id: hypotheses.len() + 1,
        path: normalized_path,
        score,
        reason: reason.to_string(),
    };
    let insert_at = (*active_index + 1).min(hypotheses.len());
    hypotheses.insert(insert_at, hypothesis);
    *active_index = insert_at;
    let active = hypotheses.get(*active_index)?;
    log_patch_attempt(active, "selected", reason);
    write_candidate_state_artifacts(hypotheses, *active_index, false, reason);
    Some(render_patch_hypothesis_prompt(active, hypotheses.len()))
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
        if source_files
            .iter()
            .any(|f| *f == c.as_str() || f.ends_with(c.as_str()))
        {
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
                let base = module
                    .trim()
                    .split(' ')
                    .next()
                    .unwrap_or("")
                    .trim_start_matches('.');
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
            "write_task_reproducer" => Some(
                r#"- write_task_reproducer: args: {"name": "test_task_reproducer.py", "source": "Python scratch test source"}; stored outside the repository patch, must import its helpers, and must assert desired post-fix behavior rather than the reported bug"#,
            ),
            "run_task_reproducer" => Some(
                r#"- run_task_reproducer: args: {}; rerun the qualified scratch reproducer against the current source patch in the isolated validation worktree"#,
            ),
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
        "write_task_reproducer",
        "run_task_reproducer",
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

fn issue_behavior_checklist(task: &str) -> String {
    let mut code_blocks = Vec::new();
    let mut in_fence = false;
    let mut current_block: Vec<String> = Vec::new();
    let mut signal_lines = Vec::new();
    let signal_needles = [
        "traceback",
        "typeerror",
        "valueerror",
        "assertionerror",
        "expected",
        "actual",
        "instead",
        "should",
        "fails",
        "error",
        "exception",
    ];

    for raw_line in task.lines() {
        let line = raw_line.trim_end();
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            if in_fence {
                if !current_block.is_empty() {
                    code_blocks.push(current_block.join("\n"));
                    current_block.clear();
                }
                in_fence = false;
            } else {
                in_fence = true;
            }
            continue;
        }

        if in_fence {
            if current_block.len() < 18 && !trimmed.is_empty() {
                current_block.push(line.to_string());
            }
            continue;
        }

        let lower = trimmed.to_ascii_lowercase();
        let comparison_like = (trimmed.contains("==")
            || trimmed.contains("!=")
            || trimmed.contains("->")
            || trimmed.contains("=>"))
            && trimmed.len() <= 180;
        if comparison_like || signal_needles.iter().any(|needle| lower.contains(needle)) {
            if !trimmed.is_empty() && trimmed.len() <= 220 {
                signal_lines.push(trimmed.to_string());
            }
        }
    }

    if in_fence && !current_block.is_empty() {
        code_blocks.push(current_block.join("\n"));
    }

    code_blocks.truncate(2);
    signal_lines.sort();
    signal_lines.dedup();
    signal_lines.truncate(8);

    let mut out = String::new();
    if !code_blocks.is_empty() {
        out.push_str("Reproduce or reason through these issue examples before finishing:\n");
        for (index, block) in code_blocks.iter().enumerate() {
            out.push_str(&format!("\nExample {}:\n```\n{}\n```\n", index + 1, block));
        }
    }
    if !signal_lines.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str("Issue behavior signals:\n");
        for line in signal_lines {
            out.push_str(&format!("- {}\n", line));
        }
    }
    out.trim().to_string()
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

fn is_repo_localization_asset(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    let basename = std::path::Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let extension = std::path::Path::new(&normalized)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("");

    normalized.contains("/locale/")
        || normalized.starts_with("locale/")
        || normalized.contains("/locales/")
        || normalized.starts_with("locales/")
        || normalized.contains("/l10n/")
        || normalized.starts_with("l10n/")
        || normalized.contains("/i18n/")
        || normalized.starts_with("i18n/")
        || matches!(extension, "po" | "pot" | "mo")
        || basename == "django.po"
        || basename == "django.mo"
}

fn task_explicitly_mentions_repo_localization(task: &str) -> bool {
    let lower = task.to_ascii_lowercase();
    [
        "translation",
        "translations",
        "locale",
        "locales",
        "localization",
        "localisation",
        "i18n",
        "l10n",
        "gettext",
        ".po",
        ".pot",
        ".mo",
        "message catalog",
        "language catalog",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
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

fn edit_tool_requires_path(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "edit_line" | "edit_block" | "patch_file" | "insert_between"
    )
}

fn push_source_locus_intel(
    candidates: &mut Vec<SourceLocusIntel>,
    seen: &mut HashSet<String>,
    path: &str,
    source: &'static str,
    detail: impl Into<String>,
    workdir: &str,
    sw_test_files: &HashMap<String, String>,
) {
    let resolved = tools::resolve_repo_path(path, workdir);
    let normalized = resolved.strip_prefix("./").unwrap_or(&resolved).to_string();
    if normalized.is_empty()
        || is_test_path(&normalized, sw_test_files)
        || is_repo_localization_asset(&normalized)
    {
        return;
    }
    if !std::path::Path::new(workdir).join(&normalized).is_file() {
        return;
    }
    if seen.insert(normalized.clone()) {
        candidates.push(SourceLocusIntel {
            path: normalized,
            source,
            detail: detail.into(),
        });
    }
}

fn collect_source_locus_intel(
    read_paths: &HashSet<String>,
    localized_file_contexts: &HashMap<String, String>,
    localized_regions: &HashMap<String, Vec<(usize, String)>>,
    sw_test_files: &HashMap<String, String>,
    workdir: &str,
    active_patch_hypothesis: Option<&PatchHypothesis>,
    retained_candidate_paths: &HashSet<String>,
    problem_shape: Option<&ProblemShape>,
) -> Vec<SourceLocusIntel> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    if let Some(hypothesis) = active_patch_hypothesis {
        push_source_locus_intel(
            &mut candidates,
            &mut seen,
            &hypothesis.path,
            "active hypothesis",
            format!("score {}; {}", hypothesis.score, hypothesis.reason),
            workdir,
            sw_test_files,
        );
    }

    let mut sorted_retained_paths: Vec<&String> = retained_candidate_paths.iter().collect();
    sorted_retained_paths.sort();
    for path in sorted_retained_paths {
        push_source_locus_intel(
            &mut candidates,
            &mut seen,
            path,
            "retained candidate",
            "best prior diff touched this source path",
            workdir,
            sw_test_files,
        );
    }

    let mut sorted_read_paths: Vec<&String> = read_paths.iter().collect();
    sorted_read_paths.sort();
    for path in sorted_read_paths {
        push_source_locus_intel(
            &mut candidates,
            &mut seen,
            path,
            "read_file",
            "already inspected in this attempt",
            workdir,
            sw_test_files,
        );
    }

    let mut sorted_context_paths: Vec<&String> = localized_file_contexts.keys().collect();
    sorted_context_paths.sort();
    for path in sorted_context_paths {
        let detail = localized_file_contexts
            .get(path)
            .map(|context| truncate(&context.replace('\n', " "), 120))
            .unwrap_or_else(|| "localized excerpt available".to_string());
        push_source_locus_intel(
            &mut candidates,
            &mut seen,
            path,
            "localized context",
            detail,
            workdir,
            sw_test_files,
        );
    }

    let mut sorted_region_paths: Vec<&String> = localized_regions.keys().collect();
    sorted_region_paths.sort();
    for path in sorted_region_paths {
        let detail = localized_regions
            .get(path)
            .and_then(|regions| regions.first())
            .map(|(line, pattern)| format!("localized hit L{}: {}", line, pattern))
            .unwrap_or_else(|| "localized region available".to_string());
        push_source_locus_intel(
            &mut candidates,
            &mut seen,
            path,
            "localized region",
            detail,
            workdir,
            sw_test_files,
        );
    }

    if let Some(shape) = problem_shape {
        for file in &shape.top_files {
            push_source_locus_intel(
                &mut candidates,
                &mut seen,
                &file.path,
                "problem shape",
                format!("score {}; {}", file.score, file.reasons.join(", ")),
                workdir,
                sw_test_files,
            );
        }
    }

    candidates
}

fn grounded_edit_path_candidates(
    read_paths: &HashSet<String>,
    localized_file_contexts: &HashMap<String, String>,
    localized_regions: &HashMap<String, Vec<(usize, String)>>,
    sw_test_files: &HashMap<String, String>,
    workdir: &str,
    active_patch_hypothesis: Option<&PatchHypothesis>,
    retained_candidate_paths: &HashSet<String>,
    problem_shape: Option<&ProblemShape>,
) -> Vec<SourceLocusIntel> {
    collect_source_locus_intel(
        read_paths,
        localized_file_contexts,
        localized_regions,
        sw_test_files,
        workdir,
        active_patch_hypothesis,
        retained_candidate_paths,
        problem_shape,
    )
}

fn collect_source_locus_focus_intel(
    sw_test_files: &HashMap<String, String>,
    workdir: &str,
    active_patch_hypothesis: Option<&PatchHypothesis>,
    retained_candidate_paths: &HashSet<String>,
    problem_shape: Option<&ProblemShape>,
) -> Vec<SourceLocusIntel> {
    let read_paths = HashSet::new();
    let localized_file_contexts = HashMap::new();
    let localized_regions = HashMap::new();
    collect_source_locus_intel(
        &read_paths,
        &localized_file_contexts,
        &localized_regions,
        sw_test_files,
        workdir,
        active_patch_hypothesis,
        retained_candidate_paths,
        problem_shape,
    )
}

fn retained_candidate_source_paths(
    candidate_bank: &candidate_bank::CandidateBank,
    quarantined_reanchor_paths: &HashSet<String>,
    enabled: bool,
) -> HashSet<String> {
    if !enabled || !candidate_bank.reanchor_best_path_enabled() {
        return HashSet::new();
    }
    candidate_bank
        .best_changed_files()
        .iter()
        .map(|path| normalize_problem_shape_path(path))
        .filter(|path| !quarantined_reanchor_paths.contains(path))
        .collect()
}

fn parse_path_handle(path: &str, candidate_count: usize) -> Option<usize> {
    let trimmed = path.trim();
    let digits = trimmed
        .strip_prefix('P')
        .or_else(|| trimmed.strip_prefix('p'))?;
    if digits.is_empty() || !digits.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let ordinal = digits.parse::<usize>().ok()?;
    if ordinal == 0 || ordinal > candidate_count {
        None
    } else {
        Some(ordinal - 1)
    }
}

fn edit_old_text(tool_args: &serde_json::Value) -> Option<&str> {
    tool_args
        .get("old")
        .and_then(|old| old.as_str())
        .map(str::trim)
        .filter(|old| old.len() >= 8)
}

fn unique_candidate_for_old_text(
    candidates: &[SourceLocusIntel],
    tool_args: &serde_json::Value,
    workdir: &str,
) -> Option<(String, &'static str)> {
    let old = edit_old_text(tool_args)?;
    let mut matches = Vec::new();
    for candidate in candidates {
        let full_path = std::path::Path::new(workdir).join(&candidate.path);
        if std::fs::read_to_string(full_path)
            .map(|content| content.contains(old))
            .unwrap_or(false)
        {
            matches.push((candidate.path.clone(), candidate.source));
        }
    }
    if matches.len() == 1 {
        matches.into_iter().next()
    } else {
        None
    }
}

fn edit_path_argument_problem(
    tool_name: &str,
    tool_args: &serde_json::Value,
    workdir: &str,
) -> Option<String> {
    if !edit_tool_requires_path(tool_name) {
        return None;
    }
    let path = tool_args
        .get("path")
        .and_then(|path| path.as_str())
        .map(str::trim)
        .unwrap_or("");
    if path.is_empty() {
        return Some("missing path".to_string());
    }
    let resolved = tools::resolve_repo_path(path, workdir);
    if std::path::Path::new(workdir).join(&resolved).is_file() {
        None
    } else {
        Some(format!("nonexistent path `{}`", path))
    }
}

fn format_path_repair_candidates(candidates: &[SourceLocusIntel]) -> String {
    if candidates.is_empty() {
        "No grounded source candidates are available yet. Use read_file, grep, inspect_class, or find_files before editing.".to_string()
    } else {
        candidates
            .iter()
            .take(6)
            .enumerate()
            .map(|(idx, candidate)| {
                format!(
                    "P{} `{}` ({}) — {}",
                    idx + 1,
                    candidate.path,
                    candidate.source,
                    truncate(&candidate.detail.replace('\n', " "), 140)
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn format_source_locus_intel_packet(candidates: &[SourceLocusIntel]) -> String {
    if candidates.is_empty() {
        "No grounded source-locus intel is available yet; inspect source files before editing."
            .to_string()
    } else {
        format!(
            "Grounded source-locus intel:\n{}",
            format_path_repair_candidates(candidates)
        )
    }
}

fn repair_edit_path_argument(
    tool_name: &str,
    tool_args: &mut serde_json::Value,
    read_paths: &HashSet<String>,
    localized_file_contexts: &HashMap<String, String>,
    localized_regions: &HashMap<String, Vec<(usize, String)>>,
    sw_test_files: &HashMap<String, String>,
    workdir: &str,
    active_patch_hypothesis: Option<&PatchHypothesis>,
    retained_candidate_paths: &HashSet<String>,
    problem_shape: Option<&ProblemShape>,
) -> Option<(String, &'static str)> {
    if !edit_tool_requires_path(tool_name) {
        return None;
    }

    let candidates = grounded_edit_path_candidates(
        read_paths,
        localized_file_contexts,
        localized_regions,
        sw_test_files,
        workdir,
        active_patch_hypothesis,
        retained_candidate_paths,
        problem_shape,
    );
    let current_path = tool_args
        .get("path")
        .and_then(|path| path.as_str())
        .map(str::trim)
        .unwrap_or("");

    let repaired = if let Some(idx) = parse_path_handle(current_path, candidates.len()) {
        let path = candidates[idx].path.clone();
        Some((path, "path handle"))
    } else if !current_path.is_empty() {
        let resolved = tools::resolve_repo_path(current_path, workdir);
        if std::path::Path::new(workdir).join(&resolved).is_file() {
            None
        } else {
            unique_candidate_for_old_text(&candidates, tool_args, workdir)
        }
    } else if let Some(unique_old_match) =
        unique_candidate_for_old_text(&candidates, tool_args, workdir)
    {
        Some(unique_old_match)
    } else if candidates.len() == 1 {
        let candidate = candidates.into_iter().next().unwrap();
        Some((candidate.path, candidate.source))
    } else {
        None
    };

    let (path, source) = repaired?;
    if let Some(object) = tool_args.as_object_mut() {
        object.insert("path".into(), json!(path.clone()));
        Some((path, source))
    } else {
        None
    }
}

fn edit_attempt_fingerprint(
    tool_name: &str,
    tool_args: &serde_json::Value,
    targeted_paths: &[String],
) -> Option<String> {
    if !is_write_tool(tool_name) {
        return None;
    }
    let mut paths: Vec<String> = targeted_paths
        .iter()
        .map(|path| path.strip_prefix("./").unwrap_or(path).to_string())
        .collect();
    paths.sort();
    Some(format!(
        "{}|{}|{}",
        tool_name,
        paths.join(","),
        serde_json::to_string(tool_args).unwrap_or_default()
    ))
}

fn is_implementation_state(state: &str) -> bool {
    matches!(state, "implementing" | "editing")
}

fn is_validation_state(state: &str) -> bool {
    matches!(state, "testing" | "micro_validation")
}

fn is_review_like_state(state: &str) -> bool {
    matches!(state, "review" | "completion_audit")
}

fn implementation_state_name(definition: &MachineDefinition) -> String {
    if definition.states.contains_key("editing") {
        "editing".into()
    } else {
        "implementing".into()
    }
}

fn failure_triage_state_name(definition: &MachineDefinition) -> String {
    if definition.states.contains_key("failure_triage") {
        "failure_triage".into()
    } else {
        implementation_state_name(definition)
    }
}

fn trusted_pass_state_name(definition: &MachineDefinition) -> String {
    if definition.states.contains_key("completion_audit") {
        "completion_audit".into()
    } else {
        "review".into()
    }
}

fn task_evidence_state_name(definition: &MachineDefinition) -> String {
    if definition.states.contains_key("task_evidence_acquisition") {
        "task_evidence_acquisition".into()
    } else {
        trusted_pass_state_name(definition)
    }
}

fn validation_unavailable_state_name(definition: &MachineDefinition) -> String {
    if candidate_fanout::process_depth_from_env() > 0
        || deprecated_preserve_unavailable_validation_enabled()
    {
        trusted_pass_state_name(definition)
    } else {
        failure_triage_state_name(definition)
    }
}

fn localized_next_state(definition: &MachineDefinition) -> String {
    definition
        .states
        .get("localizing")
        .and_then(|state| state.on.get("LOCALIZED"))
        .map(|transition| transition.target().to_string())
        .unwrap_or_else(|| "planning".into())
}

fn selected_hardcoded_machine_variant(args: &Args) -> String {
    std::env::var("SW_HARDCODED_MACHINE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| args.hardcoded_machine.clone())
        .trim()
        .to_ascii_lowercase()
}

fn deprecated_unknown_machine_legacy_fallback_enabled() -> bool {
    env_flag("DEPRECATED_SW_UNKNOWN_MACHINE_LEGACY_FALLBACK", false)
}

fn hardcoded_bug_fix_machine_for_variant(variant: &str) -> MachineDefinition {
    match variant {
        "speed" | "shotgun" | "candidate" | "fanout-child" | "fast" => {
            hardcoded_speed_solver_machine()
        }
        "v2" | "structured" | "guarded" | "new" => hardcoded_bug_fix_machine_v2(),
        "legacy" | "v1" | "old" => hardcoded_bug_fix_machine(),
        other => {
            if deprecated_unknown_machine_legacy_fallback_enabled() {
                eprintln!(
                    "[Phase 1] DEPRECATED: unknown hardcoded machine variant '{}'; using legacy",
                    other
                );
                hardcoded_bug_fix_machine()
            } else {
                eprintln!(
                    "[Phase 1] CONFIG WARNING: unknown hardcoded machine variant '{}'; using structured",
                    other
                );
                hardcoded_bug_fix_machine_v2()
            }
        }
    }
}

fn is_stagnation_diagnostic_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "read_file"
            | "grep"
            | "inspect_class"
            | "find_files"
            | "list_directory"
            | "diff"
            | "run_test"
    )
}

fn is_same_test_recovery_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "read_file" | "grep" | "inspect_class" | "find_files" | "diff"
    )
}

fn is_fresh_recovery_observation(result: &str, from_observation_cache: bool) -> bool {
    !from_observation_cache
        && !result.starts_with("(cached")
        && !result.starts_with("error")
        && !result.starts_with("BLOCKED")
}

fn patch_shape_violation(
    changed: &[(String, usize, usize)],
    max_diff_lines: usize,
) -> Option<String> {
    causal_control::patch_shape_violation(changed, max_diff_lines)
}

fn auto_test_failure_signature(test_scope: &serde_json::Value, output: &str) -> String {
    let scope = serde_json::to_string(test_scope).unwrap_or_else(|_| "{}".into());
    let excerpt = failure_excerpt(output, 8);
    let signal = if excerpt.trim().is_empty() {
        output
            .lines()
            .filter(|line| !line.trim().is_empty())
            .take(8)
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        excerpt
    };
    format!(
        "scope={}; exit={:?}; signal={}",
        scope,
        test_exit_code(output),
        signal
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

fn test_scope_authority(output: &str) -> Option<&str> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("SW_TEST_SCOPE_AUTHORITY=")
            .map(str::trim)
    })
}

fn test_scope_untrusted(output: &str) -> bool {
    if let Some(authority) = test_scope_authority(output) {
        return !matches!(authority, "trusted" | "feedback");
    }
    output
        .lines()
        .any(|line| line.trim() == "SW_TEST_SCOPE_TRUSTED=0")
}

fn untrusted_scope_must_route_unavailable(causal_one_pass: bool, output: &str) -> bool {
    test_scope_untrusted(output)
        && (!causal_one_pass
            || repair_feedback::classify_output(output)
                == repair_feedback::RepairSignalKind::Passed)
}

fn test_scope_can_complete(output: &str) -> bool {
    !output
        .lines()
        .any(|line| line.trim() == "SW_TEST_CAN_COMPLETE=0")
}

fn test_ran_zero_tests(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.contains("ran 0 tests")
        || lower.contains("0 tests ran")
        || lower.contains("no tests ran")
        || lower.contains("no tests collected")
        || lower.contains("collected 0 items")
}

fn test_collection_or_scope_failure(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    matches!(test_exit_code(output), Some(4 | 5))
        || test_ran_zero_tests(output)
        || lower.contains("one of the test labels is a path to a file")
        || lower.contains("use a dotted module name or path to a directory instead")
        || lower.contains("importerror while loading conftest")
}

fn test_collection_failure_unrelated_to_diff(
    output: &str,
    changed_files: &[(String, usize, usize)],
) -> bool {
    if !test_collection_or_scope_failure(output) {
        return false;
    }
    if changed_files.is_empty() {
        return true;
    }
    !validation_oracle::output_references_changed_source(output, changed_files)
}

fn restore_tracked_test_side_effects(
    workdir: &str,
    changed_before_test: &[(String, usize, usize)],
) -> Vec<String> {
    let before_paths: HashSet<String> = changed_before_test
        .iter()
        .map(|(path, _, _)| normalize_repo_path(path))
        .collect();
    let mut side_effects = Vec::new();
    for (path, _, _) in tools::all_diff_stats(workdir) {
        let normalized = normalize_repo_path(&path);
        if !before_paths.contains(&normalized) {
            push_unique_string(&mut side_effects, normalized);
        }
    }
    if side_effects.is_empty() {
        return Vec::new();
    }

    let mut tracked = Vec::new();
    for path in &side_effects {
        let is_tracked = Command::new("git")
            .args(["ls-files", "--error-unmatch", "--", path])
            .current_dir(workdir)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
        if is_tracked {
            tracked.push(path.clone());
        }
    }
    if tracked.is_empty() {
        return Vec::new();
    }

    let status = Command::new("git")
        .arg("checkout")
        .arg("--")
        .args(tracked.iter().map(|path| path.as_str()))
        .current_dir(workdir)
        .status();
    if !matches!(status, Ok(exit) if exit.success()) {
        return Vec::new();
    }
    tracked
}

fn git_changed_paths(workdir: &str) -> Vec<String> {
    let mut paths = Vec::new();
    if let Ok(output) = Command::new("git")
        .args([
            "-c",
            "core.quotePath=false",
            "diff",
            "--name-only",
            "HEAD",
            "--",
        ])
        .current_dir(workdir)
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            push_unique_string(&mut paths, normalize_repo_path(line));
        }
    }
    if let Ok(output) = Command::new("git")
        .args([
            "-c",
            "core.quotePath=false",
            "ls-files",
            "--others",
            "--exclude-standard",
        ])
        .current_dir(workdir)
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            push_unique_string(&mut paths, normalize_repo_path(line));
        }
    }
    paths
        .into_iter()
        .filter(|path| !path.is_empty())
        .filter(|path| std::path::Path::new(workdir).join(path).is_file())
        .collect()
}

fn changed_python_files_for_completion_guard(workdir: &str) -> Vec<String> {
    git_changed_paths(workdir)
        .into_iter()
        .filter(|path| path.ends_with(".py"))
        .collect()
}

fn pre_completion_python_syntax_guard(workdir: &str) -> Option<String> {
    let changed_python = changed_python_files_for_completion_guard(workdir);
    if changed_python.is_empty() {
        return None;
    }

    for path in changed_python {
        let output = Command::new("python3")
            .args(["-m", "py_compile", path.as_str()])
            .current_dir(workdir)
            .output();
        let output = match output {
            Ok(output) => output,
            Err(err) => {
                return Some(format!(
                    "[PRE_COMPLETION_GUARD] FAIL kind=syntax_guard_unavailable path={}\ncommand: python3 -m py_compile {}\nerror: {}",
                    path, path, err
                ));
            }
        };
        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = format!("{}{}", stdout, stderr);
            return Some(format!(
                "[PRE_COMPLETION_GUARD] FAIL kind=python_syntax path={}\ncommand: python3 -m py_compile {}\n{}",
                path,
                path,
                truncate(combined.trim(), 4000)
            ));
        }
    }
    None
}

fn execute_tool_quarantining_tests(
    tool_name: &str,
    tool_args: &serde_json::Value,
    workdir: &str,
) -> String {
    if tool_name != "run_test" {
        return tools::execute_tool(tool_name, tool_args, workdir);
    }
    let changed_before_test = tools::all_diff_stats(workdir);
    let result = tools::execute_tool(tool_name, tool_args, workdir);
    let restored_side_effects = restore_tracked_test_side_effects(workdir, &changed_before_test);
    if !restored_side_effects.is_empty() {
        println!(
            "  [TEST-SIDE-EFFECT] restored tracked file(s): {}",
            restored_side_effects.join(", ")
        );
    }
    result
}

fn test_command_line(output: &str) -> Option<&str> {
    output
        .lines()
        .find_map(|line| line.strip_prefix("SW_TEST_COMMAND="))
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
        || output.contains("ImportError")
        || output.contains("ModuleNotFoundError")
        || output.contains("NameError")
        || output.contains("ValueError")
        || output.contains("TypeError")
        || output.contains("SyntaxError")
        || output.contains("IndentationError")
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

fn test_has_patch_blocking_collection_failure(output: &str) -> bool {
    test_has_syntax_failure(output)
        || test_exit_code(output) == Some(4)
        || output.contains("ERROR collecting")
        || output.contains("errors during collection")
        || output.contains("ImportError while loading conftest")
        || output.contains("ModuleNotFoundError")
        || output.contains("ImportError:")
}

fn feedback_only_collection_failure_should_be_unavailable(
    output: &str,
    changed_files: &[(String, usize, usize)],
) -> bool {
    test_has_patch_blocking_collection_failure(output)
        && test_collection_failure_unrelated_to_diff(output, changed_files)
}

fn test_passed(output: &str) -> bool {
    if test_env_unavailable(output) {
        return false;
    }
    if test_scope_untrusted(output) {
        return false;
    }
    if test_ran_zero_tests(output) {
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
                || line.contains("Traceback")
                || line.contains("failed")
                || line.contains("Error")
                || line.contains("Exception")
                || line.contains("AssertionError")
                || line.contains("ImportError")
                || line.contains("ModuleNotFoundError")
                || line.contains("NameError")
                || line.contains("ValueError")
                || line.contains("TypeError")
                || line.contains("SyntaxError")
                || line.contains("IndentationError")
                || line.trim_start().starts_with("E   ")
                || line.contains("assert ")
                || line.contains("DO *NOT* COMMIT")
        })
        .take(limit)
        .collect::<Vec<_>>()
        .join("\n")
}

fn harness_validation_scope_from_env() -> (serde_json::Value, String) {
    if let Ok(label) = std::env::var("SW_TEST_LABEL") {
        if !label.trim().is_empty() {
            let label = label.trim().to_string();
            return (json!({"label": label}), format!("SW_TEST_LABEL={}", label));
        }
    }

    let test_files = match std::env::var("SW_TEST_FILES") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => return (json!({}), "unscoped harness command".to_string()),
    };
    let mut files: Vec<String> = test_files
        .split(':')
        .filter(|f| !f.trim().is_empty())
        .map(|f| f.trim().to_string())
        .collect();
    files.sort_by_key(|path| scoped_test_path_rank(path));
    files.dedup();

    if files.is_empty() {
        return (json!({}), "unscoped harness command".to_string());
    }
    let first = files[0].clone();
    let rest = files[1..].to_vec();
    let description = if rest.is_empty() {
        format!("SW_TEST_FILES={}", first)
    } else {
        format!("SW_TEST_FILES={} (+{} more)", first, rest.len())
    };
    if rest.is_empty() {
        (json!({"path": first}), description)
    } else {
        (json!({"path": first, "args": rest}), description)
    }
}

fn test_scope_env_can_complete() -> bool {
    std::env::var("SW_TEST_CAN_COMPLETE")
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            !matches!(normalized.as_str(), "0" | "false" | "no")
        })
        .unwrap_or(true)
}

fn retarget_feedback_only_scope_enabled() -> bool {
    env_flag("SW_RETARGET_FEEDBACK_ONLY_SCOPE", false)
}

fn post_edit_repair_scope_enabled() -> bool {
    env_flag("SW_POST_EDIT_REPAIR_SCOPE", true)
}

fn auto_test_pass_can_complete(scope_desc: &str) -> bool {
    test_scope_env_can_complete()
        && (scope_desc.starts_with("SW_TEST_FILES=") || scope_desc.starts_with("SW_TEST_LABEL="))
}

fn restore_env(name: &str, previous: Option<String>) {
    unsafe {
        if let Some(value) = previous {
            std::env::set_var(name, value);
        } else {
            std::env::remove_var(name);
        }
    }
}

fn run_bounded_unscoped_discovery_probe(workdir: &str) -> String {
    let previous_probe = std::env::var("SW_TEST_UNSCOPED_PROBE").ok();
    let previous_timeout = std::env::var("SW_TEST_TIMEOUT_SECONDS").ok();
    let previous_stop = std::env::var("SW_TEST_STOP_ON_FAILURE").ok();

    unsafe {
        std::env::set_var("SW_TEST_UNSCOPED_PROBE", "1");
        std::env::set_var("SW_TEST_TIMEOUT_SECONDS", "300");
        std::env::set_var("SW_TEST_STOP_ON_FAILURE", "1");
    }
    let output = tools::execute_tool("run_test", &json!({}), workdir);

    restore_env("SW_TEST_UNSCOPED_PROBE", previous_probe);
    restore_env("SW_TEST_TIMEOUT_SECONDS", previous_timeout);
    restore_env("SW_TEST_STOP_ON_FAILURE", previous_stop);
    output
}

fn scope_validation_timeout_seconds() -> usize {
    env_usize("SW_SCOPE_VALIDATION_TIMEOUT_SECONDS", 90, 15, 600)
}

fn scope_baseline_timeout_seconds() -> usize {
    env_usize("SW_SCOPE_BASELINE_TIMEOUT_SECONDS", 180, 30, 600)
}

fn calibrated_scope_timeout_seconds(configured: usize, baseline_elapsed_ms: Option<u64>) -> usize {
    let Some(elapsed_ms) = baseline_elapsed_ms.filter(|elapsed_ms| *elapsed_ms > 0) else {
        return configured;
    };
    let elapsed_seconds = elapsed_ms.saturating_add(999) / 1_000;
    let calibrated = elapsed_seconds
        .saturating_mul(3)
        .saturating_add(1)
        / 2
        + 20;
    configured.max(calibrated as usize).min(600)
}

fn candidate_scope_timeout_seconds(files: &[String]) -> usize {
    calibrated_scope_timeout_seconds(
        scope_validation_timeout_seconds(),
        validation_oracle::baseline_scope_elapsed_ms(files),
    )
}

fn scope_validation_total_seconds() -> usize {
    env_usize("SW_SCOPE_VALIDATION_TOTAL_SECONDS", 240, 30, 1200)
}

fn scope_validation_max_candidates() -> usize {
    env_usize("SW_SCOPE_VALIDATION_MAX_CANDIDATES", 6, 1, 20)
}

fn scope_validation_groups_last() -> bool {
    std::env::var("SW_SCOPE_VALIDATION_GROUPS")
        .map(|value| {
            !matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "first" | "before" | "1" | "true"
            )
        })
        .unwrap_or(true)
}

fn strict_feedback_scope_promotion() -> bool {
    std::env::var("SW_STRICT_FEEDBACK_SCOPE_PROMOTION")
        .map(|value| {
            !matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "no" | "off"
            )
        })
        .unwrap_or(true)
}

fn run_feedback_scope_validation_with_timeout(
    scope: &serde_json::Value,
    workdir: &str,
    timeout_seconds: usize,
) -> String {
    let previous_timeout = std::env::var("SW_TEST_TIMEOUT_SECONDS").ok();
    let previous_stop = std::env::var("SW_TEST_STOP_ON_FAILURE").ok();
    unsafe {
        std::env::set_var("SW_TEST_TIMEOUT_SECONDS", timeout_seconds.to_string());
        std::env::set_var("SW_TEST_STOP_ON_FAILURE", "1");
    }
    let output = tools::execute_tool("run_test", scope, workdir);
    restore_env("SW_TEST_TIMEOUT_SECONDS", previous_timeout);
    restore_env("SW_TEST_STOP_ON_FAILURE", previous_stop);
    output
}

fn feedback_scope_validation_timed_out(output: &str) -> bool {
    output.contains("signal: timed out")
        || output.contains("SW_TEST_TIMED_OUT=1")
        || (output.contains("exit: Some(-1)") && output.contains("timed out"))
}

fn scope_baseline_probe_enabled() -> bool {
    env_flag("SW_SCOPE_BASELINE_PROBE", true)
}

fn baseline_prove_repair_scope(
    scope: &serde_json::Value,
    scope_desc: &str,
    files: &[String],
    workdir: &str,
    baseline_snapshot: Option<&tools::Snapshot>,
) -> bool {
    if validation_oracle::scope_baseline_runnable(files) {
        return true;
    }
    if !scope_baseline_probe_enabled() || files.len() != 1 {
        return false;
    }
    let Some(baseline_snapshot) = baseline_snapshot else {
        return false;
    };

    let candidate_snapshot = tools::snapshot_all(workdir);
    let previous_can_complete = std::env::var("SW_TEST_CAN_COMPLETE").ok();
    let previous_scope_authority = std::env::var("SW_TEST_SCOPE_AUTHORITY").ok();
    let previous_scope_trusted = std::env::var("SW_TEST_SCOPE_TRUSTED").ok();
    unsafe {
        std::env::set_var("SW_TEST_CAN_COMPLETE", "0");
        std::env::set_var("SW_TEST_SCOPE_AUTHORITY", "feedback");
        std::env::set_var("SW_TEST_SCOPE_TRUSTED", "0");
    }

    tools::restore_from_snapshot(workdir, baseline_snapshot);
    let baseline_started = std::time::Instant::now();
    let output = run_feedback_scope_validation_with_timeout(
        scope,
        workdir,
        scope_baseline_timeout_seconds(),
    );
    let baseline_elapsed = baseline_started.elapsed();
    let kind = repair_feedback::classify_output(&output);
    let baseline_runnable = matches!(
        kind,
        repair_feedback::RepairSignalKind::Passed
            | repair_feedback::RepairSignalKind::AssertionFailure
            | repair_feedback::RepairSignalKind::UnknownFailure
    );
    if baseline_runnable {
        let qualification = baseline_qualification::qualify_source_mapped_public_scope(kind);
        validation_oracle::record_baseline_scope_outcome_timed(
            files,
            kind,
            &output,
            qualification.relation,
            baseline_elapsed,
        );
        println!(
            "[VALIDATION_ORACLE] baseline_proof=recorded scope={} kind={} relation={} reason={} fingerprint={}",
            scope_desc,
            kind.as_str(),
            qualification.relation.as_str(),
            qualification.reason,
            validation_oracle::failure_fingerprint(&output).replace('\n', " | ")
        );
    } else {
        println!(
            "[VALIDATION_ORACLE] baseline_proof=unavailable scope={} kind={}",
            scope_desc,
            kind.as_str()
        );
    }
    tools::restore_from_snapshot(workdir, &candidate_snapshot);
    restore_env("SW_TEST_CAN_COMPLETE", previous_can_complete);
    restore_env("SW_TEST_SCOPE_AUTHORITY", previous_scope_authority);
    restore_env("SW_TEST_SCOPE_TRUSTED", previous_scope_trusted);
    baseline_runnable
}

fn push_validation_attempt(
    attempts: &mut Vec<(
        serde_json::Value,
        String,
        Option<Vec<String>>,
        Option<String>,
    )>,
    scope: serde_json::Value,
    desc: String,
    candidate_files: Option<Vec<String>>,
    candidate_label: Option<String>,
) {
    if attempts
        .iter()
        .any(|(_, existing_desc, _, _)| existing_desc == &desc)
    {
        return;
    }
    attempts.push((scope, desc, candidate_files, candidate_label));
}

fn test_scope_from_files(files: &[String], label: &str) -> (serde_json::Value, String) {
    if files.is_empty() {
        return (json!({}), format!("{}=<empty>", label));
    }
    let first = files[0].clone();
    let rest = files[1..].to_vec();
    let description = if rest.is_empty() {
        format!("{}={}", label, first)
    } else {
        format!("{}={} (+{} more)", label, first, rest.len())
    };
    if rest.is_empty() {
        (json!({"path": first}), description)
    } else {
        (json!({"path": first, "args": rest}), description)
    }
}

fn test_scope_from_labels(labels: &[String], label: &str) -> (serde_json::Value, String) {
    if labels.is_empty() {
        return (json!({}), format!("{}=<empty>", label));
    }
    let first = labels[0].clone();
    let rest = labels[1..].to_vec();
    let description = if rest.is_empty() {
        format!("{}={}", label, first)
    } else {
        format!("{}={} (+{} more)", label, first, rest.len())
    };
    if rest.is_empty() {
        (json!({"label": first}), description)
    } else {
        (json!({"label": first, "args": rest}), description)
    }
}

fn scoped_test_path_rank(path: &str) -> u8 {
    let normalized = path.replace('\\', "/");
    let basename = std::path::Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let is_python = normalized.ends_with(".py");
    let pytest_named = basename.starts_with("test_")
        || basename == "test.py"
        || basename == "tests.py"
        || basename.ends_with("_test.py")
        || basename.ends_with("_tests.py");
    let support_module = matches!(
        basename,
        "__init__.py"
            | "models.py"
            | "admin.py"
            | "apps.py"
            | "forms.py"
            | "urls.py"
            | "views.py"
            | "conftest.py"
            | "settings.py"
            | "fixtures.py"
            | "factories.py"
    );
    if is_python && pytest_named {
        0
    } else if is_python && normalized.contains("/tests/test") {
        1
    } else if is_python && normalized.starts_with("tests/test") {
        1
    } else if is_python && support_module {
        4
    } else if is_python && (normalized.starts_with("tests/") || normalized.contains("/tests/")) {
        2
    } else if is_python {
        3
    } else if normalized.contains("test") {
        5
    } else {
        6
    }
}

fn looks_like_test_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let basename = std::path::Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if matches!(
        basename,
        "runtests.py" | "run_tests.py" | "conftest.py" | "pytest.ini"
    ) {
        return false;
    }
    basename.starts_with("test_")
        || basename == "test.py"
        || basename == "tests.py"
        || basename.ends_with("_test.py")
        || basename.ends_with("_tests.py")
        || basename.ends_with(".test.js")
        || basename.ends_with(".spec.js")
        || basename.ends_with(".test.ts")
        || basename.ends_with(".spec.ts")
        || ((normalized.starts_with("tests/") || normalized.contains("/tests/"))
            && basename.ends_with(".rs"))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct SourceTestCandidate {
    path: String,
    score: usize,
    reason: String,
    trust_tier: String,
}

fn source_scope_authoritative_min_score() -> usize {
    env_usize("SW_SOURCE_SCOPE_AUTHORITATIVE_MIN_SCORE", 120, 0, 1000)
}

fn source_test_candidate_is_authoritative(candidate: &SourceTestCandidate) -> bool {
    matches!(
        candidate.trust_tier.as_str(),
        "source_exact" | "issue_local"
    ) || candidate.score >= source_scope_authoritative_min_score()
}

fn normalize_repo_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    while let Some(stripped) = normalized.strip_prefix("./") {
        normalized = stripped.to_string();
    }
    normalized
}

fn push_unique_string(values: &mut Vec<String>, value: String) {
    if !value.is_empty() && !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn low_signal_issue_symbol_token(token: &str) -> bool {
    matches!(
        token,
        "description"
            | "solution"
            | "pytest"
            | "sphinx"
            | "license"
            | "copyright"
            | "example"
            | "following"
            | "available"
            | "essentially"
            | "entirely"
            | "possible"
            | "impossible"
            | "combination"
            | "combinations"
            | "contents"
            | "exactly"
            | "however"
            | "correctly"
            | "additional"
            | "already"
            | "warning"
            | "warnings"
            | "behavior"
            | "behaviour"
            | "comment"
            | "comments"
            | "object"
            | "objects"
            | "content"
            | "correct"
            | "current"
            | "database"
            | "attribute"
            | "without"
            | "missing"
            | "backend"
            | "containing"
            | "condition"
            | "context"
            | "doesn"
            | "doesnt"
            | "version"
            | "versions"
    )
}

fn source_locus_test_candidates(
    workdir: &str,
    source_paths: &[String],
    all_files: &[String],
    task: &str,
) -> Vec<SourceTestCandidate> {
    crate::test_map::build(
        workdir,
        source_paths,
        all_files,
        task,
        scope_validation_max_candidates().max(3),
    )
    .candidates
    .into_iter()
    .map(|candidate| SourceTestCandidate {
        path: candidate.path,
        score: candidate.score,
        reason: candidate.reason,
        trust_tier: candidate.trust_tier,
    })
    .collect()
}

fn push_unique_source_test_candidate(
    candidates: &mut Vec<SourceTestCandidate>,
    candidate: SourceTestCandidate,
) {
    if !candidates
        .iter()
        .any(|existing| normalize_repo_path(&existing.path) == normalize_repo_path(&candidate.path))
    {
        candidates.push(candidate);
    }
}

fn feedback_source_locus_test_candidates(
    workdir: &str,
    explicit_source_paths: &[String],
    ranked_files: &[(String, usize)],
    top_file_limit: usize,
    using_generic_fallback_pattern: bool,
    all_files: &[String],
    task: &str,
) -> Vec<SourceTestCandidate> {
    let mut candidates = Vec::new();

    if !explicit_source_paths.is_empty() {
        for candidate in
            source_locus_test_candidates(workdir, explicit_source_paths, all_files, task)
        {
            push_unique_source_test_candidate(&mut candidates, candidate);
        }
    }

    let mut ranked_seed_files = Vec::new();
    if !using_generic_fallback_pattern {
        let seed_limit = source_test_seed_limit(top_file_limit);
        for (path, _score) in ranked_files.iter().take(seed_limit) {
            let normalized = normalize_repo_path(path);
            if explicit_source_paths
                .iter()
                .any(|explicit| normalize_repo_path(explicit) == normalized)
            {
                continue;
            }
            push_unique_string(&mut ranked_seed_files, path.clone());
        }
    }

    if candidates.is_empty() {
        return source_locus_test_candidates(workdir, &ranked_seed_files, all_files, task);
    }

    for candidate in source_locus_test_candidates(workdir, &ranked_seed_files, all_files, task) {
        push_unique_source_test_candidate(&mut candidates, candidate);
    }
    candidates
}

fn source_test_seed_limit(top_file_limit: usize) -> usize {
    let default_limit = top_file_limit.min(2).max(1);
    env_usize("SW_SOURCE_TEST_SEED_LIMIT", default_limit, 1, 20).min(top_file_limit.max(1))
}

fn feedback_test_scope_for_sources(
    workdir: &str,
    source_paths: &[String],
    all_files: &[String],
    task: &str,
    desc_prefix: &str,
) -> Option<(serde_json::Value, String)> {
    if source_paths.is_empty() || all_files.is_empty() {
        return None;
    }
    let mut normalized_sources = Vec::new();
    for path in source_paths {
        let normalized = normalize_repo_path(path);
        if normalized.is_empty() || looks_like_test_path(&normalized) {
            continue;
        }
        if !std::path::Path::new(workdir).join(&normalized).is_file() {
            continue;
        }
        push_unique_string(&mut normalized_sources, normalized);
    }
    if normalized_sources.is_empty() {
        return None;
    }

    let candidates = source_locus_test_candidates(workdir, &normalized_sources, all_files, task);
    if candidates.is_empty() {
        return None;
    }

    let selected: Vec<String> = candidates
        .iter()
        .map(|candidate| candidate.path.clone())
        .collect();
    let first = selected[0].clone();
    let rest = selected[1..].to_vec();
    let desc = if rest.is_empty() {
        format!("{}={}", desc_prefix, first)
    } else {
        format!("{}={} (+{} more)", desc_prefix, first, rest.len())
    };
    if rest.is_empty() {
        Some((json!({"path": first}), desc))
    } else {
        Some((json!({"path": first, "args": rest}), desc))
    }
}

struct PostEditRepairOutcome {
    feedback: String,
    candidate_blocking: bool,
    scope: serde_json::Value,
    scope_desc: String,
    output: String,
    changed_before_test: Vec<(String, usize, usize)>,
}

fn source_scope_ambiguous_candidate_count(candidates: &[repair_feedback::ScopeCandidate]) -> usize {
    let score_window = env_usize("SW_SOURCE_SCOPE_AMBIGUITY_SCORE", 24, 0, 500);
    source_scope_ambiguous_candidate_count_with_window(candidates, score_window)
}

fn source_scope_ambiguous_candidate_count_with_window(
    candidates: &[repair_feedback::ScopeCandidate],
    score_window: usize,
) -> usize {
    let Some(top_score) = candidates.first().map(|candidate| candidate.score) else {
        return 0;
    };
    candidates
        .iter()
        .take_while(|candidate| top_score.saturating_sub(candidate.score) <= score_window)
        .count()
        .max(1)
}

fn post_edit_source_repair_scope(
    workdir: &str,
    source_paths: &[String],
    all_files: &[String],
    task: &str,
    model: &str,
    baseline_snapshot: Option<&tools::Snapshot>,
) -> Option<PostEditRepairOutcome> {
    if !post_edit_repair_scope_enabled() || source_paths.is_empty() || all_files.is_empty() {
        return None;
    }
    let mut normalized_sources = Vec::new();
    for path in source_paths {
        let normalized = normalize_repo_path(path);
        if normalized.is_empty() || looks_like_test_path(&normalized) {
            continue;
        }
        if !std::path::Path::new(workdir).join(&normalized).is_file() {
            continue;
        }
        push_unique_string(&mut normalized_sources, normalized);
    }
    if normalized_sources.is_empty() {
        return None;
    }

    let candidates = source_locus_test_candidates(workdir, &normalized_sources, all_files, task);
    if candidates.is_empty() {
        println!(
            "[POST_EDIT_REPAIR] SKIP kind=no_source_scope source={}",
            normalized_sources.join(", ")
        );
        return None;
    }
    let repair_candidates: Vec<repair_feedback::ScopeCandidate> = candidates
        .into_iter()
        .map(|candidate| {
            let authoritative = source_test_candidate_is_authoritative(&candidate);
            repair_feedback::ScopeCandidate {
                path: candidate.path,
                score: candidate.score,
                reason: candidate.reason,
                authoritative,
            }
        })
        .collect();
    let ambiguous_singletons = source_scope_ambiguous_candidate_count(&repair_candidates);
    let attempts = repair_feedback::scope_attempts_from_candidates(
        &repair_candidates,
        "SOURCE_SCOPE_TEST_FILES",
        scope_validation_max_candidates(),
        scope_validation_groups_last(),
    );
    if attempts.is_empty() {
        return None;
    }

    let previous_can_complete = std::env::var("SW_TEST_CAN_COMPLETE").ok();
    let previous_scope_authority = std::env::var("SW_TEST_SCOPE_AUTHORITY").ok();
    let previous_scope_trusted = std::env::var("SW_TEST_SCOPE_TRUSTED").ok();
    unsafe {
        std::env::set_var("SW_TEST_CAN_COMPLETE", "0");
        std::env::set_var("SW_TEST_SCOPE_AUTHORITY", "feedback");
        std::env::set_var("SW_TEST_SCOPE_TRUSTED", "0");
    }

    let mut passing_outcome = None;
    let mut outcome = None;
    let mut passing_singletons = 0usize;
    let started = std::time::Instant::now();
    let total_budget = scope_validation_total_seconds() as u64;
    for attempt in attempts {
        if started.elapsed().as_secs() >= total_budget {
            println!(
                "[POST_EDIT_REPAIR] SKIP kind=budget_exhausted elapsed_s={}",
                started.elapsed().as_secs()
            );
            break;
        }
        let baseline_runnable = baseline_prove_repair_scope(
            &attempt.scope,
            &attempt.desc,
            &attempt.files,
            workdir,
            baseline_snapshot,
        );
        let baseline_outcome = validation_oracle::baseline_scope_outcome(&attempt.files);
        println!(
            "[POST_EDIT_REPAIR] validating source-derived scope: {} trust={}",
            attempt.desc,
            if baseline_runnable {
                "baseline_runnable"
            } else {
                "unproven"
            }
        );
        let changed_before_test = tools::all_diff_stats(workdir);
        let candidate_timeout = candidate_scope_timeout_seconds(&attempt.files);
        println!(
            "[POST_EDIT_REPAIR] timeout={}s scope={}",
            candidate_timeout, attempt.desc
        );
        let output = run_feedback_scope_validation_with_timeout(
            &attempt.scope,
            workdir,
            candidate_timeout,
        );
        let restored_side_effects =
            restore_tracked_test_side_effects(workdir, &changed_before_test);
        if !restored_side_effects.is_empty() {
            println!(
                "  [TEST-SIDE-EFFECT] restored tracked file(s): {}",
                restored_side_effects.join(", ")
            );
        }

        let kind = repair_feedback::classify_output(&output);
        let decision = if baseline_outcome.is_some() {
            validation_oracle::classify_candidate_scope(
                kind,
                &output,
                &changed_before_test,
                &attempt.files,
            )
        } else {
            validation_oracle::classify_repair_scope(
                kind,
                &output,
                &changed_before_test,
                &attempt.files,
                baseline_runnable,
            )
        };
        match kind {
            repair_feedback::RepairSignalKind::EnvUnavailable
            | repair_feedback::RepairSignalKind::InvalidScope
            | repair_feedback::RepairSignalKind::Timeout => {
                println!(
                    "{} trust={} reason={}",
                    repair_feedback::render_skip_line(kind, &attempt.desc),
                    decision.trust_tier.as_str(),
                    decision.reason
                );
                continue;
            }
            repair_feedback::RepairSignalKind::Passed => {
                if decision.trust_tier == validation_oracle::ValidationTrustTier::TrustedPublicScope
                    && attempt.authoritative
                {
                    let feedback = match baseline_outcome.as_ref() {
                        Some(baseline)
                            if baseline.kind
                                == repair_feedback::RepairSignalKind::Passed.as_str() =>
                        {
                            repair_feedback::render_regression_pass_line(&attempt.desc, &output)
                        }
                        Some(_) => repair_feedback::render_pass_line(&attempt.desc, &output),
                        None => {
                            repair_feedback::render_regression_pass_line(&attempt.desc, &output)
                        }
                    };
                    passing_outcome = Some(PostEditRepairOutcome {
                        feedback,
                        candidate_blocking: false,
                        scope: attempt.scope.clone(),
                        scope_desc: attempt.desc.clone(),
                        output,
                        changed_before_test,
                    });
                    if attempt.files.len() == 1 {
                        passing_singletons = passing_singletons.saturating_add(1);
                    }
                    if passing_singletons >= ambiguous_singletons {
                        break;
                    }
                    continue;
                }
                println!(
                    "{} trust={} reason={} authoritative={} max_score={}",
                    repair_feedback::render_skip_line(kind, &attempt.desc),
                    decision.trust_tier.as_str(),
                    decision.reason,
                    attempt.authoritative,
                    attempt.max_score
                );
                continue;
            }
            repair_feedback::RepairSignalKind::AssertionFailure
            | repair_feedback::RepairSignalKind::SyntaxOrCollection
            | repair_feedback::RepairSignalKind::UnknownFailure => {
                if decision.candidate_blocking {
                    outcome = Some(PostEditRepairOutcome {
                        feedback: repair_feedback::render_repair_card(
                            kind,
                            &attempt.desc,
                            &output,
                            &normalized_sources,
                            model,
                        ),
                        candidate_blocking: true,
                        scope: attempt.scope.clone(),
                        scope_desc: attempt.desc.clone(),
                        output,
                        changed_before_test,
                    });
                    break;
                }
                println!(
                    "{} trust={} reason={}",
                    repair_feedback::render_skip_line(kind, &attempt.desc),
                    decision.trust_tier.as_str(),
                    decision.reason
                );
                continue;
            }
        }
    }

    restore_env("SW_TEST_CAN_COMPLETE", previous_can_complete);
    restore_env("SW_TEST_SCOPE_AUTHORITY", previous_scope_authority);
    restore_env("SW_TEST_SCOPE_TRUSTED", previous_scope_trusted);
    outcome.or(passing_outcome)
}

fn pre_completion_guard_failure(
    workdir: &str,
    all_files: &[String],
    task: &str,
    model: &str,
    baseline_snapshot: Option<&tools::Snapshot>,
) -> Option<String> {
    if let Some(feedback) = pre_completion_python_syntax_guard(workdir) {
        return Some(feedback);
    }

    let changed_source_paths: Vec<String> = git_changed_paths(workdir)
        .into_iter()
        .filter(|path| !looks_like_test_path(path))
        .collect();
    if let Some(repair) = post_edit_source_repair_scope(
        workdir,
        &changed_source_paths,
        all_files,
        task,
        model,
        baseline_snapshot,
    ) {
        if repair.candidate_blocking {
            return Some(format!(
                "[PRE_COMPLETION_GUARD] FAIL kind=source_repair_scope\n{}",
                repair.feedback
            ));
        }
    }
    None
}

fn path_matches_source_candidate(path: &str, candidates: &[SourceTestCandidate]) -> bool {
    let normalized = normalize_repo_path(path);
    candidates
        .iter()
        .any(|candidate| normalize_repo_path(&candidate.path) == normalized)
}

fn feedback_scope_matches_source_candidates(
    workdir: &str,
    candidate_files: Option<&[String]>,
    candidate_label: Option<&str>,
    candidates: &[SourceTestCandidate],
) -> bool {
    if candidates.is_empty() {
        return false;
    }

    if let Some(files) = candidate_files {
        if files
            .iter()
            .any(|path| path_matches_source_candidate(path, candidates))
        {
            return true;
        }
    }

    candidate_label
        .and_then(|label| django_label_test_file(workdir, label))
        .map(|path| path_matches_source_candidate(&path, candidates))
        .unwrap_or(false)
}

fn is_ident_component(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn django_label_test_file(workdir: &str, label: &str) -> Option<String> {
    let label = label.trim();
    if label.len() > 240
        || label.contains('/')
        || label.contains('\\')
        || label.contains(':')
        || label.contains("..")
    {
        return None;
    }
    let parts: Vec<&str> = label.split('.').collect();
    if parts.len() < 2 || parts.iter().any(|part| !is_ident_component(part)) {
        return None;
    }

    for end in (1..=parts.len()).rev() {
        let candidate = format!("tests/{}.py", parts[..end].join("/"));
        let full = std::path::Path::new(workdir).join(&candidate);
        if full.is_file() && looks_like_test_path(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn push_safe_django_label(workdir: &str, raw: &str, found: &mut Vec<String>) {
    let label = raw.trim().trim_matches(|c: char| {
        matches!(
            c,
            '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>'
        )
    });
    if !label.contains('.') {
        return;
    }
    if django_label_test_file(workdir, label).is_some()
        && !found.iter().any(|existing| existing == label)
    {
        found.push(label.to_string());
    }
}

fn extract_safe_test_labels_from_output(workdir: &str, output: &str) -> Vec<String> {
    let mut found = Vec::new();
    for line in output.lines() {
        if line.contains("FAIL:") || line.contains("ERROR:") {
            let mut rest = line;
            while let Some(start) = rest.find('(') {
                let after_start = &rest[start + 1..];
                let Some(end) = after_start.find(')') else {
                    break;
                };
                push_safe_django_label(workdir, &after_start[..end], &mut found);
                rest = &after_start[end + 1..];
            }
        }

        for raw in line.split_whitespace() {
            if let Some((path, suffix)) = raw.split_once("::") {
                let mut path = path.trim_matches(|c: char| {
                    matches!(c, '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '[' | ']')
                });
                while let Some(stripped) = path.strip_prefix("./") {
                    path = stripped;
                }
                if path.starts_with("tests/") && path.ends_with(".py") {
                    let full = std::path::Path::new(workdir).join(path);
                    if full.is_file() {
                        let mut label = path
                            .trim_start_matches("tests/")
                            .trim_end_matches(".py")
                            .replace('/', ".");
                        for part in suffix.split("::") {
                            let part = part.trim_matches(|c: char| {
                                matches!(c, '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '[' | ']')
                            });
                            if is_ident_component(part) {
                                label.push('.');
                                label.push_str(part);
                            }
                        }
                        push_safe_django_label(workdir, &label, &mut found);
                    }
                }
            }
        }
    }
    found.truncate(5);
    found
}

fn extract_safe_test_files_from_output(workdir: &str, output: &str) -> Vec<String> {
    let mut found = Vec::new();
    for raw in output.split_whitespace() {
        let mut token = raw
            .trim_matches(|c: char| {
                matches!(
                    c,
                    '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>'
                )
            })
            .to_string();
        if let Some((path, _)) = token.split_once("::") {
            token = path.to_string();
        }
        if let Some((path, suffix)) = token.rsplit_once(':') {
            if suffix.chars().all(|c| c.is_ascii_digit()) {
                token = path.to_string();
            }
        }
        while let Some(stripped) = token.strip_prefix("./") {
            token = stripped.to_string();
        }
        if token.starts_with('/') || token.contains("..") || !looks_like_test_path(&token) {
            continue;
        }
        let full = std::path::Path::new(workdir).join(&token);
        if full.is_file() && !found.iter().any(|existing| existing == &token) {
            found.push(token);
        }
    }
    for label in extract_safe_test_labels_from_output(workdir, output) {
        if let Some(path) = django_label_test_file(workdir, &label) {
            if !found.iter().any(|existing| existing == &path) {
                found.push(path);
            }
        }
    }
    found.sort_by_key(|path| scoped_test_path_rank(path));
    found.truncate(5);
    found
}

fn high_signal_scope_token(token: &str) -> bool {
    let token = token.trim().to_ascii_lowercase();
    if token.len() < 4 {
        return false;
    }
    !matches!(
        token.as_str(),
        "description"
            | "test"
            | "tests"
            | "testing"
            | "file"
            | "files"
            | "path"
            | "line"
            | "error"
            | "fail"
            | "failed"
            | "failure"
            | "traceback"
            | "model"
            | "models"
            | "field"
            | "fields"
            | "data"
            | "form"
            | "forms"
            | "view"
            | "views"
            | "request"
            | "response"
            | "content"
            | "correct"
            | "current"
            | "database"
            | "attribute"
            | "without"
            | "missing"
            | "backend"
            | "containing"
            | "condition"
            | "context"
            | "class"
            | "function"
            | "method"
            | "should"
            | "would"
            | "could"
            | "return"
            | "returns"
            | "returned"
            | "expected"
            | "actual"
            | "attempt"
            | "attempts"
            | "behavior"
            | "comment"
            | "comments"
            | "contains"
            | "contained"
            | "create"
            | "created"
            | "creating"
            | "valid"
            | "using"
            | "when"
            | "while"
            | "where"
            | "which"
            | "there"
            | "because"
            | "after"
            | "before"
    )
}

fn task_keyword_grep_patterns(task: &str) -> Vec<String> {
    let task = baseline_qualification::task_signal_region(task);
    let mut patterns = Vec::new();
    for raw in task.split_whitespace() {
        let clean = raw
            .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '.' && c != '-');
        let clean: String = clean
            .chars()
            .filter(|ch| !matches!(ch, '\'' | '\u{2018}' | '\u{2019}'))
            .collect();
        if clean.len() < 6 || clean.len() > 80 {
            continue;
        }
        let lower = clean.to_ascii_lowercase();
        let quoted_identifier = raw
            .chars()
            .next()
            .is_some_and(|ch| matches!(ch, '`' | '"' | '\''))
            || raw
                .chars()
                .last()
                .is_some_and(|ch| matches!(ch, '`' | '"' | '\''));
        let structured = clean.contains('_')
            || clean.contains('.')
            || clean.contains('-')
            || clean.chars().any(|ch| ch.is_ascii_digit())
            || quoted_identifier;
        if (structured || clean.len() >= 8)
            && high_signal_scope_token(&lower)
            && !low_signal_issue_symbol_token(&lower)
            && !patterns.iter().any(|existing| existing == &clean)
        {
            patterns.push(clean);
        }
        if patterns.len() >= 12 {
            break;
        }
    }
    patterns
}

fn grep_pattern_file_score(pattern: &str) -> usize {
    let structured = pattern.contains('_')
        || pattern.contains('.')
        || pattern.contains('-')
        || pattern.chars().any(|ch| ch.is_ascii_digit());
    let camel_case = pattern.chars().any(|ch| ch.is_ascii_uppercase())
        && pattern.chars().skip(1).any(|ch| ch.is_ascii_lowercase());
    if structured || camel_case {
        8
    } else if pattern.len() >= 10 {
        4
    } else {
        1
    }
}

fn push_scope_tokens(value: &str, tokens: &mut Vec<String>) {
    let mut current = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            current.push(ch.to_ascii_lowercase());
        } else if !current.is_empty() {
            push_scope_token_parts(&current, tokens);
            current.clear();
        }
    }
    if !current.is_empty() {
        push_scope_token_parts(&current, tokens);
    }
}

fn push_scope_token_parts(token: &str, tokens: &mut Vec<String>) {
    let stripped = token
        .trim_end_matches(".py")
        .trim_start_matches("test_")
        .trim_end_matches("_test")
        .trim_end_matches("_tests");
    for part in stripped.split('_') {
        if high_signal_scope_token(part) && !tokens.iter().any(|existing| existing == part) {
            tokens.push(part.to_string());
        }
    }
    if high_signal_scope_token(stripped) && !tokens.iter().any(|existing| existing == stripped) {
        tokens.push(stripped.to_string());
    }
}

fn explicit_source_paths_from_task(task: &str, source_files: &[&str]) -> Vec<String> {
    let normalized_task = task.replace('\\', "/");
    let mut paths = Vec::new();
    for source_file in source_files {
        let normalized = source_file.trim_start_matches("./");
        if normalized.len() < 12 || !normalized.contains('/') {
            continue;
        }
        if normalized_task.contains(normalized)
            && !paths.iter().any(|existing| existing == normalized)
        {
            paths.push(normalized.to_string());
        }
    }
    paths
}

fn validation_telemetry_line_budget(model: &str) -> usize {
    if let Ok(value) = std::env::var("SW_TEST_TELEMETRY_LINES") {
        if let Ok(parsed) = value.parse::<usize>() {
            return parsed.clamp(8, 200);
        }
    }
    let model_lower = model.to_ascii_lowercase();
    if model_lower.contains("70b") || model_lower.contains("72b") {
        100
    } else if model_lower.contains("30b")
        || model_lower.contains("32b")
        || model_lower.contains("34b")
    {
        70
    } else if model_lower.contains("14b") || model_lower.contains("20b") {
        50
    } else {
        30
    }
}

fn compact_test_telemetry(output: &str, scope: &str, model: &str) -> String {
    let limit = validation_telemetry_line_budget(model);
    let mut lines = Vec::new();
    if let Some(command) = test_command_line(output) {
        lines.push(format!("command: {}", command));
    }
    lines.push(format!("scope: {}", scope));
    lines.push(format!("exit: {:?}", test_exit_code(output)));
    if test_ran_zero_tests(output) {
        lines.push("signal: zero tests ran".to_string());
    }
    if output
        .lines()
        .any(|line| line.trim() == "SW_TEST_TIMED_OUT=1")
    {
        lines.push("signal: timed out".to_string());
    }
    if output
        .lines()
        .any(|line| line.trim() == "SW_TEST_EARLY_STOPPED=1")
    {
        lines.push("signal: early stopped".to_string());
    }
    if let Some(elapsed) = output
        .lines()
        .find_map(|line| line.trim().strip_prefix("SW_TEST_ELAPSED_MS="))
    {
        lines.push(format!("elapsed_ms: {}", elapsed));
    }

    let mut interesting: Vec<String> = output
        .lines()
        .map(|line| line.trim_end())
        .filter(|line| {
            line.contains("FAILED")
                || line.contains("ERROR")
                || line.contains("FAIL:")
                || line.contains("ERROR:")
                || line.contains("Traceback")
                || line.contains("AssertionError")
                || line.contains("ImportError")
                || line.contains("ModuleNotFoundError")
                || line.contains("NameError")
                || line.contains("ValueError")
                || line.contains("TypeError")
                || line.contains("SyntaxError")
                || line.contains("IndentationError")
                || line.contains("no tests")
                || line.contains("0 tests")
                || line.contains("collected 0")
                || line.trim_start().starts_with("E   ")
                || line.contains("assert ")
        })
        .map(|line| line.chars().take(260).collect::<String>())
        .collect();
    if interesting.is_empty() {
        interesting = output
            .lines()
            .rev()
            .filter(|line| !line.trim().is_empty())
            .take(limit.min(12))
            .map(|line| line.chars().take(260).collect::<String>())
            .collect::<Vec<_>>();
        interesting.reverse();
    }
    lines.extend(interesting.into_iter().take(limit));
    lines.join("\n")
}

#[cfg(test)]
mod harness_result_tests;
#[cfg(test)]
mod test_support;

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
                "on": { "APPROVED": "completed", "REJECTED": "implementing", "TESTS_PASS": "implementing", "TESTS_FAIL": "implementing" }
            },
            "completed": { "type": "final" },
            "failed": { "type": "final" }
        },
        "guards": {}
    }))
    .unwrap()
}

fn hardcoded_bug_fix_machine_v2() -> MachineDefinition {
    serde_json::from_value(json!({
        "id": "fix-bug-v2-structured",
        "initial": "localizing",
        "meta": {
            "task_type": "bug_fix",
            "danger_level": "moderate",
            "estimated_steps": 28,
            "statewright_machine_variant": "structured-v2"
        },
        "states": {
            "localizing": {
                "allowed_tools": [],
                "instructions": "PROGRAMMATIC — do not call LLM",
                "on": { "LOCALIZED": "scope_selecting", "FAIL": "failed" }
            },
            "scope_selecting": {
                "allowed_tools": ["read_file", "list_directory", "find_files", "run_test", "grep"],
                "instructions": "Select the smallest credible source and test scope from the localization payload. Treat Advisory Test Mapping as clues, not completion proof. Do not modify files. If the mapped tests look unrelated, inspect source paths and choose a better source locus.",
                "max_iterations": 4,
                "safe_next": "hypothesizing",
                "on": {
                    "SCOPE_READY": "hypothesizing",
                    "DONE": "hypothesizing",
                    "NEED_MORE_CONTEXT": "scope_selecting",
                    "FAIL": "failed"
                }
            },
            "hypothesizing": {
                "allowed_tools": ["read_file", "list_directory", "find_files", "grep", "inspect_class", "run_test", "write_task_reproducer"],
                "instructions": "Form one concrete bug hypothesis tied to source behavior and observed/advisory test telemetry. When the solver-safe runner supports it, write one behavioral scratch reproducer with write_task_reproducer before editing. The reproducer must import every helper it uses and assert desired post-fix behavior, not the presence of the reported bug or exception. The tool validates it on the untouched baseline; do not invent an unconditional failure or edit repository tests. Do not edit production code yet.",
                "max_iterations": 5,
                "safe_next": "patch_planning",
                "on": {
                    "HYPOTHESIS_READY": "patch_planning",
                    "DONE": "patch_planning",
                    "NEED_SCOPE": "scope_selecting",
                    "FAIL": "failed"
                }
            },
            "patch_planning": {
                "allowed_tools": ["read_file", "find_files", "grep", "inspect_class", "diff"],
                "instructions": "Plan exactly one minimal source-only patch attempt. Follow the active Problem Shape / Patch Tournament hypothesis unless fresh source evidence rejects it. Identify the file, target function/line range, and expected behavioral effect before editing. If the locus is uncertain, go back to hypothesizing.",
                "max_iterations": 3,
                "safe_next": "editing",
                "on": {
                    "PATCH_READY": "editing",
                    "DONE": "editing",
                    "NEED_EVIDENCE": "hypothesizing",
                    "FAIL": "failed"
                }
            },
            "editing": {
                "allowed_tools": ["read_file", "list_directory", "find_files", "grep", "run_test", "inspect_class", "edit_line", "edit_block", "patch_file", "apply_patch", "write_file", "insert_between"],
                "instructions": "Apply one minimal source-only patch attempt. Do not edit tests or generated localization files. After one material edit, transition DONE so micro_validation can classify the outcome.",
                "max_iterations": 8,
                "safe_next": "micro_validation",
                "on": {
                    "DONE": "micro_validation",
                    "PATCH_READY": "micro_validation",
                    "NEED_PLAN": "patch_planning",
                    "FAIL": "failed"
                }
            },
            "micro_validation": {
                "allowed_tools": ["read_file", "run_test", "run_task_reproducer"],
                "instructions": "Run run_task_reproducer when one is qualified, then interpret typed results: task-reproducer fixed, regression preserved, advisory pass, test failure, collection error, no tests collected, runner unavailable, or structural patch failure. A task reproducer fixed result is causal internal evidence, not official completion proof.",
                "max_iterations": 2,
                "on": {
                    "TESTS_PASS": "completion_audit",
                    "TRUSTED_PASS": "completion_audit",
                    "TASK_EVIDENCE_NEEDED": "task_evidence_acquisition",
                    "VALIDATION_FEEDBACK_ONLY": "failure_triage",
                    "VALIDATION_UNAVAILABLE": "failure_triage",
                    "TESTS_FAIL": "failure_triage",
                    "FAIL": "failed"
                }
            },
            "task_evidence_acquisition": {
                "allowed_tools": ["read_file", "find_files", "grep", "inspect_class", "diff", "write_task_reproducer", "run_task_reproducer"],
                "instructions": "Preserve the current source patch. Spend at most two turns acquiring issue-specific efficacy evidence: use existing issue/localization context to write one behavioral scratch reproducer, or run it if already qualified. Do not edit production files, repository tests, or the retained patch. The harness validates the scratch test on the untouched baseline and immediately reruns a qualified reproducer against the candidate. If no reproducer qualifies, continue to completion audit with the retained patch rather than guessing or aborting.",
                "max_iterations": 2,
                "safe_next": "completion_audit",
                "on": {
                    "TASK_EVIDENCE_FIXED": "completion_audit",
                    "TASK_EVIDENCE_CHANGED": "completion_audit",
                    "TASK_EVIDENCE_REPAIR": "failure_triage",
                    "TASK_EVIDENCE_UNAVAILABLE": "completion_audit",
                    "DONE": "completion_audit",
                    "FAIL": "completion_audit"
                }
            },
            "failure_triage": {
                "allowed_tools": ["read_file", "list_directory", "find_files", "grep", "inspect_class", "run_test", "diff"],
                "instructions": "Classify the latest validation outcome before any further edit. Same failure requires fresh source evidence. Collection errors require syntax/import repair. No tests collected requires scope repair. Runner unavailable is not a pass. End by choosing a new patch plan or better scope.",
                "max_iterations": 4,
                "safe_next": "patch_planning",
                "on": {
                    "SAME_FAILURE": "patch_planning",
                    "COLLECTION_ERROR": "patch_planning",
                    "NO_TESTS_COLLECTED": "scope_selecting",
                    "RUNNER_UNAVAILABLE": "patch_planning",
                    "OVERSIZED_OR_TEST_EDIT": "patch_planning",
                    "TESTS_FAIL": "patch_planning",
                    "NEED_SCOPE": "scope_selecting",
                    "PATCH_READY": "editing",
                    "DONE": "patch_planning",
                    "FAIL": "failed"
                }
            },
            "completion_audit": {
                "allowed_tools": ["read_file", "diff", "run_test"],
                "instructions": "Audit the final diff against the issue behavior checklist and validation status. Approve only after trusted scoped validation, or after direct source evidence explains an unavailable/feedback-only validation. Reject if the latest validation was invalid scope, broad, test-only, or weakly tied to the issue.",
                "max_iterations": 3,
                "safe_next": "review",
                "on": {
                    "APPROVED": "review",
                    "DONE": "review",
                    "TRUSTED_PASS": "review",
                    "VALIDATION_UNAVAILABLE": "failure_triage",
                    "VALIDATION_FEEDBACK_ONLY": "failure_triage",
                    "REJECTED": "patch_planning",
                    "TESTS_FAIL": "failure_triage",
                    "FAIL": "failed"
                }
            },
            "review": {
                "allowed_tools": ["read_file", "diff"],
                "instructions": "Final minimality review. Call diff. If the patch is source-only, small, and directly addresses the issue, approve. Otherwise reject back to patch planning.",
                "max_iterations": 3,
                "on": {
                    "APPROVED": {
                        "target": "completed",
                        "requires_approval": true,
                        "approval_message": "Structured audit approved. Complete the patch?"
                    },
                    "DONE": "completed",
                    "REJECTED": "patch_planning",
                    "TESTS_PASS": "completion_audit",
                    "TESTS_FAIL": "failure_triage",
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

fn hardcoded_speed_solver_machine() -> MachineDefinition {
    serde_json::from_value(json!({
        "id": "fix-bug-speed-solver",
        "initial": "localizing",
        "meta": {
            "task_type": "bug_fix",
            "danger_level": "moderate",
            "estimated_steps": 16,
            "statewright_machine_variant": "candidate-speed"
        },
        "states": {
            "localizing": {
                "allowed_tools": [],
                "instructions": "PROGRAMMATIC — do not call LLM",
                "on": { "LOCALIZED": "targeting", "FAIL": "failed" }
            },
            "targeting": {
                "allowed_tools": ["read_file", "grep", "inspect_class", "find_files", "run_test"],
                "instructions": "You are a short-leash candidate worker. Use the Candidate Speed Solver Packet, Problem Shape, Patch Tournament hypothesis, issue checklist, and harness-visible test telemetry. Read the forced source path first. Do not explore broadly; either confirm the forced locus or identify one concrete adjacent source locus.",
                "max_iterations": 4,
                "safe_next": "editing",
                "on": {
                    "SCOPE_READY": "editing",
                    "HYPOTHESIS_READY": "editing",
                    "DONE": "editing",
                    "NEED_MORE_CONTEXT": "targeting",
                    "FAIL": "failed"
                }
            },
            "editing": {
                "allowed_tools": ["read_file", "grep", "inspect_class", "diff", "run_test", "edit_line", "edit_block", "patch_file", "apply_patch", "insert_between"],
                "instructions": "Apply one minimal source-only patch for the active hypothesis. Do not edit tests, fixtures, generated localization assets, or benchmark harness files. If the first patch has a syntax/import/collection error, repair that same patch once. Otherwise stop editing and validate.",
                "max_iterations": 7,
                "safe_next": "micro_validation",
                "on": {
                    "DONE": "micro_validation",
                    "PATCH_READY": "micro_validation",
                    "NEED_EVIDENCE": "targeting",
                    "FAIL": "failed"
                }
            },
            "micro_validation": {
                "allowed_tools": ["read_file", "run_test", "diff"],
                "instructions": "PROGRAMMATIC validation runs on entry. Treat scoped/internal tests as candidate telemetry only. If validation is unavailable but the patch is small and source-only, continue to review so the parent can score it. If syntax, import, or collection telemetry points to your patch, repair once.",
                "max_iterations": 2,
                "safe_next": "review",
                "on": {
                    "TESTS_PASS": "review",
                    "TRUSTED_PASS": "review",
                    "VALIDATION_UNAVAILABLE": "review",
                    "VALIDATION_FEEDBACK_ONLY": "review",
                    "COLLECTION_ERROR": "editing",
                    "TESTS_FAIL": "editing",
                    "FAIL": "failed"
                }
            },
            "review": {
                "allowed_tools": ["diff", "read_file"],
                "instructions": "Call diff. Approve only a small source-only patch tied to the issue behavior and active hypothesis. Reject test edits, broad rewrites, generated-file edits, and unrelated churn. Do not keep exploring.",
                "max_iterations": 2,
                "on": {
                    "APPROVED": {
                        "target": "completed",
                        "requires_approval": true,
                        "approval_message": "Speed solver patch is source-only and minimal. Complete the candidate?"
                    },
                    "DONE": "completed",
                    "REJECTED": "editing",
                    "TESTS_FAIL": "editing",
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

    if is_checkpoint && is_implementation_state(current_state) {
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
            "scope_selecting" => "Choose the smallest credible source and test scope from the localization payload. Advisory Test Mapping is useful evidence, not proof. Use read_file, grep, find_files, or run_test only if the scope is unclear, then transition SCOPE_READY.".to_string(),
            "hypothesizing" => "State one concrete source-level hypothesis tied to the issue behavior and test telemetry. Inspect enough code to confirm it. Do not edit yet; transition HYPOTHESIS_READY when ready.".to_string(),
            "patch_planning" => "Plan one minimal source-only patch attempt: target file, target function/range, and expected behavior change. Do not edit in this state. Transition PATCH_READY when the exact edit target is clear.".to_string(),
            "implementing" | "editing" => {
                let mut s = format!(
                    "You MUST edit the code to fix the bug. Call {} now. Do NOT just read files — you already have the information you need. Make one minimal source-only edit, then transition with DONE.",
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
            "testing" | "micro_validation" => "Run the scoped validation. Trusted pass may proceed. Advisory pass, zero tests, collection error, or runner unavailable must not be treated as a solve; route to the appropriate triage/audit transition.".to_string(),
            "task_evidence_acquisition" => "Keep the retained source patch unchanged. Use the existing issue and localization evidence to write one issue-specific behavioral scratch reproducer. The harness will baseline-qualify it and immediately run it against the candidate. You have at most two turns; inability to qualify evidence falls through to patch audit, not failure.".to_string(),
            "failure_triage" => "Classify the latest validation outcome before editing again. Same failure requires fresh source evidence. Collection errors require syntax/import repair. No tests collected requires scope repair. Runner unavailable is not a pass. Transition to PATCH_READY, NEED_SCOPE, or DONE after triage.".to_string(),
            "completion_audit" => "Call diff and audit the final patch against the issue behavior, validation status, and minimality. Approve only if source-only and directly tied to the issue; otherwise reject back to patch planning.".to_string(),
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
    let process_started = std::time::Instant::now();
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
        match load_run_config_from_path(config_path) {
            Ok(config) => config,
            Err(err) => {
                eprintln!("[CONFIG] {}", err);
                return;
            }
        }
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
    tools::set_task_reproducer_issue(&task);
    let max_steps = if run_config.guardrails.max_steps > 0 && args.config.is_some() {
        run_config.guardrails.max_steps
    } else {
        args.max_steps
    };

    let causal_one_pass = std::env::var("SW_REPAIR_CONTROLLER")
        .ok()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("causal_one_pass"));
    if causal_one_pass {
        enforce_causal_serial_env();
        println!(
            "[CAUSAL_REPAIR] serial controller enabled; fanout, candidate bank, and patch tournament disabled"
        );
    }
    let causal_artifact_dir = artifact_dir_from_env();
    let mut causal_repair_controller = causal_one_pass.then(|| {
        causal_repair::CausalRepairController::from_artifact_dir(causal_artifact_dir.as_deref())
    });
    let mut causal_checkpoint_store = causal_one_pass.then(|| {
        causal_checkpoint::CausalCheckpointStore::from_artifact_dir(causal_artifact_dir.as_deref())
    });
    let _validation_sandbox_guard = if causal_one_pass {
        let parent = test_runtime::validation_worktree_parent(
            std::env::var_os("SW_VALIDATION_WORK_ROOT").map(std::path::PathBuf::from),
        );
        match tools::enable_validation_sandbox(&workdir, &parent) {
            Ok(guard) => {
                println!("[VALIDATION_SANDBOX] enabled parent={}", parent.display());
                Some(guard)
            }
            Err(err) => {
                eprintln!("[VALIDATION_SANDBOX] unavailable {err}");
                unsafe {
                    std::env::set_var("SW_TEST_PREFLIGHT_UNAVAILABLE", "1");
                }
                None
            }
        }
    } else {
        None
    };

    // Helper: get OllamaClient for a given state (per-state model routing).
    // thinking_level is not passed here — it requires state_def, which is loaded later.
    // Single-state path rebuilds the client after state_def is available.
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
                thinking_level: None,
            })
        } else {
            OllamaClient::new(OllamaConfig {
                api_url: args.ollama_url.clone(),
                model: args.model.clone(),
                temperature: 0.3,
                max_tokens: 4096,
                thinking_level: None,
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
            thinking_level: None,
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
            thinking_level: None,
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

        // Extract model routing for this state before consuming run_config.workflow.
        let model_config = run_config.model_routing.get(target_state.as_str()).cloned();

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
                let available = definition
                    .states
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ");
                eprintln!(
                    "[CONFIG] state_not_found target={} available_states=[{}]",
                    target_state, available
                );
                return;
            }
        };

        // Build client now that we have state_def — incorporates both model routing and
        // per-state thinking_level. thinking_level is only forwarded to non-Ollama endpoints.
        let client = if let Some(mc) = &model_config {
            OllamaClient::new(OllamaConfig {
                api_url: mc
                    .ollama_url
                    .clone()
                    .unwrap_or_else(|| args.ollama_url.clone()),
                model: mc.model.clone().unwrap_or_else(|| args.model.clone()),
                temperature: mc.temperature,
                max_tokens: mc.num_predict,
                thinking_level: state_def.thinking_level.clone(),
            })
        } else {
            OllamaClient::new(OllamaConfig {
                api_url: args.ollama_url.clone(),
                model: args.model.clone(),
                temperature: 0.3,
                max_tokens: 4096,
                thinking_level: state_def.thinking_level.clone(),
            })
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
            let test_output = execute_tool_quarantining_tests("run_test", &json!({}), &workdir);
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

                    let result = execute_tool_quarantining_tests(&tc.name, &tc.args, &workdir);

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
                        let test_output = execute_tool_quarantining_tests(
                            "run_test",
                            &serde_json::json!({}),
                            &workdir,
                        );
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
            originals: originals.clone(),
        })
    };

    // Phase 1: Get or generate the state machine
    let hardcoded_machine_variant = selected_hardcoded_machine_variant(&args);
    let mut definition = if args.control {
        println!("[Phase 1] CONTROL MODE — flat machine, no guardrails");
        control_flat_machine()
    } else if args.tdd_greenfield {
        println!("[Phase 1] TDD GREENFIELD — understanding→tests→red→implement→green→done");
        tdd_greenfield_machine()
    } else if causal_one_pass {
        println!("[Phase 1] CAUSAL REPAIR — using structured v2 state machine");
        hardcoded_bug_fix_machine_v2()
    } else if args.use_hardcoded_machine {
        println!(
            "[Phase 1] Using hardcoded bug-fix state machine ({})",
            hardcoded_machine_variant
        );
        hardcoded_bug_fix_machine_for_variant(&hardcoded_machine_variant)
    } else {
        println!("[Phase 1] Generating state machine via LLM...");
        let client = OllamaClient::new(OllamaConfig {
            api_url: args.ollama_url.clone(),
            model: args.model.clone(),
            temperature: 0.3,
            max_tokens: 4096,
            thinking_level: None,
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
                eprintln!(
                    "[Phase 1] Falling back to hardcoded machine ({})",
                    hardcoded_machine_variant
                );
                hardcoded_bug_fix_machine_for_variant(&hardcoded_machine_variant)
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
        thinking_level: None,
    });
    let escalation_client = OllamaClient::new(OllamaConfig {
        api_url: escalation_url.clone(),
        model: escalation_model.clone(),
        temperature: 0.3,
        max_tokens: output_tokens,
        thinking_level: None,
    });

    let mut current_state = definition.initial.clone();
    let mut context = definition.context.clone();
    let mut step = 0u32;
    let mut steps_in_current_state = 0u32;

    // Conversation history — the model sees its own previous turns
    let mut conversation = ProtocolConversation::default();
    let mut next_protocol_call_id = 0u64;

    // Escalation ladder: track failed edit attempts in implementing
    // Level 0: fast (no reasoning) → Level 1: reasoning → Level 2: bigger model → Level 3: bigger + reasoning
    let mut edit_fail_count = 0u32;
    let mut gate_fired_this_step = false; // set when GATE blocks an edit, cleared each step
    let mut test_guard_count = 0u32; // consecutive TEST GUARD blocks
    let mut test_guard_fired_this_step = false;
    let mut reasoning_mode = false;
    let mut escalated_model = false;
    let mut persistent_hint: Option<String> = None;

    // Per-file consecutive edit_line failure counter for locus-loop detection.
    // When a file accumulates LOCUS_RESET_THRESHOLD consecutive failures, we inject
    // the full current file content into the tool result to reset the model's stale
    // mental model (it hallucinates anchor text that no longer exists after prior edits).
    let mut consecutive_locus_fails: HashMap<String, u32> = HashMap::new();
    let mut disabled_edit_line_paths: HashSet<String> = HashSet::new();
    const LOCUS_RESET_THRESHOLD: u32 = 3;

    // LOCUS GUARD block counter. After 3 hard blocks, localization is probably wrong.
    // Allow edits through but
    // keep counting misses in telemetry so we can diagnose in postmortem.
    let mut locus_block_count: u32 = 0;

    // Read dedup: track file reads to avoid re-injecting full content
    // Key: (tool_name, canonical_args), Value: (step_number, result)
    let mut read_cache: HashMap<String, (u32, String)> = HashMap::new();
    let mut read_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Track which files have been modified (edits invalidate cache)
    let mut modified_files: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut oversized_restore_counts: HashMap<String, u32> = HashMap::new();
    let mut oversized_recovery_required: HashSet<String> = HashSet::new();
    let mut reanchor_toxic_restore_counts: HashMap<String, u32> = HashMap::new();
    let mut quarantined_reanchor_paths: HashSet<String> = HashSet::new();
    let mut last_auto_test_failure_signature: Option<String> = None;
    let mut same_auto_test_failure_count: u32 = 0;
    let mut same_test_diagnostic_required = false;
    let mut blocked_repeated_edit_fingerprints: HashSet<String> = HashSet::new();
    let mut causal_reproducer_edit_blocks_remaining = if causal_one_pass {
        causal_reproducer_edit_blocks()
    } else {
        0
    };
    let mut causal_serial_policy = causal_one_pass
        .then(|| causal_control::SerialRepairPolicy::new(causal_safety_edit_budget()));
    let mut consecutive_parse_failures: u32 = 0;
    let mut consecutive_llm_transport_failures: u32 = 0;

    // Model profile drives these — no more hardcoded size thresholds
    let history_window = profile.history_window;
    let max_full_read_lines = profile.max_full_read_lines;

    // Localized regions from programmatic recon — used by context cap to suggest ranges
    // Key: filename, Value: vec of (line_num, pattern) from grep hits
    let mut localized_regions: HashMap<String, Vec<(usize, String)>> = HashMap::new();
    // Best localized excerpt per file from the recon pass.
    let mut localized_file_contexts: HashMap<String, String> = HashMap::new();
    let mut sw_test_files = parse_sw_test_files();
    let mut repo_file_index: Vec<String> = Vec::new();
    let observation_filter = observation::ObservationFilter::from_env(&args.model);
    let mut observation_cache: HashMap<String, String> = HashMap::new();

    let enable_clu = clu_enabled();
    let enable_clu_workflow = enable_clu && clu_workflow_enabled();
    let enable_problem_shape = problem_shape_enabled() || enable_clu;
    let enable_problem_shape_machine = problem_shape_machine_enabled();
    let enable_source_locus_intel = source_locus_intel_enabled();
    let mut enable_patch_tournament = patch_tournament_enabled();
    let attempt_packet_reset = attempt_packet_reset_enabled();
    let parse_fail_reset_threshold = attempt_packet_parse_fail_threshold();
    let no_progress_reset_threshold = attempt_packet_no_progress_threshold();
    let mut candidate_bank = candidate_bank::CandidateBank::from_env();
    if candidate_bank.is_enabled() {
        println!("  [CANDIDATE-BANK] enabled");
    }
    if attempt_packet_reset {
        println!(
            "  [ATTEMPT-PACKET] reset enabled parse_fail_threshold={} no_progress_threshold={}",
            parse_fail_reset_threshold, no_progress_reset_threshold
        );
    }
    if enable_source_locus_intel {
        println!("  [SOURCE-LOCUS-INTEL] enabled");
    }
    let mut patch_hypotheses: Vec<PatchHypothesis> = Vec::new();
    let mut active_patch_hypothesis_index: usize = 0;
    let mut observed_patch_hypothesis_index: usize = 0;
    let mut active_patch_hypothesis_steps: u32 = 0;
    let mut patch_hypotheses_exhausted = false;
    let mut active_clu_policy: Option<CluSolverPolicy> = None;
    let mut active_hypothesis_step_budget = hypothesis_step_budget();
    let mut current_problem_shape = ProblemShape::default();
    let mut parse_repair_hypothesis_index: Option<usize> = None;
    let mut source_locus_intel_refresh_count: u32 = 0;
    let mut off_hypothesis_edit_count: u32 = 0;
    let mut edit_path_argument_fail_count: u32 = 0;
    let mut selected_fanout_validation: Option<candidate_validation::ValidationProvenance> = None;
    let mut causal_test_map: Option<crate::test_map::CausalTestMap> = None;

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
        let in_endgame = is_validation_state(&current_state)
            || is_review_like_state(&current_state)
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

        if observed_patch_hypothesis_index != active_patch_hypothesis_index {
            observed_patch_hypothesis_index = active_patch_hypothesis_index;
            active_patch_hypothesis_steps = 0;
        }

        // Check if final state
        if matches!(
            state_def.state_type,
            Some(statewright_engine::StateType::Final)
        ) {
            if current_state == "completed" {
                if let Some(feedback) = pre_completion_guard_failure(
                    &args.workdir,
                    &repo_file_index,
                    &args.task,
                    &args.model,
                    Some(&originals),
                ) {
                    println!("{}", feedback);
                    let feedback_state = failure_triage_state_name(&definition);
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!(
                            "PRE-COMPLETION GUARD BLOCKED COMPLETION.\n\
                             The patch cannot be handed off as complete until this concrete validation failure is fixed:\n\n{}",
                            feedback
                        ),
                    });
                    emit!(
                        TuiEvent::Transition {
                            from: current_state.clone(),
                            to: feedback_state.clone(),
                            trigger: Some("PRE_COMPLETION_GUARD".into()),
                            rationale: None
                        },
                        format!(
                            "  [PRE-COMPLETION GUARD] {} -> {}",
                            current_state, feedback_state
                        )
                    );
                    current_state = feedback_state;
                    steps_in_current_state = 0;
                    continue;
                }
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

        if active_hypothesis_step_budget > 0
            && attempt_packet_reset
            && enable_patch_tournament
            && !patch_hypotheses_exhausted
            && !patch_hypotheses.is_empty()
            && is_implementation_state(&current_state)
            && active_patch_hypothesis_steps >= active_hypothesis_step_budget
        {
            let current_changed = tools::all_diff_stats(&args.workdir);
            if candidate_bank.restore_best_for_stagnation(
                &args.workdir,
                &current_changed,
                "hypothesis_step_budget",
            ) {
                modified_files.clear();
                read_cache.clear();
                read_paths.clear();
                observation_cache.clear();
                println!(
                    "  [ATTEMPT-PACKET] early stop after hypothesis budget; final verification will grade retained candidate"
                );
                break 'agent_loop;
            }

            if let Some(next_prompt) = advance_patch_hypothesis(
                &patch_hypotheses,
                &mut active_patch_hypothesis_index,
                "hypothesis_step_budget",
                &format!(
                    "active_steps={} budget={}",
                    active_patch_hypothesis_steps, active_hypothesis_step_budget
                ),
            ) {
                println!(
                    "  [ATTEMPT-PACKET] action=restore_snapshot reason=hypothesis_step_budget active_steps={} budget={}",
                    active_patch_hypothesis_steps, active_hypothesis_step_budget
                );
                tools::restore_snapshot(&args.workdir);
                modified_files.clear();
                read_cache.clear();
                read_paths.clear();
                observation_cache.clear();
                blocked_repeated_edit_fingerprints.clear();
                same_auto_test_failure_count = 0;
                same_test_diagnostic_required = false;
                edit_fail_count = 0;
                off_hypothesis_edit_count = 0;
                edit_path_argument_fail_count = 0;
                consecutive_parse_failures = 0;
                active_patch_hypothesis_steps = 0;
                observed_patch_hypothesis_index = active_patch_hypothesis_index;
                persistent_hint = None;
                conversation.clear();
                conversation.push(ChatMessage {
                    role: "user".into(),
                    content: format!(
                        "The current patch hypothesis used its bounded evidence packet without producing a decisive candidate. Snapshot restored; use the next problem-shape hypothesis and keep the edit minimal, source-only, and evidence-grounded.\n\n{}\n\nLocalization context:\n{}",
                        next_prompt, localization_summary
                    ),
                });
                let from_state = current_state.clone();
                let next_state = if definition.states.contains_key("patch_planning") {
                    "patch_planning".to_string()
                } else {
                    implementation_state_name(&definition)
                };
                emit!(
                    TuiEvent::Transition {
                        from: from_state.clone(),
                        to: next_state.clone(),
                        trigger: Some("HYPOTHESIS_BUDGET_NEXT".into()),
                        rationale: Some("Bounded CLU hypothesis packet exhausted".into())
                    },
                    format!(
                        "  [TRANSITION] {} -> {} (hypothesis budget next)",
                        from_state, next_state
                    )
                );
                current_state = next_state;
                steps_in_current_state = 0;
                continue 'agent_loop;
            } else {
                patch_hypotheses_exhausted = true;
                active_patch_hypothesis_steps = 0;
                println!(
                    "  [ATTEMPT-PACKET] action=hypotheses_exhausted reason=hypothesis_step_budget"
                );
            }
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
                        .args([
                            "-c",
                            "core.quotePath=false",
                            "ls-files",
                            "--cached",
                            "--others",
                            "--exclude-standard",
                        ])
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
                repo_file_index = all_files.clone();

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
                let explicit_source_paths =
                    explicit_source_paths_from_task(&args.task, &source_files);

                // Step 3: Test telemetry. Explicit scopes are trusted. A bounded
                // unscoped probe is discovery-only; it must not become a validation
                // scope unless it later matches a source-locus-derived candidate.
                let scoped_test_files = std::env::var("SW_TEST_FILES")
                    .ok()
                    .filter(|value| !value.trim().is_empty());
                let scoped_test_label = std::env::var("SW_TEST_LABEL")
                    .ok()
                    .filter(|value| !value.trim().is_empty());
                let has_scoped_test_env =
                    scoped_test_files.is_some() || scoped_test_label.is_some();
                let mut probe_test_labels = Vec::new();
                let mut probe_test_files = Vec::new();
                let mut advisory_source_test_candidate_lines = Vec::new();
                let mut advisory_source_test_candidates = Vec::new();
                let mut promoted_feedback_test_scope = false;

                let (test_output, test_summary) = if has_scoped_test_env {
                    let (scope, scope_desc) = harness_validation_scope_from_env();
                    println!(
                        "  [LOCALIZE] Running harness validation scope: {}",
                        scope_desc
                    );
                    let changed_before_test = tools::all_diff_stats(&args.workdir);
                    let output = tools::execute_tool("run_test", &scope, &args.workdir);
                    let restored_side_effects =
                        restore_tracked_test_side_effects(&args.workdir, &changed_before_test);
                    if !restored_side_effects.is_empty() {
                        println!(
                            "  [TEST-SIDE-EFFECT] restored tracked file(s): {}",
                            restored_side_effects.join(", ")
                        );
                    }
                    let summary = compact_test_telemetry(&output, &scope_desc, &args.model);
                    println!(
                        "  [LOCALIZE] Harness test telemetry:\n{}",
                        summary.lines().take(5).collect::<Vec<_>>().join("\n")
                    );
                    (output, summary)
                } else {
                    println!(
                        "  [LOCALIZE] Running bounded unscoped discovery probe: timeout=300s stop_on_failure=1"
                    );
                    let changed_before_test = tools::all_diff_stats(&args.workdir);
                    let output = run_bounded_unscoped_discovery_probe(&args.workdir);
                    let restored_side_effects =
                        restore_tracked_test_side_effects(&args.workdir, &changed_before_test);
                    if !restored_side_effects.is_empty() {
                        println!(
                            "  [TEST-SIDE-EFFECT] restored tracked file(s): {}",
                            restored_side_effects.join(", ")
                        );
                    }
                    let summary = compact_test_telemetry(
                        &output,
                        "bounded unscoped discovery probe",
                        &args.model,
                    );
                    println!(
                        "  [LOCALIZE] Discovery probe telemetry:\n{}",
                        summary.lines().take(5).collect::<Vec<_>>().join("\n")
                    );
                    probe_test_labels =
                        extract_safe_test_labels_from_output(&args.workdir, &output);
                    probe_test_files = extract_safe_test_files_from_output(&args.workdir, &output);
                    if !probe_test_labels.is_empty() {
                        println!(
                            "  [LOCALIZE] Probe label(s) are advisory until source-locus matched: {}",
                            probe_test_labels.join(", ")
                        );
                    }
                    if !probe_test_files.is_empty() {
                        println!(
                            "  [LOCALIZE] Probe test file(s) are advisory until source-locus matched: {}",
                            probe_test_files.join(":")
                        );
                    }
                    (output, summary)
                };

                let test_scope_correlated =
                    has_scoped_test_env && !test_scope_untrusted(&test_output);
                let test_summary_for_patterns = if test_scope_correlated {
                    test_summary.as_str()
                } else {
                    ""
                };
                let test_output_for_patterns = if test_scope_correlated {
                    test_output.as_str()
                } else {
                    ""
                };
                if !test_scope_correlated {
                    println!(
                        "  [LOCALIZE] No trusted issue-local test scope yet; ignoring probe failures for localization patterns"
                    );
                }

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
                    // Framework primitives commonly occur across a repository and produce ranking noise.
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
                for pattern in task_keyword_grep_patterns(&args.task) {
                    grep_patterns.push(pattern);
                }

                // Test function names
                for line in test_summary_for_patterns.lines() {
                    for word in line.split_whitespace() {
                        let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                        if clean.starts_with("test_") && clean.len() > 8 {
                            grep_patterns.push(clean[5..].to_string());
                        }
                    }
                }

                // Assertion targets from test output
                for line in test_output_for_patterns.lines() {
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
                let mut using_generic_fallback_pattern = false;
                if grep_patterns.is_empty() {
                    if source_files.len() <= 300 || !explicit_source_paths.is_empty() {
                        grep_patterns.push(fallback_pattern.to_string());
                        using_generic_fallback_pattern = true;
                    } else {
                        println!(
                            "  [LOCALIZE] No high-signal grep patterns; skipping generic `{}` sweep on large repo",
                            fallback_pattern.trim()
                        );
                    }
                }
                if !grep_patterns.is_empty() {
                    println!(
                        "  [LOCALIZE] Patterns: {:?}",
                        &grep_patterns[..grep_patterns.len().min(5)]
                    );
                }

                // Step 5: Recursive grep + file ranking by keyword density
                let mut file_scores: HashMap<String, usize> = HashMap::new();
                for path in &explicit_source_paths {
                    *file_scores.entry(path.clone()).or_default() += 100;
                    localized_file_contexts
                        .entry(path.clone())
                        .or_insert_with(|| "[explicit problem-statement path]".to_string());
                }
                if !explicit_source_paths.is_empty() {
                    println!(
                        "  [LOCALIZE] Explicit source paths: {}",
                        explicit_source_paths.join(", ")
                    );
                }
                for pattern in &grep_patterns {
                    let pattern_score = grep_pattern_file_score(pattern);
                    // Recursive grep across entire repo (no file arg = -rn on .)
                    let grep_result =
                        tools::execute_tool("grep", &json!({"pattern": pattern}), &args.workdir);
                    if grep_result != "no matches found" {
                        for line in grep_result.lines().take(50) {
                            if let Some(file_path) = line.split(':').next() {
                                // Only count source files, not tests
                                let fp = file_path.to_string();
                                if source_files.iter().any(|&s| s == fp || fp.ends_with(s)) {
                                    *file_scores.entry(fp).or_default() += pattern_score;
                                }
                            }
                        }
                    }
                }

                // Step 6: Language-specific enrichment
                let mut enrichment_context = String::new();

                // Extract class names from task
                let mut class_names = Vec::new();
                for word in args.task.split_whitespace() {
                    let clean = word.trim_matches(|c: char| !c.is_alphanumeric());
                    if clean.len() > 2
                        && clean.chars().next().map_or(false, |c| c.is_uppercase())
                        && !stopwords.contains(&clean)
                        && !class_names.iter().any(|seen| seen == clean)
                    {
                        class_names.push(clean.to_string());
                    }
                }

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
                                                    .or_default() += 35;
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
                                    *file_scores.entry(file.to_string()).or_default() += 35;
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
                        .filter_map(|p| {
                            if p.as_str() == "__dict__" || p.as_str() == "__slots__" {
                                Some("__slots__")
                            } else {
                                None
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
                            for (idx, location) in inspect_class_locations(&result)
                                .into_iter()
                                .take(8)
                                .enumerate()
                            {
                                let score = if idx == 0 {
                                    80
                                } else if location.missing_attr {
                                    20
                                } else {
                                    8
                                };
                                *file_scores.entry(location.file.clone()).or_default() += score;
                                localized_regions
                                    .entry(location.file.clone())
                                    .or_default()
                                    .push((
                                        location.line,
                                        format!("class introspection: {}", class_name),
                                    ));

                                let existing_context = localized_file_contexts
                                    .get(&location.file)
                                    .map(|context| context.as_str())
                                    .unwrap_or("");
                                let should_replace_context = existing_context.is_empty()
                                    || existing_context.starts_with("[import-trace");
                                if should_replace_context {
                                    if let Some(context) = class_introspection_excerpt(
                                        &args.workdir,
                                        &location.file,
                                        location.line,
                                        class_name,
                                    ) {
                                        localized_file_contexts
                                            .insert(location.file.clone(), context.clone());
                                        enrichment_context.push_str(&format!(
                                            "\nClass introspection excerpt for `{}` at `{}`:{}\n{}\n",
                                            class_name, location.file, location.line, context
                                        ));
                                    }
                                }
                            }
                        }
                    }
                }

                // Import trace: BFS from test files through Python import graph.
                // On large framework repositories the fix file is often
                // transitively imported by the test, not directly grep-matchable.
                // This widens the LOCUS GUARD allowed set without grep noise.
                if dominant_lang == "py" && source_files.len() > 200 {
                    let seed_files: Vec<String> = if let Some(ref tf) = scoped_test_files {
                        tf.split(':')
                            .filter(|f| !f.is_empty())
                            .map(|s| s.to_string())
                            .collect()
                    } else {
                        source_files
                            .iter()
                            .filter(|f| test_indicators.iter().any(|t| f.contains(t)))
                            .take(3)
                            .map(|s| s.to_string())
                            .collect()
                    };

                    let mut trace_visited: std::collections::HashSet<String> =
                        std::collections::HashSet::new();
                    let mut hop_queue: std::collections::VecDeque<(String, usize)> =
                        seed_files.into_iter().map(|f| (f, 0usize)).collect();

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
                                localized_file_contexts
                                    .entry(imp.clone())
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

                // Rank files by score, then let Problem Shape choose the compact edit set.
                let mut ranked_files: Vec<(String, usize)> = file_scores.into_iter().collect();
                ranked_files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
                let top_file_limit = if enable_problem_shape {
                    problem_shape_top_file_limit()
                } else {
                    5
                };
                let top_files: Vec<&str> = ranked_files
                    .iter()
                    .take(top_file_limit)
                    .map(|(f, _)| f.as_str())
                    .collect();

                if !ranked_files.is_empty() {
                    println!("  [LOCALIZE] Top files:");
                    for (f, score) in ranked_files.iter().take(top_file_limit) {
                        println!("    {} (score: {})", f, score);
                    }
                }

                let causal_map_sources: Vec<String> = if explicit_source_paths.is_empty() {
                    ranked_files
                        .iter()
                        .take(top_file_limit)
                        .map(|(path, _)| path.clone())
                        .collect()
                } else {
                    explicit_source_paths.clone()
                };
                if causal_one_pass {
                    let map = crate::test_map::build(
                        &args.workdir,
                        &causal_map_sources,
                        &all_files,
                        &args.task,
                        scope_validation_max_candidates().max(3),
                    );
                    println!(
                        "  [CAUSAL_TEST_MAP] sources={} candidates={}",
                        map.source_paths.len(),
                        map.candidates.len()
                    );
                    record_causal_event(
                        &mut causal_repair_controller,
                        causal_repair::CausalEvent::BaselineMapped {
                            candidate_count: map.candidates.len(),
                        },
                    );
                    causal_test_map = Some(map);
                    let (initial_scope, initial_scope_desc) = if has_scoped_test_env {
                        harness_validation_scope_from_env()
                    } else {
                        (json!({}), "bounded unscoped discovery probe".to_string())
                    };
                    let initial_scope_keys = causal_validation::scope_keys(&initial_scope);
                    let initial_kind = repair_feedback::classify_output(&test_output);
                    let initial_usable = has_scoped_test_env
                        && !test_env_unavailable(&test_output)
                        && !test_scope_untrusted(&test_output)
                        && !test_collection_or_scope_failure(&test_output)
                        && !feedback_scope_validation_timed_out(&test_output);
                    if initial_usable && !initial_scope_keys.is_empty() {
                        validation_oracle::record_baseline_scope_outcome(
                            &initial_scope_keys,
                            initial_kind,
                            &test_output,
                            validation_oracle::BaselineScopeRelation::Unknown,
                        );
                    }
                    if let Some(map) = causal_test_map.as_mut() {
                        map.record_baseline_observation(crate::test_map::BaselineObservation {
                            scope_desc: initial_scope_desc.clone(),
                            scope_keys: initial_scope_keys.clone(),
                            signal: initial_kind.as_str().to_string(),
                            relation: if has_scoped_test_env {
                                "unknown".to_string()
                            } else {
                                "discovery_only".to_string()
                            },
                            fingerprint: validation_oracle::failure_fingerprint(&test_output),
                            usable_for_candidate_comparison: initial_usable,
                        });
                    }
                    record_causal_event(
                        &mut causal_repair_controller,
                        causal_repair::CausalEvent::ValidationObserved {
                            signal: format!("baseline_{}", initial_kind.as_str()),
                            detail: format!(
                                "phase=baseline scope={} keys={} relation={} usable={}",
                                initial_scope_desc,
                                initial_scope_keys.join(","),
                                if has_scoped_test_env {
                                    "unknown"
                                } else {
                                    "discovery_only"
                                },
                                initial_usable
                            ),
                        },
                    );
                }
                if !has_scoped_test_env {
                    let source_test_candidates = feedback_source_locus_test_candidates(
                        &args.workdir,
                        &explicit_source_paths,
                        &ranked_files,
                        top_file_limit,
                        using_generic_fallback_pattern,
                        &all_files,
                        &args.task,
                    );
                    advisory_source_test_candidates = source_test_candidates.clone();
                    let mut selected_files = Vec::new();
                    let mut selected_labels = Vec::new();
                    if !probe_test_files.is_empty() {
                        for path in &probe_test_files {
                            push_unique_string(&mut selected_files, normalize_repo_path(path));
                        }
                        println!(
                            "  [LOCALIZE] Probe-derived test scope candidate(s): {}",
                            selected_files.join(":")
                        );
                    }
                    if !probe_test_labels.is_empty() {
                        for label in &probe_test_labels {
                            push_unique_string(&mut selected_labels, label.trim().to_string());
                        }
                        println!(
                            "  [LOCALIZE] Probe-derived test label candidate(s): {}",
                            selected_labels.join(":")
                        );
                    }
                    if strict_feedback_scope_promotion() && !source_test_candidates.is_empty() {
                        let probe_selected_files = selected_files.clone();
                        selected_files.clear();
                        for candidate in &source_test_candidates {
                            push_unique_string(&mut selected_files, candidate.path.clone());
                        }
                        for path in probe_selected_files {
                            push_unique_string(&mut selected_files, path);
                        }
                        println!(
                            "  [LOCALIZE] Source-locus feedback scope candidate(s): {}",
                            source_test_candidates
                                .iter()
                                .map(|candidate| candidate.path.as_str())
                                .collect::<Vec<_>>()
                                .join(":")
                        );
                    } else if selected_files.is_empty()
                        && selected_labels.is_empty()
                        && !source_test_candidates.is_empty()
                    {
                        selected_files = source_test_candidates
                            .iter()
                            .map(|candidate| candidate.path.clone())
                            .collect();
                    }
                    if selected_files.is_empty() && selected_labels.is_empty() {
                        println!("  [LOCALIZE] No test scope candidate survived extraction");
                    }
                    for candidate in &source_test_candidates {
                        advisory_source_test_candidate_lines.push(format!(
                            "- `{}` (score: {}, trust: {}, {})",
                            candidate.path, candidate.score, candidate.trust_tier, candidate.reason
                        ));
                        println!(
                            "    {} (score: {}, {})",
                            candidate.path, candidate.score, candidate.reason
                        );
                    }
                    if !selected_files.is_empty() || !selected_labels.is_empty() {
                        let mut file_validation_attempts = Vec::new();
                        if !selected_files.is_empty() {
                            let singleton_attempts: Vec<Vec<String>> = selected_files
                                .iter()
                                .take(5)
                                .map(|path| vec![path.clone()])
                                .collect();
                            if selected_files.len() > 1 && !scope_validation_groups_last() {
                                file_validation_attempts.push(selected_files.clone());
                            }
                            file_validation_attempts.extend(singleton_attempts);
                            if selected_files.len() > 1 && scope_validation_groups_last() {
                                file_validation_attempts.push(selected_files.clone());
                            }
                        }
                        let mut label_validation_attempts = Vec::new();
                        if !selected_labels.is_empty() {
                            let singleton_attempts: Vec<Vec<String>> = selected_labels
                                .iter()
                                .take(5)
                                .map(|label| vec![label.clone()])
                                .collect();
                            if selected_labels.len() > 1 && !scope_validation_groups_last() {
                                label_validation_attempts.push(selected_labels.clone());
                            }
                            label_validation_attempts.extend(singleton_attempts);
                            if selected_labels.len() > 1 && scope_validation_groups_last() {
                                label_validation_attempts.push(selected_labels.clone());
                            }
                        }
                        let prefer_label_scopes = std::env::var("SW_TEST_CMD")
                            .map(|cmd| cmd.contains("tests/runtests.py"))
                            .unwrap_or(false);

                        let mut validation_attempts: Vec<(
                            serde_json::Value,
                            String,
                            Option<Vec<String>>,
                            Option<String>,
                        )> = Vec::new();
                        if prefer_label_scopes {
                            for candidate_labels in &label_validation_attempts {
                                let (scope, desc) = test_scope_from_labels(
                                    candidate_labels,
                                    "DISCOVERY_TEST_LABELS",
                                );
                                push_validation_attempt(
                                    &mut validation_attempts,
                                    scope,
                                    desc,
                                    None,
                                    candidate_labels.first().cloned(),
                                );
                            }
                            for candidate_files in &file_validation_attempts {
                                let (scope, desc) =
                                    test_scope_from_files(candidate_files, "DISCOVERY_TEST_FILES");
                                push_validation_attempt(
                                    &mut validation_attempts,
                                    scope,
                                    desc,
                                    Some(candidate_files.clone()),
                                    None,
                                );
                            }
                        } else {
                            for candidate_files in &file_validation_attempts {
                                let (scope, desc) =
                                    test_scope_from_files(candidate_files, "DISCOVERY_TEST_FILES");
                                push_validation_attempt(
                                    &mut validation_attempts,
                                    scope,
                                    desc,
                                    Some(candidate_files.clone()),
                                    None,
                                );
                            }
                            for candidate_labels in &label_validation_attempts {
                                let (scope, desc) = test_scope_from_labels(
                                    candidate_labels,
                                    "DISCOVERY_TEST_LABELS",
                                );
                                push_validation_attempt(
                                    &mut validation_attempts,
                                    scope,
                                    desc,
                                    None,
                                    candidate_labels.first().cloned(),
                                );
                            }
                        }
                        validation_attempts.truncate(scope_validation_max_candidates());

                        let previous_can_complete = std::env::var("SW_TEST_CAN_COMPLETE").ok();
                        let previous_scope_authority =
                            std::env::var("SW_TEST_SCOPE_AUTHORITY").ok();
                        let previous_scope_trusted = std::env::var("SW_TEST_SCOPE_TRUSTED").ok();
                        unsafe {
                            std::env::set_var("SW_TEST_CAN_COMPLETE", "0");
                            std::env::set_var("SW_TEST_SCOPE_AUTHORITY", "feedback");
                            std::env::set_var("SW_TEST_SCOPE_TRUSTED", "0");
                        }

                        let mut validated_files: Option<Vec<String>> = None;
                        let mut validated_label: Option<String> = None;
                        let mut runnable_fallback_files: Option<Vec<String>> = None;
                        let mut runnable_fallback_label: Option<String> = None;
                        let validation_started = std::time::Instant::now();
                        let validation_total_budget = scope_validation_total_seconds() as u64;
                        for (scope, desc, candidate_files, candidate_label) in validation_attempts {
                            if strict_feedback_scope_promotion()
                                && !feedback_scope_matches_source_candidates(
                                    &args.workdir,
                                    candidate_files.as_deref(),
                                    candidate_label.as_deref(),
                                    &source_test_candidates,
                                )
                            {
                                println!(
                                    "  [LOCALIZE] Feedback scope rejected: not source-locus matched ({})",
                                    desc
                                );
                                continue;
                            }
                            if validation_started.elapsed().as_secs() >= validation_total_budget {
                                println!(
                                    "  [LOCALIZE] Feedback scope validation budget exhausted after {}s",
                                    validation_started.elapsed().as_secs()
                                );
                                break;
                            }
                            println!("  [LOCALIZE] Validating feedback test scope: {}", desc);
                            let changed_before_test = tools::all_diff_stats(&args.workdir);
                            let baseline_started = std::time::Instant::now();
                            let validation_output = run_feedback_scope_validation_with_timeout(
                                &scope,
                                &args.workdir,
                                scope_baseline_timeout_seconds(),
                            );
                            let baseline_elapsed = baseline_started.elapsed();
                            let restored_side_effects = restore_tracked_test_side_effects(
                                &args.workdir,
                                &changed_before_test,
                            );
                            if !restored_side_effects.is_empty() {
                                println!(
                                    "  [TEST-SIDE-EFFECT] restored tracked file(s): {}",
                                    restored_side_effects.join(", ")
                                );
                            }
                            let baseline_kind =
                                repair_feedback::classify_output(&validation_output);
                            let baseline_keys = candidate_files.clone().unwrap_or_else(|| {
                                candidate_label
                                    .as_deref()
                                    .map(candidate_validation::label_scope_key)
                                    .into_iter()
                                    .collect()
                            });
                            let qualification =
                                baseline_qualification::qualify_source_mapped_public_scope(
                                    baseline_kind,
                                );
                            let baseline_usable =
                                !feedback_scope_validation_timed_out(&validation_output)
                                    && !test_env_unavailable(&validation_output)
                                    && !test_scope_untrusted(&validation_output)
                                    && !test_collection_or_scope_failure(&validation_output);
                            if causal_one_pass {
                                if let Some(map) = causal_test_map.as_mut() {
                                    map.record_baseline_observation(
                                        crate::test_map::BaselineObservation {
                                            scope_desc: desc.clone(),
                                            scope_keys: baseline_keys.clone(),
                                            signal: baseline_kind.as_str().to_string(),
                                            relation: qualification.relation.as_str().to_string(),
                                            fingerprint: validation_oracle::failure_fingerprint(
                                                &validation_output,
                                            ),
                                            usable_for_candidate_comparison: baseline_usable,
                                        },
                                    );
                                }
                                record_causal_event(
                                    &mut causal_repair_controller,
                                    causal_repair::CausalEvent::ValidationObserved {
                                        signal: format!("baseline_{}", baseline_kind.as_str()),
                                        detail: format!(
                                            "phase=baseline scope={} keys={} relation={} usable={}",
                                            desc,
                                            baseline_keys.join(","),
                                            qualification.relation.as_str(),
                                            baseline_usable
                                        ),
                                    },
                                );
                            }
                            let summary =
                                compact_test_telemetry(&validation_output, &desc, &args.model);
                            println!(
                                "  [LOCALIZE] Feedback scope validation telemetry:\n{}",
                                summary.lines().take(6).collect::<Vec<_>>().join("\n")
                            );
                            if feedback_scope_validation_timed_out(&validation_output) {
                                println!(
                                    "  [LOCALIZE] Feedback scope rejected: validation timeout"
                                );
                                println!(
                                    "  [LOCALIZE] feedback_scope_validation_timeout scope={}",
                                    desc
                                );
                                continue;
                            }
                            if test_env_unavailable(&validation_output) {
                                println!(
                                    "  [LOCALIZE] Feedback scope rejected: test environment unavailable"
                                );
                                continue;
                            }
                            if test_scope_untrusted(&validation_output)
                                || test_collection_or_scope_failure(&validation_output)
                            {
                                println!(
                                    "  [LOCALIZE] Feedback scope rejected: invalid collection/scope"
                                );
                                continue;
                            }
                            if !baseline_keys.is_empty() {
                                validation_oracle::record_baseline_scope_outcome_timed(
                                    &baseline_keys,
                                    baseline_kind,
                                    &validation_output,
                                    qualification.relation,
                                    baseline_elapsed,
                                );
                            }
                            println!(
                                "  [BASELINE-QUALIFICATION] scope={} kind={} relation={} reason={}",
                                desc,
                                baseline_kind.as_str(),
                                qualification.relation.as_str(),
                                qualification.reason
                            );
                            if matches!(
                                baseline_kind,
                                repair_feedback::RepairSignalKind::AssertionFailure
                                    | repair_feedback::RepairSignalKind::UnknownFailure
                            ) {
                                println!(
                                    "  [LOCALIZE] Baseline failure rejected as issue evidence: {} relation={} reason={}",
                                    desc,
                                    qualification.relation.as_str(),
                                    qualification.reason
                                );
                            }
                            if baseline_kind == repair_feedback::RepairSignalKind::Passed
                                && runnable_fallback_files.is_none()
                                && runnable_fallback_label.is_none()
                            {
                                println!(
                                    "  [LOCALIZE] Runnable passing scope retained as fallback while searching for a discriminating failure: {}",
                                    desc
                                );
                                runnable_fallback_files = candidate_files;
                                runnable_fallback_label = candidate_label;
                            }
                        }

                        if validated_files.is_none() && validated_label.is_none() {
                            validated_files = runnable_fallback_files;
                            validated_label = runnable_fallback_label;
                        }

                        restore_env("SW_TEST_CAN_COMPLETE", previous_can_complete);
                        restore_env("SW_TEST_SCOPE_AUTHORITY", previous_scope_authority);
                        restore_env("SW_TEST_SCOPE_TRUSTED", previous_scope_trusted);

                        if validated_files.is_none() && validated_label.is_none() {
                            println!("  [LOCALIZE] No runnable feedback test scope validated");
                        } else if let Some(validated_files) = validated_files {
                            let joined = validated_files.join(":");
                            println!("  [LOCALIZE] Validated feedback test scope: {}", joined);
                            unsafe {
                                std::env::set_var("SW_TEST_FILES", &joined);
                                std::env::remove_var("SW_TEST_LABEL");
                                std::env::set_var("SW_TEST_CAN_COMPLETE", "0");
                                std::env::set_var("SW_TEST_SCOPE_AUTHORITY", "feedback");
                                std::env::set_var("SW_TEST_SCOPE_TRUSTED", "0");
                            }
                            promoted_feedback_test_scope = true;
                            sw_test_files = parse_sw_test_files();
                        } else if let Some(label) = validated_label {
                            println!("  [LOCALIZE] Validated feedback test label: {}", label);
                            unsafe {
                                std::env::set_var("SW_TEST_LABEL", &label);
                                std::env::remove_var("SW_TEST_FILES");
                                std::env::set_var("SW_TEST_CAN_COMPLETE", "0");
                                std::env::set_var("SW_TEST_SCOPE_AUTHORITY", "feedback");
                                std::env::set_var("SW_TEST_SCOPE_TRUSTED", "0");
                            }
                            promoted_feedback_test_scope = true;
                            sw_test_files = parse_sw_test_files();
                        }
                    }
                }
                if causal_one_pass {
                    if let Some(map) = causal_test_map.as_ref() {
                        write_json_artifact("causal-test-map.json", map);
                    }
                }

                let problem_shape = if enable_problem_shape {
                    ProblemShape::from_ranked_files(
                        &ranked_files,
                        &explicit_source_paths,
                        &localized_regions,
                        &localized_file_contexts,
                        test_scope_correlated,
                        &probe_test_files,
                        &probe_test_labels,
                        &advisory_source_test_candidates,
                        promoted_feedback_test_scope,
                        top_file_limit,
                    )
                } else {
                    ProblemShape::default()
                };
                current_problem_shape = problem_shape.clone();
                if enable_problem_shape {
                    write_problem_shape_artifact(&problem_shape);
                    println!(
                        "  [PROBLEM-SHAPE] top_files={} trusted_scope={} feedback_scope_promoted={}",
                        problem_shape.top_files.len(),
                        problem_shape.trusted_test_scope,
                        problem_shape.feedback_scope_promoted
                    );
                }
                let clu_policy = if enable_clu {
                    let policy = CluSolverPolicy::from_problem_shape_with_workflow(
                        &problem_shape,
                        source_files.len(),
                        ranked_files.len(),
                        enable_clu_workflow,
                    );
                    policy.apply_to_env();
                    write_clu_policy_artifact(&policy);
                    enable_patch_tournament = policy.patch_tournament_enabled;
                    active_hypothesis_step_budget = hypothesis_step_budget();
                    candidate_bank = candidate_bank::CandidateBank::from_env();
                    if causal_one_pass {
                        enforce_causal_serial_env();
                        enable_patch_tournament = false;
                        candidate_bank = candidate_bank::CandidateBank::from_env();
                        println!(
                            "  [CAUSAL_REPAIR] preserved CLU localization policy but rejected CLU exploration expansion"
                        );
                    }
                    println!(
                        "  [CLU] profile={} workflow_lane={} workflow_enabled={} candidate_bank={} max={} reanchor={} early_stop={} hypothesis_budget={} scope_candidates={} scope_total={}s",
                        policy.profile,
                        policy.workflow_lane.as_str(),
                        enable_clu_workflow,
                        policy.candidate_bank_enabled,
                        policy.candidate_bank_max,
                        policy.candidate_bank_reanchor,
                        policy.candidate_bank_early_stop,
                        active_hypothesis_step_budget,
                        policy.scope_validation_max_candidates,
                        policy.scope_validation_total_seconds
                    );
                    for reason in &policy.reasons {
                        println!("  [CLU] reason={}", reason);
                    }
                    Some(policy)
                } else {
                    None
                };
                active_clu_policy = clu_policy.clone();
                if enable_problem_shape_machine {
                    if let Some(policy) = &clu_policy {
                        let changes = apply_problem_shape_machine_policy(&mut definition, policy);
                        for change in &changes {
                            println!("  [PROBLEM-SHAPE-MACHINE] {}", change);
                        }
                        if let Err(report) = validate_agent_machine(&definition) {
                            eprintln!(
                                "  [PROBLEM-SHAPE-MACHINE] validation warnings: {:?}",
                                report.errors
                            );
                        }
                    } else {
                        println!("  [PROBLEM-SHAPE-MACHINE] skipped; SW_CLU disabled");
                    }
                }
                patch_hypotheses = if enable_patch_tournament {
                    let mut hypotheses = problem_shape.hypotheses();
                    if let Ok(forced_path) = std::env::var("SW_CANDIDATE_FANOUT_HYPOTHESIS_PATH") {
                        let forced_id = std::env::var("SW_CANDIDATE_FANOUT_HYPOTHESIS_ID")
                            .ok()
                            .and_then(|value| value.parse::<usize>().ok())
                            .unwrap_or(1);
                        let forced_score = std::env::var("SW_CANDIDATE_FANOUT_HYPOTHESIS_SCORE")
                            .ok()
                            .and_then(|value| value.parse::<usize>().ok())
                            .unwrap_or(1);
                        let forced_reason = std::env::var("SW_CANDIDATE_FANOUT_HYPOTHESIS_REASON")
                            .unwrap_or_else(|_| "candidate fanout forced hypothesis".into());
                        hypotheses = hypotheses
                            .into_iter()
                            .filter(|hypothesis| hypothesis.path == forced_path)
                            .collect();
                        if hypotheses.is_empty() {
                            hypotheses.push(PatchHypothesis {
                                id: forced_id,
                                path: forced_path,
                                score: forced_score,
                                reason: forced_reason,
                            });
                        }
                        println!(
                            "  [CANDIDATE-FANOUT] child forced hypothesis {}",
                            hypotheses[0].path
                        );
                    } else if let Some(policy) = &clu_policy {
                        hypotheses.truncate(policy.candidate_bank_max.max(1));
                    }
                    hypotheses
                } else {
                    Vec::new()
                };
                let all_patch_hypotheses = patch_hypotheses.clone();
                let mut scout_route =
                    ScoutRouteDecision::from_env(clu_policy.as_ref(), patch_hypotheses.len());
                if scout_route.enabled {
                    if patch_hypotheses.len() > scout_route.retained_hypothesis_count {
                        patch_hypotheses.truncate(scout_route.retained_hypothesis_count);
                    }
                    scout_route.retained_hypothesis_count = patch_hypotheses.len();
                    scout_route.apply_runtime_env();
                    println!(
                        "  [SCOUT-ROUTER] route={} fanout={} lane_escalation={} retained_hypotheses={}/{} thresholds=cheap_top_files<={} cheap_ratio>={}% cheap_hypotheses<={} promoted_ratio>={}% promoted_top_score>={} progressive_fanout_max={} progressive_concurrency={} progressive_child_steps={} full_fanout_max={} full_concurrency={} full_child_steps={}",
                        scout_route.route,
                        scout_route.fanout_enabled,
                        scout_route.lane_escalation_enabled,
                        scout_route.retained_hypothesis_count,
                        scout_route.original_hypothesis_count,
                        scout_route.max_top_files,
                        scout_route.min_ratio_percent,
                        scout_route.max_hypotheses,
                        scout_route.promoted_min_ratio_percent,
                        scout_route.promoted_min_top_score,
                        scout_route.progressive_fanout_max_candidates,
                        scout_route.progressive_fanout_concurrency,
                        scout_route.progressive_child_max_steps,
                        scout_route.full_fanout_max_candidates,
                        scout_route.full_fanout_concurrency,
                        scout_route.full_child_max_steps
                    );
                    for reason in &scout_route.reasons {
                        println!("  [SCOUT-ROUTER] reason={}", reason);
                    }
                    write_scout_route_artifact(&scout_route);
                }
                active_patch_hypothesis_index = 0;
                parse_repair_hypothesis_index = None;
                patch_hypotheses_exhausted = patch_hypotheses.is_empty();
                off_hypothesis_edit_count = 0;
                if enable_problem_shape {
                    write_repair_evidence_graph_artifact(
                        &problem_shape,
                        clu_policy.as_ref(),
                        &patch_hypotheses,
                    );
                }
                if let Some(policy) = &clu_policy {
                    write_clu_plan_artifact(policy, &patch_hypotheses);
                }
                write_candidate_state_artifacts(
                    &patch_hypotheses,
                    active_patch_hypothesis_index,
                    patch_hypotheses_exhausted,
                    "initial problem-shape hypotheses",
                );
                if let Some(active) = patch_hypotheses.get(active_patch_hypothesis_index) {
                    log_patch_attempt(active, "selected", "initial problem shape hypothesis");
                }

                let fanout_config = candidate_fanout::Config::from_env();
                if fanout_config.enabled || fanout_config.child_depth > 0 {
                    println!(
                        "  [CANDIDATE-FANOUT] process_depth={} max_depth={} child={} parent_pid={}",
                        fanout_config.child_depth,
                        fanout_config.max_depth,
                        fanout_config.child,
                        fanout_config.parent_pid.as_deref().unwrap_or("none")
                    );
                }
                let mut scout_lane_escalation_ran = false;
                if scout_route.escalation_enabled()
                    && fanout_config.parent_enabled()
                    && enable_patch_tournament
                    && !all_patch_hypotheses.is_empty()
                {
                    scout_lane_escalation_ran = true;
                    let route_started = std::time::Instant::now();
                    let mut route_timeout_count = 0usize;
                    let configured_route_deadline = (scout_route.route_fanout_wall_seconds > 0)
                        .then(|| {
                            route_started
                                + std::time::Duration::from_secs(
                                    scout_route.route_fanout_wall_seconds,
                                )
                        });
                    // Managed runs use the pod-derived budget so every stage can contribute.
                    // The legacy route wall remains the fallback for standalone invocations.
                    let route_deadline =
                        pod_fanout_deadline(process_started).or(configured_route_deadline);
                    let executable = std::env::current_exe().unwrap_or_else(|_| {
                        std::path::PathBuf::from(
                            std::env::args()
                                .next()
                                .unwrap_or_else(|| "sw-agent".to_string()),
                        )
                    });
                    let invocation = candidate_fanout::AgentInvocation {
                        executable,
                        task: task.clone(),
                        ollama_url: args.ollama_url.clone(),
                        model: args.model.clone(),
                        max_retries: args.max_retries,
                        hardcoded_machine: args.hardcoded_machine.clone(),
                        use_hardcoded_machine: args.use_hardcoded_machine,
                        tool_mode: args.tool_mode.clone(),
                        model_size: args.model_size,
                        config_path: args.config.clone(),
                    };
                    let mut lane_batches = Vec::new();
                    let mut launched_hypothesis_ids = HashSet::new();
                    for lane in &scout_route.escalation_lanes {
                        let remaining = route_deadline.map(|deadline| {
                            deadline
                                .checked_duration_since(std::time::Instant::now())
                                .unwrap_or(std::time::Duration::ZERO)
                        });
                        if remaining.is_some_and(|remaining| remaining.as_secs() < 60) {
                            println!(
                                "  [SCOUT-LADDER] route_budget_stop reason=shared_deadline remaining_s={} completed_timeouts={}",
                                remaining.map(|value| value.as_secs()).unwrap_or(0),
                                route_timeout_count
                            );
                            break;
                        }
                        let lane_hypotheses: Vec<_> = all_patch_hypotheses
                            .iter()
                            .filter(|hypothesis| !launched_hypothesis_ids.contains(&hypothesis.id))
                            .take(lane.hypothesis_limit.max(1))
                            .map(|hypothesis| candidate_fanout::CandidateHypothesis {
                                id: hypothesis.id,
                                path: hypothesis.path.clone(),
                                score: hypothesis.score,
                                reason: hypothesis.reason.clone(),
                            })
                            .collect();
                        if lane_hypotheses.is_empty() {
                            continue;
                        }
                        launched_hypothesis_ids
                            .extend(lane_hypotheses.iter().map(|hypothesis| hypothesis.id));
                        let mut lane_config = fanout_config.clone();
                        lane_config.enabled = true;
                        lane_config.child = false;
                        lane_config.max_candidates = lane.max_candidates.max(1);
                        lane_config.concurrency = lane.concurrency.max(1);
                        lane_config.child_max_steps = lane.child_max_steps.max(1) as u32;
                        lane_config.child_timeout_seconds = lane.child_timeout_seconds.max(60);
                        if let Some(remaining) = remaining {
                            let remaining = remaining.as_secs();
                            lane_config.fanout_wall_seconds =
                                lane_config.fanout_wall_seconds.min(remaining);
                            lane_config.child_timeout_seconds =
                                lane_config.child_timeout_seconds.min(remaining).max(60);
                        }
                        // Timed-out children retain their patches in the tournament. The stop count
                        // only prevents launching more hypotheses after repeated budget exhaustion.
                        lane_config.timeout_stop_count =
                            scout_route.route_fanout_timeout_stop_count;
                        lane_config.fallback_to_sequential = false;
                        lane_config.require_strong_selection = false;
                        let lane_artifact_dir = artifact_dir_from_env()
                            .map(|dir| dir.join("scout-lanes").join(&lane.name));
                        println!(
                            "  [SCOUT-LADDER] lane={} hypotheses={} max_candidates={} concurrency={} child_steps={} child_timeout_s={} strong_selection={} reason={}",
                            lane.name,
                            lane_hypotheses.len().min(lane_config.max_candidates),
                            lane_config.max_candidates,
                            lane_config.concurrency,
                            lane_config.child_max_steps,
                            lane_config.child_timeout_seconds,
                            lane_config.require_strong_selection,
                            lane.reason
                        );
                        match candidate_fanout::collect(
                            &lane_config,
                            &invocation,
                            &workdir,
                            lane_artifact_dir,
                            &lane.name,
                            route_deadline,
                            lane_hypotheses,
                        ) {
                            Ok(batch) => {
                                let has_discriminating_candidate =
                                    batch.has_discriminating_candidate();
                                route_timeout_count = route_timeout_count
                                    .saturating_add(batch.timed_out_with_patch_count());
                                println!(
                                    "  [SCOUT-LADDER] retained lane={} candidates={} elapsed_ms={} timeouts={} patch_timeouts={} route_timeouts={} stop_reason={:?}",
                                    lane.name,
                                    batch.candidate_count(),
                                    batch.elapsed_ms(),
                                    batch.timed_out_count(),
                                    batch.timed_out_with_patch_count(),
                                    route_timeout_count,
                                    batch.fanout_stop_reason(),
                                );
                                lane_batches.push(batch);
                                if has_discriminating_candidate {
                                    println!(
                                        "  [SCOUT-LADDER] route_stop reason=discriminating_candidate lane={}",
                                        lane.name
                                    );
                                    break;
                                }
                                if scout_route.route_fanout_timeout_stop_count > 0
                                    && route_timeout_count
                                        >= scout_route.route_fanout_timeout_stop_count
                                {
                                    println!(
                                        "  [SCOUT-LADDER] route_stop reason=timeout_saturation patch_timeouts={} limit={}",
                                        route_timeout_count,
                                        scout_route.route_fanout_timeout_stop_count
                                    );
                                    break;
                                }
                            }
                            Err(err) => {
                                println!(
                                    "  [SCOUT-LADDER] escalate lane={} error={}",
                                    lane.name, err
                                );
                            }
                        }
                    }
                    let tournament_artifact_dir =
                        artifact_dir_from_env().map(|dir| dir.join("scout-tournament"));
                    match candidate_fanout::select_and_apply(
                        &fanout_config,
                        &invocation,
                        &workdir,
                        tournament_artifact_dir,
                        lane_batches,
                    )
                    .await
                    {
                        Ok(outcome) if outcome.applied => {
                            selected_fanout_validation = outcome.selected_validation.clone();
                            println!(
                                "  [SCOUT-TOURNAMENT] selected candidate={:?} hash={:?} candidates={} elapsed_ms={} timeouts={} patch_timeouts={} detail={}",
                                outcome.selected_candidate_id,
                                outcome.selected_patch_hash,
                                outcome.candidate_count,
                                outcome.elapsed_ms,
                                outcome.timed_out_count,
                                outcome.timed_out_with_patch_count,
                                outcome.detail,
                            );
                            if let Some(provenance) = &selected_fanout_validation {
                                println!(
                                    "  [SCOUT-TOURNAMENT] validation_provenance candidate={} signal={} scope={}",
                                    provenance.candidate_id,
                                    provenance.signal,
                                    provenance.scope_desc
                                );
                            }
                            modified_files.clear();
                            read_cache.clear();
                            read_paths.clear();
                            observation_cache.clear();
                            break 'agent_loop;
                        }
                        Ok(outcome) => println!(
                            "  [SCOUT-TOURNAMENT] no selectable patch candidates={} elapsed_ms={} detail={}",
                            outcome.candidate_count, outcome.elapsed_ms, outcome.detail
                        ),
                        Err(err) => println!("  [SCOUT-TOURNAMENT] selection error: {}", err),
                    }
                    patch_hypotheses = all_patch_hypotheses.clone();
                    active_patch_hypothesis_index = 0;
                    patch_hypotheses_exhausted = patch_hypotheses.is_empty();
                    write_candidate_state_artifacts(
                        &patch_hypotheses,
                        active_patch_hypothesis_index,
                        patch_hypotheses_exhausted,
                        "scout lane escalation exhausted; restored full hypothesis set",
                    );
                }

                if !scout_lane_escalation_ran
                    && fanout_config.parent_enabled()
                    && enable_patch_tournament
                    && patch_hypotheses.len() > 1
                {
                    println!(
                        "  [CANDIDATE-FANOUT] starting logical parallel candidates={} concurrency={} child_steps={}",
                        patch_hypotheses.len().min(fanout_config.max_candidates),
                        fanout_config.concurrency,
                        fanout_config.child_max_steps
                    );
                    let executable = std::env::current_exe().unwrap_or_else(|_| {
                        std::path::PathBuf::from(
                            std::env::args()
                                .next()
                                .unwrap_or_else(|| "sw-agent".to_string()),
                        )
                    });
                    let invocation = candidate_fanout::AgentInvocation {
                        executable,
                        task: task.clone(),
                        ollama_url: args.ollama_url.clone(),
                        model: args.model.clone(),
                        max_retries: args.max_retries,
                        hardcoded_machine: args.hardcoded_machine.clone(),
                        use_hardcoded_machine: args.use_hardcoded_machine,
                        tool_mode: args.tool_mode.clone(),
                        model_size: args.model_size,
                        config_path: args.config.clone(),
                    };
                    let fanout_hypotheses = patch_hypotheses
                        .iter()
                        .map(|hypothesis| candidate_fanout::CandidateHypothesis {
                            id: hypothesis.id,
                            path: hypothesis.path.clone(),
                            score: hypothesis.score,
                            reason: hypothesis.reason.clone(),
                        })
                        .collect();
                    match candidate_fanout::run(
                        &fanout_config,
                        &invocation,
                        &workdir,
                        artifact_dir_from_env(),
                        fanout_hypotheses,
                    )
                    .await
                    {
                        Ok(outcome) if outcome.applied => {
                            println!(
                                "  [CANDIDATE-FANOUT] selected {:?} hash={:?} detail={}",
                                outcome.selected_candidate_id,
                                outcome.selected_patch_hash,
                                outcome.detail
                            );
                            modified_files.clear();
                            read_cache.clear();
                            read_paths.clear();
                            observation_cache.clear();
                            break 'agent_loop;
                        }
                        Ok(outcome) => {
                            println!(
                                "  [CANDIDATE-FANOUT] no selected patch candidates={} detail={}",
                                outcome.candidate_count, outcome.detail
                            );
                            if !fanout_config.fallback_to_sequential {
                                println!(
                                    "  [CANDIDATE-FANOUT] continuing parent repair after unselected fanout; terminal no-selection fallback is deprecated"
                                );
                            }
                        }
                        Err(err) => {
                            println!("  [CANDIDATE-FANOUT] error: {}", err);
                            if !fanout_config.fallback_to_sequential {
                                println!(
                                    "  [CANDIDATE-FANOUT] continuing parent repair after fanout error; terminal no-selection fallback is deprecated"
                                );
                            }
                        }
                    }
                }

                // Build file ranking section for the model's context
                let file_ranking_section = if enable_problem_shape {
                    problem_shape.render_file_ranking_section()
                } else if ranked_files.len() > 1 {
                    let mut s = String::from(
                        "## Most Relevant Files (ranked by keyword density - start with #1)\n",
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
                let issue_behavior_section = issue_behavior_checklist(&task);
                let issue_behavior_section = if issue_behavior_section.is_empty() {
                    String::new()
                } else {
                    format!(
                        "\n\n## Issue Behavior Checklist\n{}",
                        issue_behavior_section
                    )
                };
                let test_summary_for_context = if test_scope_correlated {
                    test_summary.as_str()
                } else {
                    "No trusted issue-local test failure is available yet. Bounded unscoped discovery probes are advisory only."
                };
                let advisory_test_mapping_section = if !test_scope_correlated
                    && (!probe_test_labels.is_empty()
                        || !probe_test_files.is_empty()
                        || !advisory_source_test_candidate_lines.is_empty())
                {
                    let mut section = String::from(
                        "\n\n## Advisory Test Mapping\nThese are best-effort test handles from a short-circuited discovery probe and source-locus mapping. Treat them as behavioral clues only; do not edit tests and do not treat passing advisory scopes as proof of completion.\n",
                    );
                    if !probe_test_labels.is_empty() {
                        section.push_str("\nProbe labels:\n");
                        for label in probe_test_labels.iter().take(5) {
                            section.push_str(&format!("- `{}`\n", label));
                        }
                    }
                    if !probe_test_files.is_empty() {
                        section.push_str("\nProbe test files:\n");
                        for path in probe_test_files.iter().take(5) {
                            section.push_str(&format!("- `{}`\n", path));
                        }
                    }
                    if !advisory_source_test_candidate_lines.is_empty() {
                        section.push_str("\nSource-locus candidate test files:\n");
                        for line in advisory_source_test_candidate_lines.iter().take(5) {
                            section.push_str(line);
                            section.push('\n');
                        }
                    }
                    section
                } else {
                    String::new()
                };
                let clu_policy_section = clu_policy
                    .as_ref()
                    .map(|policy| policy.render_prompt_section())
                    .unwrap_or_default();
                let patch_hypothesis_section = if enable_patch_tournament {
                    patch_hypotheses
                        .get(active_patch_hypothesis_index)
                        .map(|hypothesis| {
                            format!(
                                "\n\n## Patch Tournament\n{}",
                                render_patch_hypothesis_prompt(hypothesis, patch_hypotheses.len())
                            )
                        })
                        .unwrap_or_default()
                } else {
                    String::new()
                };

                localization_summary = format!(
                    "{}{}{}{}{}\n## Test Failures\n{}{}\n\n## Relevant Code\n{}{}",
                    file_ranking_section,
                    clu_policy_section,
                    enrichment_section,
                    issue_behavior_section,
                    patch_hypothesis_section,
                    test_summary_for_context,
                    advisory_test_mapping_section,
                    localized_code,
                    hint_section
                );

                // TEST_INJECTION: append failing test file content so the model has a
                // machine-readable spec to implement against, not just prose description.
                if has_scoped_test_env {
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
                } else if promoted_feedback_test_scope {
                    println!("  [TEST_INJECT] skipped feedback-only test content injection");
                }

                // Feed everything into conversation for the next reasoning state
                conversation.push(ChatMessage {
                    role: "user".into(),
                    content: format!(
                        "Bug localization results:\n\n{}\n\nAnalyze these code sections to find the bug described in the task.",
                        localization_summary
                    ),
                });

                let from = current_state.clone();
                let next = localized_next_state(&definition);
                current_state = next.clone();
                steps_in_current_state = 0;
                emit!(
                    TuiEvent::Transition {
                        from: from,
                        to: next.clone(),
                        trigger: Some("LOCALIZED".into()),
                        rationale: Some("Programmatic localization complete".into())
                    },
                    format!("  [TRANSITION] localizing -> {}", next)
                );
                continue;
            }

            if is_validation_state(&current_state) {
                // Auto-run tests on entry using the harness-provided scope. Feedback-only
                // discovery scopes stay advisory unless explicitly retargeted; v101 showed
                // edited-source retargeting can create collection noise unrelated to the bug.
                let (env_testing_scope, env_testing_scope_desc) =
                    harness_validation_scope_from_env();
                let changed_source_paths: Vec<String> = tools::all_diff_stats(&args.workdir)
                    .into_iter()
                    .map(|(path, _, _)| path)
                    .filter(|path| !is_test_path(path, &sw_test_files))
                    .collect();
                let (testing_scope, testing_scope_desc) =
                    if !test_scope_env_can_complete() && retarget_feedback_only_scope_enabled() {
                        if let Some((scope, desc)) = feedback_test_scope_for_sources(
                            &args.workdir,
                            &changed_source_paths,
                            &repo_file_index,
                            &args.task,
                            "EDITED_SOURCE_TEST_FILES",
                        ) {
                            println!(
                                "  [TESTING] retargeted feedback-only scope from {} to {}",
                                env_testing_scope_desc, desc
                            );
                            (scope, desc)
                        } else {
                            (env_testing_scope, env_testing_scope_desc)
                        }
                    } else {
                        (env_testing_scope, env_testing_scope_desc)
                    };
                if testing_scope_desc == "unscoped harness command"
                    && testing_scope.get("path").is_none()
                    && testing_scope.get("file").is_none()
                {
                    if causal_one_pass {
                        record_causal_validation_unavailable(
                            &mut causal_repair_controller,
                            &testing_scope_desc,
                            "no resolvable TestSpec scope in validation state",
                        );
                    }
                    let validation_target = validation_unavailable_state_name(&definition);
                    println!(
                        "[Step {}] State: testing — no safe scoped test target",
                        step
                    );
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: "No safe scoped harness validation target is available. Do not run the full repository test suite repeatedly as a proxy for this fix. Return to source reasoning: inspect the diff, choose a narrower related test target if available, or make a smaller correction before finishing.".into(),
                    });
                    emit!(
                        TuiEvent::Transition {
                            from: current_state.clone(),
                            to: validation_target.clone(),
                            trigger: Some("VALIDATION_UNAVAILABLE".into()),
                            rationale: Some(
                                "No safe scoped harness target; returning to repair by default"
                                    .into()
                            )
                        },
                        format!(
                            "  [TRANSITION] {} -> {} (validation unavailable)",
                            current_state, validation_target
                        )
                    );
                    current_state = validation_target;
                    steps_in_current_state = 0;
                    continue;
                }
                let changed_before_test = tools::all_diff_stats(&args.workdir);
                let test_result = tools::execute_tool("run_test", &testing_scope, &args.workdir);
                let restored_side_effects =
                    restore_tracked_test_side_effects(&args.workdir, &changed_before_test);
                if !restored_side_effects.is_empty() {
                    println!(
                        "  [TEST-SIDE-EFFECT] restored tracked file(s): {}",
                        restored_side_effects.join(", ")
                    );
                }
                let changed_before_classification = tools::all_diff_stats(&args.workdir);
                if test_collection_failure_unrelated_to_diff(
                    &test_result,
                    &changed_before_classification,
                ) {
                    if causal_one_pass {
                        record_causal_validation_unavailable(
                            &mut causal_repair_controller,
                            &testing_scope_desc,
                            "collection failed before reaching changed source; scope is not causal evidence",
                        );
                    }
                    let validation_target = validation_unavailable_state_name(&definition);
                    let telemetry =
                        compact_test_telemetry(&test_result, &testing_scope_desc, &args.model);
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!(
                            "Harness validation hit a collection/scope failure before reaching the modified source files. Treat this validation target as invalid telemetry, not as evidence that the patch is wrong.\n\n{}",
                            telemetry
                        ),
                    });
                    emit!(
                        TuiEvent::Transition {
                            from: current_state.clone(),
                            to: validation_target.clone(),
                            trigger: Some("VALIDATION_SCOPE_INVALID".into()),
                            rationale: Some(
                                "Collection/scope failure was unrelated to modified files; returning to repair by default"
                                    .into()
                            )
                        },
                        format!(
                            "  [TRANSITION] {} -> {} (validation scope invalid)",
                            current_state,
                            validation_target
                        )
                    );
                    current_state = validation_target;
                    steps_in_current_state = 0;
                    continue;
                }
                // Runner error (non-zero exit, no assertions) is not a pass and not
                // a canonical fail. Return to implementation with bounded telemetry.
                if test_is_runner_error(&test_result) {
                    if causal_one_pass {
                        record_causal_validation_unavailable(
                            &mut causal_repair_controller,
                            &testing_scope_desc,
                            "TestSpec execution did not produce a reliable pass/fail signal",
                        );
                    }
                    let exit_code = test_exit_code(&test_result);
                    let runner_msg = match exit_code {
                        Some(5) => {
                            // No tests collected — wrong test file target
                            eprintln!(
                                "  [TESTING] no tests collected (exit 5) from '{}' — redirecting",
                                testing_scope_desc
                            );
                            format!(
                                "No tests were collected from '{}'. \
                                 This file does not contain pytest-discoverable test functions \
                                 (basenames must start with 'test_'). \
                                 Use find_files to locate the correct test file for the module \
                                 you modified, then call transition(event=TESTS_FAIL) to return \
                                 to implementing.",
                                testing_scope_desc
                            )
                        }
                        Some(4) => {
                            // Collection error — likely an import/syntax error from the edit
                            eprintln!(
                                "  [TESTING] collection error (exit 4) — import/syntax failure"
                            );
                            let error_hint: String = test_result
                                .lines()
                                .filter(|l| {
                                    l.contains("ImportError")
                                        || l.contains("ModuleNotFoundError")
                                        || l.contains("SyntaxError")
                                        || l.contains("IndentationError")
                                })
                                .take(4)
                                .collect::<Vec<_>>()
                                .join("\n");
                            format!(
                                "Test collection failed — your edit likely introduced an import \
                                 or syntax error:\n{}\n\n\
                                 Review the files you modified and fix the error, then call \
                                 transition(event=TESTS_FAIL) to return to implementing.",
                                if error_hint.is_empty() {
                                    test_result[..test_result.len().min(400)].to_string()
                                } else {
                                    error_hint
                                }
                            )
                        }
                        _ => {
                            eprintln!(
                                "  [TESTING] runner error (non-zero, no assertions) — validation unavailable"
                            );
                            format!(
                                "Harness validation could not produce a reliable pass/fail signal.\n\n{}\n\nDo not treat this as a pass. Return to source reasoning: inspect the diff, choose a different scoped test if available, or make a narrower correction before transitioning DONE again.",
                                compact_test_telemetry(
                                    &test_result,
                                    &testing_scope_desc,
                                    &args.model
                                )
                            )
                        }
                    };
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: runner_msg,
                    });
                    emit!(
                        TuiEvent::Transition {
                            from: current_state.clone(),
                            to: failure_triage_state_name(&definition),
                            trigger: Some("VALIDATION_UNAVAILABLE".into()),
                            rationale: Some(
                                "Harness validation did not produce a pass/fail signal".into()
                            )
                        },
                        format!(
                            "  [TRANSITION] {} -> {} (validation unavailable)",
                            current_state,
                            failure_triage_state_name(&definition)
                        )
                    );
                    current_state = failure_triage_state_name(&definition);
                    steps_in_current_state = 0;
                    continue;
                } else {
                    let passed = test_passed(&test_result);
                    let causal_scope_assessment = causal_one_pass.then(|| {
                        record_causal_scope_validation(
                            &mut causal_repair_controller,
                            &mut causal_checkpoint_store,
                            &args.workdir,
                            &testing_scope,
                            &testing_scope_desc,
                            &test_result,
                            &changed_before_test,
                        )
                    });
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
                    if causal_one_pass {
                        let assessment = causal_scope_assessment
                            .as_ref()
                            .expect("causal mode records every completed sandbox test execution");
                        let audit_only = passed && assessment.signal.is_pass_like();
                        let target = if audit_only {
                            trusted_pass_state_name(&definition)
                        } else {
                            failure_triage_state_name(&definition)
                        };
                        let qualified_reproducer = tools::has_qualified_task_reproducer();
                        let evidence_description = match assessment.signal {
                            causal_validation::CausalScopeSignal::RegressionPass => {
                                "baseline-green regression scope preserved"
                            }
                            causal_validation::CausalScopeSignal::TaskScopeImproved => {
                                "task-related public scope improved from its baseline"
                            }
                            causal_validation::CausalScopeSignal::StructuralPass => {
                                "structural sandbox scope passed without a task baseline"
                            }
                            _ => assessment.signal.as_str(),
                        };
                        let message = if audit_only {
                            format!(
                                "Causal validation observed {}. Reproducer qualified: {}. This is internal repair evidence only, not an official solve. Audit the patch against the task; submit it to the canonical evaluator only as a candidate hypothesis.\n\n{}",
                                evidence_description,
                                qualified_reproducer,
                                compact_test_telemetry(
                                    &test_result,
                                    &testing_scope_desc,
                                    &args.model
                                )
                            )
                        } else {
                            format!(
                                "Causal validation observed `{}`: {}. Continue repair from this typed signal; do not infer task completion.\n\n{}",
                                assessment.signal.as_str(),
                                assessment.validation.decision.reason,
                                compact_test_telemetry(
                                    &test_result,
                                    &testing_scope_desc,
                                    &args.model
                                )
                            )
                        };
                        conversation.push(ChatMessage {
                            role: "user".into(),
                            content: message,
                        });
                        emit!(
                            TuiEvent::Transition {
                                from: current_state.clone(),
                                to: target.clone(),
                                trigger: Some(if audit_only {
                                    "CAUSAL_VALIDATION_AUDIT_ONLY".into()
                                } else {
                                    "CAUSAL_VALIDATION_REPAIR".into()
                                }),
                                rationale: Some(if audit_only {
                                    "Causal validation may prepare a candidate but cannot certify a benchmark solve".into()
                                } else {
                                    "Causal validation did not preserve a usable repair trajectory"
                                        .into()
                                })
                            },
                            format!(
                                "  [TRANSITION] {} -> {} (causal validation signal={})",
                                current_state,
                                target,
                                assessment.signal.as_str()
                            )
                        );
                        current_state = target;
                        steps_in_current_state = 0;
                        continue;
                    }
                    if passed && !test_scope_can_complete(&test_result) {
                        println!("  [AUTO-TEST] PASS — feedback only");
                        let changed = tools::all_diff_stats(&args.workdir);
                        candidate_bank.record_feedback_pass_candidate(
                            &args.workdir,
                            &changed,
                            &test_result,
                            &testing_scope_desc,
                            true,
                        );
                        let issue_behavior = issue_behavior_checklist(&task);
                        let issue_behavior = if issue_behavior.is_empty() {
                            "No compact issue checklist was extracted; compare the source diff directly against the task description.".to_string()
                        } else {
                            issue_behavior
                        };
                        let telemetry =
                            compact_test_telemetry(&test_result, &testing_scope_desc, &args.model);
                        let feedback_only_can_branch =
                            candidate_bank.feedback_only_branch_can_discard_current(&changed);
                        if feedback_only_pass_branch_enabled()
                            && feedback_only_can_branch
                            && enable_patch_tournament
                            && !patch_hypotheses_exhausted
                        {
                            if let Some(next_prompt) = advance_patch_hypothesis(
                                &patch_hypotheses,
                                &mut active_patch_hypothesis_index,
                                "feedback_only_pass",
                                &telemetry,
                            ) {
                                println!(
                                    "  [AUTO-TEST] feedback-only pass recorded; branching to next hypothesis"
                                );
                                tools::restore_snapshot(&args.workdir);
                                modified_files.clear();
                                read_cache.clear();
                                read_paths.clear();
                                observation_cache.clear();
                                same_auto_test_failure_count = 0;
                                same_test_diagnostic_required = false;
                                edit_fail_count = 0;
                                off_hypothesis_edit_count = 0;
                                edit_path_argument_fail_count = 0;
                                conversation.clear();
                                conversation.push(ChatMessage {
                                    role: "user".into(),
                                    content: format!(
                                        "A feedback-only scoped test passed. It is useful telemetry, not completion evidence. The candidate was retained for offline selection; snapshot restored so the next problem-shape hypothesis can be tried independently.\n\n{}\n\nNext hypothesis:\n{}\n\nIssue behavior checklist:\n{}",
                                        telemetry, next_prompt, issue_behavior
                                    ),
                                });
                                let from_state = current_state.clone();
                                let next_state = if definition.states.contains_key("patch_planning")
                                {
                                    "patch_planning".to_string()
                                } else {
                                    implementation_state_name(&definition)
                                };
                                emit!(
                                    TuiEvent::Transition {
                                        from: from_state.clone(),
                                        to: next_state.clone(),
                                        trigger: Some("FEEDBACK_ONLY_NEXT_HYPOTHESIS".into()),
                                        rationale: Some(
                                            "Feedback-only pass cannot complete; trying independent hypothesis"
                                                .into()
                                        )
                                    },
                                    format!(
                                        "  [TRANSITION] {} -> {} (feedback-only branch)",
                                        from_state, next_state
                                    )
                                );
                                current_state = next_state;
                                steps_in_current_state = 0;
                                continue;
                            } else {
                                patch_hypotheses_exhausted = true;
                                println!(
                                    "  [AUTO-TEST] feedback-only pass branch requested but hypotheses exhausted"
                                );
                            }
                        } else if feedback_only_pass_branch_enabled() && !feedback_only_can_branch {
                            println!(
                                "  [AUTO-TEST] feedback-only branch suppressed; candidate is telemetry-only and not final-restorable"
                            );
                        }
                        let feedback_target = validation_unavailable_state_name(&definition);
                        conversation.push(ChatMessage {
                            role: "user".into(),
                            content: format!(
                                "Related scoped tests passed, but this scope is feedback-only and cannot approve completion. Treat it as weak telemetry only.\n\n{}\n\nDo not finish from this signal. Find a stronger source-derived test or build a direct reproducer from the issue behavior, then repair or narrow the patch before validating again.\n\n{}",
                                telemetry,
                                issue_behavior
                            ),
                        });
                        emit!(
                            TuiEvent::Transition {
                                from: current_state.clone(),
                                to: feedback_target.clone(),
                                trigger: Some("VALIDATION_FEEDBACK_ONLY".into()),
                                rationale: Some(
                                    "Feedback-only scoped pass is soft validation; routing by candidate context"
                                        .into()
                                )
                            },
                            format!(
                                "  [TRANSITION] {} -> {} (feedback-only pass cannot complete)",
                                current_state, feedback_target
                            )
                        );
                        current_state = feedback_target;
                        steps_in_current_state = 0;
                        continue;
                    } else if passed {
                        emit!(
                            TuiEvent::AutoTest {
                                passed: true,
                                fail_count: 0
                            },
                            "  [AUTO-TEST] ALL PASSED"
                        );
                        // Show what changed
                        let changed = tools::all_diff_stats(&args.workdir);
                        candidate_bank.record_feedback_pass_candidate(
                            &args.workdir,
                            &changed,
                            &test_result,
                            &testing_scope_desc,
                            false,
                        );
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
                            "Harness validation ran automatically and ALL PASSED.\n\n{}\n\nProceeding to review.",
                            compact_test_telemetry(&test_result, &testing_scope_desc, &args.model)
                        ),
                    });
                        emit!(
                            TuiEvent::Transition {
                                from: current_state.clone(),
                                to: trusted_pass_state_name(&definition),
                                trigger: Some("TESTS_PASS".into()),
                                rationale: Some("All tests passed".into())
                            },
                            format!(
                                "  [TRANSITION] {} -> {}",
                                current_state,
                                trusted_pass_state_name(&definition)
                            )
                        );
                        current_state = trusted_pass_state_name(&definition);
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
                        let patch_shape_issue =
                            patch_shape_violation(&changed, profile.max_diff_lines);
                        let oversized = patch_shape_issue.is_some();
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
                            // Keep read_paths — model has file content in conversation from
                            // GATE injection. Clearing causes infinite GATE→structural-failure→restore cycle.
                            eprintln!(
                                "  [TESTING] structural failure — restored candidate snapshot{}",
                                patch_shape_issue
                                    .as_deref()
                                    .map(|reason| format!(" ({})", reason))
                                    .unwrap_or_default()
                            );
                        } else {
                            eprintln!(
                                "  [TESTING] ordinary failure — keeping source diff for refinement"
                            );
                        }
                        let failure_excerpt =
                            compact_test_telemetry(&test_result, &testing_scope_desc, &args.model);
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
                            "Harness validation ran automatically and FAILED.\n\n{}\n\nTelemetry:\n{}\n\nYou are back in the repair path.",
                            retry_instruction,
                            failure_excerpt
                        ),
                    });
                        current_state = failure_triage_state_name(&definition);
                        steps_in_current_state = 0;
                        println!(
                            "  [TRANSITION] testing -> {}",
                            failure_triage_state_name(&definition)
                        );
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

        if causal_one_pass
            && task_evidence_budget_exhausted(&current_state, steps_in_current_state)
        {
            let target = trusted_pass_state_name(&definition);
            record_causal_event(
                &mut causal_repair_controller,
                causal_repair::CausalEvent::ValidationObserved {
                    signal: "post_patch_task_evidence_budget_exhausted".to_string(),
                    detail: format!("turns={steps_in_current_state}"),
                },
            );
            println!(
                "  [CAUSAL TASK-EVIDENCE] status=budget_exhausted turns={} route={}",
                steps_in_current_state, target
            );
            conversation.push(ChatMessage {
                role: "user".into(),
                content: "The bounded post-patch evidence attempt ended without a qualified task reproducer. Keep the retained source patch unchanged and audit it directly against the public issue and source contracts. Evidence remains safety-only; canonical evaluation is the sole solve authority.".into(),
            });
            emit!(
                TuiEvent::Transition {
                    from: current_state.clone(),
                    to: target.clone(),
                    trigger: Some("TASK_EVIDENCE_BUDGET_EXHAUSTED".into()),
                    rationale: Some(
                        "Bounded evidence acquisition preserved the retained candidate".into()
                    )
                },
                format!(
                    "  [TRANSITION] {} -> {} (task evidence budget exhausted)",
                    current_state, target
                )
            );
            current_state = target;
            steps_in_current_state = 0;
            continue 'agent_loop;
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
                // Don't force transition from implementing with an empty patch —
                // auto-test would pass on unchanged code, producing a false COMPLETED.
                if is_implementation_state(&current_state) {
                    let changed_files = tools::all_diff_stats(&args.workdir);
                    if changed_files.is_empty() {
                        println!(
                            "[Step {}] HARD LIMIT in '{}' — but no edits made, injecting guidance",
                            step, current_state
                        );
                        conversation.push(ChatMessage {
                            role: "user".into(),
                            content: "HARD LIMIT: You have used all available steps without making any source code edits. You MUST modify an implementation source file, not a test file. Use find_files or grep to locate the correct implementation, then make your edit.".into(),
                        });
                        // Give 5 more steps to attempt an edit
                        steps_in_current_state = limit.saturating_sub(5);
                        continue;
                    }
                }
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
        if enable_patch_tournament
            && !patch_hypotheses_exhausted
            && !patch_hypotheses.is_empty()
            && is_implementation_state(&current_state)
        {
            active_patch_hypothesis_steps = active_patch_hypothesis_steps.saturating_add(1);
        }

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
        let use_native =
            model_registry::use_native_tool_calling(&args.tool_mode, active_profile.tool_mode);

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
            content: if is_checkpoint && is_implementation_state(&current_state) {
                "You've reached the iteration limit. Make your best edit NOW based on what you've read, then call transition with DONE. Do not skip the edit.".into()
            } else if is_checkpoint {
                "You've reached the iteration limit. Make your decision now.".into()
            } else if let Some(hint) = &persistent_hint {
                format!("What is your next action?\n\nNote: {}", hint)
            } else {
                "What is your next action?".into()
            },
        });

        let mut tool_calls_to_process: Vec<ToolInvocation> = Vec::new();
        let mut transition_event: Option<String> = None;
        let mut transition_error: Option<String> = None;

        if use_native {
            // Native tool calling path
            let tool_defs = statewright_agent::ollama_client::build_tool_definitions_with_nav(
                &allowed_tools,
                &transitions,
            );
            let mut native_messages = vec![ToolProtocolMessage::from(&messages[0])];
            let protocol_window =
                conversation.protocol_window_with_diagnostics(history_start);
            if !protocol_window.interrupted_call_ids.is_empty() {
                println!(
                    "  [TOOL PROTOCOL] closed_interrupted_results={} ids={}",
                    protocol_window.interrupted_call_ids.len(),
                    protocol_window.interrupted_call_ids.join(",")
                );
            }
            native_messages.extend(protocol_window.messages);
            if let Some(next_action) = messages.last() {
                native_messages.push(ToolProtocolMessage::from(next_action));
            }
            let result = match client
                .chat_with_required_tools(native_messages, tool_defs, tool_protocol_retries())
                .await
            {
                Ok(r) => r,
                Err(e) if retryable_llm_transport_error(&e) => {
                    consecutive_llm_transport_failures += 1;
                    eprintln!(
                        "  [MODEL BACKOFF] native tool request failed after retries ({}/4): {}",
                        consecutive_llm_transport_failures, e
                    );
                    if consecutive_llm_transport_failures >= 4 {
                        eprintln!(
                            "  [LLM ERROR] model endpoint remained unavailable after repeated backoff"
                        );
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(llm_transport_backoff_secs(
                        consecutive_llm_transport_failures,
                    )))
                    .await;
                    continue 'agent_loop;
                }
                Err(e) if deprecated_native_raw_fallback_enabled() => {
                    eprintln!(
                        "  [DEPRECATED NATIVE FALLBACK] {} — falling back to raw JSON",
                        e
                    );
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
                            consecutive_llm_transport_failures = 0;
                            // Parse as raw JSON
                            if let Some(resp) = parse_response(&raw) {
                                if let Some(calls) = resp.tool_calls {
                                    for c in calls {
                                        tool_calls_to_process
                                            .push(unstructured_invocation(c.name, c.args));
                                    }
                                }
                                transition_event = resp.transition;
                                transition_error = resp.error;
                                conversation.push(ChatMessage {
                                    role: "assistant".into(),
                                    content: raw,
                                });
                                consecutive_parse_failures = 0;
                            }
                            // Continue to processing below
                            statewright_agent::ollama_client::ChatResult {
                                content: String::new(),
                                tool_calls: vec![],
                                mode: statewright_agent::ollama_client::ResponseMode::RawJson,
                                reasoning: None,
                                protocol_trace: Vec::new(),
                                protocol_corrections: 0,
                                rescued_tool_call: false,
                            }
                        }
                        Err(e2) => {
                            eprintln!("  [LLM ERROR] {}", e2);
                            break;
                        }
                    }
                }
                Err(e) => {
                    eprintln!(
                        "  [NATIVE PROTOCOL ERROR] {}. Raw fallback is disabled; set DEPRECATED_SW_NATIVE_RAW_FALLBACK=1 only to reproduce the legacy path.",
                        e
                    );
                    break 'agent_loop;
                }
            };

            if result.mode == statewright_agent::ollama_client::ResponseMode::NativeToolCalling {
                consecutive_llm_transport_failures = 0;
                if result.protocol_corrections > 0 || result.rescued_tool_call {
                    println!(
                        "  [TOOL PROTOCOL] corrections={} rescued={}",
                        result.protocol_corrections, result.rescued_tool_call
                    );
                }
                conversation.extend_protocol_trace(result.protocol_trace);
                let mut native_calls = result.tool_calls;
                let assistant_content =
                    fold_reasoning_into_content(result.content, result.reasoning.as_deref());

                // Some Qwen-compatible servers surface a textual tool call even
                // with native tools enabled. Canonicalize it once, without also
                // executing a duplicate structured call.
                if native_calls.is_empty() && !assistant_content.is_empty() {
                    if let Some(resp) = parse_response(&assistant_content) {
                        if let Some(calls) = resp.tool_calls {
                            native_calls.extend(calls.into_iter().map(|call| {
                                statewright_agent::ollama_client::NativeToolCall {
                                    id: None,
                                    call_type: Some("function".into()),
                                    function:
                                        statewright_agent::ollama_client::NativeFunctionCall {
                                            name: call.name,
                                            arguments: call.args,
                                        },
                                }
                            }));
                        }
                        if let Some(event) = resp.transition {
                            native_calls.push(statewright_agent::ollama_client::NativeToolCall {
                                id: None,
                                call_type: Some("function".into()),
                                function: statewright_agent::ollama_client::NativeFunctionCall {
                                    name: "transition".into(),
                                    arguments: serde_json::json!({
                                        "event": event,
                                        "error": resp.error,
                                    }),
                                },
                            });
                        }
                    }
                }

                canonicalize_native_calls(&mut native_calls, &mut next_protocol_call_id);
                for tc in &native_calls {
                    let invocation = invocation_from_native(tc);
                    println!(
                        "  [NATIVE] {}({})",
                        tc.function.name,
                        truncate_json(&invocation.args, 60)
                    );
                    tool_calls_to_process.push(invocation);
                }

                // If no tool calls and no transition from native, the model gave text only
                if tool_calls_to_process.is_empty() && transition_event.is_none() {
                    println!(
                        "  [TOOL PROTOCOL EXHAUSTED] {}",
                        truncate(&assistant_content, 300)
                    );
                }

                if native_calls.is_empty() {
                    conversation.push(ChatMessage {
                        role: "assistant".into(),
                        content: assistant_content,
                    });
                } else {
                    conversation.push_assistant_tool_turn(assistant_content, &native_calls);
                }
            }
        } else {
            // Raw JSON path (or checkpoint)
            let raw_response = match client.chat(messages).await {
                Ok(r) => {
                    consecutive_llm_transport_failures = 0;
                    r
                }
                Err(e) if retryable_llm_transport_error(&e) => {
                    consecutive_llm_transport_failures += 1;
                    eprintln!(
                        "  [MODEL BACKOFF] raw request failed after retries ({}/4): {}",
                        consecutive_llm_transport_failures, e
                    );
                    if consecutive_llm_transport_failures >= 4 {
                        eprintln!(
                            "  [LLM ERROR] model endpoint remained unavailable after repeated backoff"
                        );
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(llm_transport_backoff_secs(
                        consecutive_llm_transport_failures,
                    )))
                    .await;
                    continue 'agent_loop;
                }
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
                                tool_calls_to_process.push(unstructured_invocation(c.name, c.args));
                            }
                        }
                        transition_event = resp.transition;
                        transition_error = resp.error;
                        conversation.push(ChatMessage {
                            role: "assistant".into(),
                            content: raw_response,
                        });
                        consecutive_parse_failures = 0;
                    }
                    None => {
                        consecutive_parse_failures += 1;
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
                            tool_calls_to_process.push(unstructured_invocation(tool, args_val));
                            conversation.push(ChatMessage {
                                role: "assistant".into(),
                                content: raw_response,
                            });
                            consecutive_parse_failures = 0;
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
                                consecutive_parse_failures = 0;
                            } else {
                                let path_warnings = malformed_response_path_diagnostics(
                                    &raw_response,
                                    &args.workdir,
                                );
                                if attempt_packet_reset
                                    && enable_patch_tournament
                                    && !patch_hypotheses_exhausted
                                    && consecutive_parse_failures >= parse_fail_reset_threshold
                                {
                                    let repair_current = parse_repair_hypothesis_index
                                        != Some(active_patch_hypothesis_index)
                                        && should_repair_parse_fail_on_active_hypothesis(
                                            active_clu_policy.as_ref(),
                                            &patch_hypotheses,
                                            active_patch_hypothesis_index,
                                        );
                                    if repair_current {
                                        if let Some(active) =
                                            patch_hypotheses.get(active_patch_hypothesis_index)
                                        {
                                            log_patch_attempt(
                                                active,
                                                "parse_fail_repair",
                                                &truncate(&raw_response, 240),
                                            );
                                            println!(
                                                "  [ATTEMPT-PACKET] action=repair_same_hypothesis reason=parse_fail_burst count={}",
                                                consecutive_parse_failures
                                            );
                                            tools::restore_snapshot(&args.workdir);
                                            modified_files.clear();
                                            read_cache.clear();
                                            read_paths.clear();
                                            observation_cache.clear();
                                            blocked_repeated_edit_fingerprints.clear();
                                            same_auto_test_failure_count = 0;
                                            same_test_diagnostic_required = false;
                                            edit_fail_count = 0;
                                            off_hypothesis_edit_count = 0;
                                            edit_path_argument_fail_count = 0;
                                            consecutive_parse_failures = 0;
                                            persistent_hint = None;
                                            parse_repair_hypothesis_index =
                                                Some(active_patch_hypothesis_index);
                                            conversation.clear();
                                            conversation.push(ChatMessage {
                                                role: "user".into(),
                                                content: format!(
                                                    "The current patch attempt produced repeated malformed tool output after recovery failed. Snapshot restored, but the active source hypothesis is still high confidence. Repair the same hypothesis with one minimal, syntactically valid source edit. Preserve the intended behavior change if it was correct, and fix only malformed syntax such as a missing colon, bracket, quote, or comma. Do not switch files unless concrete fresh evidence proves this source locus is wrong.\n\n{}\n\nLocalization context:\n{}",
                                                    render_patch_hypothesis_prompt(
                                                        active,
                                                        patch_hypotheses.len()
                                                    ),
                                                    localization_summary
                                                ),
                                            });
                                            let from_state = current_state.clone();
                                            let next_state =
                                                if definition.states.contains_key("patch_planning")
                                                {
                                                    "patch_planning".to_string()
                                                } else {
                                                    implementation_state_name(&definition)
                                                };
                                            emit!(
                                                TuiEvent::Transition {
                                                    from: from_state.clone(),
                                                    to: next_state.clone(),
                                                    trigger: Some(
                                                        "PARSE_FAIL_REPAIR_HYPOTHESIS".into()
                                                    ),
                                                    rationale: Some(
                                                        "Repeated malformed tool output on high-confidence hypothesis".into()
                                                    )
                                                },
                                                format!(
                                                    "  [TRANSITION] {} -> {} (parse-fail repair same hypothesis)",
                                                    from_state, next_state
                                                )
                                            );
                                            current_state = next_state;
                                            steps_in_current_state = 0;
                                            continue 'agent_loop;
                                        }
                                    }
                                    if let Some(next_prompt) = advance_patch_hypothesis(
                                        &patch_hypotheses,
                                        &mut active_patch_hypothesis_index,
                                        "parse_fail_burst",
                                        &truncate(&raw_response, 240),
                                    ) {
                                        parse_repair_hypothesis_index = None;
                                        println!(
                                            "  [ATTEMPT-PACKET] action=reset reason=parse_fail_burst count={}",
                                            consecutive_parse_failures
                                        );
                                        tools::restore_snapshot(&args.workdir);
                                        modified_files.clear();
                                        read_cache.clear();
                                        read_paths.clear();
                                        observation_cache.clear();
                                        blocked_repeated_edit_fingerprints.clear();
                                        same_auto_test_failure_count = 0;
                                        same_test_diagnostic_required = false;
                                        edit_fail_count = 0;
                                        off_hypothesis_edit_count = 0;
                                        edit_path_argument_fail_count = 0;
                                        consecutive_parse_failures = 0;
                                        persistent_hint = None;
                                        conversation.clear();
                                        conversation.push(ChatMessage {
                                            role: "user".into(),
                                            content: format!(
                                                "The current patch attempt produced repeated malformed tool output after recovery failed. Snapshot restored; use the next problem-shape hypothesis and keep the next edit minimal and tool-valid.\n\n{}\n\nLocalization context:\n{}",
                                                next_prompt, localization_summary
                                            ),
                                        });
                                        let from_state = current_state.clone();
                                        let next_state =
                                            if definition.states.contains_key("patch_planning") {
                                                "patch_planning".to_string()
                                            } else {
                                                implementation_state_name(&definition)
                                            };
                                        emit!(
                                            TuiEvent::Transition {
                                                from: from_state.clone(),
                                                to: next_state.clone(),
                                                trigger: Some("PARSE_FAIL_NEXT_HYPOTHESIS".into()),
                                                rationale: Some(
                                                    "Repeated malformed tool output".into()
                                                )
                                            },
                                            format!(
                                                "  [TRANSITION] {} -> {} (parse-fail next hypothesis)",
                                                from_state, next_state
                                            )
                                        );
                                        current_state = next_state;
                                        steps_in_current_state = 0;
                                        continue 'agent_loop;
                                    } else {
                                        patch_hypotheses_exhausted = true;
                                        println!(
                                            "  [ATTEMPT-PACKET] action=hypotheses_exhausted reason=parse_fail_burst"
                                        );
                                    }
                                }
                                conversation.push(ChatMessage {
                                    role: "assistant".into(),
                                    content: raw_response,
                                });
                                let mut recovery_message =
                                    recovery::parse_recovery_message(consecutive_parse_failures);
                                if !path_warnings.is_empty() {
                                    recovery_message.push_str("\n\n[REPO PATH GUARD]\n");
                                    recovery_message.push_str(&path_warnings.join("\n"));
                                }
                                conversation.push(ChatMessage {
                                    role: "user".into(),
                                    content: recovery_message,
                                });
                            }
                            continue;
                        }
                    }
                }
            } // close else (no file blocks)
        }

        if !tool_calls_to_process.is_empty() || transition_event.is_some() {
            consecutive_parse_failures = 0;
        }

        // Process tool calls (unified for both modes)
        let mut tool_output = String::new();
        let mut protocol_call_spans: Vec<(String, String, usize)> = Vec::new();
        let mut same_test_diagnostic_seen_this_step = false;
        let mut oversized_recovery_reads_this_step: Vec<String> = Vec::new();
        let mut oversized_recovery_diagnostic_seen_this_step = false;
        for invocation in &tool_calls_to_process {
            let tool_name = &invocation.name;
            let tool_args = &invocation.args;
            if let Some(call_id) = &invocation.call_id {
                protocol_call_spans.push((tool_name.clone(), call_id.clone(), tool_output.len()));
            }
            if let Some(error) = &invocation.argument_error {
                let message = format!(
                    "[ToolArgValidationError] {}. Reissue '{}' with one JSON object matching its schema.",
                    error, tool_name
                );
                println!("  [TOOL PROTOCOL] {}", message);
                tool_output.push_str(&message);
                tool_output.push('\n');
                continue;
            }
            // Handle state machine navigation tools
            if tool_name == "transition" {
                if same_test_diagnostic_required && is_implementation_state(&current_state) {
                    let msg = "BLOCKED: repeated edits are producing the same test failure. Before transitioning, use read_file, grep, inspect_class, find_files, or diff to inspect fresh evidence for a different locus or narrower fix.";
                    println!("  [SAME-TEST GUARD] {}", msg);
                    tool_output.push_str(msg);
                    tool_output.push('\n');
                    continue;
                }
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

            let mut repaired_tool_args: Option<serde_json::Value> = None;
            if is_implementation_state(&current_state) && edit_tool_requires_path(tool_name) {
                let mut candidate_args = tool_args.clone();
                let active_patch_hypothesis =
                    if enable_patch_tournament && !patch_hypotheses_exhausted {
                        patch_hypotheses.get(active_patch_hypothesis_index)
                    } else {
                        None
                    };
                let retained_candidate_paths = retained_candidate_source_paths(
                    &candidate_bank,
                    &quarantined_reanchor_paths,
                    enable_source_locus_intel,
                );
                if let Some((path, source)) = repair_edit_path_argument(
                    tool_name,
                    &mut candidate_args,
                    &read_paths,
                    &localized_file_contexts,
                    &localized_regions,
                    &sw_test_files,
                    &args.workdir,
                    active_patch_hypothesis,
                    &retained_candidate_paths,
                    if enable_source_locus_intel {
                        Some(&current_problem_shape)
                    } else {
                        None
                    },
                ) {
                    println!(
                        "  [ARG REPAIR] added path '{}' to {} from {}",
                        path, tool_name, source
                    );
                    tool_output.push_str(&format!(
                        "[ARG REPAIR] Added missing path `{}` to `{}` from {}.\n",
                        path, tool_name, source
                    ));
                    repaired_tool_args = Some(candidate_args);
                    edit_path_argument_fail_count = 0;
                }
            }
            let tool_args = repaired_tool_args.as_ref().unwrap_or(tool_args);

            if is_implementation_state(&current_state) && edit_tool_requires_path(tool_name) {
                if let Some(problem) =
                    edit_path_argument_problem(tool_name, tool_args, &args.workdir)
                {
                    edit_path_argument_fail_count += 1;
                    edit_fail_count += 1;
                    let active_patch_hypothesis =
                        if enable_patch_tournament && !patch_hypotheses_exhausted {
                            patch_hypotheses.get(active_patch_hypothesis_index)
                        } else {
                            None
                        };
                    let retained_candidate_paths = retained_candidate_source_paths(
                        &candidate_bank,
                        &quarantined_reanchor_paths,
                        enable_source_locus_intel,
                    );
                    let candidates = grounded_edit_path_candidates(
                        &read_paths,
                        &localized_file_contexts,
                        &localized_regions,
                        &sw_test_files,
                        &args.workdir,
                        active_patch_hypothesis,
                        &retained_candidate_paths,
                        if enable_source_locus_intel {
                            Some(&current_problem_shape)
                        } else {
                            None
                        },
                    );
                    let msg = format!(
                        "BLOCKED: `{}` has an unusable edit path argument ({}). Choose one exact existing source path before editing. You may use the path handles below as `path` values, e.g. `P1`.\n{}\nPath argument failures in this hypothesis: {}/{}.",
                        tool_name,
                        problem,
                        format_path_repair_candidates(&candidates),
                        edit_path_argument_fail_count,
                        path_argument_failure_threshold()
                    );
                    println!("  [PATH-REPAIR] {}", msg);

                    if enable_source_locus_intel
                        && edit_path_argument_fail_count >= path_argument_failure_threshold()
                        && source_locus_intel_refresh_count == 0
                        && !candidates.is_empty()
                    {
                        source_locus_intel_refresh_count += 1;
                        edit_path_argument_fail_count = 0;
                        let packet = format_source_locus_intel_packet(&candidates);
                        let active_note = active_patch_hypothesis
                            .map(|hypothesis| render_patch_hypothesis_prompt(
                                hypothesis,
                                patch_hypotheses.len().max(1),
                            ))
                            .unwrap_or_else(|| {
                                "No active patch hypothesis is available; choose the highest-ranked grounded source path before editing.".to_string()
                            });
                        let refresh_msg = format!(
                            "SOURCE-LOCUS INTEL REFRESH: repeated edit path repair failed before useful source progress. Do not switch hypotheses yet. Use one exact existing source path from this packet, read it if needed, then make one minimal source-only patch.\n\n{}\n\n{}\n\nLocalization context:\n{}",
                            active_note, packet, localization_summary
                        );
                        println!("  [SOURCE-LOCUS-INTEL] action=refresh_before_hypothesis_switch");
                        conversation.push(ChatMessage {
                            role: "user".into(),
                            content: refresh_msg,
                        });
                        let from_state = current_state.clone();
                        let next_state = if definition.states.contains_key("patch_planning") {
                            "patch_planning".to_string()
                        } else {
                            implementation_state_name(&definition)
                        };
                        emit!(
                            TuiEvent::Transition {
                                from: from_state.clone(),
                                to: next_state.clone(),
                                trigger: Some("SOURCE_LOCUS_INTEL_REFRESH".into()),
                                rationale: Some(
                                    "Refresh exact source-locus packet before switching hypotheses"
                                        .into()
                                )
                            },
                            format!(
                                "  [TRANSITION] {} -> {} (source locus intel refresh)",
                                from_state, next_state
                            )
                        );
                        current_state = next_state;
                        steps_in_current_state = 0;
                        continue 'agent_loop;
                    }

                    if edit_path_argument_fail_count >= path_argument_failure_threshold()
                        && enable_patch_tournament
                        && !patch_hypotheses_exhausted
                        && path_argument_failures_should_switch_hypothesis(
                            active_clu_policy.as_ref(),
                        )
                    {
                        if let Some(next_prompt) = advance_patch_hypothesis(
                            &patch_hypotheses,
                            &mut active_patch_hypothesis_index,
                            "path_argument_failures",
                            &format!(
                                "{} consecutive unusable edit path arguments",
                                edit_path_argument_fail_count
                            ),
                        ) {
                            println!(
                                "  [PATH-REPAIR] action=restore_snapshot reason=path_argument_failures count={}",
                                edit_path_argument_fail_count
                            );
                            tools::restore_snapshot(&args.workdir);
                            modified_files.clear();
                            read_cache.clear();
                            read_paths.clear();
                            observation_cache.clear();
                            blocked_repeated_edit_fingerprints.clear();
                            same_auto_test_failure_count = 0;
                            same_test_diagnostic_required = false;
                            edit_fail_count = 0;
                            off_hypothesis_edit_count = 0;
                            edit_path_argument_fail_count = 0;
                            source_locus_intel_refresh_count = 0;
                            conversation.clear();
                            conversation.push(ChatMessage {
                                role: "user".into(),
                                content: format!(
                                    "The current patch hypothesis is stuck in low-level edit path repair, not useful source changes. Snapshot restored; use the next problem-shape hypothesis.\n\n{}\n\nLocalization context:\n{}",
                                    next_prompt, localization_summary
                                ),
                            });
                            let from_state = current_state.clone();
                            let next_state = if definition.states.contains_key("patch_planning") {
                                "patch_planning".to_string()
                            } else {
                                implementation_state_name(&definition)
                            };
                            emit!(
                                TuiEvent::Transition {
                                    from: from_state.clone(),
                                    to: next_state.clone(),
                                    trigger: Some("PATH_REPAIR_NEXT_HYPOTHESIS".into()),
                                    rationale: Some("Repeated unusable edit path arguments".into())
                                },
                                format!(
                                    "  [TRANSITION] {} -> {} (path repair next hypothesis)",
                                    from_state, next_state
                                )
                            );
                            current_state = next_state;
                            steps_in_current_state = 0;
                            continue 'agent_loop;
                        } else {
                            patch_hypotheses_exhausted = true;
                            println!(
                                "  [PATH-REPAIR] action=hypotheses_exhausted reason=path_argument_failures"
                            );
                        }
                    }

                    tool_output.push_str(&msg);
                    tool_output.push('\n');
                    continue;
                } else {
                    edit_path_argument_fail_count = 0;
                }
            }

            let writes_files = is_write_tool(tool_name);
            let targeted_paths = if writes_files {
                targeted_paths_for_tool(tool_name, tool_args, &args.workdir)
            } else {
                Vec::new()
            };
            let edit_fingerprint = if writes_files {
                edit_attempt_fingerprint(tool_name, tool_args, &targeted_paths)
            } else {
                None
            };

            if is_implementation_state(&current_state) && writes_files {
                if let Some(fingerprint) = &edit_fingerprint {
                    if blocked_repeated_edit_fingerprints.contains(fingerprint) {
                        let msg = "BLOCKED: this exact edit was already reverted after producing the same failing test signal. Inspect a different locus or make a materially different minimal edit before retrying.";
                        println!("  [REPEATED-EDIT GUARD] {}", msg);
                        tool_output.push_str(msg);
                        tool_output.push('\n');
                        continue;
                    }
                }
            }

            if same_test_diagnostic_required
                && is_implementation_state(&current_state)
                && writes_files
            {
                let msg = format!(
                    "BLOCKED: repeated edits are producing the same test failure ({} consecutive matches). Run a fresh diagnostic tool first: read_file, grep, inspect_class, find_files, or diff. Do not edit again until you inspect a different locus or the exact failing assertion.",
                    same_auto_test_failure_count
                );
                println!("  [SAME-TEST GUARD] {}", msg);
                tool_output.push_str(&msg);
                tool_output.push('\n');
                continue;
            }

            if tool_name == "edit_line" && is_implementation_state(&current_state) {
                let blocked: Vec<String> = targeted_paths
                    .iter()
                    .filter(|path| disabled_edit_line_paths.contains(*path))
                    .cloned()
                    .collect();
                if !blocked.is_empty() {
                    let msg = format!(
                        "BLOCKED: edit_line is disabled for {} after repeated stale-anchor failures. Use read_file with a tight range, then edit_block, insert_between, or apply_patch with exact current text.",
                        blocked.join(", ")
                    );
                    println!("  [STALE-ANCHOR GUARD] {}", msg);
                    tool_output.push_str(&msg);
                    tool_output.push('\n');
                    continue;
                }
            }

            if writes_files && is_implementation_state(&current_state) {
                let blocked: Vec<String> = targeted_paths
                    .iter()
                    .filter(|path| oversized_recovery_required.contains(*path))
                    .cloned()
                    .collect();
                if !blocked.is_empty() {
                    let msg = format!(
                        "BLOCKED: scoped recovery is required before more edits to {} because repeated oversized edits were reverted. Use read_file with start_line/end_line on the target function, or grep/inspect_class to find a narrower locus, then retry a minimal edit.",
                        blocked.join(", ")
                    );
                    println!("  [OVERSIZED GUARD] {}", msg);
                    tool_output.push_str(&msg);
                    tool_output.push('\n');
                    continue;
                }
            }

            if writes_files && is_implementation_state(&current_state) && profile.read_only_tests {
                let blocked_tests: Vec<String> = targeted_paths
                    .iter()
                    .filter(|path| is_test_path(path, &sw_test_files))
                    .cloned()
                    .collect();
                if !blocked_tests.is_empty() {
                    // Detect path-resolution mismatch: model asked for a non-test path
                    // (e.g. bare "models.py") but resolve_repo_path found only test files.
                    let original_path =
                        tool_args.get("path").and_then(|p| p.as_str()).unwrap_or("");
                    let resolved_to_test = !is_test_path(original_path, &sw_test_files)
                        && blocked_tests
                            .iter()
                            .all(|bt| is_test_path(bt, &sw_test_files));
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
                    test_guard_count += 1;
                    test_guard_fired_this_step = true;
                    println!("  [TEST GUARD] {} (count={})", msg, test_guard_count);
                    tool_output.push_str(&msg);
                    if test_guard_count >= 3 {
                        tool_output.push_str(
                            "\n\nYou have been blocked from editing test files 3+ times. The fix MUST be in implementation source, NOT in test files. The test file shows expected behavior; use find_files or grep to locate the code that implements it."
                        );
                    }
                    tool_output.push('\n');
                    continue;
                }
            }

            if writes_files
                && is_implementation_state(&current_state)
                && !task_explicitly_mentions_repo_localization(&args.task)
            {
                let blocked_localization: Vec<String> = targeted_paths
                    .iter()
                    .filter(|path| is_repo_localization_asset(path))
                    .cloned()
                    .collect();
                if !blocked_localization.is_empty() {
                    let msg = format!(
                        "BLOCKED: repository localization/i18n assets are unlikely edit targets for this issue. Blocked path(s): {}. These files are usually generated catalogs or translations, not the framework bug locus. Use grep/read_file/find_files to locate the source code that produces the observed behavior. If the problem statement explicitly asks for a translation/locale/catalog fix, edit the source text catalog intentionally and avoid generated binary files such as .mo.",
                        blocked_localization.join(", ")
                    );
                    println!("  [LOCALIZATION-ASSET GUARD] {}", msg);
                    tool_output.push_str(&msg);
                    tool_output.push('\n');
                    continue;
                }
            }

            if writes_files
                && is_implementation_state(&current_state)
                && enable_patch_tournament
                && !patch_hypotheses_exhausted
            {
                if let Some(active) = patch_hypotheses.get(active_patch_hypothesis_index).cloned() {
                    let active_path = normalize_problem_shape_path(&active.path);
                    let retained_candidate_paths: HashSet<String> =
                        if candidate_bank.reanchor_best_path_enabled() {
                            candidate_bank
                                .best_changed_files()
                                .iter()
                                .map(|path| normalize_problem_shape_path(path))
                                .filter(|path| !quarantined_reanchor_paths.contains(path))
                                .collect()
                        } else {
                            HashSet::new()
                        };
                    let quarantined_targets: Vec<String> = targeted_paths
                        .iter()
                        .map(|path| normalize_problem_shape_path(path))
                        .filter(|path| {
                            is_problem_shape_source_path(path)
                                && path != &active_path
                                && quarantined_reanchor_paths.contains(path)
                        })
                        .collect();
                    if !quarantined_targets.is_empty() {
                        println!(
                            "  [CANDIDATE-BANK] reanchor quarantine active for {}; treating as off-hypothesis evidence",
                            quarantined_targets.join(", ")
                        );
                    }
                    let reanchored_paths: Vec<String> = targeted_paths
                        .iter()
                        .map(|path| normalize_problem_shape_path(path))
                        .filter(|path| {
                            is_problem_shape_source_path(path)
                                && path != &active_path
                                && retained_candidate_paths.contains(path)
                        })
                        .collect();
                    if !reanchored_paths.is_empty() {
                        let msg = format!(
                            "CANDIDATE-BANK REANCHOR: edit target {} matches the retained best candidate, so it is treated as fresh candidate evidence even though active hypothesis is `{}`.",
                            reanchored_paths.join(", "),
                            active_path
                        );
                        println!("  [CANDIDATE-BANK] {}", msg);
                        tool_output.push_str(&msg);
                        tool_output.push('\n');
                        off_hypothesis_edit_count = 0;
                    }
                    let off_hypothesis: Vec<String> = targeted_paths
                        .iter()
                        .map(|path| normalize_problem_shape_path(path))
                        .filter(|path| {
                            is_problem_shape_source_path(path)
                                && path != &active_path
                                && !retained_candidate_paths.contains(path)
                        })
                        .collect();
                    if !off_hypothesis.is_empty() {
                        off_hypothesis_edit_count += 1;
                        let msg = format!(
                            "PATCH HYPOTHESIS WARNING: active hypothesis is `{}` but this edit targets {} (count={}). If this is intentional, cite the concrete evidence from read_file/grep/test output; otherwise return to the active hypothesis path and avoid stale edits from a previous attempt.",
                            active_path,
                            off_hypothesis.join(", "),
                            off_hypothesis_edit_count
                        );
                        println!("  [PATCH-HYPOTHESIS GUARD] {}", msg);
                        if off_hypothesis_edit_count >= off_hypothesis_edit_threshold() {
                            let evidenced_path = off_hypothesis.iter().find(|path| {
                                let normalized_path = normalize_problem_shape_path(path);
                                read_paths.iter().any(|read_path| {
                                    normalize_problem_shape_path(read_path) == normalized_path
                                }) || localized_file_contexts.contains_key(&normalized_path)
                                    || localized_regions.contains_key(&normalized_path)
                            });
                            if let Some(evidenced_path) = evidenced_path {
                                if let Some(next_prompt) = promote_patch_hypothesis_path(
                                    &mut patch_hypotheses,
                                    &mut active_patch_hypothesis_index,
                                    evidenced_path,
                                    "fresh off-hypothesis source evidence",
                                ) {
                                    let promote_msg = format!(
                                        "PROMOTED: repeated off-hypothesis edit target `{}` has fresh read/localization evidence. It is now the active patch hypothesis; make one minimal source edit there and do not continue the previous hypothesis unless new evidence points back.",
                                        evidenced_path
                                    );
                                    println!("  [PATCH-HYPOTHESIS GUARD] {}", promote_msg);
                                    conversation.push(ChatMessage {
                                        role: "user".into(),
                                        content: format!(
                                            "{}\n\n{}\n\nLocalization context:\n{}",
                                            promote_msg, next_prompt, localization_summary
                                        ),
                                    });
                                    let from_state = current_state.clone();
                                    let next_state =
                                        if definition.states.contains_key("patch_planning") {
                                            "patch_planning".to_string()
                                        } else {
                                            implementation_state_name(&definition)
                                        };
                                    emit!(
                                        TuiEvent::Transition {
                                            from: from_state.clone(),
                                            to: next_state.clone(),
                                            trigger: Some(
                                                "PATCH_HYPOTHESIS_PROMOTED_EVIDENCE".into()
                                            ),
                                            rationale: Some(
                                                "Repeated off-hypothesis source edit had fresh evidence".into()
                                            )
                                        },
                                        format!(
                                            "  [TRANSITION] {} -> {} (promoted off-hypothesis evidence)",
                                            from_state, next_state
                                        )
                                    );
                                    current_state = next_state;
                                    steps_in_current_state = 0;
                                    off_hypothesis_edit_count = 0;
                                    parse_repair_hypothesis_index = None;
                                    continue 'agent_loop;
                                }
                            }
                            let next_state = evidence_refresh_state_name(&definition);
                            let hard_msg = format!(
                                "BLOCKED: repeated off-hypothesis edits without a fresh-evidence transition. Active hypothesis is `{}`; blocked path(s): {}. Re-enter patch planning, cite concrete source/test evidence, then choose whether to stay on the active hypothesis or advance.",
                                active_path,
                                off_hypothesis.join(", ")
                            );
                            println!("  [PATCH-HYPOTHESIS GUARD] {}", hard_msg);
                            conversation.push(ChatMessage {
                                role: "user".into(),
                                content: format!(
                                    "{}\n\nCurrent active hypothesis:\n{}\n\nLocalization context:\n{}",
                                    hard_msg,
                                    render_patch_hypothesis_prompt(
                                        &active,
                                        patch_hypotheses.len()
                                    ),
                                    localization_summary
                                ),
                            });
                            let from_state = current_state.clone();
                            emit!(
                                TuiEvent::Transition {
                                    from: from_state.clone(),
                                    to: next_state.clone(),
                                    trigger: Some("PATCH_HYPOTHESIS_EVIDENCE_REFRESH".into()),
                                    rationale: Some("Repeated off-hypothesis edit".into())
                                },
                                format!(
                                    "  [TRANSITION] {} -> {} (patch evidence refresh)",
                                    from_state, next_state
                                )
                            );
                            current_state = next_state;
                            steps_in_current_state = 0;
                            off_hypothesis_edit_count = 0;
                            continue 'agent_loop;
                        }
                        tool_output.push_str(&msg);
                        tool_output.push('\n');
                    } else {
                        off_hypothesis_edit_count = 0;
                    }
                }
            }

            if writes_files
                && is_implementation_state(&current_state)
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
                let mut allowed_edit_paths = allowed_edit_paths;
                for path in &read_paths {
                    let normalized = norm(path);
                    if std::path::Path::new(&args.workdir)
                        .join(&normalized)
                        .is_file()
                        && !is_test_path(&normalized, &sw_test_files)
                        && !is_repo_localization_asset(&normalized)
                    {
                        allowed_edit_paths.insert(normalized);
                    }
                }
                let source_locus_focus_intel = if enable_source_locus_intel {
                    let active_patch_hypothesis =
                        if enable_patch_tournament && !patch_hypotheses_exhausted {
                            patch_hypotheses.get(active_patch_hypothesis_index)
                        } else {
                            None
                        };
                    let retained_candidate_paths = retained_candidate_source_paths(
                        &candidate_bank,
                        &quarantined_reanchor_paths,
                        true,
                    );
                    let intel = collect_source_locus_focus_intel(
                        &sw_test_files,
                        &args.workdir,
                        active_patch_hypothesis,
                        &retained_candidate_paths,
                        Some(&current_problem_shape),
                    );
                    for candidate in &intel {
                        allowed_edit_paths.insert(norm(&candidate.path));
                    }
                    intel
                } else {
                    Vec::new()
                };

                let package_adjacent: Vec<String> = targeted_paths
                    .iter()
                    .map(|path| norm(path))
                    .filter(|path| {
                        std::path::Path::new(&args.workdir).join(path).is_file()
                            && !is_test_path(path, &sw_test_files)
                            && !is_repo_localization_asset(path)
                            && locus_guard::is_package_adjacent_source(path, &allowed_edit_paths)
                    })
                    .collect();
                for path in package_adjacent {
                    println!(
                        "  [LOCUS GUARD] package-adjacent source admitted for read-before-write validation: {}",
                        path
                    );
                    allowed_edit_paths.insert(path);
                }

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
                        let intel_hint = if enable_source_locus_intel {
                            format!(
                                "\n\n{}",
                                format_source_locus_intel_packet(&source_locus_focus_intel)
                            )
                        } else {
                            String::new()
                        };
                        let msg = format!(
                            "BLOCKED: edit target is outside the localized source locus. Requested: {}. Allowed source files: {}{}",
                            outside_locus.join(", "),
                            ranked.join(", "),
                            intel_hint
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

            if causal_one_pass
                && writes_files
                && is_implementation_state(&current_state)
                && causal_repair_controller.as_ref().is_some_and(|controller| {
                    controller.state() == causal_repair::CausalState::BaselineMapped
                })
                && causal_reproducer_edit_blocks_remaining > 0
            {
                causal_reproducer_edit_blocks_remaining -= 1;
                let target = if definition.states.contains_key("hypothesizing") {
                    "hypothesizing".to_string()
                } else {
                    current_state.clone()
                };
                let message = format!(
                    "Before the first production edit, spend one bounded attempt creating an issue-specific scratch reproducer with write_task_reproducer. It must use only the issue statement and public repository behavior, import every helper it uses, and assert desired post-fix behavior rather than the reported bug or exception. If it cannot qualify, the direct-repair path remains available. Reproducer edit blocks remaining: {}.",
                    causal_reproducer_edit_blocks_remaining
                );
                println!("  [CAUSAL REPRODUCER GATE] {message}");
                conversation.push(ChatMessage {
                    role: "user".into(),
                    content: message,
                });
                current_state = target;
                steps_in_current_state = 0;
                continue 'agent_loop;
            }

            if writes_files
                && is_implementation_state(&current_state)
                && (profile.sandbox_failed_edits || causal_one_pass)
            {
                tools::snapshot_candidate(&args.workdir);
            }

            let causal_candidate_before_write = if causal_one_pass
                && writes_files
                && is_implementation_state(&current_state)
            {
                Some((
                    tools::patch_fingerprint(&args.workdir),
                    tools::all_diff_stats(&args.workdir),
                    causal_control::target_paths_fingerprint(
                        &args.workdir,
                        &targeted_paths,
                    ),
                ))
            } else {
                None
            };

            let is_edit_tool = matches!(
                tool_name.as_str(),
                "edit_line"
                    | "edit_block"
                    | "patch_file"
                    | "apply_patch"
                    | "insert_between"
                    | "write_file"
            );
            if is_edit_tool && is_implementation_state(&current_state) {
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
            let observation_cache_key =
                if !writes_files && observation::is_cacheable_tool(tool_name) {
                    Some(observation::tool_cache_key(
                        &current_state,
                        tool_name,
                        tool_args,
                    ))
                } else {
                    None
                };
            let mut result_from_observation_cache = false;

            let mut result = if let Some(cached) = observation_cache_key
                .as_ref()
                .and_then(|key| observation_cache.get(key))
            {
                result_from_observation_cache = true;
                cached.clone()
            } else if is_read && !is_ranged_read && !modified_files.contains(&read_path) {
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
                        let r =
                            execute_tool_quarantining_tests(tool_name, tool_args, &args.workdir);
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
                    let r = execute_tool_quarantining_tests(tool_name, tool_args, &args.workdir);
                    read_cache.insert(cache_key.clone(), (step, r.clone()));
                    r
                }
            } else {
                execute_tool_quarantining_tests(tool_name, tool_args, &args.workdir)
            };

            if !result_from_observation_cache && observation::is_filterable_tool(tool_name) {
                let compact = if tool_name == "run_test" {
                    Some(compact_test_telemetry(
                        &result,
                        "model-called run_test",
                        &args.model,
                    ))
                } else {
                    None
                };
                let filtered = observation_filter.filter(
                    &current_state,
                    tool_name,
                    tool_args,
                    &result,
                    compact.as_deref(),
                    causal_one_pass && tool_name == "read_file",
                );
                if filtered.filtered && !json_mode {
                    println!(
                        "  [OBSERVATION FILTER] {} raw={} displayed={} artifact={}",
                        tool_name,
                        filtered.raw_chars,
                        filtered.displayed_chars,
                        filtered.raw_artifact.as_deref().unwrap_or("<none>")
                    );
                }
                result = filtered.displayed;
                if let Some(key) = &observation_cache_key {
                    observation_cache.insert(key.clone(), result.clone());
                }
            }

            if causal_one_pass
                && matches!(
                    tool_name.as_str(),
                    "write_task_reproducer" | "run_task_reproducer"
                )
            {
                if current_state == "task_evidence_acquisition" {
                    record_post_patch_task_evidence_result(
                        &mut causal_repair_controller,
                        &mut causal_checkpoint_store,
                        &args.workdir,
                        tool_name,
                        &result,
                    );
                } else {
                    record_causal_reproducer_result(
                        &mut causal_repair_controller,
                        &mut causal_checkpoint_store,
                        &args.workdir,
                        tool_name,
                        &result,
                    );
                }
            }

            if causal_one_pass
                && current_state == "task_evidence_acquisition"
                && matches!(
                    tool_name.as_str(),
                    "write_task_reproducer" | "run_task_reproducer"
                )
            {
                let mut candidate_output = None;
                if tool_name == "write_task_reproducer"
                    && result.contains("SW_TASK_REPRODUCER_STATUS=qualified")
                {
                    let candidate_result =
                        tools::execute_tool("run_task_reproducer", &json!({}), &args.workdir);
                    record_post_patch_task_evidence_result(
                        &mut causal_repair_controller,
                        &mut causal_checkpoint_store,
                        &args.workdir,
                        "run_task_reproducer",
                        &candidate_result,
                    );
                    candidate_output = Some(candidate_result);
                }
                let evidence_output = candidate_output.as_deref().unwrap_or(&result);
                let event = task_evidence_transition_for_output(evidence_output);
                let delta = causal_task_reproducer_delta(evidence_output)
                    .map(|delta| delta.as_str())
                    .unwrap_or("unavailable");
                if let Some(candidate_result) = candidate_output {
                    result.push_str("\n[TASK_EVIDENCE_CANDIDATE_RUN]\n");
                    result.push_str(&compact_test_telemetry(
                        &candidate_result,
                        "post-patch task reproducer",
                        &args.model,
                    ));
                }
                println!(
                    "  [CAUSAL TASK-EVIDENCE] status=classified tool={} delta={} event={}",
                    tool_name, delta, event
                );
                transition_event = Some(event.to_string());
            }

            if is_read && !read_path.is_empty() && !result.starts_with("error") {
                let resolved_read = tools::resolve_repo_path(&read_path, &args.workdir);
                read_paths.insert(resolved_read.clone());
                // Explicit re-read of a modified file clears the stale-content flag so the
                // next edit attempt is not blocked by GATE (model has fresh content now).
                modified_files.remove(&resolved_read);
                if is_ranged_read && oversized_recovery_required.contains(&resolved_read) {
                    oversized_recovery_reads_this_step.push(resolved_read);
                }
            }

            if is_implementation_state(&current_state)
                && same_test_diagnostic_required
                && is_same_test_recovery_tool(tool_name)
                && is_fresh_recovery_observation(&result, result_from_observation_cache)
            {
                same_test_diagnostic_seen_this_step = true;
            }
            if is_implementation_state(&current_state)
                && !oversized_recovery_required.is_empty()
                && is_stagnation_diagnostic_tool(tool_name)
                && !result.starts_with("error")
            {
                oversized_recovery_diagnostic_seen_this_step = true;
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
                                    let lines: Vec<&str> = file_content.lines().collect();
                                    // Span from min to max localized line with ±60 line buffer
                                    let min_ln = regions.iter().map(|(l, _)| *l).min().unwrap_or(1);
                                    let max_ln = regions.iter().map(|(l, _)| *l).max().unwrap_or(1);
                                    let start = min_ln.saturating_sub(61);
                                    let end = (max_ln + 60).min(lines.len());
                                    lines[start..end].join("\n")
                                } else {
                                    let lines: Vec<&str> = file_content.lines().collect();
                                    let head = lines[..200.min(lines.len())].join("\n");
                                    let tail = lines[lines.len().saturating_sub(100)..].join("\n");
                                    format!(
                                        "{}\n...[{} lines omitted]...\n{}",
                                        head,
                                        line_count - 300,
                                        tail
                                    )
                                }
                            };
                            println!(
                                "  [LOCUS RESET] {} consecutive edit failures on {} — injecting current file content",
                                fail_n, edit_path
                            );
                            if *fail_n >= LOCUS_RESET_THRESHOLD * 2 {
                                disabled_edit_line_paths
                                    .insert(tools::resolve_repo_path(edit_path, &args.workdir));
                                // Second threshold: model is stuck in a loop despite
                                // seeing the file content.  Tell it to try a different
                                // approach entirely.
                                let candidate_ranges = build_readable_excerpt(
                                    &file_content,
                                    localized_regions.get(edit_path),
                                    old_arg,
                                );
                                result.push_str(&format!(
                                    "\n\n[LOCUS RESET] {} consecutive edit failures on {}. \
                                     You have seen the file content multiple times and still cannot match an anchor. \
                                     edit_line is now disabled for this file. {}",
                                    fail_n,
                                    edit_path,
                                    recovery::candidate_range_instruction(edit_path, &candidate_ranges)
                                ));
                            } else {
                                result.push_str(&format!(
                                    "\n\n[LOCUS RESET] {} consecutive edit failures on this file. \
                                     Your previous edits changed the file and your anchor text no longer exists. \
                                     CURRENT FILE CONTENT ({} lines):\n```\n{}\n```\n\
                                     You MUST use an exact verbatim sequence of lines from the above as your old= value. \
                                     Do NOT reconstruct from memory.",
                                    fail_n, line_count, body
                                ));
                            }
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
                let mut created_file_succeeded = false;
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
                                observation_cache.clear();
                                tool_output.push_str(&format!(
                                    "Created {} ({} bytes)\n",
                                    file_path, bytes
                                ));
                                created_file_succeeded = true;
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
                if !created_file_succeeded {
                    continue;
                }
            }

            // Track file modifications to invalidate read cache
            let is_edit = writes_files;
            let edit_succeeded = is_edit
                && !result.contains("BLOCKED")
                && !result.contains("error")
                && !result.contains("not found");
            if edit_succeeded {
                if causal_one_pass {
                    if let Some((before_fingerprint, before_stats, before_targets)) =
                        causal_candidate_before_write.as_ref()
                    {
                        let after_fingerprint = tools::patch_fingerprint(&args.workdir);
                        let after_stats = tools::all_diff_stats(&args.workdir);
                        let after_targets = causal_control::target_paths_fingerprint(
                            &args.workdir,
                            &targeted_paths,
                        );
                        if !causal_control::candidate_state_changed(
                            before_fingerprint,
                            before_stats,
                            before_targets,
                            &after_fingerprint,
                            &after_stats,
                            &after_targets,
                        ) {
                            let reason = format!(
                                "write tool reported success but produced no repository delta for {}",
                                if targeted_paths.is_empty() {
                                    "the requested target".to_string()
                                } else {
                                    targeted_paths.join(", ")
                                }
                            );
                            println!("  [CAUSAL NO-OP GUARD] REJECTED reason={reason}");
                            record_causal_event(
                                &mut causal_repair_controller,
                                causal_repair::CausalEvent::StructuralFailure {
                                    reason: reason.clone(),
                                },
                            );
                            if let Some(fingerprint) = &edit_fingerprint {
                                blocked_repeated_edit_fingerprints.insert(fingerprint.clone());
                            }
                            conversation.push(ChatMessage {
                                role: "user".into(),
                                content: format!(
                                    "The edit did not change the repository and therefore cannot advance validation: {reason}. Re-read the exact current locus and make a materially different edit."
                                ),
                            });
                            current_state = failure_triage_state_name(&definition);
                            steps_in_current_state = 0;
                            continue 'agent_loop;
                        }
                    }
                    let changed = tools::all_diff_stats(&args.workdir);
                    if let Some(reason) = causal_post_edit_guard_failure(
                        &args.workdir,
                        &changed,
                        profile.max_diff_lines,
                        &sw_test_files,
                    ) {
                        println!(
                            "  [CAUSAL POST-EDIT GUARD] REJECTED reason={reason}; restoring pre-edit candidate"
                        );
                        record_causal_event(
                            &mut causal_repair_controller,
                            causal_repair::CausalEvent::StructuralFailure {
                                reason: reason.clone(),
                            },
                        );
                        if let Some(fingerprint) = &edit_fingerprint {
                            blocked_repeated_edit_fingerprints.insert(fingerprint.clone());
                        }
                        tools::restore_candidate_snapshot(&args.workdir);
                        modified_files.clear();
                        read_cache.clear();
                        observation_cache.clear();
                        same_auto_test_failure_count = 0;
                        same_test_diagnostic_required = false;
                        edit_fail_count = 0;
                        let target = failure_triage_state_name(&definition);
                        conversation.push(ChatMessage {
                            role: "user".into(),
                            content: format!(
                                "The deterministic post-edit guard rejected and reverted this candidate before test routing: {reason}\n\nMake a smaller production-only patch that parses. Do not modify public tests."
                            ),
                        });
                        current_state = target;
                        steps_in_current_state = 0;
                        continue 'agent_loop;
                    }
                    prepare_causal_patch(
                        &mut causal_repair_controller,
                        &mut causal_checkpoint_store,
                        tools::patch_fingerprint(&args.workdir),
                    );
                    record_causal_structural_checkpoint(
                        &mut causal_repair_controller,
                        &mut causal_checkpoint_store,
                        &args.workdir,
                    );
                    if let Some(policy) = causal_serial_policy.as_mut() {
                        policy.record_valid_edit();
                    }
                }
                edit_path_argument_fail_count = 0;
                for path in &targeted_paths {
                    consecutive_locus_fails.remove(path); // reset per-file locus counter
                    modified_files.insert(path.to_string());
                    read_cache.retain(|k, _| !k.contains(path));
                    observation_cache.clear();
                    // Do NOT remove from read_paths — the model has seen this file and
                    // should be allowed to make further edits without GATE blocking.
                    // Removing here caused an infinite GATE→edit→auto-test-fail→restore→GATE cycle:
                    // restore clears modified_files but read_paths.remove already dropped the path.
                }
            }

            // Post-edit auto-test: if an edit landed in implementing, run tests immediately.
            // Count failed edit ATTEMPTS (tool returned error) for corrective hints
            let edit_tool_failed =
                is_edit && !edit_succeeded && is_implementation_state(&current_state);
            if edit_tool_failed {
                edit_fail_count += 1;
                if edit_fail_count >= 2 && persistent_hint.is_none() {
                    persistent_hint = Some("Multiple edit attempts failed. The fix might be in a different file. Try: inspect_class to check inheritance hierarchies, grep to search the codebase, or find_files to locate related files.".into());
                }
            }

            // Pass → short-circuit to completed. Fail + oversized → restore and restrict.
            'auto_test: {
                if !(edit_succeeded && is_implementation_state(&current_state)) {
                    break 'auto_test;
                }
                let mut causal_reproducer_delta_after_edit = None;
                let mut causal_reproducer_feedback_after_edit = None;
                let mut causal_reproducer_output_after_edit = None;
                let causal_has_qualified_reproducer =
                    causal_one_pass && tools::has_qualified_task_reproducer();
                if causal_has_qualified_reproducer {
                    let reproducer_result =
                        tools::execute_tool("run_task_reproducer", &json!({}), &args.workdir);
                    let delta = causal_task_reproducer_delta(&reproducer_result);
                    causal_reproducer_delta_after_edit = delta;
                    record_causal_reproducer_result(
                        &mut causal_repair_controller,
                        &mut causal_checkpoint_store,
                        &args.workdir,
                        "run_task_reproducer",
                        &reproducer_result,
                    );
                    result.push_str("\n[CAUSAL AUTO-VALIDATION]\n");
                    if let Some(delta) = delta {
                        result.push_str(&format!(
                            "Qualified task reproducer delta={}. This is causal internal evidence, not official completion. ",
                            delta.as_str()
                        ));
                        if delta == validation_oracle::TestDelta::Fixed {
                            result.push_str(
                                "Next, run a baseline-green public regression scope and audit the patch against the issue before completion.\n",
                            );
                        } else if delta == validation_oracle::TestDelta::ChangedFail {
                            result.push_str(
                                "The original reproducer failure changed, but the scratch assertion still fails. Compare the exact new failure with the public task: if the scratch assertion demands behavior the task does not require, replace it with the minimal issue invariant; otherwise repair the source. Do not treat this patch as complete.\n",
                            );
                        } else {
                            result.push_str(
                                "Keep repairing from the exact normalized failure; do not treat this patch as complete.\n",
                            );
                        }
                    } else {
                        result.push_str(
                            "Task reproducer execution produced no typed delta. This is a validation-runtime defect, not a successful or failed repair signal.\n",
                        );
                    }
                    let reproducer_feedback = compact_test_telemetry(
                        &reproducer_result,
                        "qualified task reproducer",
                        &args.model,
                    );
                    result.push_str(&reproducer_feedback);
                    causal_reproducer_feedback_after_edit = Some(reproducer_feedback);
                    causal_reproducer_output_after_edit = Some(reproducer_result);
                }
                if causal_one_pass {
                    if let Some(repair) = post_edit_source_repair_scope(
                        &args.workdir,
                        &targeted_paths,
                        &repo_file_index,
                        &args.task,
                        &args.model,
                        Some(&originals),
                    ) {
                        let assessment = record_causal_scope_validation(
                            &mut causal_repair_controller,
                            &mut causal_checkpoint_store,
                            &args.workdir,
                            &repair.scope,
                            &repair.scope_desc,
                            &repair.output,
                            &repair.changed_before_test,
                        );
                        let scope_failure_signature =
                            auto_test_failure_signature(&repair.scope, &repair.output);
                        let failure_signature = causal_control::combined_failure_signature(
                            &scope_failure_signature,
                            causal_reproducer_output_after_edit.as_deref(),
                        );
                        let has_checkpoint = causal_checkpoint_store
                            .as_ref()
                            .is_some_and(causal_checkpoint::CausalCheckpointStore::has_checkpoint);
                        let mut route = causal_serial_policy
                            .as_mut()
                            .map(|policy| {
                                policy.decide(
                                    causal_has_qualified_reproducer,
                                    causal_reproducer_delta_after_edit,
                                    assessment.signal,
                                    repair.candidate_blocking,
                                    &failure_signature,
                                    has_checkpoint,
                                )
                            })
                            .unwrap_or(causal_control::SerialRoute::Repair);
                        if route == causal_control::SerialRoute::AuditBoundedSafety {
                            let restored = causal_checkpoint_store.as_mut().is_some_and(|store| {
                                matches!(
                                    store.restore_best_for_selection(&args.workdir),
                                    causal_checkpoint::CheckpointRestore::Restored { .. }
                                        | causal_checkpoint::CheckpointRestore::AlreadySelected { .. }
                                )
                            });
                            if !restored {
                                println!(
                                    "  [CAUSAL SELECTION] bounded safety candidate restore failed; continuing repair"
                                );
                                route = causal_control::SerialRoute::Repair;
                            }
                        }
                        if route == causal_control::SerialRoute::AcquireTaskEvidence {
                            record_causal_event(
                                &mut causal_repair_controller,
                                causal_repair::CausalEvent::ValidationObserved {
                                    signal: "post_patch_task_evidence_requested".to_string(),
                                    detail: format!(
                                        "scope_signal={} checkpoint=true",
                                        assessment.signal.as_str()
                                    ),
                                },
                            );
                        }
                        let reproducer_summary = causal_reproducer_delta_after_edit
                            .map(|delta| delta.as_str())
                            .unwrap_or("not_available");
                        let reproducer_feedback = causal_reproducer_feedback_after_edit
                            .as_deref()
                            .unwrap_or("No qualified task reproducer telemetry was available.");
                        let (target, trigger, rationale, model_message) = match route {
                            causal_control::SerialRoute::AuditEfficacy => (
                                trusted_pass_state_name(&definition),
                                "CAUSAL_EFFICACY_AUDIT",
                                "Task-efficacy evidence is ready for issue audit",
                                format!(
                                    "Post-edit validation produced task-efficacy evidence. Qualified reproducer delta: {}. Source-derived signal: {}. Audit the minimal implementation against the issue before canonical evaluation; this internal evidence is not itself a SWE-bench solve.\n\n{}\n\n{}",
                                    reproducer_summary,
                                    assessment.signal.as_str(),
                                    reproducer_feedback,
                                    repair.feedback
                                ),
                            ),
                            causal_control::SerialRoute::AuditChangedFailure => (
                                trusted_pass_state_name(&definition),
                                "CAUSAL_CHANGED_FAILURE_AUDIT",
                                "The reported task failure disappeared while a stronger scratch assertion remained",
                                format!(
                                    "The qualified task reproducer no longer fails with its original issue-grounded fingerprint, and the mapped public regression scope still passes. The scratch test now fails a different model-authored assertion. Freeze the current source patch and audit it directly against the public task: approve it for canonical evaluation only if the remaining scratch assertion demands behavior the task does not establish; otherwise reject it and return to repair. This is candidate-selection evidence, not proof of a SWE-bench solve.\n\n{}\n\n{}",
                                    reproducer_feedback, repair.feedback
                                ),
                            ),
                            causal_control::SerialRoute::AcquireTaskEvidence => (
                                task_evidence_state_name(&definition),
                                "CAUSAL_TASK_EVIDENCE_ACQUIRE",
                                "A retained safety candidate gets one bounded task-evidence attempt",
                                format!(
                                    "The current source patch is structurally valid and preserves a baseline-passing public regression scope, but no issue-specific reproducer qualified before editing. Freeze the retained patch. Spend at most two turns creating one behavioral scratch reproducer from the public issue and current localization evidence; do not edit production code or repository tests. The harness will qualify it on the untouched baseline and immediately run it against this candidate. If it cannot qualify, preserve this patch and continue to audit rather than aborting or speculating.\n\n{}\n\n{}",
                                    reproducer_feedback, repair.feedback
                                ),
                            ),
                            causal_control::SerialRoute::AuditRegressionCandidate => (
                                trusted_pass_state_name(&definition),
                                "CAUSAL_REGRESSION_CANDIDATE_AUDIT",
                                "A retained candidate preserved a baseline-passing public regression scope",
                                format!(
                                    "The current source patch is structurally valid, and a mapped public regression scope that passed on the unmodified baseline still passes. No issue-specific task reproducer qualified, so task efficacy remains unproven. Freeze the source patch and audit its diff directly against the public task and existing source contracts. Approve it for canonical evaluation only if the minimal patch directly addresses the reported failure; otherwise reject it with a concrete contradiction and return to repair. Do not mutate a valid candidate merely to create additional evidence. This internal safety signal is not proof of a SWE-bench solve.\n\n{}\n\n{}",
                                    reproducer_feedback, repair.feedback
                                ),
                            ),
                            causal_control::SerialRoute::AuditBoundedSafety => (
                                trusted_pass_state_name(&definition),
                                "CAUSAL_BOUNDED_SAFETY_AUDIT",
                                "Bounded no-oracle search restored its best safe candidate",
                                format!(
                                    "The bounded no-oracle search is exhausted. The strongest retained safety candidate was restored. It has structural or regression safety evidence, not proof that the issue is fixed. Audit it directly against the issue and submit it to canonical evaluation without further speculative edits.\n\n{}\n\n{}",
                                    reproducer_feedback, repair.feedback
                                ),
                            ),
                            causal_control::SerialRoute::RefineSafety => (
                                failure_triage_state_name(&definition),
                                "CAUSAL_SAFETY_REFINE",
                                "Safety evidence retained while the current patch is extended toward task efficacy",
                                format!(
                                    "This candidate preserved a public regression or structural scope, which is safety evidence only. Keep the current patch in place, inspect the missing task behavior, and extend or correct it toward task efficacy. Do not discard already validated cumulative work or repeat the same edit.\n\n{}\n\n{}",
                                    reproducer_feedback, repair.feedback
                                ),
                            ),
                            causal_control::SerialRoute::Reset => {
                                if let Some(fingerprint) = &edit_fingerprint {
                                    blocked_repeated_edit_fingerprints.insert(fingerprint.clone());
                                }
                                tools::restore_from_snapshot(&args.workdir, &originals);
                                modified_files.clear();
                                read_cache.clear();
                                read_paths.clear();
                                observation_cache.clear();
                                (
                                    if definition.states.contains_key("hypothesizing") {
                                        "hypothesizing".to_string()
                                    } else {
                                        failure_triage_state_name(&definition)
                                    },
                                    "CAUSAL_DUPLICATE_RESET",
                                    "Repeated identical validation restored a clean hypothesis boundary",
                                    format!(
                                        "The same normalized validation failure occurred twice. The candidate was retained for final selection, and the working tree was reset. Form a different hypothesis from fresh source evidence; do not reapply the same edit.\n\n{}\n\n{}",
                                        reproducer_feedback, repair.feedback
                                    ),
                                )
                            }
                            causal_control::SerialRoute::Repair => (
                                failure_triage_state_name(&definition),
                                "CAUSAL_SOURCE_VALIDATION_REPAIR",
                                "Concrete post-edit evidence requires repair",
                                format!(
                                    "Post-edit validation did not establish task efficacy. Qualified reproducer delta: {}. Source-derived signal: {}. Repair the production patch from the concrete telemetry; do not edit tests or discard a real failing scope.\n\n{}\n\n{}",
                                    reproducer_summary,
                                    assessment.signal.as_str(),
                                    reproducer_feedback,
                                    repair.feedback
                                ),
                            ),
                        };
                        println!(
                            "  [CAUSAL SOURCE-TEST] signal={} reproducer_delta={} route={:?} -> {}",
                            assessment.signal.as_str(),
                            reproducer_summary,
                            route,
                            target
                        );
                        conversation.push(ChatMessage {
                            role: "user".into(),
                            content: model_message,
                        });
                        emit!(
                            TuiEvent::Transition {
                                from: current_state.clone(),
                                to: target.clone(),
                                trigger: Some(trigger.into()),
                                rationale: Some(rationale.into())
                            },
                            format!(
                                "  [TRANSITION] {} -> {} (causal source validation)",
                                current_state, target
                            )
                        );
                        current_state = target;
                        steps_in_current_state = 0;
                        continue 'agent_loop;
                    }
                    let scope_desc = "no source-derived public scope";
                    record_causal_validation_unavailable(
                        &mut causal_repair_controller,
                        scope_desc,
                        "no mapped public TestSpec scope after production edit",
                    );
                    let has_checkpoint = causal_checkpoint_store
                        .as_ref()
                        .is_some_and(causal_checkpoint::CausalCheckpointStore::has_checkpoint);
                    let mut route = causal_serial_policy
                        .as_mut()
                        .map(|policy| {
                            policy.decide(
                                causal_has_qualified_reproducer,
                                causal_reproducer_delta_after_edit,
                                causal_validation::CausalScopeSignal::Unavailable,
                                false,
                                scope_desc,
                                has_checkpoint,
                            )
                        })
                        .unwrap_or(causal_control::SerialRoute::Repair);
                    if route == causal_control::SerialRoute::AuditBoundedSafety {
                        let restored = causal_checkpoint_store.as_mut().is_some_and(|store| {
                            matches!(
                                store.restore_best_for_selection(&args.workdir),
                                causal_checkpoint::CheckpointRestore::Restored { .. }
                                    | causal_checkpoint::CheckpointRestore::AlreadySelected { .. }
                            )
                        });
                        if !restored {
                            route = causal_control::SerialRoute::Repair;
                        }
                    }
                    let (target, trigger, message) = match route {
                        causal_control::SerialRoute::AuditBoundedSafety => (
                            trusted_pass_state_name(&definition),
                            "CAUSAL_BOUNDED_SAFETY_AUDIT",
                            "No mapped public TestSpec scope was available. The bounded search restored its strongest structurally safe candidate. Audit it against the issue and submit it to canonical evaluation without further speculative edits.".to_string(),
                        ),
                        causal_control::SerialRoute::Reset => {
                            if let Some(fingerprint) = &edit_fingerprint {
                                blocked_repeated_edit_fingerprints.insert(fingerprint.clone());
                            }
                            tools::restore_from_snapshot(&args.workdir, &originals);
                            modified_files.clear();
                            read_cache.clear();
                            read_paths.clear();
                            observation_cache.clear();
                            (
                                if definition.states.contains_key("hypothesizing") {
                                    "hypothesizing".to_string()
                                } else {
                                    failure_triage_state_name(&definition)
                                },
                                "CAUSAL_DUPLICATE_RESET",
                                "The same unavailable validation scope repeated. The candidate was retained and the working tree reset; form a materially different issue-directed hypothesis.".to_string(),
                            )
                        }
                        _ => (
                            failure_triage_state_name(&definition),
                            "CAUSAL_SCOPE_UNAVAILABLE_REPAIR",
                            "No mapped public TestSpec scope was available after this edit. Keep the minimal patch, inspect fresh source/test evidence, and establish a task-specific check before another speculative edit.".to_string(),
                        ),
                    };
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: message,
                    });
                    emit!(
                        TuiEvent::Transition {
                            from: current_state.clone(),
                            to: target.clone(),
                            trigger: Some(trigger.into()),
                            rationale: Some(
                                "Causal controller handled missing source-derived validation"
                                    .into(),
                            )
                        },
                        format!(
                            "  [TRANSITION] {} -> {} (causal scope unavailable)",
                            current_state, target
                        )
                    );
                    current_state = target;
                    steps_in_current_state = 0;
                    continue 'agent_loop;
                }
                // Scope auto-test: prefer SW_TEST_FILES when it has been discovered
                // from safe repo-local evidence, then try tests/ near the edited file,
                // then skip unresolved large-repo feedback.
                let has_harness_scope = std::env::var("SW_TEST_FILES")
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false)
                    || std::env::var("SW_TEST_LABEL")
                        .map(|v| !v.trim().is_empty())
                        .unwrap_or(false);
                let (harness_scope, harness_scope_desc) = harness_validation_scope_from_env();
                let feedback_only_harness_scope =
                    has_harness_scope && !test_scope_env_can_complete();
                let (test_scope, test_scope_desc) = if feedback_only_harness_scope
                    && retarget_feedback_only_scope_enabled()
                {
                    if let Some((scope, desc)) = feedback_test_scope_for_sources(
                        &args.workdir,
                        &targeted_paths,
                        &repo_file_index,
                        &args.task,
                        "EDITED_SOURCE_TEST_FILES",
                    ) {
                        println!(
                            "  [AUTO-TEST] retargeted feedback-only scope from {} to {}",
                            harness_scope_desc, desc
                        );
                        (scope, desc)
                    } else {
                        (harness_scope, harness_scope_desc)
                    }
                } else if has_harness_scope {
                    (harness_scope, harness_scope_desc)
                } else if let Some(edited_path) = tool_args.get("path").and_then(|p| p.as_str()) {
                    let dir = std::path::Path::new(edited_path)
                        .parent()
                        .unwrap_or(std::path::Path::new("."));
                    let test_dir = dir.join("tests");
                    let full_test_dir = std::path::Path::new(&args.workdir).join(&test_dir);
                    if full_test_dir.is_dir() {
                        let scope = test_dir.to_string_lossy().to_string();
                        (
                            json!({"path": scope}),
                            "adjacent tests directory".to_string(),
                        )
                    } else if dir.join("test").is_dir()
                        || std::path::Path::new(&args.workdir)
                            .join(dir)
                            .join("test")
                            .is_dir()
                    {
                        let scope = dir.join("test").to_string_lossy().to_string();
                        (
                            json!({"path": scope}),
                            "adjacent test directory".to_string(),
                        )
                    } else {
                        (json!({}), "unscoped fallback".to_string())
                    }
                } else {
                    (json!({}), "unscoped fallback".to_string())
                };
                let unresolved_test_scope = test_scope.get("path").is_none()
                    && test_scope.get("file").is_none()
                    && test_scope.get("label").is_none();
                if !causal_one_pass
                    && (feedback_only_harness_scope || unresolved_test_scope)
                    && post_edit_repair_scope_enabled()
                {
                    if let Some(repair) = post_edit_source_repair_scope(
                        &args.workdir,
                        &targeted_paths,
                        &repo_file_index,
                        &args.task,
                        &args.model,
                        Some(&originals),
                    ) {
                        println!("{}", repair.feedback);
                        if repair.candidate_blocking {
                            tool_output.push_str(&format!(
                                "Source-derived repair scope failed after your edit. Fix the current patch using this concrete telemetry.\n{}\n",
                                repair.feedback
                            ));
                            edit_fail_count += 1;
                        } else {
                            let changed_after_repair = tools::all_diff_stats(&args.workdir);
                            if !changed_after_repair.is_empty() {
                                candidate_bank.record_feedback_pass_candidate(
                                    &args.workdir,
                                    &changed_after_repair,
                                    &repair.feedback,
                                    "SOURCE_SCOPE_TEST_FILES",
                                    true,
                                );
                            }
                            conversation.push(ChatMessage {
                                role: "user".into(),
                                content: format!(
                                    "Source-derived scoped tests passed after the edit. Treat this as useful feedback only; it is not proof of completion. Continue reasoning against the issue and canonical eval boundary.\n\n{}",
                                    repair.feedback
                                ),
                            });
                            let feedback_target = validation_unavailable_state_name(&definition);
                            if !deprecated_feedback_only_auto_continue_enabled()
                                || feedback_target != current_state
                            {
                                emit!(
                                    TuiEvent::Transition {
                                        from: current_state.clone(),
                                        to: feedback_target.clone(),
                                        trigger: Some("AUTO_VALIDATION_FEEDBACK_ONLY".into()),
                                        rationale: Some(
                                            "Source-derived feedback-only pass is soft validation; routing by candidate context"
                                                .into()
                                        )
                                    },
                                    format!(
                                        "  [TRANSITION] {} -> {} (source feedback-only pass)",
                                        current_state, feedback_target
                                    )
                                );
                                current_state = feedback_target;
                                steps_in_current_state = 0;
                                continue 'agent_loop;
                            }
                        }
                        break 'auto_test;
                    }
                }
                // Skip auto-test when scope is unresolved — unscoped full-suite
                // runs on large repos produce truncated output with unreliable
                // pass/fail detection (false positives in scikit-learn smoke).
                if unresolved_test_scope {
                    if causal_one_pass {
                        record_causal_validation_unavailable(
                            &mut causal_repair_controller,
                            &test_scope_desc,
                            "no resolvable TestSpec scope after production edit",
                        );
                    }
                    eprintln!("  [AUTO-TEST] no resolvable test scope — skipping");
                    let target = validation_unavailable_state_name(&definition);
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!(
                            "Auto-validation could not find a resolvable test scope after the edit. Treat this as a validation gap, not as evidence for or against the patch. Re-select a source-derived scope, build a small reproducer from the issue behavior, or continue only if this is a child speed-run candidate.\n\nEdited target(s): {}",
                            if targeted_paths.is_empty() {
                                "<unknown>".to_string()
                            } else {
                                targeted_paths.join(", ")
                            }
                        ),
                    });
                    emit!(
                        TuiEvent::Transition {
                            from: current_state.clone(),
                            to: target.clone(),
                            trigger: Some("AUTO_VALIDATION_SCOPE_UNAVAILABLE".into()),
                            rationale: Some(
                                "Auto-test had no resolvable scope; routing by candidate context"
                                    .into()
                            )
                        },
                        format!(
                            "  [TRANSITION] {} -> {} (auto validation scope unavailable)",
                            current_state, target
                        )
                    );
                    current_state = target;
                    steps_in_current_state = 0;
                    continue 'agent_loop;
                }
                let changed_before_test = tools::all_diff_stats(&args.workdir);
                let test_result = tools::execute_tool("run_test", &test_scope, &args.workdir);
                let restored_side_effects =
                    restore_tracked_test_side_effects(&args.workdir, &changed_before_test);
                if !restored_side_effects.is_empty() {
                    println!(
                        "  [TEST-SIDE-EFFECT] restored tracked file(s): {}",
                        restored_side_effects.join(", ")
                    );
                }
                let changed_after_edit = tools::all_diff_stats(&args.workdir);
                // If test runner is unavailable, skip feedback entirely — don't lie to the model
                if test_env_unavailable(&test_result) {
                    if causal_one_pass {
                        record_causal_validation_unavailable(
                            &mut causal_repair_controller,
                            &test_scope_desc,
                            "TestSpec runtime reported the test environment unavailable",
                        );
                    }
                    eprintln!(
                        "  [AUTO-TEST] test runner unavailable — routing by candidate context: {}",
                        &test_result[..test_result.len().min(200)]
                    );
                    let target = validation_unavailable_state_name(&definition);
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!(
                            "Auto-validation reported the test environment as unavailable. Treat this as invalid validation telemetry, not a pass or fail.\n\n{}",
                            compact_test_telemetry(&test_result, &test_scope_desc, &args.model)
                        ),
                    });
                    emit!(
                        TuiEvent::Transition {
                            from: current_state.clone(),
                            to: target.clone(),
                            trigger: Some("AUTO_VALIDATION_ENV_UNAVAILABLE".into()),
                            rationale: Some(
                                "Auto-test runner was unavailable; routing by candidate context"
                                    .into()
                            )
                        },
                        format!(
                            "  [TRANSITION] {} -> {} (auto validation env unavailable)",
                            current_state, target
                        )
                    );
                    current_state = target;
                    steps_in_current_state = 0;
                    continue 'agent_loop;
                }
                if untrusted_scope_must_route_unavailable(causal_one_pass, &test_result) {
                    if causal_one_pass {
                        record_causal_validation_unavailable(
                            &mut causal_repair_controller,
                            &test_scope_desc,
                            "sandbox execution marked the TestSpec scope untrusted",
                        );
                    }
                    eprintln!(
                        "  [AUTO-TEST] untrusted harness scope — routing by candidate context: {}",
                        &test_result[..test_result.len().min(200)]
                    );
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!(
                            "Harness validation scope is untrusted. A passing scoped command is not proof of a fix; use source reasoning and related in-repo tests, but do not treat this scope as solved.\n\n{}",
                            compact_test_telemetry(&test_result, &test_scope_desc, &args.model)
                        ),
                    });
                    let target = validation_unavailable_state_name(&definition);
                    emit!(
                        TuiEvent::Transition {
                            from: current_state.clone(),
                            to: target.clone(),
                            trigger: Some("AUTO_VALIDATION_SCOPE_UNTRUSTED".into()),
                            rationale: Some(
                                "Auto-test scope was untrusted; routing by candidate context"
                                    .into()
                            )
                        },
                        format!(
                            "  [TRANSITION] {} -> {} (auto validation scope untrusted)",
                            current_state, target
                        )
                    );
                    current_state = target;
                    steps_in_current_state = 0;
                    continue 'agent_loop;
                }
                if causal_one_pass && test_scope_untrusted(&test_result) {
                    println!(
                        "  [CAUSAL AUTO-TEST] preserving untrusted failure as repair feedback; it remains ineligible to certify completion"
                    );
                }
                if test_collection_failure_unrelated_to_diff(&test_result, &changed_after_edit) {
                    if causal_one_pass {
                        record_causal_validation_unavailable(
                            &mut causal_repair_controller,
                            &test_scope_desc,
                            "collection failed before reaching changed source; scope is not causal evidence",
                        );
                    }
                    let telemetry =
                        compact_test_telemetry(&test_result, &test_scope_desc, &args.model);
                    let issue_behavior = issue_behavior_checklist(&task);
                    let issue_behavior = if issue_behavior.is_empty() {
                        "No compact issue checklist was extracted; compare the source diff directly against the task description.".to_string()
                    } else {
                        issue_behavior
                    };
                    let audit_target = failure_triage_state_name(&definition);
                    if feedback_only_harness_scope {
                        println!(
                            "  [AUTO-TEST] feedback-only collection/scope failure unrelated to modified files — routing by candidate context"
                        );
                        conversation.push(ChatMessage {
                            role: "user".into(),
                            content: format!(
                                "Auto-validation hit a collection/scope failure in a feedback-only target before reaching the modified source files. Treat this as invalid harness telemetry and do not optimize the patch around it.\n\n{}\n\n{}",
                                telemetry,
                                issue_behavior
                            ),
                        });
                        let target = validation_unavailable_state_name(&definition);
                        emit!(
                            TuiEvent::Transition {
                                from: current_state.clone(),
                                to: target.clone(),
                                trigger: Some("AUTO_VALIDATION_SCOPE_INVALID".into()),
                                rationale: Some(
                                    "Feedback-only auto-test scope failed before reaching modified files; routing by candidate context"
                                        .into()
                                )
                            },
                            format!(
                                "  [TRANSITION] {} -> {} (feedback-only auto validation scope invalid)",
                                current_state, target
                            )
                        );
                        current_state = target;
                        steps_in_current_state = 0;
                        continue 'agent_loop;
                    }
                    println!(
                        "  [AUTO-TEST] collection/scope failure unrelated to modified files — routing to {}",
                        audit_target
                    );
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!(
                            "Auto-validation hit a collection/scope failure before reaching the modified source files. Treat this as invalid harness feedback, not completion evidence. Re-select or repair the validation scope, and keep the current patch only if source evidence still supports it.\n\n{}\n\n{}",
                            telemetry,
                            issue_behavior
                        ),
                    });
                    emit!(
                        TuiEvent::Transition {
                            from: current_state.clone(),
                            to: audit_target.clone(),
                            trigger: Some("AUTO_VALIDATION_SCOPE_INVALID".into()),
                            rationale: Some(
                                "Auto-test collection/scope failure was unrelated to modified files"
                                    .into()
                            )
                        },
                        format!(
                            "  [TRANSITION] {} -> {} (auto validation scope invalid)",
                            current_state, audit_target
                        )
                    );
                    current_state = audit_target;
                    steps_in_current_state = 0;
                    continue 'agent_loop;
                }
                if test_is_runner_error(&test_result) {
                    if causal_one_pass {
                        record_causal_validation_unavailable(
                            &mut causal_repair_controller,
                            &test_scope_desc,
                            "TestSpec execution did not produce a reliable pass/fail signal",
                        );
                    }
                    let exit_code = test_exit_code(&test_result);
                    match exit_code {
                        Some(5) => {
                            // No tests collected — bad test target in SW_TEST_FILES or localization
                            let file_hint = test_scope
                                .get("path")
                                .and_then(|v| v.as_str())
                                .unwrap_or(&test_scope_desc);
                            eprintln!(
                                "  [AUTO-TEST] no tests collected (exit 5) from '{}' — injecting feedback",
                                file_hint
                            );
                            conversation.push(ChatMessage {
                                role: "user".into(),
                                content: format!(
                                    "No tests were collected from '{}'. \
                                     This file does not contain pytest-discoverable test functions. \
                                     Use find_files to locate the correct test file \
                                     (basename must start with 'test_').",
                                    file_hint
                                ),
                            });
                        }
                        Some(4) => {
                            // Collection error — model's edit broke imports
                            eprintln!(
                                "  [AUTO-TEST] collection error (exit 4) — injecting feedback"
                            );
                            let error_hint: String = test_result
                                .lines()
                                .filter(|l| {
                                    l.contains("ImportError")
                                        || l.contains("ModuleNotFoundError")
                                        || l.contains("SyntaxError")
                                        || l.contains("IndentationError")
                                })
                                .take(3)
                                .collect::<Vec<_>>()
                                .join("\n");
                            conversation.push(ChatMessage {
                                role: "user".into(),
                                content: format!(
                                    "Test collection failed — your edit may have introduced an \
                                     import or syntax error:\n{}",
                                    if error_hint.is_empty() {
                                        test_result[..test_result.len().min(300)].to_string()
                                    } else {
                                        error_hint
                                    }
                                ),
                            });
                        }
                        _ => {
                            eprintln!(
                                "  [AUTO-TEST] runner error (non-zero exit, no assertions) — routing by candidate context: {}",
                                &test_result[..test_result.len().min(200)]
                            );
                            conversation.push(ChatMessage {
                                role: "user".into(),
                                content: format!(
                                    "Auto-validation could not produce a reliable pass/fail signal. Do not treat this as completion evidence.\n\n{}",
                                    compact_test_telemetry(&test_result, &test_scope_desc, &args.model)
                                ),
                            });
                        }
                    }
                    let target = validation_unavailable_state_name(&definition);
                    emit!(
                        TuiEvent::Transition {
                            from: current_state.clone(),
                            to: target.clone(),
                            trigger: Some("AUTO_VALIDATION_RUNNER_ERROR".into()),
                            rationale: Some(
                                "Auto-test runner error did not produce a reliable validation signal; routing by candidate context"
                                    .into()
                            )
                        },
                        format!(
                            "  [TRANSITION] {} -> {} (auto validation runner error)",
                            current_state, target
                        )
                    );
                    current_state = target;
                    steps_in_current_state = 0;
                    continue 'agent_loop;
                }
                if test_ran_zero_tests(&test_result) {
                    if causal_one_pass {
                        record_causal_validation_unavailable(
                            &mut causal_repair_controller,
                            &test_scope_desc,
                            "TestSpec scope collected zero tests",
                        );
                    }
                    let command = test_command_line(&test_result).unwrap_or("unknown command");
                    eprintln!(
                        "  [AUTO-TEST] zero tests ran from scoped target — injecting feedback: {}",
                        command
                    );
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!(
                            "Harness validation ran zero tests with `{}` for `{}`. Treat this as a bad test target, not success. \
                             Locate an actual test module or run a broader related test target before completing.",
                            command, test_scope_desc
                        ),
                    });
                    let target = validation_unavailable_state_name(&definition);
                    emit!(
                        TuiEvent::Transition {
                            from: current_state.clone(),
                            to: target.clone(),
                            trigger: Some("AUTO_VALIDATION_ZERO_TESTS".into()),
                            rationale: Some(
                                "Auto-test ran zero tests; routing by candidate context".into()
                            )
                        },
                        format!(
                            "  [TRANSITION] {} -> {} (auto validation zero tests)",
                            current_state, target
                        )
                    );
                    current_state = target;
                    steps_in_current_state = 0;
                    continue 'agent_loop;
                }
                let causal_scope_assessment = causal_one_pass.then(|| {
                    record_causal_scope_validation(
                        &mut causal_repair_controller,
                        &mut causal_checkpoint_store,
                        &args.workdir,
                        &test_scope,
                        &test_scope_desc,
                        &test_result,
                        &changed_before_test,
                    )
                });
                let all_pass = test_passed(&test_result);
                let changed = changed_after_edit;
                if changed.is_empty() {
                    eprintln!("  [AUTO-TEST] no diff after edit — routing by candidate context");
                    let target = validation_unavailable_state_name(&definition);
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: "Auto-validation ran after an edit tool reported success, but no source diff remains. Treat this as no-progress telemetry; make a concrete source edit or, in child fanout, leave no candidate for parent ranking.".into(),
                    });
                    emit!(
                        TuiEvent::Transition {
                            from: current_state.clone(),
                            to: target.clone(),
                            trigger: Some("AUTO_VALIDATION_NO_DIFF".into()),
                            rationale: Some(
                                "Auto-test had no remaining source diff after edit; routing by candidate context"
                                    .into()
                            )
                        },
                        format!(
                            "  [TRANSITION] {} -> {} (auto validation no diff)",
                            current_state, target
                        )
                    );
                    current_state = target;
                    steps_in_current_state = 0;
                    continue 'agent_loop;
                }
                if causal_one_pass {
                    let assessment = causal_scope_assessment
                        .as_ref()
                        .expect("causal mode records every completed sandbox test execution");
                    let pass_target = if definition.states.contains_key("completion_audit") {
                        trusted_pass_state_name(&definition)
                    } else {
                        "completed".into()
                    };
                    let (target, trigger, rationale, model_message) = if all_pass
                        && causal_post_edit_can_audit(
                            causal_has_qualified_reproducer,
                            causal_reproducer_delta_after_edit,
                            assessment.signal,
                        ) {
                        let evidence = match assessment.signal {
                            causal_validation::CausalScopeSignal::RegressionPass => {
                                "A baseline-green public regression scope remains green"
                            }
                            causal_validation::CausalScopeSignal::TaskScopeImproved => {
                                "A recorded task-related public scope improved relative to baseline"
                            }
                            causal_validation::CausalScopeSignal::StructuralPass => {
                                "The selected sandbox scope passed, but it has no recorded task baseline"
                            }
                            _ => unreachable!("pass-like causal signal was classified above"),
                        };
                        (
                            pass_target,
                            "CAUSAL_VALIDATION_AUDIT_ONLY",
                            "Causal sandbox evidence is candidate evidence only; canonical evaluator remains authoritative",
                            format!(
                                "{} after your edit. This is an internal causal observation, not a SWE-bench solve and not permission to claim success. Audit the diff against the issue now. You may submit this candidate to the canonical evaluator as a hypothesis, or continue repairing if the implementation does not satisfy the task.\n\n{}",
                                evidence,
                                compact_test_telemetry(&test_result, &test_scope_desc, &args.model)
                            ),
                        )
                    } else {
                        (
                            failure_triage_state_name(&definition),
                            "CAUSAL_VALIDATION_REPAIR",
                            "Causal sandbox observation did not preserve a usable repair trajectory",
                            format!(
                                "Causal sandbox validation produced `{}` ({}) for this candidate. This is not completion evidence. Repair from the typed observation below.\n\n{}",
                                assessment.signal.as_str(),
                                assessment.validation.decision.reason,
                                compact_test_telemetry(&test_result, &test_scope_desc, &args.model)
                            ),
                        )
                    };
                    println!(
                        "  [CAUSAL AUTO-TEST] signal={} -> {} (audit-only={})",
                        assessment.signal.as_str(),
                        target,
                        all_pass && assessment.signal.is_pass_like()
                    );
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: model_message,
                    });
                    emit!(
                        TuiEvent::Transition {
                            from: current_state.clone(),
                            to: target.clone(),
                            trigger: Some(trigger.into()),
                            rationale: Some(rationale.into())
                        },
                        format!(
                            "  [TRANSITION] {} -> {} (causal validation)",
                            current_state, target
                        )
                    );
                    current_state = target;
                    steps_in_current_state = 0;
                    continue 'agent_loop;
                }
                if all_pass {
                    let command = test_command_line(&test_result)
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "unknown command".to_string());
                    if !test_scope_can_complete(&test_result)
                        || !auto_test_pass_can_complete(&test_scope_desc)
                    {
                        println!("  [AUTO-TEST] PASS — feedback only");
                        println!("  [AUTO-TEST] command: {}", command);
                        candidate_bank.record_feedback_pass_candidate(
                            &args.workdir,
                            &changed,
                            &test_result,
                            &test_scope_desc,
                            true,
                        );
                        let issue_behavior = issue_behavior_checklist(&task);
                        let issue_behavior = if issue_behavior.is_empty() {
                            "No compact issue checklist was extracted; compare the source diff directly against the task description.".to_string()
                        } else {
                            issue_behavior
                        };
                        let telemetry =
                            compact_test_telemetry(&test_result, &test_scope_desc, &args.model);
                        let feedback_only_can_branch =
                            candidate_bank.feedback_only_branch_can_discard_current(&changed);
                        if feedback_only_pass_branch_enabled()
                            && feedback_only_can_branch
                            && enable_patch_tournament
                            && !patch_hypotheses_exhausted
                        {
                            if let Some(next_prompt) = advance_patch_hypothesis(
                                &patch_hypotheses,
                                &mut active_patch_hypothesis_index,
                                "feedback_only_auto_pass",
                                &telemetry,
                            ) {
                                println!(
                                    "  [AUTO-TEST] feedback-only pass retained; branching to next hypothesis"
                                );
                                tools::restore_snapshot(&args.workdir);
                                modified_files.clear();
                                read_cache.clear();
                                read_paths.clear();
                                observation_cache.clear();
                                last_auto_test_failure_signature = None;
                                same_auto_test_failure_count = 0;
                                same_test_diagnostic_required = false;
                                blocked_repeated_edit_fingerprints.clear();
                                edit_fail_count = 0;
                                off_hypothesis_edit_count = 0;
                                edit_path_argument_fail_count = 0;
                                conversation.clear();
                                conversation.push(ChatMessage {
                                    role: "user".into(),
                                    content: format!(
                                        "A feedback-only scoped test passed after an edit. It is useful telemetry, not completion evidence. The candidate was retained for offline selection; snapshot restored so the next problem-shape hypothesis can be tried independently.\n\n{}\n\nNext hypothesis:\n{}\n\nIssue behavior checklist:\n{}",
                                        telemetry, next_prompt, issue_behavior
                                    ),
                                });
                                let from_state = current_state.clone();
                                let next_state = if definition.states.contains_key("patch_planning")
                                {
                                    "patch_planning".to_string()
                                } else {
                                    implementation_state_name(&definition)
                                };
                                emit!(
                                    TuiEvent::Transition {
                                        from: from_state.clone(),
                                        to: next_state.clone(),
                                        trigger: Some("FEEDBACK_ONLY_AUTO_NEXT_HYPOTHESIS".into()),
                                        rationale: Some(
                                            "Feedback-only auto-test pass cannot complete; trying independent hypothesis"
                                                .into()
                                        )
                                    },
                                    format!(
                                        "  [TRANSITION] {} -> {} (feedback-only auto branch)",
                                        from_state, next_state
                                    )
                                );
                                current_state = next_state;
                                steps_in_current_state = 0;
                                continue 'agent_loop;
                            } else {
                                patch_hypotheses_exhausted = true;
                                println!(
                                    "  [AUTO-TEST] feedback-only auto branch requested but hypotheses exhausted"
                                );
                            }
                        } else if feedback_only_pass_branch_enabled() && !feedback_only_can_branch {
                            println!(
                                "  [AUTO-TEST] feedback-only auto branch suppressed; candidate is telemetry-only and not final-restorable"
                            );
                        }
                        conversation.push(ChatMessage {
                            role: "user".into(),
                            content: format!(
                                "Related scoped tests passed, but this scope is feedback-only and is not proof of completion. Preserve the current candidate only if it matches the issue behavior; otherwise keep refining from the current state. Do not complete solely because this feedback-only scope passed.\n\n{}\n\n{}",
                                telemetry,
                                issue_behavior
                            ),
                        });
                        let feedback_target = validation_unavailable_state_name(&definition);
                        if deprecated_feedback_only_auto_continue_enabled()
                            && feedback_target == current_state
                        {
                            println!(
                                "  [AUTO-TEST] feedback-only pass retained as telemetry; staying in current state"
                            );
                        } else {
                            emit!(
                                TuiEvent::Transition {
                                    from: current_state.clone(),
                                    to: feedback_target.clone(),
                                    trigger: Some("AUTO_VALIDATION_FEEDBACK_ONLY".into()),
                                    rationale: Some(
                                        "Feedback-only auto-test pass is soft validation; routing by candidate context".into()
                                    )
                                },
                                format!(
                                    "  [TRANSITION] {} -> {} (feedback-only pass)",
                                    current_state, feedback_target
                                )
                            );
                            current_state = feedback_target;
                            steps_in_current_state = 0;
                            continue 'agent_loop;
                        }
                        break 'auto_test;
                    }
                    last_auto_test_failure_signature = None;
                    same_auto_test_failure_count = 0;
                    same_test_diagnostic_required = false;
                    blocked_repeated_edit_fingerprints.clear();
                    candidate_bank.record_feedback_pass_candidate(
                        &args.workdir,
                        &changed,
                        &test_result,
                        &test_scope_desc,
                        false,
                    );
                    let diff_summary: Vec<String> = changed
                        .iter()
                        .map(|(f, c, t)| format!("{} ({}/{} lines)", f, c, t))
                        .collect();
                    let pass_target = if definition.states.contains_key("completion_audit") {
                        trusted_pass_state_name(&definition)
                    } else {
                        "completed".into()
                    };
                    println!("  [AUTO-TEST] PASS — routing to {}", pass_target);
                    println!("  [AUTO-TEST] command: {}", command);
                    println!("  Changes: {}", diff_summary.join(", "));
                    emit!(
                        TuiEvent::Transition {
                            from: current_state.clone(),
                            to: pass_target.clone(),
                            trigger: Some("AUTO_COMPLETE".into()),
                            rationale: Some("Edit + tests pass".into())
                        },
                        format!("  [TRANSITION] {} -> {} (auto)", current_state, pass_target)
                    );
                    current_state = pass_target;
                    steps_in_current_state = 0;
                    continue 'agent_loop;
                } else {
                    let patch_shape_issue = patch_shape_violation(&changed, profile.max_diff_lines);
                    let oversized = patch_shape_issue.is_some();
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
                            "test file edit".to_string()
                        } else if syntax_level_failure {
                            "syntax-level failure".to_string()
                        } else {
                            patch_shape_issue
                                .clone()
                                .unwrap_or_else(|| "oversized edit".to_string())
                        };
                        let toxic_reanchor_paths = if syntax_level_failure || oversized {
                            let changed_paths: Vec<String> =
                                changed.iter().map(|(path, _, _)| path.clone()).collect();
                            let retained_candidate_paths: HashSet<String> = candidate_bank
                                .best_changed_files()
                                .iter()
                                .map(|path| normalize_problem_shape_path(path))
                                .collect();
                            update_reanchor_quarantine_for_paths(
                                &mut reanchor_toxic_restore_counts,
                                &mut quarantined_reanchor_paths,
                                &changed_paths,
                                &retained_candidate_paths,
                                candidate_bank_reanchor_quarantine_after(),
                            )
                        } else {
                            Vec::new()
                        };
                        if !toxic_reanchor_paths.is_empty() {
                            println!(
                                "  [CANDIDATE-BANK] quarantined retained reanchor path(s) after repeated toxic restore: {}",
                                toxic_reanchor_paths.join(", ")
                            );
                        }
                        println!(
                            "  [AUTO-TEST] FAIL + {} — restoring candidate snapshot",
                            reason
                        );
                        if let Some(fingerprint) = &edit_fingerprint {
                            blocked_repeated_edit_fingerprints.insert(fingerprint.clone());
                        }
                        if oversized {
                            for (file, _, _) in changed
                                .iter()
                                .filter(|(_, c, _)| *c > profile.max_diff_lines)
                            {
                                let count =
                                    oversized_restore_counts.entry(file.clone()).or_insert(0);
                                *count += 1;
                                if *count >= recovery::OVERSIZED_RANGE_THRESHOLD {
                                    oversized_recovery_required.insert(file.clone());
                                }
                                println!(
                                    "  [OVERSIZED GUARD] {} oversized restore count={}",
                                    file, count
                                );
                            }
                        }
                        tools::restore_candidate_snapshot(&args.workdir);
                        modified_files.clear();
                        read_cache.clear();
                        observation_cache.clear();
                        // Keep read_paths — model has file content in conversation from
                        // GATE injection. Clearing causes infinite GATE→oversized→restore cycle.
                        if !toxic_reanchor_paths.is_empty()
                            && enable_patch_tournament
                            && !patch_hypotheses_exhausted
                        {
                            if let Some(next_prompt) = advance_patch_hypothesis(
                                &patch_hypotheses,
                                &mut active_patch_hypothesis_index,
                                "toxic_reanchor_restore",
                                &format!(
                                    "{} on retained reanchor path(s): {}",
                                    reason,
                                    toxic_reanchor_paths.join(", ")
                                ),
                            ) {
                                read_paths.clear();
                                same_auto_test_failure_count = 0;
                                same_test_diagnostic_required = false;
                                edit_fail_count = 0;
                                off_hypothesis_edit_count = 0;
                                edit_path_argument_fail_count = 0;
                                conversation.clear();
                                conversation.push(ChatMessage {
                                    role: "user".into(),
                                    content: format!(
                                        "The retained candidate reanchor path repeatedly produced toxic validation feedback ({}). Snapshot restored and that retained path is quarantined for reanchor; use the next problem-shape hypothesis.\n\n{}\n\nLocalization context:\n{}",
                                        toxic_reanchor_paths.join(", "),
                                        next_prompt,
                                        localization_summary
                                    ),
                                });
                                let from_state = current_state.clone();
                                let next_state = if definition.states.contains_key("patch_planning")
                                {
                                    "patch_planning".to_string()
                                } else {
                                    implementation_state_name(&definition)
                                };
                                emit!(
                                    TuiEvent::Transition {
                                        from: from_state.clone(),
                                        to: next_state.clone(),
                                        trigger: Some("TOXIC_REANCHOR_NEXT_HYPOTHESIS".into()),
                                        rationale: Some(
                                            "Repeated toxic restores on retained reanchor path"
                                                .into()
                                        )
                                    },
                                    format!(
                                        "  [TRANSITION] {} -> {} (toxic reanchor next hypothesis)",
                                        from_state, next_state
                                    )
                                );
                                current_state = next_state;
                                steps_in_current_state = 0;
                                continue 'agent_loop;
                            } else {
                                patch_hypotheses_exhausted = true;
                                println!(
                                    "  [CANDIDATE-BANK] action=hypotheses_exhausted reason=toxic_reanchor_restore"
                                );
                            }
                        }
                        let fail_detail = failure_excerpt(&test_result, 5);
                        let telemetry =
                            compact_test_telemetry(&test_result, &test_scope_desc, &args.model);
                        let recovery_hint = if oversized {
                            "\nIf this path has been reverted repeatedly, your next write will be blocked until you read a tight range around the target function."
                        } else {
                            ""
                        };
                        tool_output.push_str(&format!(
                            "Tests FAILED after your edit. The candidate patch was reverted because it was a {}.\nRejected diff: {}\n{}{}\nTry a smaller source-only edit.\n",
                            reason,
                            diff_summary.join(", "),
                            if fail_detail.is_empty() { telemetry } else { fail_detail },
                            recovery_hint
                        ));
                    } else if oversized {
                        let changed_paths: Vec<String> =
                            changed.iter().map(|(path, _, _)| path.clone()).collect();
                        let retained_candidate_paths: HashSet<String> = candidate_bank
                            .best_changed_files()
                            .iter()
                            .map(|path| normalize_problem_shape_path(path))
                            .collect();
                        let toxic_reanchor_paths = update_reanchor_quarantine_for_paths(
                            &mut reanchor_toxic_restore_counts,
                            &mut quarantined_reanchor_paths,
                            &changed_paths,
                            &retained_candidate_paths,
                            candidate_bank_reanchor_quarantine_after(),
                        );
                        if !toxic_reanchor_paths.is_empty() {
                            println!(
                                "  [CANDIDATE-BANK] quarantined retained reanchor path(s) after repeated oversized restore: {}",
                                toxic_reanchor_paths.join(", ")
                            );
                        }
                        println!(
                            "  [AUTO-TEST] FAIL + {} — restoring snapshot",
                            patch_shape_issue.as_deref().unwrap_or("oversized edit")
                        );
                        if let Some(fingerprint) = &edit_fingerprint {
                            blocked_repeated_edit_fingerprints.insert(fingerprint.clone());
                        }
                        for (file, _, _) in changed
                            .iter()
                            .filter(|(_, c, _)| *c > profile.max_diff_lines)
                        {
                            let count = oversized_restore_counts.entry(file.clone()).or_insert(0);
                            *count += 1;
                            if *count >= recovery::OVERSIZED_RANGE_THRESHOLD {
                                oversized_recovery_required.insert(file.clone());
                            }
                            println!(
                                "  [OVERSIZED GUARD] {} oversized restore count={}",
                                file, count
                            );
                        }
                        tools::restore_snapshot(&args.workdir);
                        modified_files.clear();
                        read_cache.clear();
                        // Keep read_paths — same rationale as above.
                        if !toxic_reanchor_paths.is_empty()
                            && enable_patch_tournament
                            && !patch_hypotheses_exhausted
                        {
                            if let Some(next_prompt) = advance_patch_hypothesis(
                                &patch_hypotheses,
                                &mut active_patch_hypothesis_index,
                                "toxic_reanchor_oversized_restore",
                                &format!(
                                    "oversized restore on retained reanchor path(s): {}",
                                    toxic_reanchor_paths.join(", ")
                                ),
                            ) {
                                read_paths.clear();
                                observation_cache.clear();
                                same_auto_test_failure_count = 0;
                                same_test_diagnostic_required = false;
                                edit_fail_count = 0;
                                off_hypothesis_edit_count = 0;
                                edit_path_argument_fail_count = 0;
                                conversation.clear();
                                conversation.push(ChatMessage {
                                    role: "user".into(),
                                    content: format!(
                                        "The retained candidate reanchor path repeatedly produced oversized restores ({}). Snapshot restored and that retained path is quarantined for reanchor; use the next problem-shape hypothesis.\n\n{}\n\nLocalization context:\n{}",
                                        toxic_reanchor_paths.join(", "),
                                        next_prompt,
                                        localization_summary
                                    ),
                                });
                                let from_state = current_state.clone();
                                let next_state = if definition.states.contains_key("patch_planning")
                                {
                                    "patch_planning".to_string()
                                } else {
                                    implementation_state_name(&definition)
                                };
                                emit!(
                                    TuiEvent::Transition {
                                        from: from_state.clone(),
                                        to: next_state.clone(),
                                        trigger: Some("TOXIC_REANCHOR_NEXT_HYPOTHESIS".into()),
                                        rationale: Some(
                                            "Repeated oversized restores on retained reanchor path"
                                                .into()
                                        )
                                    },
                                    format!(
                                        "  [TRANSITION] {} -> {} (toxic reanchor next hypothesis)",
                                        from_state, next_state
                                    )
                                );
                                current_state = next_state;
                                steps_in_current_state = 0;
                                continue 'agent_loop;
                            } else {
                                patch_hypotheses_exhausted = true;
                                println!(
                                    "  [CANDIDATE-BANK] action=hypotheses_exhausted reason=toxic_reanchor_oversized_restore"
                                );
                            }
                        }
                        tool_output.push_str(&format!(
                            "Tests FAILED and your edit had an invalid patch shape ({}). Snapshot restored. Use a smaller, targeted change. After repeated oversized restores on the same path, further edits are blocked until you re-read a tight target range.\n",
                            patch_shape_issue
                                .as_deref()
                                .unwrap_or("oversized edit")
                        ));
                    } else {
                        // Small edit, tests failed — keep the edit, let model iterate
                        println!("  [AUTO-TEST] FAIL — edit kept, model can refine");
                        let signature = auto_test_failure_signature(&test_scope, &test_result);
                        if last_auto_test_failure_signature.as_deref() == Some(signature.as_str()) {
                            same_auto_test_failure_count += 1;
                        } else {
                            last_auto_test_failure_signature = Some(signature);
                            same_auto_test_failure_count = 1;
                        }
                        let stagnation_hint = recovery::plateau_hint(same_auto_test_failure_count);
                        let repeated_failure_hard =
                            same_auto_test_failure_count >= recovery::TEST_PLATEAU_HARD_THRESHOLD;
                        if repeated_failure_hard {
                            same_test_diagnostic_required = true;
                        }
                        let fail_detail =
                            compact_test_telemetry(&test_result, &test_scope_desc, &args.model);
                        if feedback_only_harness_scope {
                            println!(
                                "  [CANDIDATE-BANK] skipped feedback-only failed candidate retention"
                            );
                        } else {
                            candidate_bank.record_failed_candidate(
                                &args.workdir,
                                &changed,
                                &test_result,
                                &test_scope_desc,
                                same_auto_test_failure_count,
                            );
                        }
                        let hint = if edit_fail_count >= 2 {
                            "\n\nYou've made multiple failed attempts. The fix might be in a different file. Try: inspect_class to check inheritance hierarchies, grep to search the codebase, or find_files to locate related files."
                        } else {
                            ""
                        };
                        if repeated_failure_hard && profile.sandbox_failed_edits {
                            if enable_patch_tournament && !patch_hypotheses_exhausted {
                                if let Some(next_prompt) = advance_patch_hypothesis(
                                    &patch_hypotheses,
                                    &mut active_patch_hypothesis_index,
                                    "same_test_signature",
                                    &fail_detail,
                                ) {
                                    println!(
                                        "  [SAME-TEST GUARD] repeated failure signature - restoring candidate snapshot and advancing hypothesis"
                                    );
                                    if let Some(fingerprint) = &edit_fingerprint {
                                        blocked_repeated_edit_fingerprints
                                            .insert(fingerprint.clone());
                                    }
                                    tools::restore_candidate_snapshot(&args.workdir);
                                    modified_files.clear();
                                    read_cache.clear();
                                    read_paths.clear();
                                    observation_cache.clear();
                                    same_auto_test_failure_count = 0;
                                    same_test_diagnostic_required = false;
                                    edit_fail_count = 0;
                                    off_hypothesis_edit_count = 0;
                                    edit_path_argument_fail_count = 0;
                                    conversation.clear();
                                    conversation.push(ChatMessage {
                                        role: "user".into(),
                                        content: format!(
                                            "Previous patch hypothesis stagnated under canonical harness feedback. Restore complete; use the next problem-shape hypothesis.\n\n{}\n\nLast failure telemetry:\n{}",
                                            next_prompt, fail_detail
                                        ),
                                    });
                                    let from_state = current_state.clone();
                                    let next_state =
                                        if definition.states.contains_key("patch_planning") {
                                            "patch_planning".to_string()
                                        } else {
                                            implementation_state_name(&definition)
                                        };
                                    emit!(
                                        TuiEvent::Transition {
                                            from: from_state.clone(),
                                            to: next_state.clone(),
                                            trigger: Some("STAGNATION_NEXT_HYPOTHESIS".into()),
                                            rationale: Some(
                                                "Repeated identical test failure".into()
                                            )
                                        },
                                        format!(
                                            "  [TRANSITION] {} -> {} (next hypothesis)",
                                            from_state, next_state
                                        )
                                    );
                                    current_state = next_state;
                                    steps_in_current_state = 0;
                                    continue 'agent_loop;
                                } else {
                                    patch_hypotheses_exhausted = true;
                                    println!(
                                        "  [STAGNATION] action=hypotheses_exhausted reason=same_test_signature"
                                    );
                                }
                            }
                            println!(
                                "  [SAME-TEST GUARD] repeated failure signature - restoring candidate snapshot and replanning"
                            );
                            if let Some(fingerprint) = &edit_fingerprint {
                                blocked_repeated_edit_fingerprints.insert(fingerprint.clone());
                            }
                            tools::restore_candidate_snapshot(&args.workdir);
                            modified_files.clear();
                            read_cache.clear();
                            observation_cache.clear();
                            let replan_state = if definition.states.contains_key("failure_triage") {
                                failure_triage_state_name(&definition)
                            } else if definition.states.contains_key("patch_planning") {
                                "patch_planning".to_string()
                            } else {
                                implementation_state_name(&definition)
                            };
                            conversation.push(ChatMessage {
                                role: "user".into(),
                                content: format!(
                                    "Repeated identical harness feedback means the current patch path is stale. The latest candidate was reverted.\n\nRejected diff: {}\n\nLast failure telemetry:\n{}\n{}{}\n\nCourse correction: inspect fresh source/test evidence, choose a narrower locus or a different hypothesis, and do not repeat the same edit.",
                                    diff_summary.join(", "),
                                    fail_detail,
                                    hint,
                                    stagnation_hint
                                ),
                            });
                            same_auto_test_failure_count = 0;
                            same_test_diagnostic_required = false;
                            edit_fail_count = 0;
                            off_hypothesis_edit_count = 0;
                            edit_path_argument_fail_count = 0;
                            let from_state = current_state.clone();
                            emit!(
                                TuiEvent::Transition {
                                    from: from_state.clone(),
                                    to: replan_state.clone(),
                                    trigger: Some("SAME_TEST_REPLAN".into()),
                                    rationale: Some(
                                        "Repeated identical test failure without remaining patch hypothesis"
                                            .into()
                                    )
                                },
                                format!(
                                    "  [TRANSITION] {} -> {} (same-test replan)",
                                    from_state, replan_state
                                )
                            );
                            current_state = replan_state;
                            steps_in_current_state = 0;
                            continue 'agent_loop;
                        } else {
                            tool_output.push_str(&format!(
                                "Tests FAILED after your edit. Fix the remaining issue.\n{}{}{}\n",
                                fail_detail, hint, stagnation_hint
                            ));
                        }
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

        if !tool_output.is_empty() || !protocol_call_spans.is_empty() {
            let plain_content = format!("Tool results:\n{}", tool_output);
            let protocol_tool_results: Vec<ToolResultMessage> = protocol_call_spans
                .iter()
                .enumerate()
                .map(|(index, (name, call_id, start))| {
                    let end = protocol_call_spans
                        .get(index + 1)
                        .map(|(_, _, next_start)| *next_start)
                        .unwrap_or(tool_output.len());
                    let content = tool_output[*start..end].trim().to_string();
                    ToolResultMessage {
                        name: name.clone(),
                        call_id: call_id.clone(),
                        content: if content.is_empty() {
                            "Tool call accepted; no textual result.".into()
                        } else {
                            content
                        },
                    }
                })
                .collect();
            if protocol_tool_results.is_empty() {
                conversation.push(ChatMessage {
                    role: "user".into(),
                    content: plain_content,
                });
            } else {
                conversation.push_tool_results(plain_content, &protocol_tool_results);
            }
        }
        if same_test_diagnostic_seen_this_step {
            println!("  [SAME-TEST GUARD] diagnostic observed; edits may resume next turn");
            same_test_diagnostic_required = false;
            same_auto_test_failure_count = same_auto_test_failure_count.saturating_sub(1);
        }
        for path in oversized_recovery_reads_this_step {
            println!(
                "  [OVERSIZED GUARD] scoped read observed for {}; edits may resume next turn",
                path
            );
            oversized_recovery_required.remove(&path);
        }
        if oversized_recovery_diagnostic_seen_this_step && !oversized_recovery_required.is_empty() {
            println!("  [OVERSIZED GUARD] diagnostic observed; edits may resume next turn");
            oversized_recovery_required.clear();
        }

        // Escalation: also count non-edit implementing steps as stalls.
        // Exception: a step where GATE fired (blocking an edit and injecting content)
        // is not a stall — the model had a valid edit attempt and received content to work with.
        // Similarly, a step that fired GATE in the previous step (model legitimately reading
        // before re-editing) is not a stall.
        if is_implementation_state(&current_state) {
            let any_edit_this_step = tool_calls_to_process
                .iter()
                .any(|call| is_write_tool(&call.name));
            let gate_exemption = gate_fired_this_step; // this step's GATE block
            gate_fired_this_step = false; // reset for next step
            if !test_guard_fired_this_step {
                test_guard_count = 0; // reset when model does productive work
            }
            test_guard_fired_this_step = false;
            if !any_edit_this_step && !gate_exemption {
                edit_fail_count += 1;
            }
            // Unified escalation check (fires from both auto-test failures and stalls)
            // Thresholds are intentionally high: model needs 5+ attempts to use GATE-injected
            // candidate loci from error messages before we wipe and restart.
            let hypothesis_reset_threshold = if attempt_packet_reset {
                no_progress_hypothesis_threshold(
                    active_clu_policy.as_ref(),
                    no_progress_reset_threshold,
                )
            } else {
                5
            };
            if edit_fail_count >= hypothesis_reset_threshold
                && enable_patch_tournament
                && !patch_hypotheses_exhausted
            {
                if edit_fail_count >= candidate_bank.early_stop_fail_count() {
                    let current_changed = tools::all_diff_stats(&args.workdir);
                    if candidate_bank.restore_best_for_stagnation(
                        &args.workdir,
                        &current_changed,
                        "no_progress",
                    ) {
                        modified_files.clear();
                        read_cache.clear();
                        read_paths.clear();
                        observation_cache.clear();
                        println!(
                            "  [CANDIDATE-BANK] early stop after no-progress; final verification will grade retained candidate"
                        );
                        break 'agent_loop;
                    }
                }
                if let Some(next_prompt) = advance_patch_hypothesis(
                    &patch_hypotheses,
                    &mut active_patch_hypothesis_index,
                    "no_progress",
                    &format!("edit_fail_count={}", edit_fail_count),
                ) {
                    println!(
                        "  [STAGNATION] action=restore_snapshot reason=no_progress fail_count={}",
                        edit_fail_count
                    );
                    tools::restore_snapshot(&args.workdir);
                    modified_files.clear();
                    read_cache.clear();
                    read_paths.clear();
                    observation_cache.clear();
                    blocked_repeated_edit_fingerprints.clear();
                    same_auto_test_failure_count = 0;
                    same_test_diagnostic_required = false;
                    edit_fail_count = 0;
                    off_hypothesis_edit_count = 0;
                    edit_path_argument_fail_count = 0;
                    consecutive_parse_failures = 0;
                    persistent_hint = None;
                    conversation.clear();
                    conversation.push(ChatMessage {
                        role: "user".into(),
                        content: format!(
                            "The current patch hypothesis has made no progress. Snapshot restored; use the next problem-shape hypothesis.\n\n{}\n\nLocalization context:\n{}",
                            next_prompt, localization_summary
                        ),
                    });
                    let from_state = current_state.clone();
                    let next_state = if definition.states.contains_key("patch_planning") {
                        "patch_planning".to_string()
                    } else {
                        implementation_state_name(&definition)
                    };
                    emit!(
                        TuiEvent::Transition {
                            from: from_state.clone(),
                            to: next_state.clone(),
                            trigger: Some("STAGNATION_NEXT_HYPOTHESIS".into()),
                            rationale: Some("No-progress implementation loop".into())
                        },
                        format!(
                            "  [TRANSITION] {} -> {} (next hypothesis)",
                            from_state, next_state
                        )
                    );
                    current_state = next_state;
                    steps_in_current_state = 0;
                    continue 'agent_loop;
                } else {
                    patch_hypotheses_exhausted = true;
                    println!("  [STAGNATION] action=hypotheses_exhausted reason=no_progress");
                    if !localization_summary.is_empty() {
                        conversation.push(ChatMessage {
                            role: "user".into(),
                            content: format!(
                                "All problem-shape patch hypotheses are exhausted. Stop repeating stale edits. Re-read the failing command output and either refine the current source diff using concrete evidence or inspect a new source locus from the localization context.

Localization context:
{}",
                                localization_summary
                            ),
                        });
                    }
                }
            }
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
                if causal_one_pass {
                    println!(
                        "  [CAUSAL_REPAIR] model escalation preserves the current serial candidate"
                    );
                } else {
                    tools::restore_snapshot(&args.workdir);
                }
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

            if task_evidence_fail_must_audit(causal_one_pass, &current_state, event) {
                let target = trusted_pass_state_name(&definition);
                record_causal_event(
                    &mut causal_repair_controller,
                    causal_repair::CausalEvent::ValidationObserved {
                        signal: "post_patch_task_evidence_declined".to_string(),
                        detail: "model emitted FAIL during bounded evidence acquisition"
                            .to_string(),
                    },
                );
                conversation.push(ChatMessage {
                    role: "user".into(),
                    content: "Task-evidence acquisition was declined. Preserve the retained candidate and audit it directly; inability to create a scratch reproducer is not an agent abort and is not efficacy evidence.".into(),
                });
                emit!(
                    TuiEvent::Transition {
                        from: current_state.clone(),
                        to: target.clone(),
                        trigger: Some("TASK_EVIDENCE_DECLINED".into()),
                        rationale: Some(
                            "No-oracle evidence acquisition falls through to retained-patch audit"
                                .into()
                        )
                    },
                    format!(
                        "  [TRANSITION] {} -> {} (task evidence declined)",
                        current_state, target
                    )
                );
                current_state = target;
                steps_in_current_state = 0;
                continue;
            }

            if event == "FAIL" {
                // Intercept FAIL: escalate instead of giving up if escalation is available
                if !causal_one_pass && !escalated_model {
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
                    if is_implementation_state(&result.new_state) {
                        tools::snapshot_files(&args.workdir);
                        println!("  [SNAPSHOT] Working directory snapshotted");
                    }

                    // PROGRAMMATIC EDIT GATE: block transition from implementing if nothing was edited.
                    // This is a hard constraint, not a prompt suggestion.
                    if is_implementation_state(&current_state) {
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
                    if is_implementation_state(&current_state) {
                        let mut rejected = false;
                        let changed_files = tools::all_diff_stats(&args.workdir);

                        for (file, changed, total) in &changed_files {
                            println!("  [DIFF] {} — {}/{} lines changed", file, changed, total);
                        }

                        if let Some(reason) =
                            patch_shape_violation(&changed_files, profile.max_diff_lines)
                        {
                            println!(
                                "  [MINIMIZER] REJECTED — {}. Restoring and retrying.",
                                reason
                            );
                            if causal_one_pass {
                                record_causal_event(
                                    &mut causal_repair_controller,
                                    causal_repair::CausalEvent::StructuralFailure {
                                        reason: format!(
                                            "patch-shape minimizer rejected candidate: {}",
                                            reason
                                        ),
                                    },
                                );
                            }
                            tools::restore_snapshot(&args.workdir);
                            rejected = true;

                            let diff_detail = changed_files
                                .first()
                                .map(|(file, _, _)| {
                                    tools::execute_tool(
                                        "diff",
                                        &json!({"path": file}),
                                        &args.workdir,
                                    )
                                })
                                .unwrap_or_else(|| "<no diff detail available>".to_string());

                            conversation.push(ChatMessage {
                                role: "user".into(),
                                content: format!(
                                    "Your change was REJECTED because it has an invalid patch shape: {}. \
                                    The file set has been restored to the original. Diff excerpt:\n{}\n\n\
                                    Try again. Change ONLY the line(s) with the bug. Do NOT rename variables, \
                                    remove comments, delete files, or rewrite working functions.",
                                    reason, diff_detail
                                ),
                            });
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

    // Final verification — use optional SW_TEST_FILES only when safe scope was
    // discovered. Otherwise run the harness command and let post-solve SWE-bench
    // eval provide canonical grading.
    println!("\n--- Final Verification ---");
    if candidate_bank.is_enabled() {
        let current_changed = tools::all_diff_stats(&args.workdir);
        if candidate_bank.restore_best_before_final(&args.workdir, &current_changed) {
            if selected_fanout_validation.take().is_some() {
                println!(
                    "[VALIDATION_PROVENANCE] invalidated reason=candidate_bank_restored_different_patch"
                );
            }
            modified_files.clear();
        }
    }
    if causal_one_pass {
        if let Some(checkpoints) = causal_checkpoint_store.as_mut() {
            match checkpoints.restore_best_before_final(&args.workdir) {
                causal_checkpoint::CheckpointRestore::Restored { fingerprint } => {
                    println!("[CAUSAL_CHECKPOINT] restored fingerprint={fingerprint}");
                    record_causal_event(
                        &mut causal_repair_controller,
                        causal_repair::CausalEvent::ValidationObserved {
                            signal: "checkpoint_restored".to_string(),
                            detail: format!(
                                "restored best evidence-backed candidate fingerprint={fingerprint}"
                            ),
                        },
                    );
                }
                causal_checkpoint::CheckpointRestore::AlreadySelected { fingerprint } => {
                    println!("[CAUSAL_CHECKPOINT] already_selected fingerprint={fingerprint}");
                }
                causal_checkpoint::CheckpointRestore::NoCheckpoint => {
                    println!("[CAUSAL_CHECKPOINT] no_evidence_backed_candidate");
                }
                causal_checkpoint::CheckpointRestore::Skipped { reason } => {
                    println!("[CAUSAL_CHECKPOINT] restore_skipped reason={reason}");
                }
            }
        }
        record_causal_event(
            &mut causal_repair_controller,
            causal_repair::CausalEvent::Freeze {
                reason: "repair trajectory ended; current diff is submitted to the canonical evaluator without internal promotion".to_string(),
            },
        );
        let git_diff_empty = std::process::Command::new("git")
            .args(["diff", "--quiet"])
            .current_dir(&args.workdir)
            .status()
            .map(|status| status.success())
            .unwrap_or(true);
        println!("[CAUSAL_REPAIR] patch frozen; no duplicate local final verdict will be emitted");
        if git_diff_empty {
            println!(
                "[INTERNAL_VALIDATION] no candidate diff; canonical post-solve evaluator will record the unresolved outcome"
            );
        } else {
            println!(
                "[INTERNAL_VALIDATION] causal repair evidence is complete; canonical post-solve evaluator is the sole outcome authority"
            );
        }
        return;
    }
    let (env_final_test_scope, env_final_scope_desc) = harness_validation_scope_from_env();
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
    let changed_source_paths: Vec<String> = tools::all_diff_stats(&args.workdir)
        .into_iter()
        .map(|(path, _, _)| path)
        .filter(|path| !is_test_path(path, &sw_test_files))
        .collect();
    if let Some(repair) = post_edit_source_repair_scope(
        &args.workdir,
        &changed_source_paths,
        &repo_file_index,
        &args.task,
        &args.model,
        Some(&originals),
    ) {
        println!("{}", repair.feedback);
        if repair.candidate_blocking {
            println!("[FINAL_VERIFICATION] FAIL");
            println!(
                "[FINAL_VERIFICATION] source-derived repair scope found a concrete patch failure"
            );
            return;
        }
    }
    let final_scope_env_can_complete = test_scope_env_can_complete();
    let (final_test_scope, final_scope_desc) =
        if let Some(provenance) = selected_fanout_validation.as_ref() {
            println!(
                "[VALIDATION_PROVENANCE] selected candidate={} role={} prior_signal={} scope={}",
                provenance.candidate_id,
                provenance.scope_role,
                provenance.signal,
                provenance.scope_desc
            );
            (
                provenance.scope.clone(),
                format!("SELECTED_CANDIDATE_SCOPE={}", provenance.scope_desc),
            )
        } else if !final_scope_env_can_complete && retarget_feedback_only_scope_enabled() {
            if let Some((scope, desc)) = feedback_test_scope_for_sources(
                &args.workdir,
                &changed_source_paths,
                &repo_file_index,
                &args.task,
                "EDITED_SOURCE_TEST_FILES",
            ) {
                println!(
                    "[FINAL_VERIFICATION] retargeted feedback-only scope from {} to {}",
                    env_final_scope_desc, desc
                );
                (scope, desc)
            } else {
                (env_final_test_scope, env_final_scope_desc)
            }
        } else {
            (env_final_test_scope, env_final_scope_desc)
        };
    if final_scope_desc == "unscoped harness command"
        && final_test_scope.get("path").is_none()
        && final_test_scope.get("file").is_none()
    {
        println!("[FINAL_VERIFICATION] UNAVAILABLE");
        println!(
            "[FINAL_VERIFICATION] no safe scoped harness target; canonical post-solve eval required"
        );
        return;
    }
    let changed_before_test = tools::all_diff_stats(&args.workdir);
    let test_result = tools::execute_tool("run_test", &final_test_scope, &args.workdir);
    let restored_side_effects =
        restore_tracked_test_side_effects(&args.workdir, &changed_before_test);
    if !restored_side_effects.is_empty() {
        println!(
            "[TEST-SIDE-EFFECT] restored tracked file(s): {}",
            restored_side_effects.join(", ")
        );
    }
    if let Some(provenance) = selected_fanout_validation.as_ref() {
        let assessment = candidate_validation::assess_against_baseline(
            &test_result,
            &changed_before_test,
            &provenance.baseline_keys,
            provenance.baseline.as_ref(),
        );
        if let Some(command) = test_command_line(&test_result) {
            println!("[FINAL_VERIFICATION] command: {}", command);
        }
        println!(
            "[VALIDATION_PROVENANCE] revalidated candidate={} role={} prior_signal={} signal={} kind={} trust={} blocking={} scope={}",
            provenance.candidate_id,
            provenance.scope_role,
            provenance.signal,
            assessment.signal,
            assessment.kind.as_str(),
            assessment.decision.trust_tier.as_str(),
            assessment.decision.candidate_blocking,
            provenance.scope_desc
        );
        match assessment.signal.as_str() {
            "source_scope_pass" => {
                println!("[FINAL_VERIFICATION] PASS");
                println!(
                    "[SUCCESS] Selected candidate repaired a recorded baseline failure; canonical evaluation still decides the benchmark outcome."
                );
            }
            "fail" => {
                println!("[FINAL_VERIFICATION] FAIL");
                let telemetry =
                    compact_test_telemetry(&test_result, &final_scope_desc, &args.model);
                for line in telemetry.lines() {
                    println!("  {}", line);
                }
            }
            _ => {
                println!("[FINAL_VERIFICATION] UNAVAILABLE");
                println!(
                    "[FINAL_VERIFICATION] selected candidate has regression-only or unavailable evidence; canonical evaluation required"
                );
            }
        }
    } else if test_env_unavailable(&test_result) {
        println!("[FINAL_VERIFICATION] UNAVAILABLE");
    } else if test_scope_untrusted(&test_result) {
        if let Some(command) = test_command_line(&test_result) {
            println!("[FINAL_VERIFICATION] command: {}", command);
        }
        println!("[FINAL_VERIFICATION] UNAVAILABLE");
        println!("[FINAL_VERIFICATION] untrusted harness scope");
    } else if !final_scope_env_can_complete {
        if let Some(command) = test_command_line(&test_result) {
            println!("[FINAL_VERIFICATION] command: {}", command);
        }
        if !test_passed(&test_result) {
            let telemetry = compact_test_telemetry(&test_result, &final_scope_desc, &args.model);
            if test_has_patch_blocking_collection_failure(&test_result) {
                if feedback_only_collection_failure_should_be_unavailable(
                    &test_result,
                    &changed_before_test,
                ) {
                    println!("[FINAL_VERIFICATION] UNAVAILABLE");
                    println!(
                        "[FINAL_VERIFICATION] feedback-only harness scope hit unrelated collection/import noise; canonical post-solve eval required"
                    );
                    for line in telemetry.lines() {
                        println!("  {}", line);
                    }
                    return;
                }
                println!("[FINAL_VERIFICATION] FAIL");
                println!(
                    "[FINAL_VERIFICATION] feedback-only harness scope found a patch-blocking collection or syntax failure"
                );
                for line in telemetry.lines() {
                    println!("  {}", line);
                }
                return;
            }
            println!("[FINAL_VERIFICATION] UNAVAILABLE");
            println!(
                "[FINAL_VERIFICATION] feedback-only harness scope; canonical post-solve eval required"
            );
            for line in telemetry.lines() {
                println!("  {}", line);
            }
        } else {
            println!("[FINAL_VERIFICATION] UNAVAILABLE");
            println!(
                "[FINAL_VERIFICATION] feedback-only harness scope; canonical post-solve eval required"
            );
        }
    } else if test_passed(&test_result) && !test_scope_can_complete(&test_result) {
        if let Some(command) = test_command_line(&test_result) {
            println!("[FINAL_VERIFICATION] command: {}", command);
        }
        println!("[FINAL_VERIFICATION] UNAVAILABLE");
        println!(
            "[FINAL_VERIFICATION] scoped tests passed, but this discovered scope is not proof of completion"
        );
    } else if test_passed(&test_result) {
        if let Some(command) = test_command_line(&test_result) {
            println!("[FINAL_VERIFICATION] command: {}", command);
        }
        println!("[FINAL_VERIFICATION] PASS");
        println!("[SUCCESS] All tests pass!");
    } else {
        println!("[FINAL_VERIFICATION] FAIL");
        if let Some(command) = test_command_line(&test_result) {
            println!("[FINAL_VERIFICATION] command: {}", command);
        }
        if test_ran_zero_tests(&test_result) {
            println!("[FINAL_VERIFICATION] zero tests ran; scoped validation target is invalid");
        }
        let telemetry = compact_test_telemetry(&test_result, &final_scope_desc, &args.model);
        for line in telemetry.lines() {
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

fn normalize_tool_args(value: Option<&serde_json::Value>) -> serde_json::Value {
    match value {
        Some(serde_json::Value::String(raw)) => serde_json::from_str::<serde_json::Value>(raw)
            .unwrap_or_else(|_| serde_json::Value::String(raw.clone())),
        Some(value) => value.clone(),
        None => json!({}),
    }
}

fn tool_call_from_value(item: &serde_json::Value) -> Option<ToolCallRequest> {
    if let Some(function) = item.get("function") {
        let name = function.get("name")?.as_str()?.to_string();
        let args = normalize_tool_args(
            function
                .get("arguments")
                .or_else(|| function.get("args"))
                .or_else(|| function.get("input"))
                .or_else(|| function.get("parameters")),
        );
        return Some(ToolCallRequest { name, args });
    }

    let name = item
        .get("name")
        .or_else(|| item.get("tool"))
        .or_else(|| item.get("tool_name"))
        .and_then(|name| name.as_str())?
        .to_string();
    let args = normalize_tool_args(
        item.get("args")
            .or_else(|| item.get("arguments"))
            .or_else(|| item.get("input"))
            .or_else(|| item.get("parameters")),
    );
    Some(ToolCallRequest { name, args })
}

fn transition_from_value(value: &serde_json::Value) -> Option<String> {
    value
        .as_str()
        .map(|s| s.to_string())
        .or_else(|| {
            value
                .get("name")
                .and_then(|name| name.as_str())
                .map(|s| s.to_string())
        })
        .or_else(|| {
            value
                .get("event")
                .and_then(|event| event.as_str())
                .map(|s| s.to_string())
        })
}

fn response_from_json_value(value: &serde_json::Value) -> Option<LlmResponse> {
    let obj = value.as_object()?;
    let mut transition = obj.get("transition").and_then(transition_from_value);
    let error = obj
        .get("error")
        .and_then(|error| error.as_str())
        .map(|s| s.to_string());

    let mut tool_calls: Vec<ToolCallRequest> = obj
        .get("tool_calls")
        .and_then(|calls| calls.as_array())
        .map(|calls| calls.iter().filter_map(tool_call_from_value).collect())
        .unwrap_or_default();

    if let Some(event) = obj.get("event").and_then(|event| event.as_str()) {
        if transition.is_none() {
            transition = Some(event.to_string());
        }
    }

    if let Some(action) = obj.get("action").and_then(|action| action.as_str()) {
        let mut args = value.clone();
        if let Some(map) = args.as_object_mut() {
            map.remove("action");
            map.remove("transition");
            map.remove("error");
        }
        tool_calls.push(ToolCallRequest {
            name: action.to_string(),
            args,
        });
    }

    if let Some(name) = obj.get("name").and_then(|name| name.as_str()) {
        let has_explicit_args = obj.contains_key("args")
            || obj.contains_key("arguments")
            || obj.contains_key("input")
            || obj.contains_key("parameters");
        if has_explicit_args {
            tool_calls.push(ToolCallRequest {
                name: name.to_string(),
                args: normalize_tool_args(
                    obj.get("args")
                        .or_else(|| obj.get("arguments"))
                        .or_else(|| obj.get("input"))
                        .or_else(|| obj.get("parameters")),
                ),
            });
        } else if transition.is_none() && name.chars().all(|ch| !ch.is_ascii_lowercase()) {
            transition = Some(name.to_string());
        }
    }

    if let Some(patch) = obj.get("patch").and_then(|patch| patch.as_str()) {
        tool_calls.push(ToolCallRequest {
            name: "apply_patch".into(),
            args: json!({"patch": patch}),
        });
    }

    if transition.is_some() || !tool_calls.is_empty() || error.is_some() {
        Some(LlmResponse {
            transition,
            error,
            tool_calls: if tool_calls.is_empty() {
                None
            } else {
                Some(tool_calls)
            },
            reasoning: None,
        })
    } else {
        None
    }
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

    if let Some(r) = parse_native_function_call_array(cleaned) {
        return Some(r);
    }

    // Try direct parse through a normalizer so single-call objects with both
    // {"name": "...", "args": {...}, "transition": "..."} do not collapse to
    // transition-only responses.
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(cleaned) {
        if let Some(r) = response_from_json_value(&value) {
            return Some(r);
        }
    }

    // Try with single quotes normalized to double quotes (qwen-coder outputs single-quoted JSON)
    let dequoted = normalize_single_quotes(cleaned);
    if dequoted != cleaned {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&dequoted) {
            if let Some(r) = response_from_json_value(&value) {
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
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate) {
                if let Some(r) = response_from_json_value(&value) {
                    return Some(r);
                }
            } else {
                // serde rejected the candidate — possibly because transition is an object
                // rather than a string (qwen3:8b produces {"name":"DONE"} or {"event":"DONE"}).
                // Try parsing as Value and normalizing.
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(candidate) {
                    if let Some(r) = response_from_json_value(&v) {
                        return Some(r);
                    }
                }
            }
            if cleaned.contains("}]") {
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
                        if let Ok(value) =
                            serde_json::from_str::<serde_json::Value>(&healed[h_start..=h_end])
                        {
                            if let Some(r) = response_from_json_value(&value) {
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
        if let Some(r) = response_from_json_value(&obj) {
            return Some(r);
        }
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

fn parse_native_function_call_array(raw: &str) -> Option<LlmResponse> {
    let value = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let array = value.as_array()?;
    let tool_calls: Vec<ToolCallRequest> = array
        .iter()
        .filter_map(|item| {
            let function = item.get("function")?;
            let name = function.get("name")?.as_str()?.to_string();
            let args = function
                .get("arguments")
                .and_then(|arguments| {
                    if let Some(raw_args) = arguments.as_str() {
                        serde_json::from_str::<serde_json::Value>(raw_args).ok()
                    } else {
                        Some(arguments.clone())
                    }
                })
                .unwrap_or_else(|| json!({}));
            Some(ToolCallRequest { name, args })
        })
        .collect();

    if tool_calls.is_empty() {
        None
    } else {
        Some(LlmResponse {
            transition: None,
            error: None,
            tool_calls: Some(tool_calls),
            reasoning: None,
        })
    }
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
    if let Err(err) = std::fs::write(&full_path, &unescaped) {
        println!(
            "  [PARSE RECOVER] write failed path={} error={}",
            full_path.display(),
            err
        );
        return None;
    }
    println!(
        "  [PARSE RECOVER] Wrote {} bytes (possibly truncated) to {}",
        unescaped.len(),
        path
    );
    Some(path.to_string())
}

fn malformed_response_path_diagnostics(raw: &str, workdir: &str) -> Vec<String> {
    extract_paths_from_malformed(raw)
        .into_iter()
        .filter(|path| !tools::repo_path_exists_exact(path, workdir))
        .map(|path| {
            format!(
                "{} Do not invent application placeholder paths; choose an exact repository-relative file path from the existing file index before editing.",
                tools::repo_path_missing_diagnostic(&path, workdir)
            )
        })
        .collect()
}

fn extract_paths_from_malformed(raw: &str) -> Vec<String> {
    let bytes = raw.as_bytes();
    let mut paths = Vec::new();
    let mut idx = 0;
    while let Some(offset) = raw[idx..].find("\"path\"") {
        let key_start = idx + offset;
        let mut cursor = key_start + "\"path\"".len();
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b':' {
            idx = key_start + 1;
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b'"' {
            idx = key_start + 1;
            continue;
        }
        cursor += 1;
        let mut value = String::new();
        let mut escaped = false;
        while cursor < bytes.len() {
            let ch = bytes[cursor] as char;
            if escaped {
                value.push(ch);
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                break;
            } else {
                value.push(ch);
            }
            cursor += 1;
        }
        let path = value.trim().trim_start_matches("./").to_string();
        if !path.is_empty() && !path.contains("..") && !paths.contains(&path) {
            paths.push(path);
        }
        idx = cursor.saturating_add(1);
    }
    paths
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
