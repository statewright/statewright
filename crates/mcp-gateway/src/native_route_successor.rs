//! Read-only continuity evidence for a terminal run after credential renewal.
//! The private native-origin capability is additional to current authentication.
use super::*;

#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Binding {
    thread_id: String,
    root_session_id: String,
    client_id: String,
    run_id: String,
    run_session_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    previous: Binding,
    current: Binding,
}

fn valid_request(body: &Request, client: &str, root: &str) -> bool {
    let previous = &body.previous;
    let current = &body.current;
    let client_suffix = root.split_once("__").map(|(_, suffix)| suffix);
    let previous_suffix = previous.run_session_id.split_once("__");
    let previous_session_valid = previous_suffix.is_some_and(|(prefix, suffix)| {
        client_suffix == Some(suffix)
            && prefix
                .strip_prefix("http_")
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
    });
    !current.thread_id.is_empty()
        && current.thread_id.len() <= 256
        && current.thread_id == current.root_session_id
        && previous.thread_id == current.thread_id
        && previous.root_session_id == current.root_session_id
        && previous.client_id == client
        && current.client_id == client
        && uuid::Uuid::parse_str(&previous.run_id).is_ok()
        && uuid::Uuid::parse_str(&current.run_id).is_ok()
        && previous.run_id != current.run_id
        && current.run_session_id == root
        && previous_session_valid
        && previous.run_session_id != current.run_session_id
}

type Run = (String, String, String, serde_json::Value);

fn verifies_runs(body: &Request, proof_hash: &str, rows: &[Run]) -> bool {
    if rows.len() != 2 {
        return false;
    }
    let previous = rows.iter().find(|row| row.0 == body.previous.run_id);
    let current = rows.iter().find(|row| row.0 == body.current.run_id);
    let (Some(previous), Some(current)) = (previous, current) else {
        return false;
    };
    previous.1 == body.previous.run_session_id
        && current.1 == body.current.run_session_id
        && matches!(
            previous.2.as_str(),
            "completed" | "blocked" | "failed" | "stopped"
        )
        && current.2 == "running"
        && [&previous.3, &current.3].iter().all(|checkpoint| {
            checkpoint["session"]["approval_origin_hash"].as_str() == Some(proof_hash)
        })
        && current.3["session"]["pending_approval"].is_null()
}

pub(super) async fn handle(
    State(state): State<Arc<RemoteState>>,
    headers: HeaderMap,
    Json(body): Json<Request>,
) -> Response {
    if headers.contains_key(header::ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(key) = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(client) = headers
        .get(CLIENT_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|value| !value.is_empty() && value.len() <= 256)
    else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let fingerprint = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, key.as_bytes()).to_string();
    let root = streamable_session_key(&fingerprint, Some(client), None);
    if !valid_request(&body, client, &root) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(proof_hash) = headers
        .get(crate::approval_origin::HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(crate::approval_origin::proof_hash)
    else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let Some(owner) = approval_identity(&state, key, &resource_url(&state, "/mcp")).await else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    #[cfg(feature = "metering")]
    {
        let Some(pool) = &state.db_pool else {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        };
        let rows = sqlx::query_as::<_, Run>(
            "SELECT id, session_id, status, context_snapshot FROM workflow_runs
             WHERE owner=$1 AND (id=$2 OR id=$3)",
        )
        .bind(owner)
        .bind(&body.previous.run_id)
        .bind(&body.current.run_id)
        .fetch_all(pool)
        .await;
        match rows {
            Ok(rows) if verifies_runs(&body, &proof_hash, &rows) => Json(
                serde_json::json!({"schema":"statewright/route-successor/v1",
                    "verified":true,"previous":body.previous,"current":body.current}),
            )
            .into_response(),
            Ok(_) => StatusCode::CONFLICT.into_response(),
            Err(_) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        }
    }
    #[cfg(not(feature = "metering"))]
    {
        let _ = (owner, proof_hash);
        StatusCode::SERVICE_UNAVAILABLE.into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Request, String, Vec<Run>) {
        let old = streamable_session_key(
            &uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, b"old-key").to_string(),
            Some("client"),
            None,
        );
        let root = streamable_session_key(
            &uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, b"new-key").to_string(),
            Some("client"),
            None,
        );
        let previous = Binding {
            thread_id: "thread".into(),
            root_session_id: "thread".into(),
            client_id: "client".into(),
            run_id: uuid::Uuid::new_v4().to_string(),
            run_session_id: old,
        };
        let current = Binding {
            run_id: uuid::Uuid::new_v4().to_string(),
            run_session_id: root.clone(),
            ..previous.clone()
        };
        let checkpoint =
            serde_json::json!({"session":{"approval_origin_hash":"proof","pending_approval":null}});
        let rows = vec![
            (
                previous.run_id.clone(),
                previous.run_session_id.clone(),
                "blocked".into(),
                checkpoint.clone(),
            ),
            (
                current.run_id.clone(),
                root.clone(),
                "running".into(),
                checkpoint,
            ),
        ];
        (Request { previous, current }, root, rows)
    }
    #[test]
    fn credential_renewal_requires_same_native_client_terminal_predecessor_and_origin_proof() {
        let (body, root, rows) = fixture();
        assert!(valid_request(&body, "client", &root));
        assert!(verifies_runs(&body, "proof", &rows));
        assert!(!verifies_runs(&body, "foreign-proof", &rows));
        assert!(!verifies_runs(&body, "proof", &rows[..1]));
        for status in ["running", "paused", "unknown"] {
            let mut changed = rows.clone();
            changed[0].2 = status.into();
            assert!(!verifies_runs(&body, "proof", &changed));
        }
        let mut pending = rows.clone();
        pending[1].3["session"]["pending_approval"] = serde_json::json!({"id":"review"});
        assert!(!verifies_runs(&body, "proof", &pending));
        let mut foreign = rows.clone();
        foreign[0].1 = "foreign".into();
        assert!(!verifies_runs(&body, "proof", &foreign));
    }
    #[test]
    fn foreign_client_root_branch_and_replayed_bindings_are_rejected() {
        let (body, root, _) = fixture();
        assert!(!valid_request(&body, "foreign", &root));
        let mut foreign = Request {
            previous: body.previous.clone(),
            current: body.current.clone(),
        };
        foreign.current.root_session_id = "foreign".into();
        assert!(!valid_request(&foreign, "client", &root));
        foreign.current = body.current.clone();
        foreign.previous.run_session_id.push_str("_br_foreign");
        assert!(!valid_request(&foreign, "client", &root));
        foreign.previous = body.previous.clone();
        foreign.previous.run_id = body.current.run_id.clone();
        assert!(!valid_request(&foreign, "client", &root));
    }
}
