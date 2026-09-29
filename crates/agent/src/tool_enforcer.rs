use statewright_engine::MachineDefinition;

/// Result of enforcing tool access for a given state.
#[derive(Debug, Clone)]
pub struct ToolEnforcementResult {
    pub allowed: Vec<String>,
    pub blocked: Vec<String>,
    /// If a blocked tool belongs to a reachable next state, suggest the transition event.
    pub implicit_transition: Option<String>,
}

/// Coarse deterministic tool intent used only for the explicit
/// `exploratory_read_only` state policy. It is deliberately conservative:
/// unknown tools are blocked until a registry/annotation or a later semantic
/// shadow assessor can classify them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolIntent {
    ReadOnly,
    Mutating,
    Unknown,
}

fn classify_tool_intent(tool: &str) -> ToolIntent {
    let lower = tool.to_ascii_lowercase();
    if lower == "bash" || lower == "shell" || lower == "terminal" {
        // Bash is admitted here so the separate operation classifier can
        // inspect the command arguments for redirects, interpreters, etc.
        return ToolIntent::ReadOnly;
    }

    let words: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    let has = |verbs: &[&str]| words.iter().any(|word| verbs.contains(word));

    if has(&[
        "create", "update", "delete", "remove", "write", "edit", "patch", "send", "publish",
        "deploy", "apply", "commit", "push", "move", "rename", "upload", "archive", "trash",
        "execute",
    ]) {
        ToolIntent::Mutating
    } else if has(&[
        "read", "get", "list", "search", "find", "query", "inspect", "status", "describe", "fetch",
        "lookup",
    ]) {
        ToolIntent::ReadOnly
    } else {
        ToolIntent::Unknown
    }
}

fn is_explicitly_disallowed(tool: &str, disallowed: &[String]) -> bool {
    disallowed
        .iter()
        .any(|blocked| blocked.eq_ignore_ascii_case(tool))
}

/// Explicit denials always take precedence over inferred capabilities.  Gateway
/// adapters use this before normalizing a native name to Read/Bash so a policy
/// cannot be bypassed by an alias.
pub fn tool_is_explicitly_disallowed(
    definition: &MachineDefinition,
    current_state: &str,
    tool: &str,
) -> bool {
    definition
        .states
        .get(current_state)
        .and_then(|state| state.disallowed_tools.as_ref())
        .is_some_and(|disallowed| is_explicitly_disallowed(tool, disallowed))
}

/// Given a state machine definition and the current state, check which
/// of the requested tools are allowed and which are blocked.
pub fn enforce_tools(
    definition: &MachineDefinition,
    current_state: &str,
    requested_tools: &[String],
) -> ToolEnforcementResult {
    let state_def = definition.states.get(current_state);

    let mut allowed = Vec::new();
    let mut blocked = Vec::new();

    for tool in requested_tools {
        let is_final = state_def
            .and_then(|s| s.state_type.as_ref())
            .is_some_and(|t| matches!(t, statewright_engine::StateType::Final));
        let permitted = if is_final {
            false
        } else if let Some(state) = state_def {
            if state
                .disallowed_tools
                .as_ref()
                .is_some_and(|disallowed| is_explicitly_disallowed(tool, disallowed))
            {
                false
            } else if state.intent.as_deref() == Some("exploratory_read_only") {
                matches!(classify_tool_intent(tool), ToolIntent::ReadOnly)
            } else {
                match &state.allowed_tools {
                    Some(permitted) => permitted
                        .iter()
                        .any(|entry| entry.eq_ignore_ascii_case(tool)),
                    None => true,
                }
            }
        } else {
            false
        };

        if permitted {
            allowed.push(tool.clone());
        } else {
            blocked.push(tool.clone());
        }
    }

    // Check if any blocked tool belongs to a reachable next state
    let transitionable = blocked
        .iter()
        .filter(|tool| !tool_is_explicitly_disallowed(definition, current_state, tool))
        .cloned()
        .collect::<Vec<_>>();
    let implicit_transition = if !transitionable.is_empty() {
        find_implicit_transition(definition, current_state, &transitionable)
    } else {
        None
    };

    ToolEnforcementResult {
        allowed,
        blocked,
        implicit_transition,
    }
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
    let state = definition.states.get(current_state)?;
    if state.intent.as_deref() == Some("exploratory_read_only") {
        None
    } else {
        state.allowed_tools.clone().map(|allowed| {
            let denied = state.disallowed_tools.as_deref().unwrap_or_default();
            allowed
                .into_iter()
                .filter(|tool| !is_explicitly_disallowed(tool, denied))
                .collect()
        })
    }
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
    fn get_allowed_tools_preserves_allowlist_when_a_blocklist_is_also_present() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "mixed", "initial": "inspect", "states": {
                "inspect": {"allowed_tools": ["Read", "Write"], "disallowed_tools": ["Write"], "on": {"DONE": "done"}},
                "done": {"type": "final"}
            }
        })).unwrap();
        assert_eq!(
            get_allowed_tools(&def, "inspect"),
            Some(vec!["Read".into()])
        );
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

    #[test]
    fn disallowed_tools_is_a_real_blocklist() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "blocklist", "initial": "inspect", "states": {
                "inspect": {"disallowed_tools": ["Write", "Delete"], "on": {"DONE": "done"}},
                "done": {"type": "final"}
            }
        }))
        .unwrap();
        let requested = vec!["mcp__docs__list".into(), "Write".into(), "Delete".into()];
        let result = enforce_tools(&def, "inspect", &requested);
        assert_eq!(result.allowed, vec!["mcp__docs__list".to_string()]);
        assert_eq!(
            result.blocked,
            vec!["Write".to_string(), "Delete".to_string()]
        );
    }

    #[test]
    fn exploratory_read_only_allows_read_surface_and_blocks_mutation_or_unknown() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "explore", "initial": "inspect", "states": {
                "inspect": {"intent": "exploratory_read_only", "on": {"DONE": "done"}},
                "done": {"type": "final"}
            }
        }))
        .unwrap();
        let requested = vec![
            "mcp__statewright__statewright_list_workflows".into(),
            "mcp__gmail__read_email".into(),
            "Bash".into(),
            "mcp__gmail__send_email".into(),
            "mcp__opaque__perform_thing".into(),
        ];
        let result = enforce_tools(&def, "inspect", &requested);
        assert_eq!(
            result.allowed,
            vec![
                "mcp__statewright__statewright_list_workflows".to_string(),
                "mcp__gmail__read_email".to_string(),
                "Bash".to_string(),
            ]
        );
        assert_eq!(
            result.blocked,
            vec![
                "mcp__gmail__send_email".to_string(),
                "mcp__opaque__perform_thing".to_string(),
            ]
        );
    }

    #[test]
    fn exploratory_explicit_denial_wins_and_never_suggests_transition() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "deny-explore", "initial": "inspect", "states": {
                "inspect": {"intent": "exploratory_read_only", "disallowed_tools": ["Read", "grep"], "on": {"NEXT": "next"}},
                "next": {"allowed_tools": ["Read", "grep"]},
                "done": {"type": "final"}
            }
        })).unwrap();
        let result = enforce_tools(&def, "inspect", &["Read".into(), "grep".into()]);
        assert!(result.allowed.is_empty());
        assert_eq!(result.blocked, vec!["Read", "grep"]);
        assert!(result.implicit_transition.is_none());
    }
}
