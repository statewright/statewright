use std::collections::HashMap;

use serde_json::json;
use statewright_engine::MachineDefinition;

use crate::custom_tools;
use crate::enforcement::{self, EnforcementDecision};
use crate::interceptors::{self, PreCallDecision};
use crate::protocol::{JsonRpcRequest, JsonRpcResponse, ToolCallParams, ToolInfo};
use crate::session::SessionManager;
use crate::upstream::UpstreamManager;

/// Core MCP gateway that dispatches messages.
pub struct Gateway {
    pub session_manager: SessionManager,
    pub upstream: UpstreamManager,
    session_id: String,
    workflows: HashMap<String, MachineDefinition>,
    active_workflow: Option<String>,
    /// Owner ID for step metering (from PocketBase API key lookup).
    owner_id: String,
    /// API key fingerprint for session ownership verification (UUID v5 hash).
    api_key_fingerprint: String,
    /// Database pool for run recording and step metering.
    db_pool: crate::DbPool,
    /// Current run ID (set on workflow load, used for transition/log linkage).
    current_run_id: Option<String>,
    /// Project ID (cwd hash from client, scopes runs per-project).
    project_id: Option<String>,
}

impl Gateway {
    pub fn new(
        session_manager: SessionManager,
        upstream: UpstreamManager,
        session_id: String,
        workflows: HashMap<String, MachineDefinition>,
        active_workflow: Option<String>,
        owner_id: String,
        db_pool: crate::DbPool,
    ) -> Self {
        Self {
            session_manager,
            upstream,
            session_id,
            workflows,
            active_workflow,
            owner_id,
            api_key_fingerprint: String::new(),
            db_pool,
            current_run_id: None,
            project_id: None,
        }
    }

    /// Get the session ID for this gateway instance.
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Set the API key fingerprint for session ownership verification.
    pub fn set_api_key_fingerprint(&mut self, api_key: &str) {
        self.api_key_fingerprint = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, api_key.as_bytes()).to_string();
    }

    /// Verify that the provided API key matches this session's owner.
    pub fn verify_owner_key(&self, api_key: &str) -> bool {
        let fingerprint = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, api_key.as_bytes()).to_string();
        fingerprint == self.api_key_fingerprint
    }

    /// Create a workflow run record. Returns the generated run_id.
    async fn record_run_start(&mut self, workflow_name: &str, initial_state: &str) -> Option<String> {
        #[cfg(feature = "metering")]
        {
            let pool = self.db_pool.as_ref()?;
            let now = chrono::Utc::now().to_rfc3339();
            let project = self.project_id.clone().unwrap_or_default();
            let result = sqlx::query_scalar::<_, String>(
                "INSERT INTO workflow_runs (id, owner, workflow_name, status, started_at, transitions, transition_count, session_id, project_id, created, updated) \
                 VALUES (gen_random_uuid()::text, $1, $2, 'running', $3, '[]'::jsonb, 0, $4, $5, $3, $3) RETURNING id"
            )
            .bind(&self.owner_id)
            .bind(workflow_name)
            .bind(&now)
            .bind(&self.session_id)
            .bind(&project)
            .fetch_one(pool)
            .await;
            return match result {
                Ok(run_id) => {
                    tracing::info!(workflow = workflow_name, run_id = %run_id, "Run started");
                    self.current_run_id = Some(run_id.clone());
                    Some(run_id)
                }
                Err(e) => {
                    tracing::warn!(error = %e, "Failed to create run record");
                    None
                }
            };
        }
        #[cfg(not(feature = "metering"))]
        {
            let _ = (workflow_name, initial_state);
            None
        }
    }

    /// Fire-and-forget: append a transition to the current run (by run_id).
    fn record_run_transition(&self, from: &str, to: &str, event: &str, data: &serde_json::Value) {
        let run_id = match &self.current_run_id {
            Some(id) => id.clone(),
            None => return,
        };
        #[cfg(feature = "metering")]
        if let Some(pool) = &self.db_pool {
            let pool = pool.clone();
            let now = chrono::Utc::now().to_rfc3339();
            let transition = serde_json::json!({"from": from, "to": to, "event": event, "timestamp": now, "data": data});
            tokio::spawn(async move {
                let _ = sqlx::query(
                    "UPDATE workflow_runs \
                     SET transitions = (transitions::jsonb || $1::jsonb)::json, \
                         transition_count = transition_count + 1, \
                         updated = $2 \
                     WHERE id = $3"
                )
                .bind(serde_json::to_string(&transition).unwrap())
                .bind(&now)
                .bind(&run_id)
                .execute(&pool)
                .await;
            });
        }
        #[cfg(not(feature = "metering"))]
        let _ = (from, to, event, data, run_id);
    }

    /// Fire-and-forget: mark the current run as completed/stopped/failed.
    fn record_run_end(&mut self, final_state: &str, status: &str) {
        let run_id = match self.current_run_id.take() {
            Some(id) => id,
            None => return,
        };
        #[cfg(feature = "metering")]
        if let Some(pool) = &self.db_pool {
            let pool = pool.clone();
            let now = chrono::Utc::now().to_rfc3339();
            let state = final_state.to_string();
            let stat = status.to_string();
            tokio::spawn(async move {
                let _ = sqlx::query(
                    "UPDATE workflow_runs \
                     SET status = $1, final_state = $2, completed_at = $3, updated = $3 \
                     WHERE id = $4"
                )
                .bind(&stat)
                .bind(&state)
                .bind(&now)
                .bind(&run_id)
                .execute(&pool)
                .await;
                tracing::info!(status = stat, final_state = state, "Run ended");
            });
        }
        #[cfg(not(feature = "metering"))]
        let _ = (final_state, status, run_id);
    }

    /// Fire-and-forget step count increment.
    fn record_step(&self) {
        #[cfg(feature = "metering")]
        if let Some(pool) = &self.db_pool {
            let pool = pool.clone();
            let owner = self.owner_id.clone();
            tokio::spawn(async move {
                let period = chrono::Utc::now().format("%Y-%m").to_string();
                let _ = sqlx::query(
                    "INSERT INTO step_counts (id, owner, period, count, created, updated) \
                     VALUES (gen_random_uuid()::text, $1, $2, 1, NOW(), NOW()) \
                     ON CONFLICT (owner, period) DO UPDATE SET count = step_counts.count + 1, updated = NOW()"
                )
                .bind(&owner)
                .bind(&period)
                .execute(&pool)
                .await;
            });
        }
    }

    /// Handle an incoming JSON-RPC request and return a response.
    pub async fn handle_message(&mut self, request: JsonRpcRequest) -> Option<JsonRpcResponse> {
        match request.method.as_str() {
            "initialize" => Some(self.handle_initialize(request.id)),
            "notifications/initialized" => None, // notification, no response
            "tools/list" => Some(self.handle_tools_list(request.id)),
            "tools/call" => Some(self.handle_tools_call(request.id, request.params).await),
            "ping" => Some(JsonRpcResponse::success(request.id, json!({}))),
            _ => Some(JsonRpcResponse::error(
                request.id,
                -32601,
                format!("Method not found: {}", request.method),
            )),
        }
    }

    fn handle_initialize(&self, id: Option<serde_json::Value>) -> JsonRpcResponse {
        JsonRpcResponse::success(
            id,
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": { "listChanged": false }
                },
                "serverInfo": {
                    "name": "statewright-gateway",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        )
    }

    fn handle_tools_list(&self, id: Option<serde_json::Value>) -> JsonRpcResponse {
        // When deactivated, pass all upstream tools + workflow management tools
        if self.active_workflow.is_none() {
            let mut tools: Vec<ToolInfo> = self.upstream.all_tools().into_iter().cloned().collect();
            tools.extend(custom_tools::custom_tool_definitions());
            return JsonRpcResponse::success(id, json!({ "tools": tools }));
        }

        let session = match self.session_manager.get(&self.session_id) {
            Some(s) => s,
            None => {
                return JsonRpcResponse::error(id, -32600, "No active session");
            }
        };

        let mut tools: Vec<ToolInfo> = Vec::new();

        // If checkpoint reached, return ONLY custom tools (forces transition)
        if session.is_checkpoint() {
            tools.extend(custom_tools::custom_tool_definitions());
            return JsonRpcResponse::success(id, json!({ "tools": tools }));
        }

        // If final state, return management tools (so user can start a new workflow)
        if session.is_final() {
            tools.extend(custom_tools::custom_tool_definitions());
            return JsonRpcResponse::success(id, json!({ "tools": tools }));
        }

        // Filter upstream tools by current state's allowed_tools
        let allowed = statewright_agent::tool_enforcer::get_allowed_tools(
            &session.definition,
            &session.current_state,
        );

        for upstream_tool in self.upstream.all_tools() {
            match &allowed {
                Some(allowed_list) => {
                    if allowed_list.contains(&upstream_tool.name) {
                        tools.push(upstream_tool.clone());
                    }
                }
                None => {
                    // No restrictions — pass all upstream tools through
                    tools.push(upstream_tool.clone());
                }
            }
        }

        // Always append custom statewright tools
        tools.extend(custom_tools::custom_tool_definitions());

        // Conditionally add debug tools
        let debug = session.definition.meta.as_ref()
            .and_then(|m| m.extra.get("debug"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if debug {
            tools.push(custom_tools::force_state_tool_definition());
        }

        JsonRpcResponse::success(id, json!({ "tools": tools }))
    }

    async fn handle_tools_call(
        &mut self,
        id: Option<serde_json::Value>,
        params: Option<serde_json::Value>,
    ) -> JsonRpcResponse {
        let params: ToolCallParams = match params {
            Some(p) => match serde_json::from_value(p) {
                Ok(p) => p,
                Err(e) => {
                    return JsonRpcResponse::error(
                        id,
                        -32602,
                        format!("Invalid params: {}", e),
                    );
                }
            },
            None => {
                return JsonRpcResponse::error(id, -32602, "Missing params");
            }
        };

        // Handle custom tools locally (always available, even when deactivated)
        if custom_tools::is_custom_tool(&params.name) {
            return self.handle_custom_tool_call(id, &params.name, params.arguments).await;
        }

        // When deactivated, pass all tool calls through without enforcement
        if self.active_workflow.is_none() {
            return match self.upstream.call_tool(&params.name, params.arguments).await {
                Ok(result) => JsonRpcResponse::success(
                    id,
                    serde_json::to_value(result).unwrap_or(json!({})),
                ),
                Err(e) => JsonRpcResponse::error(id, -32603, e),
            };
        }

        // Enforce tool access
        let session = match self.session_manager.get(&self.session_id) {
            Some(s) => s,
            None => {
                return JsonRpcResponse::error(id, -32600, "No active session");
            }
        };

        match enforcement::enforce_tool_call(&session, &params.name) {
            EnforcementDecision::Allow => {
                // Run pre-call interceptors (edit guard, bash guard, scope limits, read dedup, context budget)
                let pre_warning = match interceptors::pre_call_check(&session, &params.name, &params.arguments) {
                    PreCallDecision::Block(reason) => {
                        return JsonRpcResponse::success(
                            id,
                            serde_json::to_value(crate::protocol::ToolCallResult::error(reason)).unwrap(),
                        );
                    }
                    PreCallDecision::Warn(msg) => Some(msg),
                    PreCallDecision::Allow => None,
                };

                // Forward to upstream
                self.session_manager.increment_iteration(&self.session_id);
                match self.upstream.call_tool(&params.name, params.arguments.clone()).await {
                    Ok(mut result) => {
                        // Post-call tracking
                        let update = interceptors::post_call_annotations(&params.name, &params.arguments, &result);
                        let edited_path = update.file_edited.clone();
                        if let Some(ref path) = edited_path {
                            self.session_manager.record_file_edit(&self.session_id, path);
                        }
                        if let Some(path) = update.file_read {
                            self.session_manager.record_file_read(&self.session_id, &path);
                        }
                        if update.result_bytes > 0 {
                            self.session_manager.add_context_bytes(&self.session_id, update.result_bytes);
                        }

                        // Check interrupt triggers on file edits (History State pattern)
                        if let Some(ref path) = edited_path {
                            if !session.definition.interrupts.is_empty() {
                                // Skip if already in an interrupt handler (re-entrancy prevention)
                                let already_in_interrupt = session.context
                                    .get("_interrupt_return").is_some();

                                if !already_in_interrupt {
                                    let matches = statewright_engine::match_interrupts(path, &session.definition);
                                    if let Some((name, interrupt_def)) = matches.first() {
                                        // Auto-transition: set return state in context, move to handler
                                        let prev_state = session.current_state.clone();
                                        let target = interrupt_def.target.clone();

                                        let mut new_ctx = session.context.clone();
                                        if let Some(obj) = new_ctx.as_object_mut() {
                                            obj.insert(
                                                "_interrupt_return".to_string(),
                                                json!(prev_state),
                                            );
                                        }

                                        self.session_manager.update_state(
                                            &self.session_id,
                                            target.clone(),
                                            new_ctx,
                                        );
                                        self.record_step();
                                        self.record_run_transition(
                                            &prev_state, &target,
                                            &format!("INTERRUPT:{}", name), &json!({"trigger_file": path}),
                                        );

                                        result.content.push(crate::protocol::ToolResultContent {
                                            content_type: "text".into(),
                                            text: format!(
                                                "\n[STATEWRIGHT INTERRUPT] File '{}' triggered interrupt '{}'. \
                                                 State changed: {} → {}. Complete the required validation, \
                                                 then transition to return to your previous state.",
                                                path, name, prev_state, target
                                            ),
                                        });

                                        tracing::info!(
                                            interrupt = *name,
                                            trigger_file = path.as_str(),
                                            from = prev_state.as_str(),
                                            to = target.as_str(),
                                            "Interrupt auto-transition"
                                        );
                                    }
                                }
                            }
                        }

                        // Append warnings from interceptors
                        if let Some(warning) = pre_warning {
                            result.content.push(crate::protocol::ToolResultContent {
                                content_type: "text".into(),
                                text: warning,
                            });
                        }

                        JsonRpcResponse::success(
                            id,
                            serde_json::to_value(result).unwrap_or(json!({})),
                        )
                    }
                    Err(e) => JsonRpcResponse::error(id, -32603, e),
                }
            }
            EnforcementDecision::Block {
                reason,
                available_tools,
            } => JsonRpcResponse::success(
                id,
                serde_json::to_value(crate::protocol::ToolCallResult::error(format!(
                    "{}\nAvailable tools: {}",
                    reason,
                    available_tools.join(", ")
                )))
                .unwrap(),
            ),
            EnforcementDecision::ImplicitTransition { event, new_state } => {
                // Apply the transition
                self.session_manager.update_state(
                    &self.session_id,
                    new_state.clone(),
                    session.context.clone(),
                );
                tracing::info!(
                    from = session.current_state,
                    to = new_state,
                    event = event,
                    "Implicit transition from tool intent"
                );

                // Now forward the tool call (it's allowed in the new state)
                self.session_manager.increment_iteration(&self.session_id);
                match self.upstream.call_tool(&params.name, params.arguments).await {
                    Ok(result) => JsonRpcResponse::success(
                        id,
                        serde_json::to_value(result).unwrap_or(json!({})),
                    ),
                    Err(e) => JsonRpcResponse::error(id, -32603, e),
                }
            }
            EnforcementDecision::CheckpointReached { iteration, max } => {
                // Allow the tool but signal checkpoint in the result
                self.session_manager.increment_iteration(&self.session_id);
                match self.upstream.call_tool(&params.name, params.arguments).await {
                    Ok(mut result) => {
                        // Append checkpoint notice to the result
                        result.content.push(crate::protocol::ToolResultContent {
                            content_type: "text".into(),
                            text: format!(
                                "\n[STATEWRIGHT CHECKPOINT: iteration {}/{} in state '{}'. \
                                 You should transition to the next state using statewright_transition.]",
                                iteration, max, session.current_state
                            ),
                        });
                        JsonRpcResponse::success(
                            id,
                            serde_json::to_value(result).unwrap_or(json!({})),
                        )
                    }
                    Err(e) => JsonRpcResponse::error(id, -32603, e),
                }
            }
        }
    }

    async fn handle_custom_tool_call(
        &mut self,
        id: Option<serde_json::Value>,
        name: &str,
        arguments: serde_json::Value,
    ) -> JsonRpcResponse {
        match name {
            "statewright_transition" => {
                let event = arguments
                    .get("event")
                    .and_then(|e| e.as_str())
                    .unwrap_or("");
                let mut event_data = arguments
                    .get("data")
                    .cloned()
                    .unwrap_or(json!({}));
                // Strip internal context fields from user-provided data (prevent injection)
                if let Some(obj) = event_data.as_object_mut() {
                    obj.remove("_interrupt_return");
                    obj.remove("_fork");
                }

                // Get mutable session
                let mut session = match self.session_manager.get(&self.session_id) {
                    Some(s) => s,
                    None => {
                        return JsonRpcResponse::error(id, -32600, "No active session");
                    }
                };

                // Handle plugin-triggered interrupts (INTERRUPT:name format)
                if event.starts_with("INTERRUPT:") {
                    let interrupt_name = &event[10..]; // after "INTERRUPT:"
                    if let Some(interrupt_def) = session.definition.interrupts.get(interrupt_name) {
                        // Skip if already in an interrupt handler
                        if session.context.get("_interrupt_return").is_some() {
                            return JsonRpcResponse::success(
                                id,
                                serde_json::to_value(crate::protocol::ToolCallResult::text(
                                    json!({"skipped": true, "reason": "Already in interrupt handler"}).to_string()
                                )).unwrap(),
                            );
                        }

                        let prev_state = session.current_state.clone();
                        let target = interrupt_def.target.clone();

                        let mut new_ctx = session.context.clone();
                        if let Some(obj) = new_ctx.as_object_mut() {
                            obj.insert("_interrupt_return".to_string(), json!(prev_state));
                        }

                        self.session_manager.update_state(
                            &self.session_id,
                            target.clone(),
                            new_ctx,
                        );
                        self.record_step();
                        self.record_run_transition(
                            &prev_state, &target,
                            &format!("INTERRUPT:{}", interrupt_name),
                            &event_data,
                        );

                        tracing::info!(
                            interrupt = interrupt_name,
                            from = prev_state.as_str(),
                            to = target.as_str(),
                            "Plugin-triggered interrupt"
                        );

                        let result = json!({
                            "interrupted": true,
                            "from": prev_state,
                            "to": target,
                            "interrupt": interrupt_name,
                        });
                        return JsonRpcResponse::success(
                            id,
                            serde_json::to_value(crate::protocol::ToolCallResult::text(
                                serde_json::to_string_pretty(&result).unwrap()
                            )).unwrap(),
                        );
                    } else {
                        return JsonRpcResponse::success(
                            id,
                            serde_json::to_value(crate::protocol::ToolCallResult::error(
                                format!("Unknown interrupt '{}'", interrupt_name)
                            )).unwrap(),
                        );
                    }
                }

                // Handle plugin-triggered branch completion (BRANCH_DONE:name format)
                if event.starts_with("BRANCH_DONE:") {
                    let branch_name = &event[12..]; // after "BRANCH_DONE:"
                    tracing::info!(
                        session_id = %self.session_id,
                        branch = branch_name,
                        has_fork = session.context.get("_fork").is_some(),
                        session_state = %session.current_state,
                        "BRANCH_DONE received"
                    );
                    let fork_ctx = session.context.get("_fork").cloned();

                    if let Some(ref fork) = fork_ctx {
                        let branch_info = &fork["branches"][branch_name];
                        if branch_info.is_null() {
                            return JsonRpcResponse::success(
                                id,
                                serde_json::to_value(crate::protocol::ToolCallResult::error(
                                    format!("Unknown branch '{}'", branch_name)
                                )).unwrap(),
                            );
                        }

                        // Mark branch as completed
                        let mut new_fork = fork.clone();
                        new_fork["branches"][branch_name]["status"] = json!("completed");

                        // Check join condition
                        let join = fork["join"].as_str().unwrap_or("all");
                        let new_branches = new_fork["branches"].as_object().unwrap();
                        let completed_count = new_branches.values()
                            .filter(|b| b["status"].as_str() == Some("completed"))
                            .count();
                        let failed_count = new_branches.values()
                            .filter(|b| b["status"].as_str() == Some("failed"))
                            .count();
                        let total = new_branches.len();

                        let join_met = match join {
                            "all" => completed_count == total,
                            "any" => completed_count >= 1,
                            _ => completed_count == total,
                        };
                        let join_failed = match join {
                            "all" => failed_count > 0,
                            _ => false,
                        };

                        if join_met {
                            // Auto-transition parent to on_complete
                            let on_complete = fork["on_complete"].as_str().unwrap_or("").to_string();
                            let mut parent_ctx = session.context.clone();
                            if let Some(obj) = parent_ctx.as_object_mut() {
                                obj.remove("_fork");
                            }
                            self.session_manager.update_state(
                                &self.session_id,
                                on_complete.clone(),
                                parent_ctx,
                            );
                            self.record_step();
                            self.record_run_transition(
                                &session.current_state, &on_complete,
                                "FORK_JOIN", &json!({"completed_branches": completed_count}),
                            );

                            // Clean up branch sessions
                            for (_, b) in new_branches {
                                if let Some(key) = b["session_key"].as_str() {
                                    // SessionManager doesn't have a delete, but the sessions will be orphaned
                                    // and eventually cleaned up. For now, just log.
                                    tracing::debug!(session = key, "Branch session completed");
                                }
                            }

                            tracing::info!(
                                joined_to = on_complete.as_str(),
                                branches = completed_count,
                                "Fork joined"
                            );

                            let result = json!({
                                "joined": true,
                                "to": on_complete,
                                "completed_branches": completed_count,
                            });
                            return JsonRpcResponse::success(
                                id,
                                serde_json::to_value(crate::protocol::ToolCallResult::text(
                                    serde_json::to_string_pretty(&result).unwrap()
                                )).unwrap(),
                            );
                        } else if join_failed {
                            // Join failed — transition to on_fail
                            let on_fail = fork["on_fail"].as_str().unwrap_or("failed").to_string();
                            let mut parent_ctx = session.context.clone();
                            if let Some(obj) = parent_ctx.as_object_mut() {
                                obj.remove("_fork");
                            }
                            self.session_manager.update_state(
                                &self.session_id,
                                on_fail.clone(),
                                parent_ctx,
                            );
                            self.record_step();

                            let result = json!({
                                "joined": false,
                                "failed": true,
                                "to": on_fail,
                            });
                            return JsonRpcResponse::success(
                                id,
                                serde_json::to_value(crate::protocol::ToolCallResult::text(
                                    serde_json::to_string_pretty(&result).unwrap()
                                )).unwrap(),
                            );
                        } else {
                            // More branches to go — update context, advance to next branch (sequential)
                            let mut parent_ctx = session.context.clone();
                            // Find next pending branch
                            let next_branch = new_branches.iter()
                                .find(|(_, b)| b["status"].as_str() == Some("pending"))
                                .map(|(name, _)| name.clone());

                            if let Some(ref next) = next_branch {
                                new_fork["current_branch"] = json!(next);
                                new_fork["branches"][next]["status"] = json!("running");
                            }

                            if let Some(obj) = parent_ctx.as_object_mut() {
                                obj.insert("_fork".to_string(), new_fork);
                            }
                            self.session_manager.update_state(
                                &self.session_id,
                                session.current_state.clone(),
                                parent_ctx,
                            );

                            self.record_run_transition(
                                &session.current_state, &session.current_state,
                                &format!("BRANCH_DONE:{}", branch_name),
                                &json!({"completed": completed_count, "remaining": total - completed_count}),
                            );

                            let result = json!({
                                "branch_completed": branch_name,
                                "next_branch": next_branch,
                                "completed": completed_count,
                                "remaining": total - completed_count,
                            });
                            return JsonRpcResponse::success(
                                id,
                                serde_json::to_value(crate::protocol::ToolCallResult::text(
                                    serde_json::to_string_pretty(&result).unwrap()
                                )).unwrap(),
                            );
                        }
                    } else {
                        return JsonRpcResponse::success(
                            id,
                            serde_json::to_value(crate::protocol::ToolCallResult::error(
                                "No active fork. Cannot complete branch.".to_string()
                            )).unwrap(),
                        );
                    }
                }

                // Block transitions while an approval is pending
                if session.pending_approval.is_some() {
                    return JsonRpcResponse::success(
                        id,
                        serde_json::to_value(crate::protocol::ToolCallResult::error(
                            "A transition is pending approval. Approve or reject it before transitioning.".to_string()
                        )).unwrap(),
                    );
                }


                // Evaluate transition against ORIGINAL context (client data must not bypass guards)
                let prev_state = session.current_state.clone();
                match custom_tools::handle_transition(&mut session, event) {
                    Ok(result) => {
                        let new_state = session.current_state.clone();
                        let requires_approval = result["requires_approval"].as_bool().unwrap_or(false);

                        // Check if this transition should be parked for UI approval
                        let approval_mode = session.definition.meta.as_ref()
                            .and_then(|m| m.extra.get("approval_mode"))
                            .and_then(|v| v.as_str())
                            // A review-marked transition should never silently advance.
                            // UI is the local fallback; integrations opt out explicitly.
                            .unwrap_or("ui");

                        if requires_approval && approval_mode == "ui" {
                            // PARK: do not apply the transition
                            let approval_message = result["approval_message"]
                                .as_str()
                                .map(|s| s.to_string());

                            // Merge event data into context for the snapshot
                            let mut snapshot_context = session.context.clone();
                            if event_data.is_object() && event_data.as_object().map_or(false, |o| !o.is_empty()) {
                                snapshot_context = statewright_engine::apply_context_patch(&snapshot_context, &event_data);
                            }

                            // Generate approval ID (use run_id + timestamp for uniqueness)
                            let approval_id = format!("apr_{}", uuid::Uuid::new_v4().as_simple());

                            let pending = crate::session::PendingApproval {
                                approval_id: approval_id.clone(),
                                event: event.to_string(),
                                from_state: prev_state.clone(),
                                to_state: new_state.clone(),
                                new_context: snapshot_context,
                                message: approval_message.clone(),
                            };

                            self.session_manager.set_pending_approval(&self.session_id, pending);

                            let response = json!({
                                "status": "pending_approval",
                                "approval_id": approval_id,
                                "from": prev_state,
                                "to": new_state,
                                "message": approval_message,
                            });

                            return JsonRpcResponse::success(
                                id,
                                serde_json::to_value(
                                    crate::protocol::ToolCallResult::text(
                                        serde_json::to_string_pretty(&response).unwrap()
                                    )
                                ).unwrap(),
                            );
                        }

                        // Check if this transition forks into branches
                        if result.get("fork").is_some() && result["fork"]["branches"].is_object() {
                            let fork_info = &result["fork"];
                            let branches = fork_info["branches"].as_object().unwrap();
                            let join = fork_info["join"].as_str().unwrap_or("all").to_string();
                            let on_complete = fork_info["on_complete"].as_str().unwrap_or("").to_string();
                            let on_fail = fork_info["on_fail"].as_str().map(|s| s.to_string());

                            // Create branch sessions
                            let mut fork_ctx = json!({
                                "branches": {},
                                "join": join,
                                "on_complete": on_complete,
                                "on_fail": on_fail,
                            });

                            let mut first_branch = String::new();
                            for (name, def) in branches {
                                let branch_session_key = format!("{}_br_{}", self.session_id, name);
                                let initial = def["initial"].as_str().unwrap_or("").to_string();
                                let terminal = def["terminal"].as_str().unwrap_or("").to_string();

                                // Create a branch session with the same definition, starting at branch.initial
                                let branch_session = self.session_manager.create(
                                    branch_session_key.clone(),
                                    session.definition.clone(),
                                );
                                self.session_manager.update_state(
                                    &branch_session_key,
                                    initial.clone(),
                                    json!({}),
                                );
                                // Preserve plan limit on branch sessions
                                if let Some(limit) = session.plan_limit {
                                    self.session_manager.set_plan_limit(&branch_session_key, limit);
                                }

                                let status = if first_branch.is_empty() { "running" } else { "pending" };
                                if first_branch.is_empty() {
                                    first_branch = name.clone();
                                }

                                fork_ctx["branches"][name] = json!({
                                    "session_key": branch_session_key,
                                    "initial": initial,
                                    "terminal": terminal,
                                    "status": status,
                                });
                            }
                            fork_ctx["current_branch"] = json!(first_branch);

                            // Update parent context with _fork tracking
                            let mut parent_ctx = if session.context.is_object() {
                                session.context.clone()
                            } else {
                                json!({})  // ensure context is an object, not null
                            };
                            if event_data.is_object() && event_data.as_object().map_or(false, |o| !o.is_empty()) {
                                parent_ctx = statewright_engine::apply_context_patch(&parent_ctx, &event_data);
                            }
                            if let Some(obj) = parent_ctx.as_object_mut() {
                                obj.insert("_fork".to_string(), fork_ctx.clone());
                                obj.remove("_interrupt_return"); // strip if present
                            }

                            // Keep parent in current state (don't advance to on_complete yet)
                            self.session_manager.update_state(
                                &self.session_id,
                                prev_state.clone(),
                                parent_ctx,
                            );
                            self.record_step();
                            self.record_run_transition(&prev_state, &format!("FORK:{}", first_branch), event, &event_data);

                            tracing::info!(
                                branches = branches.len(),
                                first = first_branch.as_str(),
                                join = fork_ctx["join"].as_str().unwrap_or("all"),
                                "Fork created"
                            );

                            let response = json!({
                                "forked": true,
                                "branches": fork_ctx["branches"],
                                "current_branch": first_branch,
                                "join": fork_ctx["join"],
                                "on_complete": on_complete,
                            });
                            return JsonRpcResponse::success(
                                id,
                                serde_json::to_value(crate::protocol::ToolCallResult::text(
                                    serde_json::to_string_pretty(&response).unwrap()
                                )).unwrap(),
                            );
                        }

                        // Normal path: apply the transition
                        let mut final_context = session.context.clone();
                        if event_data.is_object() && event_data.as_object().map_or(false, |o| !o.is_empty()) {
                            final_context = statewright_engine::apply_context_patch(&final_context, &event_data);
                        }
                        self.session_manager.update_state(
                            &self.session_id,
                            new_state.clone(),
                            final_context,
                        );
                        self.record_step();
                        self.record_run_transition(&prev_state, &new_state, event, &event_data);
                        if session.is_final() {
                            self.record_run_end(&new_state, "completed");
                        }
                        JsonRpcResponse::success(
                            id,
                            serde_json::to_value(
                                crate::protocol::ToolCallResult::text(
                                    serde_json::to_string_pretty(&result).unwrap()
                                )
                            ).unwrap(),
                        )
                    }
                    Err(e) => JsonRpcResponse::success(
                        id,
                        serde_json::to_value(crate::protocol::ToolCallResult::error(e)).unwrap(),
                    ),
                }
            }
            "statewright_get_state" => {
                let session = match self.session_manager.get(&self.session_id) {
                    Some(s) => s,
                    None => {
                        return JsonRpcResponse::error(id, -32600, "No active session");
                    }
                };

                // Fork awareness: if _fork active, return current branch state
                if let Some(fork) = session.context.get("_fork") {
                    let current_branch = fork["current_branch"].as_str().unwrap_or("");
                    let branch_key = fork["branches"][current_branch]["session_key"]
                        .as_str().unwrap_or("");

                    let branches_status: serde_json::Value = fork["branches"].as_object()
                        .map(|bs| {
                            bs.iter().map(|(name, b)| {
                                (name.clone(), json!({
                                    "status": b["status"],
                                    "initial": b["initial"],
                                    "terminal": b["terminal"],
                                }))
                            }).collect::<serde_json::Map<String, serde_json::Value>>().into()
                        })
                        .unwrap_or(json!({}));

                    let fork_info = json!({
                        "active": true,
                        "current_branch": current_branch,
                        "branches": branches_status,
                        "join": fork["join"],
                    });

                    if let Some(branch_session) = self.session_manager.get(branch_key) {
                        let mut state = custom_tools::handle_get_state(&branch_session);
                        state["fork"] = fork_info;
                        return JsonRpcResponse::success(
                            id,
                            serde_json::to_value(crate::protocol::ToolCallResult::text(
                                serde_json::to_string_pretty(&state).unwrap(),
                            ))
                            .unwrap(),
                        );
                    } else {
                        // Branch session not found — return parent state WITH fork info
                        // so the plugin knows a fork is active but degraded
                        tracing::warn!(branch = current_branch, key = branch_key, "Fork branch session not found");
                        let mut state = custom_tools::handle_get_state(&session);
                        state["fork"] = fork_info;
                        return JsonRpcResponse::success(
                            id,
                            serde_json::to_value(crate::protocol::ToolCallResult::text(
                                serde_json::to_string_pretty(&state).unwrap(),
                            ))
                            .unwrap(),
                        );
                    }
                }

                let mut state = custom_tools::handle_get_state(&session);
                if let Some(ref run_id) = self.current_run_id {
                    state["run_id"] = json!(run_id);
                }
                let capture = session.definition.meta.as_ref()
                    .and_then(|m| m.capture_output)
                    .unwrap_or(false);
                state["capture_output"] = json!(capture);

                JsonRpcResponse::success(
                    id,
                    serde_json::to_value(crate::protocol::ToolCallResult::text(
                        serde_json::to_string_pretty(&state).unwrap(),
                    ))
                    .unwrap(),
                )
            }
            "statewright_force_state" => {
                let target_state = arguments
                    .get("state")
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                let context_patch = arguments
                    .get("context")
                    .cloned()
                    .unwrap_or(json!({}));

                let session = match self.session_manager.get(&self.session_id) {
                    Some(s) => s,
                    None => {
                        return JsonRpcResponse::error(id, -32600, "No active session");
                    }
                };

                // Check debug mode
                let debug = session.definition.meta.as_ref()
                    .and_then(|m| m.extra.get("debug"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                if !debug {
                    return JsonRpcResponse::success(
                        id,
                        serde_json::to_value(crate::protocol::ToolCallResult::error(
                            "statewright_force_state is only available when meta.debug is true.".to_string()
                        )).unwrap(),
                    );
                }

                // Validate state exists
                if !session.definition.states.contains_key(target_state) {
                    return JsonRpcResponse::success(
                        id,
                        serde_json::to_value(crate::protocol::ToolCallResult::error(
                            format!("State '{}' does not exist in the workflow.", target_state)
                        )).unwrap(),
                    );
                }

                let prev_state = session.current_state.clone();
                let mut new_context = session.context.clone();
                if context_patch.is_object() && context_patch.as_object().map_or(false, |o| !o.is_empty()) {
                    new_context = statewright_engine::apply_context_patch(&new_context, &context_patch);
                }

                // Clear any pending approval
                self.session_manager.clear_pending_approval(&self.session_id);

                // Force the state
                self.session_manager.update_state(
                    &self.session_id,
                    target_state.to_string(),
                    new_context,
                );

                // Record in run history for auditability
                self.record_step();
                self.record_run_transition(
                    &prev_state, target_state, "FORCE_STATE", &context_patch,
                );

                let result = json!({
                    "forced": true,
                    "from": prev_state,
                    "to": target_state,
                    "warning": "State forced via debug mode. Guards and transitions bypassed."
                });
                JsonRpcResponse::success(
                    id,
                    serde_json::to_value(crate::protocol::ToolCallResult::text(
                        serde_json::to_string_pretty(&result).unwrap(),
                    )).unwrap(),
                )
            }
            "statewright_list_workflows" => {
                let workflow_names: Vec<&str> = self.workflows.keys().map(|k| k.as_str()).collect();
                let result = json!({
                    "workflows": workflow_names,
                    "active": self.active_workflow,
                });
                JsonRpcResponse::success(
                    id,
                    serde_json::to_value(crate::protocol::ToolCallResult::text(
                        serde_json::to_string_pretty(&result).unwrap(),
                    ))
                    .unwrap(),
                )
            }
            "statewright_load_workflow" => {
                let workflow_name = arguments
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("");

                // Accept session_id from client for per-session scoping
                if let Some(sid) = arguments.get("session_id").and_then(|s| s.as_str()) {
                    // Create a session-scoped key: api_key_session + client_session
                    let scoped_id = format!("{}_{}", self.session_id, sid);
                    self.session_id = scoped_id;
                    self.project_id = Some(sid.to_string());
                }
                // Legacy: accept project_id too
                if let Some(pid) = arguments.get("project_id").and_then(|p| p.as_str()) {
                    if self.project_id.is_none() {
                        self.project_id = Some(pid.to_string());
                    }
                }

                // Branch parameter: connect sub-agent to a specific fork branch session
                if let Some(branch_name) = arguments.get("branch").and_then(|b| b.as_str()) {
                    // Look up the parent session's _fork context for this branch
                    let parent_session = self.session_manager.get(&self.session_id);
                    if let Some(ps) = parent_session {
                        if let Some(fork) = ps.context.get("_fork") {
                            if let Some(branch_key) = fork["branches"][branch_name]["session_key"].as_str() {
                                if let Some(branch_session) = self.session_manager.get(branch_key) {
                                    // Switch to the branch session
                                    let branch_state = branch_session.current_state.clone();
                                    let result = json!({
                                        "loaded": workflow_name,
                                        "branch": branch_name,
                                        "initial_state": branch_state,
                                        "states": branch_session.definition.states.keys().collect::<Vec<_>>(),
                                        "capture_output": false,
                                        "resumed": false,
                                    });
                                    // Point this gateway at the branch session
                                    self.session_id = branch_key.to_string();
                                    return JsonRpcResponse::success(
                                        id,
                                        serde_json::to_value(crate::protocol::ToolCallResult::text(
                                            serde_json::to_string_pretty(&result).unwrap(),
                                        )).unwrap(),
                                    );
                                }
                            }
                        }
                    }
                    return JsonRpcResponse::success(
                        id,
                        serde_json::to_value(crate::protocol::ToolCallResult::error(
                            format!("Branch '{}' not found. Is a fork active?", branch_name)
                        )).unwrap(),
                    );
                }

                // Clone definition to release immutable borrow before mutable calls
                let definition = match self.workflows.get(workflow_name).cloned() {
                    Some(d) => d,
                    None => {
                        let available: Vec<&str> =
                            self.workflows.keys().map(|k| k.as_str()).collect();
                        return JsonRpcResponse::success(
                            id,
                            serde_json::to_value(crate::protocol::ToolCallResult::error(format!(
                                "Workflow '{}' not found. Available: {}",
                                workflow_name,
                                available.join(", ")
                            )))
                            .unwrap(),
                        );
                    }
                };

                if let Err(e) = statewright_engine::validate_definition(&definition) {
                    return JsonRpcResponse::success(
                        id,
                        serde_json::to_value(crate::protocol::ToolCallResult::error(
                            format!("Invalid workflow '{}': {}", workflow_name, e),
                        ))
                        .unwrap(),
                    );
                }

                // Guard: don't overwrite a session with an active fork
                if let Some(existing) = self.session_manager.get(&self.session_id) {
                    if existing.context.get("_fork").is_some() {
                        return JsonRpcResponse::success(id,
                            serde_json::to_value(crate::protocol::ToolCallResult::error(
                                "Cannot load workflow while a fork is active. Complete or deactivate the fork first."
                            )).unwrap());
                    }
                }

                // Preserve plan_limit across workflow swaps
                let old_limit = self.session_manager.get(&self.session_id)
                    .and_then(|s| s.plan_limit);
                self.session_manager
                    .create(self.session_id.clone(), definition.clone());
                if let Some(limit) = old_limit {
                    self.session_manager.set_plan_limit(&self.session_id, limit);
                }
                self.active_workflow = Some(workflow_name.to_string());

                let resume = arguments.get("resume").and_then(|r| r.as_bool()).unwrap_or(false);
                let capture_output = definition.meta.as_ref()
                    .and_then(|m| m.capture_output)
                    .unwrap_or(false);

                // Resume from paused run or start fresh
                let (run_id, resumed_state) = if resume {
                    #[cfg(feature = "metering")]
                    {
                        if let Some(pool) = &self.db_pool {
                            let row = sqlx::query_as::<_, (String, Option<String>, Option<serde_json::Value>)>(
                                "SELECT id, final_state, context_snapshot FROM workflow_runs \
                                 WHERE owner = $1 AND workflow_name = $2 AND status = 'paused' \
                                 ORDER BY updated DESC LIMIT 1"
                            )
                            .bind(&self.owner_id)
                            .bind(workflow_name)
                            .fetch_optional(pool)
                            .await
                            .ok()
                            .flatten();

                            if let Some((rid, Some(state), context)) = row {
                                let ctx = context.unwrap_or(json!({}));
                                self.session_manager.update_state(
                                    &self.session_id,
                                    state.clone(),
                                    ctx,
                                );
                                let now = chrono::Utc::now().to_rfc3339();
                                let pool2 = pool.clone();
                                let rid2 = rid.clone();
                                tokio::spawn(async move {
                                    let _ = sqlx::query(
                                        "UPDATE workflow_runs SET status = 'running', updated = $1 WHERE id = $2"
                                    )
                                    .bind(&now)
                                    .bind(&rid2)
                                    .execute(&pool2)
                                    .await;
                                });
                                self.current_run_id = Some(rid.clone());
                                (Some(rid), Some(state))
                            } else {
                                let rid = self.record_run_start(workflow_name, &definition.initial).await;
                                (rid, None)
                            }
                        } else {
                            let rid = self.record_run_start(workflow_name, &definition.initial).await;
                            (rid, None)
                        }
                    }
                    #[cfg(not(feature = "metering"))]
                    {
                        let rid = self.record_run_start(workflow_name, &definition.initial).await;
                        (rid, None::<String>)
                    }
                } else {
                    let rid = self.record_run_start(workflow_name, &definition.initial).await;
                    (rid, None)
                };

                let current_state = resumed_state.as_deref().unwrap_or(&definition.initial);

                let result = json!({
                    "loaded": workflow_name,
                    "initial_state": current_state,
                    "states": definition.states.keys().collect::<Vec<_>>(),
                    "run_id": run_id,
                    "capture_output": capture_output,
                    "resumed": resumed_state.is_some(),
                });
                JsonRpcResponse::success(
                    id,
                    serde_json::to_value(crate::protocol::ToolCallResult::text(
                        serde_json::to_string_pretty(&result).unwrap(),
                    ))
                    .unwrap(),
                )
            }
            "statewright_get_model_traits" => {
                static REGISTRY_JSON: &str = include_str!("../../cli/model_registry.json");
                let model_tag = arguments.get("model").and_then(|m| m.as_str());

                let result = if let Some(tag) = model_tag {
                    // Resolve traits for a specific model
                    let registry: serde_json::Value = serde_json::from_str(REGISTRY_JSON)
                        .unwrap_or(json!({"error": "invalid registry"}));
                    let (family, size) = tag.split_once(':').unwrap_or((tag, ""));
                    let mut traits = registry.get("defaults").cloned().unwrap_or(json!({}));
                    if let Some(entry) = registry.get("models").and_then(|m| m.get(family)) {
                        if let Some(fd) = entry.get("family_defaults") {
                            if let (Some(base), Some(overlay)) = (traits.as_object_mut(), fd.as_object()) {
                                for (k, v) in overlay { base.insert(k.clone(), v.clone()); }
                            }
                        }
                        if !size.is_empty() {
                            if let Some(sv) = entry.get("sizes").and_then(|s| s.get(size)) {
                                if let (Some(base), Some(overlay)) = (traits.as_object_mut(), sv.as_object()) {
                                    for (k, v) in overlay { base.insert(k.clone(), v.clone()); }
                                }
                            }
                        }
                    }
                    json!({ "model": tag, "traits": traits })
                } else {
                    // Return full registry
                    serde_json::from_str::<serde_json::Value>(REGISTRY_JSON)
                        .unwrap_or(json!({"error": "invalid registry"}))
                };

                JsonRpcResponse::success(
                    id,
                    serde_json::to_value(crate::protocol::ToolCallResult::text(
                        serde_json::to_string_pretty(&result).unwrap(),
                    ))
                    .unwrap(),
                )
            }
            "statewright_deactivate" => {
                // Record run end before deactivating
                if let Some(session) = self.session_manager.get(&self.session_id) {
                    self.record_run_end(&session.current_state, "stopped");
                    // Clear _fork context so the session isn't permanently stuck
                    if session.context.get("_fork").is_some() {
                        let mut ctx = session.context.clone();
                        if let Some(obj) = ctx.as_object_mut() {
                            obj.remove("_fork");
                        }
                        self.session_manager.update_state(
                            &self.session_id,
                            session.current_state.clone(),
                            ctx,
                        );
                    }
                }
                self.active_workflow = None;
                let result = json!({ "deactivated": true });
                JsonRpcResponse::success(
                    id,
                    serde_json::to_value(crate::protocol::ToolCallResult::text(
                        serde_json::to_string_pretty(&result).unwrap(),
                    ))
                    .unwrap(),
                )
            }
            "statewright_pause" => {
                let session = match self.session_manager.get(&self.session_id) {
                    Some(s) => s,
                    None => {
                        return JsonRpcResponse::error(id, -32600, "No active session");
                    }
                };

                let paused_state = session.current_state.clone();
                let paused_context = session.context.clone();
                let workflow_name = self.active_workflow.clone().unwrap_or_default();

                // Save context snapshot to the run record
                #[cfg(feature = "metering")]
                if let Some(run_id) = &self.current_run_id {
                    if let Some(pool) = &self.db_pool {
                        let pool = pool.clone();
                        let now = chrono::Utc::now().to_rfc3339();
                        let rid = run_id.clone();
                        let state = paused_state.clone();
                        let ctx = paused_context.clone();
                        tokio::spawn(async move {
                            let _ = sqlx::query(
                                "UPDATE workflow_runs \
                                 SET status = 'paused', final_state = $1, context_snapshot = $2, updated = $3 \
                                 WHERE id = $4"
                            )
                            .bind(&state)
                            .bind(&ctx)
                            .bind(&now)
                            .bind(&rid)
                            .execute(&pool)
                            .await;
                        });
                    }
                }

                // Don't clear current_run_id — resume will reuse it
                let run_id = self.current_run_id.clone();
                self.active_workflow = None;

                let result = json!({
                    "paused": true,
                    "state": paused_state,
                    "workflow": workflow_name,
                    "run_id": run_id,
                    "message": "Workflow paused. Use statewright_load_workflow with resume=true to continue."
                });
                JsonRpcResponse::success(
                    id,
                    serde_json::to_value(crate::protocol::ToolCallResult::text(
                        serde_json::to_string_pretty(&result).unwrap(),
                    ))
                    .unwrap(),
                )
            }
            "statewright_get_status" => {
                let session = self.session_manager.get(&self.session_id);
                let usage = session.as_ref().map(|s| {
                    let (used, limit, _) = s.usage();
                    json!({
                        "transitions": used,
                        "limit": limit,
                        "remaining": limit.map(|l| l.saturating_sub(used)),
                        "warning": s.usage_warning(),
                    })
                });
                let result = json!({
                    "active_workflow": self.active_workflow,
                    "current_state": session.as_ref().map(|s| &s.current_state),
                    "iteration": session.as_ref().map(|s| s.iteration_count),
                    "transition_count": session.as_ref().map(|s| s.transition_count),
                    "is_final": session.as_ref().map(|s| s.is_final()),
                    "available_workflows": self.workflows.keys().collect::<Vec<_>>(),
                    "usage": usage,
                });
                JsonRpcResponse::success(
                    id,
                    serde_json::to_value(crate::protocol::ToolCallResult::text(
                        serde_json::to_string_pretty(&result).unwrap(),
                    ))
                    .unwrap(),
                )
            }
            "statewright_create_workflow" => {
                let wf_name = arguments.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let definition = arguments.get("definition").cloned().unwrap_or(json!({}));
                let overwrite = arguments.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false);

                if wf_name.is_empty() {
                    return JsonRpcResponse::success(id,
                        serde_json::to_value(crate::protocol::ToolCallResult::error("Workflow name is required")).unwrap());
                }

                // Validate + parse the definition upfront — reuse for in-memory insert
                let parsed_def = match serde_json::from_value::<statewright_engine::MachineDefinition>(definition.clone()) {
                    Err(e) => {
                        return JsonRpcResponse::success(id,
                            serde_json::to_value(crate::protocol::ToolCallResult::error(
                                format!("Invalid workflow definition: {}. See schema at https://statewright.ai/workflow-schema.json", e)
                            )).unwrap());
                    }
                    Ok(def) => {
                        if let Err(e) = statewright_engine::validate_definition(&def) {
                            return JsonRpcResponse::success(id,
                                serde_json::to_value(crate::protocol::ToolCallResult::error(
                                    format!("Workflow validation failed: {}. See schema at https://statewright.ai/workflow-schema.json", e)
                                )).unwrap());
                        }
                        def
                    }
                };

                // Persist workflow record
                #[cfg(feature = "metering")]
                let persist_result: Option<JsonRpcResponse> = if let Some(pool) = &self.db_pool {
                    let pool = pool.clone();
                    let owner = self.owner_id.clone();
                    let name = wf_name.to_string();
                    let def_json = definition.to_string();
                    let sql = if overwrite {
                        "INSERT INTO workflows (id, owner, name, definition, active, created, updated) \
                         VALUES (gen_random_uuid()::text, $1, $2, $3::json, false, NOW()::text, NOW()::text) \
                         ON CONFLICT (owner, name) DO UPDATE SET definition = $3::json, updated = NOW()::text"
                    } else {
                        "INSERT INTO workflows (id, owner, name, definition, active, created, updated) \
                         VALUES (gen_random_uuid()::text, $1, $2, $3::json, false, NOW()::text, NOW()::text)"
                    };
                    let result = sqlx::query(sql)
                        .bind(&owner)
                        .bind(&name)
                        .bind(&def_json)
                        .execute(&pool)
                        .await;

                    match result {
                        Ok(_) => {
                            let verb = if overwrite && self.workflows.contains_key(&name) { "updated" } else { "created" };
                            self.workflows.insert(name.clone(), parsed_def.clone());
                            Some(JsonRpcResponse::success(id.clone(),
                                serde_json::to_value(crate::protocol::ToolCallResult::text(
                                    format!("Workflow '{}' {}. Use statewright_load_workflow(name='{}') to activate it.", name, verb, name)
                                )).unwrap()))
                        }
                        Err(e) => {
                            let msg = e.to_string();
                            if msg.contains("unique") || msg.contains("duplicate") {
                                Some(JsonRpcResponse::success(id.clone(),
                                    serde_json::to_value(crate::protocol::ToolCallResult::error(
                                        format!("Workflow '{}' already exists. Use overwrite=true to replace it.", name)
                                    )).unwrap()))
                            } else {
                                Some(JsonRpcResponse::success(id.clone(),
                                    serde_json::to_value(crate::protocol::ToolCallResult::error(
                                        format!("Failed to save workflow: {}", msg)
                                    )).unwrap()))
                            }
                        }
                    }
                } else {
                    None
                };
                #[cfg(not(feature = "metering"))]
                let persist_result: Option<JsonRpcResponse> = None;

                if let Some(resp) = persist_result {
                    resp
                } else {
                    // In-memory only (no database)
                    let name = wf_name.to_string();
                    if !overwrite && self.workflows.contains_key(&name) {
                        JsonRpcResponse::success(id,
                            serde_json::to_value(crate::protocol::ToolCallResult::error(
                                format!("Workflow '{}' already exists. Use overwrite=true to replace it.", name)
                            )).unwrap())
                    } else {
                        let verb = if self.workflows.contains_key(&name) { "updated" } else { "created" };
                        self.workflows.insert(name.clone(), parsed_def);
                        JsonRpcResponse::success(id,
                            serde_json::to_value(crate::protocol::ToolCallResult::text(
                                format!("Workflow '{}' {} (in-memory). Use statewright_load_workflow(name='{}') to activate it.", name, verb, name)
                            )).unwrap())
                    }
                }
            }
            "statewright_run_agent" => {
                let task = arguments.get("task").and_then(|t| t.as_str()).unwrap_or("Fix the failing tests");
                let model = arguments.get("model").and_then(|m| m.as_str()).unwrap_or("gemma4:31b");
                let agent_workdir = arguments.get("workdir").and_then(|w| w.as_str()).unwrap_or(".");

                // Resolve active session for workflow definition and current state.
                // This is the path for TUIs (Claude Code, Hermes) that cannot spawn sw-agent
                // locally — the gateway runs it server-side using the loaded workflow.
                let (workflow_json, current_state) = self.session_manager.get(&self.session_id)
                    .map(|s| (serde_json::to_value(&s.definition).ok(), Some(s.current_state.clone())))
                    .unwrap_or((None, None));

                // Build config for the agent — include the active workflow so sw-agent
                // uses the correct state machine rather than its hardcoded fallback.
                let mut config = json!({
                    "task": task,
                    "workdir": agent_workdir,
                    "model_routing": {
                        "planning":     { "model": model, "temperature": 0.3, "num_predict": 4096 },
                        "implementing": { "model": model, "temperature": 0.2, "num_predict": 4096 },
                    },
                    "guardrails": { "max_steps": 20, "max_diff_lines": 5 }
                });
                if let Some(wf) = workflow_json {
                    config["workflow"] = wf;
                }

                // Write config to temp file
                let config_path = format!("/tmp/sw-agent-config-{}.json", std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
                if let Err(e) = std::fs::write(&config_path, config.to_string()) {
                    return JsonRpcResponse::success(id,
                        serde_json::to_value(crate::protocol::ToolCallResult::error(
                            format!("Failed to write agent config: {}", e)
                        )).unwrap());
                }

                // Build spawn args — target the current state if known (single-state execution),
                // otherwise sw-agent runs from the workflow initial state.
                let mut sw_args: Vec<String> = vec![
                    "--json-events".into(),
                    "--config".into(),
                    config_path.clone(),
                    "--workdir".into(),
                    agent_workdir.to_string(),
                ];
                if let Some(state) = current_state {
                    sw_args.push("--state".into());
                    sw_args.push(state);
                }

                // Spawn sw-agent subprocess
                let output = match tokio::process::Command::new("sw-agent")
                    .args(&sw_args)
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .output()
                    .await
                {
                    Ok(o) => o,
                    Err(e) => {
                        let _ = std::fs::remove_file(&config_path);
                        return JsonRpcResponse::success(id,
                            serde_json::to_value(crate::protocol::ToolCallResult::error(
                                format!("Failed to spawn sw-agent: {}. Is it in PATH?", e)
                            )).unwrap());
                    }
                };

                let _ = std::fs::remove_file(&config_path);

                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);

                // Parse JSONL events from stdout into a summary
                let mut summary_lines: Vec<String> = Vec::new();
                for line in stdout.lines() {
                    if let Ok(event) = serde_json::from_str::<serde_json::Value>(line) {
                        match event.get("event").and_then(|e| e.as_str()) {
                            Some("transition") => {
                                let from = event.get("from").and_then(|f| f.as_str()).unwrap_or("?");
                                let to = event.get("to").and_then(|t| t.as_str()).unwrap_or("?");
                                summary_lines.push(format!("⚡ {} → {}", from, to));
                            }
                            Some("tool_call") => {
                                let name = event.get("name").and_then(|n| n.as_str()).unwrap_or("?");
                                let args = event.get("args_preview").and_then(|a| a.as_str()).unwrap_or("");
                                summary_lines.push(format!("→ {} {}", name, args));
                            }
                            Some("auto_test") => {
                                let passed = event.get("passed").and_then(|p| p.as_bool()).unwrap_or(false);
                                let fc = event.get("fail_count").and_then(|f| f.as_u64()).unwrap_or(0);
                                if passed {
                                    summary_lines.push("✓ Tests passed".into());
                                } else {
                                    summary_lines.push(format!("✗ {} test(s) failing", fc));
                                }
                            }
                            Some("completed") => {
                                let steps = event.get("steps").and_then(|s| s.as_u64()).unwrap_or(0);
                                let success = event.get("success").and_then(|s| s.as_bool()).unwrap_or(false);
                                if success {
                                    summary_lines.push(format!("✓ Completed in {} steps", steps));
                                } else {
                                    summary_lines.push(format!("✗ Failed after {} steps", steps));
                                }
                            }
                            _ => {}
                        }
                    }
                }

                let result_text = if summary_lines.is_empty() {
                    format!("Agent finished (exit code: {:?})\n\nstdout:\n{}\n\nstderr:\n{}",
                        output.status.code(), &stdout[..stdout.len().min(2000)], &stderr[..stderr.len().min(500)])
                } else {
                    summary_lines.join("\n")
                };

                JsonRpcResponse::success(
                    id,
                    serde_json::to_value(crate::protocol::ToolCallResult::text(result_text)).unwrap(),
                )
            }

            _ => JsonRpcResponse::error(id, -32601, format!("Unknown custom tool: {}", name)),
        }
    }
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
                    "max_iterations": 3,
                    "on": { "READY": "implementing", "FAIL": "failed" }
                },
                "implementing": {
                    "allowed_tools": ["read_file", "edit_file", "write_file"],
                    "max_iterations": 6,
                    "on": { "DONE": "completed", "FAIL": "failed" }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap()
    }

    fn test_workflows() -> HashMap<String, MachineDefinition> {
        let mut wf = HashMap::new();
        wf.insert("test".into(), test_definition());
        wf
    }

    fn test_gateway() -> Gateway {
        let mgr = SessionManager::new();
        mgr.create("test-session".into(), test_definition());
        Gateway::new(
            mgr,
            UpstreamManager::empty(),
            "test-session".into(),
            test_workflows(),
            Some("test".into()),
            String::new(),
            None,
        )
    }

    #[tokio::test]
    async fn initialize_returns_server_info() {
        let mut gw = test_gateway();
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "initialize".into(),
            params: Some(json!({})),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        let result = resp.result.unwrap();
        assert_eq!(result["serverInfo"]["name"], "statewright-gateway");
    }

    #[tokio::test]
    async fn tools_list_includes_custom_tools() {
        let mut gw = test_gateway();
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/list".into(),
            params: Some(json!({})),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        let tools = resp.result.unwrap()["tools"].as_array().unwrap().clone();
        let names: Vec<String> = tools.iter().map(|t| t["name"].as_str().unwrap().into()).collect();
        assert!(names.contains(&"statewright_transition".to_string()));
        assert!(names.contains(&"statewright_get_state".to_string()));
    }

    #[tokio::test]
    async fn tools_list_at_checkpoint_returns_only_custom() {
        let mgr = SessionManager::new();
        mgr.create("test-session".into(), test_definition());
        // Hit checkpoint: planning has max_iterations: 3
        mgr.increment_iteration("test-session");
        mgr.increment_iteration("test-session");
        mgr.increment_iteration("test-session");

        let mut gw = Gateway::new(
            mgr,
            UpstreamManager::empty(),
            "test-session".into(),
            test_workflows(),
            Some("test".into()),
            String::new(),
            None,
        );
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/list".into(),
            params: Some(json!({})),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        let tools = resp.result.unwrap()["tools"].as_array().unwrap().clone();
        // Only custom tools — no upstream tools
        assert_eq!(tools.len(), 10);
        let names: Vec<String> = tools.iter().map(|t| t["name"].as_str().unwrap().into()).collect();
        assert!(names.contains(&"statewright_transition".to_string()));
        assert!(names.contains(&"statewright_get_state".to_string()));
    }

    #[tokio::test]
    async fn tools_call_blocked_returns_error_content() {
        let mut gw = test_gateway();
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({ "name": "deploy", "arguments": {} })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        let result = resp.result.unwrap();
        assert_eq!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("deploy"));
        assert!(text.contains("planning"));
    }

    #[tokio::test]
    async fn tools_call_custom_transition() {
        let mut gw = test_gateway();
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "READY" }
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        assert!(resp.error.is_none());

        // Verify state changed
        let session = gw.session_manager.get("test-session").unwrap();
        assert_eq!(session.current_state, "implementing");
    }

    #[tokio::test]
    async fn invoke_transition_does_not_advance_to_on_complete() {
        // Workflow with an invoke transition: planning --DEBUG--> {invoke: "debug_machine", on_complete: "testing"}
        // After firing DEBUG, parent must stay in "planning" (not jump to "testing").
        // The response must carry an "invoke" key for the client to act on.
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "invoke-test",
            "initial": "planning",
            "states": {
                "planning": {
                    "on": {
                        "DEBUG": { "invoke": "debug_machine", "on_complete": "testing" },
                        "DONE": "completed"
                    }
                },
                "testing": { "on": { "DONE": "completed" } },
                "completed": { "type": "final" }
            },
            "guards": {}
        })).unwrap();

        let mgr = SessionManager::new();
        mgr.create("invoke-session".into(), def.clone());
        let mut wf = HashMap::new();
        wf.insert("invoke-test".into(), def);
        let mut gw = Gateway::new(
            mgr,
            UpstreamManager::empty(),
            "invoke-session".into(),
            wf,
            Some("invoke-test".into()),
            String::new(),
            None,
        );

        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "DEBUG" }
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        assert!(resp.error.is_none());

        let text = resp.result.unwrap()["content"][0]["text"].as_str().unwrap().to_string();
        let result: serde_json::Value = serde_json::from_str(&text).unwrap();

        // Response must indicate the invoke and the eventual destination
        assert_eq!(result["transitioned"], true);
        assert_eq!(result["from"], "planning");
        assert_eq!(result["to"], "testing");         // on_complete — eventual destination
        assert!(result.get("invoke").is_some(), "response must carry invoke key");
        assert_eq!(result["invoke"]["machine"], "debug_machine");
        assert_eq!(result["invoke"]["on_complete"], "testing");

        // Parent session must NOT have advanced — stays in "planning" until sub-machine completes
        let session = gw.session_manager.get("invoke-session").unwrap();
        assert_eq!(session.current_state, "planning",
            "parent state must not advance to on_complete before sub-machine runs");
    }

    #[tokio::test]
    async fn tools_call_custom_get_state() {
        let mut gw = test_gateway();
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_get_state",
                "arguments": {}
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        let result = resp.result.unwrap();
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("planning"));
    }

    #[tokio::test]
    async fn unknown_method_returns_error() {
        let mut gw = test_gateway();
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "resources/list".into(),
            params: None,
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        assert!(resp.error.is_some());
        assert_eq!(resp.error.unwrap().code, -32601);
    }

    #[tokio::test]
    async fn notification_returns_none() {
        let mut gw = test_gateway();
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "notifications/initialized".into(),
            params: None,
            id: None,
        };
        let resp = gw.handle_message(req).await;
        assert!(resp.is_none());
    }

    // --- Approval gate integration tests ---

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
                            "approval_message": "Review before deploy"
                        },
                        "SKIP": "completed"
                    }
                },
                "deployed": {
                    "on": { "DONE": "completed" }
                },
                "completed": { "type": "final" }
            }
        }))
        .unwrap()
    }

    fn approval_gateway() -> Gateway {
        let mgr = SessionManager::new();
        mgr.create("approval-session".into(), approval_definition());
        let mut workflows = HashMap::new();
        workflows.insert("approval-test".into(), approval_definition());
        Gateway::new(
            mgr,
            UpstreamManager::empty(),
            "approval-session".into(),
            workflows,
            Some("approval-test".into()),
            String::new(),
            None,
        )
    }

    #[tokio::test]
    async fn approval_gate_parks_transition() {
        let mut gw = approval_gateway();
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "DEPLOY" }
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        assert!(resp.error.is_none());
        let result = resp.result.unwrap();
        let text = result["content"][0]["text"].as_str().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(text).unwrap();

        // Should indicate pending, not transitioned
        assert_eq!(parsed["status"], "pending_approval");

        // Session should NOT have advanced — still in "working"
        let session = gw.session_manager.get("approval-session").unwrap();
        assert_eq!(session.current_state, "working");

        // Session should have a pending approval
        assert!(session.pending_approval.is_some());
    }

    #[tokio::test]
    async fn approval_gate_blocks_further_transitions() {
        let mut gw = approval_gateway();
        // First: trigger the approval gate
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "DEPLOY" }
            })),
            id: Some(json!(1)),
        };
        gw.handle_message(req).await.unwrap();

        // Second: try another transition while approval is pending
        let req2 = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "SKIP" }
            })),
            id: Some(json!(2)),
        };
        let resp = gw.handle_message(req2).await.unwrap();
        let result = resp.result.unwrap();
        let text = result["content"][0]["text"].as_str().unwrap();
        // Should be an error about pending approval
        assert!(text.contains("pending") || text.contains("approval"));
    }

    #[tokio::test]
    async fn no_approval_mode_allows_normal_transition() {
        // Default test_gateway has no approval_mode set
        let mut gw = test_gateway();
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "READY" }
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        assert!(resp.error.is_none());

        // Should have transitioned normally
        let session = gw.session_manager.get("test-session").unwrap();
        assert_eq!(session.current_state, "implementing");
        assert!(session.pending_approval.is_none());
    }

    #[tokio::test]
    async fn get_state_shows_pending_approval() {
        let mut gw = approval_gateway();
        // Trigger the approval gate
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "DEPLOY" }
            })),
            id: Some(json!(1)),
        };
        gw.handle_message(req).await.unwrap();

        // Now get_state should include pending_approval
        let req2 = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_get_state",
                "arguments": {}
            })),
            id: Some(json!(2)),
        };
        let resp = gw.handle_message(req2).await.unwrap();
        let result = resp.result.unwrap();
        let text = result["content"][0]["text"].as_str().unwrap();
        let state: serde_json::Value = serde_json::from_str(text).unwrap();
        assert!(state["pending_approval"].is_object());
        assert_eq!(state["state"], "working"); // still in working, not deployed
    }

    // --- Interrupt integration tests (History State pattern) ---

    fn interrupt_definition() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "interrupt-test",
            "initial": "implementing",
            "context": {},
            "states": {
                "implementing": {
                    "allowed_tools": ["Edit", "Read"],
                    "on": { "DONE": "completed", "FAIL": "failed" }
                },
                "pb_validating": {
                    "allowed_tools": ["Bash"],
                    "on": { "VALIDATED": "$return", "FAIL": "failed" }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "interrupts": {
                "pb_check": {
                    "trigger": { "file_pattern": "site/pb/**/*.js" },
                    "target": "pb_validating"
                }
            }
        }))
        .unwrap()
    }

    fn interrupt_gateway() -> Gateway {
        let def = interrupt_definition();
        let mgr = SessionManager::new();
        mgr.create("int-session".into(), def.clone());
        let mut workflows = HashMap::new();
        workflows.insert("interrupt-test".into(), def);
        Gateway::new(
            mgr,
            UpstreamManager::empty(),
            "int-session".into(),
            workflows,
            Some("interrupt-test".into()),
            String::new(),
            None,
        )
    }

    #[tokio::test]
    async fn get_state_shows_interrupt_handler_when_in_handler() {
        let mut gw = interrupt_gateway();
        // Simulate being in interrupt handler (auto-transition already happened)
        let ctx = json!({"_interrupt_return": "implementing"});
        gw.session_manager.update_state("int-session", "pb_validating".into(), ctx);

        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_get_state",
                "arguments": {}
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        let result = resp.result.unwrap();
        let text = result["content"][0]["text"].as_str().unwrap();
        let state: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(state["state"], "pb_validating");
        assert!(state["interrupt_handler"].is_object());
        assert_eq!(state["interrupt_handler"]["return_state"], "implementing");
    }

    #[tokio::test]
    async fn return_transition_resumes_original_state() {
        let mut gw = interrupt_gateway();
        // Simulate being in interrupt handler
        let ctx = json!({"_interrupt_return": "implementing"});
        gw.session_manager.update_state("int-session", "pb_validating".into(), ctx);

        // Transition with VALIDATED — should resolve $return to "implementing"
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "VALIDATED" }
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        assert!(resp.error.is_none());

        let session = gw.session_manager.get("int-session").unwrap();
        assert_eq!(session.current_state, "implementing");
        // _interrupt_return should be cleared from context
        assert!(session.context.get("_interrupt_return").is_none());
    }

    #[tokio::test]
    async fn no_interrupts_allows_normal_transition() {
        // test_gateway has no interrupts defined
        let mut gw = test_gateway();
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "READY" }
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        assert!(resp.error.is_none());
        let session = gw.session_manager.get("test-session").unwrap();
        assert_eq!(session.current_state, "implementing");
    }

    #[tokio::test]
    async fn interrupt_return_stripped_from_user_event_data() {
        // Use interrupt_gateway which has context: {} (an object, not null)
        let mut gw = interrupt_gateway();
        // Transition DONE with injected _interrupt_return
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": {
                    "event": "DONE",
                    "data": { "_interrupt_return": "hacked", "real_field": "kept" }
                }
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        assert!(resp.error.is_none());
        let session = gw.session_manager.get("int-session").unwrap();
        assert_eq!(session.current_state, "completed");
        // _interrupt_return should NOT be in context (stripped)
        assert!(session.context.get("_interrupt_return").is_none());
        // real_field should be present (not stripped)
        assert_eq!(session.context.get("real_field").and_then(|v| v.as_str()), Some("kept"));
    }

    // --- Interrupt trigger integration tests (mock upstream) ---
    // These test the FULL path: file edit → pattern match → auto-transition → $return

    fn interrupt_gateway_with_mock() -> Gateway {
        let def = interrupt_definition();
        let mgr = SessionManager::new();
        mgr.create("int-mock".into(), def.clone());

        // Mock upstream with Edit tool that returns success
        let mock_edit = (
            ToolInfo {
                name: "Edit".into(),
                description: Some("Edit a file".into()),
                input_schema: json!({"type": "object", "properties": {"file_path": {"type": "string"}}}),
            },
            crate::protocol::ToolCallResult::text("File edited successfully"),
        );
        let mock_read = (
            ToolInfo {
                name: "Read".into(),
                description: Some("Read a file".into()),
                input_schema: json!({"type": "object", "properties": {"file_path": {"type": "string"}}}),
            },
            crate::protocol::ToolCallResult::text("file contents"),
        );
        let mock_bash = (
            ToolInfo {
                name: "Bash".into(),
                description: Some("Run a command".into()),
                input_schema: json!({"type": "object", "properties": {"command": {"type": "string"}}}),
            },
            crate::protocol::ToolCallResult::text("ok"),
        );

        let mut workflows = HashMap::new();
        workflows.insert("interrupt-test".into(), def);
        Gateway::new(
            mgr,
            UpstreamManager::mock(vec![mock_edit, mock_read, mock_bash]),
            "int-mock".into(),
            workflows,
            Some("interrupt-test".into()),
            String::new(),
            None,
        )
    }

    #[tokio::test]
    async fn edit_matching_file_triggers_interrupt_auto_transition() {
        let mut gw = interrupt_gateway_with_mock();

        // Edit a file matching the interrupt pattern site/pb/**/*.js
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "Edit",
                "arguments": {
                    "file_path": "site/pb/hooks/auth.pb.js",
                    "old_string": "old",
                    "new_string": "new"
                }
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        let result = resp.result.unwrap();

        // Tool call succeeded
        assert_eq!(result["isError"], false);

        // Response should contain the interrupt notice
        let texts: Vec<String> = result["content"].as_array().unwrap()
            .iter()
            .map(|c| c["text"].as_str().unwrap().to_string())
            .collect();
        let combined = texts.join("\n");
        assert!(combined.contains("STATEWRIGHT INTERRUPT"), "Expected interrupt notice, got: {}", combined);
        assert!(combined.contains("pb_check"), "Expected interrupt name");
        assert!(combined.contains("pb_validating"), "Expected target state");

        // State should have auto-transitioned to pb_validating
        let session = gw.session_manager.get("int-mock").unwrap();
        assert_eq!(session.current_state, "pb_validating");

        // Context should have _interrupt_return set
        assert_eq!(
            session.context.get("_interrupt_return").and_then(|v| v.as_str()),
            Some("implementing"),
            "Expected _interrupt_return = implementing"
        );
    }

    #[tokio::test]
    async fn edit_non_matching_file_does_not_trigger_interrupt() {
        let mut gw = interrupt_gateway_with_mock();

        // Edit a file that does NOT match the interrupt pattern
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "Edit",
                "arguments": {
                    "file_path": "src/components/App.vue",
                    "old_string": "old",
                    "new_string": "new"
                }
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();

        // No interrupt — state stays in implementing
        let session = gw.session_manager.get("int-mock").unwrap();
        assert_eq!(session.current_state, "implementing");
        assert!(session.context.get("_interrupt_return").is_none());
    }

    #[tokio::test]
    async fn interrupt_full_round_trip_edit_validate_return() {
        let mut gw = interrupt_gateway_with_mock();

        // Step 1: Edit a PB hook file — triggers interrupt
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "Edit",
                "arguments": {
                    "file_path": "site/pb/hooks/auth.pb.js",
                    "old_string": "old",
                    "new_string": "new"
                }
            })),
            id: Some(json!(1)),
        };
        gw.handle_message(req).await.unwrap();
        let session = gw.session_manager.get("int-mock").unwrap();
        assert_eq!(session.current_state, "pb_validating");

        // Step 2: Agent is now in pb_validating — transition with VALIDATED ($return)
        let req2 = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "VALIDATED" }
            })),
            id: Some(json!(2)),
        };
        let resp2 = gw.handle_message(req2).await.unwrap();
        assert!(resp2.error.is_none());

        // Step 3: Should be back in implementing, _interrupt_return cleared
        let session = gw.session_manager.get("int-mock").unwrap();
        assert_eq!(session.current_state, "implementing");
        assert!(
            session.context.get("_interrupt_return").is_none(),
            "_interrupt_return should be cleared after $return"
        );
    }

    #[tokio::test]
    async fn interrupt_reentrance_prevented_while_in_handler() {
        let mut gw = interrupt_gateway_with_mock();

        // Step 1: Edit a PB hook file — triggers interrupt
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "Edit",
                "arguments": {
                    "file_path": "site/pb/hooks/auth.pb.js",
                    "old_string": "old",
                    "new_string": "new"
                }
            })),
            id: Some(json!(1)),
        };
        gw.handle_message(req).await.unwrap();
        assert_eq!(gw.session_manager.get("int-mock").unwrap().current_state, "pb_validating");

        // Step 2: Edit ANOTHER PB hook file while already in handler
        let req2 = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "Edit",
                "arguments": {
                    "file_path": "site/pb/hooks/another.pb.js",
                    "old_string": "x",
                    "new_string": "y"
                }
            })),
            id: Some(json!(2)),
        };
        let resp2 = gw.handle_message(req2).await.unwrap();
        let result = resp2.result.unwrap();
        let texts: Vec<String> = result["content"].as_array().unwrap()
            .iter()
            .map(|c| c["text"].as_str().unwrap().to_string())
            .collect();
        let combined = texts.join("\n");

        // Should NOT trigger a second interrupt
        assert!(!combined.contains("STATEWRIGHT INTERRUPT"),
            "Should not re-trigger interrupt while already in handler");

        // Still in pb_validating (not double-transitioned)
        let session = gw.session_manager.get("int-mock").unwrap();
        assert_eq!(session.current_state, "pb_validating");
        assert_eq!(
            session.context.get("_interrupt_return").and_then(|v| v.as_str()),
            Some("implementing"),
            "_interrupt_return should still point to implementing"
        );
    }

    // --- ImplicitTransition + CheckpointReached integration tests (mock upstream) ---

    fn implicit_transition_gateway() -> Gateway {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "implicit-test",
            "initial": "planning",
            "context": {},
            "states": {
                "planning": {
                    "allowed_tools": ["Read", "Grep"],
                    "max_iterations": 3,
                    "on": { "READY": "implementing", "FAIL": "failed" }
                },
                "implementing": {
                    "allowed_tools": ["Read", "Edit", "Write", "Bash"],
                    "on": { "DONE": "completed", "FAIL": "failed" }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            }
        }))
        .unwrap();
        let mgr = SessionManager::new();
        mgr.create("impl-session".into(), def.clone());
        let mut workflows = HashMap::new();
        workflows.insert("implicit-test".into(), def);

        let mock_edit = (
            ToolInfo { name: "Edit".into(), description: None, input_schema: json!({"type": "object"}) },
            crate::protocol::ToolCallResult::text("edited"),
        );
        let mock_read = (
            ToolInfo { name: "Read".into(), description: None, input_schema: json!({"type": "object"}) },
            crate::protocol::ToolCallResult::text("file contents"),
        );
        let mock_grep = (
            ToolInfo { name: "Grep".into(), description: None, input_schema: json!({"type": "object"}) },
            crate::protocol::ToolCallResult::text("match"),
        );

        Gateway::new(
            mgr,
            UpstreamManager::mock(vec![mock_edit, mock_read, mock_grep]),
            "impl-session".into(),
            workflows,
            Some("implicit-test".into()),
            String::new(),
            None,
        )
    }

    #[tokio::test]
    async fn implicit_transition_auto_advances_and_calls_tool() {
        let mut gw = implicit_transition_gateway();

        // Edit is not in planning, but IS in implementing (reachable via READY)
        // Should auto-transition planning→implementing, then call Edit upstream
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "Edit",
                "arguments": { "file_path": "src/main.rs", "old_string": "a", "new_string": "b" }
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        let result = resp.result.unwrap();

        // Tool call should succeed (not blocked)
        assert_eq!(result["isError"], false);
        let text = result["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, "edited");

        // State should have auto-advanced to implementing
        let session = gw.session_manager.get("impl-session").unwrap();
        assert_eq!(session.current_state, "implementing");
    }

    #[tokio::test]
    async fn allowed_tool_in_current_state_does_not_implicit_transition() {
        let mut gw = implicit_transition_gateway();

        // Read IS in planning — should NOT trigger implicit transition
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "Read",
                "arguments": { "file_path": "src/main.rs" }
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        assert_eq!(resp.result.unwrap()["isError"], false);

        // Should stay in planning
        let session = gw.session_manager.get("impl-session").unwrap();
        assert_eq!(session.current_state, "planning");
    }

    #[tokio::test]
    async fn checkpoint_reached_allows_call_and_appends_notice() {
        let mut gw = implicit_transition_gateway();

        // Hit checkpoint: planning has max_iterations: 3
        gw.session_manager.increment_iteration("impl-session");
        gw.session_manager.increment_iteration("impl-session");
        gw.session_manager.increment_iteration("impl-session");

        // Read is allowed in planning — should succeed but with checkpoint notice
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "Read",
                "arguments": { "file_path": "src/main.rs" }
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        let result = resp.result.unwrap();

        // Tool call succeeded
        assert_eq!(result["isError"], false);

        // Should have checkpoint notice appended
        let texts: Vec<String> = result["content"].as_array().unwrap()
            .iter()
            .map(|c| c["text"].as_str().unwrap().to_string())
            .collect();
        let combined = texts.join("\n");
        assert!(combined.contains("STATEWRIGHT CHECKPOINT"), "Expected checkpoint notice, got: {}", combined);
        assert!(combined.contains("planning"), "Checkpoint should mention current state");
    }

    #[tokio::test]
    async fn deactivated_workflow_passes_tool_through() {
        // Gateway with no active workflow — tools pass through without enforcement
        let mgr = SessionManager::new();
        let mock_deploy = (
            ToolInfo { name: "deploy".into(), description: None, input_schema: json!({"type": "object"}) },
            crate::protocol::ToolCallResult::text("deployed"),
        );
        let mut gw = Gateway::new(
            mgr,
            UpstreamManager::mock(vec![mock_deploy]),
            "test".into(),
            HashMap::new(),
            None, // no active workflow
            String::new(),
            None,
        );

        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "deploy",
                "arguments": {}
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        let result = resp.result.unwrap();
        assert_eq!(result["isError"], false);
        assert_eq!(result["content"][0]["text"], "deployed");
    }

    // --- Interrupt trigger integration tests continued ---

    #[tokio::test]
    async fn interrupt_fail_path_goes_to_failed() {
        let mut gw = interrupt_gateway_with_mock();

        // Step 1: Trigger interrupt
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "Edit",
                "arguments": {
                    "file_path": "site/pb/hooks/bad.pb.js",
                    "old_string": "a",
                    "new_string": "b"
                }
            })),
            id: Some(json!(1)),
        };
        gw.handle_message(req).await.unwrap();

        // Step 2: Validation fails — transition FAIL from handler
        let req2 = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "FAIL" }
            })),
            id: Some(json!(2)),
        };
        gw.handle_message(req2).await.unwrap();

        // Should be in failed (not back to implementing)
        let session = gw.session_manager.get("int-mock").unwrap();
        assert_eq!(session.current_state, "failed");
        assert!(session.is_final());
    }

    // --- Plugin-triggered INTERRUPT: event tests ---

    #[tokio::test]
    async fn plugin_interrupt_event_triggers_auto_transition() {
        let mut gw = interrupt_gateway_with_mock();

        // Plugin sends INTERRUPT:pb_check event (detected file match client-side)
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": {
                    "event": "INTERRUPT:pb_check",
                    "data": { "trigger_file": "site/pb/hooks/auth.pb.js" }
                }
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        let result = resp.result.unwrap();
        let text = result["content"][0]["text"].as_str().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["interrupted"], true);
        assert_eq!(parsed["from"], "implementing");
        assert_eq!(parsed["to"], "pb_validating");

        // State should be in pb_validating with _interrupt_return
        let session = gw.session_manager.get("int-mock").unwrap();
        assert_eq!(session.current_state, "pb_validating");
        assert_eq!(
            session.context.get("_interrupt_return").and_then(|v| v.as_str()),
            Some("implementing")
        );
    }

    #[tokio::test]
    async fn plugin_interrupt_skipped_when_already_in_handler() {
        let mut gw = interrupt_gateway_with_mock();

        // First interrupt
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "INTERRUPT:pb_check" }
            })),
            id: Some(json!(1)),
        };
        gw.handle_message(req).await.unwrap();

        // Second interrupt while in handler — should be skipped
        let req2 = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "INTERRUPT:pb_check" }
            })),
            id: Some(json!(2)),
        };
        let resp2 = gw.handle_message(req2).await.unwrap();
        let result2 = resp2.result.unwrap();
        let text = result2["content"][0]["text"].as_str().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["skipped"], true);

        // Still in pb_validating
        let session = gw.session_manager.get("int-mock").unwrap();
        assert_eq!(session.current_state, "pb_validating");
    }

    #[tokio::test]
    async fn plugin_interrupt_unknown_name_errors() {
        let mut gw = interrupt_gateway_with_mock();

        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "INTERRUPT:nonexistent" }
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        let result = resp.result.unwrap();
        assert_eq!(result["isError"], true);
    }

    #[tokio::test]
    async fn plugin_interrupt_then_return_full_roundtrip() {
        let mut gw = interrupt_gateway_with_mock();

        // Step 1: Plugin triggers interrupt
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "INTERRUPT:pb_check" }
            })),
            id: Some(json!(1)),
        };
        gw.handle_message(req).await.unwrap();
        assert_eq!(gw.session_manager.get("int-mock").unwrap().current_state, "pb_validating");

        // Step 2: Agent validates, transitions VALIDATED ($return)
        let req2 = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "VALIDATED" }
            })),
            id: Some(json!(2)),
        };
        gw.handle_message(req2).await.unwrap();

        // Should be back in implementing
        let session = gw.session_manager.get("int-mock").unwrap();
        assert_eq!(session.current_state, "implementing");
        assert!(session.context.get("_interrupt_return").is_none());
    }

    // --- Fork/join integration tests ---

    fn fork_definition() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "fork-test",
            "initial": "building",
            "context": {},
            "states": {
                "building": {
                    "on": {
                        "BUILD_DONE": {
                            "fork": {
                                "branches": {
                                    "lint": { "initial": "lint_run", "terminal": "lint_done" },
                                    "types": { "initial": "types_run", "terminal": "types_done" }
                                },
                                "join": "all",
                                "on_complete": "deploying",
                                "on_fail": "failed"
                            }
                        }
                    }
                },
                "lint_run": { "allowed_tools": ["Bash"], "on": { "PASS": "lint_done", "FAIL": "lint_failed" } },
                "lint_done": { "type": "final" },
                "lint_failed": { "type": "final" },
                "types_run": { "allowed_tools": ["Bash"], "on": { "PASS": "types_done", "FAIL": "types_failed" } },
                "types_done": { "type": "final" },
                "types_failed": { "type": "final" },
                "deploying": { "on": { "DEPLOYED": "completed" } },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            }
        }))
        .unwrap()
    }

    fn fork_gateway() -> Gateway {
        let def = fork_definition();
        let mgr = SessionManager::new();
        mgr.create("fork-session".into(), def.clone());
        let mut workflows = HashMap::new();
        workflows.insert("fork-test".into(), def);
        Gateway::new(
            mgr,
            UpstreamManager::empty(),
            "fork-session".into(),
            workflows,
            Some("fork-test".into()),
            String::new(),
            None,
        )
    }

    #[tokio::test]
    async fn fork_transition_creates_branch_sessions() {
        let mut gw = fork_gateway();

        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "BUILD_DONE" }
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        let result = resp.result.unwrap();
        let text = result["content"][0]["text"].as_str().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(text).unwrap();

        assert_eq!(parsed["forked"], true);
        assert!(parsed["branches"]["lint"].is_object());
        assert!(parsed["branches"]["types"].is_object());

        // Parent should have _fork in context
        let session = gw.session_manager.get("fork-session").unwrap();
        assert!(session.context.get("_fork").is_some());

        // Branch sessions should exist
        let lint_session = gw.session_manager.get("fork-session_br_lint");
        assert!(lint_session.is_some());
        assert_eq!(lint_session.unwrap().current_state, "lint_run");

        let types_session = gw.session_manager.get("fork-session_br_types");
        assert!(types_session.is_some());
        assert_eq!(types_session.unwrap().current_state, "types_run");
    }

    #[tokio::test]
    async fn branch_done_sequential_advances_to_next() {
        let mut gw = fork_gateway();

        // Fork
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "BUILD_DONE" }
            })),
            id: Some(json!(1)),
        };
        gw.handle_message(req).await.unwrap();

        // Complete first branch (lint)
        let req2 = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "BRANCH_DONE:lint" }
            })),
            id: Some(json!(2)),
        };
        let resp2 = gw.handle_message(req2).await.unwrap();
        let result2 = resp2.result.unwrap();
        let text = result2["content"][0]["text"].as_str().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(text).unwrap();

        assert_eq!(parsed["branch_completed"], "lint");
        assert_eq!(parsed["remaining"], 1);

        // Parent should still have _fork (not joined yet)
        let session = gw.session_manager.get("fork-session").unwrap();
        assert!(session.context.get("_fork").is_some());
    }

    #[tokio::test]
    async fn branch_done_last_triggers_join() {
        let mut gw = fork_gateway();

        // Fork
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "BUILD_DONE" }
            })),
            id: Some(json!(1)),
        };
        gw.handle_message(req).await.unwrap();

        // Complete both branches
        let req2 = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "BRANCH_DONE:lint" }
            })),
            id: Some(json!(2)),
        };
        gw.handle_message(req2).await.unwrap();

        let req3 = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "BRANCH_DONE:types" }
            })),
            id: Some(json!(3)),
        };
        let resp3 = gw.handle_message(req3).await.unwrap();
        let result3 = resp3.result.unwrap();
        let text = result3["content"][0]["text"].as_str().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(text).unwrap();

        assert_eq!(parsed["joined"], true);
        assert_eq!(parsed["to"], "deploying");

        // Parent should be in deploying, _fork cleaned up
        let session = gw.session_manager.get("fork-session").unwrap();
        assert_eq!(session.current_state, "deploying");
        assert!(session.context.get("_fork").is_none());
    }

    #[tokio::test]
    async fn branch_done_no_fork_errors() {
        let mut gw = fork_gateway();
        // No fork active — BRANCH_DONE should error
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "BRANCH_DONE:lint" }
            })),
            id: Some(json!(1)),
        };
        let resp = gw.handle_message(req).await.unwrap();
        let result = resp.result.unwrap();
        assert_eq!(result["isError"], true);
    }

    #[tokio::test]
    async fn fork_strips_fork_from_user_data() {
        let mut gw = fork_gateway();
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": {
                    "event": "BUILD_DONE",
                    "data": { "_fork": "injected", "real": "kept" }
                }
            })),
            id: Some(json!(1)),
        };
        gw.handle_message(req).await.unwrap();
        let session = gw.session_manager.get("fork-session").unwrap();
        // _fork should be the gateway-managed one, not the injected string
        assert!(session.context["_fork"].is_object());
    }

    #[tokio::test]
    async fn get_state_during_fork_returns_branch_state() {
        let mut gw = fork_gateway();

        // Fork
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "BUILD_DONE" }
            })),
            id: Some(json!(1)),
        };
        gw.handle_message(req).await.unwrap();

        // get_state should return current branch state, not parent
        let req2 = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_get_state",
                "arguments": {}
            })),
            id: Some(json!(2)),
        };
        let resp = gw.handle_message(req2).await.unwrap();
        let result = resp.result.unwrap();
        let text = result["content"][0]["text"].as_str().unwrap();
        let state: serde_json::Value = serde_json::from_str(text).unwrap();

        // Should show branch state (lint_run), not parent state (building)
        assert_eq!(state["state"], "lint_run");
        // Should have fork status
        assert!(state["fork"].is_object());
        assert_eq!(state["fork"]["active"], true);
        assert!(state["fork"]["branches"]["lint"].is_object());
    }

    #[tokio::test]
    async fn fork_full_sequential_roundtrip() {
        let mut gw = fork_gateway();

        // 1. Fork
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "BUILD_DONE" }
            })),
            id: Some(json!(1)),
        };
        gw.handle_message(req).await.unwrap();

        // 2. get_state returns first branch
        let req2 = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({ "name": "statewright_get_state", "arguments": {} })),
            id: Some(json!(2)),
        };
        let resp2 = gw.handle_message(req2).await.unwrap();
        let state2 = serde_json::from_str::<serde_json::Value>(
            resp2.result.unwrap()["content"][0]["text"].as_str().unwrap()
        ).unwrap();
        assert_eq!(state2["state"], "lint_run");

        // 3. Complete first branch
        let req3 = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "BRANCH_DONE:lint" }
            })),
            id: Some(json!(3)),
        };
        gw.handle_message(req3).await.unwrap();

        // 4. get_state returns second branch
        let req4 = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({ "name": "statewright_get_state", "arguments": {} })),
            id: Some(json!(4)),
        };
        let resp4 = gw.handle_message(req4).await.unwrap();
        let state4 = serde_json::from_str::<serde_json::Value>(
            resp4.result.unwrap()["content"][0]["text"].as_str().unwrap()
        ).unwrap();
        assert_eq!(state4["state"], "types_run");

        // 5. Complete second branch — triggers join
        let req5 = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({
                "name": "statewright_transition",
                "arguments": { "event": "BRANCH_DONE:types" }
            })),
            id: Some(json!(5)),
        };
        gw.handle_message(req5).await.unwrap();

        // 6. get_state shows deploying (post-join)
        let req6 = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(json!({ "name": "statewright_get_state", "arguments": {} })),
            id: Some(json!(6)),
        };
        let resp6 = gw.handle_message(req6).await.unwrap();
        let state6 = serde_json::from_str::<serde_json::Value>(
            resp6.result.unwrap()["content"][0]["text"].as_str().unwrap()
        ).unwrap();
        assert_eq!(state6["state"], "deploying");
        // Fork should be cleaned up
        assert!(state6.get("fork").is_none() || state6["fork"].is_null());
    }
}
