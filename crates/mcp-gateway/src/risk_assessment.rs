//! Deterministic, provider-neutral pre-tool risk/exposure assessment.
//!
//! This is deliberately a shadow primitive: callers keep their existing
//! authorization checks. The assessment contains no arguments or payloads so
//! it is safe to log as a bounded staging receipt.

use crate::{bash_classifier::{self, OpClass}, protocol::ToolInfo};

#[cfg(test)]
use std::cell::{Cell, RefCell};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskBand { Low, Moderate, High, Critical }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExposureBand { Local, External, Account, Unknown }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShadowAssessment {
    pub risk: RiskBand,
    pub exposure: ExposureBand,
    pub source: &'static str,
    /// Workflow intent is context for calibration only; it never changes the
    /// deterministic authorization decision in this shadow-only milestone.
    pub state_intent: Option<String>,
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

#[cfg(test)]
thread_local! {
    static TEST_SHADOW_ENABLED: Cell<Option<bool>> = const { Cell::new(None) };
    static TEST_SHADOW_RECEIPTS: RefCell<Vec<ShadowReceipt>> = const { RefCell::new(Vec::new()) };
}

#[cfg(test)]
pub fn set_test_shadow_enabled(enabled: Option<bool>) {
    TEST_SHADOW_ENABLED.with(|value| value.set(enabled));
}

#[cfg(test)]
pub fn take_test_shadow_receipts() -> Vec<ShadowReceipt> {
    TEST_SHADOW_RECEIPTS.with(|receipts| std::mem::take(&mut *receipts.borrow_mut()))
}

/// The global evaluator is inert unless a staging deployment opts in. This
/// keeps the kernel reusable without adding production telemetry by default.
pub fn shadow_enabled_for(value: Option<&str>) -> bool {
    matches!(value, Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES"))
}

/// Emit a bounded receipt only when the deployment has explicitly opted in.
/// The boolean is intentionally returned for ingress tests and health metrics;
/// it says nothing about authorization, which remains deterministic.
pub fn emit_shadow(tool: &str, assessment: &ShadowAssessment) -> bool {
    let enabled = shadow_enabled_for(std::env::var("STATEWRIGHT_SHADOW_RISK_ASSESSMENT").ok().as_deref());
    #[cfg(test)]
    let enabled = TEST_SHADOW_ENABLED.with(|override_value| override_value.get().unwrap_or(enabled));
    emit_shadow_when(enabled, tool, assessment)
}

fn emit_shadow_when(enabled: bool, tool: &str, assessment: &ShadowAssessment) -> bool {
    if enabled {
        #[cfg(test)]
        TEST_SHADOW_RECEIPTS.with(|receipts| receipts.borrow_mut().push(ShadowReceipt {
            tool: tool.to_string(),
            risk: assessment.risk,
            exposure: assessment.exposure,
            source: assessment.source,
            state_intent: assessment.state_intent.clone(),
        }));
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

pub fn assess_shell(command: &str) -> ShadowAssessment {
    let classes = bash_classifier::classify(command);
    if classes.contains(&OpClass::Destructive) {
        return assessment(RiskBand::Critical, ExposureBand::Local, "shell");
    }
    if classes.contains(&OpClass::Network) || classes.contains(&OpClass::GitWrite) {
        return assessment(RiskBand::High, ExposureBand::External, "shell");
    }
    if classes.contains(&OpClass::FileWrite) || classes.contains(&OpClass::FileModify) {
        return assessment(RiskBand::Moderate, ExposureBand::Local, "shell");
    }
    if bash_classifier::readonly_capabilities(command).is_some() {
        return assessment(RiskBand::Low, ExposureBand::Local, "shell");
    }
    assessment(RiskBand::Moderate, ExposureBand::Unknown, "shell")
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
    let is_shell = matches!(
        tool_name.to_ascii_lowercase().as_str(),
        "bash" | "shell" | "terminal" | "exec_command" | "run_command"
    );
    let mut result = if is_shell {
        arguments
            .get("command")
            .or_else(|| arguments.get("cmd"))
            .and_then(|value| value.as_str())
            .map(assess_shell)
            .unwrap_or_else(|| assess_mcp(tool, tool_name))
    } else {
        assess_mcp(tool, tool_name)
    };
    result.state_intent = state_intent.map(str::to_owned);
    result
}

pub fn assess_mcp(tool: Option<&ToolInfo>, tool_name: &str) -> ShadowAssessment {
    if let Some(tool) = tool {
        if tool.annotations.as_ref().and_then(|a| a.read_only_hint) == Some(true) {
            let exposure = if tool.annotations.as_ref().and_then(|a| a.open_world_hint) == Some(true) {
                ExposureBand::External
            } else {
                ExposureBand::Local
            };
            return assessment(RiskBand::Low, exposure, "mcp_annotation");
        }
        if tool.annotations.as_ref().and_then(|a| a.destructive_hint) == Some(true) {
            return assessment(RiskBand::Critical, ExposureBand::Account, "mcp_annotation");
        }
    }
    let open_world = tool
        .and_then(|tool| tool.annotations.as_ref())
        .and_then(|annotations| annotations.open_world_hint)
        == Some(true);
    let lower = tool_name.to_ascii_lowercase();
    let words: Vec<_> = lower.split(|c: char| !c.is_ascii_alphanumeric()).filter(|word| !word.is_empty()).collect();
    let has = |verbs: &[&str]| words.iter().any(|word| verbs.contains(word));
    let result = if has(&["delete", "remove", "destroy", "revoke", "purge", "send", "publish", "deploy", "push"]) {
        assessment(RiskBand::High, ExposureBand::Account, "mcp_name")
    } else if has(&["create", "update", "write", "edit", "patch", "apply", "upload", "move", "rename"]) {
        assessment(RiskBand::Moderate, ExposureBand::Local, "mcp_name")
    } else if has(&["read", "get", "list", "search", "find", "query", "inspect", "status", "describe", "lookup"]) {
        assessment(RiskBand::Low, ExposureBand::Local, "mcp_name")
    } else {
        assessment(RiskBand::Moderate, ExposureBand::Unknown, "mcp_unknown")
    };
    if open_world && result.exposure == ExposureBand::Local {
        assessment(result.risk, ExposureBand::External, result.source)
    } else {
        result
    }
}

fn assessment(risk: RiskBand, exposure: ExposureBand, source: &'static str) -> ShadowAssessment {
    ShadowAssessment { risk, exposure, source, state_intent: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shell_bands_cover_read_local_write_and_external_write() {
        assert_eq!(assess_shell("rg pattern src").risk, RiskBand::Low);
        assert_eq!(assess_shell("echo hi > out.txt"), assessment(RiskBand::Moderate, ExposureBand::Local, "shell"));
        assert_eq!(assess_shell("git push origin main"), assessment(RiskBand::High, ExposureBand::External, "shell"));
        assert_eq!(assess_shell("touch output.txt"), assessment(RiskBand::Moderate, ExposureBand::Unknown, "shell"));
        assert_eq!(assess_shell("git switch -c feature").risk, RiskBand::Moderate);
    }

    #[test]
    fn mcp_prefers_registered_annotations_and_marks_unknown() {
        let reader: ToolInfo = serde_json::from_value(json!({"name":"opaque","inputSchema":{},"annotations":{"readOnlyHint":true}})).unwrap();
        assert_eq!(assess_mcp(Some(&reader), "opaque").risk, RiskBand::Low);
        assert_eq!(assess_mcp(None, "mcp__opaque__thing").exposure, ExposureBand::Unknown);
        assert_eq!(assess_mcp(None, "mcp__mail__send_email"), assessment(RiskBand::High, ExposureBand::Account, "mcp_name"));
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
        assert_eq!(assessment.state_intent.as_deref(), Some("exploratory_read_only"));
    }

    #[test]
    fn open_world_mutation_is_external_not_local() {
        let writer: ToolInfo = serde_json::from_value(json!({
            "name":"update_task", "inputSchema":{}, "annotations":{"openWorldHint":true}
        })).unwrap();
        assert_eq!(
            assess_mcp(Some(&writer), "update_task"),
            assessment(RiskBand::Moderate, ExposureBand::External, "mcp_name")
        );
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
        let assessment = assess_shell("rg policy crates");
        assert!(!emit_shadow_when(false, "exec_command", &assessment));
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
}
