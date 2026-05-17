use crate::types::*;
use serde_json::Value;

/// Resolve a transition: given current state + event + context + definition,
/// compute the new state and context.
pub fn resolve_transition(
    current_state: &str,
    event: &str,
    event_data: &Value,
    context: &Value,
    definition: &MachineDefinition,
) -> Result<TransitionResult, TransitionError> {
    let state_def = definition
        .states
        .get(current_state)
        .ok_or_else(|| TransitionError::StateNotFound {
            state: current_state.to_string(),
        })?;

    let transition = match state_def.on.get(event) {
        Some(t) => t,
        None => {
            // Event not recognized — check for safe_next fallback
            if let Some(safe_target) = &state_def.safe_next {
                let new_context = apply_context_patch(context, event_data);
                return Ok(TransitionResult {
                    new_state: safe_target.clone(),
                    new_context,
                    transitioned: true,
                    requires_approval: false,
                    approval_message: None,
                    invoke: None,
                    fork: None,
                });
            }
            return Err(TransitionError::NoMatchingTransition {
                state: current_state.to_string(),
                event: event.to_string(),
            });
        }
    };

    // Handle guarded (conditional) transitions — first matching branch wins
    if let TransitionDef::Guarded(branches) = transition {
        for branch in branches {
            let mut all_pass = true;
            // Check single guard
            if let Some(guard_name) = &branch.guard {
                if let Some(guard_def) = definition.guards.get(guard_name.as_str()) {
                    if !crate::guard::evaluate_guard(guard_def, context) {
                        all_pass = false;
                    }
                }
            }
            // Check guard list
            if all_pass {
                if let Some(guard_names) = &branch.guards {
                    for guard_name in guard_names {
                        if let Some(guard_def) = definition.guards.get(guard_name.as_str()) {
                            if !crate::guard::evaluate_guard(guard_def, context) {
                                all_pass = false;
                                break;
                            }
                        }
                    }
                }
            }
            if all_pass {
                let raw_target = branch.target.clone();
                let new_state = resolve_return_target(&raw_target, context)?;
                let mut new_context = apply_context_patch(context, event_data);
                if raw_target == "$return" {
                    if let Some(obj) = new_context.as_object_mut() {
                        obj.remove("_interrupt_return");
                    }
                }
                return Ok(TransitionResult {
                    new_state,
                    new_context,
                    transitioned: true,
                    requires_approval: false,
                    approval_message: None,
                    invoke: None,
                    fork: None,
                });
            }
        }
        return Err(TransitionError::GuardFailed {
            guard: "no matching branch".to_string(),
        });
    }

    // Evaluate guards for single transitions
    for guard_name in transition.guard_names() {
        if let Some(guard_def) = definition.guards.get(guard_name) {
            if !crate::guard::evaluate_guard(guard_def, context) {
                return Err(TransitionError::GuardFailed {
                    guard: guard_name.to_string(),
                });
            }
        }
    }

    let raw_target = transition.target().to_string();
    let new_state = resolve_return_target(&raw_target, context)?;
    let mut new_context = apply_context_patch(context, event_data);
    if raw_target == "$return" {
        if let Some(obj) = new_context.as_object_mut() {
            obj.remove("_interrupt_return");
        }
    }

    let invoke = transition.invoke_ref().map(|inv| InvokeResult {
        machine: inv.machine.to_string(),
        on_complete: inv.on_complete.to_string(),
        on_fail: inv.on_fail.map(|s| s.to_string()),
        input: inv.input.cloned(),
    });

    let fork = transition.fork_ref().map(|f| ForkResult {
        branches: f.branches.clone(),
        join: f.join.clone(),
        on_complete: f.on_complete.clone(),
        on_fail: f.on_fail.clone(),
    });

    Ok(TransitionResult {
        new_state,
        new_context,
        transitioned: true,
        requires_approval: transition.requires_approval(),
        approval_message: match transition {
            TransitionDef::Full {
                approval_message, ..
            } => approval_message.clone(),
            _ => None,
        },
        invoke,
        fork,
    })
}

/// Resolve `$return` target — looks up `_interrupt_return` in context.
/// Non-`$return` targets pass through unchanged.
fn resolve_return_target(target: &str, context: &Value) -> Result<String, TransitionError> {
    if target == "$return" {
        context
            .get("_interrupt_return")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| TransitionError::InvalidDefinition {
                message: "$return target used but _interrupt_return not set in context".to_string(),
            })
    } else {
        Ok(target.to_string())
    }
}

/// Apply a context patch (shallow merge of patch into context).
pub fn apply_context_patch(context: &Value, patch: &Value) -> Value {
    let Some(ctx_obj) = context.as_object() else {
        return context.clone();
    };

    let Some(patch_obj) = patch.as_object() else {
        return context.clone();
    };

    let mut merged = ctx_obj.clone();
    for (key, value) in patch_obj {
        merged.insert(key.clone(), value.clone());
    }
    Value::Object(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn order_machine() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "order",
            "initial": "draft",
            "context": { "item_count": 0, "items": [] },
            "states": {
                "draft": {
                    "on": {
                        "ADD_ITEM": "draft",
                        "SUBMIT": {
                            "target": "pending_payment",
                            "guards": ["has_items", "has_payment"]
                        },
                        "CANCEL": "cancelled"
                    }
                },
                "pending_payment": {
                    "on": {
                        "CONFIRM_PAYMENT": "confirmed",
                        "CANCEL": "cancelled"
                    }
                },
                "confirmed": {
                    "on": { "SHIP": "shipped" }
                },
                "shipped": {
                    "on": { "DELIVER": "delivered" }
                },
                "delivered": { "type": "final" },
                "cancelled": { "type": "final" }
            },
            "guards": {
                "has_items": { "field": "item_count", "op": "gt", "value": 0 },
                "has_payment": { "field": "payment_method", "op": "exists" }
            }
        }))
        .expect("order machine should parse")
    }

    #[test]
    fn simple_transition_changes_state() {
        let def = order_machine();
        let ctx = json!({"item_count": 0});
        let result = resolve_transition("draft", "CANCEL", &json!({}), &ctx, &def).unwrap();
        assert!(result.transitioned);
        assert_eq!(result.new_state, "cancelled");
    }

    #[test]
    fn guarded_transition_passes_when_guards_satisfied() {
        let def = order_machine();
        let ctx = json!({"item_count": 2, "payment_method": "card_4242"});
        let result = resolve_transition("draft", "SUBMIT", &json!({}), &ctx, &def).unwrap();
        assert!(result.transitioned);
        assert_eq!(result.new_state, "pending_payment");
    }

    #[test]
    fn guarded_transition_fails_when_guard_not_met() {
        let def = order_machine();
        let ctx = json!({"item_count": 0});
        let result = resolve_transition("draft", "SUBMIT", &json!({}), &ctx, &def);
        assert!(result.is_err());
        match result.unwrap_err() {
            TransitionError::GuardFailed { guard } => assert_eq!(guard, "has_items"),
            other => panic!("expected GuardFailed, got {:?}", other),
        }
    }

    #[test]
    fn unhandled_event_returns_error() {
        let def = order_machine();
        let ctx = json!({});
        let result = resolve_transition("draft", "SHIP", &json!({}), &ctx, &def);
        assert!(result.is_err());
        match result.unwrap_err() {
            TransitionError::NoMatchingTransition { state, event } => {
                assert_eq!(state, "draft");
                assert_eq!(event, "SHIP");
            }
            other => panic!("expected NoMatchingTransition, got {:?}", other),
        }
    }

    #[test]
    fn self_transition_stays_in_same_state() {
        let def = order_machine();
        let ctx = json!({"item_count": 0});
        let result = resolve_transition("draft", "ADD_ITEM", &json!({}), &ctx, &def).unwrap();
        assert!(result.transitioned);
        assert_eq!(result.new_state, "draft");
    }

    #[test]
    fn unknown_state_returns_error() {
        let def = order_machine();
        let ctx = json!({});
        let result = resolve_transition("nonexistent", "SUBMIT", &json!({}), &ctx, &def);
        assert!(result.is_err());
        match result.unwrap_err() {
            TransitionError::StateNotFound { state } => assert_eq!(state, "nonexistent"),
            other => panic!("expected StateNotFound, got {:?}", other),
        }
    }

    #[test]
    fn full_lifecycle_draft_to_delivered() {
        let def = order_machine();
        let ctx = json!({"item_count": 2, "payment_method": "card_4242"});

        let r = resolve_transition("draft", "SUBMIT", &json!({}), &ctx, &def).unwrap();
        assert_eq!(r.new_state, "pending_payment");

        let r = resolve_transition("pending_payment", "CONFIRM_PAYMENT", &json!({}), &ctx, &def).unwrap();
        assert_eq!(r.new_state, "confirmed");

        let r = resolve_transition("confirmed", "SHIP", &json!({}), &ctx, &def).unwrap();
        assert_eq!(r.new_state, "shipped");

        let r = resolve_transition("shipped", "DELIVER", &json!({}), &ctx, &def).unwrap();
        assert_eq!(r.new_state, "delivered");
    }

    #[test]
    fn approval_flag_propagated() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "agent",
            "initial": "planning",
            "states": {
                "planning": {
                    "on": {
                        "READY": {
                            "target": "executing",
                            "requires_approval": true,
                            "approval_message": "Agent wants to start executing"
                        }
                    }
                },
                "executing": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        let result = resolve_transition("planning", "READY", &json!({}), &json!({}), &def).unwrap();
        assert!(result.requires_approval);
        assert_eq!(result.approval_message.as_deref(), Some("Agent wants to start executing"));
    }

    // safe_next tests

    #[test]
    fn safe_next_fires_on_unrecognized_event() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "test",
            "initial": "working",
            "states": {
                "working": {
                    "safe_next": "done",
                    "on": { "FINISH": "done", "FAIL": "failed" }
                },
                "done": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        // Model says "COMPLETE" but the event is "FINISH" — safe_next catches it
        let result = resolve_transition("working", "COMPLETE", &json!({}), &json!({}), &def).unwrap();
        assert!(result.transitioned);
        assert_eq!(result.new_state, "done");
    }

    #[test]
    fn safe_next_does_not_override_valid_transitions() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "test",
            "initial": "working",
            "states": {
                "working": {
                    "safe_next": "fallback",
                    "on": { "FINISH": "done", "FAIL": "failed" }
                },
                "done": { "type": "final" },
                "failed": { "type": "final" },
                "fallback": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        // Valid event still works normally — safe_next is not consulted
        let result = resolve_transition("working", "FINISH", &json!({}), &json!({}), &def).unwrap();
        assert_eq!(result.new_state, "done"); // NOT fallback
    }

    #[test]
    fn safe_next_does_not_override_fail() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "test",
            "initial": "working",
            "states": {
                "working": {
                    "safe_next": "done",
                    "on": { "FAIL": "failed" }
                },
                "done": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        // FAIL still works — safe_next doesn't intercept defined events
        let result = resolve_transition("working", "FAIL", &json!({}), &json!({}), &def).unwrap();
        assert_eq!(result.new_state, "failed");
    }

    #[test]
    fn no_safe_next_still_errors_on_unrecognized() {
        let def = order_machine(); // no safe_next defined
        let result = resolve_transition("draft", "GIBBERISH", &json!({}), &json!({}), &def);
        assert!(result.is_err());
    }

    // invoke tests

    #[test]
    fn invoke_transition_returns_invoke_result() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "tdd",
            "initial": "implementing",
            "states": {
                "implementing": {
                    "on": {
                        "DONE": "testing",
                        "FAIL": "failed"
                    }
                },
                "testing": {
                    "on": {
                        "TESTS_PASS": "completed",
                        "TESTS_FAIL": {
                            "invoke": "debug_machine",
                            "on_complete": "testing",
                            "on_fail": "failed",
                            "input": { "scope": "last_change" }
                        }
                    }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        let result = resolve_transition(
            "testing", "TESTS_FAIL", &json!({}), &json!({}), &def,
        ).unwrap();

        assert!(result.transitioned);
        assert_eq!(result.new_state, "testing"); // on_complete target
        let invoke = result.invoke.unwrap();
        assert_eq!(invoke.machine, "debug_machine");
        assert_eq!(invoke.on_complete, "testing");
        assert_eq!(invoke.on_fail.as_deref(), Some("failed"));
        assert_eq!(invoke.input, Some(json!({"scope": "last_change"})));
    }

    #[test]
    fn non_invoke_transition_has_no_invoke() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "test",
            "initial": "a",
            "states": {
                "a": { "on": { "GO": "b" } },
                "b": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        let result = resolve_transition("a", "GO", &json!({}), &json!({}), &def).unwrap();
        assert!(result.invoke.is_none());
    }

    #[test]
    fn invoke_with_no_on_fail_defaults_to_none() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "test",
            "initial": "working",
            "states": {
                "working": {
                    "on": {
                        "DEBUG": {
                            "invoke": "fixer",
                            "on_complete": "working"
                        }
                    }
                },
                "completed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        let result = resolve_transition("working", "DEBUG", &json!({}), &json!({}), &def).unwrap();
        let invoke = result.invoke.unwrap();
        assert_eq!(invoke.machine, "fixer");
        assert!(invoke.on_fail.is_none());
        assert!(invoke.input.is_none());
    }

    // Guarded transition tests

    #[test]
    fn guarded_transition_takes_first_matching_branch() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "scout",
            "initial": "posting",
            "states": {
                "posting": {
                    "on": {
                        "POSTED": [
                            { "guard": "under_limit", "target": "evaluating" },
                            { "guard": "at_limit", "target": "reporting" }
                        ]
                    }
                },
                "evaluating": { "type": "final" },
                "reporting": { "type": "final" }
            },
            "guards": {
                "under_limit": { "field": "post_count", "op": "lt", "value": 5 },
                "at_limit": { "field": "post_count", "op": "gte", "value": 5 }
            }
        }))
        .unwrap();

        // Under limit: should go to evaluating
        let ctx = json!({"post_count": 2});
        let result = resolve_transition("posting", "POSTED", &json!({}), &ctx, &def).unwrap();
        assert_eq!(result.new_state, "evaluating");

        // At limit: should go to reporting
        let ctx = json!({"post_count": 5});
        let result = resolve_transition("posting", "POSTED", &json!({}), &ctx, &def).unwrap();
        assert_eq!(result.new_state, "reporting");
    }

    #[test]
    fn guarded_transition_no_match_returns_error() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "test",
            "initial": "a",
            "states": {
                "a": {
                    "on": {
                        "GO": [
                            { "guard": "never_true", "target": "b" }
                        ]
                    }
                },
                "b": { "type": "final" }
            },
            "guards": {
                "never_true": { "field": "x", "op": "eq", "value": "impossible" }
            }
        }))
        .unwrap();

        let result = resolve_transition("a", "GO", &json!({}), &json!({}), &def);
        assert!(result.is_err());
    }

    // Context patch tests
    #[test]
    fn context_patch_merges_fields() {
        let ctx = json!({"a": 1, "b": 2});
        let patch = json!({"b": 99, "c": 3});
        let result = apply_context_patch(&ctx, &patch);
        assert_eq!(result, json!({"a": 1, "b": 99, "c": 3}));
    }

    #[test]
    fn context_patch_with_empty_patch_returns_clone() {
        let ctx = json!({"a": 1});
        let result = apply_context_patch(&ctx, &json!({}));
        assert_eq!(result, json!({"a": 1}));
    }

    #[test]
    fn context_patch_with_null_patch_returns_clone() {
        let ctx = json!({"a": 1});
        let result = apply_context_patch(&ctx, &Value::Null);
        assert_eq!(result, json!({"a": 1}));
    }

    // $return target tests (History State pattern)

    fn interrupt_machine() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "interrupt-test",
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
        .unwrap()
    }

    #[test]
    fn return_target_resolves_from_context() {
        let def = interrupt_machine();
        let ctx = json!({"_interrupt_return": "implementing"});
        let result = resolve_transition("pb_validating", "VALIDATED", &json!({}), &ctx, &def).unwrap();
        assert!(result.transitioned);
        assert_eq!(result.new_state, "implementing");
    }

    #[test]
    fn return_target_errors_when_not_in_context() {
        let def = interrupt_machine();
        let ctx = json!({}); // no _interrupt_return
        let result = resolve_transition("pb_validating", "VALIDATED", &json!({}), &ctx, &def);
        assert!(result.is_err());
        match result.unwrap_err() {
            TransitionError::InvalidDefinition { message } => {
                assert!(message.contains("$return"));
            }
            other => panic!("expected InvalidDefinition, got {:?}", other),
        }
    }

    #[test]
    fn return_target_cleans_up_context() {
        let def = interrupt_machine();
        let ctx = json!({"_interrupt_return": "implementing", "some_data": "kept"});
        let result = resolve_transition("pb_validating", "VALIDATED", &json!({}), &ctx, &def).unwrap();
        assert_eq!(result.new_state, "implementing");
        // _interrupt_return should be removed from context
        assert!(result.new_context.get("_interrupt_return").is_none());
        // other context preserved
        assert_eq!(result.new_context["some_data"], "kept");
    }

    #[test]
    fn normal_target_ignores_interrupt_return_in_context() {
        let def = interrupt_machine();
        // Even if _interrupt_return is in context, a normal target resolves normally
        let ctx = json!({"_interrupt_return": "implementing"});
        let result = resolve_transition("implementing", "DONE", &json!({}), &ctx, &def).unwrap();
        assert_eq!(result.new_state, "testing"); // NOT "implementing"
    }

    // Fork transition tests

    fn fork_machine() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "ci-pipeline",
            "initial": "building",
            "context": {},
            "states": {
                "building": {
                    "on": {
                        "BUILD_DONE": {
                            "fork": {
                                "branches": {
                                    "lint": { "initial": "lint_run", "terminal": "lint_done" },
                                    "types": { "initial": "types_run", "terminal": "types_done" }
                                },
                                "join": "all",
                                "on_complete": "deploying",
                                "on_fail": "failed"
                            }
                        }
                    }
                },
                "lint_run": { "on": { "PASS": "lint_done", "FAIL": "lint_failed" } },
                "lint_done": { "type": "final" },
                "lint_failed": { "type": "final" },
                "types_run": { "on": { "PASS": "types_done", "FAIL": "types_failed" } },
                "types_done": { "type": "final" },
                "types_failed": { "type": "final" },
                "deploying": { "on": { "DEPLOYED": "completed" } },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap()
    }

    #[test]
    fn fork_def_deserializes() {
        let def = fork_machine();
        let building = def.states.get("building").unwrap();
        let transition = building.on.get("BUILD_DONE").unwrap();
        assert!(transition.is_fork());
        let fork = transition.fork_ref().unwrap();
        assert_eq!(fork.branches.len(), 2);
        assert!(fork.branches.contains_key("lint"));
        assert!(fork.branches.contains_key("types"));
        assert_eq!(fork.on_complete, "deploying");
        assert!(matches!(fork.join, JoinStrategy::All));
    }

    #[test]
    fn fork_target_returns_on_complete() {
        let def = fork_machine();
        let transition = def.states.get("building").unwrap().on.get("BUILD_DONE").unwrap();
        assert_eq!(transition.target(), "deploying");
    }

    #[test]
    fn fork_transition_returns_fork_result() {
        let def = fork_machine();
        let result = resolve_transition("building", "BUILD_DONE", &json!({}), &json!({}), &def).unwrap();
        assert!(result.transitioned);
        assert_eq!(result.new_state, "deploying");
        let fork = result.fork.unwrap();
        assert_eq!(fork.branches.len(), 2);
        assert_eq!(fork.branches["lint"].initial, "lint_run");
        assert_eq!(fork.branches["lint"].terminal, "lint_done");
        assert_eq!(fork.on_complete, "deploying");
    }

    #[test]
    fn fork_join_defaults_to_all() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "test",
            "initial": "start",
            "states": {
                "start": {
                    "on": {
                        "GO": {
                            "fork": {
                                "branches": { "a": { "initial": "a_run", "terminal": "a_done" } },
                                "on_complete": "end"
                            }
                        }
                    }
                },
                "a_run": { "on": { "DONE": "a_done" } },
                "a_done": { "type": "final" },
                "end": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();
        let fork = def.states["start"].on["GO"].fork_ref().unwrap();
        assert!(matches!(fork.join, JoinStrategy::All));
    }

    #[test]
    fn non_fork_transition_has_no_fork() {
        let def = fork_machine();
        let result = resolve_transition("lint_run", "PASS", &json!({}), &json!({}), &def).unwrap();
        assert!(result.fork.is_none());
    }
}
