use crate::types::*;
use std::collections::{BTreeSet, VecDeque};

/// Validate a machine definition for structural correctness.
/// Returns Ok(()) if valid, Err(ValidationError) with all issues found.
pub fn validate_definition(definition: &MachineDefinition) -> Result<(), ValidationError> {
    let mut errors = Vec::new();

    // 1. Initial state must exist in states
    if !definition.states.contains_key(&definition.initial) {
        errors.push(format!(
            "initial state '{}' not found in states",
            definition.initial
        ));
    }

    // 2. Must have at least one final state
    let has_final = definition.states.values().any(|s| {
        matches!(s.state_type, Some(StateType::Final))
    });
    if !has_final {
        errors.push("no final state defined; at least one state must have type: final".into());
    }

    // 3. All transition targets must reference existing states
    for (state_name, state_def) in &definition.states {
        for (event, transition) in &state_def.on {
            let target = transition.target();
            if !definition.states.contains_key(target) {
                errors.push(format!(
                    "state '{}' event '{}' targets nonexistent state '{}'",
                    state_name, event, target
                ));
            }

            // 4. All guard references must resolve
            for guard_name in transition.guard_names() {
                if !definition.guards.contains_key(guard_name) {
                    errors.push(format!(
                        "state '{}' event '{}' references undefined guard '{}'",
                        state_name, event, guard_name
                    ));
                }
            }
        }
    }

    // 5. All states must be reachable from initial (BFS)
    if definition.states.contains_key(&definition.initial) {
        let mut visited = BTreeSet::new();
        let mut queue = VecDeque::new();
        queue.push_back(definition.initial.as_str());
        visited.insert(definition.initial.as_str());

        while let Some(state_name) = queue.pop_front() {
            if let Some(state_def) = definition.states.get(state_name) {
                for transition in state_def.on.values() {
                    let target = transition.target();
                    if definition.states.contains_key(target) && visited.insert(target) {
                        queue.push_back(target);
                    }
                }
            }
        }

        for state_name in definition.states.keys() {
            if !visited.contains(state_name.as_str()) {
                errors.push(format!("state '{}' is unreachable from initial state", state_name));
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(ValidationError { errors })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_machine() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "test",
            "initial": "start",
            "states": {
                "start": {
                    "on": { "GO": "end", "FAIL": "failed" }
                },
                "end": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap()
    }

    #[test]
    fn accepts_valid_machine() {
        assert!(validate_definition(&valid_machine()).is_ok());
    }

    #[test]
    fn rejects_missing_initial_state_in_states() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "bad",
            "initial": "nonexistent",
            "states": {
                "start": { "on": { "GO": "end" } },
                "end": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        let err = validate_definition(&def).unwrap_err();
        assert!(err.errors.iter().any(|e| e.contains("initial state")));
    }

    #[test]
    fn rejects_no_final_state() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "bad",
            "initial": "start",
            "states": {
                "start": { "on": { "GO": "middle" } },
                "middle": { "on": { "GO": "start" } }
            },
            "guards": {}
        }))
        .unwrap();

        let err = validate_definition(&def).unwrap_err();
        assert!(err.errors.iter().any(|e| e.contains("final")));
    }

    #[test]
    fn rejects_unreachable_states() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "bad",
            "initial": "start",
            "states": {
                "start": { "on": { "GO": "end" } },
                "end": { "type": "final" },
                "orphan": { "on": { "GO": "end" } }
            },
            "guards": {}
        }))
        .unwrap();

        let err = validate_definition(&def).unwrap_err();
        assert!(err.errors.iter().any(|e| e.contains("unreachable")));
    }

    #[test]
    fn rejects_transition_to_nonexistent_state() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "bad",
            "initial": "start",
            "states": {
                "start": { "on": { "GO": "nowhere" } },
                "end": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        let err = validate_definition(&def).unwrap_err();
        assert!(err.errors.iter().any(|e| e.contains("nowhere")));
    }

    #[test]
    fn rejects_undefined_guard_reference() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "bad",
            "initial": "start",
            "states": {
                "start": {
                    "on": {
                        "GO": { "target": "end", "guard": "nonexistent_guard" }
                    }
                },
                "end": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        let err = validate_definition(&def).unwrap_err();
        assert!(err.errors.iter().any(|e| e.contains("nonexistent_guard")));
    }

    #[test]
    fn accepts_complex_agent_machine() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "bug-fix",
            "initial": "planning",
            "meta": { "task_type": "bug_fix", "danger_level": "moderate" },
            "states": {
                "planning": {
                    "allowed_tools": ["read_file", "search_files"],
                    "instructions": "Analyze the bug",
                    "on": { "PLAN_READY": "implementing", "FAIL": "failed" }
                },
                "implementing": {
                    "allowed_tools": ["read_file", "write_file"],
                    "on": { "DONE": "testing", "FAIL": "failed" }
                },
                "testing": {
                    "allowed_tools": ["read_file", "run_test"],
                    "on": {
                        "TESTS_PASS": {
                            "target": "review",
                            "requires_approval": true
                        },
                        "TESTS_FAIL": "implementing",
                        "FAIL": "failed"
                    }
                },
                "review": {
                    "on": { "APPROVED": "completed", "REJECTED": "implementing" }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        assert!(validate_definition(&def).is_ok());
    }
}
