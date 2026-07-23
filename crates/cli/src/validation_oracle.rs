use crate::repair_feedback::RepairSignalKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValidationTrustTier {
    TrustedPublicScope,
    StructuralPatchCheck,
    FeedbackOnly,
    ValidationUnavailable,
    ForbiddenOracle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceProvenance {
    TaskReproducer,
    PublicRegression,
    Structural,
    Diagnostic,
}

impl EvidenceProvenance {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TaskReproducer => "task_reproducer",
            Self::PublicRegression => "public_regression",
            Self::Structural => "structural",
            Self::Diagnostic => "diagnostic",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TestDelta {
    Fixed,
    Regressed,
    UnchangedPass,
    ChangedFail,
    UnchangedFail,
    Invalid,
    Unavailable,
}

impl TestDelta {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fixed => "fixed",
            Self::Regressed => "regressed",
            Self::UnchangedPass => "unchanged_pass",
            Self::ChangedFail => "changed_fail",
            Self::UnchangedFail => "unchanged_fail",
            Self::Invalid => "invalid",
            Self::Unavailable => "unavailable",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "fixed" => Some(Self::Fixed),
            "regressed" => Some(Self::Regressed),
            "unchanged_pass" => Some(Self::UnchangedPass),
            "changed_fail" => Some(Self::ChangedFail),
            "unchanged_fail" => Some(Self::UnchangedFail),
            "invalid" => Some(Self::Invalid),
            "unavailable" => Some(Self::Unavailable),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestObservation {
    pub kind: String,
    pub fingerprint: String,
    pub command: String,
    pub elapsed_ms: u128,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestEvidence {
    pub evidence_id: String,
    pub provenance: EvidenceProvenance,
    pub scope: Vec<String>,
    pub baseline: TestObservation,
    pub candidate: TestObservation,
    pub delta: TestDelta,
    pub runtime_fingerprint: String,
    pub patch_hash: String,
}

/// An immutable observation emitted for every solver `run_test` call. A later
/// controller may pair compatible baseline/candidate executions into
/// `TestEvidence`; this record deliberately never guesses that pairing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestExecution {
    pub schema_version: u8,
    pub phase: TestPhase,
    pub provenance: EvidenceProvenance,
    pub scope: Vec<String>,
    pub command: String,
    pub signal: String,
    pub fingerprint: String,
    pub elapsed_ms: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TestPhase {
    Baseline,
    Candidate,
}

impl TestPhase {
    fn from_dirty_worktree(workdir: &str) -> Self {
        let dirty = std::process::Command::new("git")
            .args(["diff", "--quiet"])
            .current_dir(workdir)
            .status()
            .map(|status| !status.success())
            .unwrap_or(true);
        if dirty {
            Self::Candidate
        } else {
            Self::Baseline
        }
    }
}

pub fn observation_from_output(output: &str, elapsed: Duration) -> TestObservation {
    TestObservation {
        kind: crate::repair_feedback::classify_output(output)
            .as_str()
            .to_string(),
        fingerprint: failure_fingerprint(output),
        command: output
            .lines()
            .find_map(|line| line.strip_prefix("SW_TEST_COMMAND="))
            .unwrap_or_default()
            .to_string(),
        elapsed_ms: elapsed.as_millis(),
    }
}

pub fn record_test_execution(args: &Value, workdir: &str, output: &str, elapsed: Duration) {
    let Some(path) = execution_ledger_path() else {
        return;
    };
    let execution = TestExecution {
        schema_version: 1,
        phase: TestPhase::from_dirty_worktree(workdir),
        provenance: EvidenceProvenance::Diagnostic,
        scope: scope_from_args(args),
        command: observation_from_output(output, elapsed).command,
        signal: crate::repair_feedback::classify_output(output)
            .as_str()
            .to_string(),
        fingerprint: failure_fingerprint(output),
        elapsed_ms: elapsed.as_millis(),
    };
    if let Err(err) = append_execution(&path, &execution) {
        eprintln!(
            "[TEST_EVIDENCE] append failed path={} error={}",
            path.display(),
            err
        );
    }
}

pub fn record_task_reproducer_execution(
    phase: TestPhase,
    scope: Vec<String>,
    output: &str,
    elapsed: Duration,
) {
    let Some(path) = execution_ledger_path() else {
        return;
    };
    let observation = observation_from_output(output, elapsed);
    let execution = TestExecution {
        schema_version: 1,
        phase,
        provenance: EvidenceProvenance::TaskReproducer,
        scope,
        command: observation.command,
        signal: observation.kind,
        fingerprint: observation.fingerprint,
        elapsed_ms: observation.elapsed_ms,
    };
    if let Err(err) = append_execution(&path, &execution) {
        eprintln!(
            "[TEST_EVIDENCE] append failed path={} error={}",
            path.display(),
            err
        );
    }
}

pub fn record_test_evidence(evidence: &TestEvidence) {
    let Some(path) = execution_ledger_path() else {
        return;
    };
    let path = path.with_file_name("test-evidence.jsonl");
    if let Err(err) = append_json_line(&path, evidence) {
        eprintln!(
            "[TEST_EVIDENCE] append failed path={} error={}",
            path.display(),
            err
        );
    }
}

fn execution_ledger_path() -> Option<std::path::PathBuf> {
    if let Ok(path) = std::env::var("SW_TEST_EVIDENCE_LEDGER") {
        if !path.trim().is_empty() {
            return Some(path.into());
        }
    }
    std::env::var("SW_ARTIFACT_DIR")
        .ok()
        .filter(|path| !path.trim().is_empty())
        .map(|path| std::path::PathBuf::from(path).join("test-executions.jsonl"))
}

fn scope_from_args(args: &Value) -> Vec<String> {
    let mut scope = Vec::new();
    for key in ["path", "test_file", "label"] {
        if let Some(value) = args.get(key).and_then(Value::as_str) {
            if !value.trim().is_empty() {
                scope.push(value.trim().to_string());
            }
        }
    }
    if let Some(values) = args.get("args").and_then(Value::as_array) {
        scope.extend(
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
        );
    }
    scope
}

fn append_execution(path: &Path, execution: &TestExecution) -> Result<(), String> {
    append_json_line(path, execution)
}

fn append_json_line<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("create evidence directory {}: {err}", parent.display()))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("open evidence ledger {}: {err}", path.display()))?;
    serde_json::to_writer(&mut file, value)
        .map_err(|err| format!("encode evidence execution: {err}"))?;
    file.write_all(b"\n")
        .map_err(|err| format!("append evidence newline: {err}"))
}

pub fn delta_for(
    provenance: EvidenceProvenance,
    baseline: RepairSignalKind,
    candidate: RepairSignalKind,
) -> TestDelta {
    if matches!(
        candidate,
        RepairSignalKind::EnvUnavailable | RepairSignalKind::Timeout
    ) {
        return TestDelta::Unavailable;
    }
    if matches!(
        candidate,
        RepairSignalKind::InvalidScope | RepairSignalKind::SyntaxOrCollection
    ) && !matches!(provenance, EvidenceProvenance::Structural)
    {
        return TestDelta::Invalid;
    }
    match (baseline, candidate) {
        (RepairSignalKind::Passed, RepairSignalKind::Passed) => TestDelta::UnchangedPass,
        (RepairSignalKind::Passed, _) => TestDelta::Regressed,
        (_, RepairSignalKind::Passed) => match provenance {
            EvidenceProvenance::TaskReproducer => TestDelta::Fixed,
            EvidenceProvenance::PublicRegression => TestDelta::UnchangedPass,
            EvidenceProvenance::Structural => TestDelta::Fixed,
            EvidenceProvenance::Diagnostic => TestDelta::UnchangedPass,
        },
        _ => TestDelta::UnchangedFail,
    }
}

pub fn delta_for_observations(
    provenance: EvidenceProvenance,
    baseline: RepairSignalKind,
    candidate: RepairSignalKind,
    baseline_fingerprint: &str,
    candidate_fingerprint: &str,
) -> TestDelta {
    let broad_delta = delta_for(provenance, baseline, candidate);
    if broad_delta == TestDelta::UnchangedFail
        && !baseline_fingerprint.trim().is_empty()
        && !candidate_fingerprint.trim().is_empty()
        && baseline_fingerprint.trim() != candidate_fingerprint.trim()
    {
        TestDelta::ChangedFail
    } else {
        broad_delta
    }
}

impl ValidationTrustTier {
    pub fn as_str(self) -> &'static str {
        match self {
            ValidationTrustTier::TrustedPublicScope => "trusted_public_scope",
            ValidationTrustTier::StructuralPatchCheck => "structural_patch_check",
            ValidationTrustTier::FeedbackOnly => "feedback_only",
            ValidationTrustTier::ValidationUnavailable => "validation_unavailable",
            ValidationTrustTier::ForbiddenOracle => "forbidden_oracle",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidationDecision {
    pub kind: RepairSignalKind,
    pub trust_tier: ValidationTrustTier,
    pub candidate_blocking: bool,
    pub reason: String,
}

impl ValidationDecision {
    pub fn skip(kind: RepairSignalKind, reason: impl Into<String>) -> Self {
        Self {
            kind,
            trust_tier: ValidationTrustTier::ValidationUnavailable,
            candidate_blocking: false,
            reason: reason.into(),
        }
    }

    pub fn feedback(kind: RepairSignalKind, reason: impl Into<String>) -> Self {
        Self {
            kind,
            trust_tier: ValidationTrustTier::FeedbackOnly,
            candidate_blocking: false,
            reason: reason.into(),
        }
    }

    pub fn structural(kind: RepairSignalKind, reason: impl Into<String>) -> Self {
        Self {
            kind,
            trust_tier: ValidationTrustTier::StructuralPatchCheck,
            candidate_blocking: true,
            reason: reason.into(),
        }
    }

    pub fn trusted(kind: RepairSignalKind, reason: impl Into<String>) -> Self {
        Self {
            kind,
            trust_tier: ValidationTrustTier::TrustedPublicScope,
            candidate_blocking: kind.is_candidate_blocking(),
            reason: reason.into(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
struct SolverValidationManifest {
    #[serde(default)]
    baseline_runnable_scopes: Vec<String>,
    #[serde(default)]
    baseline_scope_outcomes: Vec<BaselineScopeOutcome>,
    #[serde(default)]
    public_test_files: Vec<String>,
    #[serde(default)]
    protected_setup_artifacts: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BaselineScopeRelation {
    #[default]
    Unknown,
    Regression,
    TaskRelated,
    UnrelatedFailure,
}

impl BaselineScopeRelation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Regression => "regression",
            Self::TaskRelated => "task_related",
            Self::UnrelatedFailure => "unrelated_failure",
        }
    }

    pub fn is_task_related(self) -> bool {
        self == Self::TaskRelated
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BaselineScopeOutcome {
    pub files: Vec<String>,
    pub kind: String,
    pub fingerprint: String,
    #[serde(default)]
    pub relation: BaselineScopeRelation,
    #[serde(default)]
    pub elapsed_ms: u64,
}

pub fn manifest_path_from_env() -> Option<String> {
    std::env::var("SW_VALIDATION_MANIFEST")
        .ok()
        .or_else(|| std::env::var("SW_SOLVER_VALIDATION_MANIFEST").ok())
        .filter(|value| !value.trim().is_empty())
}

fn load_manifest() -> Option<SolverValidationManifest> {
    let path = manifest_path_from_env()?;
    match load_manifest_from_path(&path) {
        Ok(manifest) => Some(manifest),
        Err(err) => {
            eprintln!("[VALIDATION_ORACLE] manifest_unavailable {}", err);
            None
        }
    }
}

fn load_manifest_from_path(path: &str) -> Result<SolverValidationManifest, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|err| format!("path={} phase=read error={}", path, err))?;
    serde_json::from_str(&content).map_err(|err| format!("path={} phase=parse error={}", path, err))
}

pub fn protected_setup_artifacts() -> Vec<String> {
    let mut artifacts: Vec<String> = load_manifest()
        .map(|manifest| manifest.protected_setup_artifacts)
        .unwrap_or_default()
        .into_iter()
        .map(|path| normalize_repo_path(&path))
        .filter(|path| !path.is_empty())
        .collect();
    artifacts.sort();
    artifacts.dedup();
    artifacts
}

pub fn baseline_runnable_scopes() -> Vec<String> {
    let mut scopes: Vec<String> = load_manifest()
        .map(|manifest| manifest.baseline_runnable_scopes)
        .unwrap_or_default()
        .into_iter()
        .map(|path| normalize_repo_path(&path))
        .filter(|path| !path.is_empty())
        .collect();
    scopes.extend(inline_baseline_runnable_scopes());
    scopes.sort();
    scopes.dedup();
    scopes
}

pub fn public_test_files() -> Vec<String> {
    let mut files: Vec<String> = load_manifest()
        .map(|manifest| manifest.public_test_files)
        .unwrap_or_default()
        .into_iter()
        .map(|path| normalize_repo_path(&path))
        .filter(|path| !path.is_empty())
        .collect();
    files.sort();
    files.dedup();
    files
}

pub fn baseline_scope_outcome(files: &[String]) -> Option<BaselineScopeOutcome> {
    let normalized = normalized_scope_files(files);
    if normalized.is_empty() {
        return None;
    }
    let mut outcomes = load_manifest()
        .map(|manifest| manifest.baseline_scope_outcomes)
        .unwrap_or_default();
    outcomes.extend(inline_baseline_scope_outcomes());
    outcomes.into_iter().rev().find(|outcome| {
        let mut outcome_files = outcome.files.clone();
        outcome_files = normalized_scope_files(&outcome_files);
        outcome_files == normalized
    })
}

pub fn baseline_scope_elapsed_ms(files: &[String]) -> Option<u64> {
    baseline_scope_outcome(files)
        .map(|outcome| outcome.elapsed_ms)
        .filter(|elapsed_ms| *elapsed_ms > 0)
}

pub fn scope_baseline_runnable(files: &[String]) -> bool {
    let runnable: HashSet<String> = baseline_runnable_scopes().into_iter().collect();
    !files.is_empty()
        && files
            .iter()
            .map(|path| normalize_repo_path(path))
            .all(|path| runnable.contains(&path))
}

pub fn record_baseline_runnable_scope(files: &[String]) {
    let normalized: Vec<String> = files
        .iter()
        .map(|path| normalize_repo_path(path))
        .filter(|path| !path.is_empty())
        .collect();
    if normalized.is_empty() {
        return;
    }

    record_inline_baseline_runnable_scopes(&normalized);

    let Some(path) = manifest_path_from_env() else {
        return;
    };
    let content = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    let mut value: Value =
        serde_json::from_str(&content).unwrap_or_else(|_| Value::Object(serde_json::Map::new()));
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let entry = object
        .entry("baseline_runnable_scopes")
        .or_insert_with(|| Value::Array(Vec::new()));
    if !entry.is_array() {
        *entry = Value::Array(Vec::new());
    }
    let Some(scopes) = entry.as_array_mut() else {
        return;
    };
    for scope in &normalized {
        if !scopes.iter().any(|existing| {
            existing
                .as_str()
                .map(|existing| normalize_repo_path(existing) == *scope)
                .unwrap_or(false)
        }) {
            scopes.push(Value::String(scope.clone()));
        }
    }
    if let Ok(rendered) = serde_json::to_string_pretty(&value) {
        if let Err(err) = std::fs::write(&path, format!("{rendered}\n")) {
            eprintln!(
                "[VALIDATION_ORACLE] manifest_record_failed path={} error={}",
                path, err
            );
        }
    }
}

pub fn record_baseline_scope_outcome(
    files: &[String],
    kind: RepairSignalKind,
    output: &str,
    relation: BaselineScopeRelation,
) {
    record_baseline_scope_outcome_timed(
        files,
        kind,
        output,
        relation,
        std::time::Duration::ZERO,
    );
}

pub fn record_baseline_scope_outcome_timed(
    files: &[String],
    kind: RepairSignalKind,
    output: &str,
    relation: BaselineScopeRelation,
    elapsed: std::time::Duration,
) {
    let normalized = normalized_scope_files(files);
    if normalized.is_empty() {
        return;
    }
    if matches!(
        kind,
        RepairSignalKind::Passed
            | RepairSignalKind::AssertionFailure
            | RepairSignalKind::UnknownFailure
    ) {
        record_baseline_runnable_scope(&normalized);
    }

    let outcome = BaselineScopeOutcome {
        files: normalized.clone(),
        kind: kind.as_str().to_string(),
        fingerprint: failure_fingerprint(output),
        relation,
        elapsed_ms: elapsed.as_millis().min(u128::from(u64::MAX)) as u64,
    };
    record_inline_baseline_scope_outcome(&outcome);

    let Some(path) = manifest_path_from_env() else {
        return;
    };
    let content = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    let mut value: Value =
        serde_json::from_str(&content).unwrap_or_else(|_| Value::Object(serde_json::Map::new()));
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let entry = object
        .entry("baseline_scope_outcomes")
        .or_insert_with(|| Value::Array(Vec::new()));
    if !entry.is_array() {
        *entry = Value::Array(Vec::new());
    }
    let Some(outcomes) = entry.as_array_mut() else {
        return;
    };
    outcomes.retain(|existing| {
        serde_json::from_value::<BaselineScopeOutcome>(existing.clone())
            .map(|existing| normalized_scope_files(&existing.files) != normalized)
            .unwrap_or(false)
    });
    if let Ok(serialized) = serde_json::to_value(&outcome) {
        outcomes.push(serialized);
    }
    if let Ok(rendered) = serde_json::to_string_pretty(&value) {
        if let Err(err) = std::fs::write(&path, format!("{rendered}\n")) {
            eprintln!(
                "[VALIDATION_ORACLE] manifest_outcome_record_failed path={} error={}",
                path, err
            );
        }
    }
}

pub fn is_protected_setup_artifact(path: &str) -> bool {
    let normalized = normalize_repo_path(path);
    if normalized.is_empty() {
        return false;
    }
    if let Some(manifest) = load_manifest() {
        if manifest
            .protected_setup_artifacts
            .iter()
            .map(|entry| normalize_repo_path(entry))
            .any(|entry| normalized == entry || normalized.starts_with(&(entry + "/")))
        {
            return true;
        }
    }
    is_common_setup_artifact(&normalized)
}

pub fn classify_repair_scope(
    kind: RepairSignalKind,
    output: &str,
    changed_files: &[(String, usize, usize)],
    attempted_files: &[String],
    baseline_runnable: bool,
) -> ValidationDecision {
    if contains_forbidden_oracle_marker(output) {
        return ValidationDecision {
            kind,
            trust_tier: ValidationTrustTier::ForbiddenOracle,
            candidate_blocking: false,
            reason: "validation output referenced forbidden SWE-bench oracle data".to_string(),
        };
    }

    match kind {
        RepairSignalKind::EnvUnavailable => {
            return ValidationDecision::skip(kind, "test environment unavailable");
        }
        RepairSignalKind::InvalidScope => {
            return ValidationDecision::skip(kind, "scope did not run tests");
        }
        RepairSignalKind::Timeout => {
            return ValidationDecision::skip(kind, "scope validation timed out");
        }
        RepairSignalKind::Passed => {
            if baseline_runnable {
                return ValidationDecision::trusted(kind, "baseline-runnable public scope passed");
            }
            return ValidationDecision::feedback(kind, "unproven scoped pass is feedback only");
        }
        RepairSignalKind::SyntaxOrCollection => {
            if output_references_changed_source(output, changed_files) {
                return ValidationDecision::structural(
                    kind,
                    "collection/syntax failure references changed source",
                );
            }
            return ValidationDecision::skip(
                kind,
                "collection/setup failure did not reach changed source",
            );
        }
        RepairSignalKind::UnknownFailure => {
            if attempted_files.len() > 1 {
                return ValidationDecision::feedback(
                    kind,
                    "grouped scope failure is not trusted without singleton baseline proof",
                );
            }
            if baseline_runnable {
                return ValidationDecision::feedback(
                    kind,
                    "scope is runnable but its baseline outcome is unknown",
                );
            }
            return ValidationDecision::feedback(
                kind,
                "unproven public scope failed without baseline proof",
            );
        }
        RepairSignalKind::AssertionFailure => {
            if attempted_files.len() > 1 && !baseline_runnable {
                return ValidationDecision::feedback(
                    kind,
                    "grouped assertion failure is feedback only without baseline proof",
                );
            }
            if baseline_runnable {
                return ValidationDecision::feedback(
                    kind,
                    "scope is runnable but its baseline outcome is unknown",
                );
            }
            return ValidationDecision::feedback(
                kind,
                "assertion failure is feedback only until the scope is baseline-proven",
            );
        }
    }
}

pub fn classify_candidate_scope(
    kind: RepairSignalKind,
    output: &str,
    changed_files: &[(String, usize, usize)],
    attempted_files: &[String],
) -> ValidationDecision {
    let baseline = baseline_scope_outcome(attempted_files);
    classify_candidate_scope_against_baseline(
        kind,
        output,
        changed_files,
        attempted_files,
        baseline.as_ref(),
    )
}

pub fn classify_candidate_scope_against_baseline(
    kind: RepairSignalKind,
    output: &str,
    changed_files: &[(String, usize, usize)],
    attempted_files: &[String],
    baseline: Option<&BaselineScopeOutcome>,
) -> ValidationDecision {
    if contains_forbidden_oracle_marker(output) {
        return ValidationDecision {
            kind,
            trust_tier: ValidationTrustTier::ForbiddenOracle,
            candidate_blocking: false,
            reason: "validation output referenced forbidden SWE-bench oracle data".to_string(),
        };
    }

    if kind == RepairSignalKind::SyntaxOrCollection {
        let candidate_fingerprint = failure_fingerprint(output);
        if let Some(baseline) = baseline.filter(|baseline| {
            !baseline.fingerprint.is_empty() && baseline.fingerprint == candidate_fingerprint
        }) {
            return if baseline.relation.is_task_related() {
                ValidationDecision::trusted(
                    kind,
                    "task-related baseline collection/syntax failure is unchanged",
                )
            } else {
                ValidationDecision::feedback(
                    kind,
                    "candidate reproduced the baseline collection/setup failure",
                )
            };
        }
        if output_references_changed_source(output, changed_files) {
            return ValidationDecision::structural(
                kind,
                "collection/syntax failure references changed source and differs from baseline",
            );
        }
    }

    match kind {
        RepairSignalKind::EnvUnavailable => {
            ValidationDecision::skip(kind, "test environment unavailable")
        }
        RepairSignalKind::InvalidScope => ValidationDecision::skip(kind, "scope did not run tests"),
        RepairSignalKind::Timeout => ValidationDecision::skip(kind, "scope validation timed out"),
        RepairSignalKind::Passed => match baseline {
            Some(baseline) if baseline.kind == RepairSignalKind::Passed.as_str() => {
                ValidationDecision::trusted(kind, "baseline-passing public scope still passes")
            }
            Some(baseline) if baseline.relation.is_task_related() => ValidationDecision::trusted(
                kind,
                "task-related public scope improved relative to its recorded baseline failure",
            ),
            Some(_) => ValidationDecision::feedback(
                kind,
                "non-issue baseline failure disappeared; this is not repair proof",
            ),
            None => ValidationDecision::feedback(
                kind,
                "public scope passed without a recorded baseline outcome",
            ),
        },
        RepairSignalKind::AssertionFailure
        | RepairSignalKind::SyntaxOrCollection
        | RepairSignalKind::UnknownFailure => {
            let Some(baseline) = baseline else {
                return classify_repair_scope(kind, output, changed_files, attempted_files, false);
            };
            if baseline.kind == RepairSignalKind::Passed.as_str() {
                return ValidationDecision::trusted(
                    kind,
                    "candidate regressed a baseline-passing public scope",
                );
            }
            let candidate_fingerprint = failure_fingerprint(output);
            if baseline.relation.is_task_related() {
                if output_references_changed_source(output, changed_files) {
                    return ValidationDecision::structural(
                        kind,
                        "task-related baseline scope still fails and references changed source",
                    );
                }
                return ValidationDecision::trusted(
                    kind,
                    "task-related baseline scope still fails",
                );
            }
            if !baseline.fingerprint.is_empty() && baseline.fingerprint == candidate_fingerprint {
                return ValidationDecision::feedback(
                    kind,
                    "candidate reproduced a recorded non-issue baseline failure",
                );
            }
            if output_references_changed_source(output, changed_files) {
                return ValidationDecision::structural(
                    kind,
                    "candidate failure differs from baseline and references changed source",
                );
            }
            ValidationDecision::feedback(
                kind,
                "candidate failure differs from baseline but is not tied to changed source",
            )
        }
    }
}

pub fn failure_fingerprint(output: &str) -> String {
    let mut specific = Vec::new();
    let mut summaries = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        let is_specific = lower.contains("assertionerror")
            || lower.contains("syntaxerror")
            || lower.contains("indentationerror")
            || lower.contains("taberror")
            || lower.contains("modulenotfounderror")
            || lower.contains("importerror")
            || lower.contains("nameerror")
            || lower.contains("typeerror")
            || lower.contains("valueerror")
            || lower.contains("indexerror")
            || lower.contains("keyerror")
            || lower.contains("attributeerror")
            || lower.contains("runtimeerror");
        let is_summary = line.starts_with("FAILED ")
            || line.starts_with("ERROR ")
            || line.starts_with("FAIL: ")
            || line.starts_with("ERROR: ")
            || line.starts_with("E ");
        if line.is_empty() || !(is_specific || is_summary) {
            continue;
        }
        let compact = line.split_whitespace().collect::<Vec<_>>().join(" ");
        let target = if is_specific {
            &mut specific
        } else {
            &mut summaries
        };
        if !target.iter().any(|existing| existing == &compact) {
            target.push(compact);
        }
    }
    specific.extend(summaries);
    specific.truncate(16);
    specific.join("\n")
}

pub fn output_references_changed_source(
    output: &str,
    changed_files: &[(String, usize, usize)],
) -> bool {
    if changed_files.is_empty() {
        return false;
    }
    let normalized_output = output.replace('\\', "/");
    let normalized_output_lower = normalized_output.to_ascii_lowercase();
    changed_files.iter().any(|(path, _, _)| {
        let normalized_path = normalize_repo_path(path);
        changed_source_reference_tokens(&normalized_path)
            .iter()
            .any(|token| {
                normalized_output.contains(token)
                    || normalized_output_lower.contains(&token.to_ascii_lowercase())
            })
    })
}

fn inline_baseline_runnable_scopes() -> HashSet<String> {
    std::env::var("SW_BASELINE_RUNNABLE_SCOPES_INLINE")
        .unwrap_or_default()
        .split(':')
        .map(normalize_repo_path)
        .filter(|path| !path.is_empty())
        .collect()
}

fn inline_baseline_scope_outcomes() -> Vec<BaselineScopeOutcome> {
    std::env::var("SW_BASELINE_SCOPE_OUTCOMES_INLINE")
        .ok()
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

fn record_inline_baseline_scope_outcome(outcome: &BaselineScopeOutcome) {
    let mut outcomes = inline_baseline_scope_outcomes();
    outcomes.retain(|existing| {
        normalized_scope_files(&existing.files) != normalized_scope_files(&outcome.files)
    });
    outcomes.push(outcome.clone());
    if let Ok(serialized) = serde_json::to_string(&outcomes) {
        unsafe {
            std::env::set_var("SW_BASELINE_SCOPE_OUTCOMES_INLINE", serialized);
        }
    }
}

fn normalized_scope_files(files: &[String]) -> Vec<String> {
    let mut normalized: Vec<String> = files
        .iter()
        .map(|path| normalize_repo_path(path))
        .filter(|path| !path.is_empty())
        .collect();
    normalized.sort();
    normalized.dedup();
    normalized
}

fn record_inline_baseline_runnable_scopes(files: &[String]) {
    let mut scopes = inline_baseline_runnable_scopes();
    scopes.extend(files.iter().map(|path| normalize_repo_path(path)));
    let mut scopes: Vec<String> = scopes.into_iter().filter(|path| !path.is_empty()).collect();
    scopes.sort();
    unsafe {
        std::env::set_var("SW_BASELINE_RUNNABLE_SCOPES_INLINE", scopes.join(":"));
    }
}

fn changed_source_reference_tokens(path: &str) -> Vec<String> {
    let normalized = normalize_repo_path(path);
    if normalized.is_empty() {
        return Vec::new();
    }

    let mut tokens = vec![normalized.clone()];
    if let Some(module) = normalized.strip_suffix(".py") {
        tokens.push(module.replace('/', "."));
    }
    let parts: Vec<&str> = normalized.split('/').collect();
    for width in [3usize, 2usize] {
        if parts.len() >= width {
            tokens.push(parts[parts.len() - width..].join("/"));
        }
    }
    if let Some(name) = Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())
    {
        if !matches!(
            name,
            "__init__.py" | "base.py" | "core.py" | "utils.py" | "common.py"
        ) {
            tokens.push(format!("File \"{}", name));
            tokens.push(format!("File '{}", name));
            tokens.push(format!("/{name}"));
        }
    }
    tokens.sort();
    tokens.dedup();
    tokens
}

fn contains_forbidden_oracle_marker(output: &str) -> bool {
    output.contains("FAIL_TO_PASS")
        || output.contains("PASS_TO_PASS")
        || output.contains("test_patch")
        || output.contains("hints_text")
}

fn normalize_repo_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    while let Some(stripped) = normalized.strip_prefix("./") {
        normalized = stripped.to_string();
    }
    normalized
}

fn is_common_setup_artifact(path: &str) -> bool {
    let path_obj = Path::new(path);
    let Some(name) = path_obj.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    name.ends_with(".so")
        || name.ends_with(".pyd")
        || name.ends_with(".dll")
        || name.ends_with(".dylib")
        || name.ends_with(".egg-info")
        || path.contains(".egg-info/")
        || path.starts_with("build/")
        || path.contains("/build/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_fingerprint_prioritizes_specific_exception_over_runner_summary() {
        let fingerprint = failure_fingerprint(
            "ERROR conda.cli.main_run:execute(124): command failed\nE   NameError: name 'pytest' is not defined\nFAILED test_bug.py::test_bug - NameError\n",
        );
        assert!(fingerprint.starts_with("E NameError: name 'pytest' is not defined"));
        assert!(fingerprint.contains("ERROR conda.cli.main_run"));
    }

    #[test]
    fn task_reproducer_fail_to_pass_is_fixed() {
        assert_eq!(
            delta_for(
                EvidenceProvenance::TaskReproducer,
                RepairSignalKind::AssertionFailure,
                RepairSignalKind::Passed,
            ),
            TestDelta::Fixed
        );
    }

    #[test]
    fn task_reproducer_distinguishes_changed_failure_from_unchanged_failure() {
        let baseline = "E IndexError: tuple index out of range";
        let candidate = "E AssertionError: assert not ['ascii.ecsv']";
        assert_eq!(
            delta_for_observations(
                EvidenceProvenance::TaskReproducer,
                RepairSignalKind::AssertionFailure,
                RepairSignalKind::AssertionFailure,
                baseline,
                candidate,
            ),
            TestDelta::ChangedFail
        );
        assert_eq!(
            delta_for_observations(
                EvidenceProvenance::TaskReproducer,
                RepairSignalKind::AssertionFailure,
                RepairSignalKind::AssertionFailure,
                baseline,
                baseline,
            ),
            TestDelta::UnchangedFail
        );
    }

    #[test]
    fn public_regression_pass_to_fail_is_regressed() {
        assert_eq!(
            delta_for(
                EvidenceProvenance::PublicRegression,
                RepairSignalKind::Passed,
                RepairSignalKind::AssertionFailure,
            ),
            TestDelta::Regressed
        );
    }

    #[test]
    fn runtime_unavailable_is_not_semantic_evidence() {
        assert_eq!(
            delta_for(
                EvidenceProvenance::TaskReproducer,
                RepairSignalKind::AssertionFailure,
                RepairSignalKind::EnvUnavailable,
            ),
            TestDelta::Unavailable
        );
    }

    #[test]
    fn test_delta_parser_accepts_only_typed_ledger_values() {
        assert_eq!(TestDelta::parse("fixed"), Some(TestDelta::Fixed));
        assert_eq!(
            TestDelta::parse("UNCHANGED_FAIL"),
            Some(TestDelta::UnchangedFail)
        );
        assert_eq!(
            TestDelta::parse("CHANGED_FAIL"),
            Some(TestDelta::ChangedFail)
        );
        assert_eq!(TestDelta::parse("maybe"), None);
    }
    use std::fs;

    #[test]
    fn collection_noise_not_touching_changed_source_is_unavailable() {
        let changed = vec![("sklearn/base.py".to_string(), 1, 100)];
        let decision = classify_repair_scope(
            RepairSignalKind::SyntaxOrCollection,
            "ModuleNotFoundError: No module named 'sklearn.__check_build._check_build'",
            &changed,
            &["sklearn/tests/test_base.py".to_string()],
            false,
        );
        assert_eq!(
            decision.trust_tier,
            ValidationTrustTier::ValidationUnavailable
        );
        assert!(!decision.candidate_blocking);
    }

    #[test]
    fn malformed_validation_manifest_reports_parse_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("manifest.json");
        fs::write(&path, "{not json").expect("write manifest");

        let err = load_manifest_from_path(path.to_str().unwrap()).expect_err("parse failure");

        assert!(err.contains("phase=parse"), "{}", err);
        assert!(err.contains("manifest.json"), "{}", err);
    }

    #[test]
    fn syntax_failure_touching_changed_source_blocks_candidate() {
        let changed = vec![("sklearn/base.py".to_string(), 1, 100)];
        let decision = classify_repair_scope(
            RepairSignalKind::SyntaxOrCollection,
            "File \"sklearn/base.py\", line 44\nIndentationError: unexpected indent",
            &changed,
            &["sklearn/tests/test_base.py".to_string()],
            false,
        );
        assert_eq!(
            decision.trust_tier,
            ValidationTrustTier::StructuralPatchCheck
        );
        assert!(decision.candidate_blocking);
    }

    #[test]
    fn astropy_collection_error_touching_changed_source_blocks_candidate() {
        let changed = vec![("astropy/modeling/separable.py".to_string(), 1, 400)];
        let output = r#"ERROR collecting astropy/modeling/tests/test_separable.py
Traceback (most recent call last):
  File "/testbed/astropy/modeling/separable.py", line 315
    if left:
           ^
SyntaxError: invalid syntax"#;

        let decision = classify_repair_scope(
            RepairSignalKind::SyntaxOrCollection,
            output,
            &changed,
            &["astropy/modeling/tests/test_separable.py".to_string()],
            false,
        );

        assert_eq!(
            decision.trust_tier,
            ValidationTrustTier::StructuralPatchCheck
        );
        assert!(decision.candidate_blocking);
    }

    #[test]
    fn unchanged_baseline_collection_failure_is_not_a_candidate_regression() {
        let changed = vec![("astropy/modeling/separable.py".to_string(), 1, 400)];
        let output = r#"ERROR collecting astropy/modeling/tests/test_separable.py
  File "/testbed/astropy/modeling/separable.py", line 315
SyntaxError: invalid syntax"#;
        let baseline = BaselineScopeOutcome {
            files: vec!["astropy/modeling/tests/test_separable.py".to_string()],
            kind: RepairSignalKind::SyntaxOrCollection.as_str().to_string(),
            fingerprint: failure_fingerprint(output),
            relation: BaselineScopeRelation::UnrelatedFailure,
            elapsed_ms: 0,
        };

        let decision = classify_candidate_scope_against_baseline(
            RepairSignalKind::SyntaxOrCollection,
            output,
            &changed,
            &baseline.files,
            Some(&baseline),
        );

        assert_eq!(decision.trust_tier, ValidationTrustTier::FeedbackOnly);
        assert!(!decision.candidate_blocking);
        assert!(decision.reason.contains("baseline collection/setup"));
    }

    #[test]
    fn baseline_runnable_scope_record_is_durable() {
        let previous_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        let previous_solver_manifest = std::env::var("SW_SOLVER_VALIDATION_MANIFEST").ok();
        let previous_inline = std::env::var("SW_BASELINE_RUNNABLE_SCOPES_INLINE").ok();
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("manifest.json");
        fs::write(&path, "{\"baseline_runnable_scopes\":[]}").expect("write manifest");
        unsafe {
            std::env::set_var("SW_VALIDATION_MANIFEST", path.to_str().unwrap());
            std::env::remove_var("SW_SOLVER_VALIDATION_MANIFEST");
            std::env::remove_var("SW_BASELINE_RUNNABLE_SCOPES_INLINE");
        }

        let files = vec!["astropy/modeling/tests/test_separable.py".to_string()];

        assert!(!scope_baseline_runnable(&files));
        record_baseline_runnable_scope(&files);
        assert!(scope_baseline_runnable(&files));

        let manifest: SolverValidationManifest =
            serde_json::from_str(&fs::read_to_string(&path).expect("read manifest"))
                .expect("manifest json");
        assert_eq!(manifest.baseline_runnable_scopes, files);

        restore_env_var("SW_VALIDATION_MANIFEST", previous_manifest);
        restore_env_var("SW_SOLVER_VALIDATION_MANIFEST", previous_solver_manifest);
        restore_env_var("SW_BASELINE_RUNNABLE_SCOPES_INLINE", previous_inline);
    }

    #[test]
    fn grouped_assertion_failure_without_baseline_is_feedback_only() {
        let changed = vec![("pkg/source.py".to_string(), 1, 10)];
        let decision = classify_repair_scope(
            RepairSignalKind::AssertionFailure,
            "FAILED tests/test_a.py::test_one\nE   assert 1 == 2",
            &changed,
            &["tests/test_a.py".to_string(), "tests/test_b.py".to_string()],
            false,
        );
        assert_eq!(decision.trust_tier, ValidationTrustTier::FeedbackOnly);
        assert!(!decision.candidate_blocking);
    }

    #[test]
    fn baseline_scope_outcome_preserves_measured_runtime() {
        let _guard = crate::test_support::env_test_guard();
        let previous_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        let previous_inline = std::env::var("SW_BASELINE_SCOPE_OUTCOMES_INLINE").ok();
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("manifest.json");
        fs::write(&path, "{}").expect("manifest");
        unsafe {
            std::env::set_var("SW_VALIDATION_MANIFEST", &path);
            std::env::remove_var("SW_BASELINE_SCOPE_OUTCOMES_INLINE");
        }
        let files = vec!["tests/test_runtime.py".to_string()];

        record_baseline_scope_outcome_timed(
            &files,
            RepairSignalKind::Passed,
            "SW_TEST_EXIT_CODE=0\n1 passed\n",
            BaselineScopeRelation::Regression,
            std::time::Duration::from_millis(83_250),
        );

        assert_eq!(baseline_scope_elapsed_ms(&files), Some(83_250));
        restore_env_var("SW_VALIDATION_MANIFEST", previous_manifest);
        restore_env_var("SW_BASELINE_SCOPE_OUTCOMES_INLINE", previous_inline);
    }

    #[test]
    fn runnable_scope_without_baseline_outcome_cannot_block_candidate() {
        let decision = classify_repair_scope(
            RepairSignalKind::AssertionFailure,
            "FAILED tests/test_clock.py::test_stale_data\nE stale data",
            &[("pkg/source.py".to_string(), 1, 10)],
            &["tests/test_clock.py".to_string()],
            true,
        );

        assert_eq!(decision.trust_tier, ValidationTrustTier::FeedbackOnly);
        assert!(!decision.candidate_blocking);
        assert!(decision.reason.contains("baseline outcome is unknown"));
    }

    #[test]
    fn candidate_failure_blocks_when_public_scope_passed_at_baseline() {
        let _guard = crate::test_support::env_test_guard();
        let previous_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        let previous_inline = std::env::var("SW_BASELINE_SCOPE_OUTCOMES_INLINE").ok();
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("manifest.json");
        fs::write(&path, "{}").expect("manifest");
        unsafe {
            std::env::set_var("SW_VALIDATION_MANIFEST", &path);
            std::env::remove_var("SW_BASELINE_SCOPE_OUTCOMES_INLINE");
        }
        let files = vec!["sympy/geometry/tests/test_point.py".to_string()];
        record_baseline_scope_outcome(
            &files,
            RepairSignalKind::Passed,
            "SW_TEST_EXIT_CODE=0\n1 passed\n",
            BaselineScopeRelation::Regression,
        );

        let decision = classify_candidate_scope(
            RepairSignalKind::AssertionFailure,
            "SW_TEST_EXIT_CODE=1\nFAILED sympy/geometry/tests/test_point.py::test_issue\nE assert 2 == 1\n",
            &[("sympy/geometry/point.py".to_string(), 1, 2)],
            &files,
        );

        assert_eq!(decision.trust_tier, ValidationTrustTier::TrustedPublicScope);
        assert!(decision.candidate_blocking);
        restore_env_var("SW_VALIDATION_MANIFEST", previous_manifest);
        restore_env_var("SW_BASELINE_SCOPE_OUTCOMES_INLINE", previous_inline);
    }

    #[test]
    fn unchanged_baseline_failure_does_not_reject_candidate() {
        let _guard = crate::test_support::env_test_guard();
        let previous_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        let previous_inline = std::env::var("SW_BASELINE_SCOPE_OUTCOMES_INLINE").ok();
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("manifest.json");
        fs::write(&path, "{}").expect("manifest");
        unsafe {
            std::env::set_var("SW_VALIDATION_MANIFEST", &path);
            std::env::remove_var("SW_BASELINE_SCOPE_OUTCOMES_INLINE");
        }
        let files = vec!["tests/test_existing_failure.py".to_string()];
        let output = "SW_TEST_EXIT_CODE=1\nFAILED tests/test_existing_failure.py::test_known\nE assert 2 == 1\n";
        record_baseline_scope_outcome(
            &files,
            RepairSignalKind::AssertionFailure,
            output,
            BaselineScopeRelation::UnrelatedFailure,
        );

        let decision = classify_candidate_scope(
            RepairSignalKind::AssertionFailure,
            output,
            &[("pkg/source.py".to_string(), 1, 2)],
            &files,
        );

        assert_eq!(decision.trust_tier, ValidationTrustTier::FeedbackOnly);
        assert!(!decision.candidate_blocking);
        assert!(
            decision
                .reason
                .contains("reproduced a recorded non-issue baseline")
        );
        restore_env_var("SW_VALIDATION_MANIFEST", previous_manifest);
        restore_env_var("SW_BASELINE_SCOPE_OUTCOMES_INLINE", previous_inline);
    }

    fn restore_env_var(name: &str, previous: Option<String>) {
        unsafe {
            if let Some(value) = previous {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
    }

    #[test]
    fn execution_ledger_records_scope_phase_and_signal() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ledger.jsonl");
        let execution = TestExecution {
            schema_version: 1,
            phase: TestPhase::Candidate,
            provenance: EvidenceProvenance::Diagnostic,
            scope: vec!["tests/test_example.py".into()],
            command: "pytest tests/test_example.py".into(),
            signal: "assertion_failure".into(),
            fingerprint: "AssertionError: expected x".into(),
            elapsed_ms: 42,
        };
        append_execution(&path, &execution).unwrap();
        let line = std::fs::read_to_string(path).unwrap();
        let recorded: TestExecution = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(recorded, execution);
    }
}
