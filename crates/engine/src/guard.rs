use crate::types::{GuardDef, GuardOp};
use serde_json::Value;

/// Evaluate a guard predicate against a context value.
/// Returns true if the guard condition is satisfied.
pub fn evaluate_guard(guard: &GuardDef, context: &Value) -> bool {
    let field_value = context.get(&guard.field);

    match guard.op {
        GuardOp::Exists => matches!(field_value, Some(v) if !v.is_null()),
        GuardOp::NotExists => matches!(field_value, None | Some(Value::Null)),
        _ => {
            let Some(field_value) = field_value else {
                return false;
            };
            match guard.op {
                GuardOp::Eq => field_value == &guard.value,
                GuardOp::Neq => field_value != &guard.value,
                GuardOp::Gt => compare_numbers(field_value, &guard.value, |a, b| a > b),
                GuardOp::Gte => compare_numbers(field_value, &guard.value, |a, b| a >= b),
                GuardOp::Lt => compare_numbers(field_value, &guard.value, |a, b| a < b),
                GuardOp::Lte => compare_numbers(field_value, &guard.value, |a, b| a <= b),
                GuardOp::In => guard
                    .value
                    .as_array()
                    .is_some_and(|arr| arr.contains(field_value)),
                GuardOp::Contains => {
                    let (Some(haystack), Some(needle)) =
                        (field_value.as_str(), guard.value.as_str())
                    else {
                        return false;
                    };
                    haystack.contains(needle)
                }
                GuardOp::Exists | GuardOp::NotExists => unreachable!(),
            }
        }
    }
}

fn compare_numbers(a: &Value, b: &Value, cmp: fn(f64, f64) -> bool) -> bool {
    let (Some(a), Some(b)) = (a.as_f64(), b.as_f64()) else {
        return false;
    };
    cmp(a, b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn eq_operator_matches() {
        let guard = GuardDef {
            field: "status".into(),
            op: GuardOp::Eq,
            value: json!("draft"),
        };
        assert!(evaluate_guard(&guard, &json!({"status": "draft"})));
    }

    #[test]
    fn eq_operator_rejects_mismatch() {
        let guard = GuardDef {
            field: "status".into(),
            op: GuardOp::Eq,
            value: json!("draft"),
        };
        assert!(!evaluate_guard(&guard, &json!({"status": "confirmed"})));
    }

    #[test]
    fn gt_operator_passes() {
        let guard = GuardDef {
            field: "item_count".into(),
            op: GuardOp::Gt,
            value: json!(0),
        };
        assert!(evaluate_guard(&guard, &json!({"item_count": 3})));
    }

    #[test]
    fn gt_operator_fails_on_equal() {
        let guard = GuardDef {
            field: "item_count".into(),
            op: GuardOp::Gt,
            value: json!(0),
        };
        assert!(!evaluate_guard(&guard, &json!({"item_count": 0})));
    }

    #[test]
    fn exists_operator_passes_when_present() {
        let guard = GuardDef {
            field: "payment_method".into(),
            op: GuardOp::Exists,
            value: json!(null),
        };
        assert!(evaluate_guard(
            &guard,
            &json!({"payment_method": "card_4242"})
        ));
    }

    #[test]
    fn exists_operator_fails_when_null() {
        let guard = GuardDef {
            field: "payment_method".into(),
            op: GuardOp::Exists,
            value: json!(null),
        };
        assert!(!evaluate_guard(&guard, &json!({"payment_method": null})));
    }

    #[test]
    fn exists_operator_fails_when_missing() {
        let guard = GuardDef {
            field: "payment_method".into(),
            op: GuardOp::Exists,
            value: json!(null),
        };
        assert!(!evaluate_guard(&guard, &json!({"other_field": "value"})));
    }

    #[test]
    fn in_operator_matches_value_in_array() {
        let guard = GuardDef {
            field: "region".into(),
            op: GuardOp::In,
            value: json!(["east", "west", "central"]),
        };
        assert!(evaluate_guard(&guard, &json!({"region": "east"})));
    }

    #[test]
    fn in_operator_rejects_value_not_in_array() {
        let guard = GuardDef {
            field: "region".into(),
            op: GuardOp::In,
            value: json!(["east", "west"]),
        };
        assert!(!evaluate_guard(&guard, &json!({"region": "north"})));
    }

    #[test]
    fn neq_operator_passes_on_different() {
        let guard = GuardDef {
            field: "status".into(),
            op: GuardOp::Neq,
            value: json!("cancelled"),
        };
        assert!(evaluate_guard(&guard, &json!({"status": "active"})));
    }

    #[test]
    fn lt_operator_passes() {
        let guard = GuardDef {
            field: "retry_count".into(),
            op: GuardOp::Lt,
            value: json!(3),
        };
        assert!(evaluate_guard(&guard, &json!({"retry_count": 1})));
    }

    #[test]
    fn contains_operator_matches_substring() {
        let guard = GuardDef {
            field: "error".into(),
            op: GuardOp::Contains,
            value: json!("timeout"),
        };
        assert!(evaluate_guard(
            &guard,
            &json!({"error": "connection timeout occurred"})
        ));
    }

    #[test]
    fn missing_field_returns_false_for_comparison() {
        let guard = GuardDef {
            field: "nonexistent".into(),
            op: GuardOp::Gt,
            value: json!(0),
        };
        assert!(!evaluate_guard(&guard, &json!({"other": 5})));
    }
}
