//! Native ownership tests exercise the real HTTP router with a local authorization fixture.
use super::*;
use axum::body::Body;
use axum::http::Request;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const CHAT_A: &str = "11111111-1111-4111-8111-111111111111";
const CHAT_B: &str = "22222222-2222-4222-8222-222222222222";
const RESOURCE: &str = "https://mcp.statewright.example/mcp";
struct Fixture {
    state: Arc<RemoteState>,
    pb: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.pb.abort();
    }
}
async fn fixture() -> Fixture {
    let app = Router::new().route("/api/gateway/workflows", get(|headers: HeaderMap| async move {
        let key = headers.get("authorization").unwrap().to_str().unwrap();
        if key == "Bearer revoked" { return (StatusCode::UNAUTHORIZED, Json(json!({}))); }
        let principal = if key == "Bearer foreign" { "b".repeat(64) } else { "a".repeat(64) };
        let mut identity = if key == "Bearer legacy" || key == "Bearer missing" { Value::Null } else {
            json!({"version":1,"principal":principal,"client_id":"statewright-claude","resource":RESOURCE})
        };
        match key {
            "Bearer version" => identity["version"] = json!(2),
            "Bearer client" => identity["client_id"] = json!("other"),
            "Bearer resource" => identity["resource"] = json!("https://other.example/mcp"),
            "Bearer principal" => identity["principal"] = json!("not-a-principal"),
            _ => {},
        }
        let owner = if key == "Bearer no-owner" { "" } else if key == "Bearer owner-b" { "owner-b" } else { "owner-a" };
        let mut workflows = json!({"canary":{"id":"canary","initial":"intake","states":{
            "intake":{"on":{"DONE":"complete","REVIEW":{"target":"complete","requires_approval":true}}},
            "complete":{"type":"final"}}},"spare":{"id":"spare","initial":"done","states":{"done":{"type":"final"}}}});
        if key == "Bearer disabled" { workflows["canary"]["meta"] = json!({"enabled":false}); }
        if key == "Bearer changed" { workflows["canary"]["states"]["intake"]["instructions"] = json!("Revised definition"); }
        if key == "Bearer empty" { workflows = json!({}); }
        (StatusCode::OK, Json(json!({"default":"canary","owner_id":owner,"plan_limit":17,
          "native_session":identity, "oauth_client_id": if key == "Bearer legacy" { "" } else { "statewright-claude" },
          "workflows":workflows})))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let pb_url = format!("http://{}", listener.local_addr().unwrap());
    let pb = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Fixture {
        pb,
        state: Arc::new(RemoteState {
            sessions: RwLock::new(HashMap::new()),
            session_managers: RwLock::new(HashMap::new()),
            pb_url,
            public_url: "https://mcp.statewright.example".into(),
            authorization_server_url: "https://statewright.example".into(),
            db_pool: None,
            approval_secret: String::new(),
            classifier_denial_capture: false,
        }),
    }
}
async fn call(f: &Fixture, key: &str, args: Value) -> (StatusCode, Value) {
    rpc(
        f,
        key,
        "tools/call",
        json!({"name":"statewright_native_request","arguments":args}),
    )
    .await
}
async fn rpc(f: &Fixture, key: &str, method: &str, params: Value) -> (StatusCode, Value) {
    let response = build_router(f.state.clone())
        .oneshot(
            Request::post("/mcp")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {key}"))
                .header("mcp-session-id", "foreign_br_fake")
                .body(Body::from(
                    json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn args(chat: &str, operation: &str, input: Value, revision: Option<&str>) -> Value {
    json!({"context":{"version":1,"conversation_id":chat},"operation":operation,"input":input,"expected_revision":revision})
}
fn decoded(response: &Value) -> Value {
    let result = &response["result"];
    assert_ne!(result["isError"], true, "{response}");
    serde_json::from_str(
        result["content"][0]["text"]
            .as_str()
            .expect("native response text"),
    )
    .unwrap()
}

#[tokio::test]
async fn native_chats_are_isolated_and_refresh_keeps_owned_state() {
    let f = fixture().await;
    let initial = decoded(
        &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
            .await
            .1,
    );
    assert!(initial["state"].is_null());
    let revision = initial["revision"].as_str().unwrap();
    let loaded = decoded(
        &call(
            &f,
            "first",
            args(
                CHAT_A,
                "load_workflow",
                json!({"name":"canary"}),
                Some(revision),
            ),
        )
        .await
        .1,
    );
    assert_eq!(loaded["state"]["state"], "intake");
    let refreshed = decoded(
        &call(&f, "rotated", args(CHAT_A, "get_state", json!({}), None))
            .await
            .1,
    );
    assert_eq!(refreshed["state"]["state"], "intake");
    assert_eq!(refreshed["revision"], loaded["revision"]);
    for (key, chat) in [("rotated", CHAT_B), ("foreign", CHAT_A)] {
        assert!(
            decoded(
                &call(&f, key, args(chat, "get_state", json!({}), None))
                    .await
                    .1
            )["state"]
                .is_null()
        );
    }
    assert_eq!(
        call(&f, "revoked", args(CHAT_A, "get_state", json!({}), None))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn native_mutations_require_fresh_revision_and_cannot_reset_an_active_run() {
    let f = fixture().await;
    let initial = decoded(
        &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
            .await
            .1,
    );
    let revision = initial["revision"].as_str().unwrap();
    let load = args(
        CHAT_A,
        "load_workflow",
        json!({"name":"canary"}),
        Some(revision),
    );
    let (a, b) = tokio::join!(call(&f, "first", load.clone()), call(&f, "rotated", load));
    assert_eq!(
        [&a.1, &b.1]
            .iter()
            .filter(|r| r.get("error").is_none())
            .count(),
        1
    );
    let current = decoded(
        &call(&f, "rotated", args(CHAT_A, "get_state", json!({}), None))
            .await
            .1,
    );
    let revision = current["revision"].as_str().unwrap();
    assert!(
        call(
            &f,
            "first",
            args(
                CHAT_A,
                "load_workflow",
                json!({"name":"canary"}),
                Some(revision)
            )
        )
        .await
        .1
        .get("error")
        .is_some()
    );
    let final_state = decoded(
        &call(
            &f,
            "first",
            args(
                CHAT_A,
                "transition",
                json!({"event":"DONE"}),
                Some(revision),
            ),
        )
        .await
        .1,
    );
    assert_eq!(final_state["state"]["state"], "complete");
    assert_eq!(final_state["state"]["transition_count"], 1);
    assert_eq!(final_state["state"]["model_routing"]["enforced"], false);
    assert!(
        call(
            &f,
            "first",
            args(CHAT_A, "deactivate", json!({}), Some(revision))
        )
        .await
        .1
        .get("error")
        .is_some()
    );
    let off = decoded(
        &call(
            &f,
            "first",
            args(
                CHAT_A,
                "deactivate",
                json!({}),
                final_state["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    assert!(off["state"].is_null());
}

#[tokio::test]
async fn native_first_reads_publish_one_session_without_resetting_state() {
    let f = fixture().await;
    let (a, b) = tokio::join!(
        call(&f, "first", args(CHAT_A, "get_state", json!({}), None)),
        call(&f, "rotated", args(CHAT_A, "get_state", json!({}), None))
    );
    assert_eq!(decoded(&a.1)["revision"], decoded(&b.1)["revision"]);
    assert_eq!(f.state.sessions.read().await.len(), 1);
}

#[tokio::test]
async fn native_malformed_and_unsupported_calls_never_create_or_mutate_a_session() {
    let f = fixture().await;
    let good = args(CHAT_A, "get_state", json!({}), None);
    let mut bad_version = good.clone();
    bad_version["context"]["version"] = json!(2);
    let mut bad_context = good.clone();
    bad_context["context"]["principal"] = json!("forged");
    let mut approval = good.clone();
    approval["decision"] = json!("approved");
    for input in [
        bad_version,
        bad_context,
        approval,
        args("not-a-uuid", "get_state", json!({}), None),
        args(
            "00000000-0000-0000-0000-000000000000",
            "get_state",
            json!({}),
            None,
        ),
        args(CHAT_A, "load_workflow", json!({"name":"canary"}), None),
        args(
            CHAT_A,
            "load_workflow",
            json!({"name":"canary","session_id":CHAT_B}),
            Some(CHAT_A),
        ),
        args(
            CHAT_A,
            "load_workflow",
            json!({"name":"canary","resume":true}),
            Some(CHAT_A),
        ),
        args(
            CHAT_A,
            "transition",
            json!({"event":"DONE","data":[]}),
            Some(CHAT_A),
        ),
        args(
            CHAT_A,
            "request_approval",
            json!({"decision":"approved"}),
            None,
        ),
        args(
            CHAT_A,
            "post_tool",
            json!({"tool_response":"fabricated"}),
            None,
        ),
    ] {
        assert!(call(&f, "first", input).await.1.get("error").is_some());
    }
    assert!(call(&f, "legacy", good).await.1.get("error").is_some());
    assert!(f.state.sessions.read().await.is_empty());
}

#[tokio::test]
async fn native_discovery_and_legacy_paths_do_not_share_execution() {
    let f = fixture().await;
    for (key, exposed) in [("first", true), ("legacy", false)] {
        let response = rpc(&f, key, "tools/list", json!({})).await.1;
        assert_eq!(
            response["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == "statewright_native_request"),
            exposed
        );
        let catalog = rpc(
            &f,
            key,
            "tools/call",
            json!({"name":"statewright_list_workflows","arguments":{}}),
        )
        .await
        .1;
        assert_eq!(decoded(&catalog)["native_control"]["version"] == 1, exposed);
    }
    let params = json!({"name":"statewright_load_workflow","arguments":{"name":"canary"}});
    assert!(
        rpc(&f, "first", "tools/call", params.clone())
            .await
            .1
            .get("error")
            .is_some()
    );
    assert!(
        rpc(&f, "legacy", "tools/call", params)
            .await
            .1
            .get("error")
            .is_none()
    );
    assert!(
        decoded(
            &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
                .await
                .1
        )["state"]
            .is_null()
    );
}

#[tokio::test]
async fn native_approval_required_transition_stays_held_without_a_decision_api() {
    let f = fixture().await;
    let initial = decoded(
        &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
            .await
            .1,
    );
    let loaded = decoded(
        &call(
            &f,
            "first",
            args(
                CHAT_A,
                "load_workflow",
                json!({"name":"canary"}),
                initial["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    let waiting = decoded(
        &call(
            &f,
            "first",
            args(
                CHAT_A,
                "transition",
                json!({"event":"REVIEW"}),
                loaded["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    assert_eq!(waiting["state"]["state"], "intake");
    assert!(waiting["state"]["pending_approval"]["approval_id"].is_string());
    assert_eq!(waiting["capabilities"]["human_approval"], false);
    assert!(
        call(
            &f,
            "first",
            args(CHAT_A, "approve", json!({}), waiting["revision"].as_str())
        )
        .await
        .1
        .get("error")
        .is_some()
    );
}

#[tokio::test]
async fn native_invalid_identity_is_not_discoverable_and_never_falls_back() {
    for key in [
        "missing",
        "version",
        "client",
        "resource",
        "principal",
        "no-owner",
    ] {
        let f = fixture().await;
        let listing = rpc(&f, key, "tools/list", json!({})).await.1;
        assert!(
            !listing["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == native::TOOL)
        );
        assert!(
            call(&f, key, args(CHAT_A, "get_state", json!({}), None))
                .await
                .1
                .get("error")
                .is_some()
        );
        assert!(
            rpc(
                &f,
                key,
                "tools/call",
                json!({"name":"statewright_load_workflow","arguments":{"name":"canary"}})
            )
            .await
            .1
            .get("error")
            .is_some()
        );
        assert!(
            f.state
                .sessions
                .read()
                .await
                .keys()
                .all(|key| !key.starts_with("native_"))
        );
    }
}

#[tokio::test]
async fn native_cached_catalog_is_refreshed_before_load() {
    let f = fixture().await;
    let initial = decoded(
        &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
            .await
            .1,
    );
    let unavailable = decoded(
        &call(
            &f,
            "disabled",
            args(
                CHAT_A,
                "load_workflow",
                json!({"name":"canary"}),
                initial["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    assert!(unavailable["state"].is_null());
    assert_eq!(unavailable["outcome"]["isError"], true);
    let changed = decoded(
        &call(
            &f,
            "changed",
            args(
                CHAT_A,
                "load_workflow",
                json!({"name":"canary"}),
                unavailable["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    assert_eq!(changed["state"]["instructions"], "Revised definition");
    assert!(
        decoded(
            &call(&f, "owner-b", args(CHAT_A, "get_state", json!({}), None))
                .await
                .1
        )["state"]
            .is_null()
    );
    let denied = call(
        &f,
        "revoked",
        args(
            CHAT_A,
            "deactivate",
            json!({}),
            changed["revision"].as_str(),
        ),
    )
    .await;
    assert_eq!(denied.0, StatusCode::UNAUTHORIZED);
    assert_eq!(
        decoded(
            &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
                .await
                .1
        )["revision"],
        changed["revision"]
    );
}

async fn held(f: &Fixture) -> Value {
    let initial = decoded(
        &call(f, "first", args(CHAT_A, "get_state", json!({}), None))
            .await
            .1,
    );
    let loaded = decoded(
        &call(
            f,
            "first",
            args(
                CHAT_A,
                "load_workflow",
                json!({"name":"canary"}),
                initial["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    decoded(
        &call(
            f,
            "first",
            args(
                CHAT_A,
                "transition",
                json!({"event":"REVIEW"}),
                loaded["revision"].as_str(),
            ),
        )
        .await
        .1,
    )
}
async fn callback(f: &Fixture, waiting: &Value, secret: &str) -> StatusCode {
    build_router(f.state.clone())
        .oneshot(
            Request::post("/api/approval-callback")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {secret}"))
                .body(Body::from(
                    json!({"approval_id":waiting["state"]["pending_approval"]["approval_id"],
            "instance_id":waiting["state"]["run_session_id"],"status":"approved"})
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn native_callbacks_require_secret_and_invalidate_revision_and_stopped_approvals() {
    let f = fixture().await;
    let waiting = held(&f).await;
    assert_eq!(
        callback(&f, &waiting, "").await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let mut f = fixture().await;
    Arc::get_mut(&mut f.state).unwrap().approval_secret = "fixture-secret".into();
    let waiting = held(&f).await;
    assert_eq!(
        callback(&f, &waiting, "wrong").await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        callback(&f, &waiting, "fixture-secret").await,
        StatusCode::OK
    );
    let approved = decoded(
        &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
            .await
            .1,
    );
    assert_eq!(approved["state"]["state"], "complete");
    assert_ne!(approved["revision"], waiting["revision"]);
    let mut f = fixture().await;
    Arc::get_mut(&mut f.state).unwrap().approval_secret = "fixture-secret".into();
    let waiting = held(&f).await;
    let off = decoded(
        &call(
            &f,
            "first",
            args(
                CHAT_A,
                "deactivate",
                json!({}),
                waiting["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    assert!(off["state"].is_null());
    assert_eq!(
        callback(&f, &waiting, "fixture-secret").await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn native_grants_cannot_open_a_legacy_sse_session() {
    let f = fixture().await;
    let response = build_router(f.state.clone())
        .oneshot(
            Request::get("/sse")
                .header("authorization", "Bearer first")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(f.state.sessions.read().await.is_empty());
}

#[tokio::test]
async fn native_empty_catalog_preserves_reconnect_readback_and_deactivation() {
    let f = fixture().await;
    let waiting = held(&f).await;
    let hello = rpc(&f, "empty", "initialize", json!({})).await;
    assert_eq!(hello.0, StatusCode::OK);
    assert!(hello.1["result"]["serverInfo"].is_object());
    let listing = rpc(&f, "empty", "tools/list", json!({})).await.1;
    assert!(
        listing["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == native::TOOL)
    );
    let still_waiting = decoded(
        &call(&f, "empty", args(CHAT_A, "get_state", json!({}), None))
            .await
            .1,
    );
    assert_eq!(still_waiting["revision"], waiting["revision"]);
    let off = decoded(
        &call(
            &f,
            "empty",
            args(
                CHAT_A,
                "deactivate",
                json!({}),
                waiting["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    assert!(off["state"].is_null());
    let new_chat = decoded(
        &call(&f, "empty", args(CHAT_B, "get_state", json!({}), None))
            .await
            .1,
    );
    assert!(new_chat["state"].is_null());
    let no_load = decoded(
        &call(
            &f,
            "empty",
            args(
                CHAT_B,
                "load_workflow",
                json!({"name":"canary"}),
                new_chat["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    assert!(no_load["state"].is_null());
    assert_eq!(no_load["outcome"]["isError"], true);
    let available = decoded(
        &call(
            &f,
            "first",
            args(
                CHAT_B,
                "load_workflow",
                json!({"name":"canary"}),
                no_load["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    let session_key = available["state"]["run_session_id"].as_str().unwrap();
    let session = f
        .state
        .sessions
        .read()
        .await
        .get(session_key)
        .cloned()
        .unwrap();
    let gateway = &session.lock().await.gateway;
    assert_eq!(
        gateway
            .session_manager
            .get(&gateway.session_id())
            .unwrap()
            .plan_limit,
        Some(17)
    );
}
