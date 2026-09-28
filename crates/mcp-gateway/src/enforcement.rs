use statewright_agent::tool_enforcer;
use statewright_engine::{ClassifierRiskTolerance, resolve_transition};

use crate::{
    bash_classifier,
    risk_assessment::{ResolvedEffect, RiskPipelineAssessment},
    session::{
        DENYLIST_HEURISTIC_POLICY_MODE, GatewaySession, LEGACY_DENYLIST_HEURISTIC_POLICY_MODE,
    },
    tool_intent::{NativeToolFamily, native_tool_family},
};

const UNTRUSTED_EXPLORATORY_ADAPTER: &str = "__statewright_untrusted_exploratory_adapter__";

/// Decision from the enforcement pipeline.
#[derive(Debug, Clone)]
pub enum EnforcementDecision {
    /// Tool is allowed in the current state.
    Allow,
    /// Tool is blocked. Includes reason and list of available tools.
    Block {
        reason: String,
        available_tools: Vec<String>,
    },
    /// Tool is blocked in current state but available in an adjacent state.
    /// The implicit transition was evaluated and guards passed.
    ImplicitTransition { event: String, new_state: String },
    /// Tool is allowed but the iteration limit has been reached.
    CheckpointReached { iteration: u32, max: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdapterToolOrigin {
    NativeUnregistered,
    RegisteredUpstream,
}

/// Return the policy error for a shell dialect that Statewright does not
/// inspect.  Native adapters can name their shell tool `exec_command` while
/// selecting zsh in the input, so checking only the tool name is insufficient.
pub fn unsupported_shell_dialect_reason(
    requested_tool: &str,
    tool_input: &serde_json::Value,
) -> Option<&'static str> {
    let native_shell = matches!(
        requested_tool.to_ascii_lowercase().as_str(),
        "bash" | "zsh" | "exec_command" | "run_command" | "shell" | "terminal"
    );
    if !native_shell {
        return None;
    }
    let requested_shell = tool_input
        .get("shell")
        .and_then(|value| value.as_str())
        .and_then(|shell| shell.split_whitespace().next())
        .and_then(|shell| shell.rsplit('/').next());
    if requested_tool.eq_ignore_ascii_case("zsh")
        || requested_shell.is_some_and(|shell| shell.eq_ignore_ascii_case("zsh"))
    {
        Some(
            "Zsh is not enabled for guarded shell execution. Use Bash so Statewright can apply its shell policy.",
        )
    } else {
        None
    }
}

fn allowed_name_for_family(session: &GatewaySession, family: NativeToolFamily) -> Option<String> {
    tool_enforcer::get_allowed_tools(&session.definition, &session.current_state)
        .unwrap_or_default()
        .into_iter()
        .find(|candidate| native_tool_family(candidate) == Some(family))
}

fn allowed_general_read_name(session: &GatewaySession) -> Option<String> {
    tool_enforcer::get_allowed_tools(&session.definition, &session.current_state)
        .unwrap_or_default()
        .into_iter()
        .find(|candidate| {
            matches!(
                candidate.to_ascii_lowercase().as_str(),
                "read" | "read_file"
            )
        })
}

fn readonly_shell_policy_name(
    session: &GatewaySession,
    tool_input: &serde_json::Value,
) -> Option<String> {
    let command = tool_input
        .get("command")
        .or_else(|| tool_input.get("cmd"))
        .and_then(|value| value.as_str())?
        .trim();
    let mut selected = None;
    for capability in bash_classifier::readonly_capabilities(command)? {
        let family = native_tool_family(capability)?;
        let allowed = allowed_name_for_family(session, family)?;
        selected.get_or_insert(allowed);
    }
    selected
}

/// Resolve a native TUI tool name to the equivalent name declared by the
/// active workflow. This is intentionally adapter-only: ordinary MCP tools
/// retain exact-name enforcement, and command/test families remain distinct.
pub fn resolve_adapter_tool_name(
    session: &GatewaySession,
    requested: &str,
    tool_input: &serde_json::Value,
) -> String {
    resolve_adapter_tool_name_with_pipeline_and_origin(
        session,
        requested,
        tool_input,
        None,
        AdapterToolOrigin::NativeUnregistered,
    )
}

/// Resolve a native adapter tool after the risk pipeline has classified its
/// effect. A structurally proven read-only shell call can use the workflow's
/// provider-neutral read capability even when the legacy token classifier
/// cannot reduce compound Bash syntax to individual read commands.
pub fn resolve_adapter_tool_name_with_pipeline(
    session: &GatewaySession,
    requested: &str,
    tool_input: &serde_json::Value,
    pipeline: Option<&RiskPipelineAssessment>,
) -> String {
    resolve_adapter_tool_name_with_pipeline_and_origin(
        session,
        requested,
        tool_input,
        pipeline,
        AdapterToolOrigin::NativeUnregistered,
    )
}

pub fn resolve_adapter_tool_name_with_pipeline_and_origin(
    session: &GatewaySession,
    requested: &str,
    tool_input: &serde_json::Value,
    pipeline: Option<&RiskPipelineAssessment>,
    origin: AdapterToolOrigin,
) -> String {
    // Preserve the original identity before adapter aliases collapse it to a
    // provider-neutral family. This makes an explicit `grep` denial effective
    // even when `grep` would otherwise normalize to `Read`.
    if tool_enforcer::tool_is_explicitly_disallowed(
        &session.definition,
        &session.current_state,
        requested,
    ) {
        return requested.to_string();
    }
    // Registered upstream tools retain exact identity. Adapter transport
    // provenance says who delivered the call, not that the underlying tool is
    // a local native capability.
    if origin == AdapterToolOrigin::RegisteredUpstream {
        return requested.to_string();
    }
    let exploratory = session
        .definition
        .states
        .get(&session.current_state)
        .and_then(|state| state.intent.as_deref())
        == Some("exploratory_read_only");
    if exploratory {
        // Adapter-native read aliases have no MCP metadata.  Normalize only
        // the small built-in family; unknown adapters remain unknown.  Shell
        // admission is still decided from its arguments by interceptors.
        return match native_tool_family(requested) {
            Some(NativeToolFamily::Read) => "Read".to_string(),
            Some(NativeToolFamily::Command) => "Bash".to_string(),
            _ => format!("{UNTRUSTED_EXPLORATORY_ADAPTER}:{requested}"),
        };
    }
    let allowed = tool_enforcer::get_allowed_tools(&session.definition, &session.current_state)
        .unwrap_or_default();
    if allowed.iter().any(|name| name == requested) {
        return requested.to_string();
    }
    let Some(family) = native_tool_family(requested) else {
        return requested.to_string();
    };
    if family == NativeToolFamily::Command {
        if pipeline
            .is_some_and(|assessment| assessment.resolve_effect() == ResolvedEffect::ReadOnly)
        {
            if let Some(policy_name) = allowed_general_read_name(session) {
                return policy_name;
            }
        }
        if let Some(policy_name) = readonly_shell_policy_name(session, tool_input) {
            return policy_name;
        }
    }
    allowed
        .into_iter()
        .find(|candidate| native_tool_family(candidate) == Some(family))
        .unwrap_or_else(|| requested.to_string())
}

/// Evaluate whether a tool call should be permitted, blocked, or trigger an implicit transition.
pub fn enforce_tool_call(session: &GatewaySession, tool_name: &str) -> EnforcementDecision {
    if tool_name.starts_with(UNTRUSTED_EXPLORATORY_ADAPTER) {
        return EnforcementDecision::Block {
            reason: "Unregistered adapter tool has no authoritative read-only capability evidence in an exploratory state.".into(),
            available_tools: tool_enforcer::get_allowed_tools(&session.definition, &session.current_state)
                .unwrap_or_default(),
        };
    }
    if tool_name.eq_ignore_ascii_case("zsh") {
        return EnforcementDecision::Block {
            reason: "Zsh is not enabled for guarded shell execution. Use Bash so Statewright can apply its shell policy.".into(),
            available_tools: tool_enforcer::get_allowed_tools(&session.definition, &session.current_state)
                .unwrap_or_default(),
        };
    }
    // Final states block everything
    if session.is_final() {
        return EnforcementDecision::Block {
            reason: format!(
                "State machine is in final state '{}'. No tools are available.",
                session.current_state
            ),
            available_tools: vec![],
        };
    }

    let result = tool_enforcer::enforce_tools(
        &session.definition,
        &session.current_state,
        &[tool_name.to_string()],
    );

    if result.allowed.contains(&tool_name.to_string()) {
        // Tool is allowed — check if we've hit the checkpoint
        if session.is_checkpoint() {
            let max = session.max_iterations().unwrap();
            return EnforcementDecision::CheckpointReached {
                iteration: session.iteration_count,
                max,
            };
        }
        return EnforcementDecision::Allow;
    }

    // Tool is blocked — check for implicit transition
    if let Some(event) = result.implicit_transition {
        // Try the transition — check guards
        match resolve_transition(
            &session.current_state,
            &event,
            &serde_json::json!({}),
            &session.context,
            &session.definition,
        ) {
            Ok(transition_result) if transition_result.transitioned => {
                return EnforcementDecision::ImplicitTransition {
                    event,
                    new_state: transition_result.new_state,
                };
            }
            _ => {
                // Guard failed or transition error — fall through to block
            }
        }
    }

    // Blocked, no viable implicit transition
    let available = tool_enforcer::get_allowed_tools(&session.definition, &session.current_state)
        .unwrap_or_default();

    EnforcementDecision::Block {
        reason: format!(
            "Tool '{}' is not available in state '{}'. Available tools: {}",
            tool_name,
            session.current_state,
            available.join(", ")
        ),
        available_tools: available,
    }
}

fn uses_semantic_effect_policy(session: &GatewaySession) -> bool {
    matches!(
        session
            .context
            .get("tool_policy_mode")
            .and_then(|value| value.as_str()),
        Some(DENYLIST_HEURISTIC_POLICY_MODE | LEGACY_DENYLIST_HEURISTIC_POLICY_MODE)
    )
}

fn classifier_risk_tolerance(session: &GatewaySession) -> ClassifierRiskTolerance {
    session
        .definition
        .states
        .get(&session.current_state)
        .and_then(|state| state.classifier_policy.as_ref())
        .or_else(|| {
            session
                .definition
                .meta
                .as_ref()
                .and_then(|meta| meta.classifier_policy.as_ref())
        })
        .map(|policy| policy.risk_tolerance)
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticEffectDenial {
    pub reason: String,
    pub basis: &'static str,
    pub required_authority: &'static str,
}

impl SemanticEffectDenial {
    fn new(
        reason: impl Into<String>,
        basis: &'static str,
        required_authority: &'static str,
    ) -> Self {
        Self {
            reason: reason.into(),
            basis,
            required_authority,
        }
    }
}

/// Deny known-risk or unresolved effects before ordinary enforcement. This
/// gate is state-independent and therefore safe to apply before a transition.
pub fn semantic_effect_risk_denial(
    session: &GatewaySession,
    pipeline: &RiskPipelineAssessment,
) -> Option<String> {
    semantic_effect_risk_denial_details(session, pipeline).map(|denial| denial.reason)
}

pub fn semantic_effect_risk_denial_details(
    session: &GatewaySession,
    pipeline: &RiskPipelineAssessment,
) -> Option<SemanticEffectDenial> {
    if !uses_semantic_effect_policy(session) {
        return None;
    }
    let (effect, basis) = pipeline.resolve_effect_with_basis();
    match effect {
        ResolvedEffect::DenyKnownRisk => Some(SemanticEffectDenial::new(
            format!(
                "Operation denied: classifier axis '{basis}' resolved a known destructive, irreversible, or non-local effect. Required authority: {}. Equivalent retries are not allowed.",
                effect.required_authority(),
            ),
            basis,
            effect.required_authority(),
        )),
        ResolvedEffect::DenyUncertain => Some(SemanticEffectDenial::new(
            format!(
                "Operation denied: classifier axis '{basis}' left the effect uncertain after System One assessment. Required authority: {}. Inspect risk_assessment for the redacted bands and probabilities; do not retry the equivalent operation through another executable.",
                effect.required_authority(),
            ),
            basis,
            effect.required_authority(),
        )),
        ResolvedEffect::ReadOnly
            if basis.starts_with("semantic_")
                && classifier_risk_tolerance(session)
                    != ClassifierRiskTolerance::AssessedModerateLocal =>
        {
            Some(SemanticEffectDenial::new(
                format!(
                    "Operation denied: workflow classifier_policy does not admit semantic resolution at axis '{basis}'. Required authority: assessed_moderate_local. Equivalent retries are not allowed."
                ),
                "classifier_policy_semantic_resolution",
                "assessed_moderate_local",
            ))
        }
        ResolvedEffect::LocalWrite
        | ResolvedEffect::BoundedLocalExecution
        | ResolvedEffect::LocalWriteAndGitLocalWrite
            if classifier_risk_tolerance(session) == ClassifierRiskTolerance::LowLocal =>
        {
            Some(SemanticEffectDenial::new(
                "Operation denied: workflow classifier_policy permits only low-risk local reads. Required authority: moderate_local or assessed_moderate_local. Equivalent retries are not allowed.",
                "classifier_policy_low_local",
                "moderate_local_or_assessed_moderate_local",
            ))
        }
        ResolvedEffect::LocalWrite | ResolvedEffect::LocalWriteAndGitLocalWrite
            if basis.starts_with("semantic_")
                && classifier_risk_tolerance(session)
                    != ClassifierRiskTolerance::AssessedModerateLocal =>
        {
            Some(SemanticEffectDenial::new(
                format!(
                    "Operation denied: workflow classifier_policy does not admit semantic local-write resolution at axis '{basis}'. Required authority: assessed_moderate_local. Equivalent retries are not allowed."
                ),
                "classifier_policy_semantic_local_write",
                "assessed_moderate_local",
            ))
        }
        ResolvedEffect::ReadOnly
        | ResolvedEffect::LocalWrite
        | ResolvedEffect::BoundedLocalExecution
        | ResolvedEffect::GitLocalWrite
        | ResolvedEffect::LocalWriteAndGitLocalWrite => None,
    }
}

/// Apply explicit capability denials after ordinary enforcement has selected
/// the state in which the operation will actually execute.
pub fn semantic_effect_capability_denial(
    execution_session: &GatewaySession,
    pipeline: &RiskPipelineAssessment,
) -> Option<String> {
    semantic_effect_capability_denial_details(execution_session, pipeline)
        .map(|denial| denial.reason)
}

pub fn semantic_effect_capability_denial_details(
    execution_session: &GatewaySession,
    pipeline: &RiskPipelineAssessment,
) -> Option<SemanticEffectDenial> {
    if !uses_semantic_effect_policy(execution_session) {
        return None;
    }
    let explicitly_denied = |capability: &str| {
        tool_enforcer::tool_is_explicitly_disallowed(
            &execution_session.definition,
            &execution_session.current_state,
            capability,
        )
    };
    let explicitly_allowed = |capability: &str| {
        tool_enforcer::get_allowed_tools(
            &execution_session.definition,
            &execution_session.current_state,
        )
        .is_some_and(|allowed| {
            allowed
                .iter()
                .any(|entry| entry.eq_ignore_ascii_case(capability))
        })
    };
    let has_capability_allowlist = execution_session
        .definition
        .states
        .get(&execution_session.current_state)
        .and_then(|state| state.allowed_tools.as_ref())
        .is_some();
    match pipeline.resolve_effect() {
        ResolvedEffect::ReadOnly if explicitly_denied("Read") => Some(SemanticEffectDenial::new(
            format!(
                "Read-only effect is explicitly blocked in state '{}'.",
                execution_session.current_state
            ),
            "workflow_capability_read_denied",
            "Read",
        )),
        ResolvedEffect::LocalWrite
            if explicitly_denied("Write")
                || (has_capability_allowlist && !explicitly_allowed("Write")) =>
        {
            Some(SemanticEffectDenial::new(
                format!(
                    "Local write effect is explicitly blocked in state '{}'.",
                    execution_session.current_state
                ),
                "workflow_capability_write_denied",
                "Write",
            ))
        }
        ResolvedEffect::BoundedLocalExecution
            if explicitly_denied("BoundedLocalExecution")
                || !explicitly_allowed("BoundedLocalExecution") =>
        {
            Some(SemanticEffectDenial::new(
                format!(
                    "Bounded local execution is not explicitly authorized in state '{}'.",
                    execution_session.current_state
                ),
                "workflow_capability_bounded_local_execution_not_allowed",
                "BoundedLocalExecution",
            ))
        }
        ResolvedEffect::GitLocalWrite
            if explicitly_denied("GitLocalWrite") || !explicitly_allowed("GitLocalWrite") =>
        {
            Some(SemanticEffectDenial::new(
                format!(
                    "Bounded local Git closeout is not explicitly authorized in state '{}'.",
                    execution_session.current_state
                ),
                "workflow_capability_git_local_write_not_allowed",
                "GitLocalWrite",
            ))
        }
        ResolvedEffect::LocalWriteAndGitLocalWrite
            if explicitly_denied("Write")
                || explicitly_denied("GitLocalWrite")
                || (has_capability_allowlist && !explicitly_allowed("Write"))
                || !explicitly_allowed("GitLocalWrite") =>
        {
            Some(SemanticEffectDenial::new(
                format!(
                    "Combined local file and bounded Git effects are not authorized in state '{}'.",
                    execution_session.current_state
                ),
                "workflow_capability_combined_local_write_not_allowed",
                "Write+GitLocalWrite",
            ))
        }
        ResolvedEffect::ReadOnly
        | ResolvedEffect::LocalWrite
        | ResolvedEffect::BoundedLocalExecution
        | ResolvedEffect::GitLocalWrite
        | ResolvedEffect::LocalWriteAndGitLocalWrite
        | ResolvedEffect::DenyKnownRisk
        | ResolvedEffect::DenyUncertain => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::SessionManager;
    use serde_json::json;
    use statewright_engine::MachineDefinition;

    fn test_definition() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "test",
            "initial": "planning",
            "states": {
                "planning": {
                    "allowed_tools": ["read_file", "grep"],
                    "max_iterations": 3,
                    "on": { "READY": "implementing", "FAIL": "failed" }
                },
                "implementing": {
                    "allowed_tools": ["read_file", "edit_file", "write_file"],
                    "max_iterations": 6,
                    "on": { "DONE": "testing", "FAIL": "failed" }
                },
                "testing": {
                    "allowed_tools": ["read_file", "run_test"],
                    "on": { "PASS": "completed", "FAIL_TEST": "implementing" }
                },
                "unrestricted": {
                    "on": { "DONE": "completed" }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap()
    }

    fn session_at(state: &str) -> GatewaySession {
        let mgr = SessionManager::new();
        let s = mgr.create("test".into(), test_definition());
        if state != "planning" {
            mgr.update_state("test", state.into(), json!({}));
        }
        mgr.get("test").unwrap()
    }

    fn denylist_session(disallowed: &[&str]) -> GatewaySession {
        let definition: MachineDefinition = serde_json::from_value(json!({
            "id": "denylist", "initial": "inspect",
            "context": {"tool_policy_mode":"denylist_heuristic_v1"},
            "states": {
                "inspect": {"disallowed_tools": disallowed, "on": {"DONE":"done"}},
                "done": {"type":"final"}
            }
        }))
        .unwrap();
        GatewaySession::new("denylist".into(), definition)
    }

    fn denylist_session_with_tolerance(risk_tolerance: &str) -> GatewaySession {
        let definition: MachineDefinition = serde_json::from_value(json!({
            "id": "denylist-policy", "initial": "inspect",
            "context": {"tool_policy_mode":"denylist_heuristic_v1"},
            "meta": {"classifier_policy": {"risk_tolerance": "low_local"}},
            "states": {
                "inspect": {
                    "classifier_policy": {"risk_tolerance": risk_tolerance},
                    "on": {"DONE":"done"}
                },
                "done": {"type":"final"}
            }
        }))
        .unwrap();
        GatewaySession::new("denylist-policy".into(), definition)
    }

    #[test]
    fn legacy_denylist_policy_wire_value_remains_accepted() {
        let definition: MachineDefinition = serde_json::from_value(json!({
            "id": "legacy-denylist", "initial": "inspect",
            "context": {"tool_policy_mode": LEGACY_DENYLIST_HEURISTIC_POLICY_MODE},
            "states": {"inspect": {"on": {"DONE":"done"}}, "done": {"type":"final"}},
            "guards": {}
        }))
        .unwrap();
        let session = GatewaySession::new("legacy-denylist".into(), definition);

        assert!(uses_semantic_effect_policy(&session));
    }

    fn semantic_pipeline(
        command: &str,
        vector: Option<crate::risk_assessment::SemanticRiskVector>,
    ) -> crate::risk_assessment::RiskPipelineAssessment {
        use crate::risk_assessment::{SemanticAssessmentReceipt, SemanticAssessorStatus};
        let deterministic = crate::risk_assessment::assess_invocation(
            None,
            "exec_command",
            &json!({"cmd":command}),
            Some("inspect"),
        );
        let effective_risk = deterministic.risk;
        RiskPipelineAssessment {
            deterministic,
            semantic: SemanticAssessmentReceipt {
                tool: "exec_command".into(),
                status: if vector.is_some() {
                    SemanticAssessorStatus::Assessed
                } else {
                    SemanticAssessorStatus::Unavailable
                },
                vector,
                state_intent: Some("inspect".into()),
            },
            effective_risk,
            semantic_failsafe_escalated: false,
            semantic_authorization_enabled: true,
        }
    }

    #[test]
    fn denylist_semantic_effect_policy_applies_explicit_capabilities_and_fails_closed() {
        use crate::risk_assessment::{Probability, SemanticRiskVector};
        let read_vector = || SemanticRiskVector {
            read_only: Probability::new(0.98).unwrap(),
            may_write: Probability::new(0.01).unwrap(),
            reversible: Probability::new(0.99).unwrap(),
            destructive: Probability::new(0.01).unwrap(),
            irreversible: Probability::new(0.01).unwrap(),
            external_or_account_effect: Probability::new(0.01).unwrap(),
        };
        let open = denylist_session(&[]);
        assert!(
            semantic_effect_risk_denial(&open, &semantic_pipeline("rg policy src", None)).is_none()
        );
        assert!(
            semantic_effect_capability_denial(&open, &semantic_pipeline("rg policy src", None))
                .is_none()
        );
        assert!(
            semantic_effect_capability_denial(
                &open,
                &semantic_pipeline("cp source-file local-file", None)
            )
            .is_none()
        );
        assert!(
            semantic_effect_risk_denial(
                &open,
                &semantic_pipeline("tmux capture-pane -p -t private-pane", Some(read_vector())),
            )
            .is_none()
        );
        assert!(
            semantic_effect_risk_denial(&open, &semantic_pipeline("tmux new-session shell", None),)
                .unwrap()
                .contains("uncertain")
        );
        assert!(
            semantic_effect_risk_denial(
                &open,
                &semantic_pipeline("git push origin main", Some(read_vector())),
            )
            .unwrap()
            .contains("known")
        );

        let no_read = denylist_session(&["Read"]);
        assert!(
            semantic_effect_capability_denial(&no_read, &semantic_pipeline("rg policy src", None))
                .is_some()
        );
        assert!(
            semantic_effect_capability_denial(
                &no_read,
                &semantic_pipeline("tmux capture-pane -p -t %36", None),
            )
            .is_some()
        );
        let no_write = denylist_session(&["Write"]);
        assert!(
            semantic_effect_capability_denial(
                &no_write,
                &semantic_pipeline("cp source-file local-file", None)
            )
            .is_some()
        );

        let restricted_definition: MachineDefinition = serde_json::from_value(json!({
            "id": "restricted-denylist", "initial": "inspect",
            "context": {"tool_policy_mode":"denylist_heuristic_v1"},
            "states": {
                "inspect": {
                    "allowed_tools": ["Read", "Bash"],
                    "classifier_policy": {"risk_tolerance": "assessed_moderate_local"},
                    "on": {"DONE":"done"}
                },
                "done": {"type":"final"}
            }
        }))
        .unwrap();
        let restricted = GatewaySession::new("restricted-denylist".into(), restricted_definition);
        assert!(
            semantic_effect_capability_denial(
                &restricted,
                &semantic_pipeline("cp source-file local-file", None)
            )
            .is_some(),
            "an allowlist without Write must not admit a resolved local write"
        );

        let legacy = session_at("unrestricted");
        assert!(
            semantic_effect_risk_denial(
                &legacy,
                &semantic_pipeline("git push origin main", Some(read_vector())),
            )
            .is_none()
        );
    }

    #[test]
    fn classifier_policy_selects_only_bounded_local_tolerance() {
        use crate::risk_assessment::{Probability, SemanticRiskVector};
        let semantic_read = SemanticRiskVector {
            read_only: Probability::new(0.99).unwrap(),
            may_write: Probability::new(0.01).unwrap(),
            reversible: Probability::new(0.99).unwrap(),
            destructive: Probability::new(0.0).unwrap(),
            irreversible: Probability::new(0.0).unwrap(),
            external_or_account_effect: Probability::new(0.0).unwrap(),
        };
        let local_write = semantic_pipeline("cp source target", None);
        let inferred_read = semantic_pipeline("systemctl status statewright", Some(semantic_read));
        let external = semantic_pipeline("git push origin main", None);

        let low = denylist_session_with_tolerance("low_local");
        let low_denial = semantic_effect_risk_denial_details(&low, &local_write).unwrap();
        assert!(low_denial.reason.contains("low-risk local reads"));
        assert_eq!(low_denial.basis, "classifier_policy_low_local");
        assert_eq!(
            low_denial.required_authority,
            "moderate_local_or_assessed_moderate_local"
        );

        let moderate = denylist_session_with_tolerance("moderate_local");
        assert!(semantic_effect_risk_denial(&moderate, &local_write).is_none());
        let semantic_denial =
            semantic_effect_risk_denial_details(&moderate, &inferred_read).unwrap();
        assert!(
            semantic_denial
                .reason
                .contains("does not admit semantic resolution")
        );
        assert_eq!(
            semantic_denial.basis,
            "classifier_policy_semantic_resolution"
        );
        assert_eq!(
            semantic_denial.required_authority,
            "assessed_moderate_local"
        );

        let assessed = denylist_session_with_tolerance("assessed_moderate_local");
        assert!(semantic_effect_risk_denial(&assessed, &inferred_read).is_none());
        assert!(
            semantic_effect_risk_denial(&assessed, &external)
                .unwrap()
                .contains("known")
        );
    }

    #[test]
    fn semantic_capability_policy_applies_after_the_selected_execution_state() {
        let definition: MachineDefinition = serde_json::from_value(json!({
            "id":"transition", "initial":"inspect",
            "context":{"tool_policy_mode":"denylist_heuristic_v1"},
            "states": {
                "inspect":{"allowed_tools":["Read"], "disallowed_tools":["Write"], "on":{"IMPLEMENT":"implement"}},
                "implement":{"allowed_tools":["Read","Edit","Write"], "on":{"DONE":"done"}},
                "done":{"type":"final"}
            }
        })).unwrap();
        let current = GatewaySession::new("transition".into(), definition);
        let pipeline = semantic_pipeline("cp source-file local-file", None);
        assert!(semantic_effect_risk_denial(&current, &pipeline).is_none());
        assert!(semantic_effect_capability_denial(&current, &pipeline).is_some());
        assert!(matches!(
            enforce_tool_call(&current, "Edit"),
            EnforcementDecision::ImplicitTransition { ref new_state, .. } if new_state == "implement"
        ));
        let mut execution = current.clone();
        execution.current_state = "implement".into();
        assert!(semantic_effect_capability_denial(&execution, &pipeline).is_none());
    }

    #[test]
    fn exploratory_adapters_normalize_only_builtin_read_and_shell_families() {
        let definition: MachineDefinition = serde_json::from_value(json!({
            "id": "explore", "initial": "inspect", "states": {
                "inspect": {"intent": "exploratory_read_only", "on": {"DONE": "done"}},
                "done": {"type": "final"}
            }
        }))
        .unwrap();
        let session = GatewaySession::new("explore".into(), definition);
        assert_eq!(
            resolve_adapter_tool_name(&session, "grep", &json!({})),
            "Read"
        );
        assert_eq!(
            resolve_adapter_tool_name(&session, "terminal", &json!({"cmd":"touch x"})),
            "Bash"
        );
        let opaque = resolve_adapter_tool_name(&session, "mcp__db__query", &json!({}));
        assert!(opaque.starts_with(UNTRUSTED_EXPLORATORY_ADAPTER));
        assert!(matches!(
            enforce_tool_call(&session, &opaque),
            EnforcementDecision::Block { .. }
        ));
    }

    #[test]
    fn allow_tool_in_current_state() {
        let session = session_at("planning");
        match enforce_tool_call(&session, "read_file") {
            EnforcementDecision::Allow => {}
            other => panic!("Expected Allow, got {:?}", other),
        }
    }

    #[test]
    fn block_tool_not_in_current_state() {
        let session = session_at("planning");
        match enforce_tool_call(&session, "deploy") {
            EnforcementDecision::Block {
                available_tools, ..
            } => {
                assert!(available_tools.contains(&"read_file".to_string()));
                assert!(available_tools.contains(&"grep".to_string()));
                assert!(!available_tools.contains(&"deploy".to_string()));
            }
            other => panic!("Expected Block, got {:?}", other),
        }
    }

    #[test]
    fn implicit_transition_when_blocked_tool_in_next_state() {
        let session = session_at("planning");
        // edit_file is not in planning but IS in implementing (reachable via READY)
        match enforce_tool_call(&session, "edit_file") {
            EnforcementDecision::ImplicitTransition { event, new_state } => {
                assert_eq!(event, "READY");
                assert_eq!(new_state, "implementing");
            }
            other => panic!("Expected ImplicitTransition, got {:?}", other),
        }
    }

    #[test]
    fn checkpoint_reached_at_max_iterations() {
        let mgr = SessionManager::new();
        mgr.create("test".into(), test_definition());
        // planning has max_iterations: 3
        mgr.increment_iteration("test");
        mgr.increment_iteration("test");
        mgr.increment_iteration("test");
        let session = mgr.get("test").unwrap();

        match enforce_tool_call(&session, "read_file") {
            EnforcementDecision::CheckpointReached { iteration, max } => {
                assert_eq!(iteration, 3);
                assert_eq!(max, 3);
            }
            other => panic!("Expected CheckpointReached, got {:?}", other),
        }
    }

    #[test]
    fn final_state_blocks_all_tools() {
        let session = session_at("completed");
        match enforce_tool_call(&session, "read_file") {
            EnforcementDecision::Block {
                available_tools, ..
            } => {
                assert!(available_tools.is_empty());
            }
            other => panic!("Expected Block, got {:?}", other),
        }
    }

    #[test]
    fn unrestricted_state_allows_everything() {
        let session = session_at("unrestricted");
        match enforce_tool_call(&session, "any_tool_at_all") {
            EnforcementDecision::Allow => {}
            other => panic!("Expected Allow, got {:?}", other),
        }
    }

    #[test]
    fn block_includes_reason_with_tool_and_state() {
        let session = session_at("testing");
        // deploy doesn't exist in any reachable state from testing
        match enforce_tool_call(&session, "deploy") {
            EnforcementDecision::Block { reason, .. } => {
                assert!(reason.contains("deploy"));
                assert!(reason.contains("testing"));
            }
            other => panic!("Expected Block, got {:?}", other),
        }
    }

    #[test]
    fn checksum_shell_uses_read_equivalence_without_general_shell_access() {
        let session = session_at("planning");
        for command in ["sha256sum receipt.json", "shasum -a 256 receipt.json"] {
            let resolved =
                resolve_adapter_tool_name(&session, "exec_command", &json!({"cmd": command}));
            assert_eq!(resolved, "read_file");
            assert!(matches!(
                enforce_tool_call(&session, &resolved),
                EnforcementDecision::Allow
            ));
        }
        for command in [
            "openssl dgst -sha256 receipt.json",
            "python3 -c 'print(1)'",
            "shasum -a 256 receipt.json > receipt.sha256",
        ] {
            assert_eq!(
                resolve_adapter_tool_name(&session, "exec_command", &json!({"cmd": command})),
                "exec_command",
            );
        }
        assert_eq!(
            resolve_adapter_tool_name(
                &session_at("completed"),
                "exec_command",
                &json!({"cmd": "sha256sum receipt.json"})
            ),
            "exec_command",
        );
    }

    #[test]
    fn adapter_tool_names_resolve_only_to_equivalent_allowed_tools() {
        let session = session_at("planning");
        assert_eq!(
            resolve_adapter_tool_name(&session, "Read", &json!({})),
            "read_file"
        );
        assert_eq!(
            resolve_adapter_tool_name(&session, "read", &json!({})),
            "read_file"
        );
        assert_eq!(
            resolve_adapter_tool_name(&session, "deploy", &json!({})),
            "deploy"
        );
        assert_eq!(
            resolve_adapter_tool_name(&session, "exec_command", &json!({"cmd": "cat README.md"}),),
            "read_file",
        );
        assert_eq!(
            resolve_adapter_tool_name(
                &session,
                "Bash",
                &json!({"command": "printf x > marker.txt"}),
            ),
            "Bash",
        );

        let testing = session_at("testing");
        assert_eq!(
            resolve_adapter_tool_name(&testing, "bash", &json!({})),
            "bash"
        );
        assert_eq!(
            resolve_adapter_tool_name(&testing, "run_test", &json!({})),
            "run_test"
        );
    }

    #[test]
    fn authoritative_read_pipeline_maps_compound_shell_to_read_capability() {
        let definition: MachineDefinition = serde_json::from_value(json!({
            "id": "pipeline-map",
            "initial": "planning",
            "context": {"tool_policy_mode": "denylist_heuristic_v1"},
            "states": {
                "planning": {
                    "allowed_tools": ["Read", "Grep", "Glob"],
                    "disallowed_tools": ["Write"],
                    "on": {"DONE": "completed"}
                },
                "completed": {"type": "final"}
            }
        }))
        .unwrap();
        let session = GatewaySession::new("pipeline-map".into(), definition);
        crate::risk_assessment::set_test_shell_ast_authority_enabled(Some(true));
        let read = semantic_pipeline(
            "if git rev-parse HEAD; then tmux capture-pane -p -t %36 | tail -20; fi",
            None,
        );
        let write = semantic_pipeline("git rev-parse HEAD || git push origin HEAD", None);
        crate::risk_assessment::set_test_shell_ast_authority_enabled(None);

        assert_eq!(read.resolve_effect(), ResolvedEffect::ReadOnly);
        assert_eq!(
            resolve_adapter_tool_name_with_pipeline(
                &session,
                "exec_command",
                &json!({"cmd":"if git rev-parse HEAD; then tmux capture-pane -p -t %36 | tail -20; fi"}),
                Some(&read),
            ),
            "Read",
        );
        assert_eq!(
            resolve_adapter_tool_name_with_pipeline(
                &session,
                "exec_command",
                &json!({"cmd":"git rev-parse HEAD || git push origin HEAD"}),
                Some(&write),
            ),
            "exec_command",
        );
    }

    #[test]
    fn git_closeout_capability_does_not_inherit_native_write_authority() {
        let definition: MachineDefinition = serde_json::from_value(json!({
            "id": "git-closeout-capability",
            "initial": "intake",
            "context": {"tool_policy_mode": "denylist_heuristic_v1"},
            "states": {
                "intake": {
                    "disallowed_tools": ["Write"],
                    "on": {"READY": "commit"}
                },
                "commit": {
                    "allowed_tools": ["Read", "Bash", "GitLocalWrite"],
                    "disallowed_tools": ["Write"],
                    "on": {"DONE": "complete"}
                },
                "complete": {"type": "final"}
            }
        }))
        .unwrap();
        let mut session = GatewaySession::new("git-closeout-capability".into(), definition);
        let closeout = semantic_pipeline(
            "statewright-git-closeout --message 'docs: bounded closeout' -- docs/one.md",
            None,
        );
        let ordinary_write = semantic_pipeline("mkdir output", None);

        assert_eq!(closeout.resolve_effect(), ResolvedEffect::GitLocalWrite);
        assert!(semantic_effect_capability_denial(&session, &closeout).is_some());
        session.current_state = "commit".into();
        assert!(semantic_effect_capability_denial(&session, &closeout).is_none());
        assert_eq!(ordinary_write.resolve_effect(), ResolvedEffect::LocalWrite);
        assert!(semantic_effect_capability_denial(&session, &ordinary_write).is_some());
    }

    #[test]
    fn normalized_capabilities_admit_native_read_and_write_tools() {
        let definition: MachineDefinition = serde_json::from_value(json!({
            "id": "normalized",
            "initial": "working",
            "states": {
                "working": {
                    "allowed_tools": ["Read", "Write", "Bash"],
                    "on": { "DONE": "completed" }
                },
                "completed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();
        let session = GatewaySession::new("normalized".into(), definition);

        for native in ["Read", "grep", "Glob", "find_files", "ls"] {
            assert_eq!(
                resolve_adapter_tool_name(&session, native, &json!({})),
                "Read"
            );
        }
        for native in [
            "Edit",
            "edit",
            "apply_patch",
            "functions.apply_patch",
            "patch_file",
            "MultiEdit",
            "multiedit",
            "StrReplace",
            "write_file",
            "create_or_update_file",
        ] {
            assert_eq!(
                resolve_adapter_tool_name(&session, native, &json!({})),
                "Write"
            );
        }
        match enforce_tool_call(&session, "Zsh") {
            EnforcementDecision::Block { reason, .. } => assert!(reason.contains("Use Bash")),
            other => panic!("Zsh must be explicitly blocked, got {other:?}"),
        }
        assert!(
            unsupported_shell_dialect_reason("exec_command", &json!({"shell": "/bin/zsh"}))
                .is_some()
        );
        assert!(
            unsupported_shell_dialect_reason("exec_command", &json!({"shell": "/bin/bash"}))
                .is_none()
        );
        assert!(unsupported_shell_dialect_reason("Read", &json!({"shell": "/bin/zsh"})).is_none());
    }
}
