//! Workflow-selected, trusted-environment-gated classifier observation.
//!
//! This module never executes commands or grants independent authority. A
//! candidate must be durably recorded by the native adapter before proceeding.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditMode {
    #[default]
    Enforce,
    Audit,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    mode: AuditMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditEnvironment {
    Staging,
    Dev,
    Dev1,
    Dev2,
    Dev3,
}

/// Construct only through the strict parser; workflow JSON cannot pick a lane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuditConfig {
    environment: Option<AuditEnvironment>,
}

impl AuditConfig {
    pub fn from_workflow_extra(
        extra: &BTreeMap<String, serde_json::Value>,
        trusted_environment: Option<&str>,
    ) -> Result<Self, &'static str> {
        Self::from_metadata(extra.get("classifier_audit"), trusted_environment)
    }

    pub fn from_metadata(
        metadata: Option<&serde_json::Value>,
        trusted_environment: Option<&str>,
    ) -> Result<Self, &'static str> {
        let mode = match metadata {
            None => AuditMode::Enforce,
            Some(value) => {
                serde_json::from_value::<Metadata>(value.clone())
                    .map_err(|_| "classifier_audit must contain only mode: audit or enforce")?
                    .mode
            }
        };
        if mode == AuditMode::Enforce {
            return Ok(Self { environment: None });
        }
        let environment = match trusted_environment {
            Some("staging") => AuditEnvironment::Staging,
            Some("dev") => AuditEnvironment::Dev,
            Some("dev1") => AuditEnvironment::Dev1,
            Some("dev2") => AuditEnvironment::Dev2,
            Some("dev3") => AuditEnvironment::Dev3,
            _ => return Err(
                "classifier audit requires trusted staging, dev, dev1, dev2 or dev3 environment",
            ),
        };
        Ok(Self {
            environment: Some(environment),
        })
    }

    pub fn enabled(self) -> bool {
        self.environment.is_some()
    }
}

/// These outcomes must be supplied by classifier code, never workflow metadata,
/// command arguments, a semantic model's free text, or the native client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClassifierOutcome {
    Allowed,
    DenyUncertain,
    DenyKnownRisk,
    ExplicitDeny,
}

/// Fresh independent authorization for this same invocation. Missing checks are
/// false by default. Native permissions are explicitly deferred to the host;
/// this gateway neither observes nor waives the platform's approval decision.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IndependentGuards {
    pub workflow_tool: bool,
    pub interceptor: bool,
    pub capability: bool,
    pub scope: bool,
    pub native_approval: NativePermissions,
    pub human_review: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativePermissions {
    #[default]
    Unavailable,
    /// The gateway has no native platform approval result. It leaves that
    /// separate host gate intact and must never claim it already passed.
    DeferredToHost,
}

impl IndependentGuards {
    fn all_clear(self) -> bool {
        self.workflow_tool
            && self.interceptor
            && self.capability
            && self.scope
            && self.native_approval == NativePermissions::DeferredToHost
            && self.human_review
    }
}

/// Only a SHA256 identifier enters receipts. Raw commands, user-controlled
/// strings, filesystem paths and model output cannot enter via evidence refs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct EvidenceDigest(String);

impl EvidenceDigest {
    pub fn new(value: &str) -> Result<Self, &'static str> {
        if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("audit evidence reference must be a SHA256 hex digest");
        }
        Ok(Self(value.to_ascii_lowercase()))
    }
}

/// Digests identify complete native evidence held in a trusted local store.
/// `invocation` must be a keyed digest when the original contains secrets;
/// unkeyed hashes of low-entropy credentials are not a privacy boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuditEvidenceReferences {
    pub workflow: EvidenceDigest,
    pub policy: EvidenceDigest,
    pub invocation: EvidenceDigest,
    pub classifier_decision: EvidenceDigest,
    pub independent_guards: EvidenceDigest,
    pub native_context: EvidenceDigest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuditReceipt {
    pub schema_version: u32,
    pub event: AuditEvent,
    pub environment: AuditEnvironment,
    pub simulation_label: SimulationLabel,
    pub evidence: AuditEvidenceReferences,
    pub native_permissions: NativePermissions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditEvent {
    ClassifierWouldBlockUncertain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SimulationLabel {
    UnlabelledPendingReview,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditAction {
    /// Preserve the ordinary enforcement decision (including ordinary allows).
    PreserveEnforcement,
    /// This is not permission to execute. The adapter must durably write the
    /// receipt and sanitized unlabelled simulation case, then recheck current
    /// context/guards before proceeding. Any persistence failure stays blocked.
    RecordBeforeProceeding(AuditReceipt),
}

pub fn evaluate(
    config: AuditConfig,
    classifier: ClassifierOutcome,
    guards: IndependentGuards,
    evidence: AuditEvidenceReferences,
) -> AuditAction {
    match config.environment {
        Some(environment)
            if classifier == ClassifierOutcome::DenyUncertain && guards.all_clear() =>
        {
            AuditAction::RecordBeforeProceeding(AuditReceipt {
                schema_version: 1,
                event: AuditEvent::ClassifierWouldBlockUncertain,
                environment,
                simulation_label: SimulationLabel::UnlabelledPendingReview,
                evidence,
                native_permissions: guards.native_approval,
            })
        }
        _ => AuditAction::PreserveEnforcement,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn audit_config(environment: &str) -> AuditConfig {
        AuditConfig::from_metadata(Some(&json!({"mode": "audit"})), Some(environment)).unwrap()
    }

    fn evidence() -> AuditEvidenceReferences {
        let digest = EvidenceDigest::new(&"a".repeat(64)).unwrap();
        AuditEvidenceReferences {
            workflow: digest.clone(),
            policy: digest.clone(),
            invocation: digest.clone(),
            classifier_decision: digest.clone(),
            independent_guards: digest.clone(),
            native_context: digest,
        }
    }

    fn clear() -> IndependentGuards {
        IndependentGuards {
            workflow_tool: true,
            interceptor: true,
            capability: true,
            scope: true,
            native_approval: NativePermissions::DeferredToHost,
            human_review: true,
        }
    }

    #[test]
    fn audit_environment_is_exact_and_cannot_come_from_metadata() {
        for environment in ["staging", "dev", "dev1", "dev2", "dev3"] {
            assert!(audit_config(environment).enabled());
        }
        for environment in [
            None,
            Some("production"),
            Some("prod"),
            Some("dev4"),
            Some("development"),
            Some("Staging"),
            Some("staging "),
            Some(""),
        ] {
            assert!(
                AuditConfig::from_metadata(Some(&json!({"mode": "audit"})), environment).is_err()
            );
        }
        assert!(AuditConfig::from_metadata(
            Some(&json!({"mode": "audit", "environment": "staging"})),
            Some("staging")
        )
        .is_err());
    }

    #[test]
    fn default_enforcement_and_malformed_configuration_fail_closed() {
        assert!(!AuditConfig::from_workflow_extra(&BTreeMap::new(), None)
            .unwrap()
            .enabled());
        assert!(
            !AuditConfig::from_metadata(Some(&json!({"mode": "enforce"})), Some("production"))
                .unwrap()
                .enabled()
        );
        for metadata in [
            json!(null),
            json!(true),
            json!("audit"),
            json!({}),
            json!({"mode": "AUDIT"}),
            json!({"mode": "audit", "allow": true}),
        ] {
            assert!(AuditConfig::from_metadata(Some(&metadata), Some("staging")).is_err());
        }
    }

    #[test]
    fn only_uncertainty_with_every_independent_guard_can_be_audited() {
        let config = audit_config("staging");
        assert!(matches!(
            evaluate(
                config,
                ClassifierOutcome::DenyUncertain,
                clear(),
                evidence()
            ),
            AuditAction::RecordBeforeProceeding(_)
        ));
        for classifier in [
            ClassifierOutcome::Allowed,
            ClassifierOutcome::DenyKnownRisk,
            ClassifierOutcome::ExplicitDeny,
        ] {
            assert_eq!(
                evaluate(config, classifier, clear(), evidence()),
                AuditAction::PreserveEnforcement
            );
        }
        for index in 0..6 {
            let mut guards = clear();
            match index {
                0 => guards.workflow_tool = false,
                1 => guards.interceptor = false,
                2 => guards.capability = false,
                3 => guards.scope = false,
                4 => guards.native_approval = NativePermissions::Unavailable,
                _ => guards.human_review = false,
            }
            assert_eq!(
                evaluate(config, ClassifierOutcome::DenyUncertain, guards, evidence()),
                AuditAction::PreserveEnforcement
            );
        }
        let enforce = AuditConfig::from_metadata(None, Some("staging")).unwrap();
        assert_eq!(
            evaluate(
                enforce,
                ClassifierOutcome::DenyUncertain,
                clear(),
                evidence()
            ),
            AuditAction::PreserveEnforcement
        );
    }

    #[test]
    fn receipt_is_unlabelled_and_exposes_only_fixed_values_and_digests() {
        let AuditAction::RecordBeforeProceeding(receipt) = evaluate(
            audit_config("dev2"),
            ClassifierOutcome::DenyUncertain,
            clear(),
            evidence(),
        ) else {
            panic!("expected candidate")
        };
        let value = serde_json::to_value(receipt).unwrap();
        assert_eq!(value["simulation_label"], "unlabelled_pending_review");
        assert_eq!(value["event"], "classifier_would_block_uncertain");
        assert_eq!(value["environment"], "dev2");
        assert_eq!(value["evidence"].as_object().unwrap().len(), 6);
        assert!(EvidenceDigest::new("secret token or raw command").is_err());
        assert!(EvidenceDigest::new(&"z".repeat(64)).is_err());
        assert!(EvidenceDigest::new(&"a".repeat(63)).is_err());
        assert_eq!(
            serde_json::to_value(EvidenceDigest::new(&"A".repeat(64)).unwrap()).unwrap(),
            "a".repeat(64)
        );
    }
}
