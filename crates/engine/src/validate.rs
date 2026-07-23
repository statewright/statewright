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
    let has_final = definition
        .states
        .values()
        .any(|s| matches!(s.state_type, Some(StateType::Final)));
    if !has_final {
        errors.push("no final state defined; at least one state must have type: final".into());
    }

    // 3. All transition targets must reference existing states (skip $return)
    for (state_name, state_def) in &definition.states {
        for (event, transition) in &state_def.on {
            let target = transition.target();
            if target != "$return" && !definition.states.contains_key(target) {
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

    // 5. All interrupt targets must reference existing states
    for (int_name, int_def) in &definition.interrupts {
        if !definition.states.contains_key(&int_def.target) {
            errors.push(format!(
                "interrupt '{}' targets nonexistent state '{}'",
                int_name, int_def.target
            ));
        }
    }

    // 6. All fork branch states must exist
    for (state_name, state_def) in &definition.states {
        for (event, transition) in &state_def.on {
            if let Some(fork) = transition.fork_ref() {
                for (branch_name, branch) in &fork.branches {
                    if !definition.states.contains_key(&branch.initial) {
                        errors.push(format!(
                            "state '{}' event '{}' fork branch '{}' initial state '{}' not found",
                            state_name, event, branch_name, branch.initial
                        ));
                    }
                    if !definition.states.contains_key(&branch.terminal) {
                        errors.push(format!(
                            "state '{}' event '{}' fork branch '{}' terminal state '{}' not found",
                            state_name, event, branch_name, branch.terminal
                        ));
                    }
                }
                if let Some(ref on_fail) = fork.on_fail {
                    if !definition.states.contains_key(on_fail) {
                        errors.push(format!(
                            "state '{}' event '{}' fork on_fail state '{}' not found",
                            state_name, event, on_fail
                        ));
                    }
                }
            }
        }
    }

    // 7. All states must be reachable from initial, interrupt targets, or fork branches (BFS)
    if definition.states.contains_key(&definition.initial) {
        let mut visited = BTreeSet::new();
        let mut queue = VecDeque::new();
        queue.push_back(definition.initial.as_str());
        visited.insert(definition.initial.as_str());

        // Interrupt target states are reachable via interrupt trigger
        for int_def in definition.interrupts.values() {
            if definition.states.contains_key(&int_def.target)
                && visited.insert(int_def.target.as_str())
            {
                queue.push_back(int_def.target.as_str());
            }
        }

        // Fork branch states + on_fail are reachable via fork transition
        for state_def in definition.states.values() {
            for transition in state_def.on.values() {
                if let Some(fork) = transition.fork_ref() {
                    for branch in fork.branches.values() {
                        if definition.states.contains_key(&branch.initial)
                            && visited.insert(branch.initial.as_str())
                        {
                            queue.push_back(branch.initial.as_str());
                        }
                        if definition.states.contains_key(&branch.terminal)
                            && visited.insert(branch.terminal.as_str())
                        {
                            queue.push_back(branch.terminal.as_str());
                        }
                    }
                    if let Some(ref on_fail) = fork.on_fail {
                        if definition.states.contains_key(on_fail)
                            && visited.insert(on_fail.as_str())
                        {
                            queue.push_back(on_fail.as_str());
                        }
                    }
                }
            }
        }

        while let Some(state_name) = queue.pop_front() {
            if let Some(state_def) = definition.states.get(state_name) {
                for transition in state_def.on.values() {
                    for target in transition.all_targets() {
                        if target != "$return"
                            && definition.states.contains_key(target)
                            && visited.insert(target)
                        {
                            queue.push_back(target);
                        }
                    }
                }
            }
        }

        for state_name in definition.states.keys() {
            if !visited.contains(state_name.as_str()) {
                errors.push(format!(
                    "state '{}' is unreachable from initial state",
                    state_name
                ));
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

    // --- Interrupt validation tests ---

    #[test]
    fn rejects_interrupt_target_nonexistent() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "bad",
            "initial": "start",
            "states": {
                "start": { "on": { "GO": "end" } },
                "end": { "type": "final" }
            },
            "guards": {},
            "interrupts": {
                "bad_interrupt": {
                    "trigger": { "file_pattern": "**/*.js" },
                    "target": "ghost_state"
                }
            }
        }))
        .unwrap();

        let err = validate_definition(&def).unwrap_err();
        assert!(err.errors.iter().any(|e| e.contains("ghost_state")));
    }

    #[test]
    fn interrupt_target_state_not_flagged_unreachable() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "test",
            "initial": "working",
            "states": {
                "working": { "on": { "DONE": "completed" } },
                "pb_validating": { "on": { "VALIDATED": "$return", "FAIL": "failed" } },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {},
            "interrupts": {
                "pb_check": {
                    "trigger": { "file_pattern": "site/pb/**/*.js" },
                    "target": "pb_validating"
                }
            }
        }))
        .unwrap();

        // pb_validating is only reachable via interrupt — should NOT be flagged as unreachable
        assert!(validate_definition(&def).is_ok());
    }

    #[test]
    fn return_target_not_flagged_as_nonexistent() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "test",
            "initial": "working",
            "states": {
                "working": { "on": { "DONE": "completed" } },
                "pb_validating": { "on": { "VALIDATED": "$return", "FAIL": "failed" } },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {},
            "interrupts": {
                "pb_check": {
                    "trigger": { "file_pattern": "site/pb/**/*.js" },
                    "target": "pb_validating"
                }
            }
        }))
        .unwrap();

        // $return should not trigger "nonexistent state" error
        assert!(validate_definition(&def).is_ok());
    }

    #[test]
    fn accepts_valid_interrupt_workflow() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "tdd-with-pb-check",
            "initial": "implementing",
            "states": {
                "implementing": {
                    "on": { "DONE": "testing", "FAIL": "failed" }
                },
                "testing": {
                    "on": { "PASS": "completed", "FAIL": "implementing" }
                },
                "pb_validating": {
                    "on": { "VALIDATED": "$return", "FAIL": "failed" }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {},
            "interrupts": {
                "pb_check": {
                    "trigger": { "file_pattern": "site/pb/**/*.js" },
                    "target": "pb_validating"
                }
            }
        }))
        .unwrap();

        assert!(validate_definition(&def).is_ok());
    }

    // --- Fork validation tests ---

    #[test]
    fn accepts_valid_fork_workflow() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "pipeline",
            "initial": "building",
            "states": {
                "building": {
                    "on": {
                        "BUILD_DONE": {
                            "fork": {
                                "branches": {
                                    "lint": { "initial": "lint_run", "terminal": "lint_done" },
                                    "types": { "initial": "types_run", "terminal": "types_done" }
                                },
                                "on_complete": "deploying"
                            }
                        }
                    }
                },
                "lint_run": { "on": { "PASS": "lint_done" } },
                "lint_done": { "type": "final" },
                "types_run": { "on": { "PASS": "types_done" } },
                "types_done": { "type": "final" },
                "deploying": { "on": { "DONE": "completed" } },
                "completed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();
        assert!(validate_definition(&def).is_ok());
    }

    #[test]
    fn rejects_fork_with_nonexistent_branch_initial() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "bad",
            "initial": "start",
            "states": {
                "start": {
                    "on": {
                        "GO": {
                            "fork": {
                                "branches": {
                                    "a": { "initial": "ghost", "terminal": "a_done" }
                                },
                                "on_complete": "end"
                            }
                        }
                    }
                },
                "a_done": { "type": "final" },
                "end": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();
        let err = validate_definition(&def).unwrap_err();
        assert!(err.errors.iter().any(|e| e.contains("ghost")));
    }

    #[test]
    fn rejects_fork_with_nonexistent_on_complete() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "bad",
            "initial": "start",
            "states": {
                "start": {
                    "on": {
                        "GO": {
                            "fork": {
                                "branches": {
                                    "a": { "initial": "a_run", "terminal": "a_done" }
                                },
                                "on_complete": "nowhere"
                            }
                        }
                    }
                },
                "a_run": { "on": { "DONE": "a_done" } },
                "a_done": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();
        let err = validate_definition(&def).unwrap_err();
        assert!(err.errors.iter().any(|e| e.contains("nowhere")));
    }

    #[test]
    fn fork_branch_states_not_flagged_unreachable() {
        // Branch states are only reachable via fork — should NOT be flagged
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "pipeline",
            "initial": "building",
            "states": {
                "building": {
                    "on": {
                        "BUILD_DONE": {
                            "fork": {
                                "branches": {
                                    "lint": { "initial": "lint_run", "terminal": "lint_done" }
                                },
                                "on_complete": "done"
                            }
                        }
                    }
                },
                "lint_run": { "on": { "PASS": "lint_done" } },
                "lint_done": { "type": "final" },
                "done": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();
        assert!(validate_definition(&def).is_ok());
    }
}
