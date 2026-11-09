//! Gateway-owned reusable approval identities. Human grants resolve uncertainty
//! only; every invocation still traverses current admission and policy checks.
use crate::session::GatewaySession;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const DURATIONS: [&str; 5] = ["once", "2h", "4h", "8h", "always"];

pub(crate) fn digest(value: &Value) -> String {
    // serde_json's default map is ordered; explicitly canonicalize nested maps
    // as well so context identity survives rebuilding a workflow HashMap.
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), canonical(v)))
                    .collect::<std::collections::BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
            _ => value.clone(),
        }
    }
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&canonical(value)).expect("JSON value"))
    )
}

pub(crate) fn policy(session: &GatewaySession) -> Value {
    let configured = session
        .definition
        .meta
        .as_ref()
        .and_then(|meta| meta.extra.get("approval_memory"));
    let durations = match configured {
        None => DURATIONS.to_vec(),
        Some(value) => value
            .get("allowed_durations")
            .and_then(Value::as_array)
            .filter(|items| {
                !items.is_empty()
                    && items
                        .iter()
                        .all(|item| item.as_str().is_some_and(|s| DURATIONS.contains(&s)))
            })
            .map(|items| {
                DURATIONS
                    .into_iter()
                    .filter(|duration| *duration == "once" || items.iter().any(|v| v == duration))
                    .collect()
            })
            .unwrap_or_else(|| vec!["once"]),
    };
    json!({"schema":"statewright/approval-memory-policy/v1",
        "policy_sha256":digest(&json!({"contract":1,"definition":session.definition,
            "context":session.context,"environment":std::env::var("STATEWRIGHT_ENV").ok()})),
        "allowed_durations":durations})
}

fn dependency_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| key.as_str() != "collected_at_ms")
                .map(|(key, value)| (key.clone(), dependency_value(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(dependency_value).collect()),
        _ => value.clone(),
    }
}

pub(crate) fn context(
    session: &GatewaySession,
    tool_name: &str,
    input: &Value,
    command_evidence: Option<&Value>,
    references: Option<&Value>,
    source: &str,
    native: bool,
    validated_complete_bounds: bool,
) -> Value {
    let policy = policy(session);
    // A named runner with uncollected or unvalidated source must never become
    // an everlasting grant just because its argv is unchanged. Native web
    // requests carry their complete declarative action data in the invocation.
    let reusable = native
        && ((validated_complete_bounds
            && matches!(
                source,
                "native_command_evidence" | "native_command_list_evidence"
            ))
            || crate::tool_intent::is_native_web_run(tool_name));
    json!({"schema":"statewright/approval-memory-context/v1",
        "policy_sha256":policy["policy_sha256"],"allowed_durations":policy["allowed_durations"],
        "invocation_sha256":digest(&json!([tool_name,input])),
        "dependency_sha256":digest(&dependency_value(&json!([command_evidence,references]))),
        "reusable":reusable,
        "reason":if reusable {"bound_native_evidence"}else{"reusable_dependency_provenance_unavailable"}})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session() -> GatewaySession {
        GatewaySession::new(
            "fixture".into(),
            serde_json::from_value(json!({
            "id":"memory-fixture","initial":"work","states":{"work":{}}}))
            .unwrap(),
        )
    }
    #[test]
    fn memory_identity_survives_collection_time_but_invalidates_changes() {
        let session = session();
        let input = json!({"cmd":"task test","workdir":"/workspace"});
        let evidence = json!({"files":[{"sha256":"original"}],"collected_at_ms":1});
        let original = context(
            &session,
            "exec_command",
            &input,
            Some(&evidence),
            None,
            "native_command_evidence",
            true,
            true,
        );
        let refreshed = json!({"files":[{"sha256":"original"}],"collected_at_ms":2});
        assert_eq!(
            original,
            context(
                &session,
                "exec_command",
                &input,
                Some(&refreshed),
                None,
                "native_command_evidence",
                true,
                true
            )
        );
        let changed = json!({"files":[{"sha256":"changed"}],"collected_at_ms":2});
        assert_ne!(
            original["dependency_sha256"],
            context(
                &session,
                "exec_command",
                &input,
                Some(&changed),
                None,
                "native_command_evidence",
                true,
                true
            )["dependency_sha256"]
        );
        assert_ne!(
            original["invocation_sha256"],
            context(
                &session,
                "exec_command",
                &json!({"cmd":"task other"}),
                Some(&evidence),
                None,
                "native_command_evidence",
                true,
                true
            )["invocation_sha256"]
        );
        assert_eq!(
            context(
                &session,
                "exec_command",
                &input,
                None,
                None,
                "shell",
                true,
                false
            )["reusable"],
            false
        );
        assert_eq!(
            context(
                &session,
                "exec_command",
                &input,
                Some(&evidence),
                None,
                "native_command_evidence",
                false,
                true
            )["reusable"],
            false
        );
        for source in ["native_command_evidence", "native_command_list_evidence"] {
            assert_eq!(
                context(
                    &session,
                    "exec_command",
                    &input,
                    Some(&evidence),
                    None,
                    source,
                    true,
                    false
                )["reusable"],
                false
            );
        }
    }
}
