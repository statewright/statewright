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
    approvals: Arc<Mutex<Vec<Value>>>,
    service: Arc<Mutex<Value>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.pb.abort();
    }
}
async fn fixture() -> Fixture {
    let approvals = Arc::new(Mutex::new(Vec::<Value>::new()));
    let service = Arc::new(Mutex::new(json!({"can_decide":true,"status":"pending"})));
    let recorded = approvals.clone();
    let settings = service.clone();
    let app = Router::new().route("/api/internal/human-approval", post(move |headers: HeaderMap, Json(body): Json<Value>| {
        let recorded = recorded.clone(); let settings = settings.clone();
        async move {
            assert_eq!(headers["authorization"], "Bearer fixture-secret");
            recorded.lock().await.push(body.clone());
            let mut settings = settings.lock().await;
            if settings["can_decide"] == true && body["decision"].is_string() && settings["status"] == "pending" {
                settings["status"] = body["decision"].clone();
                if settings["lose_decision_response"] == true { return (StatusCode::BAD_GATEWAY, Json(json!({}))); }
            }
            let receipt = json!({"approval_id":body["approval_id"],"run_id":body["run_id"],"instance_id":body["instance_id"],
              "from_state":body["pending"]["from_state"],"to_state":body["pending"]["to_state"],
              "context_snapshot":body["pending"]["context_snapshot"],"status":settings["status"],"can_decide":settings["can_decide"]});
            (StatusCode::OK, Json(receipt))
        }
    })).route("/api/gateway/workflows", get(|headers: HeaderMap| async move {
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
            "intake":{"allowed_tools":["Read"],"on":{"DONE":"complete","REVIEW":{"target":"complete","requires_approval":true}}},
            "complete":{"type":"final"}}},"spare":{"id":"spare","initial":"done","states":{"done":{"type":"final"}}}});
        if key == "Bearer disabled" { workflows["canary"]["meta"] = json!({"enabled":false}); }
        if key == "Bearer changed" { workflows["canary"]["states"]["intake"]["instructions"] = json!("Revised definition"); }
        if key == "Bearer web" { workflows["canary"]["states"]["intake"]["allowed_tools"] = json!(["Read", "WebFetch", "WebSearch"]); }
        if key == "Bearer empty" { workflows = json!({}); }
        if key.starts_with("Bearer engineering") {
            let mut definition = workflows["canary"].clone();
            definition["id"] = json!("agentic-engineering");
            workflows["agentic-engineering"] = definition.clone();
            if key != "Bearer engineering" {
                definition["id"] = json!("engineering");
                definition["meta"] = json!({"enabled":key != "Bearer engineering-disabled"});
                workflows["engineering"] = definition;
            }
        }
        let telemetry = match key {
            "Bearer telemetry-allow" => json!({"version":2,"enabled":true,"updated_at":"2026-10-14T12:00:00.000Z"}),
            "Bearer telemetry-deny" => json!({"version":2,"enabled":false,"updated_at":"2026-10-14T12:00:01.000Z"}),
            "Bearer telemetry-invalid" => json!({"version":2,"enabled":true,"updated_at":"invalid"}),
            _ => Value::Null,
        };
        (StatusCode::OK, Json(json!({"default":"canary","owner_id":owner,"plan_limit":17,"telemetry_consent":telemetry,
          "native_session":identity, "oauth_client_id": if key == "Bearer legacy" { "" } else { "statewright-claude" },
          "workflows":workflows})))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let pb_url = format!("http://{}", listener.local_addr().unwrap());
    let pb = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Fixture {
        pb,
        approvals,
        service,
        state: Arc::new(RemoteState {
            native_approvals: Mutex::new(native_approval::Broker::default()),
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

fn action_outcome(snapshot: &Value) -> Value {
    assert_ne!(snapshot["outcome"]["isError"], true, "{snapshot}");
    serde_json::from_str(snapshot["outcome"]["content"][0]["text"].as_str().unwrap()).unwrap()
}

fn connect_args(chat: &str) -> Value {
    json!({"context":{"version":1,"conversation_id":chat}})
}

#[tokio::test]
async fn native_consent_transport_preserves_current_withdrawal_without_changing_workflow() {
    let f = fixture().await;
    let catalog = decoded(&rpc(&f, "telemetry-allow", "tools/call", json!({"name":"statewright_list_workflows","arguments":{}})).await.1);
    assert_eq!(catalog["telemetry_consent"]["enabled"], true);
    let initial = decoded(&connect(&f, "telemetry-allow", connect_args(CHAT_A)).await.1);
    assert_eq!(initial["snapshot"]["telemetry_consent"]["enabled"], true);
    let revision = initial["snapshot"]["revision"].clone();
    for (key, expected) in [("telemetry-deny", json!(false)), ("telemetry-allow", json!(false)),
        ("telemetry-invalid", Value::Null), ("telemetry-allow", Value::Null)] {
        let receipt = decoded(&call(&f, key, args(CHAT_A, "get_state", json!({}), None)).await.1);
        assert_eq!(receipt["telemetry_consent"]["enabled"], expected);
        assert_eq!(receipt["revision"], revision);
    }
}

#[test]
fn optional_telemetry_metadata_is_closed_and_cannot_break_workflow_loading() {
    let grant = json!({"version":2,"enabled":true,"updated_at":"2026-10-14T12:00:00.000Z"});
    assert!(decode_telemetry_consent(Some(grant.clone())).unwrap().enabled);
    for invalid in [json!(null), json!({"version":1,"enabled":true}), json!({"version":2,"enabled":true,"updated_at":"invalid"}),
        json!({"version":2,"enabled":true,"updated_at":"2026-10-14T12:00:00.000Z","secret":"private"})] {
        assert!(decode_telemetry_consent(Some(invalid)).is_none());
    }
    let mut current = decode_telemetry_consent(Some(grant.clone()));
    let mut watermark = current.clone();
    let mut declined = grant.clone(); declined["enabled"] = json!(false); declined["updated_at"] = json!("2026-10-14T12:00:01.000Z");
    observe_telemetry_consent(&mut current, &mut watermark, decode_telemetry_consent(Some(declined)));
    assert!(!current.as_ref().unwrap().enabled);
    observe_telemetry_consent(&mut current, &mut watermark, decode_telemetry_consent(Some(grant.clone())));
    assert!(!current.as_ref().unwrap().enabled);
    observe_telemetry_consent(&mut current, &mut watermark, None);
    assert!(current.is_none());
    observe_telemetry_consent(&mut current, &mut watermark, decode_telemetry_consent(Some(grant)));
    assert!(current.is_none(), "unknown must preserve withdrawal watermark");
}

#[tokio::test]
async fn engineering_alias_native_load_continues_exact_run_and_revision() {
    let f = fixture().await;
    let initial = decoded(&connect(&f, "engineering", connect_args(CHAT_A)).await.1);
    assert_eq!(
        initial["snapshot"]["workflow_aliases"]["engineering"],
        "agentic-engineering"
    );
    assert!(
        !initial["workflows"]
            .as_array()
            .unwrap()
            .contains(&json!("engineering"))
    );
    let loaded = decoded(
        &call(
            &f,
            "engineering",
            args(
                CHAT_A,
                "load_workflow",
                json!({"name":"engineering"}),
                initial["snapshot"]["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    assert_eq!(loaded["state"]["workflow"], "agentic-engineering");
    assert_eq!(action_outcome(&loaded)["loaded"], "agentic-engineering");
    for name in ["agentic-engineering", "engineering"] {
        let duplicate = call(
            &f,
            "engineering",
            args(
                CHAT_A,
                "load_workflow",
                json!({"name":name}),
                loaded["revision"].as_str(),
            ),
        )
        .await
        .1;
        assert!(
            duplicate["error"]["message"]
                .as_str()
                .unwrap()
                .contains("already active")
        );
        let same = decoded(
            &call(
                &f,
                "engineering",
                args(CHAT_A, "get_state", json!({}), None),
            )
            .await
            .1,
        );
        assert_eq!(same["state"], loaded["state"]);
        assert_eq!(same["revision"], loaded["revision"]);
        assert!(same["outcome"].is_null());
    }
    // Reconnect/refresh with a newly present exact name must not reinterpret it
    // as the active canonical workflow, including when the new entry is disabled.
    for key in ["engineering-exact", "engineering-disabled"] {
        let conflict = call(
            &f,
            key,
            args(
                CHAT_A,
                "load_workflow",
                json!({"name":"engineering"}),
                loaded["revision"].as_str(),
            ),
        )
        .await
        .1;
        assert!(
            conflict["error"]["message"]
                .as_str()
                .unwrap()
                .contains("already active")
        );
        let current = decoded(
            &call(&f, key, args(CHAT_A, "get_state", json!({}), None))
                .await
                .1,
        );
        assert_eq!(current["state"], loaded["state"]);
        assert_eq!(current["revision"], loaded["revision"]);
        assert_eq!(current["workflow_aliases"], json!({}));
    }
}

#[tokio::test]
async fn engineering_alias_native_disabled_exact_entry_never_falls_back() {
    let f = fixture().await;
    let initial = decoded(
        &connect(&f, "engineering-disabled", connect_args(CHAT_A))
            .await
            .1,
    );
    assert_eq!(initial["snapshot"]["workflow_aliases"], json!({}));
    assert!(
        !initial["workflows"]
            .as_array()
            .unwrap()
            .contains(&json!("engineering"))
    );
    let denied = decoded(
        &call(
            &f,
            "engineering-disabled",
            args(
                CHAT_A,
                "load_workflow",
                json!({"name":"engineering"}),
                initial["snapshot"]["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    assert_eq!(denied["outcome"]["isError"], true);
    assert!(denied["state"].is_null());
}

#[tokio::test]
async fn native_http_discovery_then_web_fetch_can_complete_without_semantic_authorization() {
    let f = fixture().await;
    let before = decoded(&connect(&f, "web", connect_args(CHAT_A)).await.1);
    let mut state = decoded(
        &call(
            &f,
            "web",
            args(
                CHAT_A,
                "load_workflow",
                json!({"name":"canary"}),
                before["snapshot"]["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    for (tool, input) in [
        (
            "ToolSearch",
            json!({"query":"select:WebFetch","max_results":1}),
        ),
        (
            "WebFetch",
            json!({"url":"https://example.com","prompt":"Summarize"}),
        ),
    ] {
        state = decoded(
            &call(
                &f,
                "web",
                args(
                    CHAT_A,
                    "pre_tool",
                    json!({"tool_name":tool,"tool_input":input}),
                    state["revision"].as_str(),
                ),
            )
            .await
            .1,
        );
        assert_eq!(action_outcome(&state)["decision"], "allow", "{state}");
        state = decoded(&call(&f, "web", args(CHAT_A, "post_tool", json!({"tool_name":tool,"tool_input":input,"tool_response":"fixture result","is_error":false}), state["revision"].as_str())).await.1);
    }
    state = decoded(
        &call(
            &f,
            "web",
            args(
                CHAT_A,
                "transition",
                json!({"event":"DONE"}),
                state["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    assert_eq!(state["state"]["state"], "complete");
    assert_eq!(state["state"]["is_final"], true);
    assert!(f.approvals.lock().await.is_empty());
}

async fn connect(f: &Fixture, key: &str, arguments: Value) -> (StatusCode, Value) {
    rpc(
        f,
        key,
        "tools/call",
        json!({"name":native::CONNECT_TOOL,"arguments":arguments}),
    )
    .await
}

#[tokio::test]
async fn native_connect_discovery_requires_valid_identity_and_only_connect_requests_interaction() {
    for key in [
        "first",
        "empty",
        "legacy",
        "missing",
        "version",
        "client",
        "resource",
        "principal",
        "no-owner",
    ] {
        let f = fixture().await;
        let listing = rpc(&f, key, "tools/list", json!({})).await.1;
        let tools = listing["result"]["tools"].as_array().unwrap();
        let connection = tools
            .iter()
            .find(|tool| tool["name"] == native::CONNECT_TOOL);
        let valid = matches!(key, "first" | "empty");
        assert_eq!(connection.is_some(), valid, "{key}");
        if let Some(connection) = connection {
            assert_eq!(
                connection["_meta"]["anthropic/requiresUserInteraction"],
                true
            );
            assert_eq!(connection["annotations"]["readOnlyHint"], true);
            assert_eq!(connection["inputSchema"]["additionalProperties"], false);
            assert_eq!(connection["inputSchema"]["required"], json!(["context"]));
        }
        assert!(
            tools
                .iter()
                .filter(|tool| tool["name"] != native::CONNECT_TOOL)
                .all(|tool| tool["_meta"]["anthropic/requiresUserInteraction"].is_null())
        );
        if !valid {
            assert!(
                connect(&f, key, connect_args(CHAT_A)).await.1["error"].is_object(),
                "{key}"
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
    let f = fixture().await;
    assert_eq!(
        connect(&f, "revoked", connect_args(CHAT_A)).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert!(f.state.sessions.read().await.is_empty());
}

#[tokio::test]
async fn native_connect_strict_input_cannot_mutate_or_decide() {
    let f = fixture().await;
    for arguments in [
        Value::Null,
        json!({}),
        json!({"context":{}}),
        json!({"context":{"version":2,"conversation_id":CHAT_A}}),
        json!({"context":{"version":1,"conversation_id":"not-a-uuid"}}),
        json!({"context":{"version":1,"conversation_id":"00000000-0000-0000-0000-000000000000"}}),
        json!({"context":{"version":1,"conversation_id":CHAT_A,"approved":true}}),
        json!({"context":{"version":1,"conversation_id":CHAT_A},"decision":"approved"}),
        json!({"context":{"version":1,"conversation_id":CHAT_A},"operation":"request_approval"}),
        json!({"context":{"version":1,"conversation_id":CHAT_A},"input":{"name":"canary"}}),
        json!({"context":{"version":1,"conversation_id":CHAT_A},"expected_revision":"grant"}),
    ] {
        assert!(
            connect(&f, "first", arguments.clone()).await.1["error"].is_object(),
            "{arguments}"
        );
    }
    let transport = initialize(&f, "first", json!({})).await;
    for id in [None, Some(Value::Null)] {
        let mut request = json!({"jsonrpc":"2.0","method":"tools/call","params":{"name":native::CONNECT_TOOL,"arguments":connect_args(CHAT_A)}});
        if let Some(id) = id {
            request["id"] = id;
        }
        let response = wire(&f, "first", &transport, request).await;
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(body["error"].is_object());
    }
    assert!(f.state.sessions.read().await.is_empty());
    assert!(f.approvals.lock().await.is_empty());
}

#[tokio::test]
async fn native_connect_reads_catalog_and_snapshot_without_starting_or_changing_workflows() {
    let f = fixture().await;
    let connected = decoded(&connect(&f, "first", connect_args(CHAT_A)).await.1);
    assert_eq!(connected["protocol_version"], 1);
    assert_eq!(connected["conversation_id"], CHAT_A);
    assert_eq!(connected["workflows"], json!(["canary", "spare"]));
    assert!(connected["snapshot"]["state"].is_null());
    let before = decoded(
        &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
            .await
            .1,
    );
    assert_eq!(connected["snapshot"], before);
    let active = decoded(
        &call(
            &f,
            "first",
            args(
                CHAT_A,
                "load_workflow",
                json!({"name":"canary"}),
                before["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    let connected = decoded(&connect(&f, "rotated", connect_args(CHAT_A)).await.1);
    let after = decoded(
        &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
            .await
            .1,
    );
    assert_eq!(connected["snapshot"], after);
    assert_eq!(after["revision"], active["revision"]);
    assert_eq!(after["state"], active["state"]);
    assert!(after["outcome"].is_null());
    let denied = decoded(
        &call(
            &f,
            "first",
            args(
                CHAT_A,
                "pre_tool",
                json!({"tool_name":"Write","tool_input":{"file_path":"no.txt","content":"no"}}),
                after["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    assert_eq!(action_outcome(&denied)["decision"], "deny");
    assert!(f.approvals.lock().await.is_empty());
}

#[tokio::test]
async fn native_connect_preserves_pending_approval_and_empty_catalog() {
    let f = fixture().await;
    let waiting = held(&f).await;
    let connected = decoded(&connect(&f, "empty", connect_args(CHAT_A)).await.1);
    assert_eq!(connected["workflows"], json!([]));
    assert_eq!(connected["snapshot"]["revision"], waiting["revision"]);
    assert_eq!(connected["snapshot"]["state"], waiting["state"]);
    assert!(connected["snapshot"]["outcome"].is_null());
    let empty = decoded(&connect(&f, "empty", connect_args(CHAT_B)).await.1);
    assert_eq!(empty["workflows"], json!([]));
    assert!(empty["snapshot"]["state"].is_null());
    assert!(f.approvals.lock().await.is_empty());
}

#[tokio::test]
async fn native_connect_does_not_cross_conversations_principals_or_transports() {
    let f = fixture().await;
    let active = held(&f).await;
    for (key, chat) in [("first", CHAT_B), ("foreign", CHAT_A), ("owner-b", CHAT_A)] {
        let connected = decoded(&connect(&f, key, connect_args(chat)).await.1);
        assert!(connected["snapshot"]["state"].is_null());
        assert_ne!(connected["snapshot"]["revision"], active["revision"]);
    }
    let transport = initialize(&f, "first", json!({"elicitation":{}})).await;
    let read = json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":native::CONNECT_TOOL,"arguments":connect_args(CHAT_A)}});
    assert_eq!(
        wire(&f, "foreign", &transport, read.clone()).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        wire(&f, "first", "unknown", read.clone()).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        wire(&f, "rotated", &transport, read).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        connect(&f, "revoked", connect_args(CHAT_A)).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn native_tools_reuse_existing_pre_post_and_stop_handlers() {
    let f = fixture().await;
    let mut state = decoded(
        &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
            .await
            .1,
    );
    state = decoded(
        &call(
            &f,
            "first",
            args(
                CHAT_A,
                "load_workflow",
                json!({"name":"canary"}),
                state["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    assert_eq!(state["enforcement_scope"], "native_pre_permission_hooks");
    for (operation, input, expected) in [
        (
            "pre_tool",
            json!({"tool_name":"Read","tool_input":{"file_path":"allowed.txt"}}),
            "allow",
        ),
        (
            "pre_tool",
            json!({"tool_name":"Write","tool_input":{"file_path":"no.txt","content":"no"}}),
            "deny",
        ),
        ("stop", json!({}), "block"),
    ] {
        let before = state["revision"].clone();
        state = decoded(
            &call(
                &f,
                "first",
                args(CHAT_A, operation, input.clone(), before.as_str()),
            )
            .await
            .1,
        );
        assert_eq!(action_outcome(&state)["decision"], expected);
        assert_ne!(state["revision"], before);
        assert!(
            call(&f, "first", args(CHAT_A, operation, input, before.as_str()))
                .await
                .1["error"]
                .is_object()
        );
    }
    // The old post-tool business logic still counts failed attempts, but never
    // fabricates read/edit evidence from them. Its unit suite checks annotations.
    for failed in [true, false] {
        state = decoded(&call(&f, "first", args(CHAT_A, "post_tool", json!({"tool_name":"Read","tool_input":{"file_path":"allowed.txt"},"tool_response":"fixture","is_error":failed}), state["revision"].as_str())).await.1);
        assert_eq!(action_outcome(&state)["active"], true);
        assert_eq!(
            action_outcome(&state)["iteration"],
            if failed { 1 } else { 2 }
        );
    }
    for (operation, input) in [
        (
            "post_tool",
            json!({"tool_name":"Read","tool_input":{},"tool_response":"missing failed flag"}),
        ),
        (
            "pre_tool",
            json!({"tool_name":"Read","tool_input":{},"approved":true}),
        ),
        (
            "pre_tool",
            json!({"tool_name":"statewright_transition","tool_input":{}}),
        ),
        ("stop", json!({"approved":true})),
    ] {
        assert!(
            call(
                &f,
                "first",
                args(CHAT_A, operation, input, state["revision"].as_str())
            )
            .await
            .1["error"]
                .is_object()
        );
    }
    state = decoded(
        &call(
            &f,
            "first",
            args(CHAT_A, "deactivate", json!({}), state["revision"].as_str()),
        )
        .await
        .1,
    );
    state = decoded(
        &call(
            &f,
            "first",
            args(CHAT_A, "stop", json!({}), state["revision"].as_str()),
        )
        .await
        .1,
    );
    assert_eq!(action_outcome(&state)["decision"], "allow");
    assert_eq!(action_outcome(&state)["active"], false);
}

#[tokio::test]
async fn native_approval_transport_is_random_and_negotiates_form_protocol() {
    let f = fixture().await;
    let mut transports = Vec::new();
    for _ in 0..2 {
        let response = build_router(f.state.clone())
            .oneshot(
                Request::post("/mcp")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer first")
                    .body(Body::from(
                        json!({"jsonrpc":"2.0","id":1,"method":"initialize",
              "params":{"protocolVersion":"2025-06-18","capabilities":{"elicitation":{}}}})
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        transports.push(
            response.headers()["mcp-session-id"]
                .to_str()
                .unwrap()
                .to_string(),
        );
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(body["result"]["protocolVersion"], "2025-06-18");
    }
    assert_ne!(transports[0], transports[1]);
}

async fn wire(f: &Fixture, key: &str, transport: &str, message: Value) -> Response {
    build_router(f.state.clone())
        .oneshot(
            Request::post("/mcp")
                .header("content-type", "application/json")
                .header("accept", "application/json, text/event-stream")
                .header("authorization", format!("Bearer {key}"))
                .header("mcp-session-id", transport)
                .header("mcp-protocol-version", "2025-06-18")
                .body(Body::from(message.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn initialize(f: &Fixture, key: &str, capabilities: Value) -> String {
    let r = wire(
        f,
        key,
        "",
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":capabilities}}),
    )
    .await;
    assert_eq!(r.status(), StatusCode::OK);
    r.headers()["mcp-session-id"].to_str().unwrap().to_string()
}
async fn waiting() -> (Fixture, Value) {
    let mut f = fixture().await;
    Arc::get_mut(&mut f.state).unwrap().approval_secret = "fixture-secret".into();
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
    // Memory fixture only: production obtains this run identity from durable storage.
    let session = f
        .state
        .sessions
        .read()
        .await
        .values()
        .next()
        .unwrap()
        .clone();
    session
        .lock()
        .await
        .gateway
        .seed_native_usage_run("native-fixture-run", "intake");
    let state = decoded(
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
    assert!(state["state"]["pending_approval"].is_object());
    (f, state)
}
fn approval_request(state: &Value) -> Value {
    json!({"jsonrpc":"2.0","id":"approval-call","method":"tools/call","params":{"name":native::TOOL,
      "arguments":args(CHAT_A, "request_approval", json!({"run_id":state["state"]["run_id"],"approval_id":state["state"]["pending_approval"]["approval_id"]}), state["revision"].as_str())}})
}
async fn next_event(body: &mut Body) -> Value {
    let frame = tokio::time::timeout(std::time::Duration::from_secs(3), body.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let bytes = frame.into_data().unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();
    let data = text
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .expect(text);
    serde_json::from_str(data).unwrap()
}
async fn prompt(f: &Fixture, state: &Value, transport: &str) -> (Body, Value) {
    let response = wire(f, "first", transport, approval_request(state)).await;
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let mut body = response.into_body();
    let event = next_event(&mut body).await;
    assert_eq!(event["method"], "elicitation/create");
    (body, event)
}

#[tokio::test]
async fn native_approval_accept_decline_cancel_and_malformed_are_distinct() {
    for (answer, expected, target) in [
        (
            json!({"action":"accept","content":{"decision":"approve"}}),
            "approved",
            "complete",
        ),
        (
            json!({"action":"accept","content":{"decision":"reject"}}),
            "rejected",
            "intake",
        ),
        (json!({"action":"decline"}), "rejected", "intake"),
        (json!({"action":"cancel"}), "cancelled", "intake"),
        (
            json!({"action":"accept","content":{"decision":"approve","injected":true}}),
            "invalid_reply",
            "intake",
        ),
    ] {
        let (f, state) = waiting().await;
        let transport = initialize(&f, "first", json!({"elicitation":{}})).await;
        let (mut body, event) = prompt(&f, &state, &transport).await;
        let reply = wire(
            &f,
            "rotated",
            &transport,
            json!({"jsonrpc":"2.0","id":event["id"],"result":answer}),
        )
        .await;
        assert_eq!(reply.status(), StatusCode::ACCEPTED);
        assert!(
            reply
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .is_empty()
        );
        let result = decoded(&next_event(&mut body).await);
        assert_eq!(
            decoded(&json!({"result":result["outcome"]}))["approval_status"],
            expected
        );
        assert_eq!(result["state"]["state"], target);
        let submitted = f
            .approvals
            .lock()
            .await
            .iter()
            .filter(|v| v["decision"].is_string())
            .count();
        assert_eq!(
            submitted,
            usize::from(["approved", "rejected"].contains(&expected))
        );
        if submitted == 0 {
            assert!(result["state"]["pending_approval"].is_object());
        }
        assert_ne!(result["revision"], state["revision"]);
    }
}

#[tokio::test]
async fn native_approval_rejects_foreign_replayed_and_forged_decisions() {
    let (f, state) = waiting().await;
    let transport = initialize(&f, "first", json!({"elicitation":{}})).await;
    let other = initialize(&f, "first", json!({"elicitation":{}})).await;
    let mut forged = approval_request(&state);
    forged["params"]["arguments"]["input"]["decision"] = json!("approved");
    let bytes = wire(&f, "first", &transport, forged)
        .await
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    assert!(serde_json::from_slice::<Value>(&bytes).unwrap()["error"].is_object());
    assert!(f.approvals.lock().await.is_empty());
    let (mut body, event) = prompt(&f, &state, &transport).await;
    let answer = json!({"jsonrpc":"2.0","id":event["id"],"result":{"action":"accept","content":{"decision":"approve"}}});
    for (key, t, expected) in [
        ("foreign", transport.as_str(), StatusCode::NOT_FOUND),
        ("revoked", &transport, StatusCode::UNAUTHORIZED),
        ("first", &other, StatusCode::FORBIDDEN),
    ] {
        assert_eq!(wire(&f, key, t, answer.clone()).await.status(), expected);
    }
    assert_eq!(
        wire(&f, "rotated", &transport, answer.clone())
            .await
            .status(),
        StatusCode::ACCEPTED
    );
    assert_eq!(
        wire(&f, "first", &transport, answer).await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        decoded(&next_event(&mut body).await)["state"]["state"],
        "complete"
    );
    assert_eq!(f.approvals.lock().await.len(), 2);
}

#[tokio::test]
async fn native_approval_off_and_rpc_cancel_never_approve() {
    for off in [false, true] {
        let (f, state) = waiting().await;
        let transport = initialize(&f, "first", json!({"elicitation":{}})).await;
        let (mut body, event) = prompt(&f, &state, &transport).await;
        let current = decoded(
            &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
                .await
                .1,
        );
        if off {
            let stopped = decoded(
                &call(
                    &f,
                    "first",
                    args(
                        CHAT_A,
                        "deactivate",
                        json!({}),
                        current["revision"].as_str(),
                    ),
                )
                .await
                .1,
            );
            assert!(stopped["state"].is_null());
            assert_eq!(wire(&f, "first", &transport, json!({"jsonrpc":"2.0","id":event["id"],"result":{"action":"accept","content":{"decision":"approve"}}})).await.status(), StatusCode::ACCEPTED);
            assert!(next_event(&mut body).await["error"].is_object());
        } else {
            assert_eq!(wire(&f, "first", &transport, json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"approval-call"}})).await.status(), StatusCode::ACCEPTED);
            let cancelled = next_event(&mut body).await;
            assert_eq!(cancelled["method"], "notifications/cancelled");
            assert_eq!(cancelled["params"]["requestId"], event["id"]);
            assert!(body.frame().await.is_none());
            let current = decoded(
                &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
                    .await
                    .1,
            );
            assert!(current["state"]["pending_approval"].is_object());
        }
        assert_eq!(f.approvals.lock().await.len(), 1); // Projection only, never a decision.
    }
}

#[tokio::test]
async fn native_approval_requires_owning_reviewer_capability_and_durable_identity() {
    let (f, state) = waiting().await;
    for caps in [json!({}), json!({"elicitation":{"url":{}}})] {
        let transport = initialize(&f, "first", caps).await;
        let response = wire(&f, "first", &transport, approval_request(&state)).await;
        assert_eq!(response.headers()["content-type"], "application/json");
        assert!(f.approvals.lock().await.is_empty());
    }
    let transport = initialize(&f, "first", json!({"elicitation":{}})).await;
    f.service.lock().await["can_decide"] = json!(false);
    let response = wire(&f, "first", &transport, approval_request(&state)).await;
    let result: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(
        result["error"]["message"]
            .as_str()
            .unwrap()
            .contains("authorized reviewer")
    );
    assert_eq!(f.approvals.lock().await.len(), 1);
}

#[tokio::test]
async fn native_approval_reconciles_lost_commit_and_first_browser_decision() {
    for lost in [false, true] {
        let (f, state) = waiting().await;
        let transport = initialize(&f, "first", json!({"elicitation":{}})).await;
        let (mut body, event) = prompt(&f, &state, &transport).await;
        if lost {
            f.service.lock().await["lose_decision_response"] = json!(true);
        } else {
            f.service.lock().await["status"] = json!("rejected");
        }
        assert_eq!(wire(&f, "first", &transport, json!({"jsonrpc":"2.0","id":event["id"],"result":{"action":"accept","content":{"decision":"approve"}}})).await.status(), StatusCode::ACCEPTED);
        let result = next_event(&mut body).await;
        if lost {
            assert!(result["error"].is_object());
            let current = decoded(
                &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
                    .await
                    .1,
            );
            let recovered = wire(&f, "rotated", &transport, approval_request(&current)).await;
            assert_eq!(recovered.headers()["content-type"], "application/json");
            let recovered: Value =
                serde_json::from_slice(&recovered.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            assert_eq!(decoded(&recovered)["state"]["state"], "complete");
        } else {
            let result = decoded(&result);
            assert_eq!(result["state"]["state"], "intake");
            assert!(result["state"]["pending_approval"].is_null());
        }
        assert_eq!(
            f.approvals
                .lock()
                .await
                .iter()
                .filter(|r| r["decision"].is_string())
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn native_approval_disconnect_does_not_decide_or_cancel() {
    let (f, state) = waiting().await;
    let transport = initialize(&f, "first", json!({"elicitation":{}})).await;
    let (body, event) = prompt(&f, &state, &transport).await;
    drop(body);
    assert_eq!(f.approvals.lock().await.len(), 1);
    let current = decoded(
        &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
            .await
            .1,
    );
    assert!(current["state"]["pending_approval"].is_object());
    let duplicate = wire(&f, "first", &transport, approval_request(&current)).await;
    assert_eq!(duplicate.headers()["content-type"], "application/json");
    // The same authenticated client may still return its explicit response;
    // disconnection alone isn't a human decision or MCP cancellation.
    assert_eq!(wire(&f, "rotated", &transport, json!({"jsonrpc":"2.0","id":event["id"],"result":{"action":"accept","content":{"decision":"approve"}}})).await.status(), StatusCode::ACCEPTED);
    for _ in 0..100 {
        let current = decoded(
            &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
                .await
                .1,
        );
        if current["state"]["state"] == "complete" {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("Explicit response did not resolve after disconnect");
}

#[tokio::test]
async fn native_approval_off_then_new_run_retires_old_prompt() {
    let (f, state) = waiting().await;
    let transport = initialize(&f, "first", json!({"elicitation":{}})).await;
    let (mut old_body, old_event) = prompt(&f, &state, &transport).await;
    let current = decoded(
        &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
            .await
            .1,
    );
    let off = decoded(
        &call(
            &f,
            "first",
            args(
                CHAT_A,
                "deactivate",
                json!({}),
                current["revision"].as_str(),
            ),
        )
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
                off["revision"].as_str(),
            ),
        )
        .await
        .1,
    );
    let session = f
        .state
        .sessions
        .read()
        .await
        .values()
        .next()
        .unwrap()
        .clone();
    session
        .lock()
        .await
        .gateway
        .seed_native_usage_run("native-fixture-run-2", "intake");
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
    let (mut body, event) = prompt(&f, &waiting, &transport).await;
    assert_ne!(old_event["id"], event["id"]);
    assert!(next_event(&mut old_body).await["error"].is_object());
    assert_eq!(wire(&f, "first", &transport, json!({"jsonrpc":"2.0","id":old_event["id"],"result":{"action":"accept","content":{"decision":"approve"}}})).await.status(), StatusCode::CONFLICT);
    assert_eq!(
        wire(
            &f,
            "first",
            &transport,
            json!({"jsonrpc":"2.0","id":event["id"],"result":{"action":"cancel"}})
        )
        .await
        .status(),
        StatusCode::ACCEPTED
    );
    assert!(decoded(&next_event(&mut body).await)["state"]["pending_approval"].is_object());
    assert_eq!(
        f.approvals
            .lock()
            .await
            .iter()
            .filter(|r| r["decision"].is_string())
            .count(),
        0
    );
}

#[tokio::test]
async fn native_transport_validation_covers_ordinary_calls_too() {
    let f = fixture().await;
    let transport = initialize(&f, "first", json!({"elicitation":{}})).await;
    let read = json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":native::TOOL,"arguments":args(CHAT_A, "get_state", json!({}), None)}});
    assert_eq!(
        wire(&f, "foreign", &transport, read.clone()).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        wire(&f, "first", "unknown", read.clone()).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        wire(&f, "rotated", &transport, read.clone()).await.status(),
        StatusCode::OK
    );
    let mut malformed = read;
    malformed["result"] = json!({"action":"accept"});
    assert_eq!(
        wire(&f, "first", &transport, malformed).await.status(),
        StatusCode::BAD_REQUEST
    );
}

/// Optional real-client interoperability. Driver owns a disposable native host
/// config and synthetic elicitation answers; this is not a human acceptance test.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires STATEWRIGHT_NATIVE_CONNECT_DRIVER and STATEWRIGHT_NATIVE_CONNECT_ENGINE"]
async fn native_connect_client_interop() {
    let driver = std::env::var("STATEWRIGHT_NATIVE_CONNECT_DRIVER").expect("explicit driver path");
    let engine =
        std::env::var("STATEWRIGHT_NATIVE_CONNECT_ENGINE").expect("explicit native engine");
    let f = fixture().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let router = build_router(f.state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(90),
        tokio::process::Command::new("node")
            .arg(driver)
            .arg(engine)
            .arg("auto-allow")
            .arg(&url)
            .env_clear()
            .env("PATH", "/opt/homebrew/bin:/usr/bin:/bin")
            .kill_on_drop(true)
            .output(),
    )
    .await;
    server.abort();
    let output = output.expect("native connection driver timed out").unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    eprintln!("{stdout}");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value =
        serde_json::from_str(stdout.lines().last().expect("driver report")).unwrap();
    assert_eq!(report["outcome"], "pass");
    assert_eq!(report["callDelta"], 1);
    assert_eq!(report["permissionDelta"], 1);
    let conversation = report["conversation"]
        .as_str()
        .expect("native conversation UUID");
    let id = uuid::Uuid::parse_str(conversation).unwrap();
    assert!(!id.is_nil());
    assert_eq!(id.to_string(), conversation);
    // Do not create a session during verification and then mistake it for a
    // successful client call. The real router must already own exactly this one.
    let sessions = f.state.sessions.read().await;
    assert_eq!(sessions.len(), 1);
    assert!(
        sessions
            .keys()
            .all(|key| key.starts_with("native_") && key.ends_with(&format!("__{conversation}")))
    );
    drop(sessions);
    let current = decoded(
        &call(
            &f,
            "first",
            args(conversation, "get_state", json!({}), None),
        )
        .await
        .1,
    );
    assert!(current["state"].is_null());
    assert!(current["outcome"].is_null());
    assert!(f.approvals.lock().await.is_empty());
}

/// Optional approval protocol test, separate from native connection consent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires STATEWRIGHT_NATIVE_APPROVAL_DRIVER and a native MCP client"]
async fn native_approval_client_interop() {
    let driver = std::env::var("STATEWRIGHT_NATIVE_APPROVAL_DRIVER").expect("explicit driver path");
    let (f, _) = waiting().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let router = build_router(f.state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let output = tokio::process::Command::new("node")
        .arg(driver)
        .arg(&url)
        .arg(CHAT_A)
        .env_clear()
        .env("PATH", "/opt/homebrew/bin:/usr/bin:/bin")
        .kill_on_drop(true)
        .output()
        .await
        .unwrap();
    server.abort();
    eprintln!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let current = decoded(
        &call(&f, "first", args(CHAT_A, "get_state", json!({}), None))
            .await
            .1,
    );
    assert_eq!(current["state"]["state"], "complete");
    assert_eq!(
        f.approvals
            .lock()
            .await
            .iter()
            .filter(|r| r["decision"].is_string())
            .count(),
        1
    );
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
    assert_eq!(waiting["capabilities"]["human_approval"], true);
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
