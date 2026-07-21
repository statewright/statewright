use serde_json::json;
use statewright_engine::resolve_transition;

use crate::protocol::ToolInfo;
use crate::session::GatewaySession;

/// Handle the statewright_transition tool call.
/// Returns the new state info on success, or an error message.
pub fn handle_transition(
    session: &mut GatewaySession,
    event: &str,
) -> Result<serde_json::Value, String> {
    if session.is_final() {
        return Err(format!(
            "Cannot transition: state machine is in final state '{}'.",
            session.current_state
        ));
    }

    match resolve_transition(
        &session.current_state,
        event,
        &json!({}),
        &session.context,
        &session.definition,
    ) {
        Ok(result) if result.transitioned => {
            let old_state = session.current_state.clone();

            // Invoke transition: don't advance parent state — sub-machine must run first.
            // The engine sets new_state = on_complete (via target()), but the client must
            // drive the named sub-machine to completion before the parent can advance there.
            // Returning early without mutating session keeps the parent in its current state.
            if let Some(ref invoke) = result.invoke {
                let (used, limit, _pct) = session.usage();
                let mut invoke_response = json!({
                    "transitioned": true,
                    "from": old_state,
                    "to": invoke.on_complete,
                    "requires_approval": result.requires_approval,
                    "approval_message": result.approval_message,
                    "transition_count": session.transition_count,
                    "usage": {
                        "transitions": used,
                        "limit": limit,
                        "remaining": limit.map(|l| l.saturating_sub(used)),
                    },
                    "invoke": {
                        "machine": invoke.machine,
                        "on_complete": invoke.on_complete,
                        "on_fail": invoke.on_fail,
                        "input": invoke.input,
                    },
                });
                if let Some(warning) = session.usage_warning() {
                    invoke_response["usage"]["warning"] = json!(warning);
                }
                return Ok(invoke_response);
            }

            session.current_state = result.new_state.clone();
            session.context = result.new_context;
            session.iteration_count = 0;
            // Note: transition_count is incremented by SessionManager::update_state, not here

            let (used, limit, _pct) = session.usage();
            let mut response = json!({
                "transitioned": true,
                "from": old_state,
                "to": result.new_state,
                "requires_approval": result.requires_approval,
                "approval_message": result.approval_message,
                "transition_count": session.transition_count,
                "usage": {
                    "transitions": used,
                    "limit": limit,
                    "remaining": limit.map(|l| l.saturating_sub(used)),
                },
            });

            if let Some(warning) = session.usage_warning() {
                response["usage"]["warning"] = json!(warning);
            }

            // Include fork info if this transition forks
            if let Some(ref fork) = result.fork {
                let branches: serde_json::Value = fork.branches.iter()
                    .map(|(name, def)| {
                        (name.clone(), json!({
                            "initial": def.initial,
                            "terminal": def.terminal,
                        }))
                    })
                    .collect::<serde_json::Map<String, serde_json::Value>>()
                    .into();
                response["fork"] = json!({
                    "branches": branches,
                    "join": match fork.join {
                        statewright_engine::JoinStrategy::All => "all",
                        statewright_engine::JoinStrategy::Any => "any",
                    },
                    "on_complete": fork.on_complete,
                    "on_fail": fork.on_fail,
                });
            }

            Ok(response)
        }
        Ok(_) => {
            // Guard failed — transition not taken
            Err(format!(
                "Transition '{}' from state '{}' was blocked by a guard condition.",
                event, session.current_state
            ))
        }
        Err(e) => {
            // Engine already handles safe_next internally — if we get here,
            // the event truly has no transition (and no safe_next fallback).
            Err(format!(
                "No transition for event '{}' in state '{}': {}",
                event, session.current_state, e
            ))
        }
    }
}

/// Handle the statewright_get_state tool call.
pub fn handle_get_state(session: &GatewaySession) -> serde_json::Value {
    let state_def = session.definition.states.get(&session.current_state);

    let allowed_tools = state_def
        .and_then(|s| s.allowed_tools.as_ref())
        .cloned()
        .unwrap_or_default();

    let transitions: Vec<serde_json::Value> = state_def
        .map(|s| {
            s.on
                .iter()
                .map(|(event, def)| {
                    json!({
                        "event": event,
                        "target": def.target(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let instructions = state_def.and_then(|s| s.instructions.as_ref()).cloned();
    let max_iterations = state_def.and_then(|s| s.max_iterations);
    let allowed_commands = state_def.and_then(|s| s.allowed_commands.as_ref()).cloned();
    let disallowed_tools = state_def.and_then(|s| s.disallowed_tools.as_ref()).cloned();
    let blocked_env = state_def.and_then(|s| s.blocked_env.as_ref()).cloned();
    let env_overrides = state_def.and_then(|s| s.env_overrides.as_ref()).cloned();
    let thinking_level = state_def.and_then(|s| s.thinking_level.as_ref()).cloned();
    let direct_execution = state_def.and_then(|s| s.direct_execution).unwrap_or(false);
    let model_ladder = state_def.and_then(|s| s.model_ladder.as_ref()).cloned();

    // Include guard definitions for transitions that use them
    let guard_info: serde_json::Value = state_def
        .and_then(|s| {
            let guard_names: Vec<String> = s.on.values()
                .flat_map(|t| match t {
                    statewright_engine::TransitionDef::Guarded(branches) => {
                        branches.iter().filter_map(|b| b.guard.clone()).collect::<Vec<_>>()
                    }
                    _ => t.guard_names().iter().map(|s| s.to_string()).collect(),
                })
                .collect();
            if guard_names.is_empty() { return None; }
            let guards: serde_json::Map<String, serde_json::Value> = guard_names.iter()
                .filter_map(|name| {
                    session.definition.guards.get(name.as_str())
                        .map(|g| (name.clone(), serde_json::to_value(g).unwrap_or_default()))
                })
                .collect();
            if guards.is_empty() { None } else { Some(serde_json::Value::Object(guards)) }
        })
        .unwrap_or(serde_json::Value::Null);

    let default_model = session.definition.meta.as_ref()
        .and_then(|m| m.default_model.as_ref());
    let state_model = state_def.and_then(|s| s.model.as_ref());
    let model = state_model.or(default_model).cloned();

    let mut response = json!({
        "state": session.current_state,
        "is_final": session.is_final(),
        "allowed_tools": allowed_tools,
        "transitions": transitions,
        "iteration": session.iteration_count,
        "max_iterations": max_iterations,
        "instructions": instructions,
        "model": model,
        "default_model": default_model,
        "thinking_level": thinking_level,
        "transition_count": session.transition_count,
        "blocked_env": blocked_env,
        "env_overrides": env_overrides,
        "context": session.context,
        "guards": guard_info,
        "meta": session.definition.meta,
        "allowed_commands": allowed_commands,
        "disallowed_tools": disallowed_tools,
        "direct_execution": direct_execution,
        "model_ladder": model_ladder,
    });

    // Include interrupt definitions for client-side detection (built-in tools)
    if !session.definition.interrupts.is_empty() {
        let interrupts: serde_json::Value = session.definition.interrupts.iter()
            .map(|(name, def)| {
                (name.clone(), json!({
                    "file_pattern": def.trigger.file_pattern,
                    "target": def.target,
                }))
            })
            .collect::<serde_json::Map<String, serde_json::Value>>()
            .into();
        response["interrupts"] = interrupts;
    }

    if let Some(pending) = &session.pending_approval {
        response["pending_approval"] = json!({
            "approval_id": pending.approval_id,
            "event": pending.event,
            "from_state": pending.from_state,
            "to_state": pending.to_state,
            "message": pending.message,
        });
    }

    if let Some(return_state) = session.context.get("_interrupt_return").and_then(|v| v.as_str()) {
        response["interrupt_handler"] = json!({
            "return_state": return_state,
            "message": "You are in an interrupt handler. Complete validation and transition to return.",
        });
    }

    response
}

/// Return tool definitions for the custom statewright tools.
pub fn custom_tool_definitions() -> Vec<ToolInfo> {
    vec![
        ToolInfo {
            name: "statewright_transition".into(),
            description: Some(
                "Transition the state machine to a new state by emitting an event.".into(),
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "event": {
                        "type": "string",
                        "description": "The transition event name (e.g., DONE, FAIL, PLAN_READY)"
                    },
                    "data": {
                        "type": "object",
                        "description": "Optional context data merged after the transition completes. Available for guard evaluation on subsequent transitions, not the current one."
                    }
                },
                "required": ["event"]
            }),
        },
        ToolInfo {
            name: "statewright_get_state".into(),
            description: Some(
                "Get the current state machine state, available tools, transitions, and iteration count.".into(),
            ),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
        },
        ToolInfo {
            name: "statewright_list_workflows".into(),
            description: Some(
                "List all available named workflows and which one is currently active.".into(),
            ),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
        },
        ToolInfo {
            name: "statewright_load_workflow".into(),
            description: Some(
                "Load a named workflow, resetting the state machine to the workflow's initial state.".into(),
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The workflow name to load (e.g., bugfix, etl-pipeline)"
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Client session identifier for per-session state isolation"
                    },
                    "project_id": {
                        "type": "string",
                        "description": "Project identifier (cwd hash) for per-project run scoping"
                    },
                    "stitch_id": {
                        "type": "string",
                        "description": "Optional task-level lineage ID. Generated automatically for [stitch] workflows."
                    },
                    "task_intent": {
                        "type": "string",
                        "description": "Optional bounded task intent stored with a newly generated stitch."
                    },
                    "resume": {
                        "type": "boolean",
                        "description": "Resume from the last paused run of this workflow instead of starting fresh"
                    },
                    "branch": {
                        "type": "string",
                        "description": "Connect to a specific fork branch session (for parallel sub-agents)"
                    }
                },
                "required": ["name"]
            }),
        },
        ToolInfo {
            name: "statewright_pause".into(),
            description: Some(
                "Pause the current workflow. State and context are saved. Resume later with statewright_load_workflow(name, resume=true).".into(),
            ),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
        },
        ToolInfo {
            name: "statewright_deactivate".into(),
            description: Some(
                "Deactivate workflow enforcement. All tools pass through without restriction.".into(),
            ),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
        },
        ToolInfo {
            name: "statewright_get_status".into(),
            description: Some(
                "Get gateway status: active workflow, current state, available workflows.".into(),
            ),
            input_schema: json!({
                "type": "object",
                "properties": {}
            }),
        },
        ToolInfo {
            name: "statewright_search_references".into(),
            description: Some(
                "Search the local repository reference index with deterministic lexical ranking. Plugin clients return read-only provenance, source hashes, rank reasons, and bounded excerpts.".into(),
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Task, identifier, path, failed hypothesis, or validation signature to find"
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 20,
                        "default": 8
                    }
                },
                "required": ["query"]
            }),
        },
        ToolInfo {
            name: "statewright_create_workflow".into(),
            description: Some(
                "Create a new workflow from a JSON definition. Schema at https://statewright.ai/workflow-schema.json".into(),
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Workflow name (lowercase, hyphens, e.g. 'data-pipeline')"
                    },
                    "definition": {
                        "type": "object",
                        "description": "Full workflow definition matching the schema at /workflow-schema.json"
                    },
                    "overwrite": {
                        "type": "boolean",
                        "description": "If true, overwrite an existing workflow with the same name"
                    }
                },
                "required": ["name", "definition"]
            }),
        },
        ToolInfo {
            name: "statewright_run_agent".into(),
            description: Some(
                "Run a state-machine-constrained agent to fix bugs or build features. Spawns the Rust agent executor and streams progress.".into(),
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "What to fix or build"
                    },
                    "model": {
                        "type": "string",
                        "description": "Ollama model to use (default: gemma4:31b)"
                    },
                    "workflow": {
                        "type": "string",
                        "description": "State machine workflow name (default: bugfix-v2)"
                    },
                    "workdir": {
                        "type": "string",
                        "description": "Working directory (default: current directory)"
                    }
                },
                "required": ["task"]
            }),
        },
        ToolInfo {
            name: "statewright_get_model_traits".into(),
            description: Some(
                "Get model behavioral traits from the registry. Returns tool_mode, reasoning support, context limits, and other characteristics the agent should use to configure itself for the given model.".into(),
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "model": {
                        "type": "string",
                        "description": "Model tag (e.g., qwen3:8b, devstral-small-2:24b). If omitted, returns the full registry."
                    }
                }
            }),
        },
    ]
}

/// Force-state tool definition, gated on meta.debug.
pub fn force_state_tool_definition() -> ToolInfo {
    ToolInfo {
        name: "statewright_force_state".into(),
        description: Some(
            "Force the state machine to a specific state, bypassing guards and transitions. Debug mode only.".into(),
        ),
        input_schema: json!({
            "type": "object",
            "properties": {
                "state": {
                    "type": "string",
                    "description": "Target state name to jump to"
                },
                "context": {
                    "type": "object",
                    "description": "Optional context to set (merged with existing context)"
                }
            },
            "required": ["state"]
        }),
    }
}

/// Check if a tool name is a custom statewright tool.
pub fn is_custom_tool(name: &str) -> bool {
    matches!(
        name,
        "statewright_transition"
            | "statewright_get_state"
            | "statewright_list_workflows"
            | "statewright_load_workflow"
            | "statewright_deactivate"
            | "statewright_pause"
            | "statewright_get_status"
            | "statewright_search_references"
            | "statewright_create_workflow"
            | "statewright_force_state"
            | "statewright_run_agent"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use statewright_engine::MachineDefinition;

    fn test_definition() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "test",
            "initial": "planning",
            "states": {
                "planning": {
                    "allowed_tools": ["read_file", "grep"],
                    "instructions": "Read files and plan your approach.",
                    "max_iterations": 5,
                    "safe_next": "implementing",
                    "on": { "READY": "implementing", "FAIL": "failed" }
                },
                "implementing": {
                    "allowed_tools": ["read_file", "edit_file"],
                    "max_iterations": 10,
                    "on": { "DONE": "completed", "FAIL": "failed" }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap()
    }

    fn new_session() -> GatewaySession {
        GatewaySession::new("test".into(), test_definition())
    }

    #[test]
    fn transition_advances_state() {
        let mut session = new_session();
        assert_eq!(session.current_state, "planning");

        let result = handle_transition(&mut session, "READY").unwrap();
        assert_eq!(result["to"], "implementing");
        assert_eq!(session.current_state, "implementing");
        assert_eq!(session.iteration_count, 0);
        // transition_count is incremented by SessionManager::update_state, not handle_transition
        assert_eq!(session.transition_count, 0);
    }

    #[test]
    fn transition_to_final_state() {
        let mut session = new_session();
        handle_transition(&mut session, "READY").unwrap();
        handle_transition(&mut session, "DONE").unwrap();
        assert_eq!(session.current_state, "completed");
        assert!(session.is_final());
    }

    #[test]
    fn transition_from_final_state_errors() {
        let mut session = new_session();
        handle_transition(&mut session, "READY").unwrap();
        handle_transition(&mut session, "DONE").unwrap();

        let result = handle_transition(&mut session, "RESTART");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("final state"));
    }

    #[test]
    fn unrecognized_event_uses_safe_next() {
        let mut session = new_session();
        // planning has safe_next: "implementing"
        // The engine handles safe_next internally — returns Ok(transitioned)
        let result = handle_transition(&mut session, "UNKNOWN_EVENT").unwrap();
        assert_eq!(result["to"], "implementing");
        assert_eq!(result["transitioned"], true);
        assert_eq!(session.current_state, "implementing");
    }

    #[test]
    fn unrecognized_event_without_safe_next_errors() {
        let mut session = new_session();
        handle_transition(&mut session, "READY").unwrap();
        // implementing has no safe_next
        let result = handle_transition(&mut session, "UNKNOWN_EVENT");
        assert!(result.is_err());
    }

    #[test]
    fn get_state_returns_correct_info() {
        let session = new_session();
        let state = handle_get_state(&session);

        assert_eq!(state["state"], "planning");
        assert_eq!(state["is_final"], false);
        assert_eq!(state["iteration"], 0);
        assert_eq!(state["max_iterations"], 5);
        assert_eq!(state["instructions"], "Read files and plan your approach.");

        let tools: Vec<String> = serde_json::from_value(state["allowed_tools"].clone()).unwrap();
        assert!(tools.contains(&"read_file".to_string()));
        assert!(tools.contains(&"grep".to_string()));

        let transitions = state["transitions"].as_array().unwrap();
        assert!(transitions.iter().any(|t| t["event"] == "READY"));
    }

    #[test]
    fn get_state_after_transition() {
        let mut session = new_session();
        handle_transition(&mut session, "READY").unwrap();
        session.iteration_count = 3;

        let state = handle_get_state(&session);
        assert_eq!(state["state"], "implementing");
        assert_eq!(state["iteration"], 3);
        assert_eq!(state["max_iterations"], 10);
    }

    #[test]
    fn custom_tool_definitions_has_all_tools() {
        let tools = custom_tool_definitions();
        assert_eq!(tools.len(), 11);
        assert!(tools.iter().any(|t| t.name == "statewright_transition"));
        assert!(tools.iter().any(|t| t.name == "statewright_get_state"));
        assert!(tools.iter().any(|t| t.name == "statewright_list_workflows"));
        assert!(tools.iter().any(|t| t.name == "statewright_load_workflow"));
        assert!(tools.iter().any(|t| t.name == "statewright_deactivate"));
        assert!(tools.iter().any(|t| t.name == "statewright_get_status"));
        assert!(
            tools
                .iter()
                .any(|t| t.name == "statewright_search_references")
        );
        assert!(tools.iter().any(|t| t.name == "statewright_run_agent"));
        assert!(tools.iter().any(|t| t.name == "statewright_get_model_traits"));
    }

    #[test]
    fn is_custom_tool_identifies_correctly() {
        assert!(is_custom_tool("statewright_transition"));
        assert!(is_custom_tool("statewright_get_state"));
        assert!(is_custom_tool("statewright_list_workflows"));
        assert!(is_custom_tool("statewright_load_workflow"));
        assert!(is_custom_tool("statewright_deactivate"));
        assert!(is_custom_tool("statewright_get_status"));
        assert!(is_custom_tool("statewright_search_references"));
        assert!(is_custom_tool("statewright_create_workflow"));
        assert!(!is_custom_tool("read_file"));
        assert!(!is_custom_tool("statewright_other"));
    }

    #[test]
    fn transition_resets_iteration_count() {
        let mut session = new_session();
        session.iteration_count = 4;
        handle_transition(&mut session, "READY").unwrap();
        assert_eq!(session.iteration_count, 0);
    }

    // --- Approval gate tests ---

    fn approval_definition() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "approval-test",
            "initial": "working",
            "meta": {
                "approval_mode": "ui"
            },
            "states": {
                "working": {
                    "allowed_tools": ["read_file"],
                    "on": {
                        "DEPLOY": {
                            "target": "deployed",
                            "requires_approval": true,
                            "approval_message": "Review changes before deploy"
                        },
                        "DONE": "completed"
                    }
                },
                "deployed": {
                    "on": { "VERIFIED": "completed" }
                },
                "completed": { "type": "final" }
            }
        }))
        .unwrap()
    }

    #[test]
    fn transition_with_requires_approval_returns_flag() {
        let mut session = GatewaySession::new("test".into(), approval_definition());
        let result = handle_transition(&mut session, "DEPLOY").unwrap();
        assert_eq!(result["requires_approval"], true);
        // Session advanced (handle_transition mutates the clone)
        assert_eq!(session.current_state, "deployed");
    }

    #[test]
    fn transition_without_approval_has_false_flag() {
        let mut session = GatewaySession::new("test".into(), approval_definition());
        let result = handle_transition(&mut session, "DONE").unwrap();
        assert_eq!(result["requires_approval"], false);
    }

    #[test]
    fn get_state_includes_pending_approval_when_set() {
        let mut session = GatewaySession::new("test".into(), approval_definition());
        session.pending_approval = Some(crate::session::PendingApproval {
            approval_id: "apr_test".into(),
            event: "DEPLOY".into(),
            from_state: "working".into(),
            to_state: "deployed".into(),
            new_context: json!({}),
            message: Some("Review changes".into()),
        });
        let state = handle_get_state(&session);
        assert!(state["pending_approval"].is_object());
        assert_eq!(state["pending_approval"]["approval_id"], "apr_test");
        assert_eq!(state["pending_approval"]["to_state"], "deployed");
    }

    #[test]
    fn get_state_no_pending_approval_field_when_none() {
        let session = GatewaySession::new("test".into(), approval_definition());
        let state = handle_get_state(&session);
        assert!(state.get("pending_approval").is_none() || state["pending_approval"].is_null());
    }

    // --- Interrupt handler tests ---

    #[test]
    fn get_state_shows_interrupt_handler_when_in_context() {
        let mut session = new_session();
        session.context = json!({"_interrupt_return": "implementing"});
        let state = handle_get_state(&session);
        assert!(state["interrupt_handler"].is_object());
        assert_eq!(state["interrupt_handler"]["return_state"], "implementing");
    }

    #[test]
    fn get_state_no_interrupt_handler_when_not_in_context() {
        let session = new_session();
        let state = handle_get_state(&session);
        assert!(state.get("interrupt_handler").is_none() || state["interrupt_handler"].is_null());
    }

    // --- Per-state model routing tests ---

    fn model_routing_definition() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "model-routing",
            "initial": "diagnose",
            "states": {
                "diagnose": {
                    "allowed_tools": ["Read", "Bash"],
                    "model": "claude-haiku-4-5-20251001",
                    "max_iterations": 8,
                    "on": { "DIAGNOSED": "propose_fix" }
                },
                "propose_fix": {
                    "allowed_tools": ["Read"],
                    "model": "anthropic/claude-opus-4-6",
                    "max_iterations": 3,
                    "on": { "DONE": "execute" }
                },
                "execute": {
                    "allowed_tools": ["Read", "Edit", "Bash"],
                    "on": { "DONE": "completed" }
                },
                "completed": { "type": "final" }
            }
        }))
        .unwrap()
    }

    #[test]
    fn get_state_includes_model_when_defined() {
        let session = GatewaySession::new("test".into(), model_routing_definition());
        let state = handle_get_state(&session);
        assert_eq!(state["model"], "claude-haiku-4-5-20251001");
    }

    #[test]
    fn get_state_model_null_when_not_defined() {
        let mut session = GatewaySession::new("test".into(), model_routing_definition());
        // Transition to "execute" which has no model
        handle_transition(&mut session, "DIAGNOSED").unwrap();
        handle_transition(&mut session, "DONE").unwrap();
        assert_eq!(session.current_state, "execute");
        let state = handle_get_state(&session);
        assert!(state["model"].is_null());
    }

    #[test]
    fn get_state_model_changes_after_transition() {
        let mut session = GatewaySession::new("test".into(), model_routing_definition());
        let state1 = handle_get_state(&session);
        assert_eq!(state1["model"], "claude-haiku-4-5-20251001");

        handle_transition(&mut session, "DIAGNOSED").unwrap();
        let state2 = handle_get_state(&session);
        assert_eq!(state2["model"], "anthropic/claude-opus-4-6");
    }

    // --- default_model inheritance tests ---

    fn default_model_definition() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "default-model",
            "initial": "planning",
            "meta": {
                "default_model": "anthropic/claude-opus-4-6"
            },
            "states": {
                "planning": {
                    "allowed_tools": ["Read"],
                    "on": { "READY": "grunt_work" }
                },
                "grunt_work": {
                    "allowed_tools": ["Read", "Edit"],
                    "model": "claude-haiku-4-5-20251001",
                    "on": { "DONE": "completed" }
                },
                "completed": { "type": "final" }
            }
        }))
        .unwrap()
    }

    #[test]
    fn get_state_inherits_default_model_when_state_has_none() {
        let session = GatewaySession::new("test".into(), default_model_definition());
        let state = handle_get_state(&session);
        // planning has no model — inherits default_model
        assert_eq!(state["model"], "anthropic/claude-opus-4-6");
        assert_eq!(state["default_model"], "anthropic/claude-opus-4-6");
    }

    #[test]
    fn get_state_state_model_overrides_default() {
        let mut session = GatewaySession::new("test".into(), default_model_definition());
        handle_transition(&mut session, "READY").unwrap();
        let state = handle_get_state(&session);
        // grunt_work has explicit model — overrides default
        assert_eq!(state["model"], "claude-haiku-4-5-20251001");
        assert_eq!(state["default_model"], "anthropic/claude-opus-4-6");
    }

    #[test]
    fn get_state_no_default_model_when_meta_absent() {
        let session = new_session(); // test_definition() has no meta
        let state = handle_get_state(&session);
        assert!(state["default_model"].is_null());
    }
}
