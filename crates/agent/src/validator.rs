use statewright_engine::{DangerLevel, MachineDefinition, StateType};
use std::collections::{BTreeSet, VecDeque};

/// Tool categories for escalation detection.
const READ_ONLY_TOOLS: &[&str] = &[
    "read_file",
    "search_files",
    "list_directory",
    "grep",
    "git_status",
    "git_log",
    "git_diff",
];

const WRITE_TOOLS: &[&str] = &["write_file", "edit_file", "create_file", "delete_file"];

const EXECUTE_TOOLS: &[&str] = &["run_command", "run_test", "run_build"];

const GIT_MUTATE_TOOLS: &[&str] = &[
    "git_add",
    "git_commit",
    "git_push",
    "git_checkout",
    "git_branch",
];

const EXTERNAL_TOOLS: &[&str] = &[
    "http_request",
    "deploy",
    "database_query",
    "database_mutate",
];

/// Validate an LLM-generated machine definition for agent safety.
/// This extends the engine's structural validation with agent-specific checks.
pub fn validate_agent_machine(definition: &MachineDefinition) -> Result<(), AgentValidationError> {
    let mut errors = Vec::new();

    let danger = definition
        .meta
        .as_ref()
        .and_then(|m| m.danger_level.as_ref());
    let is_dangerous = matches!(
        danger,
        Some(DangerLevel::Dangerous) | Some(DangerLevel::Moderate)
    );

    // 1. Run engine-level structural validation first
    if let Err(e) = statewright_engine::validate_definition(definition) {
        errors.extend(e.errors);
    }

    // 2. Must have a "failed" state with type: final
    let has_failed = definition
        .states
        .get("failed")
        .and_then(|s| s.state_type.as_ref())
        .is_some_and(|t| matches!(t, StateType::Final));

    if !has_failed {
        errors.push("machine must have a 'failed' state with type: final".into());
    }

    // 3. Every non-final state must have a path to "failed"
    if has_failed {
        for (state_name, state_def) in &definition.states {
            if matches!(state_def.state_type, Some(StateType::Final)) {
                continue;
            }
            if !can_reach(state_name, "failed", definition) {
                errors.push(format!(
                    "state '{}' has no path to 'failed' state (every state must be able to fail)",
                    state_name
                ));
            }
        }
    }

    // 4. Initial state must not have write/execute/external tools (moderate/dangerous only)
    if is_dangerous {
        if let Some(initial_state) = definition.states.get(&definition.initial) {
            if let Some(tools) = &initial_state.allowed_tools {
                let dangerous_in_initial: Vec<&str> = tools
                    .iter()
                    .filter(|t| tool_privilege_level(t) >= 2)
                    .map(|s| s.as_str())
                    .collect();

                if !dangerous_in_initial.is_empty() {
                    errors.push(format!(
                        "initial state must not have write/execute tools (found: {})",
                        dangerous_in_initial.join(", ")
                    ));
                }
            }
        }
    }

    // 5. Dangerous/moderate machines must have at least one approval gate
    if is_dangerous {
        let has_approval = definition
            .states
            .values()
            .any(|state_def| state_def.on.values().any(|t| t.requires_approval()));

        if !has_approval {
            errors.push(
                "machine with danger_level 'moderate' or 'dangerous' must have at least one transition with requires_approval: true".into()
            );
        }
    }

    // 6. Tool escalation check: if a state has higher-privilege tools than a
    //    predecessor state, there must be an approval gate on the transition path
    if is_dangerous {
        for (state_name, state_def) in &definition.states {
            if matches!(state_def.state_type, Some(StateType::Final)) {
                continue;
            }
            let current_max = max_tool_privilege(state_def.allowed_tools.as_deref());

            for transition in state_def.on.values() {
                let target = transition.target();
                if let Some(target_def) = definition.states.get(target) {
                    let target_max = max_tool_privilege(target_def.allowed_tools.as_deref());

                    // Escalation: jumping 2+ privilege levels without approval
                    if target_max >= 4 && current_max <= 1 && !transition.requires_approval() {
                        errors.push(format!(
                            "tool escalation from '{}' (privilege {}) to '{}' (privilege {}) without approval gate",
                            state_name, current_max, target, target_max
                        ));
                    }
                }
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(AgentValidationError { errors })
    }
}

fn max_tool_privilege(tools: Option<&[String]>) -> u8 {
    tools
        .map(|ts| {
            ts.iter()
                .map(|t| tool_privilege_level(t))
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0)
}

/// BFS check: can we reach `target` from `from` following transitions?
fn can_reach(from: &str, target: &str, definition: &MachineDefinition) -> bool {
    let mut visited = BTreeSet::new();
    let mut queue = VecDeque::new();
    queue.push_back(from);
    visited.insert(from);

    while let Some(state) = queue.pop_front() {
        if let Some(state_def) = definition.states.get(state) {
            for transition in state_def.on.values() {
                let next = transition.target();
                if next == target {
                    return true;
                }
                if visited.insert(next) {
                    queue.push_back(next);
                }
            }
        }
    }
    false
}

/// Determines the "privilege level" of a tool set.
/// Higher number = more dangerous.
fn tool_privilege_level(tool: &str) -> u8 {
    if READ_ONLY_TOOLS.contains(&tool) {
        return 1;
    }
    if WRITE_TOOLS.contains(&tool) {
        return 2;
    }
    if EXECUTE_TOOLS.contains(&tool) {
        return 3;
    }
    if GIT_MUTATE_TOOLS.contains(&tool) {
        return 3;
    }
    if EXTERNAL_TOOLS.contains(&tool) {
        return 4;
    }
    0 // unknown tool
}

#[derive(Debug, Clone)]
pub struct AgentValidationError {
    pub errors: Vec<String>,
}

impl std::fmt::Display for AgentValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "agent validation errors: {}", self.errors.join("; "))
    }
}

impl std::error::Error for AgentValidationError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_bug_fix_machine() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "bug-fix",
            "initial": "planning",
            "meta": { "task_type": "bug_fix", "danger_level": "moderate" },
            "states": {
                "planning": {
                    "allowed_tools": ["read_file", "search_files", "grep"],
                    "instructions": "Analyze the bug. Read relevant files.",
                    "on": { "PLAN_READY": "implementing", "FAIL": "failed" }
                },
                "implementing": {
                    "allowed_tools": ["read_file", "write_file", "edit_file"],
                    "instructions": "Implement the fix.",
                    "on": { "DONE": "testing", "FAIL": "failed" }
                },
                "testing": {
                    "allowed_tools": ["read_file", "run_test"],
                    "instructions": "Run tests to verify.",
                    "on": {
                        "TESTS_PASS": {
                            "target": "review",
                            "requires_approval": true,
                            "approval_message": "Tests passed. Review the changes?"
                        },
                        "TESTS_FAIL": "implementing",
                        "FAIL": "failed"
                    }
                },
                "review": {
                    "allowed_tools": ["read_file"],
                    "on": { "APPROVED": "committing", "REJECTED": "implementing" }
                },
                "committing": {
                    "allowed_tools": ["git_add", "git_commit"],
                    "on": { "COMMITTED": "completed", "FAIL": "failed" }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap()
    }

    fn valid_research_machine() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "research",
            "initial": "gathering",
            "meta": { "task_type": "research", "danger_level": "safe" },
            "states": {
                "gathering": {
                    "allowed_tools": ["read_file", "search_files", "grep", "http_request"],
                    "on": { "DATA_COLLECTED": "analyzing", "FAIL": "failed" }
                },
                "analyzing": {
                    "allowed_tools": ["read_file"],
                    "on": { "ANALYSIS_DONE": "summarizing", "FAIL": "failed" }
                },
                "summarizing": {
                    "allowed_tools": ["read_file", "write_file"],
                    "on": { "DONE": "completed", "FAIL": "failed" }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap()
    }

    #[test]
    fn accepts_valid_bug_fix_machine() {
        assert!(validate_agent_machine(&valid_bug_fix_machine()).is_ok());
    }

    #[test]
    fn accepts_valid_research_machine() {
        assert!(validate_agent_machine(&valid_research_machine()).is_ok());
    }

    #[test]
    fn rejects_missing_failed_state() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "bad",
            "initial": "start",
            "meta": { "danger_level": "safe" },
            "states": {
                "start": { "on": { "GO": "end" } },
                "end": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        let err = validate_agent_machine(&def).unwrap_err();
        assert!(
            err.errors.iter().any(|e| e.contains("failed")),
            "expected error about missing 'failed' state, got: {:?}",
            err.errors
        );
    }

    #[test]
    fn rejects_dangerous_machine_without_approval_gate() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "bad",
            "initial": "planning",
            "meta": { "danger_level": "dangerous" },
            "states": {
                "planning": {
                    "allowed_tools": ["read_file"],
                    "on": { "GO": "executing", "FAIL": "failed" }
                },
                "executing": {
                    "allowed_tools": ["write_file", "deploy"],
                    "on": { "DONE": "completed", "FAIL": "failed" }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        let err = validate_agent_machine(&def).unwrap_err();
        assert!(
            err.errors.iter().any(|e| e.contains("approval")),
            "expected error about missing approval gate, got: {:?}",
            err.errors
        );
    }

    #[test]
    fn rejects_write_tools_in_initial_state() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "bad",
            "initial": "start",
            "meta": { "danger_level": "moderate" },
            "states": {
                "start": {
                    "allowed_tools": ["read_file", "write_file", "delete_file"],
                    "on": { "GO": "end", "FAIL": "failed" }
                },
                "end": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        let err = validate_agent_machine(&def).unwrap_err();
        assert!(
            err.errors
                .iter()
                .any(|e| e.contains("initial state") || e.contains("write")),
            "expected error about write tools in initial state, got: {:?}",
            err.errors
        );
    }

    #[test]
    fn rejects_tool_escalation_without_approval() {
        // Goes from read-only tools to deploy (external) without any approval gate
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "bad",
            "initial": "reading",
            "meta": { "danger_level": "moderate" },
            "states": {
                "reading": {
                    "allowed_tools": ["read_file"],
                    "on": { "GO": "deploying", "FAIL": "failed" }
                },
                "deploying": {
                    "allowed_tools": ["deploy", "database_mutate"],
                    "on": { "DONE": "completed", "FAIL": "failed" }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        let err = validate_agent_machine(&def).unwrap_err();
        assert!(
            err.errors
                .iter()
                .any(|e| e.contains("escalation") || e.contains("approval")),
            "expected error about tool escalation without approval, got: {:?}",
            err.errors
        );
    }

    #[test]
    fn rejects_state_without_fail_transition() {
        // Non-final state with no path to failed
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "bad",
            "initial": "start",
            "meta": { "danger_level": "safe" },
            "states": {
                "start": {
                    "on": { "GO": "middle" }
                },
                "middle": {
                    "on": { "GO": "completed" }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        let err = validate_agent_machine(&def).unwrap_err();
        assert!(
            err.errors
                .iter()
                .any(|e| e.contains("failed") || e.contains("FAIL")),
            "expected error about missing path to failed, got: {:?}",
            err.errors
        );
    }

    #[test]
    fn passes_structural_validation_from_engine() {
        // Invalid at the engine level (initial state doesn't exist) should also fail here
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "bad",
            "initial": "nonexistent",
            "meta": { "danger_level": "safe" },
            "states": {
                "start": { "on": { "GO": "end", "FAIL": "failed" } },
                "end": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        let err = validate_agent_machine(&def).unwrap_err();
        assert!(
            err.errors.iter().any(|e| e.contains("initial state")),
            "expected engine-level validation error, got: {:?}",
            err.errors
        );
    }
}
