use serde_json::{Value, json};
use statewright_engine::{MachineDefinition, resolve_transition, validate_definition};

fn workflow() -> MachineDefinition {
    let source = std::env::var("SW_ENGINEERING_FIXTURE").map_or_else(
        |_| include_str!("fixtures/agentic-engineering.json").to_owned(),
        |path| std::fs::read_to_string(path).unwrap(),
    );
    serde_json::from_str(&source).unwrap()
}

fn step(d: &MachineDefinition, state: &mut String, context: &mut Value, event: &str, data: Value) {
    let result = resolve_transition(state, event, &data, context, d).unwrap();
    *state = result.new_state;
    *context = result.new_context;
}

fn start(d: &MachineDefinition, no_change: bool) -> (String, Value) {
    let mut state = d.initial.clone();
    let mut context = d.context.clone();
    step(
        d,
        &mut state,
        &mut context,
        "DIAGNOSED",
        json!({"scope":"fixture"}),
    );
    if no_change {
        step(
            d,
            &mut state,
            &mut context,
            "NO_CHANGE_NEEDED",
            json!({
                "change_required": false, "no_change_evidence": "current behavior meets criterion"
            }),
        );
    } else {
        step(
            d,
            &mut state,
            &mut context,
            "PLAN_READY",
            json!({"baseline":"red"}),
        );
        step(
            d,
            &mut state,
            &mut context,
            "IMPLEMENTED",
            json!({"changed_files":["fixture"]}),
        );
    }
    assert_eq!(state, "validate");
    (state, context)
}

#[test]
fn schema_and_model_portability() {
    let d = workflow();
    validate_definition(&d).unwrap();
    for state in d.states.values() {
        assert!(state.model.is_none());
        assert!(state.model_ladder.is_none());
        assert!(state.env_overrides.is_none());
    }
}

#[test]
fn changed_and_no_change_paths_require_validation_then_review() {
    let d = workflow();
    for no_change in [false, true] {
        let (mut state, mut context) = start(&d, no_change);
        step(
            &d,
            &mut state,
            &mut context,
            "CHECKS_RECORDED",
            json!({
                "validation_status":"passed", "validation_evidence":"fixture check passed"
            }),
        );
        assert_eq!(state, "review");
        step(
            &d,
            &mut state,
            &mut context,
            "APPROVED",
            json!({"review":"no findings"}),
        );
        assert_eq!(state, "handoff");
        step(
            &d,
            &mut state,
            &mut context,
            if no_change {
                "NO_CHANGE_CONFIRMED"
            } else {
                "CHANGE_CONFIRMED"
            },
            json!({}),
        );
        assert_eq!(state, "complete");
    }
}

#[test]
fn missing_failed_or_same_event_validation_cannot_pass_review() {
    let d = workflow();
    for context in [
        json!({}),
        json!({"validation_status":"failed","validation_evidence":"failed"}),
        json!({"validation_status":"passed"}),
        json!({"validation_status":true,"validation_evidence":"check"}),
    ] {
        assert!(
            resolve_transition(
                "review",
                "APPROVED",
                &json!({
                    "validation_status":"passed", "validation_evidence":"same event"
                }),
                &context,
                &d
            )
            .is_err()
        );
    }
}

#[test]
fn false_empty_or_nontext_evidence_cannot_confirm_completion() {
    let d = workflow();
    for evidence in [
        json!(null),
        json!(false),
        json!(true),
        json!(""),
        json!([]),
        json!({}),
        json!(42),
    ] {
        for (state, status, field) in [
            ("review", "validation_status", "validation_evidence"),
            (
                "rereview",
                "repair_validation_status",
                "repair_validation_evidence",
            ),
        ] {
            let mut context = json!({});
            context[status] = json!("passed");
            context[field] = evidence.clone();
            assert!(
                resolve_transition(state, "APPROVED", &json!({}), &context, &d).is_err(),
                "{state} accepted {evidence}"
            );
        }
        assert!(
            resolve_transition(
                "handoff",
                "NO_CHANGE_CONFIRMED",
                &json!({}),
                &json!({"change_required":false,"no_change_evidence":evidence}),
                &d
            )
            .is_err()
        );
    }
}

#[test]
fn no_change_can_be_recorded_at_review_but_not_on_guarded_completion() {
    let d = workflow();
    let mut state = "review".to_owned();
    let mut context =
        json!({"change_required":true,"validation_status":"passed","validation_evidence":"check"});
    step(
        &d,
        &mut state,
        &mut context,
        "APPROVED",
        json!({
            "change_required":false,"no_change_evidence":"already fixed"
        }),
    );
    step(
        &d,
        &mut state,
        &mut context,
        "NO_CHANGE_CONFIRMED",
        json!({}),
    );
    assert_eq!(state, "complete");
    for context in [
        json!({}),
        json!({"change_required":true}),
        json!({"change_required":false}),
        json!({"change_required":"false","no_change_evidence":"check"}),
    ] {
        assert!(
            resolve_transition(
                "handoff",
                "NO_CHANGE_CONFIRMED",
                &json!({
                    "change_required":false,"no_change_evidence":"too late"
                }),
                &context,
                &d
            )
            .is_err()
        );
    }
}

#[test]
fn one_repair_requires_new_validation_not_the_old_receipt() {
    let d = workflow();
    let (mut state, mut context) = start(&d, false);
    step(
        &d,
        &mut state,
        &mut context,
        "CHECKS_RECORDED",
        json!({
            "validation_status":"passed","validation_evidence":"first pass"
        }),
    );
    for event in [
        "REWORK_REQUIRED",
        "REPAIR_PLANNED",
        "REPAIRED",
        "CHECKS_RECORDED",
    ] {
        step(&d, &mut state, &mut context, event, json!({}));
    }
    assert_eq!(state, "rereview");
    assert!(resolve_transition(&state, "APPROVED", &json!({}), &context, &d).is_err());
    context["repair_validation_status"] = json!("passed");
    context["repair_validation_evidence"] = json!("new check");
    step(&d, &mut state, &mut context, "APPROVED", json!({}));
    step(&d, &mut state, &mut context, "CHANGE_CONFIRMED", json!({}));
    assert_eq!(state, "complete");
}

#[test]
fn failed_repair_blocks_and_all_paths_are_finite() {
    let d = workflow();
    fn visit(d: &MachineDefinition, state: &str, path: &mut Vec<String>) -> usize {
        assert!(!path.iter().any(|s| s == state), "cycle through {state}");
        path.push(state.to_owned());
        let depth = d.states[state]
            .on
            .values()
            .flat_map(|t| t.all_targets())
            .map(|next| visit(d, next, path))
            .max()
            .unwrap_or(0);
        path.pop();
        depth + usize::from(!d.states[state].on.is_empty())
    }
    assert_eq!(visit(&d, &d.initial, &mut vec![]), 10);
    for state in ["repair", "revalidate", "rereview"] {
        assert!(
            !d.states[state]
                .on
                .values()
                .any(|t| t.target() == "reconcile")
        );
        let result = resolve_transition(state, "BLOCKED", &json!({}), &json!({}), &d).unwrap();
        assert_eq!(result.new_state, "blocked");
    }
}

#[test]
fn mutation_only_in_implementation_phases_and_unknown_events_do_not_advance() {
    let d = workflow();
    for (name, state) in &d.states {
        if state.on.is_empty() {
            continue;
        }
        let tools = state.allowed_tools.as_ref().unwrap();
        assert_eq!(
            tools.iter().any(|tool| tool == "Write"),
            ["implement", "repair"].contains(&name.as_str())
        );
        let result =
            resolve_transition(name, "UNRECOGNIZED_EVENT_ZZ", &json!({}), &json!({}), &d).unwrap();
        assert_eq!(result.new_state, "blocked");
    }
}
