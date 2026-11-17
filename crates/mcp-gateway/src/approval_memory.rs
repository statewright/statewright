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
    let durations = match configured.and_then(|value|value.get("allowed_durations")) {
        None => DURATIONS.to_vec(),
        Some(value) => value
            .as_array()
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
            // `approve_for` selects the host picker default, not its cap.
            .unwrap_or_else(|| vec!["once"]),
    };
    let approve_for = configured
        .and_then(|value| value.get("approve_for"))
        .and_then(Value::as_str)
        .filter(|value| DURATIONS.contains(value) && durations.contains(value))
        .unwrap_or("once");
    json!({"schema":"statewright/approval-memory-policy/v1",
        "policy_sha256":digest(&json!({"contract":1,"definition":session.definition,
            "context":session.context,"audit_override":session.classifier_audit_override,
            "audit_revision":session.classifier_audit_revision,"environment":std::env::var("STATEWRIGHT_ENV").ok()})),
        "grant_policy_v2_sha256":digest(&json!({"contract":2,"definition":session.definition,
            "audit_override":session.classifier_audit_override,
            "audit_revision":session.classifier_audit_revision,"environment":std::env::var("STATEWRIGHT_ENV").ok()})),
        "allowed_durations":durations,"approve_for":approve_for})
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

fn exact_native_shell_request(tool_name: &str, input: &Value, source: &str) -> bool {
    use crate::tool_intent::{native_tool_family, NativeToolFamily};
    // This binding represents a human decision about unknown effects, not a
    // claim that those effects were proved. Incomplete runner/source collection
    // remains ineligible: a stable argv must not hide a changing named script.
    if native_tool_family(tool_name) != Some(NativeToolFamily::Command)
        || source != "shell_ast"
        || input.get("environment_id").is_some_and(|v| !v.is_null())
    {
        return false;
    }
    let Some(cwd) = input.get("workdir").or_else(|| input.get("cwd")).and_then(Value::as_str) else {
        return false;
    };
    let bytes = cwd.as_bytes();
    let absolute = cwd.starts_with('/') || cwd.starts_with("\\\\")
        || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'));
    if !absolute || cwd.chars().any(char::is_control) { return false; }
    let Some(command) = input.get("cmd").or_else(|| input.get("command")).and_then(Value::as_str) else {
        return false;
    };
    if command.trim().is_empty() { return false; }
    let parsed = crate::shell_ast_shadow::assess(command);
    if parsed.status != crate::shell_ast_shadow::ParseStatus::Parsed || parsed.executable_nodes == 0 {
        return false;
    }
    // Reuse the collector's runner grammar instead of allowing missing source
    // evidence to turn a named script into an exact-request-only grant.
    crate::shell_ast_shadow::literal_command_units(command).is_some_and(|units| units.iter().all(|unit| {
        crate::bash_classifier::literal_invocation(unit).is_some_and(|invocation|
            !crate::risk_assessment::native_source_runner(&invocation))
    }))
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
    let exact_shell = exact_native_shell_request(tool_name, input, source);
    let reusable = native
        && ((validated_complete_bounds
            && matches!(
                source,
                "native_command_evidence" | "native_command_list_evidence" | "shell_ast"
            ))
            || exact_shell || crate::tool_intent::is_native_web_run(tool_name));
    json!({"schema":"statewright/approval-memory-context/v1",
        "policy_sha256":policy["policy_sha256"],"allowed_durations":policy["allowed_durations"],"approve_for":policy["approve_for"],
        "grant_policy_v2_sha256":policy["grant_policy_v2_sha256"],
        "invocation_sha256":digest(&json!([tool_name,input])),
        "dependency_sha256":digest(&dependency_value(&json!([command_evidence,references]))),
        "reusable":reusable,
        "reason":if reusable && exact_shell {"exact_native_request_with_observed_dependencies"}
            else if reusable {"bound_native_evidence"}else{"reusable_dependency_provenance_unavailable"}})
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
    fn stable_grant_policy_keeps_legacy_snapshot_context_sensitive() {
        let mut session = session();
        let before = policy(&session);
        session.context["progress"] = json!("another step");
        let after = policy(&session);
        assert_ne!(before["policy_sha256"], after["policy_sha256"]);
        assert_eq!(before["grant_policy_v2_sha256"], after["grant_policy_v2_sha256"]);
        session.classifier_audit_revision += 1;
        assert_ne!(after["grant_policy_v2_sha256"], policy(&session)["grant_policy_v2_sha256"]);
    }
    #[test]
    fn native_mcp_canonical_digest_matches_bridge_vector() {
        let value = json!(["mcp__codex_apps__github_fetch_commit",
            {"repo_full_name":"statewright/statewright", "commit_sha":"abc"}]);
        assert_eq!(digest(&value), "7f0d842f4df60dfc4ed2700f613774620f98383e457d0959f2cf320ca3b5076f");
        let ordered = json!(["mcp__x__y", {"2":2,"10":1,"\u{e000}":3,"\u{10000}":4}]);
        assert_eq!(digest(&ordered), "9c039e5819278e9ee85f5acc4632a0a04ffba4e409b58131fb4b11f4526be37a");
    }
    #[test]
    fn policy_propagates_workflow_approval_duration() {
        let mut session = session();
        assert_eq!(policy(&session)["approve_for"], "once");
        session.definition = serde_json::from_value(json!({
            "id":"memory-fixture","initial":"work",
            "meta":{"approval_memory":{"approve_for":"8h","allowed_durations":["once","8h"]}},
            "states":{"work":{}}
        }))
        .unwrap();
        assert_eq!(policy(&session)["approve_for"], "8h");
        assert_eq!(
            context(
                &session,
                "exec_command",
                &json!({"cmd":"test"}),
                None,
                None,
                "native_command_evidence",
                true,
                true
            )["approve_for"],
            "8h"
        );
    }
    #[test]
    fn approve_for_without_cap_offers_all_durations() {
        let mut session = session();
        session.definition = serde_json::from_value(json!({
            "id":"memory-fixture","initial":"work",
            "meta":{"approval_memory":{"approve_for":"4h"}},
            "states":{"work":{}}
        })).unwrap();
        let policy = policy(&session);
        assert_eq!(policy["approve_for"], "4h");
        assert_eq!(policy["allowed_durations"], json!(["once","2h","4h","8h","always"]));
    }
    #[test]
    fn explicit_invalid_cap_fails_closed() {
        for cap in [json!([]),json!(["invalid"]),json!("4h")] {
            let mut session=session();
            session.definition=serde_json::from_value(json!({"id":"memory-fixture","initial":"work",
                "meta":{"approval_memory":{"approve_for":"4h","allowed_durations":cap}},
                "states":{"work":{}}})).unwrap();
            assert_eq!(policy(&session)["allowed_durations"],json!(["once"]));
            assert_eq!(policy(&session)["approve_for"],"once");
        }
    }

    #[test]
    fn complete_native_shell_effects_can_bind_a_reusable_approval() {
        let session = session();
        let input = json!({"cmd":"example --inspect","workdir":"/workspace"});
        let context_for = |source, native, complete| context(
            &session, "exec_command", &input, None, None, source, native, complete);
        assert_eq!(context_for("shell_ast", true, true)["reusable"], true);
        assert_eq!(context_for("shell_ast", true, false)["reusable"], true);
        assert_eq!(context_for("shell_ast", false, true)["reusable"], false);
        assert_eq!(context_for("native_command_evidence_incomplete", true, true)["reusable"], false);
    }
    #[test]
    fn human_memory_can_bind_unknown_effects_but_not_missing_request_or_source_identity() {
        let session = session();
        let check = |tool, input: Value, source, native| context(
            &session, tool, &input, None, None, source, native, false)["reusable"].clone();
        for cwd in ["/workspace", "C:\\workspace", "\\\\host\\share"] {
            assert_eq!(check("exec_command", json!({"cmd":"getconf ARG_MAX","workdir":cwd}), "shell_ast", true), true);
        }
        for input in [json!({"cmd":"getconf ARG_MAX"}),
            json!({"cmd":"getconf ARG_MAX","workdir":"relative"}),
            json!({"cmd":"getconf ARG_MAX","workdir":"/workspace","environment_id":"foreign"}),
            json!({"cmd":"echo '","workdir":"/workspace"}),
            json!({"cmd":"npm run canary","workdir":"/workspace"}),
            json!({"cmd":"task test","workdir":"/workspace"}),
            json!({"cmd":"getconf ARG_MAX && npm run canary","workdir":"/workspace"}),
            json!({"cmd":"","workdir":"/workspace"})] {
            assert_eq!(check("exec_command",input,"shell_ast",true), false);
        }
        let input = json!({"command":"getconf ARG_MAX","cwd":"/workspace"});
        assert_eq!(check("Bash",input.clone(),"shell_ast",true), true);
        assert_eq!(check("Bash",input.clone(),"shell_ast",false), false);
        assert_eq!(check("mcp_foreign",input.clone(),"shell_ast",true), false);
        assert_eq!(check("Bash",input,"native_command_evidence_incomplete",true), false);
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
