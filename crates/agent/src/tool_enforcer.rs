use statewright_engine::MachineDefinition;

/// Result of enforcing tool access for a given state.
#[derive(Debug, Clone)]
pub struct ToolEnforcementResult {
    pub allowed: Vec<String>,
    pub blocked: Vec<String>,
    /// If a blocked tool belongs to a reachable next state, suggest the transition event.
    pub implicit_transition: Option<String>,
}

/// Given a state machine definition and the current state, check which
/// of the requested tools are allowed and which are blocked.
pub fn enforce_tools(
    definition: &MachineDefinition,
    current_state: &str,
    requested_tools: &[String],
) -> ToolEnforcementResult {
    let allowed_set = get_allowed_tools(definition, current_state);

    let mut allowed = Vec::new();
    let mut blocked = Vec::new();

    for tool in requested_tools {
        match &allowed_set {
            Some(permitted) => {
                if permitted.contains(tool) {
                    allowed.push(tool.clone());
                } else {
                    blocked.push(tool.clone());
                }
            }
            None => {
                // No restrictions — state has no allowed_tools defined
                // But final states block everything (no work should happen)
                let is_final = definition
                    .states
                    .get(current_state)
                    .and_then(|s| s.state_type.as_ref())
                    .is_some_and(|t| matches!(t, statewright_engine::StateType::Final));

                if is_final {
                    blocked.push(tool.clone());
                } else {
                    allowed.push(tool.clone());
                }
            }
        }
    }

    // Check if any blocked tool belongs to a reachable next state
    let implicit_transition = if !blocked.is_empty() {
        find_implicit_transition(definition, current_state, &blocked)
    } else {
        None
    };

    ToolEnforcementResult { allowed, blocked, implicit_transition }
}

/// If a blocked tool is available in a state reachable via a single transition,
/// return the event name that would get us there.
fn find_implicit_transition(
    definition: &MachineDefinition,
    current_state: &str,
    blocked_tools: &[String],
) -> Option<String> {
    let state_def = definition.states.get(current_state)?;

    for (event, transition) in &state_def.on {
        let target = transition.target();
        if let Some(target_def) = definition.states.get(target) {
            if let Some(target_tools) = &target_def.allowed_tools {
                for blocked in blocked_tools {
                    if target_tools.contains(blocked) {
                        return Some(event.clone());
                    }
                }
            }
        }
    }
    None
}

/// Get the list of allowed tools for a given state.
/// Returns None if the state has no tool restrictions (all tools allowed).
pub fn get_allowed_tools(
    definition: &MachineDefinition,
    current_state: &str,
) -> Option<Vec<String>> {
    definition
        .states
        .get(current_state)?
        .allowed_tools
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn agent_machine() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "test-agent",
            "initial": "planning",
            "states": {
                "planning": {
                    "allowed_tools": ["read_file", "search_files", "grep"],
                    "on": { "READY": "executing", "FAIL": "failed" }
                },
                "executing": {
                    "allowed_tools": ["read_file", "write_file", "edit_file", "run_test"],
                    "on": { "DONE": "completed", "FAIL": "failed" }
                },
                "unrestricted": {
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
    fn allows_permitted_tools() {
        let def = agent_machine();
        let requested = vec!["read_file".into(), "search_files".into()];
        let result = enforce_tools(&def, "planning", &requested);
        assert_eq!(result.allowed, vec!["read_file", "search_files"]);
        assert!(result.blocked.is_empty());
    }

    #[test]
    fn blocks_unpermitted_tools() {
        let def = agent_machine();
        let requested = vec!["read_file".into(), "write_file".into(), "deploy".into()];
        let result = enforce_tools(&def, "planning", &requested);
        assert_eq!(result.allowed, vec!["read_file"]);
        assert_eq!(result.blocked, vec!["write_file", "deploy"]);
    }

    #[test]
    fn allows_all_tools_when_no_restrictions() {
        let def = agent_machine();
        let requested = vec!["read_file".into(), "deploy".into(), "delete_file".into()];
        let result = enforce_tools(&def, "unrestricted", &requested);
        assert_eq!(result.allowed, vec!["read_file", "deploy", "delete_file"]);
        assert!(result.blocked.is_empty());
    }

    #[test]
    fn returns_empty_for_no_requested_tools() {
        let def = agent_machine();
        let requested: Vec<String> = vec![];
        let result = enforce_tools(&def, "planning", &requested);
        assert!(result.allowed.is_empty());
        assert!(result.blocked.is_empty());
    }

    #[test]
    fn get_allowed_tools_returns_list_for_restricted_state() {
        let def = agent_machine();
        let tools = get_allowed_tools(&def, "planning");
        assert!(tools.is_some());
        let tools = tools.unwrap();
        assert!(tools.contains(&"read_file".to_string()));
        assert!(tools.contains(&"search_files".to_string()));
        assert!(!tools.contains(&"write_file".to_string()));
    }

    #[test]
    fn get_allowed_tools_returns_none_for_unrestricted_state() {
        let def = agent_machine();
        let tools = get_allowed_tools(&def, "unrestricted");
        assert!(tools.is_none());
    }

    #[test]
    fn get_allowed_tools_returns_none_for_unknown_state() {
        let def = agent_machine();
        let tools = get_allowed_tools(&def, "nonexistent");
        assert!(tools.is_none());
    }

    #[test]
    fn blocks_all_tools_in_final_state() {
        let def = agent_machine();
        let requested = vec!["read_file".into(), "write_file".into()];
        let result = enforce_tools(&def, "completed", &requested);
        // Final states have no transitions, no allowed_tools — block everything
        assert!(result.allowed.is_empty());
        assert_eq!(result.blocked, vec!["read_file", "write_file"]);
    }
}
