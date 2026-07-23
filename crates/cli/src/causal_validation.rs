//! Typed, baseline-relative interpretation for causal one-pass validation.
//!
//! A test command is not automatically task evidence just because it passes.
//! This module keeps the distinction explicit so the controller can use the
//! same sandboxed TestSpec execution for repair feedback without treating it
//! as the canonical SWE-bench verdict.

use crate::{candidate_validation, repair_feedback, validation_oracle};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CausalScopeSignal {
    RegressionPass,
    RegressionFailure,
    TaskScopeImproved,
    TaskScopeStillFailing,
    StructuralPass,
    StructuralFailure,
    FeedbackFailure,
    Unavailable,
}

impl CausalScopeSignal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RegressionPass => "regression_pass",
            Self::RegressionFailure => "regression_failure",
            Self::TaskScopeImproved => "task_scope_improved",
            Self::TaskScopeStillFailing => "task_scope_still_failing",
            Self::StructuralPass => "structural_pass",
            Self::StructuralFailure => "structural_failure",
            Self::FeedbackFailure => "feedback_failure",
            Self::Unavailable => "unavailable",
        }
    }

    pub fn is_pass_like(self) -> bool {
        matches!(
            self,
            Self::RegressionPass | Self::TaskScopeImproved | Self::StructuralPass
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CausalScopeAssessment {
    pub scope_keys: Vec<String>,
    pub baseline: Option<validation_oracle::BaselineScopeOutcome>,
    pub validation: candidate_validation::ValidationAssessment,
    pub signal: CausalScopeSignal,
}

impl CausalScopeAssessment {
    pub fn trace_detail(&self, scope_desc: &str) -> String {
        format!(
            "scope={} keys={} signal={} kind={} trust={} blocking={} reason={}",
            scope_desc,
            self.scope_keys.join(","),
            self.signal.as_str(),
            self.validation.kind.as_str(),
            self.validation.decision.trust_tier.as_str(),
            self.validation.decision.candidate_blocking,
            self.validation.decision.reason
        )
    }
}

/// Extract the identity used by the baseline ledger from a solver TestSpec
/// scope. Labels are namespaced because they are not repository paths.
pub fn scope_keys(scope: &Value) -> Vec<String> {
    let mut keys = Vec::new();
    for field in ["path", "file", "test_file"] {
        if let Some(value) = scope.get(field).and_then(Value::as_str) {
            push_unique(&mut keys, value);
        }
    }
    if let Some(values) = scope.get("args").and_then(Value::as_array) {
        for value in values.iter().filter_map(Value::as_str) {
            push_unique(&mut keys, value);
        }
    }
    for field in ["label", "test_label"] {
        if let Some(value) = scope.get(field).and_then(Value::as_str) {
            push_unique(&mut keys, &candidate_validation::label_scope_key(value));
        }
    }
    if let Some(values) = scope.get("labels").and_then(Value::as_array) {
        for value in values.iter().filter_map(Value::as_str) {
            push_unique(&mut keys, &candidate_validation::label_scope_key(value));
        }
    }
    keys
}

pub fn assess(
    scope: &Value,
    output: &str,
    changed_files: &[(String, usize, usize)],
) -> CausalScopeAssessment {
    let scope_keys = scope_keys(scope);
    let baseline = validation_oracle::baseline_scope_outcome(&scope_keys);
    let validation = candidate_validation::assess_against_baseline(
        output,
        changed_files,
        &scope_keys,
        baseline.as_ref(),
    );
    let signal = classify(&validation, baseline.as_ref());
    CausalScopeAssessment {
        scope_keys,
        baseline,
        validation,
        signal,
    }
}

fn classify(
    validation: &candidate_validation::ValidationAssessment,
    baseline: Option<&validation_oracle::BaselineScopeOutcome>,
) -> CausalScopeSignal {
    use repair_feedback::RepairSignalKind;

    let baseline_passed =
        baseline.is_some_and(|value| value.kind == RepairSignalKind::Passed.as_str());
    let baseline_task_related = baseline.is_some_and(|value| value.relation.is_task_related());

    if matches!(
        validation.kind,
        RepairSignalKind::EnvUnavailable
            | RepairSignalKind::InvalidScope
            | RepairSignalKind::Timeout
    ) || matches!(
        validation.decision.trust_tier,
        validation_oracle::ValidationTrustTier::ValidationUnavailable
            | validation_oracle::ValidationTrustTier::ForbiddenOracle
    ) {
        return CausalScopeSignal::Unavailable;
    }

    if validation.kind == RepairSignalKind::Passed {
        return if baseline_passed {
            CausalScopeSignal::RegressionPass
        } else if baseline_task_related {
            CausalScopeSignal::TaskScopeImproved
        } else {
            CausalScopeSignal::StructuralPass
        };
    }

    if baseline_passed {
        return CausalScopeSignal::RegressionFailure;
    }
    if validation.decision.trust_tier
        == validation_oracle::ValidationTrustTier::StructuralPatchCheck
    {
        return CausalScopeSignal::StructuralFailure;
    }
    if baseline_task_related {
        return CausalScopeSignal::TaskScopeStillFailing;
    }
    if validation.decision.candidate_blocking {
        return CausalScopeSignal::StructuralFailure;
    }
    CausalScopeSignal::FeedbackFailure
}

fn push_unique(target: &mut Vec<String>, value: &str) {
    let value = value.trim();
    if !value.is_empty() && !target.iter().any(|existing| existing == value) {
        target.push(value.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repair_feedback::RepairSignalKind;
    use crate::validation_oracle::{BaselineScopeOutcome, BaselineScopeRelation};
    use serde_json::json;

    fn baseline(kind: RepairSignalKind, relation: BaselineScopeRelation) -> BaselineScopeOutcome {
        BaselineScopeOutcome {
            files: vec!["tests/test_widget.py".to_string()],
            kind: kind.as_str().to_string(),
            fingerprint: "baseline".to_string(),
            relation,
            elapsed_ms: 0,
        }
    }

    fn assessment_with_baseline(
        output: &str,
        baseline: Option<BaselineScopeOutcome>,
    ) -> CausalScopeAssessment {
        let scope = json!({"path": "tests/test_widget.py"});
        let keys = scope_keys(&scope);
        let validation = candidate_validation::assess_against_baseline(
            output,
            &[("src/widget.py".to_string(), 1, 1)],
            &keys,
            baseline.as_ref(),
        );
        let signal = classify(&validation, baseline.as_ref());
        CausalScopeAssessment {
            scope_keys: keys,
            baseline,
            validation,
            signal,
        }
    }

    #[test]
    fn baseline_green_scope_remains_a_regression_guard() {
        let assessment = assessment_with_baseline(
            "SW_TEST_EXIT_CODE=0\n1 passed\n",
            Some(baseline(
                RepairSignalKind::Passed,
                BaselineScopeRelation::Regression,
            )),
        );
        assert_eq!(assessment.signal, CausalScopeSignal::RegressionPass);
    }

    #[test]
    fn task_related_baseline_failure_can_improve_without_becoming_official() {
        let assessment = assessment_with_baseline(
            "SW_TEST_EXIT_CODE=0\n1 passed\n",
            Some(baseline(
                RepairSignalKind::AssertionFailure,
                BaselineScopeRelation::TaskRelated,
            )),
        );
        assert_eq!(assessment.signal, CausalScopeSignal::TaskScopeImproved);
        assert!(assessment.signal.is_pass_like());
    }

    #[test]
    fn unmapped_pass_is_structural_only() {
        let assessment = assessment_with_baseline("SW_TEST_EXIT_CODE=0\n1 passed\n", None);
        assert_eq!(assessment.signal, CausalScopeSignal::StructuralPass);
    }

    #[test]
    fn baseline_green_failure_is_a_regression() {
        let assessment = assessment_with_baseline(
            "SW_TEST_EXIT_CODE=1\nFAILED tests/test_widget.py::test_shape\n",
            Some(baseline(
                RepairSignalKind::Passed,
                BaselineScopeRelation::Regression,
            )),
        );
        assert_eq!(assessment.signal, CausalScopeSignal::RegressionFailure);
    }

    #[test]
    fn label_scope_keys_are_namespaced() {
        assert_eq!(
            scope_keys(&json!({"label": "tests.widget.WidgetTests"})),
            vec!["__test_label__/tests.widget.WidgetTests"]
        );
    }
}
