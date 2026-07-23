use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateEvidenceKind {
    DidNotRun,
    Unavailable,
    GenericFeedbackPass,
    BaselineRegressionPass,
    TrustedSourceScopePass,
    IssueMappedBaselinePass,
    CanonicalHarnessPass,
    ConcreteFail,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CandidateEvidence {
    pub kind: CandidateEvidenceKind,
    pub source: String,
    pub scope_files: Vec<String>,
}

impl CandidateEvidence {
    pub fn from_output(output: &str) -> Self {
        let output = output
            .rsplit_once("[CANDIDATE_EVIDENCE_EPOCH]")
            .map(|(_, latest)| latest)
            .unwrap_or(output);
        let scope_files = source_scope_files(output);

        // A concrete failure is monotonic: later unavailable telemetry cannot erase it.
        if output.contains("[FINAL_VERIFICATION] FAIL")
            || output.contains("[PARENT_CANDIDATE_VALIDATION] SIGNAL=fail")
            || output.contains("[PARENT_TIMEOUT_VALIDATION] SIGNAL=fail")
            || output.contains("[POST_EDIT_REPAIR] FAIL")
            || output.contains("[SOURCE_SCOPE_REPAIR] FAIL")
        {
            return Self::new(
                CandidateEvidenceKind::ConcreteFail,
                "concrete_failure",
                scope_files,
            );
        }
        if output.contains("[FINAL_VERIFICATION] PASS") {
            return Self::new(
                CandidateEvidenceKind::CanonicalHarnessPass,
                "final_verification",
                scope_files,
            );
        }
        if output.contains("[PARENT_CANDIDATE_VALIDATION] SIGNAL=source_scope_pass")
            || output.contains("[PARENT_TIMEOUT_VALIDATION] SIGNAL=source_scope_pass")
            || output.lines().any(|line| {
                line.contains("[POST_EDIT_REPAIR] PASS")
                    && line.contains("authority=baseline_failure_repaired")
            })
        {
            return Self::new(
                CandidateEvidenceKind::IssueMappedBaselinePass,
                "baseline_proven_scope",
                scope_files,
            );
        }
        if output.contains("[PARENT_CANDIDATE_VALIDATION] SIGNAL=regression_pass")
            || output.contains("[PARENT_TIMEOUT_VALIDATION] SIGNAL=regression_pass")
            // Legacy parent `pass` meant only that a baseline-passing scope still passed.
            || output.contains("[PARENT_CANDIDATE_VALIDATION] SIGNAL=pass")
            || output.contains("[PARENT_TIMEOUT_VALIDATION] SIGNAL=pass")
            || output.lines().any(|line| {
                line.contains("[POST_EDIT_REPAIR] REGRESSION_PASS")
                    || (line.contains("[POST_EDIT_REPAIR] PASS")
                        && line.contains("authority=baseline_proven_source_scope"))
            })
        {
            return Self::new(
                CandidateEvidenceKind::BaselineRegressionPass,
                "baseline_regression_scope",
                scope_files,
            );
        }
        if output.lines().any(|line| {
            line.contains("[POST_EDIT_REPAIR] PASS")
                && line.contains("authority=trusted_source_scope")
        }) {
            return Self::new(
                CandidateEvidenceKind::TrustedSourceScopePass,
                "trusted_source_scope",
                scope_files,
            );
        }
        if output.contains("[PARENT_CANDIDATE_VALIDATION] SIGNAL=feedback_pass")
            || output.contains("[PARENT_TIMEOUT_VALIDATION] SIGNAL=feedback_pass")
            || (!scope_files.is_empty()
                && (output.contains("[POST_EDIT_REPAIR] PASS")
                    || output.contains("[SOURCE_SCOPE_REPAIR] PASS")))
        {
            return Self::new(
                CandidateEvidenceKind::GenericFeedbackPass,
                "feedback_scope",
                scope_files,
            );
        }
        if output.contains("[FINAL_VERIFICATION] UNAVAILABLE")
            || output.contains("[PARENT_CANDIDATE_VALIDATION] SIGNAL=unavailable")
            || output.contains("[PARENT_TIMEOUT_VALIDATION] SIGNAL=unavailable")
        {
            return Self::new(
                CandidateEvidenceKind::Unavailable,
                "validation_unavailable",
                scope_files,
            );
        }
        Self::new(
            CandidateEvidenceKind::DidNotRun,
            "no_validation_signal",
            scope_files,
        )
    }

    pub fn selection_signal(&self) -> &'static str {
        match self.kind {
            CandidateEvidenceKind::ConcreteFail => "fail",
            CandidateEvidenceKind::CanonicalHarnessPass => "pass",
            CandidateEvidenceKind::IssueMappedBaselinePass => "source_scope_pass",
            CandidateEvidenceKind::BaselineRegressionPass
            | CandidateEvidenceKind::TrustedSourceScopePass => "regression_pass",
            CandidateEvidenceKind::GenericFeedbackPass => "feedback_pass",
            CandidateEvidenceKind::Unavailable => "unavailable",
            CandidateEvidenceKind::DidNotRun => "none",
        }
    }

    fn new(kind: CandidateEvidenceKind, source: &str, scope_files: Vec<String>) -> Self {
        Self {
            kind,
            source: source.to_string(),
            scope_files,
        }
    }
}

pub fn actual_locus(changed_files: &[String], launched_path: &str) -> String {
    let source_files: Vec<&String> = changed_files
        .iter()
        .filter(|path| !crate::patch_authority::is_test_path(path))
        .collect();
    if source_files
        .iter()
        .any(|path| path.as_str() == launched_path)
    {
        return launched_path.to_string();
    }
    if source_files.len() == 1 {
        return source_files[0].clone();
    }
    launched_path.to_string()
}

fn source_scope_files(output: &str) -> Vec<String> {
    let mut files = Vec::new();
    for line in output.lines().filter(|line| {
        line.contains("[POST_EDIT_REPAIR]") || line.contains("[SOURCE_SCOPE_REPAIR]")
    }) {
        let Some(scope) = line.split_whitespace().find_map(|part| {
            part.strip_prefix("scope=SOURCE_SCOPE_TEST_FILES=")
                .or_else(|| part.strip_prefix("scope=EDITED_SOURCE_TEST_FILES="))
        }) else {
            continue;
        };
        let normalized = scope.trim().trim_matches(|ch| matches!(ch, ',' | ';'));
        if !normalized.is_empty() && !files.iter().any(|path| path == normalized) {
            files.push(normalized.to_string());
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_unavailable_keeps_legacy_baseline_pass_as_regression_only() {
        let evidence = CandidateEvidence::from_output(
            "[POST_EDIT_REPAIR] PASS authority=baseline_proven_source_scope scope=SOURCE_SCOPE_TEST_FILES=tests/test_base.py\n[PARENT_CANDIDATE_VALIDATION] SIGNAL=unavailable\n",
        );
        assert_eq!(evidence.kind, CandidateEvidenceKind::BaselineRegressionPass);
        assert_eq!(evidence.selection_signal(), "regression_pass");
        assert_eq!(evidence.scope_files, vec!["tests/test_base.py"]);
    }

    #[test]
    fn concrete_child_failure_dominates_parent_pass() {
        let evidence = CandidateEvidence::from_output(
            "[POST_EDIT_REPAIR] FAIL kind=assertion_failure scope=SOURCE_SCOPE_TEST_FILES=tests/test_base.py\n[PARENT_CANDIDATE_VALIDATION] SIGNAL=pass\n",
        );
        assert_eq!(evidence.kind, CandidateEvidenceKind::ConcreteFail);
        assert_eq!(evidence.selection_signal(), "fail");
    }

    #[test]
    fn a_new_repair_epoch_can_replace_an_old_failure() {
        let evidence = CandidateEvidence::from_output(
            "[POST_EDIT_REPAIR] FAIL kind=assertion_failure scope=SOURCE_SCOPE_TEST_FILES=tests/test_base.py\n[CANDIDATE_EVIDENCE_EPOCH]\n[POST_EDIT_REPAIR] PASS authority=baseline_proven_source_scope scope=SOURCE_SCOPE_TEST_FILES=tests/test_base.py\n",
        );
        assert_eq!(evidence.kind, CandidateEvidenceKind::BaselineRegressionPass);
    }

    #[test]
    fn parent_differential_pass_is_issue_mapped_repair_evidence() {
        let evidence = CandidateEvidence::from_output(
            "[FINAL_VERIFICATION] UNAVAILABLE\n[PARENT_CANDIDATE_VALIDATION] SIGNAL=source_scope_pass\n",
        );
        assert_eq!(
            evidence.kind,
            CandidateEvidenceKind::IssueMappedBaselinePass
        );
        assert_eq!(evidence.selection_signal(), "source_scope_pass");
    }

    #[test]
    fn legacy_parent_pass_is_regression_only() {
        let evidence = CandidateEvidence::from_output(
            "[FINAL_VERIFICATION] UNAVAILABLE\n[PARENT_CANDIDATE_VALIDATION] SIGNAL=pass\n",
        );
        assert_eq!(evidence.kind, CandidateEvidenceKind::BaselineRegressionPass);
        assert_eq!(evidence.selection_signal(), "regression_pass");
    }

    #[test]
    fn actual_locus_uses_the_only_changed_source_when_child_moves() {
        assert_eq!(
            actual_locus(&["pkg/right.py".to_string()], "pkg/wrong.py"),
            "pkg/right.py"
        );
    }
}
