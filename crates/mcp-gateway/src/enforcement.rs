use statewright_agent::tool_enforcer;
use statewright_engine::resolve_transition;

use crate::session::GatewaySession;

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

/// Evaluate whether a tool call should be permitted, blocked, or trigger an implicit transition.
pub fn enforce_tool_call(session: &GatewaySession, tool_name: &str) -> EnforcementDecision {
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
}
