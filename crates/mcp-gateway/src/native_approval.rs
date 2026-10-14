//! Native MCP elicitation. Only an authenticated protocol response can resolve
//! a server-held prompt. Tool arguments never carry approval decisions.
use super::*;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

const TRANSPORT_TTL: Duration = Duration::from_secs(3600);
const PROMPT_TTL: Duration = Duration::from_secs(180);
const PROTOCOL: &str = "2025-06-18";

#[derive(Default)]
pub(super) struct Broker {
    transports: HashMap<String, Transport>,
    pending: HashMap<String, Prompt>,
}
struct Transport {
    namespace: String,
    form: bool,
    expires: Instant,
}
struct Prompt {
    transport: String,
    session: String,
    request_id: Value,
    revision: String,
    expires: Instant,
    reply: oneshot::Sender<Answer>,
}
enum Answer {
    Decision(&'static str),
    Cancel,
    RpcCancel,
    Invalid,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Ticket {
    run_id: String,
    approval_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    jsonrpc: String,
    id: String,
    result: Option<Value>,
    error: Option<Value>,
}

impl Broker {
    fn prune(&mut self) {
        let now = Instant::now();
        self.transports.retain(|_, t| t.expires > now);
        self.pending.retain(|_, p| {
            p.expires > now && !p.reply.is_closed() && self.transports.contains_key(&p.transport)
        });
    }
    fn owns(&mut self, id: &str, namespace: &str) -> bool {
        self.prune();
        self.transports.get_mut(id).is_some_and(|t| {
            if t.namespace != namespace {
                return false;
            }
            t.expires = Instant::now() + TRANSPORT_TTL;
            true
        })
    }
}

fn response(reply: JsonRpcResponse) -> Response {
    Json(reply).into_response()
}
fn outcome(status: &str) -> Value {
    serde_json::to_value(crate::protocol::ToolCallResult::text(
        json!({"approval_status":status}).to_string(),
    ))
    .unwrap()
}
fn fail(id: Option<Value>, message: &str) -> Response {
    response(JsonRpcResponse::error(id, -32602, message))
}

pub(super) async fn route(
    state: Arc<RemoteState>,
    validated: FetchResult,
    resource: &str,
    headers: &HeaderMap,
    message: Value,
) -> Response {
    // Native clients are not browser origins. Reject unsolicited cross-origin
    // browser traffic rather than expanding the approval transport's surface.
    if headers.contains_key(header::ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let identity = validated.native_session.as_ref().filter(|identity| {
        identity.valid(resource, &validated.owner_id, &validated.oauth_client_id)
    });
    let namespace = identity
        .map(|identity| identity.namespace(&state.authorization_server_url, &validated.owner_id));
    let transport = headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !message.is_object() || message["jsonrpc"] != "2.0" {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if message.get("method").is_none() {
        let Some(namespace) = namespace else {
            return StatusCode::FORBIDDEN.into_response();
        };
        let reply: Reply = match serde_json::from_value(message) {
            Ok(reply) => reply,
            Err(_) => return StatusCode::BAD_REQUEST.into_response(),
        };
        if reply.jsonrpc != "2.0" || reply.result.is_some() == reply.error.is_some() {
            return StatusCode::BAD_REQUEST.into_response();
        }
        let mut broker = state.native_approvals.lock().await;
        if !broker.owns(transport, &namespace) {
            return StatusCode::NOT_FOUND.into_response();
        }
        if headers
            .get("mcp-protocol-version")
            .is_some_and(|v| v != PROTOCOL)
        {
            return StatusCode::BAD_REQUEST.into_response();
        }
        let Some(prompt) = broker.pending.get(&reply.id) else {
            return StatusCode::CONFLICT.into_response();
        };
        if prompt.transport != transport {
            return StatusCode::FORBIDDEN.into_response();
        }
        // Consume before processing, even for malformed content. A foreign reply
        // never consumes another connection's request.
        let prompt = broker.pending.remove(&reply.id).unwrap();
        let answer = reply
            .result
            .as_ref()
            .map(parse_answer)
            .unwrap_or(Answer::Invalid);
        let _ = prompt.reply.send(answer);
        return StatusCode::ACCEPTED.into_response();
    }
    if message
        .as_object()
        .unwrap()
        .keys()
        .any(|key| !["jsonrpc", "id", "method", "params"].contains(&key.as_str()))
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let request: JsonRpcRequest = match serde_json::from_value(message) {
        Ok(request) => request,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    if request.method == "initialize" {
        let Some(namespace) = namespace else {
            return native::discovery(&validated, resource, request)
                .map(response)
                .unwrap_or_else(|| StatusCode::ACCEPTED.into_response());
        };
        if request.id.is_none() || request.id == Some(Value::Null) {
            return StatusCode::BAD_REQUEST.into_response();
        }
        let params = request.params.as_ref().unwrap_or(&Value::Null);
        // Negotiate our supported revision. Clients offering newer revisions
        // may accept this one, or disconnect according to MCP negotiation.
        let offered = params["protocolVersion"].as_str().unwrap_or("");
        let elicitation = &params["capabilities"]["elicitation"];
        let form = matches!(offered, "2025-06-18" | "2025-11-25")
            && elicitation.is_object()
            && (elicitation == &json!({}) || elicitation["form"].is_object());
        let mut broker = state.native_approvals.lock().await;
        broker.prune();
        if broker.transports.len() >= 4096
            || broker
                .transports
                .values()
                .filter(|t| t.namespace == namespace)
                .count()
                >= 128
        {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
        let id = uuid::Uuid::new_v4().to_string();
        broker.transports.insert(
            id.clone(),
            Transport {
                namespace,
                form,
                expires: Instant::now() + TRANSPORT_TTL,
            },
        );
        let mut result = Gateway::initialization_result(true);
        result["protocolVersion"] = json!(PROTOCOL);
        return streamable_json_response(JsonRpcResponse::success(request.id, result), &id);
    }
    // Calls without a transport retain the read/control v1 compatibility path,
    // but an initialized/expired transport must never silently change identity.
    if !transport.is_empty() && namespace.is_some() {
        if !state
            .native_approvals
            .lock()
            .await
            .owns(transport, namespace.as_ref().unwrap())
        {
            return StatusCode::NOT_FOUND.into_response();
        }
        if headers
            .get("mcp-protocol-version")
            .is_some_and(|v| v != PROTOCOL)
        {
            return StatusCode::BAD_REQUEST.into_response();
        }
    }
    if request.method == "notifications/cancelled" {
        let Some(namespace) = namespace else {
            return StatusCode::FORBIDDEN.into_response();
        };
        let Some(id) = request.params.as_ref().and_then(|p| p.get("requestId")) else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        let mut broker = state.native_approvals.lock().await;
        if !broker.owns(transport, &namespace) {
            return StatusCode::NOT_FOUND.into_response();
        }
        let nonce = broker
            .pending
            .iter()
            .find(|(_, p)| p.transport == transport && &p.request_id == id)
            .map(|(n, _)| n.clone());
        if let Some(nonce) = nonce {
            if let Some(prompt) = broker.pending.remove(&nonce) {
                let _ = prompt.reply.send(Answer::RpcCancel);
            }
        }
        return StatusCode::ACCEPTED.into_response();
    }
    if request.method == "tools/call"
        && request
            .params
            .as_ref()
            .is_some_and(|p| p["name"] == native::CONNECT_TOOL)
    {
        return response(native::handle(&state, validated, resource, request).await);
    }
    if request.method == "tools/call"
        && request
            .params
            .as_ref()
            .is_some_and(|p| p["name"] == native::TOOL)
    {
        if request
            .params
            .as_ref()
            .is_some_and(|p| p["arguments"]["operation"] == "request_approval")
        {
            let Some(namespace) = namespace else {
                return fail(request.id, "Authenticated native identity unavailable");
            };
            if !headers
                .get(header::ACCEPT)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| {
                    v.split(',')
                        .any(|v| v.trim().starts_with("text/event-stream"))
                })
            {
                return fail(
                    request.id,
                    "Native approval requires an SSE-capable connection",
                );
            }
            if headers
                .get("mcp-protocol-version")
                .is_some_and(|v| v != PROTOCOL)
            {
                return StatusCode::BAD_REQUEST.into_response();
            }
            return begin(state, &namespace, transport, request).await;
        }
        return response(native::handle(&state, validated, resource, request).await);
    }
    native::discovery(&validated, resource, request)
        .map(response)
        .unwrap_or_else(|| StatusCode::ACCEPTED.into_response())
}

fn parse_answer(value: &Value) -> Answer {
    let Some(object) = value.as_object() else {
        return Answer::Invalid;
    };
    if object.keys().any(|key| key != "action" && key != "content") {
        return Answer::Invalid;
    }
    match value["action"].as_str() {
        Some("cancel") if value.get("content").is_none() => Answer::Cancel,
        Some("decline") if value.get("content").is_none() => Answer::Decision("rejected"),
        Some("accept") if value["content"] == json!({"decision":"approve"}) => {
            Answer::Decision("approved")
        }
        Some("accept") if value["content"] == json!({"decision":"reject"}) => {
            Answer::Decision("rejected")
        }
        _ => Answer::Invalid,
    }
}

fn receipt_matches(receipt: &Value, projection: &Value) -> bool {
    ["approval_id", "run_id", "instance_id"]
        .iter()
        .all(|field| receipt[field] == projection[field])
        && receipt["from_state"] == projection["pending"]["from_state"]
        && receipt["to_state"] == projection["pending"]["to_state"]
        && matches!(
            receipt["status"].as_str(),
            Some("pending" | "approved" | "rejected")
        )
}

async fn begin(
    state: Arc<RemoteState>,
    namespace: &str,
    transport: &str,
    request: JsonRpcRequest,
) -> Response {
    if request.id.is_none() || request.id == Some(Value::Null) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let arguments = request
        .params
        .as_ref()
        .and_then(|p| p.get("arguments"))
        .cloned()
        .unwrap_or(Value::Null);
    let (native, _) = match native::parse(arguments) {
        Ok(v) => v,
        Err(e) => return fail(request.id, e),
    };
    let ticket: Ticket = match serde_json::from_value(native.input) {
        Ok(v) => v,
        Err(_) => return fail(request.id, "Invalid approval ticket"),
    };
    {
        let mut broker = state.native_approvals.lock().await;
        if !broker.owns(transport, namespace) {
            return StatusCode::NOT_FOUND.into_response();
        }
        if !broker.transports[transport].form {
            return fail(
                request.id,
                "This native client did not negotiate form elicitation",
            );
        }
    }
    let session_key = format!("{}__{}", namespace, native.context.conversation_id);
    let Some(session) = state.sessions.read().await.get(&session_key).cloned() else {
        return fail(
            request.id,
            "Read the current workflow before requesting approval",
        );
    };
    let mut locked = session.lock().await;
    // Approval waits may outlive a telemetry grant. Do not advertise cached
    // consent as freshly verified on any approval reply; get_state refreshes it.
    locked.telemetry_consent = None;
    if native.expected_revision.as_deref() != Some(&locked.native_revision) {
        return fail(
            request.id,
            "Native state changed. Read get_state before requesting approval.",
        );
    }
    {
        let mut broker = state.native_approvals.lock().await;
        broker.prune();
        // Off, a browser callback or another state mutation makes an older
        // prompt unusable. Retire it so a fresh run isn't blocked for its TTL.
        broker
            .pending
            .retain(|_, p| p.session != session_key || p.revision == locked.native_revision);
        if broker.pending.values().any(|p| p.session == session_key) {
            return fail(
                request.id,
                "An approval prompt is already pending; wait or cancel it",
            );
        }
    }
    let mut projection = match locked
        .gateway
        .approval_projection(&ticket.run_id, &ticket.approval_id)
    {
        Ok(v) => v,
        Err(e) => return fail(request.id, e),
    };
    if !projection["pending"].is_object() {
        return fail(request.id, "No matching approval is pending");
    }
    if locked.gateway.persist_approval_checkpoint().await.is_err() {
        return fail(request.id, "Approval checkpoint unavailable");
    }
    projection["decision"] = Value::Null;
    let Some(receipt) = approval_service_receipt(&state, &projection).await else {
        return fail(
            request.id,
            "Approval service unavailable; no decision was submitted",
        );
    };
    if !receipt_matches(&receipt, &projection) {
        return fail(request.id, "Approval receipt identity mismatch");
    }
    if receipt["status"] != "pending" {
        // Reconcile an earlier committed decision without sending another.
        return finish(
            &mut locked,
            &native.context.conversation_id,
            &ticket,
            receipt,
            request.id,
        )
        .await;
    }
    if receipt["can_decide"] != true {
        return fail(
            request.id,
            "This approval requires its authorized reviewer on the Statewright approval page",
        );
    }
    let (reply_tx, reply_rx) = oneshot::channel();
    let nonce = uuid::Uuid::new_v4().to_string();
    let revision = uuid::Uuid::new_v4().to_string();
    {
        let mut broker = state.native_approvals.lock().await;
        if !broker.owns(transport, namespace) {
            return StatusCode::NOT_FOUND.into_response();
        }
        if broker.pending.len() >= 1024
            || broker.pending.values().any(|p| {
                p.session == session_key
                    || (p.transport == transport && p.request_id == *request.id.as_ref().unwrap())
            })
        {
            return fail(
                request.id,
                "An approval prompt is already pending; wait or cancel it",
            );
        }
        broker.pending.insert(
            nonce.clone(),
            Prompt {
                transport: transport.into(),
                session: session_key,
                request_id: request.id.clone().unwrap(),
                revision: revision.clone(),
                expires: Instant::now() + PROMPT_TTL,
                reply: reply_tx,
            },
        );
        locked.native_revision = revision.clone();
    }
    drop(locked); // Human wait never holds the workflow mutex.
    let message = format!(
        "Statewright would like your approval to move from {} to {}. {}",
        projection["pending"]["from_state"].as_str().unwrap_or("?"),
        projection["pending"]["to_state"].as_str().unwrap_or("?"),
        projection["pending"]["message"]
            .as_str()
            .unwrap_or("Review this workflow transition before continuing.")
    );
    let elicitation = json!({"jsonrpc":"2.0","id":nonce,"method":"elicitation/create","params":{
        "message":message,"requestedSchema":{"type":"object","properties":{"decision":{"type":"string","title":"Your decision","enum":["approve","reject"],"enumNames":["Approve transition","Reject transition"]}},"required":["decision"]}}});
    let (tx, rx) = mpsc::channel::<String>(2);
    let _ = tx.send(elicitation.to_string()).await;
    tokio::spawn(async move {
        let answer = tokio::time::timeout(PROMPT_TTL, reply_rx).await;
        state.native_approvals.lock().await.pending.remove(&nonce);
        let mut locked = session.lock().await;
        if matches!(answer, Ok(Ok(Answer::RpcCancel))) {
            if locked.native_revision == revision {
                locked.native_revision = uuid::Uuid::new_v4().to_string();
            }
            drop(locked);
            // RPC cancellation is not the human form's Cancel action. Retire
            // our server request and don't reply to the cancelled tool call.
            let _ = tx
                .send(
                    json!({"jsonrpc":"2.0","method":"notifications/cancelled",
                "params":{"requestId":nonce,"reason":"The originating request was cancelled"}})
                    .to_string(),
                )
                .await;
            return;
        }
        let current = locked
            .gateway
            .approval_projection(&ticket.run_id, &ticket.approval_id)
            .ok();
        let reply = if locked.native_revision != revision
            || current
                .as_ref()
                .is_none_or(|p| p["pending"] != projection["pending"])
        {
            fail(
                request.id,
                "Workflow changed while approval was open; no decision was submitted",
            )
        } else {
            match answer {
                Ok(Ok(Answer::Decision(decision))) => {
                    projection["decision"] = json!(decision);
                    // Only the bounded service call, never the human wait, is
                    // serialized with Off/callback/transition. First commit wins.
                    match approval_service_receipt(&state, &projection).await {
                        Some(receipt) if receipt_matches(&receipt, &projection) => {
                            finish(
                                &mut locked,
                                &native.context.conversation_id,
                                &ticket,
                                receipt,
                                request.id,
                            )
                            .await
                        }
                        _ => {
                            locked.native_revision = uuid::Uuid::new_v4().to_string();
                            fail(
                                request.id,
                                "Approval result unavailable. Read state and reconcile before requesting again.",
                            )
                        }
                    }
                }
                _ => {
                    locked.telemetry_consent = None;
                    locked.native_revision = uuid::Uuid::new_v4().to_string();
                    let status = match answer {
                        Ok(Ok(Answer::Cancel)) => "cancelled",
                        Ok(Ok(Answer::Invalid)) => "invalid_reply",
                        _ => "expired",
                    };
                    response(
                        native::snapshot(
                            &mut locked,
                            &native.context.conversation_id,
                            outcome(status),
                            request.id,
                        )
                        .await,
                    )
                }
            }
        };
        drop(locked);
        // A lost response does not cancel a committed decision. get_state and a
        // new request's service preflight reconcile it; no response is replayed.
        if let Ok(bytes) = axum::body::to_bytes(reply.into_body(), 1024 * 1024).await {
            let _ = tx.send(String::from_utf8_lossy(&bytes).into_owned()).await;
        }
    });
    Sse::new(ReceiverStream::new(rx).map(|data| {
        Ok::<_, std::convert::Infallible>(Event::default().event("message").data(data))
    }))
    .keep_alive(axum::response::sse::KeepAlive::default())
    .into_response()
}

async fn finish(
    session: &mut RemoteSession,
    chat: &str,
    ticket: &Ticket,
    receipt: Value,
    id: Option<Value>,
) -> Response {
    session.telemetry_consent = None;
    session.native_revision = uuid::Uuid::new_v4().to_string();
    if session
        .gateway
        .apply_approval_receipt(&ticket.run_id, &ticket.approval_id, &receipt)
        .is_err()
    {
        return fail(
            id,
            "Approval receipt could not be applied; read state before continuing",
        );
    }
    if session.gateway.persist_approval_checkpoint().await.is_err() {
        return fail(
            id,
            "Approval was resolved but its checkpoint is unavailable; do not retry the decision",
        );
    }
    response(
        native::snapshot(
            session,
            chat,
            outcome(receipt["status"].as_str().unwrap_or("unavailable")),
            id,
        )
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_and_abandoned_prompts_are_retired_without_a_decision() {
        let mut broker = Broker::default();
        let (tx, mut rx) = oneshot::channel();
        broker.pending.insert(
            "nonce".into(),
            Prompt {
                transport: "transport".into(),
                session: "chat".into(),
                request_id: json!(1),
                revision: "revision".into(),
                expires: Instant::now() - Duration::from_secs(1),
                reply: tx,
            },
        );
        broker.transports.insert(
            "transport".into(),
            Transport {
                namespace: "owner".into(),
                form: true,
                expires: Instant::now() - Duration::from_secs(1),
            },
        );
        assert!(!broker.owns("transport", "owner"));
        assert!(broker.pending.is_empty());
        assert!(matches!(
            rx.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }
}
