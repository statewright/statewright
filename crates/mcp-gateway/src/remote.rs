use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{OriginalUri, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use tokio::sync::{Mutex, RwLock, mpsc};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::ReceiverStream;

use statewright_engine::MachineDefinition;

use crate::gateway::Gateway;
use crate::protocol::{JsonRpcRequest, JsonRpcResponse};
use crate::session::SessionManager;
use crate::tool_intent::{NativeToolFamily, native_tool_family};
use crate::upstream::UpstreamManager;
use crate::usage::{RuntimeUsageReport, UsageDisposition};

#[cfg(test)]
#[path = "native_remote_tests.rs"]
mod native_remote_tests;

#[path = "native_remote.rs"]
mod native;

/// Shared state for the remote MCP transport server.
pub struct RemoteState {
    /// Active SSE sessions: session_id -> sender for SSE events.
    sessions: RwLock<HashMap<String, Arc<Mutex<RemoteSession>>>>,
    /// Per-API-key session managers, shared across parent and branch sessions.
    session_managers: RwLock<HashMap<String, SessionManager>>,
    /// PocketBase URL for workflow loading.
    pb_url: String,
    /// Canonical public origin of this protected resource.
    public_url: String,
    /// Canonical issuer identifier for the OAuth authorization server.
    authorization_server_url: String,
    /// Database pool for run recording and step metering.
    db_pool: crate::DbPool,
    /// Approval callback secret (from APPROVAL_CALLBACK_SECRET env var at startup).
    approval_secret: String,
    /// Temporary, explicit field-calibration channel for classifier-denied
    /// shell commands. Raw command text never enters ordinary telemetry.
    classifier_denial_capture: bool,
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
    resource: String,
    native_revision: String,
}

#[derive(Deserialize)]
struct NativeUsageRequest {
    run_id: String,
    run_session_id: String,
    usage: RuntimeUsageReport,
}

const CLASSIFIER_DENIAL_COMMAND_BYTES: usize = 64 * 1024;
const CLASSIFIER_DENIAL_CAPTURE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_millis(750);

fn classifier_denial_basis(value: &str) -> bool {
    matches!(
        value,
        "effective_known_risk"
            | "deterministic_known_risk"
            | "deterministic_nonlocal_risk"
            | "semantic_threshold_not_met"
            | "incomplete_structural_evidence"
            | "semantic_vector_unavailable"
            | "semantic_assessment_incomplete"
            | "semantic_authorization_disabled"
            | "exploratory_effect_unresolved"
    ) || value.starts_with("classifier_policy_")
        || value.starts_with("workflow_capability_")
}

fn bounded_command(value: &str) -> (String, bool) {
    if value.len() <= CLASSIFIER_DENIAL_COMMAND_BYTES {
        return (value.to_string(), false);
    }
    let mut end = CLASSIFIER_DENIAL_COMMAND_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_string(), true)
}

fn classifier_semantic_vector(value: Option<&serde_json::Value>) -> Option<serde_json::Value> {
    let object = value?.as_object()?;
    let mut projected = serde_json::Map::new();
    for field in [
        "read_only",
        "may_write",
        "reversible",
        "destructive",
        "irreversible",
        "external_or_account_effect",
    ] {
        let Some(score) = object.get(field).and_then(serde_json::Value::as_f64) else {
            continue;
        };
        if (0.0..=1.0).contains(&score) {
            projected.insert(field.to_string(), serde_json::json!(score));
        }
    }
    (!projected.is_empty()).then(|| serde_json::Value::Object(projected))
}

fn classifier_denial_sample(
    request: &JsonRpcRequest,
    response: &JsonRpcResponse,
    run_session_id: &str,
) -> Option<serde_json::Value> {
    if request.method != "tools/call" {
        return None;
    }
    let params = request.params.as_ref()?;
    if params.get("name")?.as_str()? != "statewright_adapter_pre_tool" {
        return None;
    }
    let arguments = params.get("arguments")?;
    let tool_name = arguments.get("tool_name")?.as_str()?;
    if native_tool_family(tool_name) != Some(NativeToolFamily::Command) {
        return None;
    }
    let tool_input = arguments.get("tool_input")?;
    let raw_command = tool_input
        .get("command")
        .or_else(|| tool_input.get("cmd"))?
        .as_str()?;
    if raw_command.is_empty() {
        return None;
    }

    // Adapter hook responses are MCP text results whose single text item is a
    // JSON decision. Parse only that typed wrapper; never retain the complete
    // request, response, reason, or arbitrary tool input.
    let decision: serde_json::Value =
        serde_json::from_str(response.result.as_ref()?["content"][0]["text"].as_str()?).ok()?;
    if !matches!(decision.get("decision")?.as_str()?, "deny" | "block") {
        return None;
    }
    let risk = decision.get("risk_assessment")?.as_object()?;
    let intent_fingerprint = risk.get("intent_fingerprint")?.as_str()?;
    let invocation_fingerprint = risk.get("invocation_fingerprint")?.as_str()?;
    if !intent_fingerprint.starts_with("intent_v1_")
        || !invocation_fingerprint.starts_with("invocation_v1_")
    {
        return None;
    }
    let denial_basis = risk
        .get("final_denial_basis")
        .or_else(|| risk.get("resolution_basis"))?
        .as_str()?;
    if !classifier_denial_basis(denial_basis) {
        return None;
    }

    let (command, command_truncated) = bounded_command(raw_command);
    Some(serde_json::json!({
        "schema_version": 1,
        "run_session_id": run_session_id,
        "state": decision.get("state").and_then(serde_json::Value::as_str),
        "tool_name": tool_name,
        "command": command,
        "command_bytes": raw_command.len(),
        "command_truncated": command_truncated,
        "intent_fingerprint": intent_fingerprint,
        "invocation_fingerprint": invocation_fingerprint,
        "final_denial_basis": denial_basis,
        "resolution_basis": risk.get("resolution_basis").and_then(serde_json::Value::as_str),
        "deterministic_risk": risk.get("deterministic_risk").and_then(serde_json::Value::as_str),
        "deterministic_exposure": risk.get("deterministic_exposure").and_then(serde_json::Value::as_str),
        "deterministic_source": risk.get("deterministic_source").and_then(serde_json::Value::as_str),
        "effective_risk": risk.get("effective_risk").and_then(serde_json::Value::as_str),
        "semantic_status": risk.get("semantic_status").and_then(serde_json::Value::as_str),
        "semantic_vector": classifier_semantic_vector(risk.get("semantic_vector")),
        "resolved_effect": risk.get("resolved_effect").and_then(serde_json::Value::as_str),
        "required_authority": risk.get("required_authority").and_then(serde_json::Value::as_str),
        "observed_at": chrono::Utc::now().to_rfc3339(),
    }))
}

async fn persist_classifier_denial(
    state: &RemoteState,
    api_key: &str,
    sample: Option<serde_json::Value>,
) {
    if !state.classifier_denial_capture {
        return;
    }
    let Some(sample) = sample else {
        return;
    };
    let invocation = sample["invocation_fingerprint"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let result = reqwest::Client::new()
        .post(format!(
            "{}/api/gateway/classifier-denials",
            state.pb_url.trim_end_matches('/')
        ))
        .bearer_auth(api_key)
        .timeout(CLASSIFIER_DENIAL_CAPTURE_TIMEOUT)
        .json(&sample)
        .send()
        .await;
    match result {
        Ok(response) if response.status().is_success() => {}
        Ok(response) => tracing::warn!(
            status = %response.status(),
            invocation_fingerprint = %invocation,
            "PocketBase rejected classifier denial calibration sample"
        ),
        Err(error) => tracing::warn!(
            error = %error,
            invocation_fingerprint = %invocation,
            "Could not persist classifier denial calibration sample"
        ),
    }
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
    pub public_url: String,
    pub authorization_server_url: String,
}

fn normalize_public_origin(value: &str, name: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(value).map_err(|e| format!("Invalid {name}: {e}"))?;
    let loopback_http = parsed.scheme() == "http"
        && parsed.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        });
    if (parsed.scheme() != "https" && !loopback_http)
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err(format!(
            "Invalid {name}: expected an HTTPS origin (or loopback HTTP) without credentials, path, query, or fragment"
        ));
    }
    Ok(parsed.origin().ascii_serialization())
}

/// Start the remote MCP transport server (HTTP+SSE).
pub async fn start_remote_server(config: RemoteConfig) -> Result<std::net::SocketAddr, String> {
    let public_url = normalize_public_origin(&config.public_url, "public URL")?;
    let authorization_server_url =
        normalize_public_origin(&config.authorization_server_url, "authorization server URL")?;

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
    let classifier_denial_capture = std::env::var("STATEWRIGHT_CLASSIFIER_DENIAL_CAPTURE")
        .is_ok_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"));

    let state = Arc::new(RemoteState {
        sessions: RwLock::new(HashMap::new()),
        session_managers: RwLock::new(HashMap::new()),
        pb_url: config.pb_url,
        public_url,
        authorization_server_url,
        db_pool,
        approval_secret,
        classifier_denial_capture,
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

fn resource_url(state: &RemoteState, path: &str) -> String {
    if path == "/mcp" {
        format!("{}/mcp", state.public_url)
    } else {
        state.public_url.clone()
    }
}

fn resource_metadata_url(state: &RemoteState, path: &str) -> String {
    if path == "/mcp" {
        format!(
            "{}/.well-known/oauth-protected-resource/mcp",
            state.public_url
        )
    } else {
        format!("{}/.well-known/oauth-protected-resource", state.public_url)
    }
}

fn unauthorized_response(state: &RemoteState, path: &str, message: &'static str) -> Response {
    let challenge = format!(
        "Bearer resource_metadata=\"{}\", scope=\"mcp\"",
        resource_metadata_url(state, path)
    );
    let mut response = (StatusCode::UNAUTHORIZED, message).into_response();
    if let Ok(value) = HeaderValue::from_str(&challenge) {
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, value);
    }
    response
}

async fn handle_protected_resource_metadata(
    State(state): State<Arc<RemoteState>>,
    OriginalUri(uri): OriginalUri,
) -> impl IntoResponse {
    let path = if uri.path().ends_with("/mcp") {
        "/mcp"
    } else {
        "/"
    };
    Json(serde_json::json!({
        "resource": resource_url(&state, path),
        "authorization_servers": [state.authorization_server_url],
        "scopes_supported": ["mcp"],
        "bearer_methods_supported": ["header"]
    }))
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

    // Fetch workflows from PocketBase using the exact protected resource.
    let resource = state.public_url.clone();
    let result = fetch_workflows(&state.pb_url, &api_key, &resource)
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
    if result.oauth_client_id == "statewright-claude" {
        return Err(StatusCode::BAD_REQUEST);
    }
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
    gateway.set_remote_host_model_control(
        headers
            .get(CLIENT_ID_HEADER)
            .and_then(|value| value.to_str().ok())
            .is_none_or(str::is_empty),
    );

    // Create SSE channel
    let (tx, rx) = mpsc::channel::<String>(32);

    // Send the endpoint URL as the first SSE event (MCP spec)
    let endpoint_msg =
        serde_json::json!({"endpoint": std::format!("/message?session_id={}", session_id)});
    tx.send(endpoint_msg.to_string()).await.ok();

    // Store the session
    state.sessions.write().await.insert(
        session_id.clone(),
        Arc::new(Mutex::new(RemoteSession {
            gateway,
            tx,
            resource,
            native_revision: uuid::Uuid::new_v4().to_string(),
        })),
    );

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
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    Json(request): Json<JsonRpcRequest>,
) -> impl IntoResponse {
    let resource_path = if uri.path() == "/mcp" { "/mcp" } else { "/" };
    let resource = resource_url(&state, resource_path);
    let api_key = match headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.strip_prefix("Bearer ").unwrap_or(s).to_string())
    {
        Some(k) if !k.is_empty() => k,
        _ => {
            return unauthorized_response(&state, resource_path, "Authorization header required");
        }
    };

    // Validate on every request so expiry, revocation, scope, and exact OAuth
    // resource binding take effect even when a session is already cached.
    let validated = match fetch_workflows(&state.pb_url, &api_key, &resource).await {
        Ok(result) => result,
        Err(error) => {
            tracing::warn!(%error, "Failed to validate API key");
            return unauthorized_response(&state, resource_path, "Invalid API key or no workflows");
        }
    };
    // Deterministic base key from API key
    let api_key_hash = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, api_key.as_bytes());
    let api_key_fingerprint = api_key_hash.to_string();

    // The client ID isolates independent TUI sessions in one account. The MCP
    // session header selects a fork/launcher branch beneath that client root.
    let client_id = headers
        .get(CLIENT_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty());
    let mcp_session_id = headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .filter(|value| !value.is_empty());
    let session_key = streamable_session_key(&api_key_fingerprint, client_id, mcp_session_id);

    let native_tool = request
        .params
        .as_ref()
        .and_then(|params| params.get("name"))
        .and_then(|name| name.as_str());
    if request.method == "tools/call" && native_tool == Some(native::TOOL) {
        let response = native::handle(&state, validated, &resource, request).await;
        // MCP transport identity is not the native conversation identity. Never
        // teach a client to select mutable chat state through its header echo.
        return streamable_json_response(response, &session_key);
    }
    if validated.oauth_client_id == "statewright-claude" {
        return match native::discovery(&validated, &resource, request) {
            Some(response) => streamable_json_response(response, &session_key),
            None => StatusCode::ACCEPTED.into_response(),
        };
    }
    if validated.workflows.is_empty() {
        return (StatusCode::NOT_FOUND, "No workflows found").into_response();
    }

    // Use shared SessionManager for this API key (parent + branches share state)
    let session_manager = state.get_session_manager(&api_key_fingerprint).await;

    // Check if session exists WITHOUT holding the write lock
    let needs_create = !state.sessions.read().await.contains_key(&session_key);

    // If we need a new session, do the expensive fetch_workflows OUTSIDE any lock
    let new_session = if needs_create {
        let result = validated;

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
        Some(Arc::new(Mutex::new(RemoteSession {
            gateway,
            tx,
            resource,
            native_revision: uuid::Uuid::new_v4().to_string(),
        })))
    } else {
        None
    };

    // Hold the map lock only long enough to publish/resolve the session. Each
    // session serializes its own Gateway independently.
    let session = {
        let mut sessions = state.sessions.write().await;
        if let Some(rs) = new_session {
            // Double-check: another request may have created it while we were fetching
            if !sessions.contains_key(&session_key) {
                sessions.insert(session_key.clone(), rs);
                tracing::info!(session = session_key, "HTTP session created");
            }
        }
        sessions.get(&session_key).cloned().unwrap()
    };
    let mut session = session.lock().await;
    session
        .gateway
        .set_remote_host_model_control(client_id.is_none());

    // Process request
    let capture_request = request.clone();
    match session.gateway.handle_message(request).await {
        Some(response) => {
            let sample = classifier_denial_sample(&capture_request, &response, &session_key);
            drop(session);
            persist_classifier_denial(&state, &api_key, sample).await;
            streamable_json_response(response, &session_key)
        }
        None => StatusCode::ACCEPTED.into_response(),
    }
}

fn streamable_json_response(response: JsonRpcResponse, session_key: &str) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert("content-type", "application/json".parse().unwrap());
    if let Ok(value) = session_key.parse() {
        headers.insert("mcp-session-id", value);
    }
    (StatusCode::OK, headers, Json(response)).into_response()
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

    // Revalidate against PocketBase so expiry, revocation, scope, and exact
    // resource binding also apply to legacy SSE messages.
    let session = match state.sessions.read().await.get(&query.session_id).cloned() {
        Some(s) => s,
        None => return (StatusCode::NOT_FOUND, "Session not found").into_response(),
    };
    let resource = {
        let session = session.lock().await;
        // Validate ownership before using the session's bound resource.
        if !session.gateway.verify_owner_key(&api_key) {
            return (StatusCode::FORBIDDEN, "Session belongs to another user").into_response();
        }
        session.resource.clone()
    };
    if let Err(error) = fetch_workflows(&state.pb_url, &api_key, &resource).await {
        tracing::warn!(%error, "Failed to revalidate SSE API key");
        state.sessions.write().await.remove(&query.session_id);
        return unauthorized_response(&state, "/", "Invalid API key or no workflows");
    }

    let mut session = session.lock().await;
    if !session.gateway.verify_owner_key(&api_key) {
        return (StatusCode::FORBIDDEN, "Session belongs to another user").into_response();
    }

    // Process the request through the gateway
    let capture_request = request.clone();
    if let Some(response) = session.gateway.handle_message(request).await {
        let sample = classifier_denial_sample(&capture_request, &response, &query.session_id);
        let response_json = serde_json::to_string(&response).unwrap_or_default();
        let tx = session.tx.clone();
        drop(session);
        persist_classifier_denial(&state, &api_key, sample).await;

        // Send response via SSE
        if tx.send(response_json).await.is_err() {
            // SSE connection closed
            state.sessions.write().await.remove(&query.session_id);
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
    oauth_client_id: String,
    native_session: Option<native::Identity>,
}

async fn fetch_workflows(
    pb_url: &str,
    api_key: &str,
    resource: &str,
) -> Result<FetchResult, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/gateway/workflows", pb_url);

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("X-Statewright-OAuth-Resource", resource)
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
        #[serde(default)]
        oauth_client_id: String,
        native_session: Option<native::Identity>,
    }

    let mut data: GatewayResponse = resp
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))?;

    // Treat the upstream response as untrusted catalog input. Older PB hooks
    // may still return disabled definitions, so filter again at the gateway.
    data.workflows.retain(|_, definition| {
        definition
            .meta
            .as_ref()
            .and_then(|meta| meta.enabled)
            .unwrap_or(true)
    });

    let default = data
        .default
        .filter(|name| data.workflows.contains_key(name))
        .unwrap_or_else(|| data.workflows.keys().next().cloned().unwrap_or_default());

    Ok(FetchResult {
        default,
        workflows: data.workflows,
        owner_id: data.owner_id.unwrap_or_default(),
        plan_limit: data.plan_limit,
        oauth_client_id: data.oauth_client_id,
        native_session: data.native_session,
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
        .route(
            "/.well-known/oauth-protected-resource",
            get(handle_protected_resource_metadata),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(handle_protected_resource_metadata),
        )
        .route("/mcp", post(handle_streamable_http))
        .route("/", post(handle_streamable_http))
        .route("/sse", get(handle_sse))
        .route("/message", post(handle_message))
        .route("/health", get(|| async { "ok" }))
        .route("/api/runtime-usage", post(handle_native_usage))
        .route("/api/runtime-approval", post(handle_runtime_approval))
        .route("/api/approval-callback", post(handle_approval_callback))
        .with_state(state)
}

#[derive(Deserialize)]
struct RuntimeApprovalRequest {
    run_id: String,
    run_session_id: String,
    approval_id: String,
    decision: Option<String>,
}

// Host-only HTTP capability, intentionally absent from MCP tools/list.
async fn handle_runtime_approval(
    State(state): State<Arc<RemoteState>>,
    headers: HeaderMap,
    Json(body): Json<RuntimeApprovalRequest>,
) -> axum::response::Response {
    let Some(key) = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if body
        .decision
        .as_deref()
        .is_some_and(|s| s != "approved" && s != "rejected")
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    // Require the client's streamable root, or a branch session derived from
    // it (executor panes run `br_*` branches of their client root). Another
    // pane in the same account cannot select a session it does not own
    // through the request body.
    let fingerprint = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, key.as_bytes()).to_string();
    let client = headers
        .get(CLIENT_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|value| !value.is_empty());
    let client = match client {
        Some(client) => client,
        None => return StatusCode::FORBIDDEN.into_response(),
    };
    let root = streamable_session_key(&fingerprint, Some(client), None);
    let prefix = format!("{root}_");
    let under_own_branch = body.run_session_id.starts_with(&prefix)
        && body.run_session_id[root.len() + 1..].starts_with("br_");
    if body.run_session_id != root && !under_own_branch {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut session = state
        .sessions
        .read()
        .await
        .get(&body.run_session_id)
        .cloned();
    if session.is_none() {
        // The gateway process may have been replaced while a human decision
        // was parked. A durable checkpoint is the only authority for reviving
        // that exact owner/client/run; never fabricate one from the request.
        if state.db_pool.is_none() {
            return StatusCode::NOT_FOUND.into_response();
        }
        let resource = resource_url(&state, "/mcp");
        let workflows = match fetch_workflows(&state.pb_url, key, &resource).await {
            Ok(value) if !value.workflows.is_empty() => value,
            _ => return StatusCode::NOT_FOUND.into_response(),
        };
        let manager = state.get_session_manager(&fingerprint).await;
        let mut gateway = Gateway::new(
            manager,
            UpstreamManager::empty(),
            body.run_session_id.clone(),
            workflows.workflows,
            None,
            workflows.owner_id,
            state.db_pool.clone(),
        );
        gateway.set_api_key_fingerprint(key);
        let (tx, _rx) = mpsc::channel::<String>(1);
        let candidate = Arc::new(Mutex::new(RemoteSession {
            gateway,
            tx,
            resource,
            native_revision: uuid::Uuid::new_v4().to_string(),
        }));
        let mut sessions = state.sessions.write().await;
        session = Some(
            sessions
                .entry(body.run_session_id.clone())
                .or_insert(candidate)
                .clone(),
        );
    }
    let session = session.expect("approval session was restored or already present");
    let mut session = session.lock().await;
    if !session.gateway.verify_owner_key(key) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if session
        .gateway
        .ensure_pending_approval(&body.run_id, &body.approval_id)
        .await
        .is_err()
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut projection = match session
        .gateway
        .approval_projection(&body.run_id, &body.approval_id)
    {
        Ok(v) => v,
        Err(_) => return StatusCode::CONFLICT.into_response(),
    };
    if state.approval_secret.is_empty() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    projection["decision"] = serde_json::json!(body.decision);
    let response = reqwest::Client::new()
        .post(format!(
            "{}/api/internal/human-approval",
            state.pb_url.trim_end_matches('/')
        ))
        .bearer_auth(&state.approval_secret)
        .timeout(std::time::Duration::from_secs(10))
        .json(&projection)
        .send()
        .await;
    let receipt = match response {
        Ok(r) if r.status().is_success() => r.json::<serde_json::Value>().await.ok(),
        _ => None,
    };
    let Some(receipt) = receipt else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    if session
        .gateway
        .apply_approval_receipt(&body.run_id, &body.approval_id, &receipt)
        .is_err()
    {
        return StatusCode::CONFLICT.into_response();
    }
    if receipt["status"] != "pending"
        && session.gateway.persist_approval_checkpoint().await.is_err()
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    Json(receipt).into_response()
}

/// POST /api/runtime-usage — Update the live usage ledger from provider-native
/// telemetry. This is deliberately separate from the hidden controller tool:
/// native clients may update only the exact session and run owned by their API
/// key, while controller reports retain their stronger control-token boundary.
async fn handle_native_usage(
    State(state): State<Arc<RemoteState>>,
    headers: HeaderMap,
    Json(body): Json<NativeUsageRequest>,
) -> impl IntoResponse {
    let api_key = match headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
    {
        Some(value) => value,
        None => return (StatusCode::UNAUTHORIZED, "Authorization header required").into_response(),
    };

    let Some(session) = state
        .sessions
        .read()
        .await
        .get(&body.run_session_id)
        .cloned()
    else {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "inactive_session",
                "message": "Active Statewright session not found"
            })),
        )
            .into_response();
    };
    let mut session = session.lock().await;
    if !session.gateway.verify_owner_key(api_key) {
        return (StatusCode::FORBIDDEN, "API key does not own this session").into_response();
    }

    match session
        .gateway
        .report_native_usage(&body.run_id, body.usage)
    {
        Ok(UsageDisposition::Applied) => StatusCode::NO_CONTENT.into_response(),
        Ok(UsageDisposition::Superseded) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "superseded",
                "message": "A more authoritative usage total is already recorded"
            })),
        )
            .into_response(),
        Err(error) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": error.code, "message": error.message })),
        )
            .into_response(),
    }
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

    if body.status != "approved" && body.status != "rejected" {
        return (
            StatusCode::BAD_REQUEST,
            "Invalid status (expected approved or rejected)",
        )
            .into_response();
    }

    let session_entry = if let Some(instance_id) = body.instance_id.as_deref() {
        state
            .sessions
            .read()
            .await
            .get(instance_id)
            .cloned()
            .map(|session| (instance_id.to_string(), session))
    } else {
        // Compatibility for older callback producers. Never await an unrelated
        // stream lock: a busy session must not head-of-line block approvals.
        state
            .sessions
            .read()
            .await
            .iter()
            .map(|(id, session)| (id.clone(), session.clone()))
            .collect::<Vec<_>>()
            .into_iter()
            .find(|(_, candidate)| {
                let Ok(session) = candidate.try_lock() else {
                    return false;
                };
                session
                    .gateway
                    .session_manager
                    .get(&session.gateway.session_id())
                    .is_some_and(|machine| {
                        machine
                            .pending_approval
                            .as_ref()
                            .is_some_and(|pending| pending.approval_id == body.approval_id)
                    })
            })
    };

    let (session_id, remote_session) = match session_entry {
        Some(entry) => entry,
        None => {
            return (
                StatusCode::NOT_FOUND,
                "No session with this pending approval",
            )
                .into_response();
        }
    };
    let mut remote_session = remote_session.lock().await;
    // Legacy development fixtures permit an empty callback secret. Never apply
    // that compatibility rule to native grant-scoped approval state.
    if session_id.starts_with("native_") && expected_secret.is_empty() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let pending_matches = remote_session
        .gateway
        .session_manager
        .get(&remote_session.gateway.session_id())
        .is_some_and(|machine| {
            machine
                .pending_approval
                .as_ref()
                .is_some_and(|pending| pending.approval_id == body.approval_id)
        });
    if !pending_matches {
        return (
            StatusCode::NOT_FOUND,
            "No session with this pending approval",
        )
            .into_response();
    }

    remote_session.native_revision = uuid::Uuid::new_v4().to_string();
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
                remote_session.gateway.record_external_transition(
                    &pending.from_state,
                    &pending.to_state,
                    &pending.event,
                    &serde_json::json!({
                        "approval_id": pending.approval_id,
                        "review_note": body.review_note,
                    }),
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
        _ => unreachable!("approval status validated before session lookup"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use serde_json::json;
    use tower::ServiceExt; // for oneshot()

    fn test_state() -> Arc<RemoteState> {
        Arc::new(RemoteState {
            sessions: RwLock::new(HashMap::new()),
            session_managers: RwLock::new(HashMap::new()),
            pb_url: "http://localhost:8090".into(),
            public_url: "https://mcp.statewright.example".into(),
            authorization_server_url: "https://statewright.example".into(),
            db_pool: None,
            approval_secret: String::new(),
            classifier_denial_capture: false,
        })
    }

    fn test_state_with_secret(secret: &str) -> Arc<RemoteState> {
        Arc::new(RemoteState {
            sessions: RwLock::new(HashMap::new()),
            session_managers: RwLock::new(HashMap::new()),
            pb_url: "http://localhost:8090".into(),
            public_url: "https://mcp.statewright.example".into(),
            authorization_server_url: "https://statewright.example".into(),
            db_pool: None,
            approval_secret: secret.into(),
            classifier_denial_capture: false,
        })
    }

    async fn test_state_with_revalidating_pb(
        expected_resource: &'static str,
    ) -> (Arc<RemoteState>, Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let app = Router::new().route(
            "/api/gateway/workflows",
            get(move |headers: HeaderMap| {
                let observed = observed.clone();
                async move {
                    if headers
                        .get("x-statewright-oauth-resource")
                        .and_then(|value| value.to_str().ok())
                        != Some(expected_resource)
                    {
                        return (StatusCode::BAD_REQUEST, Json(json!({"error": "resource"})));
                    }
                    if observed.fetch_add(1, Ordering::SeqCst) > 0 {
                        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "revoked"})));
                    }
                    (
                        StatusCode::OK,
                        Json(json!({
                            "default": "test",
                            "owner_id": "owner1",
                            "plan_limit": 5000,
                            "workflows": {
                                "test": {
                                    "id": "test",
                                    "initial": "working",
                                    "context": {},
                                    "states": {
                                        "working": {"on": {"DONE": "completed"}},
                                        "completed": {"type": "final"}
                                    }
                                }
                            }
                        })),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let state = Arc::new(RemoteState {
            sessions: RwLock::new(HashMap::new()),
            session_managers: RwLock::new(HashMap::new()),
            pb_url: format!("http://{addr}"),
            public_url: "https://mcp.statewright.example".into(),
            authorization_server_url: "https://statewright.example".into(),
            db_pool: None,
            approval_secret: String::new(),
            classifier_denial_capture: false,
        });
        (state, calls)
    }

    fn adapter_request(tool_name: &str, tool_input: serde_json::Value) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_adapter_pre_tool",
                "arguments": {"tool_name": tool_name, "tool_input": tool_input}
            })),
            id: Some(json!(1)),
        }
    }

    fn adapter_decision(decision: serde_json::Value) -> JsonRpcResponse {
        JsonRpcResponse::success(
            Some(json!(1)),
            serde_json::to_value(crate::protocol::ToolCallResult::text(decision.to_string()))
                .unwrap(),
        )
    }

    #[test]
    fn classifier_capture_projects_only_denied_shell_commands_and_bounded_receipts() {
        let request = adapter_request(
            "exec_command",
            json!({
                "cmd": "git status --short && touch marker",
                "api_token": "must-not-be-projected"
            }),
        );
        let response = adapter_decision(json!({
            "decision": "deny",
            "state": "baseline",
            "reason": "private reason must not be projected",
            "risk_assessment": {
                "intent_fingerprint": "intent_v1_family",
                "invocation_fingerprint": "invocation_v1_exact",
                "deterministic_risk": "Moderate",
                "deterministic_exposure": "Local",
                "deterministic_source": "shell_ast",
                "effective_risk": "Moderate",
                "semantic_status": "Assessed",
                "semantic_vector": {"read_only": 0.31, "may_write": 0.94, "private_score": 0.99},
                "resolved_effect": "local_write",
                "resolution_basis": "deterministic_local_write",
                "final_denial_basis": "workflow_capability_write_denied",
                "required_authority": "Write",
                "private_extra": "must-not-be-projected"
            }
        }));

        let sample = classifier_denial_sample(&request, &response, "owned-session").unwrap();
        assert_eq!(sample["command"], "git status --short && touch marker");
        assert_eq!(
            sample["final_denial_basis"],
            "workflow_capability_write_denied"
        );
        assert_eq!(sample["run_session_id"], "owned-session");
        assert_eq!(sample["semantic_vector"]["may_write"], 0.94);
        assert!(sample["semantic_vector"].get("private_score").is_none());
        assert!(!sample.to_string().contains("api_token"));
        assert!(!sample.to_string().contains("private reason"));
        assert!(!sample.to_string().contains("private_extra"));

        let allowed = adapter_decision(json!({
            "decision": "allow",
            "risk_assessment": response.result.as_ref().unwrap()
        }));
        assert!(classifier_denial_sample(&request, &allowed, "owned-session").is_none());

        let approval = adapter_decision(json!({
            "decision": "deny",
            "state": "baseline",
            "risk_assessment": {
                "intent_fingerprint": "intent_v1_family",
                "invocation_fingerprint": "invocation_v1_exact",
                "final_denial_basis": "approval_pending"
            }
        }));
        assert!(classifier_denial_sample(&request, &approval, "owned-session").is_none());
        assert!(
            classifier_denial_sample(
                &adapter_request("Read", json!({"command": "private"})),
                &response,
                "owned-session",
            )
            .is_none()
        );
    }

    #[test]
    fn classifier_capture_truncates_on_a_utf8_boundary() {
        let command = format!("{}é", "x".repeat(CLASSIFIER_DENIAL_COMMAND_BYTES - 1));
        let request = adapter_request("Bash", json!({"command": command}));
        let response = adapter_decision(json!({
            "decision": "deny",
            "state": "baseline",
            "risk_assessment": {
                "intent_fingerprint": "intent_v1_family",
                "invocation_fingerprint": "invocation_v1_exact",
                "final_denial_basis": "semantic_threshold_not_met"
            }
        }));
        let sample = classifier_denial_sample(&request, &response, "owned-session").unwrap();
        assert_eq!(sample["command_truncated"], true);
        assert!(sample["command"].as_str().unwrap().len() <= CLASSIFIER_DENIAL_COMMAND_BYTES);
        assert_eq!(sample["command_bytes"], CLASSIFIER_DENIAL_COMMAND_BYTES + 1);
    }

    #[tokio::test]
    async fn classifier_capture_posts_only_when_explicitly_enabled() {
        let observed = Arc::new(Mutex::new(Vec::<(String, serde_json::Value)>::new()));
        let received = observed.clone();
        let app = Router::new().route(
            "/api/gateway/classifier-denials",
            post(
                move |headers: HeaderMap, Json(body): Json<serde_json::Value>| {
                    let received = received.clone();
                    async move {
                        received.lock().await.push((
                            headers
                                .get("authorization")
                                .and_then(|value| value.to_str().ok())
                                .unwrap_or_default()
                                .to_string(),
                            body,
                        ));
                        StatusCode::CREATED
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pb_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let sample = Some(json!({
            "invocation_fingerprint": "invocation_v1_exact",
            "command": "private command"
        }));
        let disabled = RemoteState {
            sessions: RwLock::new(HashMap::new()),
            session_managers: RwLock::new(HashMap::new()),
            pb_url: pb_url.clone(),
            public_url: "https://mcp.statewright.example".into(),
            authorization_server_url: "https://statewright.example".into(),
            db_pool: None,
            approval_secret: String::new(),
            classifier_denial_capture: false,
        };
        persist_classifier_denial(&disabled, "sw_live_secret", sample.clone()).await;
        assert!(observed.lock().await.is_empty());

        let enabled = RemoteState {
            classifier_denial_capture: true,
            ..disabled
        };
        persist_classifier_denial(&enabled, "sw_live_secret", sample).await;
        let observed = observed.lock().await;
        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0].0, "Bearer sw_live_secret");
        assert_eq!(observed[0].1["command"], "private command");
        server.abort();
    }

    #[tokio::test]
    async fn workflow_fetch_excludes_disabled_definitions_and_disabled_default() {
        let enabled = json!({
            "id": "enabled",
            "initial": "done",
            "states": {"done": {"type": "final"}}
        });
        let disabled = json!({
            "id": "disabled",
            "initial": "done",
            "meta": {"enabled": false},
            "states": {"done": {"type": "final"}}
        });
        let response = json!({
            "default": "disabled",
            "owner_id": "owner-a",
            "workflows": {"enabled": enabled, "disabled": disabled}
        });
        let app = axum::Router::new().route(
            "/api/gateway/workflows",
            get(move || {
                let response = response.clone();
                async move { Json(response) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pb_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let result = fetch_workflows(&pb_url, "test-key", "https://mcp.statewright.example/mcp")
            .await
            .unwrap();
        assert_eq!(result.default, "enabled");
        assert_eq!(result.workflows.keys().collect::<Vec<_>>(), vec!["enabled"]);
        server.abort();
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
        state.sessions.write().await.insert(
            session_id.into(),
            Arc::new(Mutex::new(RemoteSession {
                gateway,
                tx,
                resource: "https://mcp.statewright.example/mcp".into(),
                native_revision: uuid::Uuid::new_v4().to_string(),
            })),
        );

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

    #[test]
    fn discovery_origins_are_normalized_and_invalid_values_fail_closed() {
        assert_eq!(
            normalize_public_origin("https://MCP.Statewright.Example:443/", "public URL").unwrap(),
            "https://mcp.statewright.example"
        );
        assert_eq!(
            normalize_public_origin("http://127.0.0.1:3001/", "public URL").unwrap(),
            "http://127.0.0.1:3001"
        );
        for value in [
            "http://mcp.statewright.example",
            "https://user@mcp.statewright.example",
            "https://mcp.statewright.example/path",
            "https://mcp.statewright.example?tenant=other",
            "not a URL",
        ] {
            assert!(
                normalize_public_origin(value, "public URL").is_err(),
                "unexpected valid origin: {value}"
            );
        }
    }

    #[tokio::test]
    async fn protected_resource_metadata_uses_configured_origins_not_host_header() {
        for (path, expected_resource) in [
            (
                "/.well-known/oauth-protected-resource",
                "https://mcp.statewright.example",
            ),
            (
                "/.well-known/oauth-protected-resource/mcp",
                "https://mcp.statewright.example/mcp",
            ),
        ] {
            let response = build_router(test_state())
                .oneshot(
                    Request::get(path)
                        .header("host", "attacker.example")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = response.into_body().collect().await.unwrap().to_bytes();
            let metadata: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(metadata["resource"], expected_resource);
            assert_eq!(
                metadata["authorization_servers"],
                json!(["https://statewright.example"])
            );
            assert_eq!(metadata["scopes_supported"], json!(["mcp"]));
            assert_eq!(metadata["bearer_methods_supported"], json!(["header"]));
        }
    }

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
        assert_eq!(
            resp.headers().get(header::WWW_AUTHENTICATE).unwrap(),
            "Bearer resource_metadata=\"https://mcp.statewright.example/.well-known/oauth-protected-resource/mcp\", scope=\"mcp\""
        );
    }

    #[tokio::test]
    async fn streamable_http_forwards_exact_resource_and_revalidates_cached_sessions() {
        use std::sync::atomic::Ordering;

        let (state, calls) =
            test_state_with_revalidating_pb("https://mcp.statewright.example/mcp").await;
        let app = build_router(state);
        let first = app
            .clone()
            .oneshot(
                Request::post("/mcp")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer sw_live_oauth_token")
                    .body(Body::from(
                        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let first_body = first.into_body().collect().await.unwrap().to_bytes();
        let first_payload: serde_json::Value = serde_json::from_slice(&first_body).unwrap();
        assert!(
            first_payload["result"]["instructions"]
                .as_str()
                .unwrap()
                .contains("cannot apply")
        );

        let revoked = app
            .oneshot(
                Request::post("/mcp")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer sw_live_oauth_token")
                    .body(Body::from(
                        r#"{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(revoked.headers().contains_key(header::WWW_AUTHENTICATE));
    }

    #[tokio::test]
    async fn streamable_http_managed_client_does_not_get_web_routing_warning() {
        let (state, _) =
            test_state_with_revalidating_pb("https://mcp.statewright.example/mcp").await;
        let response = build_router(state)
            .oneshot(
                Request::post("/mcp")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer sw_live_oauth_token")
                    .header(CLIENT_ID_HEADER, "swc_native_client")
                    .body(Body::from(
                        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"statewright-codex","version":"1"}}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(payload["result"].get("instructions").is_none());
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

    #[tokio::test]
    async fn native_usage_is_bound_to_owner_session_run_state_and_sequence() {
        let state = test_state_with_session("sess-usage", "sw_test_owner_key").await;
        {
            let remote_session = state
                .sessions
                .read()
                .await
                .get("sess-usage")
                .cloned()
                .unwrap();
            remote_session
                .lock()
                .await
                .gateway
                .seed_native_usage_run("run-1", "working");
        }

        let report = json!({
            "run_id": "run-1",
            "run_session_id": "sess-usage",
            "usage": {
                "sequence": 1,
                "state": "working",
                "state_epoch": 1,
                "provider": "openai",
                "model": "gpt-5.6-sol",
                "effort": "high",
                "precision": "exact",
                "token_usage": {
                    "input_tokens": 10,
                    "cached_input_tokens": 2,
                    "cache_write_input_tokens": 3,
                    "output_tokens": 5,
                    "reasoning_output_tokens": 1,
                    "total_tokens": 15
                }
            }
        });
        let send = |body: serde_json::Value, key: &'static str| {
            build_router(state.clone()).oneshot(
                Request::post("/api/runtime-usage")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {key}"))
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
        };

        let mut inactive_session = report.clone();
        inactive_session["run_session_id"] = json!("expired-session");
        let inactive_response = send(inactive_session, "sw_test_owner_key").await.unwrap();
        assert_eq!(inactive_response.status(), StatusCode::CONFLICT);
        let inactive_body = inactive_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&inactive_body).unwrap()["error"],
            "inactive_session"
        );

        assert_eq!(
            send(report.clone(), "sw_test_owner_key")
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );

        let mut duplicate = report.clone();
        duplicate["usage"]["token_usage"]["total_tokens"] = json!(999);
        assert_eq!(
            send(duplicate, "sw_test_owner_key").await.unwrap().status(),
            StatusCode::CONFLICT
        );

        let mut unavailable = report.clone();
        unavailable["usage"]["sequence"] = json!(2);
        unavailable["usage"]["precision"] = json!("unavailable");
        assert_eq!(
            send(unavailable, "sw_test_owner_key")
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );

        let mut wrong_state = report.clone();
        wrong_state["usage"]["sequence"] = json!(2);
        wrong_state["usage"]["state"] = json!("deployed");
        assert_eq!(
            send(wrong_state, "sw_test_owner_key")
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );

        let mut wrong_run = report.clone();
        wrong_run["usage"]["sequence"] = json!(2);
        wrong_run["run_id"] = json!("run-foreign");
        assert_eq!(
            send(wrong_run, "sw_test_owner_key").await.unwrap().status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            send(report.clone(), "sw_test_wrong_key")
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );

        let response = {
            let remote_session = state
                .sessions
                .read()
                .await
                .get("sess-usage")
                .cloned()
                .unwrap();
            remote_session
                .lock()
                .await
                .gateway
                .handle_message(JsonRpcRequest {
                    jsonrpc: "2.0".into(),
                    method: "tools/call".into(),
                    params: Some(json!({ "name": "statewright_get_usage", "arguments": {} })),
                    id: Some(json!(9)),
                })
                .await
                .unwrap()
        };
        let text = response.result.unwrap()["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string();
        let summaries: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(summaries[0]["precision"], "exact");
        assert_eq!(summaries[0]["token_usage"]["cache_write_input_tokens"], 3);
        assert_eq!(summaries[0]["token_usage"]["total_tokens"], 15);
    }

    #[tokio::test]
    async fn native_usage_accepts_branch_pane_presenting_its_own_key() {
        // Executor panes run `br_*` branch sessions whose owner key is the
        // branch session key, not the client root key. The usage route must
        // accept the pane's own key (exact fingerprint match) and reject
        // foreign keys, or every branch pane's usage stream 403s.
        let fingerprint = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, b"canary-key").to_string();
        let root = streamable_session_key(&fingerprint, Some("canary-client"), None);
        let branch = format!("{root}_br_exec_pane");
        let branch_key = "sw_test_branch_key";
        let state = test_state_with_session(&branch, branch_key).await;
        {
            let remote_session = state.sessions.read().await.get(&branch).cloned().unwrap();
            remote_session
                .lock()
                .await
                .gateway
                .seed_native_usage_run("run-1", "working");
        }

        let report = json!({
            "run_id": "run-1",
            "run_session_id": branch,
            "usage": {
                "sequence": 1,
                "state": "working",
                "state_epoch": 1,
                "provider": "openai",
                "model": "gpt-5.6-sol",
                "effort": "high",
                "precision": "exact",
                "token_usage": {
                    "input_tokens": 10,
                    "cached_input_tokens": 2,
                    "cache_write_input_tokens": 3,
                    "output_tokens": 5,
                    "reasoning_output_tokens": 1,
                    "total_tokens": 15
                }
            }
        });
        let send = |body: serde_json::Value, key: &str| {
            build_router(state.clone()).oneshot(
                Request::post("/api/runtime-usage")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {key}"))
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
        };

        // The pane presenting its own branch key is accepted.
        assert_eq!(
            send(report.clone(), branch_key).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );

        // The client root key of the same account must not be usable against
        // the branch pane's stream, and unknown keys stay forbidden.
        assert_eq!(
            send(report.clone(), "sw_test_root_key")
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            send(report.clone(), "sw_test_wrong_key")
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
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
    async fn runtime_approval_requires_key_and_exact_client_root() {
        let body = json!({"run_id": "r", "run_session_id": "foreign", "approval_id": "apr_test"})
            .to_string();
        let response = build_router(test_state())
            .oneshot(
                Request::post("/api/runtime-approval")
                    .header("content-type", "application/json")
                    .body(Body::from(body.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = build_router(test_state())
            .oneshot(
                Request::post("/api/runtime-approval")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer key")
                    .header(CLIENT_ID_HEADER, "own-client")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[cfg(feature = "metering")]
    #[tokio::test]
    #[ignore = "requires STATEWRIGHT_TEST_DATABASE_URL; uses connection-local temporary table only"]
    async fn runtime_approval_recovers_only_exact_parked_session_after_gateway_replacement() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&std::env::var("STATEWRIGHT_TEST_DATABASE_URL").unwrap())
            .await
            .unwrap();
        sqlx::query("SET search_path TO pg_temp")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TEMP TABLE workflow_runs (id text PRIMARY KEY, owner text, workflow_name text, status text, session_id text, project_id text, final_state text, context_snapshot json, updated text)")
            .execute(&pool).await.unwrap();

        let fingerprint = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, b"key").to_string();
        let root = streamable_session_key(&fingerprint, Some("own-client"), None);
        let definition: MachineDefinition = serde_json::from_value(json!({
            "id": "test", "initial": "working", "context": {},
            "states": {"working": {"on": {"DEPLOY": {"target": "deployed", "requires_approval": true}}},
                "deployed": {"type": "final"}}
        })).unwrap();
        let manager = SessionManager::new();
        manager.create(root.clone(), definition.clone());
        manager.set_pending_approval(
            &root,
            crate::session::PendingApproval {
                approval_id: "apr_recover".into(),
                event: "DEPLOY".into(),
                from_state: "working".into(),
                to_state: "deployed".into(),
                new_context: json!({}),
                message: None,
            },
        );
        let checkpoint = manager.get(&root).unwrap().checkpoint();
        sqlx::query("INSERT INTO workflow_runs (id, owner, workflow_name, status, session_id, project_id, final_state, context_snapshot) VALUES ('run-1', 'owner-a', 'test', 'running', $1, 'project-a', 'working', $2)")
            .bind(&root).bind(&checkpoint).execute(&pool).await.unwrap();

        let response =
            json!({"default": "test", "owner_id": "owner-a", "workflows": {"test": definition}});
        let pb = axum::Router::new().route(
            "/api/gateway/workflows",
            get(move || {
                let response = response.clone();
                async move { Json(response) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pb_url = format!("http://{}", listener.local_addr().unwrap());
        let pb_server = tokio::spawn(async move {
            axum::serve(listener, pb).await.unwrap();
        });
        let state = Arc::new(RemoteState {
            sessions: RwLock::new(HashMap::new()),
            session_managers: RwLock::new(HashMap::new()),
            pb_url,
            public_url: "https://mcp.statewright.example".into(),
            authorization_server_url: "https://statewright.example".into(),
            db_pool: Some(pool.clone()),
            approval_secret: String::new(),
            classifier_denial_capture: false,
        });
        let request = |client: &'static str, approval: &'static str| {
            Request::post("/api/runtime-approval")
                .header("content-type", "application/json")
                .header("authorization", "Bearer key")
                .header(CLIENT_ID_HEADER, client)
                .body(Body::from(
                    json!({"run_id": "run-1", "run_session_id": root,
                "approval_id": approval})
                    .to_string(),
                ))
                .unwrap()
        };

        assert_eq!(
            build_router(state.clone())
                .oneshot(request("foreign-client", "apr_recover"))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            build_router(state.clone())
                .oneshot(request("own-client", "wrong-ticket"))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        // No approval secret was configured for this fixture. Reaching 503
        // means the gateway recovered and projected the exact owned ticket;
        // no decision was submitted to PocketBase.
        assert_eq!(
            build_router(state.clone())
                .oneshot(request("own-client", "apr_recover"))
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        let stored = state.sessions.read().await.get(&root).cloned().unwrap();
        let stored = stored.lock().await;
        assert_eq!(
            stored
                .gateway
                .approval_projection("run-1", "apr_recover")
                .unwrap()["pending"]["to_state"],
            "deployed"
        );
        drop(stored);
        pb_server.abort();
        pool.close().await;
    }

    #[tokio::test]
    async fn runtime_approval_accepts_branch_sessions_under_own_client_root() {
        let fingerprint = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, b"key").to_string();
        let root = streamable_session_key(&fingerprint, Some("own-client"), None);
        let branch = format!("{root}_br_test_branch");
        let state = test_state_with_session(&branch, "key").await;
        {
            let rs = state.sessions.read().await.get(&branch).cloned().unwrap();
            let mut rs = rs.lock().await;
            rs.gateway.seed_native_usage_run("r", "working");
            rs.gateway.session_manager.set_pending_approval(
                &branch,
                crate::session::PendingApproval {
                    approval_id: "apr_test".into(),
                    event: "DEPLOY".into(),
                    from_state: "working".into(),
                    to_state: "deployed".into(),
                    new_context: json!({}),
                    message: None,
                },
            );
        }

        let make = |run_session_id: String| {
            Request::post("/api/runtime-approval")
                .header("content-type", "application/json")
                .header("authorization", "Bearer key")
                .header(CLIENT_ID_HEADER, "own-client")
                .body(Body::from(
                    json!({
                        "run_id": "r",
                        "run_session_id": run_session_id,
                        "approval_id": "apr_test"
                    })
                    .to_string(),
                ))
                .unwrap()
        };

        // The executor's `br_*` branch under the presenting client root is its
        // own session: the identity check accepts it (the test state then
        // answers 503 because no approval secret/PB is configured).
        let response = build_router(state.clone())
            .oneshot(make(branch.clone()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

        // A branch under a different client root stays forbidden even with the
        // same account key.
        let other_root = streamable_session_key(&fingerprint, Some("other-client"), None);
        let response = build_router(state.clone())
            .oneshot(make(format!("{other_root}_br_evil")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        // A branch under the own root that has no stored session must not be
        // served by a sibling session.
        let response = build_router(state)
            .oneshot(make(format!("{root}_br_missing")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn approval_callback_invalid_status() {
        // Set up a session with a pending approval
        let state = test_state_with_session("sess2", "key2").await;
        {
            let rs = state.sessions.read().await.get("sess2").cloned().unwrap();
            let rs = rs.lock().await;
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
                            "instance_id": "sess2",
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
            let rs = state.sessions.read().await.get("sess3").cloned().unwrap();
            let mut rs = rs.lock().await;
            rs.gateway.seed_native_usage_run("run-approved", "working");
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
                            "instance_id": "sess3",
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
        let rs = state.sessions.read().await.get("sess3").cloned().unwrap();
        let mut rs = rs.lock().await;
        let session = rs.gateway.session_manager.get("sess3").unwrap();
        assert_eq!(session.current_state, "deployed");
        assert!(session.pending_approval.is_none());
        assert_eq!(
            rs.gateway
                .report_native_usage(
                    "run-approved",
                    crate::usage::RuntimeUsageReport {
                        sequence: 1,
                        state: "deployed".into(),
                        state_epoch: 2,
                        provider: "openai".into(),
                        model: None,
                        effort: None,
                        precision: "exact".into(),
                        token_usage: crate::usage::TokenUsage {
                            total_tokens: 42,
                            ..Default::default()
                        },
                    },
                )
                .unwrap(),
            UsageDisposition::Applied
        );
    }

    #[tokio::test]
    async fn approval_callback_rejected_clears_without_transition() {
        let state = test_state_with_session("sess4", "key4").await;
        {
            let rs = state.sessions.read().await.get("sess4").cloned().unwrap();
            let rs = rs.lock().await;
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
                            "instance_id": "sess4",
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
        let rs = state.sessions.read().await.get("sess4").cloned().unwrap();
        let rs = rs.lock().await;
        let session = rs.gateway.session_manager.get("sess4").unwrap();
        assert_eq!(session.current_state, "working");
        assert!(session.pending_approval.is_none());
    }
}
