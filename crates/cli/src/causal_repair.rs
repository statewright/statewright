//! Typed, append-only trace for the causal one-pass repair trajectory.
//!
//! This module is deliberately a controller boundary rather than another
//! validation authority. Canonical SWE-bench evaluation remains outside this
//! state machine. The controller records only events the harness actually
//! observed, so unavailable validation cannot be represented as a pass.

use crate::validation_oracle::TestDelta;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CausalState {
    Prepared,
    BaselineMapped,
    ReproducerQualified,
    DirectRepairNoOracle,
    RepairPlanned,
    PatchApplied,
    StructuralGreen,
    ReproducerGreen,
    RegressionGreen,
    BroadenedGreen,
    Frozen,
}

impl CausalState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::BaselineMapped => "baseline_mapped",
            Self::ReproducerQualified => "reproducer_qualified",
            Self::DirectRepairNoOracle => "direct_repair_no_oracle",
            Self::RepairPlanned => "repair_planned",
            Self::PatchApplied => "patch_applied",
            Self::StructuralGreen => "structural_green",
            Self::ReproducerGreen => "reproducer_green",
            Self::RegressionGreen => "regression_green",
            Self::BroadenedGreen => "broadened_green",
            Self::Frozen => "frozen",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CausalEvent {
    BaselineMapped {
        candidate_count: usize,
    },
    ReproducerQualified,
    NoCausalOracle {
        reason: String,
    },
    RepairPlanned {
        reason: String,
    },
    PatchApplied {
        patch_fingerprint: String,
    },
    StructuralPass,
    StructuralFailure {
        reason: String,
    },
    StructuralUnavailable {
        reason: String,
    },
    ReproducerDelta {
        delta: TestDelta,
    },
    RegressionPass,
    RegressionFailure {
        reason: String,
    },
    /// A real sandbox observation that does not itself change the repair
    /// state. Keeping it in the trace prevents advisory/structural evidence
    /// from being silently upgraded or discarded.
    ValidationObserved {
        signal: String,
        detail: String,
    },
    BroadenedPass,
    Freeze {
        reason: String,
    },
}

impl CausalEvent {
    fn name(&self) -> &'static str {
        match self {
            Self::BaselineMapped { .. } => "baseline_mapped",
            Self::ReproducerQualified => "reproducer_qualified",
            Self::NoCausalOracle { .. } => "no_causal_oracle",
            Self::RepairPlanned { .. } => "repair_planned",
            Self::PatchApplied { .. } => "patch_applied",
            Self::StructuralPass => "structural_pass",
            Self::StructuralFailure { .. } => "structural_failure",
            Self::StructuralUnavailable { .. } => "structural_unavailable",
            Self::ReproducerDelta { .. } => "reproducer_delta",
            Self::RegressionPass => "regression_pass",
            Self::RegressionFailure { .. } => "regression_failure",
            Self::ValidationObserved { .. } => "validation_observed",
            Self::BroadenedPass => "broadened_pass",
            Self::Freeze { .. } => "freeze",
        }
    }

    fn detail(&self) -> String {
        match self {
            Self::BaselineMapped { candidate_count } => {
                format!("candidate_count={candidate_count}")
            }
            Self::NoCausalOracle { reason }
            | Self::RepairPlanned { reason }
            | Self::StructuralFailure { reason }
            | Self::StructuralUnavailable { reason }
            | Self::RegressionFailure { reason }
            | Self::Freeze { reason } => reason.clone(),
            Self::ValidationObserved { signal, detail } => {
                format!("signal={signal} {detail}")
            }
            Self::PatchApplied { patch_fingerprint } => {
                format!("patch_fingerprint={patch_fingerprint}")
            }
            Self::ReproducerDelta { delta } => format!("delta={}", delta.as_str()),
            _ => String::new(),
        }
    }

    fn delta(&self) -> Option<TestDelta> {
        match self {
            Self::ReproducerDelta { delta } => Some(*delta),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CausalTraceEvent {
    pub schema_version: u8,
    pub sequence: u32,
    pub state_before: CausalState,
    pub state_after: CausalState,
    pub event: String,
    pub accepted: bool,
    pub detail: String,
    pub delta: Option<TestDelta>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CausalTransition {
    pub from: CausalState,
    pub to: CausalState,
    pub accepted: bool,
}

pub struct CausalRepairController {
    state: CausalState,
    sequence: u32,
    trace_path: Option<PathBuf>,
}

impl CausalRepairController {
    pub fn new(trace_path: Option<PathBuf>) -> Self {
        Self {
            state: CausalState::Prepared,
            sequence: 0,
            trace_path,
        }
    }

    pub fn from_artifact_dir(artifact_dir: Option<&Path>) -> Self {
        Self::new(artifact_dir.map(|directory| directory.join("causal-repair-trace.jsonl")))
    }

    pub fn state(&self) -> CausalState {
        self.state
    }

    /// Append the event even when the transition is rejected. A rejected event
    /// is evidence of orchestration drift, not a reason to silently rewrite
    /// the causal trajectory.
    pub fn record(&mut self, event: CausalEvent) -> CausalTransition {
        self.sequence = self.sequence.saturating_add(1);
        let from = self.state;
        let next = next_state(from, &event);
        let accepted = next.is_some();
        let to = next.unwrap_or(from);
        if accepted {
            self.state = to;
        }
        let trace = CausalTraceEvent {
            schema_version: 1,
            sequence: self.sequence,
            state_before: from,
            state_after: to,
            event: event.name().to_string(),
            accepted,
            detail: event.detail(),
            delta: event.delta(),
        };
        if let Some(path) = &self.trace_path {
            if let Err(error) = append_trace(path, &trace) {
                eprintln!(
                    "[CAUSAL_REPAIR] trace_write_failed path={} error={}",
                    path.display(),
                    error
                );
            }
        }
        CausalTransition { from, to, accepted }
    }
}

fn next_state(state: CausalState, event: &CausalEvent) -> Option<CausalState> {
    if matches!(event, CausalEvent::Freeze { .. }) {
        return Some(CausalState::Frozen);
    }
    match (state, event) {
        (state, CausalEvent::ValidationObserved { .. }) if state != CausalState::Frozen => {
            Some(state)
        }
        (CausalState::Prepared, CausalEvent::BaselineMapped { .. }) => {
            Some(CausalState::BaselineMapped)
        }
        (state, CausalEvent::ReproducerQualified)
            if !matches!(state, CausalState::Prepared | CausalState::Frozen) =>
        {
            Some(CausalState::ReproducerQualified)
        }
        (CausalState::BaselineMapped, CausalEvent::NoCausalOracle { .. }) => {
            Some(CausalState::DirectRepairNoOracle)
        }
        (CausalState::ReproducerQualified, CausalEvent::RepairPlanned { .. })
        | (CausalState::DirectRepairNoOracle, CausalEvent::RepairPlanned { .. }) => {
            Some(CausalState::RepairPlanned)
        }
        (state, CausalEvent::RepairPlanned { .. })
            if !matches!(state, CausalState::Prepared | CausalState::Frozen) =>
        {
            Some(CausalState::RepairPlanned)
        }
        (CausalState::RepairPlanned, CausalEvent::PatchApplied { .. }) => {
            Some(CausalState::PatchApplied)
        }
        (CausalState::PatchApplied, CausalEvent::StructuralPass) => {
            Some(CausalState::StructuralGreen)
        }
        (state, CausalEvent::StructuralFailure { .. })
        | (state, CausalEvent::StructuralUnavailable { .. })
        | (state, CausalEvent::RegressionFailure { .. })
            if !matches!(state, CausalState::Prepared | CausalState::Frozen) =>
        {
            Some(CausalState::RepairPlanned)
        }
        (
            CausalState::StructuralGreen,
            CausalEvent::ReproducerDelta {
                delta: TestDelta::Fixed,
            },
        ) => Some(CausalState::ReproducerGreen),
        (CausalState::StructuralGreen, CausalEvent::ReproducerDelta { .. }) => {
            Some(CausalState::RepairPlanned)
        }
        (CausalState::StructuralGreen, CausalEvent::RegressionPass)
        | (CausalState::ReproducerGreen, CausalEvent::RegressionPass) => {
            Some(CausalState::RegressionGreen)
        }
        (CausalState::RegressionGreen, CausalEvent::BroadenedPass) => {
            Some(CausalState::BroadenedGreen)
        }
        _ => None,
    }
}

fn append_trace(path: &Path, trace: &CausalTraceEvent) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create trace directory {}: {error}", parent.display()))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("open trace {}: {error}", path.display()))?;
    serde_json::to_writer(&mut file, trace)
        .map_err(|error| format!("encode trace event: {error}"))?;
    file.write_all(b"\n")
        .map_err(|error| format!("append trace newline: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qualified_reproducer_path_reaches_broadened_green() {
        let mut controller = CausalRepairController::new(None);
        for event in [
            CausalEvent::BaselineMapped { candidate_count: 3 },
            CausalEvent::ReproducerQualified,
            CausalEvent::RepairPlanned {
                reason: "hypothesis ready".to_string(),
            },
            CausalEvent::PatchApplied {
                patch_fingerprint: "patch-a".to_string(),
            },
            CausalEvent::StructuralPass,
            CausalEvent::ReproducerDelta {
                delta: TestDelta::Fixed,
            },
            CausalEvent::RegressionPass,
            CausalEvent::BroadenedPass,
        ] {
            assert!(controller.record(event).accepted);
        }
        assert_eq!(controller.state(), CausalState::BroadenedGreen);
    }

    #[test]
    fn no_oracle_remains_serial_and_can_repair_with_regression_evidence() {
        let mut controller = CausalRepairController::new(None);
        for event in [
            CausalEvent::BaselineMapped { candidate_count: 0 },
            CausalEvent::NoCausalOracle {
                reason: "runner does not accept scratch paths".to_string(),
            },
            CausalEvent::RepairPlanned {
                reason: "direct source reasoning".to_string(),
            },
            CausalEvent::PatchApplied {
                patch_fingerprint: "patch-b".to_string(),
            },
            CausalEvent::StructuralPass,
            CausalEvent::RegressionPass,
        ] {
            assert!(controller.record(event).accepted);
        }
        assert_eq!(controller.state(), CausalState::RegressionGreen);
    }

    #[test]
    fn invalid_transition_is_recorded_without_rewriting_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("trace.jsonl");
        let mut controller = CausalRepairController::new(Some(path.clone()));
        let transition = controller.record(CausalEvent::PatchApplied {
            patch_fingerprint: "premature".to_string(),
        });
        assert!(!transition.accepted);
        assert_eq!(controller.state(), CausalState::Prepared);
        let trace: CausalTraceEvent =
            serde_json::from_str(std::fs::read_to_string(path).unwrap().trim()).unwrap();
        assert!(!trace.accepted);
        assert_eq!(trace.state_after, CausalState::Prepared);
    }

    #[test]
    fn freeze_is_available_from_any_observed_state() {
        let mut controller = CausalRepairController::new(None);
        assert!(
            controller
                .record(CausalEvent::Freeze {
                    reason: "deadline".to_string()
                })
                .accepted
        );
        assert_eq!(controller.state(), CausalState::Frozen);
    }

    #[test]
    fn observations_preserve_state_and_later_unavailable_validation_reopens_repair() {
        let mut controller = CausalRepairController::new(None);
        for event in [
            CausalEvent::BaselineMapped { candidate_count: 1 },
            CausalEvent::NoCausalOracle {
                reason: "no task reproducer".to_string(),
            },
            CausalEvent::RepairPlanned {
                reason: "direct repair".to_string(),
            },
            CausalEvent::PatchApplied {
                patch_fingerprint: "patch-c".to_string(),
            },
            CausalEvent::StructuralPass,
            CausalEvent::RegressionPass,
        ] {
            assert!(controller.record(event).accepted);
        }
        assert_eq!(controller.state(), CausalState::RegressionGreen);

        let observed = controller.record(CausalEvent::ValidationObserved {
            signal: "task_scope_improved".to_string(),
            detail: "public scope changed relative to baseline".to_string(),
        });
        assert!(observed.accepted);
        assert_eq!(observed.from, CausalState::RegressionGreen);
        assert_eq!(observed.to, CausalState::RegressionGreen);

        assert!(
            controller
                .record(CausalEvent::StructuralUnavailable {
                    reason: "runner lost its environment".to_string(),
                })
                .accepted
        );
        assert_eq!(controller.state(), CausalState::RepairPlanned);
    }
}
