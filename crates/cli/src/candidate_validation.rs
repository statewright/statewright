use crate::{
    candidate_context::CandidateContextPacket, candidate_evidence::CandidateEvidence,
    repair_feedback, validation_oracle,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeSelection {
    pub scope: Value,
    pub desc: String,
    pub files: Vec<String>,
    pub baseline_keys: Vec<String>,
    pub role: ScopeRole,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeRole {
    Issue,
    Regression,
    Feedback,
}

impl ScopeRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Issue => "issue",
            Self::Regression => "regression",
            Self::Feedback => "feedback",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidationAssessment {
    pub signal: String,
    pub kind: repair_feedback::RepairSignalKind,
    pub decision: validation_oracle::ValidationDecision,
    pub diagnostic: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ValidationProvenance {
    pub candidate_id: String,
    pub scope_role: String,
    pub scope: Value,
    pub scope_desc: String,
    pub files: Vec<String>,
    pub baseline_keys: Vec<String>,
    pub baseline: Option<validation_oracle::BaselineScopeOutcome>,
    pub signal: String,
    pub kind: String,
    pub trust_tier: String,
    pub candidate_blocking: bool,
    pub reason: String,
    pub command: Option<String>,
}

pub fn select_scope(
    child_evidence: &CandidateEvidence,
    changed_files: &[String],
    context: &CandidateContextPacket,
) -> Option<ScopeSelection> {
    select_issue_scope()
        .or_else(|| select_regression_scope(child_evidence, changed_files, context, &[]))
}

pub fn select_issue_scope() -> Option<ScopeSelection> {
    let files = env_test_files();
    if !files.is_empty() {
        let baseline = validation_oracle::baseline_scope_outcome(&files);
        if baseline.as_ref().is_some_and(|baseline| {
            baseline.kind != repair_feedback::RepairSignalKind::Passed.as_str()
                && baseline.relation.is_task_related()
        }) {
            return Some(scope_selection_from_files(
                files,
                ScopeRole::Issue,
                "promoted_parent_failure",
            ));
        }
    }

    let label = std::env::var("SW_TEST_LABEL")
        .ok()
        .map(|label| label.trim().to_string())
        .filter(|label| !label.is_empty());
    if let Some(label) = label {
        let baseline_keys = vec![label_scope_key(&label)];
        let baseline = validation_oracle::baseline_scope_outcome(&baseline_keys);
        if baseline.as_ref().is_some_and(|baseline| {
            baseline.kind != repair_feedback::RepairSignalKind::Passed.as_str()
                && baseline.relation.is_task_related()
        }) {
            return Some(ScopeSelection {
                scope: json!({"label": label}),
                desc: format!("PROMOTED_ISSUE_TEST_LABEL={label}"),
                files: Vec::new(),
                baseline_keys,
                role: ScopeRole::Issue,
            });
        }
    }

    None
}

pub fn select_regression_scope(
    child_evidence: &CandidateEvidence,
    changed_files: &[String],
    context: &CandidateContextPacket,
    excluded_files: &[String],
) -> Option<ScopeSelection> {
    let sources: Vec<String> = changed_files
        .iter()
        .map(|path| normalize(path))
        .filter(|path| !path.is_empty() && !is_test_path(path))
        .collect();
    let mut candidates: HashMap<String, (usize, String)> = HashMap::new();

    for path in validation_oracle::public_test_files() {
        add_file_candidate(&mut candidates, &sources, &path, 0, "public_test_manifest");
    }
    for path in &context.advisory_test_files {
        add_file_candidate(&mut candidates, &sources, path, 350, "parent_locus_map");
    }
    for path in validation_oracle::baseline_runnable_scopes() {
        add_file_candidate(&mut candidates, &sources, &path, 300, "baseline_runnable");
    }
    for path in &child_evidence.scope_files {
        let bonus = if validation_oracle::scope_baseline_runnable(&[path.clone()]) {
            500
        } else {
            250
        };
        add_file_candidate(&mut candidates, &sources, path, bonus, "child_evidence");
    }
    let excluded: Vec<String> = excluded_files.iter().map(|path| normalize(path)).collect();
    candidates.retain(|path, _| {
        !excluded.iter().any(|excluded| excluded == path)
            && validation_oracle::baseline_scope_outcome(&[path.clone()]).is_none_or(|baseline| {
                baseline.kind == repair_feedback::RepairSignalKind::Passed.as_str()
            })
    });

    if let Some((path, (score, reason))) = candidates
        .into_iter()
        .max_by(|left, right| left.1.0.cmp(&right.1.0).then_with(|| right.0.cmp(&left.0)))
    {
        let role = validation_oracle::baseline_scope_outcome(&[path.clone()])
            .map(|_| ScopeRole::Regression)
            .unwrap_or(ScopeRole::Feedback);
        return Some(ScopeSelection {
            scope: json!({"path": path.clone()}),
            desc: format!(
                "SOURCE_MAPPED_TEST_FILE={} score={} reason={}",
                path, score, reason
            ),
            files: vec![path.clone()],
            baseline_keys: vec![path],
            role,
        });
    }

    std::env::var("SW_TEST_LABEL")
        .ok()
        .map(|label| label.trim().to_string())
        .filter(|label| !label.is_empty())
        .map(|label| ScopeSelection {
            scope: json!({"label": label}),
            desc: format!("SW_TEST_LABEL={label}"),
            files: Vec::new(),
            baseline_keys: vec![label_scope_key(&label)],
            role: ScopeRole::Feedback,
        })
}

fn scope_selection_from_files(
    mut files: Vec<String>,
    role: ScopeRole,
    reason: &str,
) -> ScopeSelection {
    files.sort();
    files.dedup();
    let first = files[0].clone();
    let rest = files[1..].to_vec();
    let scope = if rest.is_empty() {
        json!({"path": first})
    } else {
        json!({"path": first, "args": rest})
    };
    ScopeSelection {
        scope,
        desc: format!(
            "PROMOTED_ISSUE_TEST_FILES={} reason={reason}",
            files.join(":")
        ),
        baseline_keys: files.clone(),
        files,
        role,
    }
}

pub fn label_scope_key(label: &str) -> String {
    format!("__test_label__/{}", label.trim())
}

pub fn assess(
    output: &str,
    changed_files: &[(String, usize, usize)],
    attempted_files: &[String],
) -> ValidationAssessment {
    assess_with_baseline_keys(output, changed_files, attempted_files)
}

pub fn assess_with_baseline_keys(
    output: &str,
    changed_files: &[(String, usize, usize)],
    baseline_keys: &[String],
) -> ValidationAssessment {
    let baseline = validation_oracle::baseline_scope_outcome(baseline_keys);
    assess_against_baseline(output, changed_files, baseline_keys, baseline.as_ref())
}

pub fn assess_against_baseline(
    output: &str,
    changed_files: &[(String, usize, usize)],
    baseline_keys: &[String],
    baseline: Option<&validation_oracle::BaselineScopeOutcome>,
) -> ValidationAssessment {
    let kind = repair_feedback::classify_output(output);
    let decision = validation_oracle::classify_candidate_scope_against_baseline(
        kind,
        output,
        changed_files,
        baseline_keys,
        baseline,
    );
    let signal = match kind {
        repair_feedback::RepairSignalKind::Passed => match baseline {
            Some(ref baseline)
                if baseline.kind == repair_feedback::RepairSignalKind::Passed.as_str() =>
            {
                "regression_pass"
            }
            Some(ref baseline) if baseline.relation.is_task_related() => "source_scope_pass",
            Some(_) => "feedback_pass",
            None => "feedback_pass",
        },
        _ if decision.candidate_blocking => "fail",
        _ => "unavailable",
    }
    .to_string();
    ValidationAssessment {
        signal,
        kind,
        diagnostic: compact_diagnostic(output),
        decision,
    }
}

fn add_file_candidate(
    candidates: &mut HashMap<String, (usize, String)>,
    sources: &[String],
    path: &str,
    origin_bonus: usize,
    origin: &str,
) {
    let path = normalize(path);
    if path.is_empty() || !is_test_path(&path) {
        return;
    }
    let relation = sources
        .iter()
        .map(|source| source_test_relation_score(source, &path))
        .max()
        .unwrap_or(0);
    if !sources.is_empty() && relation == 0 && origin_bonus == 0 {
        return;
    }
    let score = relation.saturating_add(origin_bonus);
    let reason = format!("origin={origin} structural_relation={relation}");
    let entry = candidates.entry(path).or_insert((0, String::new()));
    if score > entry.0 {
        *entry = (score, reason);
    }
}

fn source_test_relation_score(source: &str, test: &str) -> usize {
    let source = normalize(source).to_ascii_lowercase();
    let test = normalize(test).to_ascii_lowercase();
    let source_stem = Path::new(&source)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("");
    let test_stem = Path::new(&test)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("");
    let exact = !source_stem.is_empty()
        && matches!(
            test_stem,
            value if value == format!("test_{source_stem}")
                || value == format!("{source_stem}_test")
                || value == format!("{source_stem}_tests")
        );
    if exact {
        return 1_000;
    }

    let mut score = 0usize;
    if let Some(parent) = Path::new(&source).parent().and_then(Path::to_str) {
        let sibling_tests = format!("{parent}/tests/");
        if test.starts_with(&sibling_tests) {
            score += 300;
        }
        let mut ancestor = parent;
        let mut distance = 0usize;
        while let Some((next, _)) = ancestor.rsplit_once('/') {
            distance += 1;
            ancestor = next;
            if test.starts_with(&format!("{ancestor}/tests/")) {
                score += 180usize.saturating_sub(distance * 20);
                break;
            }
        }
    }

    let source_tokens = path_tokens(&source);
    let test_tokens = path_tokens(&test);
    score
        + source_tokens
            .iter()
            .filter(|token| test_tokens.contains(token))
            .count()
            * 20
}

fn path_tokens(path: &str) -> Vec<String> {
    path.split(|ch: char| matches!(ch, '/' | '_' | '.' | '-'))
        .filter(|token| token.len() >= 4 && !matches!(*token, "test" | "tests"))
        .map(ToString::to_string)
        .collect()
}

fn env_test_files() -> Vec<String> {
    std::env::var("SW_TEST_FILES")
        .unwrap_or_default()
        .split(':')
        .map(normalize)
        .filter(|path| !path.is_empty())
        .collect()
}

fn compact_diagnostic(output: &str) -> String {
    let mut lines = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        if line.starts_with("SW_TEST_EXIT_CODE=")
            || line.starts_with("FAILED ")
            || line.starts_with("ERROR ")
            || line.starts_with("E ")
            || lower.contains("traceback")
            || lower.contains("syntaxerror")
            || lower.contains("indentationerror")
            || lower.contains("assertionerror")
            || lower.contains("modulenotfounderror")
            || lower.contains("importerror")
        {
            lines.push(line.to_string());
        }
        if lines.len() >= 12 {
            break;
        }
    }
    lines.join("\n")
}

fn normalize(path: &str) -> String {
    path.trim().trim_start_matches("./").replace('\\', "/")
}

fn is_test_path(path: &str) -> bool {
    crate::patch_authority::is_test_path(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn exact_source_test_mapping_beats_runnable_generic_sibling() {
        let _guard = crate::test_support::env_test_guard();
        let previous_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        let previous_test_files = std::env::var("SW_TEST_FILES").ok();
        let previous_test_label = std::env::var("SW_TEST_LABEL").ok();
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = dir.path().join("manifest.json");
        fs::write(
            &manifest,
            r#"{"public_test_files":["sympy/functions/elementary/tests/test_miscellaneous.py","sympy/functions/elementary/tests/test_hyperbolic.py"],"baseline_runnable_scopes":["sympy/functions/elementary/tests/test_miscellaneous.py"]}"#,
        )
        .expect("manifest");
        unsafe {
            std::env::set_var("SW_VALIDATION_MANIFEST", &manifest);
            std::env::remove_var("SW_TEST_FILES");
            std::env::remove_var("SW_TEST_LABEL");
        }
        let context = CandidateContextPacket::default();
        let evidence = CandidateEvidence::from_output(
            "[POST_EDIT_REPAIR] PASS authority=baseline_proven_source_scope scope=SOURCE_SCOPE_TEST_FILES=sympy/functions/elementary/tests/test_miscellaneous.py\n",
        );

        let selected = select_scope(
            &evidence,
            &["sympy/functions/elementary/hyperbolic.py".to_string()],
            &context,
        )
        .expect("scope");

        assert_eq!(
            selected.files,
            vec!["sympy/functions/elementary/tests/test_hyperbolic.py"]
        );
        restore_env("SW_VALIDATION_MANIFEST", previous_manifest);
        restore_env("SW_TEST_FILES", previous_test_files);
        restore_env("SW_TEST_LABEL", previous_test_label);
    }

    #[test]
    fn promoted_issue_failure_beats_exact_source_regression_scope() {
        let _guard = crate::test_support::env_test_guard();
        let previous_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        let previous_test_files = std::env::var("SW_TEST_FILES").ok();
        let previous_inline = std::env::var("SW_BASELINE_SCOPE_OUTCOMES_INLINE").ok();
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = dir.path().join("manifest.json");
        fs::write(&manifest, "{}").expect("manifest");
        let issue_file = "astropy/io/fits/tests/test_fitstime.py";
        let regression_file = "astropy/io/fits/tests/test_core.py";
        unsafe {
            std::env::set_var("SW_VALIDATION_MANIFEST", &manifest);
            std::env::set_var("SW_TEST_FILES", issue_file);
            std::env::remove_var("SW_BASELINE_SCOPE_OUTCOMES_INLINE");
        }
        validation_oracle::record_baseline_scope_outcome(
            &[issue_file.to_string()],
            repair_feedback::RepairSignalKind::AssertionFailure,
            "SW_TEST_EXIT_CODE=1\nFAILED astropy/io/fits/tests/test_fitstime.py::test_bug\n",
            validation_oracle::BaselineScopeRelation::TaskRelated,
        );
        validation_oracle::record_baseline_scope_outcome(
            &[regression_file.to_string()],
            repair_feedback::RepairSignalKind::Passed,
            "SW_TEST_EXIT_CODE=0\n1 passed\n",
            validation_oracle::BaselineScopeRelation::Regression,
        );
        let evidence = CandidateEvidence::from_output(&format!(
            "[POST_EDIT_REPAIR] REGRESSION_PASS scope=SOURCE_SCOPE_TEST_FILES={regression_file}\n"
        ));

        let selected = select_scope(
            &evidence,
            &["astropy/io/fits/card.py".to_string()],
            &CandidateContextPacket::default(),
        )
        .expect("scope");

        assert_eq!(selected.files, vec![issue_file]);
        assert_eq!(selected.role, ScopeRole::Issue);
        restore_env("SW_VALIDATION_MANIFEST", previous_manifest);
        restore_env("SW_TEST_FILES", previous_test_files);
        restore_env("SW_BASELINE_SCOPE_OUTCOMES_INLINE", previous_inline);
    }

    #[test]
    fn promoted_issue_failure_is_independent_of_candidate_locus() {
        let _guard = crate::test_support::env_test_guard();
        let previous_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        let previous_test_files = std::env::var("SW_TEST_FILES").ok();
        let previous_inline = std::env::var("SW_BASELINE_SCOPE_OUTCOMES_INLINE").ok();
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = dir.path().join("manifest.json");
        fs::write(&manifest, "{}").expect("manifest");
        let issue_file = "astropy/coordinates/tests/test_erfa_astrom.py";
        unsafe {
            std::env::set_var("SW_VALIDATION_MANIFEST", &manifest);
            std::env::set_var("SW_TEST_FILES", issue_file);
            std::env::remove_var("SW_BASELINE_SCOPE_OUTCOMES_INLINE");
        }
        validation_oracle::record_baseline_scope_outcome(
            &[issue_file.to_string()],
            repair_feedback::RepairSignalKind::AssertionFailure,
            "SW_TEST_EXIT_CODE=1\nFAILED astropy/coordinates/tests/test_erfa_astrom.py::test_bug\n",
            validation_oracle::BaselineScopeRelation::TaskRelated,
        );
        let evidence = CandidateEvidence::from_output(
            "[POST_EDIT_REPAIR] PASS authority=baseline_proven_source_scope scope=SOURCE_SCOPE_TEST_FILES=astropy/io/ascii/tests/test_html.py\n",
        );

        let selected = select_scope(
            &evidence,
            &["astropy/io/ascii/html.py".to_string()],
            &CandidateContextPacket::default(),
        )
        .expect("scope");

        assert_eq!(selected.files, vec![issue_file]);
        assert_eq!(selected.role, ScopeRole::Issue);
        restore_env("SW_VALIDATION_MANIFEST", previous_manifest);
        restore_env("SW_TEST_FILES", previous_test_files);
        restore_env("SW_BASELINE_SCOPE_OUTCOMES_INLINE", previous_inline);
    }

    #[test]
    fn unrelated_parent_failure_cannot_become_issue_scope() {
        let _guard = crate::test_support::env_test_guard();
        let previous_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        let previous_test_files = std::env::var("SW_TEST_FILES").ok();
        let previous_inline = std::env::var("SW_BASELINE_SCOPE_OUTCOMES_INLINE").ok();
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = dir.path().join("manifest.json");
        fs::write(&manifest, "{}").expect("manifest");
        let unrelated_file = "astropy/io/fits/tests/test_fitstime.py";
        let regression_file = "astropy/io/fits/tests/test_header.py";
        unsafe {
            std::env::set_var("SW_VALIDATION_MANIFEST", &manifest);
            std::env::set_var("SW_TEST_FILES", unrelated_file);
            std::env::remove_var("SW_BASELINE_SCOPE_OUTCOMES_INLINE");
        }
        validation_oracle::record_baseline_scope_outcome(
            &[unrelated_file.to_string()],
            repair_feedback::RepairSignalKind::AssertionFailure,
            "FAILED astropy/io/fits/tests/test_fitstime.py::test_time_to_fits_loc\n",
            validation_oracle::BaselineScopeRelation::UnrelatedFailure,
        );
        validation_oracle::record_baseline_scope_outcome(
            &[regression_file.to_string()],
            repair_feedback::RepairSignalKind::Passed,
            "1 passed\n",
            validation_oracle::BaselineScopeRelation::Regression,
        );
        let evidence = CandidateEvidence::from_output(&format!(
            "[POST_EDIT_REPAIR] REGRESSION_PASS scope=SOURCE_SCOPE_TEST_FILES={regression_file}\n"
        ));

        let selected = select_scope(
            &evidence,
            &["astropy/io/fits/card.py".to_string()],
            &CandidateContextPacket::default(),
        )
        .expect("regression scope");

        assert_eq!(selected.files, vec![regression_file]);
        assert_eq!(selected.role, ScopeRole::Regression);
        restore_env("SW_VALIDATION_MANIFEST", previous_manifest);
        restore_env("SW_TEST_FILES", previous_test_files);
        restore_env("SW_BASELINE_SCOPE_OUTCOMES_INLINE", previous_inline);
    }

    #[test]
    fn regression_scope_excludes_issue_and_prefers_baseline_pass() {
        let _guard = crate::test_support::env_test_guard();
        let previous_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        let previous_inline = std::env::var("SW_BASELINE_SCOPE_OUTCOMES_INLINE").ok();
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = dir.path().join("manifest.json");
        fs::write(&manifest, "{}").expect("manifest");
        let issue_file = "astropy/io/fits/tests/test_fitstime.py";
        let regression_file = "astropy/io/fits/tests/test_core.py";
        unsafe {
            std::env::set_var("SW_VALIDATION_MANIFEST", &manifest);
            std::env::remove_var("SW_BASELINE_SCOPE_OUTCOMES_INLINE");
        }
        validation_oracle::record_baseline_scope_outcome(
            &[issue_file.to_string()],
            repair_feedback::RepairSignalKind::AssertionFailure,
            "SW_TEST_EXIT_CODE=1\nFAILED astropy/io/fits/tests/test_fitstime.py::test_bug\n",
            validation_oracle::BaselineScopeRelation::TaskRelated,
        );
        validation_oracle::record_baseline_scope_outcome(
            &[regression_file.to_string()],
            repair_feedback::RepairSignalKind::Passed,
            "SW_TEST_EXIT_CODE=0\n1 passed\n",
            validation_oracle::BaselineScopeRelation::Regression,
        );
        let evidence = CandidateEvidence::from_output(&format!(
            "[POST_EDIT_REPAIR] REGRESSION_PASS scope=SOURCE_SCOPE_TEST_FILES={regression_file}\n"
        ));

        let selected = select_regression_scope(
            &evidence,
            &["astropy/io/fits/card.py".to_string()],
            &CandidateContextPacket::default(),
            &[issue_file.to_string()],
        )
        .expect("regression scope");

        assert_eq!(selected.files, vec![regression_file]);
        assert_eq!(selected.role, ScopeRole::Regression);
        restore_env("SW_VALIDATION_MANIFEST", previous_manifest);
        restore_env("SW_BASELINE_SCOPE_OUTCOMES_INLINE", previous_inline);
    }

    #[test]
    fn changed_source_syntax_failure_is_never_downgraded_by_feedback_flags() {
        let _guard = crate::test_support::env_test_guard();
        let previous_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        let previous_solver_manifest = std::env::var("SW_SOLVER_VALIDATION_MANIFEST").ok();
        let previous_inline = std::env::var("SW_BASELINE_SCOPE_OUTCOMES_INLINE").ok();
        unsafe {
            std::env::remove_var("SW_VALIDATION_MANIFEST");
            std::env::remove_var("SW_SOLVER_VALIDATION_MANIFEST");
            std::env::remove_var("SW_BASELINE_SCOPE_OUTCOMES_INLINE");
        }
        let output = "SW_TEST_SCOPE_TRUSTED=0\nSW_TEST_CAN_COMPLETE=0\nSW_TEST_EXIT_CODE=4\nFile \"sympy/geometry/point.py\", line 99\nIndentationError: unexpected indent\n";
        let assessment = assess(
            output,
            &[("sympy/geometry/point.py".to_string(), 1, 2)],
            &["sympy/geometry/tests/test_point.py".to_string()],
        );

        assert_eq!(assessment.signal, "fail");
        assert!(assessment.decision.candidate_blocking);
        restore_env("SW_VALIDATION_MANIFEST", previous_manifest);
        restore_env("SW_SOLVER_VALIDATION_MANIFEST", previous_solver_manifest);
        restore_env("SW_BASELINE_SCOPE_OUTCOMES_INLINE", previous_inline);
    }

    #[test]
    fn unchanged_baseline_pass_is_regression_evidence_not_repair_evidence() {
        let _guard = crate::test_support::env_test_guard();
        let previous_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        let previous_inline = std::env::var("SW_BASELINE_SCOPE_OUTCOMES_INLINE").ok();
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = dir.path().join("manifest.json");
        fs::write(&manifest, "{}").expect("manifest");
        unsafe {
            std::env::set_var("SW_VALIDATION_MANIFEST", &manifest);
            std::env::remove_var("SW_BASELINE_SCOPE_OUTCOMES_INLINE");
        }
        let files = vec!["tests/test_source.py".to_string()];
        validation_oracle::record_baseline_scope_outcome(
            &files,
            repair_feedback::RepairSignalKind::Passed,
            "SW_TEST_EXIT_CODE=0\n1 passed\n",
            validation_oracle::BaselineScopeRelation::Regression,
        );

        let assessment = assess(
            "SW_TEST_EXIT_CODE=0\n1 passed\n",
            &[("source.py".to_string(), 1, 1)],
            &files,
        );

        assert_eq!(assessment.signal, "regression_pass");
        assert!(!assessment.decision.candidate_blocking);
        restore_env("SW_VALIDATION_MANIFEST", previous_manifest);
        restore_env("SW_BASELINE_SCOPE_OUTCOMES_INLINE", previous_inline);
    }

    #[test]
    fn repaired_baseline_failure_is_source_scope_evidence() {
        let _guard = crate::test_support::env_test_guard();
        let previous_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        let previous_inline = std::env::var("SW_BASELINE_SCOPE_OUTCOMES_INLINE").ok();
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = dir.path().join("manifest.json");
        fs::write(&manifest, "{}").expect("manifest");
        unsafe {
            std::env::set_var("SW_VALIDATION_MANIFEST", &manifest);
            std::env::remove_var("SW_BASELINE_SCOPE_OUTCOMES_INLINE");
        }
        let files = vec!["tests/test_source.py".to_string()];
        validation_oracle::record_baseline_scope_outcome(
            &files,
            repair_feedback::RepairSignalKind::AssertionFailure,
            "SW_TEST_EXIT_CODE=1\nFAILED tests/test_source.py::test_bug\nE assert 2 == 1\n",
            validation_oracle::BaselineScopeRelation::TaskRelated,
        );

        let assessment = assess(
            "SW_TEST_EXIT_CODE=0\n1 passed\n",
            &[("source.py".to_string(), 1, 1)],
            &files,
        );

        assert_eq!(assessment.signal, "source_scope_pass");
        assert!(!assessment.decision.candidate_blocking);
        restore_env("SW_VALIDATION_MANIFEST", previous_manifest);
        restore_env("SW_BASELINE_SCOPE_OUTCOMES_INLINE", previous_inline);
    }

    #[test]
    fn unrepaired_baseline_failure_is_concrete_failure_evidence() {
        let _guard = crate::test_support::env_test_guard();
        let previous_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        let previous_inline = std::env::var("SW_BASELINE_SCOPE_OUTCOMES_INLINE").ok();
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = dir.path().join("manifest.json");
        fs::write(&manifest, "{}").expect("manifest");
        unsafe {
            std::env::set_var("SW_VALIDATION_MANIFEST", &manifest);
            std::env::remove_var("SW_BASELINE_SCOPE_OUTCOMES_INLINE");
        }
        let files = vec!["tests/test_source.py".to_string()];
        let failure =
            "SW_TEST_EXIT_CODE=1\nFAILED tests/test_source.py::test_bug\nE assert 2 == 1\n";
        validation_oracle::record_baseline_scope_outcome(
            &files,
            repair_feedback::RepairSignalKind::AssertionFailure,
            failure,
            validation_oracle::BaselineScopeRelation::TaskRelated,
        );

        let assessment = assess(failure, &[("source.py".to_string(), 1, 1)], &files);

        assert_eq!(assessment.signal, "fail");
        restore_env("SW_VALIDATION_MANIFEST", previous_manifest);
        restore_env("SW_BASELINE_SCOPE_OUTCOMES_INLINE", previous_inline);
    }

    #[test]
    fn unrelated_baseline_failure_neither_passes_nor_fails_candidate() {
        let _guard = crate::test_support::env_test_guard();
        let previous_manifest = std::env::var("SW_VALIDATION_MANIFEST").ok();
        let previous_inline = std::env::var("SW_BASELINE_SCOPE_OUTCOMES_INLINE").ok();
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest = dir.path().join("manifest.json");
        fs::write(&manifest, "{}").expect("manifest");
        unsafe {
            std::env::set_var("SW_VALIDATION_MANIFEST", &manifest);
            std::env::remove_var("SW_BASELINE_SCOPE_OUTCOMES_INLINE");
        }
        let files = vec!["tests/test_environment.py".to_string()];
        let failure =
            "SW_TEST_EXIT_CODE=1\nFAILED tests/test_environment.py::test_clock\nE stale data\n";
        validation_oracle::record_baseline_scope_outcome(
            &files,
            repair_feedback::RepairSignalKind::AssertionFailure,
            failure,
            validation_oracle::BaselineScopeRelation::UnrelatedFailure,
        );

        let changed = vec![("src.py".to_string(), 1, 1)];
        let still_failing = assess(failure, &changed, &files);
        let disappeared = assess("SW_TEST_EXIT_CODE=0\n1 passed\n", &changed, &files);

        assert_eq!(still_failing.signal, "unavailable");
        assert_eq!(disappeared.signal, "feedback_pass");
        assert!(!still_failing.decision.candidate_blocking);
        assert!(!disappeared.decision.candidate_blocking);
        restore_env("SW_VALIDATION_MANIFEST", previous_manifest);
        restore_env("SW_BASELINE_SCOPE_OUTCOMES_INLINE", previous_inline);
    }

    #[test]
    fn captured_baseline_drives_revalidation_without_manifest_state() {
        let baseline = validation_oracle::BaselineScopeOutcome {
            files: vec!["tests/test_source.py".to_string()],
            kind: repair_feedback::RepairSignalKind::AssertionFailure
                .as_str()
                .to_string(),
            fingerprint: "FAILED tests/test_source.py::test_bug".to_string(),
            relation: validation_oracle::BaselineScopeRelation::TaskRelated,
            elapsed_ms: 0,
        };

        let assessment = assess_against_baseline(
            "SW_TEST_EXIT_CODE=0\n1 passed\n",
            &[("source.py".to_string(), 1, 1)],
            &["tests/test_source.py".to_string()],
            Some(&baseline),
        );

        assert_eq!(assessment.signal, "source_scope_pass");
        assert_eq!(
            assessment.decision.trust_tier,
            validation_oracle::ValidationTrustTier::TrustedPublicScope
        );
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
}
