use crate::{
    candidate_context::CandidateContextPacket,
    candidate_evidence::{CandidateEvidence, CandidateEvidenceKind},
    candidate_strengthening, candidate_validation, patch_authority, tools, validation_oracle,
};
use serde::Serialize;
use statewright_agent::ollama_client::{OllamaClient, OllamaConfig};
use statewright_agent::prompt_templates::ChatMessage;
use std::cmp::Ordering;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_MAX_CANDIDATES: usize = 4;
const DEFAULT_CONCURRENCY: usize = 2;
const DEFAULT_CHILD_STEPS: u32 = 45;
const DEFAULT_CHILD_TIMEOUT_SECONDS: u64 = 900;
const DEFAULT_MAX_DEPTH: usize = 1;
const DEFAULT_CHILD_MAX_RETRIES: u32 = 1;
const DEFAULT_CHILD_PROFILE: &str = "speed";
const DEFAULT_CHILD_MACHINE: &str = "speed";
const DEFAULT_ARBITER_MARGIN: i32 = 30;
const DEFAULT_ARBITER_MAX_CANDIDATES: usize = 3;
const DEFAULT_ARBITER_TIMEOUT_SECONDS: u64 = 90;
const DEFAULT_FANOUT_WALL_SECONDS: u64 = 1200;
const DEFAULT_TIMEOUT_STOP_COUNT: usize = 2;

pub fn feature_enabled() -> bool {
    if std::env::var("SW_REPAIR_CONTROLLER")
        .ok()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("causal_one_pass"))
    {
        return false;
    }
    if env_flag("SW_CANDIDATE_FANOUT_DISABLED", false) {
        return false;
    }
    let Some(mode) = env_string("DEPRECATED_SW_CANDIDATE_FANOUT_MODE") else {
        return false;
    };
    matches!(
        mode.trim().to_ascii_lowercase().as_str(),
        "1" | "on" | "true" | "fanout" | "parallel"
    )
}

#[derive(Clone, Debug)]
pub struct Config {
    pub enabled: bool,
    pub child: bool,
    pub child_depth: usize,
    pub max_depth: usize,
    pub parent_pid: Option<String>,
    pub max_candidates: usize,
    pub concurrency: usize,
    pub child_max_steps: u32,
    pub child_timeout_seconds: u64,
    pub fanout_wall_seconds: u64,
    pub timeout_stop_count: usize,
    pub child_max_retries: u32,
    pub child_profile: String,
    pub child_machine: String,
    pub context_pump: bool,
    pub fallback_to_sequential: bool,
    pub arbiter_enabled: bool,
    pub arbiter_margin: i32,
    pub arbiter_max_candidates: usize,
    pub arbiter_timeout_seconds: u64,
    pub require_strong_selection: bool,
    pub work_root: Option<PathBuf>,
    pub keep_workdirs: bool,
    pub strengthening: candidate_strengthening::StrengtheningConfig,
}

impl Config {
    pub fn from_env() -> Self {
        let child_depth = process_depth_from_env();
        Self {
            enabled: feature_enabled() && env_flag("SW_CANDIDATE_FANOUT", false),
            child: child_depth > 0,
            child_depth,
            max_depth: env_usize("SW_CANDIDATE_FANOUT_MAX_DEPTH", DEFAULT_MAX_DEPTH, 0, 8),
            parent_pid: env_string("SW_CANDIDATE_FANOUT_PARENT_PID"),
            max_candidates: env_usize("SW_CANDIDATE_FANOUT_MAX", DEFAULT_MAX_CANDIDATES, 1, 12),
            concurrency: env_usize("SW_CANDIDATE_FANOUT_CONCURRENCY", DEFAULT_CONCURRENCY, 1, 8),
            child_max_steps: env_u32(
                "SW_CANDIDATE_FANOUT_CHILD_MAX_STEPS",
                DEFAULT_CHILD_STEPS,
                8,
                200,
            ),
            child_timeout_seconds: env_u64(
                "SW_CANDIDATE_FANOUT_CHILD_TIMEOUT_SECONDS",
                DEFAULT_CHILD_TIMEOUT_SECONDS,
                60,
                7200,
            ),
            fanout_wall_seconds: env_u64(
                "SW_CANDIDATE_FANOUT_WALL_SECONDS",
                DEFAULT_FANOUT_WALL_SECONDS,
                0,
                7200,
            ),
            timeout_stop_count: env_usize(
                "SW_CANDIDATE_FANOUT_TIMEOUT_STOP_COUNT",
                DEFAULT_TIMEOUT_STOP_COUNT,
                0,
                32,
            ),
            child_max_retries: env_u32(
                "SW_CANDIDATE_FANOUT_CHILD_MAX_RETRIES",
                DEFAULT_CHILD_MAX_RETRIES,
                0,
                20,
            ),
            child_profile: env_string("SW_CANDIDATE_FANOUT_CHILD_PROFILE")
                .unwrap_or_else(|| DEFAULT_CHILD_PROFILE.to_string()),
            child_machine: env_string("SW_CANDIDATE_FANOUT_CHILD_MACHINE")
                .unwrap_or_else(|| DEFAULT_CHILD_MACHINE.to_string()),
            context_pump: env_flag("SW_CANDIDATE_FANOUT_CONTEXT_PUMP", true),
            fallback_to_sequential: env_flag("DEPRECATED_SW_CANDIDATE_FANOUT_FALLBACK", false),
            arbiter_enabled: env_flag("SW_CANDIDATE_FANOUT_ARBITER", true),
            arbiter_margin: env_i32(
                "SW_CANDIDATE_FANOUT_ARBITER_MARGIN",
                DEFAULT_ARBITER_MARGIN,
                0,
                200,
            ),
            arbiter_max_candidates: env_usize(
                "SW_CANDIDATE_FANOUT_ARBITER_MAX",
                DEFAULT_ARBITER_MAX_CANDIDATES,
                2,
                8,
            ),
            arbiter_timeout_seconds: env_u64(
                "SW_CANDIDATE_FANOUT_ARBITER_TIMEOUT_SECONDS",
                DEFAULT_ARBITER_TIMEOUT_SECONDS,
                10,
                600,
            ),
            require_strong_selection: env_flag(
                "SW_CANDIDATE_FANOUT_REQUIRE_STRONG_SELECTION",
                false,
            ),
            work_root: env_path("SW_CANDIDATE_FANOUT_WORK_ROOT"),
            keep_workdirs: env_flag("SW_CANDIDATE_FANOUT_KEEP_WORKDIRS", false),
            strengthening: candidate_strengthening::StrengtheningConfig::from_env(),
        }
    }

    pub fn parent_enabled(&self) -> bool {
        self.enabled && !self.child && self.child_depth == 0 && self.max_depth > 0
    }
}

pub fn process_depth_from_env() -> usize {
    let explicit_depth = env_usize("SW_CANDIDATE_FANOUT_DEPTH", 0, 0, 64);
    if explicit_depth == 0 && env_flag("SW_CANDIDATE_FANOUT_CHILD", false) {
        1
    } else {
        explicit_depth
    }
}

pub fn plan_mode_from_env(patch_tournament_enabled: bool) -> &'static str {
    let config = Config::from_env();
    if patch_tournament_enabled && config.parent_enabled() {
        "parallel_candidate_fanout"
    } else if patch_tournament_enabled {
        "sequential_candidate_packets"
    } else {
        "disabled"
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct CandidateHypothesis {
    pub id: usize,
    pub path: String,
    pub score: usize,
    pub reason: String,
}

#[derive(Clone, Debug)]
pub struct AgentInvocation {
    pub executable: PathBuf,
    pub task: String,
    pub ollama_url: String,
    pub model: String,
    pub max_retries: u32,
    pub hardcoded_machine: String,
    pub use_hardcoded_machine: bool,
    pub tool_mode: String,
    pub model_size: f32,
    pub config_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FanoutPlan {
    schema_version: u32,
    artifact: &'static str,
    mode: &'static str,
    benchmark_clean: bool,
    scoring_boundary: &'static str,
    process_depth: usize,
    spawned_child_depth: usize,
    max_depth: usize,
    parent_pid: Option<String>,
    candidate_count: usize,
    concurrency: usize,
    child_max_steps: u32,
    child_timeout_seconds: u64,
    fanout_wall_seconds: u64,
    timeout_stop_count: usize,
    child_max_retries: u32,
    child_profile: String,
    child_machine: String,
    context_pump: bool,
    strengthening_enabled: bool,
    strengthening_steps: u32,
    strengthening_timeout_seconds: u64,
    local_work_root: String,
    hypotheses: Vec<CandidateHypothesis>,
}

#[derive(Debug, Serialize)]
pub struct CandidateRunReport {
    candidate_id: String,
    hypothesis_id: usize,
    path: String,
    score: i32,
    accepted: bool,
    rejection_reasons: Vec<String>,
    patch_path: Option<String>,
    patch_hash: Option<String>,
    changed_files: Vec<String>,
    changed_lines: usize,
    quality_penalty: i32,
    quality_flags: Vec<String>,
    final_verification_signal: String,
    candidate_validation_signal: String,
    parent_validation_signal: Option<String>,
    parent_validation_provenance: Option<candidate_validation::ValidationProvenance>,
    parent_validation_excerpt: Option<String>,
    timeout_validation_signal: Option<String>,
    exit_code: Option<i32>,
    duration_ms: u128,
    timed_out: bool,
    materialization: MaterializationReport,
    evidence: CandidateEvidence,
    launched_path: String,
    issue_locus_aligned: bool,
    strengthening_attempted: bool,
    strengthening_signal: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FanoutSelectionReport {
    schema_version: u32,
    artifact: &'static str,
    mode: &'static str,
    benchmark_clean: bool,
    scoring_boundary: &'static str,
    selected_candidate_id: Option<String>,
    selected_patch_source: &'static str,
    selector: String,
    no_clear_winner: bool,
    fanout_stop_reason: Option<String>,
    selection_reason: String,
    selected_validation_provenance: Option<candidate_validation::ValidationProvenance>,
    arbiter: Option<ArbiterReport>,
    candidates: Vec<CandidateRunReport>,
}

#[derive(Debug)]
pub struct FanoutOutcome {
    pub applied: bool,
    pub selected_candidate_id: Option<String>,
    pub candidate_count: usize,
    pub timed_out_count: usize,
    pub timed_out_with_patch_count: usize,
    pub elapsed_ms: u128,
    pub fanout_stop_reason: Option<String>,
    pub selected_patch_hash: Option<String>,
    pub selected_validation: Option<candidate_validation::ValidationProvenance>,
    pub detail: String,
}

#[derive(Debug)]
pub struct FanoutBatch {
    namespace: String,
    executions: Vec<CandidateExecution>,
    elapsed_ms: u128,
    fanout_stop_reason: Option<String>,
}

impl FanoutBatch {
    pub fn candidate_count(&self) -> usize {
        self.executions.len()
    }

    pub fn timed_out_count(&self) -> usize {
        self.executions
            .iter()
            .filter(|execution| execution.timed_out)
            .count()
    }

    pub fn timed_out_with_patch_count(&self) -> usize {
        self.executions
            .iter()
            .filter(|execution| execution.timed_out && !execution.patch.trim().is_empty())
            .count()
    }

    pub fn elapsed_ms(&self) -> u128 {
        self.elapsed_ms
    }

    pub fn fanout_stop_reason(&self) -> Option<&str> {
        self.fanout_stop_reason.as_deref()
    }

    pub fn has_discriminating_candidate(&self) -> bool {
        self.executions.iter().any(|execution| {
            candidate_is_selectable(execution)
                && matches!(
                    execution.evidence.kind,
                    CandidateEvidenceKind::CanonicalHarnessPass
                        | CandidateEvidenceKind::IssueMappedBaselinePass
                )
        })
    }
}

#[derive(Debug)]
struct CandidateExecution {
    hypothesis: CandidateHypothesis,
    candidate_id: String,
    stdout: String,
    stderr: String,
    patch: String,
    changed_files: Vec<String>,
    changed_lines: usize,
    exit_code: Option<i32>,
    duration_ms: u128,
    timed_out: bool,
    materialization: MaterializationReport,
    evidence: CandidateEvidence,
    actual_locus: String,
    issue_locus_aligned: bool,
    strengthening_attempted: bool,
    strengthening_signal: Option<String>,
    parent_validation_output: String,
    parent_validation_provenance: Option<candidate_validation::ValidationProvenance>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum MaterializationMode {
    GitWorktreeWithPreparedArtifacts,
    PreparedTreeCopy,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct MaterializationReport {
    mode: MaterializationMode,
    protected_artifacts_requested: usize,
    protected_artifacts_copied: usize,
}

#[derive(Clone, Debug, Serialize)]
struct ArbiterReport {
    artifact: &'static str,
    status: String,
    selected_candidate_id: Option<String>,
    confidence: Option<String>,
    reason: String,
    concerns: Vec<String>,
    raw_response: Option<String>,
    fallback_candidate_id: Option<String>,
}

#[derive(Debug)]
struct SelectionDecision {
    selected_index: Option<usize>,
    detail: String,
    selector: String,
    no_clear_winner: bool,
    arbiter: Option<ArbiterReport>,
}

pub async fn run(
    config: &Config,
    invocation: &AgentInvocation,
    parent_workdir: &str,
    artifact_dir: Option<PathBuf>,
    hypotheses: Vec<CandidateHypothesis>,
) -> Result<FanoutOutcome, String> {
    let batch = collect(
        config,
        invocation,
        parent_workdir,
        artifact_dir.clone(),
        "",
        None,
        hypotheses,
    )?;
    select_and_apply(
        config,
        invocation,
        parent_workdir,
        artifact_dir,
        vec![batch],
    )
    .await
}

pub fn collect(
    config: &Config,
    invocation: &AgentInvocation,
    parent_workdir: &str,
    artifact_dir: Option<PathBuf>,
    namespace: &str,
    shared_deadline: Option<Instant>,
    hypotheses: Vec<CandidateHypothesis>,
) -> Result<FanoutBatch, String> {
    if !config.parent_enabled() {
        return Ok(FanoutBatch {
            namespace: namespace.to_string(),
            executions: Vec::new(),
            elapsed_ms: 0,
            fanout_stop_reason: None,
        });
    }

    let artifact_dir = artifact_dir.unwrap_or_else(|| PathBuf::from(".statewright-artifacts"));
    std::fs::create_dir_all(&artifact_dir)
        .map_err(|err| format!("create artifact dir {}: {err}", artifact_dir.display()))?;

    let mut hypotheses = hypotheses;
    hypotheses.truncate(config.max_candidates.max(1));
    if hypotheses.is_empty() {
        return Ok(FanoutBatch {
            namespace: namespace.to_string(),
            executions: Vec::new(),
            elapsed_ms: 0,
            fanout_stop_reason: None,
        });
    }

    let runs_dir = artifact_dir.join("candidates");
    std::fs::create_dir_all(&runs_dir)
        .map_err(|err| format!("create candidates dir {}: {err}", runs_dir.display()))?;
    let root = temp_root(config);
    std::fs::create_dir_all(&root)
        .map_err(|err| format!("create fanout work root {}: {err}", root.display()))?;
    write_plan(&artifact_dir, config, &hypotheses, &root)?;
    let context_packet =
        CandidateContextPacket::load(&artifact_dir, validation_oracle::baseline_runnable_scopes());
    write_json_path(
        &artifact_dir.join("candidate-context-packet.json"),
        &context_packet,
    )?;
    append_event(
        &artifact_dir,
        serde_json::json!({
            "event": "candidate_work_root",
            "path": root,
            "storage": "local_scratch",
        }),
    );

    let mut executions = Vec::new();
    let started = Instant::now();
    let local_deadline = (config.fanout_wall_seconds > 0)
        .then(|| started + Duration::from_secs(config.fanout_wall_seconds));
    let fanout_deadline = earliest_deadline(local_deadline, shared_deadline);
    let mut fanout_stop_reason = None;
    for chunk in hypotheses.chunks(config.concurrency.max(1)) {
        if fanout_deadline.is_some_and(|deadline| deadline <= Instant::now()) {
            fanout_stop_reason = Some("shared fanout deadline reached".to_string());
            break;
        }
        if let Some(reason) = fanout_budget_stop_reason(config, started.elapsed(), &executions) {
            fanout_stop_reason = Some(reason);
            break;
        }
        let mut handles = Vec::new();
        for hypothesis in chunk.iter().cloned() {
            let invocation = invocation.clone();
            let parent_workdir = parent_workdir.to_string();
            let root = root.clone();
            let artifact_dir = runs_dir.join(candidate_id(&hypothesis));
            let config = config.clone();
            let context_packet = context_packet.clone();
            handles.push(thread::spawn(move || {
                run_one_candidate(
                    &config,
                    &invocation,
                    &parent_workdir,
                    hypothesis,
                    artifact_dir,
                    &root,
                    fanout_deadline,
                    &context_packet,
                )
            }));
        }
        for handle in handles {
            match handle.join() {
                Ok(Ok(execution)) => {
                    let mut execution = execution;
                    execution.candidate_id =
                        namespaced_candidate_id(namespace, &execution.candidate_id);
                    executions.push(execution);
                }
                Ok(Err(err)) => {
                    append_event(
                        &artifact_dir,
                        serde_json::json!({
                            "event": "candidate_error",
                            "error": err,
                        }),
                    );
                }
                Err(_) => {
                    append_event(
                        &artifact_dir,
                        serde_json::json!({
                            "event": "candidate_thread_panic",
                        }),
                    );
                }
            }
        }
        if let Some(reason) = fanout_budget_stop_reason(config, started.elapsed(), &executions) {
            append_event(
                &artifact_dir,
                serde_json::json!({
                    "event": "candidate_fanout_budget_stop",
                    "reason": reason,
                    "completed_candidates": executions.len(),
                    "timed_out_candidates": executions.iter().filter(|execution| execution.timed_out).count(),
                    "timed_out_with_patch_candidates": executions.iter().filter(|execution| execution.timed_out && !execution.patch.trim().is_empty()).count(),
                    "elapsed_ms": started.elapsed().as_millis(),
                }),
            );
            fanout_stop_reason = Some(reason);
            break;
        }
    }

    if !config.keep_workdirs {
        if let Err(err) = std::fs::remove_dir_all(&root) {
            eprintln!(
                "[CANDIDATE-FANOUT] workdir cleanup failed path={} error={}",
                root.display(),
                err
            );
        }
    }

    Ok(FanoutBatch {
        namespace: namespace.to_string(),
        executions,
        elapsed_ms: started.elapsed().as_millis(),
        fanout_stop_reason,
    })
}

pub async fn select_and_apply(
    config: &Config,
    invocation: &AgentInvocation,
    parent_workdir: &str,
    artifact_dir: Option<PathBuf>,
    batches: Vec<FanoutBatch>,
) -> Result<FanoutOutcome, String> {
    let started = Instant::now();
    let artifact_dir = artifact_dir.unwrap_or_else(|| PathBuf::from(".statewright-artifacts"));
    std::fs::create_dir_all(&artifact_dir)
        .map_err(|err| format!("create artifact dir {}: {err}", artifact_dir.display()))?;

    let candidate_count = batches.iter().map(FanoutBatch::candidate_count).sum();
    let timed_out_count = batches.iter().map(FanoutBatch::timed_out_count).sum();
    let timed_out_with_patch_count = batches
        .iter()
        .map(FanoutBatch::timed_out_with_patch_count)
        .sum();
    let collection_elapsed_ms = batches.iter().map(FanoutBatch::elapsed_ms).sum::<u128>();
    let stop_reasons: Vec<String> = batches
        .iter()
        .filter_map(|batch| {
            batch
                .fanout_stop_reason
                .as_ref()
                .map(|reason| format!("{}:{reason}", batch.namespace))
        })
        .collect();
    let fanout_stop_reason = (!stop_reasons.is_empty()).then(|| stop_reasons.join("; "));
    let executions = merge_batches(batches);

    persist_tournament_patches(&artifact_dir, &executions)?;
    let reports: Vec<CandidateRunReport> = executions.iter().map(report_for_execution).collect();
    let selection_decision =
        select_candidate_index(config, invocation, &executions, &artifact_dir).await;

    let mut selected_candidate_id = None;
    let mut selected_patch_hash = None;
    let mut selected_validation = None;
    let mut applied = false;
    let detail;
    if let Some(selected_index) = selection_decision.selected_index {
        let selected = &executions[selected_index];
        if selection_allowed_to_apply(config, selected) {
            selected_candidate_id = Some(selected.candidate_id.clone());
            selected_patch_hash = Some(stable_hash(&selected.patch));
            selected_validation = selected.parent_validation_provenance.clone();
            apply_patch(parent_workdir, &selected.patch)?;
            applied = true;
            detail = selection_decision.detail.clone();
        } else {
            detail = format!(
                "deferred {} path={} selector={} reason=weak_early_lane_selection validation={} path_aligned={} changed_lines={} quality_penalty={} original={}",
                selected.candidate_id,
                selected.actual_locus,
                selection_decision.selector,
                candidate_validation_signal(&selected.stdout),
                candidate_path_aligned(selected),
                selected.changed_lines,
                patch_quality_assessment(selected).penalty,
                selection_decision.detail
            );
        }
    } else {
        detail = selection_decision.detail.clone();
    }

    write_selection(
        &artifact_dir,
        FanoutSelectionReport {
            schema_version: 1,
            artifact: "statewright.candidate_fanout.selection",
            mode: "logical_parallel",
            benchmark_clean: true,
            scoring_boundary: "Generated candidate patches and harness-visible validation telemetry only; no official solution patch, hidden test patch, or post-hoc verifier result is exposed to the model. Official SWE-bench verification remains the only solve authority.",
            selected_candidate_id: selected_candidate_id.clone(),
            selected_patch_source: if applied { "candidate_fanout" } else { "none" },
            selector: selection_decision.selector.clone(),
            no_clear_winner: selection_decision.no_clear_winner,
            fanout_stop_reason: fanout_stop_reason.clone(),
            selection_reason: detail.clone(),
            selected_validation_provenance: selected_validation.clone(),
            arbiter: selection_decision.arbiter.clone(),
            candidates: reports,
        },
    )?;

    Ok(FanoutOutcome {
        applied,
        selected_candidate_id,
        candidate_count,
        timed_out_count,
        timed_out_with_patch_count,
        elapsed_ms: collection_elapsed_ms.saturating_add(started.elapsed().as_millis()),
        fanout_stop_reason,
        selected_patch_hash,
        selected_validation,
        detail,
    })
}

fn fanout_budget_stop_reason(
    config: &Config,
    elapsed: Duration,
    executions: &[CandidateExecution],
) -> Option<String> {
    if config.timeout_stop_count > 0 {
        let timed_out = executions
            .iter()
            .filter(|execution| execution.timed_out && !execution.patch.trim().is_empty())
            .count();
        if timed_out >= config.timeout_stop_count {
            return Some(format!(
                "timeout_stop_count reached patch_timeouts={} limit={}",
                timed_out, config.timeout_stop_count
            ));
        }
    }

    if config.fanout_wall_seconds > 0 && elapsed >= Duration::from_secs(config.fanout_wall_seconds)
    {
        return Some(format!(
            "fanout_wall_seconds reached elapsed_ms={} limit_s={}",
            elapsed.as_millis(),
            config.fanout_wall_seconds
        ));
    }

    None
}

fn earliest_deadline(left: Option<Instant>, right: Option<Instant>) -> Option<Instant> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(deadline), None) | (None, Some(deadline)) => Some(deadline),
        (None, None) => None,
    }
}

fn namespaced_candidate_id(namespace: &str, candidate_id: &str) -> String {
    let namespace = namespace
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    let namespace = namespace.trim_matches('-');
    if namespace.is_empty() {
        candidate_id.to_string()
    } else {
        format!("{namespace}--{candidate_id}")
    }
}

fn persist_tournament_patches(
    artifact_dir: &Path,
    executions: &[CandidateExecution],
) -> Result<(), String> {
    let candidates_dir = artifact_dir.join("candidates");
    std::fs::create_dir_all(&candidates_dir).map_err(|err| {
        format!(
            "create tournament candidates dir {}: {err}",
            candidates_dir.display()
        )
    })?;
    for execution in executions {
        if execution.patch.trim().is_empty() {
            continue;
        }
        let candidate_dir = candidates_dir.join(&execution.candidate_id);
        std::fs::create_dir_all(&candidate_dir).map_err(|err| {
            format!(
                "create tournament candidate dir {}: {err}",
                candidate_dir.display()
            )
        })?;
        std::fs::write(candidate_dir.join("diff.patch"), &execution.patch)
            .map_err(|err| format!("write tournament patch {}: {err}", execution.candidate_id))?;
    }
    Ok(())
}

fn merge_batches(batches: Vec<FanoutBatch>) -> Vec<CandidateExecution> {
    batches
        .into_iter()
        .flat_map(|batch| batch.executions)
        .collect()
}

async fn select_candidate_index(
    config: &Config,
    invocation: &AgentInvocation,
    executions: &[CandidateExecution],
    artifact_dir: &Path,
) -> SelectionDecision {
    let ranked = ranked_selectable_candidate_indices(executions);
    let Some(&heuristic_index) = ranked.first() else {
        return SelectionDecision {
            selected_index: None,
            detail: "no selectable candidate patch selected; only unsafe, empty, or concrete-failing candidates were available".to_string(),
            selector: "none".to_string(),
            no_clear_winner: false,
            arbiter: None,
        };
    };

    let heuristic = &executions[heuristic_index];
    let heuristic_quality = patch_quality_assessment(heuristic);
    let heuristic_detail = format!(
        "selected {} path={} score={} quality_penalty={} quality_flags={} selector=heuristic",
        heuristic.candidate_id,
        heuristic.actual_locus,
        score_execution(heuristic),
        heuristic_quality.penalty,
        format_quality_flags(&heuristic_quality.flags)
    );

    let needs_arbitration = selection_needs_arbitration(executions, &ranked, config.arbiter_margin);
    if !needs_arbitration || !config.arbiter_enabled {
        return SelectionDecision {
            selected_index: Some(heuristic_index),
            detail: heuristic_detail,
            selector: "heuristic".to_string(),
            no_clear_winner: needs_arbitration,
            arbiter: None,
        };
    }

    let arbiter_limit = config.arbiter_max_candidates.min(ranked.len()).max(1);
    let arbitration_indices = &ranked[..arbiter_limit];
    let fallback_index =
        static_risk_tiebreak_index(executions, arbitration_indices).unwrap_or(heuristic_index);
    let fallback = &executions[fallback_index];
    let fallback_tiebreak_detail =
        static_risk_tiebreak_detail(executions, fallback, arbitration_indices);

    let mut arbiter = match tokio::time::timeout(
        Duration::from_secs(config.arbiter_timeout_seconds),
        arbitrate_candidate_selection(invocation, executions, arbitration_indices, artifact_dir),
    )
    .await
    {
        Ok(report) => report,
        Err(_) => {
            let report = ArbiterReport {
                artifact: "statewright.candidate_fanout.arbiter",
                status: "timeout".to_string(),
                selected_candidate_id: None,
                confidence: None,
                reason: format!(
                    "arbiter exceeded {} second selection budget",
                    config.arbiter_timeout_seconds
                ),
                concerns: vec!["arbiter timed out; static risk tiebreak used".to_string()],
                raw_response: None,
                fallback_candidate_id: None,
            };
            write_json_path_or_event(
                artifact_dir,
                &artifact_dir.join("candidate-fanout-arbiter.json"),
                &report,
                "arbiter_timeout_artifact_write_failed",
            );
            report
        }
    };
    arbiter.fallback_candidate_id = Some(fallback.candidate_id.clone());
    if let Some(selected_id) = arbiter.selected_candidate_id.clone() {
        if let Some(index) = arbitration_indices
            .iter()
            .copied()
            .find(|index| executions[*index].candidate_id == selected_id)
        {
            let selected = &executions[index];
            if !arbiter_selection_allowed(selected, fallback) {
                arbiter.status = "rejected_static_risk".to_string();
                append_event(
                    artifact_dir,
                    serde_json::json!({
                        "event": "candidate_arbiter_static_risk_rejected",
                        "selected_candidate_id": selected_id,
                        "fallback": fallback.candidate_id,
                        "fallback_reason": fallback_tiebreak_detail.clone(),
                        "selected_validation": candidate_validation_signal(&selected.stdout),
                        "fallback_validation": candidate_validation_signal(&fallback.stdout),
                        "selected_path_aligned": candidate_path_aligned(selected),
                        "fallback_path_aligned": candidate_path_aligned(fallback),
                        "selected_changed_lines": selected.changed_lines,
                        "fallback_changed_lines": fallback.changed_lines,
                        "selected_quality_penalty": patch_quality_assessment(selected).penalty,
                        "fallback_quality_penalty": patch_quality_assessment(fallback).penalty,
                    }),
                );
            } else {
                let selected_quality = patch_quality_assessment(selected);
                let confidence = arbiter.confidence.as_deref().unwrap_or("unspecified");
                let concerns = if arbiter.concerns.is_empty() {
                    "none".to_string()
                } else {
                    compact_one_line(&arbiter.concerns.join("; "), 200)
                };
                return SelectionDecision {
                    selected_index: Some(index),
                    detail: format!(
                        "selected {} path={} score={} quality_penalty={} quality_flags={} selector=llm_arbiter no_clear_winner=true confidence={} reason={} concerns={}",
                        selected.candidate_id,
                        selected.actual_locus,
                        score_execution(selected),
                        selected_quality.penalty,
                        format_quality_flags(&selected_quality.flags),
                        confidence,
                        compact_one_line(&arbiter.reason, 240),
                        concerns
                    ),
                    selector: "llm_arbiter".to_string(),
                    no_clear_winner: true,
                    arbiter: Some(arbiter),
                };
            }
        } else {
            arbiter.status = "invalid_selection".to_string();
            append_event(
                artifact_dir,
                serde_json::json!({
                        "event": "candidate_arbiter_invalid_selection",
                        "selected_candidate_id": selected_id,
                        "fallback": fallback.candidate_id,
                        "fallback_reason": fallback_tiebreak_detail.clone(),
                }),
            );
        }
    } else {
        append_event(
            artifact_dir,
            serde_json::json!({
                "event": "candidate_arbiter_unavailable",
                "status": arbiter.status,
                "fallback": fallback.candidate_id,
                "fallback_reason": fallback_tiebreak_detail.clone(),
            }),
        );
    }

    SelectionDecision {
        selected_index: Some(fallback_index),
        detail: format!(
            "selected {} path={} score={} quality_penalty={} quality_flags={} no_clear_winner=true selector=static_risk_tiebreak_after_arbiter_{} arbiter_status={} arbiter_reason={} {}",
            fallback.candidate_id,
            fallback.actual_locus,
            score_execution(fallback),
            patch_quality_assessment(fallback).penalty,
            format_quality_flags(&patch_quality_assessment(fallback).flags),
            if arbiter.status == "error" {
                "error"
            } else {
                "unavailable"
            },
            arbiter.status,
            compact_one_line(&arbiter.reason, 180),
            fallback_tiebreak_detail
        ),
        selector: format!(
            "static_risk_tiebreak_after_arbiter_{}",
            if arbiter.status == "error" {
                "error"
            } else {
                "unavailable"
            }
        ),
        no_clear_winner: true,
        arbiter: Some(arbiter),
    }
}

fn run_one_candidate(
    config: &Config,
    invocation: &AgentInvocation,
    parent_workdir: &str,
    hypothesis: CandidateHypothesis,
    artifact_dir: PathBuf,
    root: &Path,
    fanout_deadline: Option<Instant>,
    context_packet: &CandidateContextPacket,
) -> Result<CandidateExecution, String> {
    let candidate_id = candidate_id(&hypothesis);
    std::fs::create_dir_all(&artifact_dir).map_err(|err| {
        format!(
            "create candidate artifact dir {}: {err}",
            artifact_dir.display()
        )
    })?;
    let workdir = root.join(&candidate_id);
    let materialization = materialize_workdir(parent_workdir, &workdir)?;

    let started = std::time::Instant::now();
    let child_max_retries = config.child_max_retries.min(invocation.max_retries);
    let child_task = if config.context_pump {
        speed_solver_task(
            &invocation.task,
            config,
            &hypothesis,
            &candidate_id,
            child_max_retries,
            context_packet,
        )
    } else {
        invocation.task.clone()
    };
    let child_machine = child_machine_variant(config, invocation);
    let cmd = candidate_command(
        config,
        invocation,
        &hypothesis,
        &workdir,
        &artifact_dir,
        &child_task,
        config.child_max_steps,
        child_max_retries,
        &child_machine,
    );

    let child_timeout = remaining_timeout(
        fanout_deadline,
        Duration::from_secs(config.child_timeout_seconds),
    )
    .ok_or_else(|| format!("fanout deadline reached before candidate {candidate_id} start"))?;
    println!(
        "  [CANDIDATE-FANOUT] start candidate={} path={} child_steps={} timeout_s={}",
        candidate_id,
        hypothesis.path,
        config.child_max_steps,
        child_timeout.as_secs()
    );
    let output = run_child_with_timeout(cmd, child_timeout, &candidate_id)?;
    let mut stdout = output.stdout;
    let mut stderr = output.stderr;
    let mut exit_code = output.exit_code;
    let mut timed_out = output.timed_out;
    let mut patch =
        git_diff(&workdir).map_err(|err| format!("read candidate diff {candidate_id}: {err}"))?;
    let mut candidate_changed_files = changed_files(&workdir);
    let mut changed_lines = changed_line_count(&patch);
    let child_evidence = CandidateEvidence::from_output(&stdout);
    let mut parent_validation_output = String::new();
    let mut parent_validation_provenance = None;
    let mut parent_validation_signal =
        if !patch.trim().is_empty() && candidate_needs_parent_validation(&stdout) {
            let result = run_parent_candidate_validation(
                &workdir,
                &artifact_dir,
                &candidate_id,
                output.timed_out,
                &child_evidence,
                &candidate_changed_files,
                context_packet,
                fanout_deadline,
            );
            parent_validation_output = result.output;
            parent_validation_provenance = result.provenance;
            Some(result.signal)
        } else {
            None
        };
    if let Some(signal) = &parent_validation_signal {
        stdout.push_str(&format!(
            "[PARENT_CANDIDATE_VALIDATION] SIGNAL={}\n",
            signal
        ));
    }
    let mut evidence = CandidateEvidence::from_output(&stdout);
    let mut actual_locus =
        crate::candidate_evidence::actual_locus(&candidate_changed_files, &hypothesis.path);
    let remaining = fanout_deadline.map(|deadline| {
        deadline
            .checked_duration_since(Instant::now())
            .unwrap_or(Duration::ZERO)
    });
    let mut strengthening_attempted = false;
    let mut strengthening_signal = None;
    if candidate_strengthening::should_attempt(&config.strengthening, &evidence, &patch, remaining)
    {
        strengthening_attempted = true;
        let validation_feedback =
            std::fs::read_to_string(artifact_dir.join("parent-validation.log"))
                .unwrap_or_else(|_| stdout.clone());
        let strengthening_task = candidate_strengthening::repair_task(
            &invocation.task,
            &candidate_id,
            &actual_locus,
            &validation_feedback,
        );
        let strengthening_dir = artifact_dir.join("strengthening");
        std::fs::create_dir_all(&strengthening_dir).map_err(|err| {
            format!(
                "create strengthening artifact dir {}: {err}",
                strengthening_dir.display()
            )
        })?;
        let strengthening_command = candidate_command(
            config,
            invocation,
            &hypothesis,
            &workdir,
            &strengthening_dir,
            &strengthening_task,
            config.strengthening.steps,
            0,
            &child_machine,
        );
        if let Some(strengthening_timeout) =
            remaining_timeout(fanout_deadline, config.strengthening.timeout)
        {
            println!(
                "  [CANDIDATE-STRENGTHENING] start candidate={} steps={} timeout_s={} locus={}",
                candidate_id,
                config.strengthening.steps,
                strengthening_timeout.as_secs(),
                actual_locus
            );
            let strengthened = run_child_with_timeout(
                strengthening_command,
                strengthening_timeout,
                &format!("{candidate_id}-strengthening"),
            )?;
            std::fs::write(
                artifact_dir.join("strengthening.stdout.log"),
                &strengthened.stdout,
            )
            .map_err(|err| format!("write strengthening stdout: {err}"))?;
            std::fs::write(
                artifact_dir.join("strengthening.stderr.log"),
                &strengthened.stderr,
            )
            .map_err(|err| format!("write strengthening stderr: {err}"))?;
            stdout.push_str("[CANDIDATE_EVIDENCE_EPOCH]\n");
            stdout.push_str(&strengthened.stdout);
            stderr.push_str(&strengthened.stderr);
            exit_code = strengthened.exit_code.or(exit_code);
            timed_out |= strengthened.timed_out;
            patch = git_diff(&workdir)
                .map_err(|err| format!("read strengthened diff {candidate_id}: {err}"))?;
            candidate_changed_files = changed_files(&workdir);
            changed_lines = changed_line_count(&patch);
            actual_locus =
                crate::candidate_evidence::actual_locus(&candidate_changed_files, &hypothesis.path);
            let strengthened_evidence = CandidateEvidence::from_output(&stdout);
            parent_validation_signal =
                if !patch.trim().is_empty() && candidate_needs_parent_validation(&stdout) {
                    let result = run_parent_candidate_validation(
                        &workdir,
                        &artifact_dir,
                        &candidate_id,
                        strengthened.timed_out,
                        &strengthened_evidence,
                        &candidate_changed_files,
                        context_packet,
                        fanout_deadline,
                    );
                    parent_validation_output = result.output;
                    parent_validation_provenance = result.provenance;
                    Some(result.signal)
                } else {
                    None
                };
            if let Some(signal) = &parent_validation_signal {
                stdout.push_str(&format!(
                    "[PARENT_CANDIDATE_VALIDATION] SIGNAL={}\n",
                    signal
                ));
            }
            evidence = CandidateEvidence::from_output(&stdout);
            strengthening_signal = Some(evidence.selection_signal().to_string());
            println!(
                "  [CANDIDATE-STRENGTHENING] finish candidate={} signal={} changed_lines={}",
                candidate_id,
                evidence.selection_signal(),
                changed_lines
            );
        }
    }
    let duration_ms = started.elapsed().as_millis();
    let issue_locus_aligned =
        candidate_issue_locus_aligned(&candidate_changed_files, &hypothesis.path, context_packet);
    let patch_hash = if patch.trim().is_empty() {
        None
    } else {
        Some(stable_hash(&patch))
    };
    if !patch.trim().is_empty() {
        std::fs::write(artifact_dir.join("diff.patch"), &patch)
            .map_err(|err| format!("write candidate patch: {err}"))?;
    }
    std::fs::write(artifact_dir.join("harness.stdout.log"), &stdout)
        .map_err(|err| format!("write candidate stdout: {err}"))?;
    std::fs::write(artifact_dir.join("harness.stderr.log"), &stderr)
        .map_err(|err| format!("write candidate stderr: {err}"))?;
    let report = serde_json::json!({
        "schema_version": 1,
        "artifact": "statewright.candidate_fanout.candidate",
        "candidate_id": candidate_id,
        "hypothesis": hypothesis,
        "child_profile": config.child_profile.clone(),
        "child_machine": child_machine.variant,
        "context_pump": config.context_pump,
        "child_max_steps": config.child_max_steps,
        "child_max_retries": child_max_retries,
        "patch_hash": patch_hash,
        "changed_files": candidate_changed_files,
        "changed_lines": changed_lines,
        "duration_ms": duration_ms,
        "exit_code": exit_code,
        "timed_out": timed_out,
        "materialization": materialization.clone(),
        "evidence": evidence.clone(),
        "actual_locus": actual_locus.clone(),
        "issue_locus_aligned": issue_locus_aligned,
        "strengthening_attempted": strengthening_attempted,
        "strengthening_signal": strengthening_signal.clone(),
        "final_verification_signal": final_verification_signal(&stdout),
        "parent_validation_signal": parent_validation_signal.clone(),
        "parent_validation_provenance": parent_validation_provenance.clone(),
        "timeout_validation_signal": if timed_out { parent_validation_signal.clone() } else { None },
    });
    write_json_path(&artifact_dir.join("candidate.json"), &report)?;
    println!(
        "  [CANDIDATE-FANOUT] finish candidate={} exit={:?} timed_out={} duration_ms={} changed_lines={} final={}",
        candidate_id,
        exit_code,
        timed_out,
        duration_ms,
        changed_lines,
        final_verification_signal(&stdout)
    );

    Ok(CandidateExecution {
        hypothesis,
        candidate_id,
        stdout,
        stderr,
        patch,
        changed_files: candidate_changed_files,
        changed_lines,
        exit_code,
        duration_ms,
        timed_out,
        materialization,
        evidence,
        actual_locus,
        issue_locus_aligned,
        strengthening_attempted,
        strengthening_signal,
        parent_validation_output,
        parent_validation_provenance,
    })
}

struct ParentValidationResult {
    signal: String,
    output: String,
    provenance: Option<candidate_validation::ValidationProvenance>,
}

struct ExecutedScopeValidation {
    selection: candidate_validation::ScopeSelection,
    baseline: Option<validation_oracle::BaselineScopeOutcome>,
    assessment: candidate_validation::ValidationAssessment,
    output: String,
    command: Option<String>,
}

fn run_parent_candidate_validation(
    workdir: &Path,
    artifact_dir: &Path,
    candidate_id: &str,
    timed_out: bool,
    child_evidence: &CandidateEvidence,
    changed_files: &[String],
    context_packet: &CandidateContextPacket,
    fanout_deadline: Option<Instant>,
) -> ParentValidationResult {
    let output_path = artifact_dir.join("parent-validation.log");
    let Some(primary_selection) =
        candidate_validation::select_scope(child_evidence, changed_files, context_packet)
    else {
        let message = format!(
            "[PARENT_CANDIDATE_VALIDATION] UNAVAILABLE candidate={} timed_out={} scope=none\n",
            candidate_id, timed_out
        );
        if let Err(err) = std::fs::write(&output_path, &message) {
            eprintln!(
                "[CANDIDATE-FANOUT] timeout validation artifact write failed path={} error={}",
                output_path.display(),
                err
            );
        }
        return ParentValidationResult {
            signal: "unavailable".to_string(),
            output: message,
            provenance: None,
        };
    };

    let validation_timeout = remaining_timeout(
        fanout_deadline,
        Duration::from_secs(env_u64(
            "SW_CANDIDATE_TIMEOUT_VALIDATION_SECONDS",
            120,
            15,
            900,
        )),
    );
    let Some(validation_timeout) = validation_timeout else {
        let message = format!(
            "[PARENT_CANDIDATE_VALIDATION] UNAVAILABLE candidate={} timed_out={} scope={} reason=fanout_deadline\n",
            candidate_id, timed_out, primary_selection.desc
        );
        let _ = std::fs::write(&output_path, &message);
        let baseline = validation_oracle::baseline_scope_outcome(&primary_selection.baseline_keys);
        return ParentValidationResult {
            signal: "unavailable".to_string(),
            output: message,
            provenance: Some(candidate_validation::ValidationProvenance {
                candidate_id: candidate_id.to_string(),
                scope_role: primary_selection.role.as_str().to_string(),
                scope: primary_selection.scope,
                scope_desc: primary_selection.desc,
                files: primary_selection.files,
                baseline_keys: primary_selection.baseline_keys,
                baseline,
                signal: "unavailable".to_string(),
                kind: "timeout".to_string(),
                trust_tier: "validation_unavailable".to_string(),
                candidate_blocking: false,
                reason: "fanout deadline reached before parent validation".to_string(),
                command: None,
            }),
        };
    };

    let primary = execute_parent_scope_validation(workdir, primary_selection, validation_timeout);
    let mut signal = primary.assessment.signal.clone();
    let mut aggregate_reason = primary.assessment.decision.reason.clone();
    let mut artifact = format!(
        "[PARENT_CANDIDATE_VALIDATION] candidate={} role={} scope={} timed_out={} signal={} kind={} trust={} blocking={} reason={}\n{}",
        candidate_id,
        primary.selection.role.as_str(),
        primary.selection.desc,
        timed_out,
        signal,
        primary.assessment.kind.as_str(),
        primary.assessment.decision.trust_tier.as_str(),
        primary.assessment.decision.candidate_blocking,
        primary.assessment.decision.reason,
        primary.output
    );

    if primary.selection.role == candidate_validation::ScopeRole::Issue
        && signal == "source_scope_pass"
    {
        if let Some(regression_selection) = candidate_validation::select_regression_scope(
            child_evidence,
            changed_files,
            context_packet,
            &primary.selection.files,
        ) {
            if let Some(regression_timeout) = remaining_timeout(
                fanout_deadline,
                Duration::from_secs(env_u64(
                    "SW_CANDIDATE_REGRESSION_VALIDATION_SECONDS",
                    120,
                    15,
                    900,
                )),
            ) {
                let regression = execute_parent_scope_validation(
                    workdir,
                    regression_selection,
                    regression_timeout,
                );
                artifact.push_str(&format!(
                    "\n[PARENT_REGRESSION_VALIDATION] candidate={} role={} scope={} signal={} kind={} trust={} blocking={} reason={}\n{}",
                    candidate_id,
                    regression.selection.role.as_str(),
                    regression.selection.desc,
                    regression.assessment.signal,
                    regression.assessment.kind.as_str(),
                    regression.assessment.decision.trust_tier.as_str(),
                    regression.assessment.decision.candidate_blocking,
                    regression.assessment.decision.reason,
                    regression.output
                ));
                if regression.assessment.signal == "fail" {
                    signal = "fail".to_string();
                    aggregate_reason = format!(
                        "issue scope repaired, but source-mapped regression scope failed: {}",
                        regression.assessment.decision.reason
                    );
                } else {
                    aggregate_reason = format!(
                        "{}; regression_check={} ({})",
                        aggregate_reason,
                        regression.assessment.signal,
                        regression.assessment.decision.reason
                    );
                }
            } else {
                artifact.push_str(&format!(
                    "\n[PARENT_REGRESSION_VALIDATION] candidate={} signal=unavailable reason=fanout_deadline\n",
                    candidate_id
                ));
                aggregate_reason.push_str("; regression_check=unavailable (fanout deadline)");
            }
        }
    }

    if let Err(err) = std::fs::write(&output_path, &artifact) {
        eprintln!(
            "[CANDIDATE-FANOUT] parent validation artifact write failed path={} error={}",
            output_path.display(),
            err
        );
    }
    ParentValidationResult {
        provenance: Some(candidate_validation::ValidationProvenance {
            candidate_id: candidate_id.to_string(),
            scope_role: primary.selection.role.as_str().to_string(),
            scope: primary.selection.scope,
            scope_desc: primary.selection.desc,
            files: primary.selection.files,
            baseline_keys: primary.selection.baseline_keys,
            baseline: primary.baseline,
            signal: signal.clone(),
            kind: primary.assessment.kind.as_str().to_string(),
            trust_tier: primary.assessment.decision.trust_tier.as_str().to_string(),
            candidate_blocking: signal == "fail",
            reason: aggregate_reason,
            command: primary.command,
        }),
        signal,
        output: artifact,
    }
}

fn execute_parent_scope_validation(
    workdir: &Path,
    selection: candidate_validation::ScopeSelection,
    validation_timeout: Duration,
) -> ExecutedScopeValidation {
    let baseline = validation_oracle::baseline_scope_outcome(&selection.baseline_keys);
    let previous_timeout = std::env::var("SW_TEST_TIMEOUT_SECONDS").ok();
    let previous_stop = std::env::var("SW_TEST_STOP_ON_FAILURE").ok();
    unsafe {
        std::env::set_var(
            "SW_TEST_TIMEOUT_SECONDS",
            validation_timeout.as_secs().max(1).to_string(),
        );
        std::env::set_var("SW_TEST_STOP_ON_FAILURE", "1");
    }
    let changed_before_test = tools::all_diff_stats(&workdir.to_string_lossy());
    let candidate_snapshot = tools::snapshot_all(&workdir.to_string_lossy());
    let output = tools::execute_tool("run_test", &selection.scope, &workdir.to_string_lossy());
    tools::restore_from_snapshot(&workdir.to_string_lossy(), &candidate_snapshot);
    restore_env("SW_TEST_TIMEOUT_SECONDS", previous_timeout);
    restore_env("SW_TEST_STOP_ON_FAILURE", previous_stop);

    let assessment = candidate_validation::assess_against_baseline(
        &output,
        &changed_before_test,
        &selection.baseline_keys,
        baseline.as_ref(),
    );
    let command = validation_command_line(&output);
    ExecutedScopeValidation {
        selection,
        baseline,
        assessment,
        output,
        command,
    }
}

fn validation_command_line(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("command: ")
            .map(str::trim)
            .filter(|command| !command.is_empty())
            .map(ToString::to_string)
    })
}

fn remaining_timeout(deadline: Option<Instant>, requested: Duration) -> Option<Duration> {
    let Some(deadline) = deadline else {
        return Some(requested);
    };
    let remaining = deadline.checked_duration_since(Instant::now())?;
    if remaining.is_zero() {
        None
    } else {
        Some(requested.min(remaining))
    }
}

fn candidate_needs_parent_validation(stdout: &str) -> bool {
    matches!(
        candidate_validation_signal(stdout).as_str(),
        "source_scope_pass" | "regression_pass" | "feedback_pass" | "unavailable" | "none"
    )
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

struct ChildMachine {
    variant: String,
    force_hardcoded: bool,
}

#[allow(clippy::too_many_arguments)]
fn candidate_command(
    config: &Config,
    invocation: &AgentInvocation,
    hypothesis: &CandidateHypothesis,
    workdir: &Path,
    artifact_dir: &Path,
    task: &str,
    max_steps: u32,
    max_retries: u32,
    child_machine: &ChildMachine,
) -> Command {
    let mut cmd = Command::new(&invocation.executable);
    let child_use_hardcoded = child_machine.force_hardcoded || invocation.use_hardcoded_machine;
    cmd.arg("--task")
        .arg(task)
        .arg("--workdir")
        .arg(workdir)
        .arg("--ollama-url")
        .arg(&invocation.ollama_url)
        .arg("--model")
        .arg(&invocation.model)
        .arg("--max-retries")
        .arg(max_retries.to_string())
        .arg("--max-steps")
        .arg(max_steps.to_string())
        .arg("--hardcoded-machine")
        .arg(&child_machine.variant)
        .arg("--tool-mode")
        .arg(&invocation.tool_mode)
        .arg("--model-size")
        .arg(invocation.model_size.to_string())
        .arg("--no-restore");
    if child_use_hardcoded {
        cmd.arg("--use-hardcoded-machine");
    }
    if let Some(config_path) = &invocation.config_path {
        cmd.arg("--config").arg(config_path);
    }
    cmd.env("SW_CANDIDATE_FANOUT", "0")
        .env("SW_CANDIDATE_FANOUT_CHILD", "1")
        .env(
            "SW_CANDIDATE_FANOUT_DEPTH",
            config.child_depth.saturating_add(1).to_string(),
        )
        .env(
            "SW_CANDIDATE_FANOUT_MAX_DEPTH",
            config.max_depth.to_string(),
        )
        .env(
            "SW_CANDIDATE_FANOUT_PARENT_PID",
            std::process::id().to_string(),
        )
        .env("SW_SCOUT_FANOUT", "0")
        .env("SW_SCOUT_LANE_ESCALATION", "0")
        .env(
            "SW_SPEED_SOLVER",
            bool_string(config.child_profile.eq_ignore_ascii_case("speed")),
        )
        .env("SW_HARDCODED_MACHINE", &child_machine.variant)
        .env("SW_CANDIDATE_FANOUT_CHILD_PROFILE", &config.child_profile)
        .env("SW_CANDIDATE_FANOUT_CHILD_MACHINE", &child_machine.variant)
        .env(
            "SW_CANDIDATE_FANOUT_CONTEXT_PUMP",
            bool_string(config.context_pump),
        )
        .env(
            "SW_CANDIDATE_FANOUT_HYPOTHESIS_ID",
            hypothesis.id.to_string(),
        )
        .env("SW_CANDIDATE_FANOUT_HYPOTHESIS_PATH", &hypothesis.path)
        .env(
            "SW_CANDIDATE_FANOUT_HYPOTHESIS_SCORE",
            hypothesis.score.to_string(),
        )
        .env("SW_CANDIDATE_FANOUT_HYPOTHESIS_REASON", &hypothesis.reason)
        .env("SW_ARTIFACT_DIR", artifact_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

fn child_machine_variant(config: &Config, invocation: &AgentInvocation) -> ChildMachine {
    let requested = config.child_machine.trim();
    if requested.is_empty()
        || requested.eq_ignore_ascii_case("inherit")
        || requested.eq_ignore_ascii_case("parent")
    {
        ChildMachine {
            variant: invocation.hardcoded_machine.clone(),
            force_hardcoded: false,
        }
    } else {
        ChildMachine {
            variant: requested.to_string(),
            force_hardcoded: true,
        }
    }
}

fn speed_solver_task(
    original_task: &str,
    config: &Config,
    hypothesis: &CandidateHypothesis,
    candidate_id: &str,
    child_max_retries: u32,
    context_packet: &CandidateContextPacket,
) -> String {
    format!(
        "{original_task}\n\n## Candidate Speed Solver Packet\n\
You are child candidate `{candidate_id}` in a benchmark-clean patch tournament. \
Your parent will compare generated source patches using harness-visible telemetry only; \
official SWE-bench verification remains the only solve authority.\n\n\
Forced source hypothesis:\n\
- path: `{}`\n\
- score: {}\n\
- reason: {}\n\n\
Execution contract:\n\
- Profile: `{}`.\n\
- Step budget: {} steps, {} state-machine retry attempt(s), {}s wall timeout.\n\
- Treat the typed parent evidence packet below as ranked starting evidence, not proof; validate it against public repo code and harness-visible test telemetry.\n\
- Read the forced path first. Make one minimal source-only patch unless concrete source evidence proves this path cannot be the bug locus.\n\
- Do not edit tests, generated localization assets, benchmark harness files, or unrelated files.\n\
- If validation telemetry is unavailable, still leave the smallest defensible source patch for parent scoring; do not loop trying broad/full-suite variants.\n\
- If syntax, collection, or import feedback appears after your edit, repair that patch once instead of switching hypotheses.\n\n\
{}\n",
        hypothesis.path,
        hypothesis.score,
        hypothesis.reason,
        config.child_profile,
        config.child_max_steps,
        child_max_retries,
        config.child_timeout_seconds,
        context_packet.render()
    )
}

async fn arbitrate_candidate_selection(
    invocation: &AgentInvocation,
    executions: &[CandidateExecution],
    candidate_indices: &[usize],
    artifact_dir: &Path,
) -> ArbiterReport {
    let prompt = arbitration_prompt(&invocation.task, executions, candidate_indices);
    let client = OllamaClient::new(OllamaConfig {
        api_url: invocation.ollama_url.clone(),
        model: invocation.model.clone(),
        temperature: 0.0,
        max_tokens: 512,
        thinking_level: None,
    });
    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: "You are a benchmark-clean candidate patch arbiter. Choose the best generated source patch using only the provided problem statement, candidate diffs, and harness-visible telemetry. Do not assume hidden tests or official solution details. Return JSON only.".into(),
        },
        ChatMessage {
            role: "user".into(),
            content: prompt,
        },
    ];

    let response = match client.chat(messages).await {
        Ok(response) => response,
        Err(err) => {
            let report = ArbiterReport {
                artifact: "statewright.candidate_fanout.arbiter",
                status: "error".to_string(),
                selected_candidate_id: None,
                confidence: None,
                reason: err.to_string(),
                concerns: vec!["arbiter call failed".to_string()],
                raw_response: None,
                fallback_candidate_id: None,
            };
            write_json_path_or_event(
                artifact_dir,
                &artifact_dir.join("candidate-fanout-arbiter.json"),
                &report,
                "arbiter_error_artifact_write_failed",
            );
            return report;
        }
    };
    let selected = parse_arbiter_candidate_id(&response);
    let reason = parse_arbiter_reason(&response).unwrap_or_else(|| response.clone());
    let confidence = parse_arbiter_confidence(&response);
    let concerns = parse_arbiter_concerns(&response);
    let report = ArbiterReport {
        artifact: "statewright.candidate_fanout.arbiter",
        status: if selected.is_some() {
            "selected".to_string()
        } else {
            "invalid_response".to_string()
        },
        selected_candidate_id: selected,
        confidence,
        reason,
        concerns,
        raw_response: Some(response),
        fallback_candidate_id: None,
    };
    write_json_path_or_event(
        artifact_dir,
        &artifact_dir.join("candidate-fanout-arbiter.json"),
        &report,
        "arbiter_response_artifact_write_failed",
    );
    report
}

fn arbitration_prompt(
    task: &str,
    executions: &[CandidateExecution],
    candidate_indices: &[usize],
) -> String {
    let mut prompt = String::new();
    prompt.push_str("Select the best candidate patch. If there is no clear winner, still choose the candidate you would apply, set confidence to low, and explain the risk.\n\n");
    prompt.push_str("Return JSON only, replacing the placeholder with an exact candidate ID shown below: {\"candidate_id\":\"<exact candidate ID>\",\"confidence\":\"high|medium|low\",\"reason\":\"short benchmark-clean reason\",\"concerns\":[\"short concern\"]}\n\n");
    prompt.push_str("Selection rules:\n");
    prompt.push_str("- Prefer the patch most directly tied to the issue behavior.\n");
    prompt.push_str("- Prefer smaller source-only patches when confidence is similar.\n");
    prompt.push_str("- If candidates are otherwise tied, prefer the patch closest to the median changed-line count across candidate diffs; avoid both trivial one-line guesses and broad rewrites.\n");
    prompt.push_str("- Treat source_scope_pass as useful source-derived scoped evidence, not final verification proof.\n");
    prompt.push_str("- Treat regression_pass only as evidence that a baseline-passing public scope did not regress; it is not evidence that the issue was repaired.\n");
    prompt.push_str("- Prefer stronger validation when patches are otherwise comparable, but if every candidate is feedback-only, unavailable, or none, choose the cleanest issue-grounded source patch and mark confidence low.\n");
    prompt.push_str("- Do reject candidates that look unrelated, overbroad, or unsupported by their own diff/telemetry.\n\n");
    prompt.push_str("Problem statement:\n");
    prompt.push_str(&compact_block(task, 2400));
    prompt.push_str("\n\nCandidates:\n");
    let median_x2 = median_changed_lines_x2(executions, candidate_indices);
    for index in candidate_indices {
        let execution = &executions[*index];
        let quality = patch_quality_assessment(execution);
        let median_detail = median_x2
            .map(|median_x2| {
                format!(
                    "median={}, distance_x2={}",
                    format_median_x2(median_x2),
                    median_changed_lines_distance_x2(execution.changed_lines, median_x2)
                )
            })
            .unwrap_or_else(|| "median=unavailable".to_string());
        prompt.push_str(&format!(
            "\n## Candidate `{}`\n- hypothesis path: `{}`\n- hypothesis score: {}\n- heuristic score: {}\n- candidate validation signal: {}\n- quality penalty: {}\n- quality flags: {}\n- changed files: {}\n- changed lines: {} ({})\n- child exit: {:?}, timeout: {}\n- hypothesis reason: {}\n\nDiff excerpt:\n```diff\n{}\n```\n",
            execution.candidate_id,
            execution.hypothesis.path,
            execution.hypothesis.score,
            score_execution(execution),
            candidate_validation_signal(&execution.stdout),
            quality.penalty,
            format_quality_flags(&quality.flags),
            if execution.changed_files.is_empty() {
                "<none>".to_string()
            } else {
                execution.changed_files.join(", ")
            },
            execution.changed_lines,
            median_detail,
            execution.exit_code,
            execution.timed_out,
            compact_one_line(&execution.hypothesis.reason, 240),
            compact_block(&execution.patch, 2200)
        ));
    }
    prompt
}

fn parse_arbiter_candidate_id(response: &str) -> Option<String> {
    parse_arbiter_json_field(response, "candidate_id")
        .or_else(|| parse_arbiter_json_field(response, "selected_candidate_id"))
        .or_else(|| {
            response
                .split(|ch: char| {
                    ch.is_whitespace() || matches!(ch, '"' | '\'' | ',' | ':' | '{' | '}')
                })
                .find(|token| {
                    token.len() > 1
                        && token.starts_with('h')
                        && token[1..].chars().all(|ch| ch.is_ascii_digit())
                })
                .map(|token| token.to_string())
        })
}

fn parse_arbiter_reason(response: &str) -> Option<String> {
    parse_arbiter_json_field(response, "reason")
}

fn parse_arbiter_confidence(response: &str) -> Option<String> {
    parse_arbiter_json_field(response, "confidence").map(|value| {
        let lower = value.to_ascii_lowercase();
        if matches!(lower.as_str(), "high" | "medium" | "low") {
            lower
        } else {
            value
        }
    })
}

fn parse_arbiter_concerns(response: &str) -> Vec<String> {
    let value: Option<serde_json::Value> = serde_json::from_str(response).ok().or_else(|| {
        let start = response.find('{')?;
        let end = response.rfind('}')?;
        serde_json::from_str(&response[start..=end]).ok()
    });
    let Some(value) = value else {
        return Vec::new();
    };
    match value.get("concerns") {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
            .collect(),
        Some(serde_json::Value::String(item)) => item
            .split(';')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_arbiter_json_field(response: &str, field: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(response).ok().or_else(|| {
        let start = response.find('{')?;
        let end = response.rfind('}')?;
        serde_json::from_str(&response[start..=end]).ok()
    })?;
    value
        .get(field)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn compact_one_line(value: &str, limit: usize) -> String {
    compact_block(value, limit)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn compact_block(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut truncated: String = value.chars().take(limit).collect();
    truncated.push_str("\n...[truncated]");
    truncated
}

struct ChildOutput {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
}

fn terminate_child_group(child: &mut Child) {
    unsafe {
        if libc::killpg(child.id() as i32, libc::SIGKILL) != 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::ESRCH) {
                eprintln!("[CANDIDATE-FANOUT] process group kill failed: {err}");
            }
        }
    }
    if let Err(err) = child.kill() {
        if err.kind() != std::io::ErrorKind::InvalidInput {
            eprintln!("[CANDIDATE-FANOUT] child kill failed: {err}");
        }
    }
    if let Err(err) = child.wait() {
        eprintln!("[CANDIDATE-FANOUT] child wait failed: {err}");
    }
}

fn run_child_with_timeout(
    mut command: Command,
    timeout: Duration,
    candidate_id: &str,
) -> Result<ChildOutput, String> {
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|err| format!("run candidate {}: {err}", candidate_id))?;

    let (tx, rx) = mpsc::channel::<(bool, String)>();
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let tx = tx.clone();
        readers.push(thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send((false, line)).is_err() {
                    eprintln!(
                        "[CANDIDATE-FANOUT] stdout receiver closed while reading child output"
                    );
                    break;
                }
            }
        }));
    }
    if let Some(stderr) = child.stderr.take() {
        let tx = tx.clone();
        readers.push(thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if tx.send((true, line)).is_err() {
                    eprintln!(
                        "[CANDIDATE-FANOUT] stderr receiver closed while reading child output"
                    );
                    break;
                }
            }
        }));
    }
    drop(tx);

    let started = Instant::now();
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = None;
    let mut timed_out = false;

    loop {
        while let Ok((is_stderr, line)) = rx.try_recv() {
            if is_stderr {
                stderr.push_str(&line);
                stderr.push('\n');
            } else {
                stdout.push_str(&line);
                stdout.push('\n');
            }
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code();
                break;
            }
            Ok(None) => {}
            Err(err) => return Err(format!("wait candidate {}: {err}", candidate_id)),
        }

        if started.elapsed() >= timeout {
            timed_out = true;
            terminate_child_group(&mut child);
            break;
        }

        thread::sleep(Duration::from_millis(100));
    }

    while let Ok((is_stderr, line)) = rx.try_recv() {
        if is_stderr {
            stderr.push_str(&line);
            stderr.push('\n');
        } else {
            stdout.push_str(&line);
            stdout.push('\n');
        }
    }
    for reader in readers {
        if reader.join().is_err() {
            eprintln!("[CANDIDATE-FANOUT] output reader thread panicked");
        }
    }

    if timed_out {
        stderr.push_str(&format!(
            "[CANDIDATE-FANOUT] TIMEOUT candidate={} timeout_s={}\n",
            candidate_id,
            timeout.as_secs()
        ));
    }

    Ok(ChildOutput {
        stdout,
        stderr,
        exit_code,
        timed_out,
    })
}

fn write_plan(
    artifact_dir: &Path,
    config: &Config,
    hypotheses: &[CandidateHypothesis],
    local_work_root: &Path,
) -> Result<(), String> {
    write_json_path(
        &artifact_dir.join("candidate-fanout-plan.json"),
        &FanoutPlan {
            schema_version: 1,
            artifact: "statewright.candidate_fanout.plan",
            mode: "logical_parallel",
            benchmark_clean: true,
            scoring_boundary: "Candidate fanout ranks generated patches with harness-visible telemetry only; official SWE-bench verification remains the only solve authority.",
            process_depth: config.child_depth,
            spawned_child_depth: config.child_depth.saturating_add(1),
            max_depth: config.max_depth,
            parent_pid: config.parent_pid.clone(),
            candidate_count: hypotheses.len(),
            concurrency: config.concurrency,
            child_max_steps: config.child_max_steps,
            child_timeout_seconds: config.child_timeout_seconds,
            fanout_wall_seconds: config.fanout_wall_seconds,
            timeout_stop_count: config.timeout_stop_count,
            child_max_retries: config.child_max_retries,
            child_profile: config.child_profile.clone(),
            child_machine: config.child_machine.clone(),
            context_pump: config.context_pump,
            strengthening_enabled: config.strengthening.enabled,
            strengthening_steps: config.strengthening.steps,
            strengthening_timeout_seconds: config.strengthening.timeout.as_secs(),
            local_work_root: local_work_root.display().to_string(),
            hypotheses: hypotheses.to_vec(),
        },
    )
}

fn write_selection(artifact_dir: &Path, report: FanoutSelectionReport) -> Result<(), String> {
    write_json_path(
        &artifact_dir.join("candidate-fanout-selection.json"),
        &report,
    )
}

fn append_event(artifact_dir: &Path, value: serde_json::Value) {
    let path = artifact_dir.join("candidate-fanout-events.jsonl");
    let mut file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        Ok(file) => file,
        Err(err) => {
            eprintln!("  [CANDIDATE-FANOUT] event open failed: {err}");
            return;
        }
    };
    let line = match serde_json::to_string(&value) {
        Ok(line) => line,
        Err(err) => {
            eprintln!("  [CANDIDATE-FANOUT] event serialize failed: {err}");
            return;
        }
    };
    if let Err(err) = writeln!(file, "{line}") {
        eprintln!("  [CANDIDATE-FANOUT] event write failed: {err}");
    }
}

fn write_json_path_or_event<T: Serialize>(
    artifact_dir: &Path,
    path: &Path,
    value: &T,
    failure_event: &str,
) {
    if let Err(err) = write_json_path(path, value) {
        eprintln!(
            "  [CANDIDATE-FANOUT] artifact write failed path={} error={}",
            path.display(),
            err
        );
        append_event(
            artifact_dir,
            serde_json::json!({
                "event": failure_event,
                "path": path.display().to_string(),
                "error": err,
            }),
        );
    }
}

fn report_for_execution(execution: &CandidateExecution) -> CandidateRunReport {
    let rejection_reasons = candidate_rejection_reasons(execution);
    let quality = patch_quality_assessment(execution);
    let patch_hash = if execution.patch.trim().is_empty() {
        None
    } else {
        Some(stable_hash(&execution.patch))
    };
    CandidateRunReport {
        candidate_id: execution.candidate_id.clone(),
        hypothesis_id: execution.hypothesis.id,
        path: execution.actual_locus.clone(),
        score: score_execution(execution),
        accepted: rejection_reasons.is_empty(),
        rejection_reasons,
        patch_path: if execution.patch.trim().is_empty() {
            None
        } else {
            Some(format!("candidates/{}/diff.patch", execution.candidate_id))
        },
        patch_hash,
        changed_files: execution.changed_files.clone(),
        changed_lines: execution.changed_lines,
        quality_penalty: quality.penalty,
        quality_flags: quality.flags,
        final_verification_signal: final_verification_signal(&execution.stdout),
        candidate_validation_signal: candidate_validation_signal(&execution.stdout),
        parent_validation_signal: parent_validation_signal(&execution.stdout),
        parent_validation_provenance: execution.parent_validation_provenance.clone(),
        parent_validation_excerpt: (!execution.parent_validation_output.trim().is_empty())
            .then(|| compact_block(&execution.parent_validation_output, 2_000)),
        timeout_validation_signal: if execution.timed_out {
            parent_validation_signal(&execution.stdout)
        } else {
            None
        },
        exit_code: execution.exit_code,
        duration_ms: execution.duration_ms,
        timed_out: execution.timed_out,
        materialization: execution.materialization.clone(),
        evidence: execution.evidence.clone(),
        launched_path: execution.hypothesis.path.clone(),
        issue_locus_aligned: execution.issue_locus_aligned,
        strengthening_attempted: execution.strengthening_attempted,
        strengthening_signal: execution.strengthening_signal.clone(),
    }
}

fn candidate_is_selectable(execution: &CandidateExecution) -> bool {
    candidate_rejection_reasons(execution).is_empty()
}

fn candidate_rejection_reasons(execution: &CandidateExecution) -> Vec<String> {
    let mut rejection_reasons = Vec::new();
    if execution.patch.trim().is_empty() {
        rejection_reasons.push("empty_patch".to_string());
    }
    if !candidate_has_authoritative_source_patch(execution) {
        rejection_reasons.push("non_authoritative_patch_path".to_string());
    }
    if execution.timed_out && execution.patch.trim().is_empty() {
        rejection_reasons.push("candidate_timeout".to_string());
    }
    if execution
        .changed_files
        .iter()
        .any(|path| is_test_path(path))
    {
        rejection_reasons.push("test_file_touched".to_string());
    }
    if execution_has_syntax_failure(execution) {
        rejection_reasons.push("syntax_error_signal".to_string());
    }
    if execution_has_collection_failure(execution) {
        rejection_reasons.push("collection_error_signal".to_string());
    }
    if execution_final_verification_failed(execution) {
        rejection_reasons.push("final_verification_failed".to_string());
    }
    if execution_validation_did_not_run(execution) {
        rejection_reasons.push("validation_did_not_run".to_string());
    }
    rejection_reasons
}

fn execution_output_contains_any(execution: &CandidateExecution, needles: &[&str]) -> bool {
    needles.iter().any(|needle| {
        execution.stdout.contains(needle)
            || execution.stderr.contains(needle)
            || execution.parent_validation_output.contains(needle)
    })
}

fn execution_has_syntax_failure(execution: &CandidateExecution) -> bool {
    execution_output_contains_any(execution, &["SyntaxError", "IndentationError", "TabError"])
}

fn execution_has_collection_failure(execution: &CandidateExecution) -> bool {
    execution_output_contains_any(
        execution,
        &[
            "SW_TEST_EXIT_CODE=4",
            "exit: Some(4)",
            "ERROR collecting",
            "errors during collection",
            "ImportError while loading conftest",
            "ModuleNotFoundError",
            "ImportError:",
        ],
    )
}

fn execution_has_post_edit_repair_failure(execution: &CandidateExecution) -> bool {
    execution_output_contains_any(
        execution,
        &["[POST_EDIT_REPAIR] FAIL", "[SOURCE_SCOPE_REPAIR] FAIL"],
    )
}

fn execution_final_verification_failed(execution: &CandidateExecution) -> bool {
    candidate_validation_signal(&execution.stdout) == "fail"
}

fn execution_validation_did_not_run(execution: &CandidateExecution) -> bool {
    execution_output_contains_any(
        execution,
        &[
            "SW_TEST_EXIT_CODE=5",
            "exit: Some(5)",
            "no tests ran",
            "no tests collected",
            "collected 0 items",
            "did not run any tests",
        ],
    )
}

fn ranked_selectable_candidate_indices(executions: &[CandidateExecution]) -> Vec<usize> {
    let mut indices: Vec<usize> = executions
        .iter()
        .enumerate()
        .filter_map(|(index, execution)| candidate_is_selectable(execution).then_some(index))
        .collect();
    let median_x2 = median_changed_lines_x2(executions, &indices);
    indices.sort_by(|left, right| {
        compare_execution_rank(&executions[*left], &executions[*right], median_x2)
    });
    indices
}

fn selection_needs_arbitration(
    executions: &[CandidateExecution],
    ranked_indices: &[usize],
    margin: i32,
) -> bool {
    if ranked_indices.len() < 2 {
        return false;
    }
    let top = &executions[ranked_indices[0]];
    let runner_up = &executions[ranked_indices[1]];
    if candidate_validation_signal(&top.stdout) == "pass"
        && candidate_validation_signal(&runner_up.stdout) != "pass"
    {
        return false;
    }
    let top_signal = candidate_validation_signal(&top.stdout);
    let runner_up_signal = candidate_validation_signal(&runner_up.stdout);
    if matches!(top_signal.as_str(), "unavailable" | "none")
        && matches!(runner_up_signal.as_str(), "unavailable" | "none")
    {
        return true;
    }
    score_execution(top).saturating_sub(score_execution(runner_up)) <= margin
}

fn compare_execution_rank(
    left: &CandidateExecution,
    right: &CandidateExecution,
    median_x2: Option<usize>,
) -> Ordering {
    score_execution(right)
        .cmp(&score_execution(left))
        .then_with(|| match median_x2 {
            Some(median_x2) => median_changed_lines_distance_x2(left.changed_lines, median_x2).cmp(
                &median_changed_lines_distance_x2(right.changed_lines, median_x2),
            ),
            None => Ordering::Equal,
        })
        .then_with(|| {
            patch_quality_assessment(left)
                .penalty
                .cmp(&patch_quality_assessment(right).penalty)
        })
        .then_with(|| right.hypothesis.score.cmp(&left.hypothesis.score))
        .then_with(|| left.changed_lines.cmp(&right.changed_lines))
        .then_with(|| left.candidate_id.cmp(&right.candidate_id))
}

fn median_diff_tiebreak_index(
    executions: &[CandidateExecution],
    indices: &[usize],
) -> Option<usize> {
    let median_x2 = median_changed_lines_x2(executions, indices)?;
    indices.iter().copied().min_by(|left, right| {
        compare_median_diff_tiebreak(&executions[*left], &executions[*right], median_x2)
    })
}

fn compare_median_diff_tiebreak(
    left: &CandidateExecution,
    right: &CandidateExecution,
    median_x2: usize,
) -> Ordering {
    median_changed_lines_distance_x2(left.changed_lines, median_x2)
        .cmp(&median_changed_lines_distance_x2(
            right.changed_lines,
            median_x2,
        ))
        .then_with(|| {
            patch_quality_assessment(left)
                .penalty
                .cmp(&patch_quality_assessment(right).penalty)
        })
        .then_with(|| score_execution(right).cmp(&score_execution(left)))
        .then_with(|| right.hypothesis.score.cmp(&left.hypothesis.score))
        .then_with(|| left.changed_lines.cmp(&right.changed_lines))
        .then_with(|| left.candidate_id.cmp(&right.candidate_id))
}

fn median_changed_lines_x2(executions: &[CandidateExecution], indices: &[usize]) -> Option<usize> {
    let mut sizes: Vec<usize> = indices
        .iter()
        .filter_map(|index| {
            let changed_lines = executions.get(*index)?.changed_lines;
            (changed_lines > 0).then_some(changed_lines)
        })
        .collect();
    if sizes.is_empty() {
        return None;
    }
    sizes.sort_unstable();
    let mid = sizes.len() / 2;
    if sizes.len() % 2 == 1 {
        Some(sizes[mid] * 2)
    } else {
        Some(sizes[mid - 1] + sizes[mid])
    }
}

fn median_changed_lines_distance_x2(changed_lines: usize, median_x2: usize) -> usize {
    (changed_lines * 2).abs_diff(median_x2)
}

fn format_median_x2(median_x2: usize) -> String {
    if median_x2 % 2 == 0 {
        (median_x2 / 2).to_string()
    } else {
        format!("{}.5", median_x2 / 2)
    }
}

fn static_risk_tiebreak_index(
    executions: &[CandidateExecution],
    indices: &[usize],
) -> Option<usize> {
    indices
        .iter()
        .copied()
        .min_by(|left, right| compare_static_risk_tiebreak(&executions[*left], &executions[*right]))
}

fn compare_static_risk_tiebreak(left: &CandidateExecution, right: &CandidateExecution) -> Ordering {
    let left_signal = candidate_validation_signal(&left.stdout);
    let right_signal = candidate_validation_signal(&right.stdout);
    validation_signal_rank(&right_signal)
        .cmp(&validation_signal_rank(&left_signal))
        .then_with(|| candidate_path_aligned(right).cmp(&candidate_path_aligned(left)))
        .then_with(|| {
            patch_quality_assessment(left)
                .penalty
                .cmp(&patch_quality_assessment(right).penalty)
        })
        .then_with(|| left.timed_out.cmp(&right.timed_out))
        .then_with(|| left.changed_lines.cmp(&right.changed_lines))
        .then_with(|| score_execution(right).cmp(&score_execution(left)))
        .then_with(|| right.hypothesis.score.cmp(&left.hypothesis.score))
        .then_with(|| left.candidate_id.cmp(&right.candidate_id))
}

fn static_risk_tiebreak_detail(
    _executions: &[CandidateExecution],
    selected: &CandidateExecution,
    _indices: &[usize],
) -> String {
    let quality = patch_quality_assessment(selected);
    format!(
        "static_risk_tiebreak validation={} path_aligned={} changed_lines={} quality_penalty={} quality_flags={} timed_out={}",
        candidate_validation_signal(&selected.stdout),
        candidate_path_aligned(selected),
        selected.changed_lines,
        quality.penalty,
        format_quality_flags(&quality.flags),
        selected.timed_out
    )
}

fn selection_allowed_to_apply(config: &Config, execution: &CandidateExecution) -> bool {
    if !candidate_is_selectable(execution) {
        return false;
    }
    if !config.require_strong_selection {
        return true;
    }
    early_lane_static_selection_allowed(execution)
}

fn early_lane_static_selection_allowed(execution: &CandidateExecution) -> bool {
    match candidate_validation_signal(&execution.stdout).as_str() {
        "pass" => return candidate_has_authoritative_source_patch(execution),
        "source_scope_pass" => return clean_source_candidate(execution, true),
        "regression_pass" => return clean_source_candidate(execution, false),
        "fail" => return false,
        _ => {}
    }

    clean_source_candidate(execution, false)
}

fn clean_source_candidate(execution: &CandidateExecution, allow_timeout: bool) -> bool {
    !execution.patch.trim().is_empty()
        && (allow_timeout || !execution.timed_out)
        && candidate_path_aligned(execution)
        && patch_quality_assessment(execution).penalty == 0
        && execution.changed_lines > 0
        && execution.changed_lines <= 48
        && !execution_has_syntax_failure(execution)
        && !execution_has_collection_failure(execution)
        && !execution_validation_did_not_run(execution)
        && candidate_has_authoritative_source_patch(execution)
        && !execution
            .changed_files
            .iter()
            .any(|path| is_test_path(path))
}

fn arbiter_selection_allowed(selected: &CandidateExecution, fallback: &CandidateExecution) -> bool {
    if !candidate_is_selectable(selected) {
        return false;
    }
    if !candidate_is_selectable(fallback) {
        return true;
    }
    let selected_signal = candidate_validation_signal(&selected.stdout);
    let fallback_signal = candidate_validation_signal(&fallback.stdout);
    let selected_signal_rank = validation_signal_rank(&selected_signal);
    let fallback_signal_rank = validation_signal_rank(&fallback_signal);
    if selected_signal_rank > fallback_signal_rank {
        return true;
    }
    if selected_signal_rank < fallback_signal_rank {
        return false;
    }

    let selected_quality = patch_quality_assessment(selected);
    let fallback_quality = patch_quality_assessment(fallback);
    if selected_quality.penalty > fallback_quality.penalty {
        return false;
    }
    if fallback_quality.penalty > selected_quality.penalty {
        return true;
    }
    if candidate_path_aligned(fallback) && !candidate_path_aligned(selected) {
        return false;
    }
    if candidate_path_aligned(selected) && !candidate_path_aligned(fallback) {
        return true;
    }
    if selected_signal_rank <= 1
        && selected.changed_lines > fallback.changed_lines.saturating_add(8)
    {
        return false;
    }
    true
}

fn candidate_path_aligned(execution: &CandidateExecution) -> bool {
    execution.issue_locus_aligned
}

fn candidate_issue_locus_aligned(
    changed_files: &[String],
    launched_path: &str,
    context_packet: &CandidateContextPacket,
) -> bool {
    changed_files.iter().any(|path| {
        !is_test_path(path)
            && (repo_paths_equal(path, launched_path) || context_packet.ranks_source_path(path))
    })
}

fn repo_paths_equal(left: &str, right: &str) -> bool {
    left.trim().trim_start_matches("./") == right.trim().trim_start_matches("./")
}

fn candidate_has_authoritative_source_patch(execution: &CandidateExecution) -> bool {
    patch_authority::patch_has_authoritative_source(
        &execution.changed_files,
        execution.changed_lines,
    )
}

fn validation_signal_rank(signal: &str) -> i32 {
    match signal {
        "pass" => 4,
        "source_scope_pass" => 3,
        "regression_pass" => 2,
        "feedback_pass" => 1,
        "unavailable" | "none" => 1,
        "fail" => 0,
        _ => 1,
    }
}

fn score_execution(execution: &CandidateExecution) -> i32 {
    if !candidate_is_selectable(execution) {
        return -1000;
    }
    score_execution_without_strict_validation(execution)
}

fn score_execution_without_strict_validation(execution: &CandidateExecution) -> i32 {
    if execution.patch.trim().is_empty()
        || execution
            .changed_files
            .iter()
            .any(|path| is_test_path(path))
        || !candidate_has_authoritative_source_patch(execution)
        || execution_has_syntax_failure(execution)
        || execution_has_collection_failure(execution)
        || execution_final_verification_failed(execution)
        || execution_validation_did_not_run(execution)
    {
        return -1000;
    }
    let mut score = execution.hypothesis.score.min(200) as i32;
    score += 30;
    match candidate_validation_signal(&execution.stdout).as_str() {
        "pass" => score += 120,
        "source_scope_pass" => score += 60,
        "regression_pass" => score += 30,
        "feedback_pass" => score += 25,
        "unavailable" | "none" => score -= 45,
        _ => {}
    }
    if candidate_path_aligned(execution) {
        score += 30;
    }
    if execution
        .changed_files
        .iter()
        .any(|path| is_test_path(path))
    {
        score -= 80;
    }
    if execution.stdout.contains("ModuleNotFoundError") || execution.stdout.contains("ImportError")
    {
        score -= 20;
    }
    if execution.timed_out {
        score -= 10;
    }
    if execution_has_post_edit_repair_failure(execution) {
        score -= 10;
    }
    score -= patch_quality_assessment(execution).penalty;
    score -= (execution.changed_lines as i32).min(80);
    score
}

fn final_verification_signal(stdout: &str) -> String {
    if stdout.contains("[FINAL_VERIFICATION] PASS") {
        "pass".to_string()
    } else if stdout.contains("[FINAL_VERIFICATION] FAIL") {
        "fail".to_string()
    } else if stdout.contains("[FINAL_VERIFICATION] UNAVAILABLE") {
        "unavailable".to_string()
    } else {
        "none".to_string()
    }
}

fn parent_validation_signal(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .rev()
        .find_map(|line| {
            let line = line.trim();
            line.strip_prefix("[PARENT_CANDIDATE_VALIDATION] SIGNAL=")
                .or_else(|| line.strip_prefix("[PARENT_TIMEOUT_VALIDATION] SIGNAL="))
        })
        .map(str::trim)
        .filter(|signal| !signal.is_empty())
        .map(ToString::to_string)
}

fn candidate_validation_signal(stdout: &str) -> String {
    CandidateEvidence::from_output(stdout)
        .selection_signal()
        .to_string()
}

fn materialize_workdir(
    parent_workdir: &str,
    child_workdir: &Path,
) -> Result<MaterializationReport, String> {
    if child_workdir.exists() {
        std::fs::remove_dir_all(child_workdir).map_err(|err| {
            format!(
                "remove stale child workdir {}: {err}",
                child_workdir.display()
            )
        })?;
    }
    let protected_artifacts = validation_oracle::protected_setup_artifacts();
    if try_git_worktree(parent_workdir, child_workdir)? {
        let copied = copy_protected_setup_artifacts(
            Path::new(parent_workdir),
            child_workdir,
            &protected_artifacts,
        )?;
        return Ok(MaterializationReport {
            mode: MaterializationMode::GitWorktreeWithPreparedArtifacts,
            protected_artifacts_requested: protected_artifacts.len(),
            protected_artifacts_copied: copied,
        });
    }
    copy_dir(Path::new(parent_workdir), child_workdir)?;
    let copied = copy_protected_setup_artifacts(
        Path::new(parent_workdir),
        child_workdir,
        &protected_artifacts,
    )?;
    Ok(MaterializationReport {
        mode: MaterializationMode::PreparedTreeCopy,
        protected_artifacts_requested: protected_artifacts.len(),
        protected_artifacts_copied: copied,
    })
}

fn copy_protected_setup_artifacts(
    parent_workdir: &Path,
    child_workdir: &Path,
    artifacts: &[String],
) -> Result<usize, String> {
    let mut copied = 0;
    for artifact in artifacts {
        let relative = Path::new(artifact);
        if relative.is_absolute()
            || relative.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(format!("invalid protected setup artifact path: {artifact}"));
        }
        let source = parent_workdir.join(relative);
        if !source.exists() && !source.is_symlink() {
            return Err(format!(
                "protected setup artifact missing from prepared parent: {}",
                source.display()
            ));
        }
        copy_prepared_path(&source, &child_workdir.join(relative))?;
        copied += 1;
    }
    Ok(copied)
}

fn copy_prepared_path(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(source)
        .map_err(|err| format!("inspect prepared artifact {}: {err}", source.display()))?;
    if metadata.file_type().is_symlink() {
        if target.exists() || target.is_symlink() {
            remove_existing_path(target)?;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("create prepared parent {}: {err}", parent.display()))?;
        }
        let link = std::fs::read_link(source)
            .map_err(|err| format!("read prepared symlink {}: {err}", source.display()))?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(link, target)
            .map_err(|err| format!("copy prepared symlink {}: {err}", target.display()))?;
        return Ok(());
    }
    if metadata.is_dir() {
        std::fs::create_dir_all(target)
            .map_err(|err| format!("create prepared directory {}: {err}", target.display()))?;
        for entry in std::fs::read_dir(source)
            .map_err(|err| format!("read prepared directory {}: {err}", source.display()))?
        {
            let entry = entry.map_err(|err| format!("read prepared directory entry: {err}"))?;
            copy_prepared_path(&entry.path(), &target.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("create prepared parent {}: {err}", parent.display()))?;
    }
    std::fs::copy(source, target).map_err(|err| {
        format!(
            "copy prepared artifact {} to {}: {err}",
            source.display(),
            target.display()
        )
    })?;
    Ok(())
}

fn remove_existing_path(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|err| format!("inspect existing prepared target {}: {err}", path.display()))?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        std::fs::remove_dir_all(path)
            .map_err(|err| format!("remove prepared directory {}: {err}", path.display()))
    } else {
        std::fs::remove_file(path)
            .map_err(|err| format!("remove prepared file {}: {err}", path.display()))
    }
}

fn try_git_worktree(parent_workdir: &str, child_workdir: &Path) -> Result<bool, String> {
    let head = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(parent_workdir)
        .output();
    let Ok(head) = head else {
        return Ok(false);
    };
    if !head.status.success() {
        return Ok(false);
    }
    let head = String::from_utf8_lossy(&head.stdout).trim().to_string();
    if head.is_empty() {
        return Ok(false);
    }
    let status = Command::new("git")
        .args([
            "worktree",
            "add",
            "--detach",
            child_workdir.to_string_lossy().as_ref(),
            &head,
        ])
        .current_dir(parent_workdir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("git worktree add failed to start: {err}"))?;
    Ok(status.success())
}

fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|err| format!("create copy target {}: {err}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|err| format!("read {}: {err}", src.display()))? {
        let entry = entry.map_err(|err| format!("read dir entry: {err}"))?;
        let path = entry.path();
        let file_name = entry.file_name();
        if should_skip_copy(&file_name) {
            continue;
        }
        let target = dst.join(file_name);
        let ty = entry
            .file_type()
            .map_err(|err| format!("file type: {err}"))?;
        if ty.is_dir() {
            copy_dir(&path, &target)?;
        } else if ty.is_file() {
            std::fs::copy(&path, &target)
                .map_err(|err| format!("copy {} to {}: {err}", path.display(), target.display()))?;
        } else if ty.is_symlink() {
            if let Ok(link) = std::fs::read_link(&path) {
                #[cfg(unix)]
                std::os::unix::fs::symlink(link, &target)
                    .map_err(|err| format!("symlink {}: {err}", target.display()))?;
            }
        }
    }
    Ok(())
}

fn should_skip_copy(file_name: &OsString) -> bool {
    matches!(
        file_name.to_string_lossy().as_ref(),
        ".pytest_cache"
            | ".mypy_cache"
            | ".ruff_cache"
            | ".tox"
            | "__pycache__"
            | "node_modules"
            | "target"
    )
}

fn git_diff(workdir: &Path) -> Result<String, String> {
    let output = Command::new("git")
        .args(["-c", "core.quotePath=false", "diff", "--binary"])
        .current_dir(workdir)
        .output()
        .map_err(|err| format!("git diff failed: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "git diff exited {:?}: {}",
            output.status.code(),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn changed_files(workdir: &Path) -> Vec<String> {
    let output = Command::new("git")
        .args(["-c", "core.quotePath=false", "diff", "--name-only"])
        .current_dir(workdir)
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

fn apply_patch(workdir: &str, patch: &str) -> Result<(), String> {
    let mut child = Command::new("git")
        .args(["apply", "-"])
        .current_dir(workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("git apply failed to start: {err}"))?;
    if let Some(stdin) = &mut child.stdin {
        stdin
            .write_all(patch.as_bytes())
            .map_err(|err| format!("write patch to git apply: {err}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|err| format!("git apply wait: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git apply selected fanout patch failed: {stderr}"))
    }
}

fn changed_line_count(patch: &str) -> usize {
    patch
        .lines()
        .filter(|line| {
            (line.starts_with('+') && !line.starts_with("+++"))
                || (line.starts_with('-') && !line.starts_with("---"))
        })
        .count()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PatchQuality {
    penalty: i32,
    flags: Vec<String>,
}

fn patch_quality_assessment(execution: &CandidateExecution) -> PatchQuality {
    let added = patch_added_lines(&execution.patch);
    let removed = patch_removed_lines(&execution.patch);
    let mut flags = Vec::new();
    let mut penalty = 0;

    if added.is_empty() && !removed.is_empty() {
        push_quality_flag(&mut flags, &mut penalty, "deletion_only_patch", 70);
    }

    if removed.len() >= 8 && removed.len() > added.len().saturating_mul(3).max(1) {
        push_quality_flag(&mut flags, &mut penalty, "deletion_heavy_patch", 35);
    }

    let semantic_added: Vec<&str> = added
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .filter(|line| !is_comment_only_added_line(line))
        .collect();

    if !added.is_empty() && semantic_added.is_empty() {
        push_quality_flag(&mut flags, &mut penalty, "comment_only_patch", 80);
    }

    if !semantic_added.is_empty()
        && semantic_added
            .iter()
            .all(|line| is_fallback_only_added_line(line))
    {
        push_quality_flag(&mut flags, &mut penalty, "fallback_only_patch", 45);
    }

    if added
        .iter()
        .map(|line| line.as_str())
        .any(|line| contains_placeholder_marker(line))
    {
        push_quality_flag(&mut flags, &mut penalty, "placeholder_marker", 55);
    }

    if semantic_added
        .iter()
        .any(|line| contains_broad_exception_swallow(line))
    {
        push_quality_flag(&mut flags, &mut penalty, "broad_exception_swallow", 45);
    }

    if semantic_added
        .iter()
        .any(|line| contains_dynamic_code_execution(line))
    {
        push_quality_flag(&mut flags, &mut penalty, "dynamic_code_execution", 50);
    }

    if repeated_semantic_added_line_count(&semantic_added) >= 3 {
        push_quality_flag(&mut flags, &mut penalty, "repeated_added_line", 30);
    }

    if looks_like_incomplete_sibling_update(&execution.patch) {
        push_quality_flag(&mut flags, &mut penalty, "incomplete_sibling_update", 25);
    }

    PatchQuality { penalty, flags }
}

fn push_quality_flag(flags: &mut Vec<String>, penalty: &mut i32, flag: &str, value: i32) {
    if !flags.iter().any(|existing| existing == flag) {
        flags.push(flag.to_string());
        *penalty += value;
    }
}

fn format_quality_flags(flags: &[String]) -> String {
    if flags.is_empty() {
        "none".to_string()
    } else {
        flags.join(",")
    }
}

fn patch_added_lines(patch: &str) -> Vec<String> {
    patch
        .lines()
        .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
        .map(|line| line.trim_start_matches('+').to_string())
        .collect()
}

fn patch_removed_lines(patch: &str) -> Vec<String> {
    patch
        .lines()
        .filter(|line| line.starts_with('-') && !line.starts_with("---"))
        .map(|line| line.trim_start_matches('-').to_string())
        .collect()
}

fn looks_like_incomplete_sibling_update(patch: &str) -> bool {
    let changed_class_names = changed_class_names(patch);
    if changed_class_names.len() != 1 {
        return false;
    }
    let class_name = &changed_class_names[0];
    class_name.starts_with("ASCII")
        || class_name.starts_with("Unicode")
        || class_name.ends_with("ASCII")
        || class_name.ends_with("Unicode")
}

fn changed_class_names(patch: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut current_class: Option<String> = None;
    for line in patch.lines() {
        if line.starts_with("diff --git")
            || line.starts_with("index ")
            || line.starts_with("+++")
            || line.starts_with("---")
        {
            current_class = None;
            continue;
        }
        if let Some(name) = class_name_from_diff_line(line) {
            current_class = Some(name);
            continue;
        }
        if (line.starts_with('+') || line.starts_with('-'))
            && !line.starts_with("+++")
            && !line.starts_with("---")
        {
            if let Some(name) = current_class.as_ref() {
                if !names.iter().any(|existing| existing == name) {
                    names.push(name.clone());
                }
            }
        }
    }
    names
}

fn class_name_from_diff_line(line: &str) -> Option<String> {
    let source = line
        .strip_prefix(' ')
        .or_else(|| line.strip_prefix('+'))
        .or_else(|| line.strip_prefix('-'))
        .unwrap_or(line)
        .trim_start();
    let rest = source.strip_prefix("class ")?;
    let name: String = rest
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
        .collect();
    (!name.is_empty()).then_some(name)
}

fn is_comment_only_added_line(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with('#')
        || trimmed.starts_with("//")
        || trimmed.starts_with("/*")
        || trimmed.starts_with('*')
        || trimmed == "\"\"\""
        || trimmed == "'''"
}

fn is_fallback_only_added_line(line: &str) -> bool {
    let trimmed = line.trim();
    matches!(
        trimmed,
        "pass"
            | "..."
            | "return None"
            | "return True"
            | "return False"
            | "return []"
            | "return {}"
            | "return \"\""
            | "return ''"
            | "continue"
            | "break"
    ) || trimmed.starts_with("raise NotImplementedError")
}

fn contains_placeholder_marker(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("todo")
        || lower.contains("fixme")
        || lower.contains("placeholder")
        || lower.contains("dummy")
        || lower.contains("stub")
        || lower.contains("temporary hack")
        || lower.contains("rest of implementation")
}

fn contains_broad_exception_swallow(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.starts_with("except:")
        || lower.starts_with("except exception")
        || lower.starts_with("except baseexception")
        || lower.contains("except exception")
        || lower.contains("except baseexception")
}

fn contains_dynamic_code_execution(line: &str) -> bool {
    let compact = line.replace(' ', "");
    compact.contains("eval(")
        || compact.contains("exec(")
        || compact.contains("__import__(")
        || compact.contains("os.system(")
        || compact.contains("subprocess.")
}

fn repeated_semantic_added_line_count(lines: &[&str]) -> usize {
    let mut max_count = 0;
    for (index, line) in lines.iter().enumerate() {
        if line.len() < 8 {
            continue;
        }
        let count = lines[index..]
            .iter()
            .filter(|candidate| *candidate == line)
            .count();
        max_count = max_count.max(count);
    }
    max_count
}

fn is_test_path(path: &str) -> bool {
    patch_authority::is_test_path(path)
}

fn temp_root(config: &Config) -> PathBuf {
    let run = std::env::var("SW_INSTANCE_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| std::process::id().to_string());
    let base = config.work_root.clone().unwrap_or_else(|| {
        std::env::temp_dir()
            .join("statewright")
            .join("candidate-fanout-workdirs")
    });
    base.join(sanitize_path_component(&run))
}

fn candidate_id(hypothesis: &CandidateHypothesis) -> String {
    format!("h{}", hypothesis.id)
}

fn stable_hash(value: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn write_json_path<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("create json parent {}: {err}", parent.display()))?;
    }
    let data = serde_json::to_string_pretty(value)
        .map_err(|err| format!("serialize {}: {err}", path.display()))?;
    std::fs::write(path, data).map_err(|err| format!("write {}: {err}", path.display()))
}

fn env_flag(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on" | "best_of_n" | "fanout" | "parallel"
            )
        })
        .unwrap_or(default)
}

fn env_usize(name: &str, default: usize, min: usize, max: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn env_i32(name: &str, default: i32, min: i32, max: i32) -> i32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn env_u32(name: &str, default: u32, min: u32, max: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn env_u64(name: &str, default: u64, min: u64, max: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn env_string(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn bool_string(value: bool) -> &'static str {
    if value { "1" } else { "0" }
}

fn sanitize_path_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    sanitized.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn execution(id: usize, patch: &str, stdout: &str, changed_lines: usize) -> CandidateExecution {
        CandidateExecution {
            hypothesis: CandidateHypothesis {
                id,
                path: "src/lib.py".to_string(),
                score: 100,
                reason: "unit".to_string(),
            },
            candidate_id: format!("h{id}"),
            stdout: stdout.to_string(),
            stderr: String::new(),
            patch: patch.to_string(),
            changed_files: vec!["src/lib.py".to_string()],
            changed_lines,
            exit_code: Some(0),
            duration_ms: 10,
            timed_out: false,
            materialization: MaterializationReport {
                mode: MaterializationMode::PreparedTreeCopy,
                protected_artifacts_requested: 0,
                protected_artifacts_copied: 0,
            },
            evidence: CandidateEvidence::from_output(stdout),
            actual_locus: "src/lib.py".to_string(),
            issue_locus_aligned: true,
            strengthening_attempted: false,
            strengthening_signal: None,
            parent_validation_output: String::new(),
            parent_validation_provenance: None,
        }
    }

    fn source_scope_pass_stdout() -> &'static str {
        "[FINAL_VERIFICATION] UNAVAILABLE\n[POST_EDIT_REPAIR] PASS scope=SOURCE_SCOPE_TEST_FILES=tests/test_lib.py\n"
    }

    fn trusted_source_scope_pass_stdout() -> &'static str {
        "[FINAL_VERIFICATION] UNAVAILABLE\n[POST_EDIT_REPAIR] PASS scope=SOURCE_SCOPE_TEST_FILES=tests/test_lib.py authority=trusted_source_scope\n"
    }

    fn issue_mapped_source_scope_pass_stdout() -> &'static str {
        "[FINAL_VERIFICATION] UNAVAILABLE\n[PARENT_CANDIDATE_VALIDATION] SIGNAL=source_scope_pass\n"
    }

    fn final_pass_stdout() -> &'static str {
        "[FINAL_VERIFICATION] PASS\n"
    }

    fn source_scope_fail_stdout() -> &'static str {
        "[POST_EDIT_REPAIR] FAIL kind=assertion_failure scope=SOURCE_SCOPE_TEST_FILES=tests/test_lib.py\nE   assert 2 == 1\n"
    }

    #[test]
    fn plan_mode_distinguishes_fanout_from_sequential_packets() {
        let _env_guard = crate::test_support::env_test_guard();
        unsafe {
            std::env::remove_var("SW_CANDIDATE_FANOUT");
            std::env::remove_var("SW_CANDIDATE_FANOUT_CHILD");
            std::env::remove_var("SW_CANDIDATE_FANOUT_DEPTH");
            std::env::remove_var("SW_CANDIDATE_FANOUT_MAX_DEPTH");
            std::env::remove_var("SW_CANDIDATE_FANOUT_MODE");
            std::env::remove_var("DEPRECATED_SW_CANDIDATE_FANOUT_MODE");
            std::env::remove_var("SW_CANDIDATE_FANOUT_DISABLED");
        }
        assert_eq!(plan_mode_from_env(true), "sequential_candidate_packets");
        unsafe {
            std::env::set_var("SW_CANDIDATE_FANOUT", "1");
            std::env::set_var("SW_CANDIDATE_FANOUT_MODE", "fanout");
        }
        assert_eq!(plan_mode_from_env(true), "sequential_candidate_packets");
        unsafe {
            std::env::set_var("DEPRECATED_SW_CANDIDATE_FANOUT_MODE", "fanout");
        }
        assert_eq!(plan_mode_from_env(true), "parallel_candidate_fanout");
        unsafe {
            std::env::set_var("SW_CANDIDATE_FANOUT_CHILD", "1");
        }
        assert_eq!(plan_mode_from_env(true), "sequential_candidate_packets");
        unsafe {
            std::env::remove_var("SW_CANDIDATE_FANOUT");
            std::env::remove_var("SW_CANDIDATE_FANOUT_CHILD");
            std::env::remove_var("SW_CANDIDATE_FANOUT_DEPTH");
            std::env::remove_var("SW_CANDIDATE_FANOUT_MAX_DEPTH");
            std::env::remove_var("SW_CANDIDATE_FANOUT_MODE");
            std::env::remove_var("DEPRECATED_SW_CANDIDATE_FANOUT_MODE");
            std::env::remove_var("SW_CANDIDATE_FANOUT_DISABLED");
        }
    }

    #[test]
    fn candidate_fanout_mode_off_forces_sequential_packets() {
        let _env_guard = crate::test_support::env_test_guard();
        unsafe {
            std::env::set_var("SW_CANDIDATE_FANOUT", "1");
            std::env::set_var("DEPRECATED_SW_CANDIDATE_FANOUT_MODE", "off");
            std::env::remove_var("SW_CANDIDATE_FANOUT_CHILD");
            std::env::remove_var("SW_CANDIDATE_FANOUT_DEPTH");
        }

        let config = Config::from_env();
        assert!(!feature_enabled());
        assert!(!config.enabled);
        assert!(!config.parent_enabled());
        assert_eq!(plan_mode_from_env(true), "sequential_candidate_packets");

        unsafe {
            std::env::remove_var("SW_CANDIDATE_FANOUT");
            std::env::remove_var("DEPRECATED_SW_CANDIDATE_FANOUT_MODE");
        }
    }

    #[test]
    fn causal_one_pass_disables_fanout_even_when_legacy_env_is_set() {
        let _env_guard = crate::test_support::env_test_guard();
        unsafe {
            std::env::set_var("SW_REPAIR_CONTROLLER", "causal_one_pass");
            std::env::set_var("SW_CANDIDATE_FANOUT", "1");
            std::env::set_var("DEPRECATED_SW_CANDIDATE_FANOUT_MODE", "fanout");
        }
        assert!(!feature_enabled());
        unsafe {
            std::env::remove_var("SW_REPAIR_CONTROLLER");
            std::env::remove_var("SW_CANDIDATE_FANOUT");
            std::env::remove_var("DEPRECATED_SW_CANDIDATE_FANOUT_MODE");
        }
    }

    #[test]
    fn depth_label_blocks_child_from_parent_fanout() {
        let _env_guard = crate::test_support::env_test_guard();
        unsafe {
            std::env::set_var("SW_CANDIDATE_FANOUT", "1");
            std::env::set_var("DEPRECATED_SW_CANDIDATE_FANOUT_MODE", "fanout");
            std::env::set_var("SW_CANDIDATE_FANOUT_DEPTH", "1");
            std::env::remove_var("SW_CANDIDATE_FANOUT_CHILD");
            std::env::remove_var("SW_CANDIDATE_FANOUT_MAX_DEPTH");
            std::env::remove_var("SW_CANDIDATE_FANOUT_DISABLED");
        }

        let config = Config::from_env();
        assert!(config.enabled);
        assert!(config.child);
        assert_eq!(config.child_depth, 1);
        assert!(!config.parent_enabled());
        assert_eq!(plan_mode_from_env(true), "sequential_candidate_packets");

        unsafe {
            std::env::remove_var("SW_CANDIDATE_FANOUT");
            std::env::remove_var("DEPRECATED_SW_CANDIDATE_FANOUT_MODE");
            std::env::remove_var("SW_CANDIDATE_FANOUT_DEPTH");
        }
    }

    #[test]
    fn legacy_child_flag_maps_to_depth_one() {
        let _env_guard = crate::test_support::env_test_guard();
        unsafe {
            std::env::set_var("SW_CANDIDATE_FANOUT", "1");
            std::env::set_var("SW_CANDIDATE_FANOUT_CHILD", "1");
            std::env::remove_var("SW_CANDIDATE_FANOUT_DEPTH");
        }

        let config = Config::from_env();
        assert!(config.child);
        assert_eq!(config.child_depth, 1);
        assert!(!config.parent_enabled());

        unsafe {
            std::env::remove_var("SW_CANDIDATE_FANOUT");
            std::env::remove_var("SW_CANDIDATE_FANOUT_CHILD");
        }
    }

    #[test]
    fn child_defaults_to_speed_solver_with_context_packet() {
        let _env_guard = crate::test_support::env_test_guard();
        unsafe {
            std::env::remove_var("SW_CANDIDATE_FANOUT_CHILD_PROFILE");
            std::env::remove_var("SW_CANDIDATE_FANOUT_CHILD_MACHINE");
            std::env::remove_var("SW_CANDIDATE_FANOUT_CONTEXT_PUMP");
            std::env::remove_var("SW_CANDIDATE_FANOUT_CHILD_MAX_RETRIES");
        }

        let config = Config::from_env();
        assert_eq!(config.child_profile, "speed");
        assert_eq!(config.child_machine, "speed");
        assert!(config.context_pump);
        assert_eq!(config.child_max_retries, 1);

        let invocation = AgentInvocation {
            executable: PathBuf::from("sw-agent"),
            task: "Fix the bug".to_string(),
            ollama_url: "http://localhost:11434/v1".to_string(),
            model: "qwen3:8b".to_string(),
            max_retries: 3,
            hardcoded_machine: "structured".to_string(),
            use_hardcoded_machine: false,
            tool_mode: "auto".to_string(),
            model_size: 8.0,
            config_path: None,
        };
        let machine = child_machine_variant(&config, &invocation);
        assert_eq!(machine.variant, "speed");
        assert!(machine.force_hardcoded);

        let hypothesis = CandidateHypothesis {
            id: 1,
            path: "pkg/source.py".to_string(),
            score: 123,
            reason: "ranked locus".to_string(),
        };
        let context_dir = tempfile::tempdir().expect("context dir");
        let context_packet = CandidateContextPacket::load(
            context_dir.path(),
            vec!["tests/test_source.py".to_string()],
        );
        let task = speed_solver_task(
            "Fix the bug",
            &config,
            &hypothesis,
            "h1",
            1,
            &context_packet,
        );
        assert!(task.contains("Candidate Speed Solver Packet"));
        assert!(task.contains("`pkg/source.py`"));
        assert!(task.contains("Baseline-runnable public test files: `tests/test_source.py`"));
        assert!(task.contains("official SWE-bench verification remains the only solve authority"));
    }

    #[test]
    fn sequential_fallback_requires_deprecated_escape_hatch() {
        let _env_guard = crate::test_support::env_test_guard();
        unsafe {
            std::env::remove_var("SW_CANDIDATE_FANOUT_FALLBACK");
            std::env::remove_var("DEPRECATED_SW_CANDIDATE_FANOUT_FALLBACK");
        }
        assert!(!Config::from_env().fallback_to_sequential);

        unsafe {
            std::env::set_var("SW_CANDIDATE_FANOUT_FALLBACK", "1");
        }
        assert!(!Config::from_env().fallback_to_sequential);

        unsafe {
            std::env::set_var("DEPRECATED_SW_CANDIDATE_FANOUT_FALLBACK", "1");
        }
        assert!(Config::from_env().fallback_to_sequential);

        unsafe {
            std::env::remove_var("SW_CANDIDATE_FANOUT_FALLBACK");
            std::env::remove_var("DEPRECATED_SW_CANDIDATE_FANOUT_FALLBACK");
        }
    }

    #[test]
    fn git_diff_reports_non_git_workdir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = git_diff(dir.path()).expect_err("non-git workdir should not look empty");
        assert!(err.contains("git diff exited") || err.contains("git diff failed"));
    }

    #[test]
    fn max_depth_zero_disables_parent_fanout() {
        let _env_guard = crate::test_support::env_test_guard();
        unsafe {
            std::env::set_var("SW_CANDIDATE_FANOUT", "1");
            std::env::set_var("DEPRECATED_SW_CANDIDATE_FANOUT_MODE", "fanout");
            std::env::set_var("SW_CANDIDATE_FANOUT_MAX_DEPTH", "0");
            std::env::remove_var("SW_CANDIDATE_FANOUT_CHILD");
            std::env::remove_var("SW_CANDIDATE_FANOUT_DEPTH");
            std::env::remove_var("SW_CANDIDATE_FANOUT_DISABLED");
        }

        let config = Config::from_env();
        assert!(config.enabled);
        assert_eq!(config.child_depth, 0);
        assert_eq!(config.max_depth, 0);
        assert!(!config.parent_enabled());

        unsafe {
            std::env::remove_var("SW_CANDIDATE_FANOUT");
            std::env::remove_var("DEPRECATED_SW_CANDIDATE_FANOUT_MODE");
            std::env::remove_var("SW_CANDIDATE_FANOUT_MAX_DEPTH");
        }
    }

    #[test]
    fn scoring_prefers_validation_signal_and_smaller_patch() {
        let pass = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+ok\n",
            "[FINAL_VERIFICATION] PASS",
            2,
        );
        let fail = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n+bad\n+bad2\n+bad3\n",
            "[FINAL_VERIFICATION] FAIL",
            8,
        );
        assert!(score_execution(&pass) > score_execution(&fail));
    }

    #[test]
    fn empty_patch_is_rejected() {
        let empty = execution(1, "", "[FINAL_VERIFICATION] PASS", 0);
        assert!(score_execution(&empty) < 0);
        let report = report_for_execution(&empty);
        assert!(
            report
                .rejection_reasons
                .contains(&"empty_patch".to_string())
        );
    }

    #[test]
    fn syntax_error_candidate_is_rejected_and_unselectable() {
        let syntax = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+if True\n+    return 1\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\nSyntaxError: invalid syntax\n",
            2,
        );
        let report = report_for_execution(&syntax);
        assert!(!candidate_is_selectable(&syntax));
        assert!(score_execution(&syntax) < 0);
        assert!(
            report
                .rejection_reasons
                .contains(&"syntax_error_signal".to_string())
        );
    }

    #[test]
    fn collection_error_candidate_is_rejected_and_unselectable() {
        let collection_error = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+from missing import thing\n",
            "SW_TEST_EXIT_CODE=4\nERROR collecting tests/test_lib.py\nModuleNotFoundError: missing\n",
            2,
        );
        let report = report_for_execution(&collection_error);
        assert!(!candidate_is_selectable(&collection_error));
        assert!(
            report
                .rejection_reasons
                .contains(&"collection_error_signal".to_string())
        );
    }

    #[test]
    fn final_verification_fail_candidate_is_rejected_and_unselectable() {
        let failing = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return value + 1\n",
            "[FINAL_VERIFICATION] FAIL\n",
            2,
        );
        let report = report_for_execution(&failing);
        assert!(!candidate_is_selectable(&failing));
        assert!(
            report
                .rejection_reasons
                .contains(&"final_verification_failed".to_string())
        );
    }

    #[test]
    fn source_scope_feedback_candidate_is_selectable_but_ranked_below_strong_validation() {
        let weak = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return value + 1\n",
            source_scope_pass_stdout(),
            2,
        );
        let strong = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n+return value + 1\n",
            final_pass_stdout(),
            2,
        );
        let report = report_for_execution(&weak);
        assert!(candidate_is_selectable(&weak));
        assert!(report.rejection_reasons.is_empty());
        assert!(score_execution(&weak) > 0);
        assert!(score_execution(&weak) < score_execution(&strong));
        assert_eq!(candidate_validation_signal(&weak.stdout), "feedback_pass");
    }

    #[test]
    fn trusted_source_scope_pass_is_regression_evidence_not_final_pass() {
        let scoped = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return value + 1\n",
            trusted_source_scope_pass_stdout(),
            2,
        );
        let final_pass = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n+return value + 1\n",
            "[FINAL_VERIFICATION] PASS\n",
            2,
        );

        let report = report_for_execution(&scoped);
        assert!(candidate_is_selectable(&scoped));
        assert!(report.rejection_reasons.is_empty());
        assert_eq!(
            candidate_validation_signal(&scoped.stdout),
            "regression_pass"
        );
        assert_eq!(report.final_verification_signal, "unavailable");
        assert_eq!(report.candidate_validation_signal, "regression_pass");
        assert!(score_execution(&scoped) > 0);
        assert!(score_execution(&scoped) < score_execution(&final_pass));
    }

    #[test]
    fn generic_unavailable_candidate_is_selectable_with_penalty() {
        let missing = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return value + 1\n",
            "[POST_EDIT_REPAIR] PASS\n",
            2,
        );
        let report = report_for_execution(&missing);
        assert!(candidate_is_selectable(&missing));
        assert!(report.rejection_reasons.is_empty());
        assert!(score_execution(&missing) > 0);
    }

    #[test]
    fn strong_validation_beats_weak_validation_for_same_patch_shape() {
        let weak = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return value + 1\n",
            "[POST_EDIT_REPAIR] PASS\n",
            2,
        );
        let strong = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n+return value + 1\n",
            final_pass_stdout(),
            2,
        );

        assert!(candidate_is_selectable(&weak));
        assert!(candidate_is_selectable(&strong));
        assert!(score_execution(&weak) < score_execution(&strong));
    }

    #[test]
    fn early_lane_defers_path_mismatched_unavailable_candidate() {
        let _env_guard = crate::test_support::env_test_guard();
        let mut config = Config::from_env();
        config.require_strong_selection = true;
        let mut candidate = execution(
            1,
            "diff --git a/docs/example.rst b/docs/example.rst\n+use the helper here\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n",
            1,
        );
        candidate.changed_files = vec!["docs/example.rst".to_string()];
        candidate.issue_locus_aligned = false;

        assert!(candidate_is_selectable(&candidate));
        assert!(!selection_allowed_to_apply(&config, &candidate));
    }

    #[test]
    fn early_lane_allows_clean_path_aligned_unavailable_candidate() {
        let _env_guard = crate::test_support::env_test_guard();
        let mut config = Config::from_env();
        config.require_strong_selection = true;
        let candidate = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return normalize(value)\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n",
            1,
        );

        assert!(candidate_is_selectable(&candidate));
        assert!(selection_allowed_to_apply(&config, &candidate));
    }

    #[test]
    fn early_lane_keeps_clean_issue_mapped_patch_from_timed_out_child() {
        let _env_guard = crate::test_support::env_test_guard();
        let mut config = Config::from_env();
        config.require_strong_selection = true;
        let mut candidate = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return normalize(value)\n",
            issue_mapped_source_scope_pass_stdout(),
            1,
        );
        candidate.timed_out = true;

        assert_eq!(
            candidate_validation_signal(&candidate.stdout),
            "source_scope_pass"
        );
        assert!(candidate_is_selectable(&candidate));
        assert!(selection_allowed_to_apply(&config, &candidate));
    }

    #[test]
    fn unchanged_baseline_pass_does_not_stop_route_escalation() {
        let regression = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return normalize(value)\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n[POST_EDIT_REPAIR] PASS authority=baseline_proven_source_scope scope=SOURCE_SCOPE_TEST_FILES=tests/test_lib.py\n[PARENT_CANDIDATE_VALIDATION] SIGNAL=regression_pass\n",
            1,
        );
        let regression_batch = FanoutBatch {
            namespace: "focused_probe".to_string(),
            executions: vec![regression],
            elapsed_ms: 10,
            fanout_stop_reason: None,
        };
        assert!(!regression_batch.has_discriminating_candidate());

        let repaired = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n+return normalize(value)\n",
            issue_mapped_source_scope_pass_stdout(),
            1,
        );
        let repaired_batch = FanoutBatch {
            namespace: "progressive_fanout".to_string(),
            executions: vec![repaired],
            elapsed_ms: 10,
            fanout_stop_reason: None,
        };
        assert!(repaired_batch.has_discriminating_candidate());
    }

    #[test]
    fn early_lane_drops_timed_out_candidate_without_issue_mapped_pass() {
        let _env_guard = crate::test_support::env_test_guard();
        let mut config = Config::from_env();
        config.require_strong_selection = true;
        let mut candidate = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return normalize(value)\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n",
            1,
        );
        candidate.timed_out = true;

        assert!(candidate_is_selectable(&candidate));
        assert!(!selection_allowed_to_apply(&config, &candidate));
    }

    #[test]
    fn parent_ranked_source_locus_outweighs_wrong_launch_guess() {
        let context_dir = tempfile::tempdir().expect("context dir");
        std::fs::write(
            context_dir.path().join("problem-shape.json"),
            r#"{"top_files":[{"path":"django/conf/global_settings.py","score":91}]}"#,
        )
        .expect("problem shape");
        let packet = CandidateContextPacket::load(context_dir.path(), Vec::new());

        assert!(candidate_issue_locus_aligned(
            &["django/conf/global_settings.py".to_string()],
            "django/core/management/base.py",
            &packet,
        ));
        assert!(!candidate_issue_locus_aligned(
            &["django/db/models/query.py".to_string()],
            "django/core/management/base.py",
            &packet,
        ));
    }

    #[test]
    fn full_lane_can_apply_weak_best_effort_candidate() {
        let _env_guard = crate::test_support::env_test_guard();
        let mut config = Config::from_env();
        config.require_strong_selection = false;
        let mut candidate = execution(
            1,
            "diff --git a/docs/example.rst b/docs/example.rst\n+use the helper here\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n",
            1,
        );
        candidate.changed_files = vec!["docs/example.rst".to_string()];

        assert!(candidate_is_selectable(&candidate));
        assert!(selection_allowed_to_apply(&config, &candidate));
    }

    #[test]
    fn close_selectable_candidates_need_arbiter() {
        let first = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return value + 1\n",
            final_pass_stdout(),
            2,
        );
        let second = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n+return value - 1\n",
            final_pass_stdout(),
            3,
        );
        let executions = vec![first, second];
        let ranked = ranked_selectable_candidate_indices(&executions);

        assert_eq!(ranked.len(), 2);
        assert!(selection_needs_arbitration(&executions, &ranked, 30));
    }

    #[test]
    fn clear_validation_pass_skips_arbiter() {
        let pass = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return value + 1\n",
            "[FINAL_VERIFICATION] PASS\n",
            2,
        );
        let unavailable = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n+return value - 1\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n[POST_EDIT_REPAIR] PASS\n",
            2,
        );
        let executions = vec![pass, unavailable];
        let ranked = ranked_selectable_candidate_indices(&executions);

        assert!(!selection_needs_arbitration(&executions, &ranked, 200));
    }

    #[test]
    fn weak_validation_candidates_need_arbiter_even_with_score_gap() {
        let _env_guard = crate::test_support::env_test_guard();
        let mut high_score = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return value + 1\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n",
            1,
        );
        high_score.hypothesis.score = 200;
        let mut low_score = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n+return value - 1\n",
            "[POST_EDIT_REPAIR] PASS\n",
            20,
        );
        low_score.hypothesis.score = 1;
        let executions = vec![high_score, low_score];
        let ranked = ranked_selectable_candidate_indices(&executions);

        assert!(
            score_execution(&executions[ranked[0]]) - score_execution(&executions[ranked[1]]) > 30
        );
        assert!(selection_needs_arbitration(&executions, &ranked, 30));
    }

    #[test]
    fn equal_score_ranking_prefers_median_diff_size() {
        let mut tiny = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return value\n",
            final_pass_stdout(),
            1,
        );
        tiny.hypothesis.score = 100;
        let mut median = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n+value = normalize(value)\n+return value\n",
            final_pass_stdout(),
            10,
        );
        median.hypothesis.score = 109;
        let mut rewrite = execution(
            3,
            "diff --git a/src/lib.py b/src/lib.py\n+class Replacement:\n+    pass\n",
            final_pass_stdout(),
            80,
        );
        rewrite.hypothesis.score = 179;
        let executions = vec![tiny, median, rewrite];
        let ranked = ranked_selectable_candidate_indices(&executions);

        assert_eq!(
            score_execution(&executions[0]),
            score_execution(&executions[1])
        );
        assert_eq!(
            score_execution(&executions[1]),
            score_execution(&executions[2])
        );
        assert_eq!(ranked[0], 1);
        assert_eq!(median_diff_tiebreak_index(&executions, &ranked), Some(1));
    }

    #[test]
    fn static_risk_tiebreak_prefers_path_aligned_minimal_candidate() {
        let mut broad_wrong_path = execution(
            1,
            "diff --git a/docs/example.rst b/docs/example.rst\n+documentation guess\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n",
            1,
        );
        broad_wrong_path.hypothesis.score = 200;
        broad_wrong_path.changed_files = vec!["docs/example.rst".to_string()];
        broad_wrong_path.issue_locus_aligned = false;
        let mut focused_source = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n+return normalize(value)\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n",
            1,
        );
        focused_source.hypothesis.score = 100;
        let executions = vec![broad_wrong_path, focused_source];
        let indices = vec![0, 1];

        assert_eq!(static_risk_tiebreak_index(&executions, &indices), Some(1));
    }

    #[test]
    fn arbiter_rejects_broader_unavailable_candidate() {
        let selected = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return normalize(value)\n+return normalize(value)\n+return normalize(value)\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n",
            20,
        );
        let fallback = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n+return normalize(value)\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n",
            2,
        );

        assert!(!arbiter_selection_allowed(&selected, &fallback));
    }

    #[test]
    fn arbiter_allows_equal_quality_unavailable_override() {
        let selected = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return normalize(value)\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n",
            2,
        );
        let fallback = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n+return normalize(value)\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n",
            2,
        );

        assert!(arbiter_selection_allowed(&selected, &fallback));
    }

    #[test]
    fn arbiter_can_retain_equal_evidence_patch_from_timed_out_child() {
        let mut selected = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n-return cot\n+return cothm\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n",
            2,
        );
        selected.timed_out = true;
        let fallback = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n-return cot\n+return coth\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n",
            2,
        );

        assert!(arbiter_selection_allowed(&selected, &fallback));
    }

    #[test]
    fn arbiter_can_choose_stronger_validation_signal() {
        let selected = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return normalize(value)\n+return normalize(value)\n+return normalize(value)\n",
            "[FINAL_VERIFICATION] PASS\n",
            20,
        );
        let fallback = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n+return normalize(value)\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n",
            2,
        );

        assert!(arbiter_selection_allowed(&selected, &fallback));
    }

    #[test]
    fn incomplete_ascii_unicode_sibling_patch_is_penalized() {
        let candidate = execution(
            1,
            "diff --git a/django/contrib/auth/validators.py b/django/contrib/auth/validators.py\n@@\n class ASCIIUsernameValidator(RegexValidator):\n-    regex = r'^[\\w.@+-]+$'\n+    regex = r'^[\\w.@+-]+\\Z'\n",
            final_pass_stdout(),
            2,
        );
        let quality = patch_quality_assessment(&candidate);

        assert!(
            quality
                .flags
                .contains(&"incomplete_sibling_update".to_string())
        );
    }

    #[test]
    fn complete_ascii_unicode_sibling_patch_is_not_penalized() {
        let candidate = execution(
            1,
            "diff --git a/django/contrib/auth/validators.py b/django/contrib/auth/validators.py\n@@\n class ASCIIUsernameValidator(RegexValidator):\n-    regex = r'^[\\w.@+-]+$'\n+    regex = r'^[\\w.@+-]+\\Z'\n@@\n class UnicodeUsernameValidator(RegexValidator):\n-    regex = r'^[\\w.@+-]+$'\n+    regex = r'^[\\w.@+-]+\\Z'\n",
            final_pass_stdout(),
            4,
        );
        let quality = patch_quality_assessment(&candidate);

        assert!(
            !quality
                .flags
                .contains(&"incomplete_sibling_update".to_string())
        );
    }

    #[test]
    fn fanout_budget_stops_after_timeout_limit() {
        let mut config = Config::from_env();
        config.timeout_stop_count = 2;
        config.fanout_wall_seconds = 0;
        let mut first = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return 1\n",
            "",
            1,
        );
        first.timed_out = true;
        let mut second = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n+return 2\n",
            "",
            1,
        );
        second.timed_out = true;
        let executions = vec![first, second];

        let reason =
            fanout_budget_stop_reason(&config, Duration::from_secs(10), &executions).unwrap();

        assert!(reason.contains("timeout_stop_count"));
        assert!(reason.contains("patch_timeouts=2"));
    }

    #[test]
    fn fanout_budget_ignores_empty_timeout_probes() {
        let mut config = Config::from_env();
        config.timeout_stop_count = 2;
        config.fanout_wall_seconds = 0;
        let mut first = execution(1, "", "", 0);
        first.timed_out = true;
        let mut second = execution(2, "", "", 0);
        second.timed_out = true;
        let executions = vec![first, second];

        assert!(fanout_budget_stop_reason(&config, Duration::from_secs(10), &executions).is_none());
    }

    #[test]
    fn fanout_budget_stops_after_wall_clock_limit() {
        let mut config = Config::from_env();
        config.timeout_stop_count = 0;
        config.fanout_wall_seconds = 20;

        let reason = fanout_budget_stop_reason(&config, Duration::from_secs(21), &[]).unwrap();

        assert!(reason.contains("fanout_wall_seconds"));
    }

    #[test]
    fn candidate_timeout_is_clamped_to_absolute_fanout_deadline() {
        let deadline = Instant::now() + Duration::from_millis(80);
        let timeout =
            remaining_timeout(Some(deadline), Duration::from_secs(900)).expect("remaining timeout");
        assert!(timeout <= Duration::from_millis(80));
        assert!(remaining_timeout(Some(Instant::now()), Duration::from_secs(1)).is_none());
    }

    #[test]
    fn even_candidate_set_uses_midpoint_median_for_diff_size() {
        let one = execution(1, "diff --git a/src/lib.py b/src/lib.py\n+a\n", "", 1);
        let three = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n+a\n+b\n+c\n",
            "",
            3,
        );
        let seven = execution(
            3,
            "diff --git a/src/lib.py b/src/lib.py\n+a\n+b\n+c\n+d\n+e\n+f\n+g\n",
            "",
            7,
        );
        let twenty = execution(
            4,
            "diff --git a/src/lib.py b/src/lib.py\n+rewrite\n",
            "",
            20,
        );
        let executions = vec![one, three, seven, twenty];
        let indices = vec![0, 1, 2, 3];
        let median_x2 = median_changed_lines_x2(&executions, &indices).unwrap();

        assert_eq!(median_x2, 10);
        assert_eq!(format_median_x2(median_x2), "5");
        assert_eq!(median_changed_lines_distance_x2(3, median_x2), 4);
        assert_eq!(median_changed_lines_distance_x2(7, median_x2), 4);
    }

    #[test]
    fn arbiter_candidate_parser_accepts_json_and_plain_id() {
        assert_eq!(
            parse_arbiter_candidate_id(r#"{"candidate_id":"h2","reason":"smaller"}"#).as_deref(),
            Some("h2")
        );
        assert_eq!(
            parse_arbiter_candidate_id("I choose h3 because it is tighter").as_deref(),
            Some("h3")
        );
        assert_eq!(
            parse_arbiter_reason(r#"{"candidate_id":"h2","reason":"smaller"}"#).as_deref(),
            Some("smaller")
        );
        assert_eq!(
            parse_arbiter_confidence(
                r#"{"candidate_id":"h2","confidence":"LOW","concerns":["validation unavailable"]}"#
            )
            .as_deref(),
            Some("low")
        );
        assert_eq!(
            parse_arbiter_concerns(
                r#"{"candidate_id":"h2","confidence":"low","concerns":["validation unavailable","path mismatch"]}"#
            ),
            vec![
                "validation unavailable".to_string(),
                "path mismatch".to_string()
            ]
        );
    }

    #[test]
    fn arbitration_prompt_includes_patch_quality_flags() {
        let candidate = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+    # TODO: placeholder until real fix\n+    pass\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n",
            2,
        );

        let prompt = arbitration_prompt("Fix the behavior.", &[candidate], &[0]);

        assert!(prompt.contains("- quality penalty:"));
        assert!(prompt.contains("- quality flags:"));
        assert!(prompt.contains("placeholder_marker"));
        assert!(prompt.contains("\"confidence\":\"high|medium|low\""));
        assert!(prompt.contains("If there is no clear winner"));
        assert!(prompt.contains("median="));
    }

    #[test]
    fn timed_out_child_candidate_is_rejected_and_unselectable() {
        let mut timed_out = execution(1, "", "[POST_EDIT_REPAIR] PASS\n", 0);
        timed_out.timed_out = true;
        let report = report_for_execution(&timed_out);
        assert!(!candidate_is_selectable(&timed_out));
        assert!(
            report
                .rejection_reasons
                .contains(&"candidate_timeout".to_string())
        );
    }

    #[test]
    fn timed_out_source_patch_remains_low_confidence_selectable() {
        let mut timed_out = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return value + 1\n",
            final_pass_stdout(),
            2,
        );
        timed_out.timed_out = true;
        let clean = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return value + 1\n",
            final_pass_stdout(),
            2,
        );

        let report = report_for_execution(&timed_out);
        assert!(candidate_is_selectable(&timed_out));
        assert!(report.rejection_reasons.is_empty());
        assert!(score_execution(&timed_out) < score_execution(&clean));
    }

    #[test]
    fn post_edit_repair_failure_rejects_source_patch() {
        let repair_fail = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+return value + 1\n",
            source_scope_fail_stdout(),
            2,
        );
        let report = report_for_execution(&repair_fail);
        assert!(!candidate_is_selectable(&repair_fail));
        assert!(
            report
                .rejection_reasons
                .contains(&"final_verification_failed".to_string())
        );
    }

    #[test]
    fn placeholder_patch_is_reported_and_penalized_without_hard_rejection() {
        let placeholder = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+    # TODO: placeholder until real fix\n+    pass\n",
            final_pass_stdout(),
            2,
        );
        let clean = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+    value = normalize(value)\n+    return value\n",
            final_pass_stdout(),
            2,
        );

        let report = report_for_execution(&placeholder);
        assert!(candidate_is_selectable(&placeholder));
        assert!(report.rejection_reasons.is_empty());
        assert!(report.quality_penalty > 0);
        assert!(
            report
                .quality_flags
                .contains(&"placeholder_marker".to_string())
        );
        assert!(score_execution(&placeholder) < score_execution(&clean));
    }

    #[test]
    fn fallback_only_patch_loses_to_clean_source_patch() {
        let fallback = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+    return None\n",
            final_pass_stdout(),
            1,
        );
        let clean = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+    return coerce_value(value)\n",
            final_pass_stdout(),
            1,
        );

        let report = report_for_execution(&fallback);
        assert!(candidate_is_selectable(&fallback));
        assert!(
            report
                .quality_flags
                .contains(&"fallback_only_patch".to_string())
        );
        assert!(score_execution(&fallback) < score_execution(&clean));
    }

    #[test]
    fn timed_out_smelly_source_patch_remains_selectable_but_ranked_lower() {
        let mut smelly = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+    try:\n+        return render(value)\n+    except Exception:\n+        return None\n",
            final_pass_stdout(),
            4,
        );
        smelly.timed_out = true;
        let mut clean = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+    return render(normalize(value))\n",
            final_pass_stdout(),
            1,
        );
        clean.timed_out = true;

        let report = report_for_execution(&smelly);
        assert!(candidate_is_selectable(&smelly));
        assert!(
            report
                .quality_flags
                .contains(&"broad_exception_swallow".to_string())
        );
        assert!(score_execution(&smelly) < score_execution(&clean));
    }

    #[test]
    fn quoted_test_path_candidate_is_rejected() {
        let mut test_edit = execution(
            1,
            "diff --git \"a/tests/staticfiles_tests/apps/test/static/test/\\342\\212\\227.txt\" \"b/tests/staticfiles_tests/apps/test/static/test/\\342\\212\\227.txt\"\n+bad\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n",
            1,
        );
        test_edit.changed_files =
            vec!["\"tests/staticfiles_tests/apps/test/static/test/\\342\\212\\227.txt\"".into()];
        let report = report_for_execution(&test_edit);
        assert!(!candidate_is_selectable(&test_edit));
        assert!(
            report
                .rejection_reasons
                .contains(&"test_file_touched".to_string())
        );
    }

    #[test]
    fn generated_build_path_candidate_is_rejected() {
        let mut generated = execution(
            1,
            "diff --git a/build/lib/django/core/validators.py b/build/lib/django/core/validators.py\n+return value\n",
            "[FINAL_VERIFICATION] PASS\n",
            1,
        );
        generated.changed_files = vec!["build/lib/django/core/validators.py".to_string()];
        let report = report_for_execution(&generated);

        assert!(!candidate_is_selectable(&generated));
        assert!(
            report
                .rejection_reasons
                .contains(&"non_authoritative_patch_path".to_string())
        );
        assert!(score_execution(&generated) < 0);
    }

    #[test]
    fn changed_files_reports_unicode_paths_unquoted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir
            .path()
            .join("tests/staticfiles_tests/apps/test/static/test/⊗.txt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "old\n").unwrap();
        assert!(
            Command::new("git")
                .arg("init")
                .current_dir(dir.path())
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("git")
                .args(["add", "."])
                .current_dir(dir.path())
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("git")
                .args([
                    "-c",
                    "user.email=test@example.invalid",
                    "-c",
                    "user.name=Test",
                    "commit",
                    "-m",
                    "baseline",
                ])
                .current_dir(dir.path())
                .status()
                .unwrap()
                .success()
        );

        std::fs::write(&path, "new\n").unwrap();

        assert_eq!(
            changed_files(dir.path()),
            vec!["tests/staticfiles_tests/apps/test/static/test/⊗.txt".to_string()]
        );
    }

    #[test]
    fn git_worktree_materialization_preserves_manifest_setup_artifacts() {
        let _env_guard = crate::test_support::env_test_guard();
        let previous_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        let root = tempfile::tempdir().expect("tempdir");
        let parent = root.path().join("parent");
        let child = root.path().join("child");
        std::fs::create_dir_all(parent.join("src")).expect("source dir");
        std::fs::write(parent.join("src/lib.py"), "value = 1\n").expect("source file");
        assert!(
            Command::new("git")
                .arg("init")
                .current_dir(&parent)
                .status()
                .expect("git init")
                .success()
        );
        assert!(
            Command::new("git")
                .args(["add", "."])
                .current_dir(&parent)
                .status()
                .expect("git add")
                .success()
        );
        assert!(
            Command::new("git")
                .args([
                    "-c",
                    "user.email=test@example.invalid",
                    "-c",
                    "user.name=Test",
                    "commit",
                    "-m",
                    "baseline",
                ])
                .current_dir(&parent)
                .status()
                .expect("git commit")
                .success()
        );

        let artifact = "pkg/_compiled.cpython-36m-x86_64-linux-gnu.so";
        std::fs::create_dir_all(parent.join("pkg")).expect("artifact dir");
        std::fs::write(parent.join(artifact), b"prepared-binary").expect("artifact");
        let manifest = root.path().join("solver-validation-manifest.json");
        std::fs::write(
            &manifest,
            format!(
                "{{\"baseline_runnable_scopes\":[\"tests/test_pkg.py\"],\"protected_setup_artifacts\":[\"{artifact}\"]}}\n"
            ),
        )
        .expect("manifest");
        unsafe {
            std::env::set_var("SW_VALIDATION_MANIFEST", &manifest);
        }

        let report = materialize_workdir(parent.to_str().unwrap(), &child)
            .expect("prepared child materialization");

        assert_eq!(
            report.mode,
            MaterializationMode::GitWorktreeWithPreparedArtifacts
        );
        assert_eq!(report.protected_artifacts_requested, 1);
        assert_eq!(report.protected_artifacts_copied, 1);
        assert_eq!(
            std::fs::read(child.join(artifact)).expect("copied artifact"),
            b"prepared-binary"
        );
        assert!(child.join("src/lib.py").is_file());

        let _ = Command::new("git")
            .args(["worktree", "remove", "--force", child.to_str().unwrap()])
            .current_dir(&parent)
            .status();
        unsafe {
            if let Some(value) = previous_manifest {
                std::env::set_var("SW_VALIDATION_MANIFEST", value);
            } else {
                std::env::remove_var("SW_VALIDATION_MANIFEST");
            }
        }
    }

    #[test]
    fn default_work_root_is_not_artifact_dir() {
        unsafe {
            std::env::remove_var("SW_CANDIDATE_FANOUT_WORK_ROOT");
            std::env::set_var("SW_INSTANCE_ID", "repo/instance");
        }
        let config = Config::from_env();
        let root = temp_root(&config);
        assert!(root.to_string_lossy().contains("candidate-fanout-workdirs"));
        assert!(!root.starts_with("/results"));
        assert!(root.ends_with("repo-instance"));
        unsafe {
            std::env::remove_var("SW_INSTANCE_ID");
        }
    }

    #[test]
    fn tournament_merges_and_ranks_candidates_across_lanes() {
        let focused = execution(
            1,
            "diff --git a/src/lib.py b/src/lib.py\n+old\n+new\n",
            "[FINAL_VERIFICATION] UNAVAILABLE\n[POST_EDIT_REPAIR] PASS\n",
            2,
        );
        let mut full = execution(
            2,
            "diff --git a/src/lib.py b/src/lib.py\n-old\n+better\n",
            "[FINAL_VERIFICATION] PASS\n",
            2,
        );
        full.candidate_id = "full_fanout--h2".to_string();
        let batches = vec![
            FanoutBatch {
                namespace: "focused_probe".to_string(),
                executions: vec![focused],
                elapsed_ms: 10,
                fanout_stop_reason: None,
            },
            FanoutBatch {
                namespace: "full_fanout".to_string(),
                executions: vec![full],
                elapsed_ms: 20,
                fanout_stop_reason: None,
            },
        ];

        let executions = merge_batches(batches);
        let ranked = ranked_selectable_candidate_indices(&executions);

        assert_eq!(executions.len(), 2);
        assert_eq!(executions[ranked[0]].candidate_id, "full_fanout--h2");
    }

    #[test]
    fn candidate_namespace_is_artifact_safe() {
        assert_eq!(
            namespaced_candidate_id("full fanout/late", "h2-src-lib-py"),
            "full-fanout-late--h2-src-lib-py"
        );
    }
}
