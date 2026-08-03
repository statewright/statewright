use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::enforcement::{self, EnforcementDecision};
use crate::interceptors::{self, PreCallDecision};
use crate::session::SessionManager;

/// Shared state for the hook HTTP server.
pub struct HookState {
    pub session_manager: SessionManager,
    pub session_id: String,
}

/// Request body for /hooks/pre-tool
#[derive(Debug, Deserialize)]
pub struct PreToolRequest {
    pub tool_name: String,
    #[serde(default)]
    pub tool_input: serde_json::Value,
}

/// Response for /hooks/pre-tool (Claude Code hook format)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreToolResponse {
    pub decision: String, // "allow" | "deny"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additional_context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
}

/// Request body for /hooks/post-tool
#[derive(Debug, Deserialize)]
pub struct PostToolRequest {
    pub tool_name: String,
    #[serde(default)]
    pub tool_response: serde_json::Value,
}

/// Response for /hooks/post-tool
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostToolResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed: Option<bool>,
}

/// Response for /hooks/state
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateResponse {
    pub state: String,
    pub is_final: bool,
    pub iteration: u32,
    pub max_iterations: Option<u32>,
    pub allowed_tools: Vec<String>,
    pub allowed_commands: Vec<String>,
    pub instructions: Option<String>,
    pub model: Option<String>,
    pub default_model: Option<String>,
    pub thinking_level: Option<String>,
    pub delivery_required: bool,
    pub additional_context: String,
}

/// Response for /hooks/stop
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopResponse {
    pub decision: String, // "allow" | "block"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additional_context: Option<String>,
}

/// Start the hook HTTP server on a random port. Returns the bound address.
pub async fn start_hook_server(
    session_manager: SessionManager,
    session_id: String,
) -> Result<SocketAddr, String> {
    let state = Arc::new(RwLock::new(HookState {
        session_manager,
        session_id,
    }));

    let app = Router::new()
        .route("/hooks/pre-tool", post(handle_pre_tool))
        .route("/hooks/post-tool", post(handle_post_tool))
        .route("/hooks/state", get(handle_state))
        .route("/hooks/stop", post(handle_stop))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind hook server: {}", e))?;

    let addr = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local addr: {}", e))?;

    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });

    Ok(addr)
}

async fn handle_pre_tool(
    State(state): State<Arc<RwLock<HookState>>>,
    Json(req): Json<PreToolRequest>,
) -> Json<PreToolResponse> {
    let state = state.read().await;
    let session = match state.session_manager.get(&state.session_id) {
        Some(s) => s,
        None => {
            return Json(PreToolResponse {
                decision: "allow".into(),
                additional_context: None,
                status_message: None,
            });
        }
    };

    let status = format!(
        "{} ({}/{})",
        session.current_state,
        session.iteration_count,
        session.max_iterations().unwrap_or(0)
    );

    match enforcement::enforce_tool_call(&session, &req.tool_name) {
        EnforcementDecision::Allow => pre_tool_policy_response(&session, &req, status, None),
        EnforcementDecision::Block { reason, .. } => Json(PreToolResponse {
            decision: "deny".into(),
            additional_context: Some(format!("BLOCKED: {}", reason)),
            status_message: Some(status),
        }),
        EnforcementDecision::ImplicitTransition { event, new_state } => {
            // Apply the transition in the session manager
            let old_state = session.current_state.clone();
            state.session_manager.update_state(
                &state.session_id,
                new_state.clone(),
                session.context.clone(),
            );
            let context = Some(format!(
                "State transitioned: {} -> {} (via {}). You are now in the {} phase.",
                old_state, new_state, event, new_state
            ));
            match state.session_manager.get(&state.session_id) {
                Some(updated) => pre_tool_policy_response(
                    &updated,
                    &req,
                    format!("{} -> {}", old_state, new_state),
                    context,
                ),
                None => Json(PreToolResponse {
                    decision: "deny".into(),
                    additional_context: Some(
                        "BLOCKED: workflow session disappeared during implicit transition".into(),
                    ),
                    status_message: Some(format!("{} -> {}", old_state, new_state)),
                }),
            }
        }
        EnforcementDecision::CheckpointReached { iteration, max } => pre_tool_policy_response(
            &session,
            &req,
            format!("{} CHECKPOINT {}/{}", session.current_state, iteration, max),
            Some(format!(
                "CHECKPOINT: You have reached iteration {}/{} in state '{}'. \
                 You MUST make your best edit now and transition to the next state \
                 using statewright_transition.",
                iteration, max, session.current_state
            )),
        ),
    }
}

fn pre_tool_policy_response(
    session: &crate::session::GatewaySession,
    req: &PreToolRequest,
    status: String,
    context: Option<String>,
) -> Json<PreToolResponse> {
    match interceptors::pre_call_check(session, &req.tool_name, &req.tool_input) {
        PreCallDecision::Allow => Json(PreToolResponse {
            decision: "allow".into(),
            additional_context: context,
            status_message: Some(status),
        }),
        PreCallDecision::Warn(warning) => Json(PreToolResponse {
            decision: "allow".into(),
            additional_context: Some(match context {
                Some(context) => format!("{} {}", context, warning),
                None => warning,
            }),
            status_message: Some(status),
        }),
        PreCallDecision::Block(reason) => Json(PreToolResponse {
            decision: "deny".into(),
            additional_context: Some(match context {
                Some(context) => format!("{} BLOCKED: {}", context, reason),
                None => format!("BLOCKED: {}", reason),
            }),
            status_message: Some(status),
        }),
    }
}

async fn handle_post_tool(
    State(state): State<Arc<RwLock<HookState>>>,
    Json(_req): Json<PostToolRequest>,
) -> Json<PostToolResponse> {
    let state = state.read().await;
    state.session_manager.increment_iteration(&state.session_id);

    let session = match state.session_manager.get(&state.session_id) {
        Some(s) => s,
        None => {
            return Json(PostToolResponse {
                status_message: Some("unknown".into()),
                transition: None,
                completed: None,
            });
        }
    };

    let status = format!(
        "{} ({}/{})",
        session.current_state,
        session.iteration_count,
        session.max_iterations().unwrap_or(0)
    );

    // Detect if a transition happened since the last post-tool call
    // (e.g., via MCP statewright_transition or implicit transition in pre-tool)
    let transition = session
        .previous_state
        .as_ref()
        .map(|prev| format!("{} => {}", prev, session.current_state));

    let completed = if session.is_final() { Some(true) } else { None };

    Json(PostToolResponse {
        status_message: Some(status),
        transition,
        completed,
    })
}

async fn handle_state(State(state): State<Arc<RwLock<HookState>>>) -> Json<StateResponse> {
    let state = state.read().await;
    let session = match state.session_manager.get(&state.session_id) {
        Some(s) => s,
        None => {
            return Json(StateResponse {
                state: "unknown".into(),
                is_final: false,
                iteration: 0,
                max_iterations: None,
                allowed_tools: vec![],
                allowed_commands: vec![],
                instructions: None,
                model: None,
                default_model: None,
                thinking_level: None,
                delivery_required: false,
                additional_context: "No active session".into(),
            });
        }
    };

    let state_def = session.definition.states.get(&session.current_state);
    let allowed_tools = state_def
        .and_then(|s| s.allowed_tools.as_ref())
        .cloned()
        .unwrap_or_default();
    let allowed_commands = state_def
        .and_then(|s| s.allowed_commands.as_ref())
        .cloned()
        .unwrap_or_default();
    let instructions = state_def.and_then(|s| s.instructions.as_ref()).cloned();
    let default_model = session
        .definition
        .meta
        .as_ref()
        .and_then(|meta| meta.default_model.as_ref())
        .cloned();
    let model = state_def
        .and_then(|definition| definition.model.as_ref())
        .cloned()
        .or_else(|| default_model.clone());
    let thinking_level = state_def
        .and_then(|definition| definition.thinking_level.as_ref())
        .cloned();
    let delivery_required = session.definition.meta.as_ref().is_some_and(|meta| {
        meta.workspace
            .as_ref()
            .is_some_and(|policy| policy.required)
            || meta.preview.as_ref().is_some_and(|policy| policy.required)
            || meta
                .promotion
                .as_ref()
                .is_some_and(|policy| policy.required)
    });

    let context = format!(
        "Statewright state machine active. Current state: {}. \
         Available tools: {}. Iteration: {}/{}.",
        session.current_state,
        allowed_tools.join(", "),
        session.iteration_count,
        session.max_iterations().unwrap_or(0),
    );

    Json(StateResponse {
        state: session.current_state.clone(),
        is_final: session.is_final(),
        iteration: session.iteration_count,
        max_iterations: session.max_iterations(),
        allowed_tools,
        allowed_commands,
        instructions,
        model,
        default_model,
        thinking_level,
        delivery_required,
        additional_context: context,
    })
}

async fn handle_stop(State(state): State<Arc<RwLock<HookState>>>) -> Json<StopResponse> {
    let state = state.read().await;
    let session = match state.session_manager.get(&state.session_id) {
        Some(s) => s,
        None => {
            return Json(StopResponse {
                decision: "allow".into(),
                additional_context: None,
            });
        }
    };

    if session.is_final() {
        Json(StopResponse {
            decision: "allow".into(),
            additional_context: None,
        })
    } else {
        Json(StopResponse {
            decision: "block".into(),
            additional_context: Some(format!(
                "Task is not complete. Current state: '{}'. \
                 You need to continue working or transition to a final state \
                 (completed/failed) using statewright_transition.",
                session.current_state
            )),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use statewright_engine::MachineDefinition;

    fn hook_state() -> Arc<RwLock<HookState>> {
        let definition: MachineDefinition = serde_json::from_value(json!({
            "id": "hook-policy-test",
            "initial": "active",
            "states": {
                "active": {
                    "allowed_tools": ["bash"],
                    "allowed_commands": ["gh"],
                    "on": { "DONE": "completed" }
                },
                "completed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();
        let manager = SessionManager::new();
        manager.create("test-session".into(), definition);
        Arc::new(RwLock::new(HookState {
            session_manager: manager,
            session_id: "test-session".into(),
        }))
    }

    #[tokio::test]
    async fn pre_tool_applies_allowed_command_policy_to_tool_input() {
        let blocked = handle_pre_tool(
            State(hook_state()),
            Json(PreToolRequest {
                tool_name: "bash".into(),
                tool_input: json!({"command": "ghpr list"}),
            }),
        )
        .await
        .0;
        assert_eq!(blocked.decision, "deny");
        assert!(
            blocked
                .additional_context
                .as_deref()
                .unwrap_or_default()
                .contains("not in the allowed commands")
        );

        let allowed = handle_pre_tool(
            State(hook_state()),
            Json(PreToolRequest {
                tool_name: "bash".into(),
                tool_input: json!({"command": "gh pr list"}),
            }),
        )
        .await
        .0;
        assert_eq!(allowed.decision, "allow");
    }

    #[tokio::test]
    async fn state_exposes_routing_and_required_delivery_policy() {
        let definition: MachineDefinition = serde_json::from_value(json!({
            "id": "hook-routing-test",
            "initial": "active",
            "meta": {
                "default_model": "anthropic/claude-sonnet-4-6",
                "workspace": {
                    "version": 1,
                    "mode": "git_worktree",
                    "required": true,
                    "cleanup": "after_promoted"
                }
            },
            "states": {
                "active": {
                    "allowed_tools": ["Read"],
                    "model": "openai/gpt-5.6-terra",
                    "thinking_level": "medium",
                    "on": { "DONE": "completed" }
                },
                "completed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();
        let manager = SessionManager::new();
        manager.create("routing-session".into(), definition);
        let state = Arc::new(RwLock::new(HookState {
            session_manager: manager,
            session_id: "routing-session".into(),
        }));

        let response = handle_state(State(state)).await.0;

        assert_eq!(response.model.as_deref(), Some("openai/gpt-5.6-terra"));
        assert_eq!(
            response.default_model.as_deref(),
            Some("anthropic/claude-sonnet-4-6")
        );
        assert_eq!(response.thinking_level.as_deref(), Some("medium"));
        assert!(response.delivery_required);
    }
}
