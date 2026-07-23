//! Deterministic routing policy for serial causal repair.
//!
//! This module does not decide whether a SWE-bench task is solved. It keeps
//! internal safety evidence separate from task-efficacy evidence, bounds
//! no-oracle exploration, and breaks repeated validation loops while the
//! canonical evaluator remains the sole solve authority.

use crate::{
    causal_validation::CausalScopeSignal,
    validation_oracle::{self, TestDelta},
};

const MAX_CHANGED_FILES_PER_PATCH: usize = 12;
const REPEATED_FAILURE_RESET_THRESHOLD: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvidenceTier {
    None,
    Safety,
    Efficacy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SerialRoute {
    AuditEfficacy,
    AuditChangedFailure,
    AcquireTaskEvidence,
    AuditRegressionCandidate,
    AuditBoundedSafety,
    RefineSafety,
    Repair,
    Reset,
}

pub struct SerialRepairPolicy {
    safety_edit_budget: u32,
    valid_edits: u32,
    last_failure_signature: Option<String>,
    repeated_failure_count: u32,
    task_evidence_acquisition_used: bool,
}

impl SerialRepairPolicy {
    pub fn new(safety_edit_budget: u32) -> Self {
        Self {
            safety_edit_budget: safety_edit_budget.max(2),
            valid_edits: 0,
            last_failure_signature: None,
            repeated_failure_count: 0,
            task_evidence_acquisition_used: false,
        }
    }

    pub fn record_valid_edit(&mut self) {
        self.valid_edits = self.valid_edits.saturating_add(1);
    }

    pub fn decide(
        &mut self,
        has_qualified_reproducer: bool,
        reproducer_delta: Option<TestDelta>,
        scope_signal: CausalScopeSignal,
        candidate_blocking: bool,
        failure_signature: &str,
        has_checkpoint: bool,
    ) -> SerialRoute {
        let tier = evidence_tier(has_qualified_reproducer, reproducer_delta, scope_signal);
        if tier == EvidenceTier::Efficacy && !candidate_blocking {
            self.clear_failure();
            return SerialRoute::AuditEfficacy;
        }

        if reproducer_delta == Some(TestDelta::ChangedFail)
            && scope_signal.is_pass_like()
            && !candidate_blocking
        {
            self.clear_failure();
            return SerialRoute::AuditChangedFailure;
        }

        if !has_qualified_reproducer
            && reproducer_delta.is_none()
            && scope_signal == CausalScopeSignal::RegressionPass
            && !candidate_blocking
            && has_checkpoint
        {
            self.clear_failure();
            if !self.task_evidence_acquisition_used {
                self.task_evidence_acquisition_used = true;
                return SerialRoute::AcquireTaskEvidence;
            }
            return SerialRoute::AuditRegressionCandidate;
        }

        if self.valid_edits >= self.safety_edit_budget && has_checkpoint {
            self.clear_failure();
            return SerialRoute::AuditBoundedSafety;
        }

        if candidate_blocking || tier == EvidenceTier::None {
            if self.last_failure_signature.as_deref() == Some(failure_signature) {
                self.repeated_failure_count = self.repeated_failure_count.saturating_add(1);
            } else {
                self.last_failure_signature = Some(failure_signature.to_string());
                self.repeated_failure_count = 1;
            }
            if self.repeated_failure_count >= REPEATED_FAILURE_RESET_THRESHOLD && has_checkpoint {
                self.clear_failure();
                SerialRoute::Reset
            } else {
                SerialRoute::Repair
            }
        } else {
            self.clear_failure();
            SerialRoute::RefineSafety
        }
    }

    fn clear_failure(&mut self) {
        self.last_failure_signature = None;
        self.repeated_failure_count = 0;
    }
}

pub fn candidate_state_changed(
    before_fingerprint: &str,
    before_stats: &[(String, usize, usize)],
    before_targets: &str,
    after_fingerprint: &str,
    after_stats: &[(String, usize, usize)],
    after_targets: &str,
) -> bool {
    before_fingerprint != after_fingerprint
        || normalized_diff_stats(before_stats) != normalized_diff_stats(after_stats)
        || before_targets != after_targets
}

pub fn target_paths_fingerprint(workdir: &str, paths: &[String]) -> String {
    let mut paths = paths.to_vec();
    paths.sort();
    paths.dedup();
    let mut hash = 0xcbf29ce484222325u64;
    for path in paths {
        for byte in path.as_bytes().iter().copied().chain([0]) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        match std::fs::read(std::path::Path::new(workdir).join(&path)) {
            Ok(content) => {
                hash ^= 1;
                hash = hash.wrapping_mul(0x100000001b3);
                for byte in content {
                    hash ^= u64::from(byte);
                    hash = hash.wrapping_mul(0x100000001b3);
                }
            }
            Err(_) => {
                hash ^= 2;
                hash = hash.wrapping_mul(0x100000001b3);
            }
        }
    }
    format!("{hash:016x}")
}

pub fn combined_failure_signature(
    scope_signature: &str,
    reproducer_output: Option<&str>,
) -> String {
    let Some(reproducer_output) = reproducer_output else {
        return scope_signature.to_string();
    };
    let reproducer_fingerprint = validation_oracle::failure_fingerprint(reproducer_output);
    if reproducer_fingerprint.is_empty() {
        scope_signature.to_string()
    } else {
        format!("{scope_signature}; reproducer={reproducer_fingerprint}")
    }
}

fn normalized_diff_stats(stats: &[(String, usize, usize)]) -> Vec<(String, usize, usize)> {
    let mut normalized = stats.to_vec();
    normalized.sort();
    normalized
}

pub fn evidence_tier(
    has_qualified_reproducer: bool,
    reproducer_delta: Option<TestDelta>,
    scope_signal: CausalScopeSignal,
) -> EvidenceTier {
    if has_qualified_reproducer {
        return if reproducer_delta == Some(TestDelta::Fixed) && scope_signal.is_pass_like() {
            EvidenceTier::Efficacy
        } else {
            EvidenceTier::None
        };
    }
    match scope_signal {
        CausalScopeSignal::TaskScopeImproved => EvidenceTier::Efficacy,
        CausalScopeSignal::RegressionPass | CausalScopeSignal::StructuralPass => {
            EvidenceTier::Safety
        }
        _ => EvidenceTier::None,
    }
}

pub fn patch_shape_violation(
    changed: &[(String, usize, usize)],
    max_diff_lines: usize,
) -> Option<String> {
    if changed.is_empty() {
        return None;
    }
    let oversized: Vec<String> = changed
        .iter()
        .filter(|(_, changed_lines, total)| *total > 0 && *changed_lines > max_diff_lines)
        .take(4)
        .map(|(file, changed_lines, total)| format!("{} ({}/{})", file, changed_lines, total))
        .collect();
    if !oversized.is_empty() {
        return Some(format!(
            "oversized edit: {} changed more than {} lines",
            oversized.join(", "),
            max_diff_lines
        ));
    }
    if changed.len() > MAX_CHANGED_FILES_PER_PATCH {
        return Some(format!(
            "wide patch: {} files changed (max {})",
            changed.len(),
            MAX_CHANGED_FILES_PER_PATCH
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_pass_is_safety_not_efficacy_without_reproducer() {
        assert_eq!(
            evidence_tier(false, None, CausalScopeSignal::RegressionPass),
            EvidenceTier::Safety
        );
    }

    #[test]
    fn fixed_reproducer_plus_safe_scope_is_efficacy() {
        assert_eq!(
            evidence_tier(
                true,
                Some(TestDelta::Fixed),
                CausalScopeSignal::RegressionPass,
            ),
            EvidenceTier::Efficacy
        );
    }

    #[test]
    fn reproducer_fingerprint_distinguishes_changed_failures_in_loop_signature() {
        let index_error = combined_failure_signature(
            "scope=regression; signal=passed",
            Some("E IndexError: tuple index out of range\nSW_TEST_EXIT_CODE=1"),
        );
        let assertion_error = combined_failure_signature(
            "scope=regression; signal=passed",
            Some("E AssertionError: assert not ['ascii.ecsv']\nSW_TEST_EXIT_CODE=1"),
        );
        assert_ne!(index_error, assertion_error);
        assert!(index_error.contains("IndexError"));
        assert!(assertion_error.contains("AssertionError"));
    }

    #[test]
    fn changed_task_failure_with_safe_public_scope_routes_to_semantic_audit() {
        let mut policy = SerialRepairPolicy::new(6);
        policy.record_valid_edit();
        assert_eq!(
            policy.decide(
                true,
                Some(TestDelta::ChangedFail),
                CausalScopeSignal::RegressionPass,
                false,
                "scope=regression; reproducer=changed",
                true,
            ),
            SerialRoute::AuditChangedFailure
        );
    }

    #[test]
    fn changed_task_failure_does_not_bypass_a_blocking_public_scope() {
        let mut policy = SerialRepairPolicy::new(6);
        policy.record_valid_edit();
        assert_eq!(
            policy.decide(
                true,
                Some(TestDelta::ChangedFail),
                CausalScopeSignal::RegressionFailure,
                true,
                "scope=regression; reproducer=changed",
                true,
            ),
            SerialRoute::Repair
        );
    }

    #[test]
    fn baseline_passing_public_scope_audits_current_no_oracle_candidate() {
        let mut policy = SerialRepairPolicy::new(6);
        policy.record_valid_edit();
        assert_eq!(
            policy.decide(
                false,
                None,
                CausalScopeSignal::RegressionPass,
                false,
                "scope=regression; reproducer=unavailable",
                true,
            ),
            SerialRoute::AcquireTaskEvidence
        );
        assert_eq!(
            policy.decide(
                false,
                None,
                CausalScopeSignal::RegressionPass,
                false,
                "scope=regression; reproducer=unavailable",
                true,
            ),
            SerialRoute::AuditRegressionCandidate
        );
    }

    #[test]
    fn no_oracle_regression_pass_requires_a_retained_candidate() {
        let mut policy = SerialRepairPolicy::new(6);
        policy.record_valid_edit();
        assert_eq!(
            policy.decide(
                false,
                None,
                CausalScopeSignal::RegressionPass,
                false,
                "scope=regression; reproducer=unavailable",
                false,
            ),
            SerialRoute::RefineSafety
        );
    }

    #[test]
    fn repeated_failure_resets_only_when_a_checkpoint_can_preserve_work() {
        let mut policy = SerialRepairPolicy::new(6);
        policy.record_valid_edit();
        assert_eq!(
            policy.decide(
                false,
                None,
                CausalScopeSignal::Unavailable,
                false,
                "scope=a; failure=x",
                true,
            ),
            SerialRoute::Repair
        );
        assert_eq!(
            policy.decide(
                false,
                None,
                CausalScopeSignal::Unavailable,
                false,
                "scope=a; failure=x",
                true,
            ),
            SerialRoute::Reset
        );
    }

    #[test]
    fn bounded_no_oracle_search_audits_retained_safety_candidate() {
        let mut policy = SerialRepairPolicy::new(2);
        policy.record_valid_edit();
        assert_eq!(
            policy.decide(
                false,
                None,
                CausalScopeSignal::StructuralPass,
                false,
                "pass",
                true,
            ),
            SerialRoute::RefineSafety
        );
        policy.record_valid_edit();
        assert_eq!(
            policy.decide(
                false,
                None,
                CausalScopeSignal::Unavailable,
                false,
                "unavailable",
                true,
            ),
            SerialRoute::AuditBoundedSafety
        );
    }

    #[test]
    fn patch_shape_rejects_wide_and_oversized_edits() {
        let wide: Vec<(String, usize, usize)> = (0..13)
            .map(|index| (format!("pkg/file_{index}.py"), 1, 10))
            .collect();
        assert!(
            patch_shape_violation(&wide, 5)
                .unwrap()
                .contains("wide patch")
        );
        assert!(
            patch_shape_violation(&[("pkg/file.py".to_string(), 6, 10)], 5)
                .unwrap()
                .contains("oversized edit")
        );
    }

    #[test]
    fn candidate_state_requires_a_real_tracked_or_untracked_delta() {
        let before = vec![("src/lib.py".to_string(), 2, 40)];
        let reordered = vec![("src/lib.py".to_string(), 2, 40)];
        assert!(!candidate_state_changed(
            "same", &before, "targets", "same", &reordered, "targets",
        ));
        assert!(candidate_state_changed(
            "same",
            &before,
            "targets",
            "same",
            &[
                ("src/lib.py".to_string(), 2, 40),
                ("src/new.py".to_string(), 1, 1),
            ],
            "targets",
        ));
        assert!(candidate_state_changed(
            "before", &before, "targets", "after", &before, "targets",
        ));
        assert!(candidate_state_changed(
            "same",
            &before,
            "before-target",
            "same",
            &before,
            "after-target",
        ));
    }
}
