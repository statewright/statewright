use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::response::sse::{Event, Sse};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use tokio::sync::{RwLock, mpsc};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::ReceiverStream;

use statewright_engine::MachineDefinition;

use crate::gateway::Gateway;
use crate::protocol::{JsonRpcRequest, JsonRpcResponse};
use crate::session::SessionManager;
use crate::upstream::UpstreamManager;

/// Shared state for the remote MCP transport server.
pub struct RemoteState {
    /// Active SSE sessions: session_id -> sender for SSE events.
    sessions: RwLock<HashMap<String, RemoteSession>>,
    /// Per-API-key session managers, shared across parent and branch sessions.
    session_managers: RwLock<HashMap<String, SessionManager>>,
    /// PocketBase URL for workflow loading.
    pb_url: String,
    /// Database pool for run recording and step metering.
    db_pool: crate::DbPool,
    /// Approval callback secret (from APPROVAL_CALLBACK_SECRET env var at startup).
    approval_secret: String,
}

impl RemoteState {
    /// Get or create a SessionManager for a given API key fingerprint.
    /// All sessions (parent + branches) for the same API key share one SessionManager.
    async fn get_session_manager(&self, api_key_fingerprint: &str) -> SessionManager {
        {
            let mgrs = self.session_managers.read().await;
            if let Some(mgr) = mgrs.get(api_key_fingerprint) {
                return mgr.clone();
            }
        }
        let mut mgrs = self.session_managers.write().await;
        mgrs.entry(api_key_fingerprint.to_string())
            .or_insert_with(SessionManager::new)
            .clone()
    }
}

struct RemoteSession {
    gateway: Gateway,
    tx: mpsc::Sender<String>,
}

const CLIENT_ID_HEADER: &str = "x-statewright-client-id";

/// Derive the mutable gateway boundary for one streamable HTTP client.
///
/// The API-key fingerprint is the tenant boundary. A client-provided identity
/// creates an isolated session inside that tenant. `Mcp-Session-Id` may select
/// a branch below that client root, but cannot cross into another client root.
fn streamable_session_key(
    api_key_fingerprint: &str,
    client_id: Option<&str>,
    mcp_session_id: Option<&str>,
) -> String {
    let base = format!("http_{}", api_key_fingerprint);
    let root = client_id.filter(|value| !value.is_empty()).map_or_else(
        || base.clone(),
        |value| {
            let fingerprint = uuid::Uuid::new_v5(
                &uuid::Uuid::NAMESPACE_OID,
                format!("statewright-client:{}", value).as_bytes(),
            );
            format!("{}__{}", base, fingerprint)
        },
    );

    match mcp_session_id.filter(|value| !value.is_empty()) {
        Some(session_id)
            if session_id == root || session_id.starts_with(&format!("{}_br_", root)) =>
        {
            session_id.to_string()
        }
        Some(branch_id) if branch_id.starts_with("br_") => format!("{}_{}", root, branch_id),
        _ => root,
    }
}

/// Configuration for the remote transport.
pub struct RemoteConfig {
    pub pb_url: String,
    pub listen_addr: String,
    pub database_url: Option<String>,
}

/// Start the remote MCP transport server (HTTP+SSE).
pub async fn start_remote_server(config: RemoteConfig) -> Result<std::net::SocketAddr, String> {
    // Connect to Postgres for step metering if DATABASE_URL provided
    #[cfg(feature = "metering")]
    let db_pool: crate::DbPool = if let Some(ref db_url) = config.database_url {
        match sqlx::postgres::PgPoolOptions::new()
            .max_connections(5)
            .connect(db_url)
            .await
        {
            Ok(pool) => {
                tracing::info!("Step metering: connected to Postgres");
                Some(pool)
            }
            Err(e) => {
                tracing::warn!(
                    "Step metering: failed to connect to Postgres: {e}. Metering disabled."
                );
                None
            }
        }
    } else {
        tracing::info!("Step metering: no DATABASE_URL, metering disabled");
        None
    };
    #[cfg(not(feature = "metering"))]
    let db_pool: crate::DbPool = {
        let _ = &config.database_url;
        None
    };

    let approval_secret = std::env::var("APPROVAL_CALLBACK_SECRET").unwrap_or_default();

    let state = Arc::new(RemoteState {
        sessions: RwLock::new(HashMap::new()),
        session_managers: RwLock::new(HashMap::new()),
        pb_url: config.pb_url,
        db_pool,
        approval_secret,
    });

    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind(&config.listen_addr)
        .await
        .map_err(|e| format!("Failed to bind: {}", e))?;

    let addr = listener
        .local_addr()
        .map_err(|e| format!("Failed to get addr: {}", e))?;

    tracing::info!(%addr, "Remote MCP transport listening");

    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    Ok(addr)
}

/// GET /sse — Establish SSE connection, authenticate via API key, load workflows.
async fn handle_sse(
    State(state): State<Arc<RemoteState>>,
    headers: HeaderMap,
) -> Result<
    Sse<impl tokio_stream::Stream<Item = Result<Event, std::convert::Infallible>>>,
    StatusCode,
> {
    // Extract API key from Authorization header
    let api_key = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.strip_prefix("Bearer ").unwrap_or(s).to_string())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    // Fetch workflows from PocketBase
    let result = fetch_workflows(&state.pb_url, &api_key)
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, "Failed to fetch workflows");
            StatusCode::UNAUTHORIZED
        })?;

    if result.workflows.is_empty() {
        tracing::warn!("No workflows found for API key");
        return Err(StatusCode::NOT_FOUND);
    }

    // Create session (shared SessionManager per API key for fork/join branch visibility)
    let api_key_hash = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, api_key.as_bytes());
    let session_manager = state.get_session_manager(&api_key_hash.to_string()).await;
    let session_id = uuid::Uuid::new_v4().to_string();

    let default_def = result
        .workflows
        .get(&result.default)
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;

    session_manager.create(session_id.clone(), default_def.clone());
    if let Some(limit) = result.plan_limit {
        session_manager.set_plan_limit(&session_id, limit);
    }

    let mut gateway = Gateway::new(
        session_manager,
        UpstreamManager::empty(),
        session_id.clone(),
        result.workflows,
        // A remote client must explicitly load a workflow. Inheriting the
        // account default here leaks unrelated workflow state into new TUIs.
        None,
        result.owner_id,
        state.db_pool.clone(),
    );

    // Set API key fingerprint for /message auth verification
    gateway.set_api_key_fingerprint(&api_key);

    // Create SSE channel
    let (tx, rx) = mpsc::channel::<String>(32);

    // Send the endpoint URL as the first SSE event (MCP spec)
    let endpoint_msg =
        serde_json::json!({"endpoint": std::format!("/message?session_id={}", session_id)});
    tx.send(endpoint_msg.to_string()).await.ok();

    // Store the session
    state
        .sessions
        .write()
        .await
        .insert(session_id.clone(), RemoteSession { gateway, tx });

    tracing::info!(session_id = session_id, "SSE session established");

    // Convert receiver to SSE stream
    let stream = ReceiverStream::new(rx).map(|msg| Ok(Event::default().event("message").data(msg)));

    Ok(Sse::new(stream))
}

#[derive(Deserialize)]
struct MessageQuery {
    session_id: String,
}

/// POST /mcp — Streamable HTTP transport (MCP 2025-03-26 spec).
/// Each request creates or reuses a session keyed by API key and client ID.
/// Returns JSON-RPC response directly in the HTTP response body.
async fn handle_streamable_http(
    State(state): State<Arc<RemoteState>>,
    headers: HeaderMap,
    Json(request): Json<JsonRpcRequest>,
) -> impl IntoResponse {
    let api_key = match headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.strip_prefix("Bearer ").unwrap_or(s).to_string())
    {
        Some(k) => k,
        None => return (StatusCode::UNAUTHORIZED, "Authorization header required").into_response(),
    };

    // Deterministic base key from API key
    let api_key_hash = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, api_key.as_bytes());
    let api_key_fingerprint = api_key_hash.to_string();

    // The client ID isolates independent TUI sessions in one account. The MCP
    // session header selects a fork/launcher branch beneath that client root.
    let client_id = headers
        .get(CLIENT_ID_HEADER)
        .and_then(|value| value.to_str().ok());
    let mcp_session_id = headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .filter(|value| !value.is_empty());
    let session_key = streamable_session_key(&api_key_fingerprint, client_id, mcp_session_id);

    // Use shared SessionManager for this API key (parent + branches share state)
    let session_manager = state.get_session_manager(&api_key_fingerprint).await;

    // Check if session exists WITHOUT holding the write lock
    let needs_create = !state.sessions.read().await.contains_key(&session_key);

    // If we need a new session, do the expensive fetch_workflows OUTSIDE any lock
    let new_session = if needs_create {
        let result = match fetch_workflows(&state.pb_url, &api_key).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "Failed to fetch workflows");
                return (StatusCode::UNAUTHORIZED, "Invalid API key or no workflows")
                    .into_response();
            }
        };

        if result.workflows.is_empty() {
            return (StatusCode::NOT_FOUND, "No workflows found").into_response();
        }

        let session_id = session_key.clone();
        let default_def = match result.workflows.get(&result.default) {
            Some(d) => d.clone(),
            None => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Default workflow not found",
                )
                    .into_response();
            }
        };

        // Check if this session key already exists in the shared SessionManager
        // (e.g., a branch session created by the parent's fork handler)
        if !session_manager.exists(&session_id) {
            session_manager.create(session_id.clone(), default_def);
            if let Some(limit) = result.plan_limit {
                session_manager.set_plan_limit(&session_id, limit);
            }
        }

        let mut gateway = Gateway::new(
            session_manager.clone(),
            UpstreamManager::empty(),
            session_id,
            result.workflows,
            // Keep the machine definition available for `load_workflow`, but
            // do not activate it until this client explicitly asks.
            None,
            result.owner_id,
            state.db_pool.clone(),
        );
        gateway.set_api_key_fingerprint(&api_key);

        let (tx, _rx) = mpsc::channel::<String>(1);
        Some(RemoteSession { gateway, tx })
    } else {
        None
    };

    // Now acquire write lock only for the brief insert + handle_message
    let mut sessions = state.sessions.write().await;

    if let Some(rs) = new_session {
        // Double-check: another request may have created it while we were fetching
        if !sessions.contains_key(&session_key) {
            sessions.insert(session_key.clone(), rs);
            tracing::info!(session = session_key, "HTTP session created");
        }
    }

    let session = sessions.get_mut(&session_key).unwrap();

    // Process request
    match session.gateway.handle_message(request).await {
        Some(response) => {
            let mut headers = axum::http::HeaderMap::new();
            headers.insert("content-type", "application/json".parse().unwrap());
            // Include session ID for client to track
            if let Ok(val) = session_key.parse() {
                headers.insert("mcp-session-id", val);
            }
            (StatusCode::OK, headers, axum::Json(response)).into_response()
        }
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// POST /message?session_id=... — Receive JSON-RPC request, route to gateway, respond via SSE.
async fn handle_message(
    State(state): State<Arc<RemoteState>>,
    headers: HeaderMap,
    Query(query): Query<MessageQuery>,
    Json(request): Json<JsonRpcRequest>,
) -> impl IntoResponse {
    // Require same API key auth as SSE establishment
    let api_key = match headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.strip_prefix("Bearer ").unwrap_or(s).to_string())
    {
        Some(k) if !k.is_empty() => k,
        _ => return (StatusCode::UNAUTHORIZED, "Authorization required").into_response(),
    };

    // Verify the API key owns this session by checking the owner_id matches
    let mut sessions = state.sessions.write().await;
    let session = match sessions.get_mut(&query.session_id) {
        Some(s) => s,
        None => return (StatusCode::NOT_FOUND, "Session not found").into_response(),
    };

    // Validate ownership: hash the provided key and check it resolves to the same owner
    if !session.gateway.verify_owner_key(&api_key) {
        return (StatusCode::FORBIDDEN, "Session belongs to another user").into_response();
    }

    // Process the request through the gateway
    if let Some(response) = session.gateway.handle_message(request).await {
        let response_json = serde_json::to_string(&response).unwrap_or_default();

        // Send response via SSE
        if session.tx.send(response_json).await.is_err() {
            // SSE connection closed
            sessions.remove(&query.session_id);
            return (StatusCode::GONE, "SSE connection closed").into_response();
        }
    }

    StatusCode::ACCEPTED.into_response()
}

/// Fetch workflows from PocketBase via API key.
/// Result of fetching workflows from PocketBase.
struct FetchResult {
    default: String,
    workflows: HashMap<String, MachineDefinition>,
    owner_id: String,
    plan_limit: Option<u64>,
}

async fn fetch_workflows(pb_url: &str, api_key: &str) -> Result<FetchResult, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/gateway/workflows", pb_url);

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("HTTP error: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("PocketBase returned {}", resp.status()));
    }

    #[derive(Deserialize)]
    struct GatewayResponse {
        default: Option<String>,
        workflows: HashMap<String, MachineDefinition>,
        owner_id: Option<String>,
        plan_limit: Option<u64>,
    }

    let data: GatewayResponse = resp
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))?;

    let default = data
        .default
        .unwrap_or_else(|| data.workflows.keys().next().cloned().unwrap_or_default());

    Ok(FetchResult {
        default,
        workflows: data.workflows,
        owner_id: data.owner_id.unwrap_or_default(),
        plan_limit: data.plan_limit,
    })
}

#[derive(Deserialize)]
struct ApprovalCallback {
    approval_id: String,
    instance_id: Option<String>,
    status: String,
    review_note: Option<String>,
    edited_context: Option<serde_json::Value>,
}

/// Build the router (extracted for testing).
pub fn build_router(state: Arc<RemoteState>) -> Router {
    Router::new()
        .route("/mcp", post(handle_streamable_http.clone()))
        .route("/", post(handle_streamable_http))
        .route("/sse", get(handle_sse))
        .route("/message", post(handle_message))
        .route("/health", get(|| async { "ok" }))
        .route("/api/approval-callback", post(handle_approval_callback))
        .with_state(state)
}

/// POST /api/approval-callback — Called by PB hook when approval status changes.
async fn handle_approval_callback(
    State(state): State<Arc<RemoteState>>,
    headers: HeaderMap,
    Json(body): Json<ApprovalCallback>,
) -> impl IntoResponse {
    // Auth: check bearer token matches approval_secret
    let expected_secret = &state.approval_secret;
    if !expected_secret.is_empty() {
        let provided = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.strip_prefix("Bearer ").unwrap_or(s).to_string())
            .unwrap_or_default();
        if provided != *expected_secret {
            return (StatusCode::UNAUTHORIZED, "Invalid callback secret").into_response();
        }
    }

    let sessions = state.sessions.write().await;

    // Find the session that has this approval_id pending
    let session_entry = sessions.iter().find(|(_, rs)| {
        rs.gateway
            .session_manager
            .get(&rs.gateway.session_id())
            .map_or(false, |s| {
                s.pending_approval
                    .as_ref()
                    .map_or(false, |p| p.approval_id == body.approval_id)
            })
    });

    let (session_id, remote_session) = match session_entry {
        Some((sid, rs)) => (sid.clone(), rs),
        None => {
            return (
                StatusCode::NOT_FOUND,
                "No session with this pending approval",
            )
                .into_response();
        }
    };

    match body.status.as_str() {
        "approved" => {
            // Get the parked transition details
            if let Some(pending) = remote_session
                .gateway
                .session_manager
                .clear_pending_approval(&remote_session.gateway.session_id())
            {
                // Apply edited context if provided, otherwise use the original
                let final_context = if let Some(edited) = body.edited_context {
                    statewright_engine::apply_context_patch(&pending.new_context, &edited)
                } else {
                    pending.new_context
                };

                remote_session.gateway.session_manager.update_state(
                    &remote_session.gateway.session_id(),
                    pending.to_state.clone(),
                    final_context,
                );

                tracing::info!(
                    session = %session_id,
                    from = %pending.from_state,
                    to = %pending.to_state,
                    "Approval granted, transition applied"
                );
            }
            (StatusCode::OK, "approved").into_response()
        }
        "rejected" => {
            remote_session
                .gateway
                .session_manager
                .clear_pending_approval(&remote_session.gateway.session_id());
            tracing::info!(session = %session_id, "Approval rejected, transition cancelled");
            (StatusCode::OK, "rejected").into_response()
        }
        _ => (
            StatusCode::BAD_REQUEST,
            "Invalid status (expected approved or rejected)",
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use serde_json::json;
    use tower::ServiceExt; // for oneshot()

    fn test_state() -> Arc<RemoteState> {
        Arc::new(RemoteState {
            sessions: RwLock::new(HashMap::new()),
            session_managers: RwLock::new(HashMap::new()),
            pb_url: "http://localhost:8090".into(),
            db_pool: None,
            approval_secret: String::new(),
        })
    }

    fn test_state_with_secret(secret: &str) -> Arc<RemoteState> {
        Arc::new(RemoteState {
            sessions: RwLock::new(HashMap::new()),
            session_managers: RwLock::new(HashMap::new()),
            pb_url: "http://localhost:8090".into(),
            db_pool: None,
            approval_secret: secret.into(),
        })
    }

    async fn test_state_with_session(session_id: &str, api_key: &str) -> Arc<RemoteState> {
        let state = test_state();
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "test",
            "initial": "working",
            "context": {},
            "states": {
                "working": {
                    "on": { "DEPLOY": { "target": "deployed", "requires_approval": true }, "DONE": "completed" }
                },
                "deployed": { "on": { "DONE": "completed" } },
                "completed": { "type": "final" }
            }
        })).unwrap();

        let session_manager = SessionManager::new();
        session_manager.create(session_id.into(), def.clone());

        let mut workflows = HashMap::new();
        workflows.insert("test".into(), def);

        let mut gateway = Gateway::new(
            session_manager,
            UpstreamManager::empty(),
            session_id.into(),
            workflows,
            Some("test".into()),
            "owner1".into(),
            None,
        );
        gateway.set_api_key_fingerprint(api_key);

        let (tx, _rx) = mpsc::channel::<String>(1);
        state
            .sessions
            .write()
            .await
            .insert(session_id.into(), RemoteSession { gateway, tx });

        state
    }

    #[tokio::test]
    async fn fresh_remote_session_starts_inactive_until_workflow_is_loaded() {
        let definition: MachineDefinition = serde_json::from_value(json!({
            "id": "default-workflow",
            "initial": "planning",
            "context": {},
            "states": {
                "planning": { "on": { "READY": "completed" } },
                "completed": { "type": "final" }
            }
        }))
        .unwrap();
        let session_manager = SessionManager::new();
        session_manager.create("fresh-client".into(), definition.clone());
        let mut workflows = HashMap::new();
        workflows.insert("default-workflow".into(), definition);
        let mut gateway = Gateway::new(
            session_manager,
            UpstreamManager::empty(),
            "fresh-client".into(),
            workflows,
            None,
            "owner".into(),
            None,
        );

        let get_state = || JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_get_state",
                "arguments": {}
            })),
            id: Some(json!(1)),
        };

        let response = gateway.handle_message(get_state()).await.unwrap();
        let result = response.result.unwrap();
        let text = result["content"][0]["text"].as_str().unwrap();
        assert_eq!(
            text,
            "No active workflow. Load a workflow before requesting state."
        );

        let load = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_load_workflow",
                "arguments": { "name": "default-workflow" }
            })),
            id: Some(json!(2)),
        };
        gateway.handle_message(load).await.unwrap();

        let response = gateway.handle_message(get_state()).await.unwrap();
        let result = response.result.unwrap();
        let text = result["content"][0]["text"].as_str().unwrap();
        let state: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(state["workflow"], "default-workflow");
        assert_eq!(state["state"], "planning");
    }

    // --- Health endpoint ---

    #[test]
    fn streamable_http_separates_clients_with_the_same_api_key() {
        let fingerprint = "account-fingerprint";
        let client_a = streamable_session_key(fingerprint, Some("codex-thread-a"), None);
        let client_b = streamable_session_key(fingerprint, Some("codex-thread-b"), None);

        assert_ne!(client_a, client_b);
        assert_eq!(
            client_a,
            streamable_session_key(fingerprint, Some("codex-thread-a"), None)
        );
        assert_eq!(
            client_a,
            streamable_session_key(fingerprint, Some("codex-thread-a"), Some(&client_a))
        );
    }

    #[test]
    fn branch_ids_are_scoped_under_the_client_root() {
        let fingerprint = "account-fingerprint";
        let root = streamable_session_key(fingerprint, Some("codex-thread-a"), None);
        let branch =
            streamable_session_key(fingerprint, Some("codex-thread-a"), Some("br_validation"));

        assert_eq!(branch, format!("{}_br_validation", root));
        assert_ne!(
            branch,
            streamable_session_key(fingerprint, Some("codex-thread-b"), Some("br_validation"),)
        );
    }

    #[test]
    fn canonical_session_ids_cannot_cross_client_roots() {
        let fingerprint = "account-fingerprint";
        let client_a = streamable_session_key(fingerprint, Some("codex-thread-a"), None);
        let client_b = streamable_session_key(fingerprint, Some("codex-thread-b"), None);

        assert_eq!(
            streamable_session_key(fingerprint, Some("codex-thread-b"), Some(&client_a)),
            client_b
        );
    }

    #[test]
    fn legacy_branch_sessions_still_accept_their_canonical_echo() {
        let fingerprint = "account-fingerprint";
        let branch = streamable_session_key(fingerprint, None, Some("br_validation"));

        assert_eq!(
            streamable_session_key(fingerprint, None, Some(&branch)),
            branch
        );
    }

    #[tokio::test]
    async fn client_scoped_keys_keep_mutable_machine_state_independent() {
        let state = test_state();
        let fingerprint = "account-fingerprint";
        let client_a = streamable_session_key(fingerprint, Some("codex-thread-a"), None);
        let client_b = streamable_session_key(fingerprint, Some("codex-thread-b"), None);
        let definition: MachineDefinition = serde_json::from_value(json!({
            "id": "isolation-test",
            "initial": "planning",
            "context": {},
            "states": {
                "planning": { "on": { "DONE": "complete" } },
                "complete": { "type": "final" }
            }
        }))
        .unwrap();
        let manager = state.get_session_manager(fingerprint).await;
        manager.create(client_a.clone(), definition.clone());
        manager.create(client_b.clone(), definition);

        assert!(manager.update_state(&client_a, "complete".into(), json!({"by": "a"})));
        assert_eq!(manager.get(&client_a).unwrap().current_state, "complete");
        assert_eq!(manager.get(&client_b).unwrap().current_state, "planning");
        assert_eq!(manager.get(&client_b).unwrap().context, json!({}));
    }

    #[tokio::test]
    async fn health_returns_ok() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    // --- Streamable HTTP auth ---

    #[tokio::test]
    async fn streamable_http_unauthorized_without_header() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(
                Request::post("/mcp")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    // --- Legacy SSE auth ---

    #[tokio::test]
    async fn sse_unauthorized_without_header() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(Request::get("/sse").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    // --- Message auth ---

    #[tokio::test]
    async fn message_unauthorized_without_header() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(
                Request::post("/message?session_id=test")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn message_not_found_for_unknown_session() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(
                Request::post("/message?session_id=nonexistent")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer sw_test_testkey123")
                    .body(Body::from(
                        r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn message_forbidden_for_wrong_api_key() {
        let state = test_state_with_session("sess1", "sw_test_correct_key").await;
        let app = build_router(state);
        let resp = app
            .oneshot(
                Request::post("/message?session_id=sess1")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer sw_test_wrong_key")
                    .body(Body::from(
                        r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    // --- Approval callback ---

    #[tokio::test]
    async fn approval_callback_unauthorized_with_wrong_secret() {
        let app = build_router(test_state_with_secret("correct_secret_123"));
        let resp = app
            .oneshot(
                Request::post("/api/approval-callback")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer wrong_secret")
                    .body(Body::from(
                        json!({
                            "approval_id": "apr_test",
                            "status": "approved"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn approval_callback_not_found_for_unknown_approval() {
        // test_state has empty secret = allow all callbacks
        let state = test_state_with_session("sess1", "key1").await;
        let app = build_router(state);
        let resp = app
            .oneshot(
                Request::post("/api/approval-callback")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "approval_id": "apr_nonexistent",
                            "status": "approved"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn approval_callback_invalid_status() {
        // Set up a session with a pending approval
        let state = test_state_with_session("sess2", "key2").await;
        {
            let mut sessions = state.sessions.write().await;
            let rs = sessions.get_mut("sess2").unwrap();
            rs.gateway.session_manager.set_pending_approval(
                "sess2",
                crate::session::PendingApproval {
                    approval_id: "apr_test2".into(),
                    event: "DEPLOY".into(),
                    from_state: "working".into(),
                    to_state: "deployed".into(),
                    new_context: json!({}),
                    message: None,
                },
            );
        }

        let app = build_router(state);
        let resp = app
            .oneshot(
                Request::post("/api/approval-callback")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "approval_id": "apr_test2",
                            "status": "maybe"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn approval_callback_approved_applies_transition() {
        let state = test_state_with_session("sess3", "key3").await;
        {
            let mut sessions = state.sessions.write().await;
            let rs = sessions.get_mut("sess3").unwrap();
            rs.gateway.session_manager.set_pending_approval(
                "sess3",
                crate::session::PendingApproval {
                    approval_id: "apr_approve".into(),
                    event: "DEPLOY".into(),
                    from_state: "working".into(),
                    to_state: "deployed".into(),
                    new_context: json!({"reviewed": true}),
                    message: Some("Deploy review".into()),
                },
            );
        }

        let app = build_router(state.clone());
        let resp = app
            .oneshot(
                Request::post("/api/approval-callback")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "approval_id": "apr_approve",
                            "status": "approved"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Verify the transition was applied
        let sessions = state.sessions.read().await;
        let rs = sessions.get("sess3").unwrap();
        let session = rs.gateway.session_manager.get("sess3").unwrap();
        assert_eq!(session.current_state, "deployed");
        assert!(session.pending_approval.is_none());
    }

    #[tokio::test]
    async fn approval_callback_rejected_clears_without_transition() {
        let state = test_state_with_session("sess4", "key4").await;
        {
            let mut sessions = state.sessions.write().await;
            let rs = sessions.get_mut("sess4").unwrap();
            rs.gateway.session_manager.set_pending_approval(
                "sess4",
                crate::session::PendingApproval {
                    approval_id: "apr_reject".into(),
                    event: "DEPLOY".into(),
                    from_state: "working".into(),
                    to_state: "deployed".into(),
                    new_context: json!({}),
                    message: None,
                },
            );
        }

        let app = build_router(state.clone());
        let resp = app
            .oneshot(
                Request::post("/api/approval-callback")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "approval_id": "apr_reject",
                            "status": "rejected"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // State should NOT have changed — still in working
        let sessions = state.sessions.read().await;
        let rs = sessions.get("sess4").unwrap();
        let session = rs.gateway.session_manager.get("sess4").unwrap();
        assert_eq!(session.current_state, "working");
        assert!(session.pending_approval.is_none());
    }
}
