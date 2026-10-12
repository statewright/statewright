//! Versioned native-host conversation lane. No credential or human decision is
//! accepted in a tool argument. The authorization service owns the principal;
//! the trusted host supplies the conversation namespace on every call.
use super::*;
use crate::protocol::{ToolAnnotations, ToolCallResult, ToolInfo};
use serde_json::{Value, json};

pub(super) const TOOL: &str = "statewright_native_request";

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Identity {
    version: u32,
    principal: String,
    client_id: String,
    resource: String,
}
impl Identity {
    pub(super) fn valid(&self, resource: &str, owner: &str, client: &str) -> bool {
        self.version == 1
            && !owner.is_empty()
            && client == "statewright-claude"
            && self.client_id == client
            && self.resource == resource
            && self.principal.len() == 64
            && self
                .principal
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    }
    fn namespace(&self, issuer: &str, owner: &str) -> String {
        let tuple = json!([
            "statewright-native-v1",
            issuer,
            owner,
            self.resource,
            self.client_id,
            self.principal
        ]);
        format!(
            "native_{}",
            uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, tuple.to_string().as_bytes())
        )
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Context {
    version: u32,
    conversation_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    context: Context,
    operation: String,
    input: Value,
    expected_revision: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Load {
    name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Transition {
    event: String,
    #[serde(default)]
    data: Option<serde_json::Map<String, Value>>,
}

fn valid_label(value: &str) -> bool {
    !value.is_empty() && value.len() <= 200 && !value.chars().any(char::is_control)
}
fn parse(arguments: Value) -> Result<(Request, &'static str), &'static str> {
    let request: Request =
        serde_json::from_value(arguments).map_err(|_| "Invalid native request")?;
    if request.context.version != 1
        || uuid::Uuid::parse_str(&request.context.conversation_id)
            .ok()
            .is_none_or(|id| id.is_nil() || id.to_string() != request.context.conversation_id)
    {
        return Err("Invalid native conversation context");
    }
    let tool = match request.operation.as_str() {
        "get_state" | "deactivate" if request.input == json!({}) => {
            if request.operation == "get_state" {
                "statewright_get_state"
            } else {
                "statewright_deactivate"
            }
        }
        "load_workflow" => {
            let input: Load = serde_json::from_value(request.input.clone())
                .map_err(|_| "Invalid workflow input")?;
            if !valid_label(&input.name) {
                return Err("Invalid workflow name");
            }
            "statewright_load_workflow"
        }
        "transition" => {
            let input: Transition = serde_json::from_value(request.input.clone())
                .map_err(|_| "Invalid transition input")?;
            if !valid_label(&input.event) {
                return Err("Invalid transition event");
            }
            let _ = input.data;
            "statewright_transition"
        }
        _ => return Err("Unsupported native operation or input"),
    };
    if tool != "statewright_get_state"
        && request
            .expected_revision
            .as_deref()
            .is_none_or(|value| uuid::Uuid::parse_str(value).is_err())
    {
        return Err("Mutation requires the current native revision");
    }
    Ok((request, tool))
}

pub(super) fn definition() -> ToolInfo {
    ToolInfo { name: TOOL.into(), annotations: Some(ToolAnnotations { read_only_hint: Some(false),
        destructive_hint: Some(false), idempotent_hint: Some(false), open_world_hint: Some(false), ..Default::default() }),
        description: Some("Versioned native workspace control. The host supplies its current conversation context. No human approval or arbitrary tool execution is accepted. Read get_state before a mutation; never retry a mutation without readback.".into()),
        input_schema: json!({"type":"object","additionalProperties":false,
          "properties": {"context":{"type":"object","additionalProperties":false,
            "properties":{"version":{"type":"integer","enum":[1]},"conversation_id":{"type":"string","format":"uuid"}},
            "required":["version","conversation_id"]},
          "operation":{"type":"string","enum":["get_state","load_workflow","transition","deactivate"]},
          "input":{"type":"object"},"expected_revision":{"type":["string","null"]}},
          "required":["context","operation","input"]}) }
}

// Native discovery is independent of an active workflow or nonempty catalog.
// This permits reconnect/readback/deactivation after the last entry is removed.
pub(super) fn discovery(
    validated: &FetchResult,
    resource: &str,
    request: JsonRpcRequest,
) -> Option<JsonRpcResponse> {
    let result = match request.method.as_str() {
        "initialize" => Gateway::initialization_result(true),
        "notifications/initialized" | "notifications/cancelled" => return None,
        "ping" => json!({}),
        "tools/list" => {
            let mut tools: Vec<_> = crate::custom_tools::custom_tool_definitions()
                .into_iter()
                .filter(|tool| tool.name == "statewright_list_workflows")
                .collect();
            if validated.native_session.as_ref().is_some_and(|identity| {
                identity.valid(resource, &validated.owner_id, &validated.oauth_client_id)
            }) {
                tools.push(definition());
            }
            json!({"tools":tools})
        }
        "tools/call"
            if request.params.as_ref().is_some_and(|params| {
                params["name"] == "statewright_list_workflows"
                    && params
                        .get("arguments")
                        .is_none_or(|args| args == &json!({}))
            }) =>
        {
            let mut names: Vec<_> = validated.workflows.keys().collect();
            names.sort();
            let native_control = validated
                .native_session
                .as_ref()
                .filter(|identity| {
                    identity.valid(resource, &validated.owner_id, &validated.oauth_client_id)
                })
                .map(|_| json!({"version":1}));
            serde_json::to_value(ToolCallResult::text(
                json!({"workflows":names,"active":null,"native_control":native_control})
                    .to_string(),
            ))
            .unwrap()
        }
        _ => {
            return Some(JsonRpcResponse::error(
                request.id,
                -32602,
                "Native workflow calls require statewright_native_request conversation context",
            ));
        }
    };
    Some(JsonRpcResponse::success(request.id, result))
}

async fn invoke(gateway: &mut Gateway, tool: &str, input: Value) -> Value {
    gateway
        .handle_message(JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            id: Some(json!("native")),
            params: Some(json!({"name":tool,"arguments":input})),
        })
        .await
        .and_then(|reply| reply.result)
        .unwrap_or_else(|| json!({"isError":true,"content":[]}))
}
fn decoded_state(result: &Value) -> Result<Value, &'static str> {
    let text = result["content"][0]["text"]
        .as_str()
        .ok_or("Native state unavailable")?;
    if text == "No active workflow. Load a workflow before requesting state." {
        return Ok(Value::Null);
    }
    let state: Value = serde_json::from_str(text).map_err(|_| "Invalid native state")?;
    if result["isError"] == true || !state.is_object() {
        return Err("Native state unavailable");
    }
    Ok(state)
}

pub(super) async fn handle(
    state: &RemoteState,
    validated: FetchResult,
    resource: &str,
    request: JsonRpcRequest,
) -> JsonRpcResponse {
    let fail = |message: &str| JsonRpcResponse::error(request.id.clone(), -32602, message);
    if request.id.is_none() || request.id == Some(Value::Null) {
        return fail("Native operations require a request ID");
    }
    let Some(identity) = validated.native_session.filter(|identity| {
        identity.valid(resource, &validated.owner_id, &validated.oauth_client_id)
    }) else {
        return fail("Authenticated native conversation identity unavailable");
    };
    let arguments = request
        .params
        .as_ref()
        .and_then(|p| p.get("arguments"))
        .cloned()
        .unwrap_or(Value::Null);
    let (native, tool) = match parse(arguments) {
        Ok(value) => value,
        Err(error) => return fail(error),
    };
    let namespace = identity.namespace(&state.authorization_server_url, &validated.owner_id);
    let session_key = format!("{}__{}", namespace, native.context.conversation_id);
    let manager = state.get_session_manager(&namespace).await;
    // Only synchronous creation occurs while publishing. No exists/create race:
    // losing first requests cannot reset the winning conversation's machine.
    let session = {
        let mut sessions = state.sessions.write().await;
        if let Some(session) = sessions.get(&session_key) {
            session.clone()
        } else {
            if let Some(definition) = validated.workflows.get(&validated.default).cloned() {
                manager.create(session_key.clone(), definition);
            }
            if let Some(limit) = validated.plan_limit {
                manager.set_plan_limit(&session_key, limit);
            }
            let mut gateway = Gateway::new(
                manager,
                UpstreamManager::empty(),
                session_key.clone(),
                validated.workflows.clone(),
                None,
                validated.owner_id,
                state.db_pool.clone(),
            );
            gateway.set_remote_host_model_control(true);
            let (tx, _rx) = mpsc::channel(1);
            let session = Arc::new(Mutex::new(RemoteSession {
                gateway,
                tx,
                resource: resource.into(),
                native_revision: uuid::Uuid::new_v4().to_string(),
            }));
            sessions.insert(session_key, session.clone());
            session
        }
    };
    let mut session = session.lock().await;
    // An empty-catalog conversation has no machine yet. Seed it once a current
    // definition exists so load_workflow preserves the authenticated plan limit.
    let machine_id = session.gateway.session_id().to_string();
    if !session.gateway.session_manager.exists(&machine_id) {
        if let Some(definition) = validated.workflows.get(&validated.default).cloned() {
            session
                .gateway
                .session_manager
                .create(machine_id.clone(), definition);
        }
    }
    if let Some(limit) = validated.plan_limit {
        session
            .gateway
            .session_manager
            .set_plan_limit(&machine_id, limit);
    }
    session.gateway.refresh_native_catalog(validated.workflows);
    if tool != "statewright_get_state"
        && native.expected_revision.as_deref() != Some(&session.native_revision)
    {
        return fail("Native state changed. Read get_state before deciding the next action.");
    }
    let before = match decoded_state(
        &invoke(&mut session.gateway, "statewright_get_state", json!({})).await,
    ) {
        Ok(value) => value,
        Err(error) => return fail(error),
    };
    // Loading another workflow must never silently abandon an active run or its
    // pending approval. Deactivation remains an explicit owner-controlled action.
    if tool == "statewright_load_workflow" && !before.is_null() && before["is_final"] != true {
        return fail("A workflow is already active in this conversation");
    }
    let outcome = if tool == "statewright_get_state" {
        Value::Null
    } else {
        let result = invoke(&mut session.gateway, tool, native.input).await;
        if tool == "statewright_deactivate" && result["isError"] != true {
            // A late authenticated browser callback must not advance a run the
            // owner has stopped. Retire its exact pending transition as well.
            session
                .gateway
                .session_manager
                .clear_pending_approval(&session.gateway.session_id());
        }
        // Even a failed/ambiguous mutation consumes the revision. Require readback
        // rather than blindly replaying a possibly accepted operation.
        session.native_revision = uuid::Uuid::new_v4().to_string();
        result
    };
    let current = match decoded_state(
        &invoke(&mut session.gateway, "statewright_get_state", json!({})).await,
    ) {
        Ok(value) => value,
        Err(error) => return fail(error),
    };
    let result = json!({"protocol_version":1,"conversation_id":native.context.conversation_id,
        "revision":session.native_revision,"state":current,"outcome":outcome,
        "capabilities":{"workflow_control":true,"native_tool_enforcement":false,"human_approval":false,"model_routing":false}});
    JsonRpcResponse::success(
        request.id,
        serde_json::to_value(ToolCallResult::text(result.to_string())).unwrap(),
    )
}
