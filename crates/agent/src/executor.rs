use crate::ollama_client::{OllamaClient, OllamaError};
use crate::prompt_templates;
use crate::tool_enforcer;
use statewright_engine::{MachineDefinition, StateType, TransitionError};
use serde::Deserialize;
use serde_json::Value;

/// Tracks the full state of an executing agent session.
#[derive(Debug, Clone)]
pub struct ExecutionState {
    pub definition: MachineDefinition,
    pub current_state: String,
    pub context: Value,
    pub step_count: u32,
    pub status: ExecutionStatus,
    pub steps: Vec<StepRecord>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExecutionStatus {
    Running,
    AwaitingApproval { event: String, message: String },
    AwaitingInvoke {
        machine: String,
        on_complete: String,
        on_fail: Option<String>,
        input: Option<Value>,
    },
    Completed,
    Failed { error: String },
}

/// Registry of sub-machine definitions that can be invoked.
pub struct MachineRegistry {
    machines: std::collections::HashMap<String, MachineDefinition>,
}

impl MachineRegistry {
    pub fn new() -> Self {
        Self {
            machines: std::collections::HashMap::new(),
        }
    }

    pub fn register(&mut self, name: &str, definition: MachineDefinition) {
        self.machines.insert(name.to_string(), definition);
    }

    pub fn get(&self, name: &str) -> Option<&MachineDefinition> {
        self.machines.get(name)
    }
}

/// Record of a single execution step.
#[derive(Debug, Clone)]
pub struct StepRecord {
    pub step_number: u32,
    pub state: String,
    pub tools_requested: Vec<String>,
    pub tools_allowed: Vec<String>,
    pub tools_blocked: Vec<String>,
    pub transition_event: Option<String>,
    pub llm_response: String,
}

/// What the LLM responded with (parsed from its output).
#[derive(Debug, Clone, Deserialize)]
struct LlmAction {
    #[serde(default)]
    transition: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Debug, Clone, Deserialize)]
struct ToolCall {
    name: String,
    #[serde(default)]
    #[allow(dead_code)]
    args: Value,
}

impl ExecutionState {
    /// Create a new execution from a validated machine definition.
    pub fn new(definition: MachineDefinition) -> Self {
        let initial = definition.initial.clone();
        let context = definition.context.clone();
        Self {
            definition,
            current_state: initial,
            context,
            step_count: 0,
            status: ExecutionStatus::Running,
            steps: Vec::new(),
        }
    }

    /// Execute a single step: call the LLM, enforce tools, process the response.
    /// Returns the step record. Advances internal state if a transition occurs.
    pub async fn step(&mut self, client: &OllamaClient) -> Result<StepRecord, ExecutionError> {
        if self.status != ExecutionStatus::Running {
            return Err(ExecutionError::NotRunning(self.status.clone()));
        }

        // Check iteration limit for current state
        if let Some(state_def) = self.definition.states.get(&self.current_state) {
            if let Some(max) = state_def.max_iterations {
                let steps_in_state = self
                    .steps
                    .iter()
                    .rev()
                    .take_while(|s| s.state == self.current_state)
                    .count() as u32;

                if steps_in_state >= max {
                    self.status = ExecutionStatus::Failed {
                        error: format!(
                            "max iterations ({}) exceeded in state '{}'",
                            max, self.current_state
                        ),
                    };
                    return Err(ExecutionError::MaxIterationsExceeded {
                        state: self.current_state.clone(),
                        limit: max,
                    });
                }
            }
        }

        // Build the prompt
        let state_def = self.definition.states.get(&self.current_state);
        let instructions = state_def.and_then(|s| s.instructions.as_deref());
        let allowed_tools = state_def
            .and_then(|s| s.allowed_tools.as_ref())
            .cloned()
            .unwrap_or_default();

        let transitions: Vec<(String, String)> = state_def
            .map(|s| {
                s.on
                    .iter()
                    .map(|(event, t)| (event.clone(), t.target().to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let context_summary = serde_json::to_string_pretty(&self.context).unwrap_or_default();

        let messages = prompt_templates::build_execution_prompt(
            &self.definition.id,
            &self.current_state,
            instructions,
            &allowed_tools,
            &transitions,
            &context_summary,
        );

        // Call the LLM
        let raw_response = client.chat(messages).await.map_err(ExecutionError::Ollama)?;

        // Parse the response — try to extract structured action
        let action = parse_llm_response(&raw_response);

        // Enforce tools
        let tools_requested: Vec<String> = action
            .tool_calls
            .as_ref()
            .map(|calls| calls.iter().map(|c| c.name.clone()).collect())
            .unwrap_or_default();

        let enforcement =
            tool_enforcer::enforce_tools(&self.definition, &self.current_state, &tools_requested);

        self.step_count += 1;

        let mut record = StepRecord {
            step_number: self.step_count,
            state: self.current_state.clone(),
            tools_requested,
            tools_allowed: enforcement.allowed,
            tools_blocked: enforcement.blocked.clone(),
            transition_event: None,
            llm_response: raw_response,
        };

        // Process transition if requested
        if let Some(event) = &action.transition {
            record.transition_event = Some(event.clone());

            // Check if this is a FAIL transition
            if event == "FAIL" {
                let error_msg = action
                    .error
                    .unwrap_or_else(|| "agent reported failure".into());

                // Attempt the transition to "failed" state
                match statewright_engine::resolve_transition(
                    &self.current_state,
                    event,
                    &Value::Null,
                    &self.context,
                    &self.definition,
                ) {
                    Ok(result) => {
                        self.current_state = result.new_state;
                        self.context = result.new_context;
                    }
                    Err(_) => {
                        // Even if FAIL isn't a defined transition, force to failed state
                        if self.definition.states.contains_key("failed") {
                            self.current_state = "failed".into();
                        }
                    }
                }
                self.status = ExecutionStatus::Failed { error: error_msg };
            } else {
                // Normal transition
                match statewright_engine::resolve_transition(
                    &self.current_state,
                    event,
                    &Value::Null,
                    &self.context,
                    &self.definition,
                ) {
                    Ok(result) => {
                        if result.requires_approval {
                            self.status = ExecutionStatus::AwaitingApproval {
                                event: event.clone(),
                                message: result
                                    .approval_message
                                    .unwrap_or_else(|| "Approval required".into()),
                            };
                        } else if let Some(invoke) = result.invoke {
                            // Transition triggers a sub-machine invocation
                            self.status = ExecutionStatus::AwaitingInvoke {
                                machine: invoke.machine,
                                on_complete: invoke.on_complete,
                                on_fail: invoke.on_fail,
                                input: invoke.input,
                            };
                        } else {
                            self.current_state = result.new_state.clone();
                            self.context = result.new_context;

                            // Check if we reached a final state
                            if let Some(target_def) =
                                self.definition.states.get(&result.new_state)
                            {
                                if matches!(target_def.state_type, Some(StateType::Final)) {
                                    self.status = ExecutionStatus::Completed;
                                }
                            }
                        }
                    }
                    Err(TransitionError::GuardFailed { guard: _ }) => {
                        // Guard failed — stay in current state
                        record.transition_event = None;
                    }
                    Err(TransitionError::NoMatchingTransition { .. }) => {
                        // Invalid event — stay in current state
                        record.transition_event = None;
                    }
                    Err(e) => return Err(ExecutionError::Transition(e)),
                }
            }
        }

        self.steps.push(record.clone());
        Ok(record)
    }

    /// Resume execution after human approval.
    /// Completes the pending transition.
    pub fn approve(&mut self) -> Result<(), ExecutionError> {
        let (event, _message) = match &self.status {
            ExecutionStatus::AwaitingApproval { event, message } => {
                (event.clone(), message.clone())
            }
            other => return Err(ExecutionError::NotAwaitingApproval(other.clone())),
        };

        // Execute the transition that was pending approval
        match statewright_engine::resolve_transition(
            &self.current_state,
            &event,
            &Value::Null,
            &self.context,
            &self.definition,
        ) {
            Ok(result) => {
                self.current_state = result.new_state.clone();
                self.context = result.new_context;

                if let Some(target_def) = self.definition.states.get(&result.new_state) {
                    if matches!(target_def.state_type, Some(StateType::Final)) {
                        self.status = ExecutionStatus::Completed;
                    } else {
                        self.status = ExecutionStatus::Running;
                    }
                } else {
                    self.status = ExecutionStatus::Running;
                }
                Ok(())
            }
            Err(e) => Err(ExecutionError::Transition(e)),
        }
    }

    /// Reject the pending approval — send back to a previous state or fail.
    pub fn reject(&mut self, reason: &str) {
        self.status = ExecutionStatus::Failed {
            error: format!("approval rejected: {}", reason),
        };
        if self.definition.states.contains_key("failed") {
            self.current_state = "failed".into();
        }
    }

    /// Resume after a sub-machine completed successfully.
    /// Advances to the on_complete state specified in the invoke transition.
    pub fn complete_invoke(&mut self, child_context: Option<Value>) -> Result<(), ExecutionError> {
        let on_complete = match &self.status {
            ExecutionStatus::AwaitingInvoke { on_complete, .. } => on_complete.clone(),
            other => return Err(ExecutionError::NotAwaitingInvoke(other.clone())),
        };

        // Merge child context into parent if provided
        if let Some(child_ctx) = child_context {
            // Ensure parent context is an object
            if !self.context.is_object() {
                self.context = Value::Object(serde_json::Map::new());
            }
            if let (Some(parent), Some(child)) = (self.context.as_object_mut(), child_ctx.as_object()) {
                for (k, v) in child {
                    parent.insert(k.clone(), v.clone());
                }
            }
        }

        self.current_state = on_complete;
        self.status = ExecutionStatus::Running;

        // Check if on_complete is a final state
        if let Some(state_def) = self.definition.states.get(&self.current_state) {
            if matches!(state_def.state_type, Some(StateType::Final)) {
                self.status = ExecutionStatus::Completed;
            }
        }

        Ok(())
    }

    /// Resume after a sub-machine failed.
    /// Advances to the on_fail state, or fails the parent if no on_fail specified.
    pub fn fail_invoke(&mut self, error: &str) -> Result<(), ExecutionError> {
        let on_fail = match &self.status {
            ExecutionStatus::AwaitingInvoke { on_fail, .. } => on_fail.clone(),
            other => return Err(ExecutionError::NotAwaitingInvoke(other.clone())),
        };

        match on_fail {
            Some(fail_state) => {
                self.current_state = fail_state;
                self.status = ExecutionStatus::Running;
            }
            None => {
                self.status = ExecutionStatus::Failed {
                    error: format!("sub-machine failed: {}", error),
                };
                if self.definition.states.contains_key("failed") {
                    self.current_state = "failed".into();
                }
            }
        }

        Ok(())
    }
}

/// Parse the LLM's raw text response into a structured action.
/// The LLM might respond with:
/// - A JSON object with "transition" and/or "tool_calls"
/// - Plain text (no transition, just working)
fn parse_llm_response(raw: &str) -> LlmAction {
    let trimmed = raw.trim();

    // Try to parse as JSON first
    if let Ok(action) = serde_json::from_str::<LlmAction>(trimmed) {
        return action;
    }

    // Try to find JSON embedded in the response
    if let Some(start) = trimmed.find('{') {
        if let Some(end) = trimmed.rfind('}') {
            if let Ok(action) = serde_json::from_str::<LlmAction>(&trimmed[start..=end]) {
                return action;
            }
        }
    }

    // Markdown code blocks → tool calls (gemma4 and small models write ```bash ... ``` as text)
    let mut tool_calls = Vec::new();
    let mut search = trimmed;
    while let Some(fence_start) = search.find("```") {
        let after_fence = &search[fence_start + 3..];
        // Check if this is a bash/sh/shell code block
        let lang_end = after_fence.find('\n').unwrap_or(0);
        let lang = after_fence[..lang_end].trim();
        if lang == "bash" || lang == "sh" || lang == "shell" {
            let content_start = lang_end + 1;
            if let Some(close) = after_fence[content_start..].find("```") {
                let cmd = after_fence[content_start..content_start + close].trim();
                if !cmd.is_empty() {
                    tool_calls.push(ToolCall {
                        name: "bash".into(),
                        args: serde_json::json!({ "command": cmd }),
                    });
                }
                search = &after_fence[content_start + close + 3..];
                continue;
            }
        }
        search = &after_fence[lang_end..];
    }
    if !tool_calls.is_empty() {
        return LlmAction {
            transition: None,
            error: None,
            tool_calls: Some(tool_calls),
        };
    }

    // No structured action found — LLM is just talking
    LlmAction {
        transition: None,
        error: None,
        tool_calls: None,
    }
}

#[derive(Debug)]
pub enum ExecutionError {
    NotRunning(ExecutionStatus),
    NotAwaitingApproval(ExecutionStatus),
    NotAwaitingInvoke(ExecutionStatus),
    Ollama(OllamaError),
    Transition(TransitionError),
    MaxIterationsExceeded { state: String, limit: u32 },
}

impl std::fmt::Display for ExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExecutionError::NotRunning(s) => write!(f, "execution not running: {:?}", s),
            ExecutionError::NotAwaitingInvoke(s) => {
                write!(f, "not awaiting invoke: {:?}", s)
            }
            ExecutionError::NotAwaitingApproval(s) => {
                write!(f, "not awaiting approval: {:?}", s)
            }
            ExecutionError::Ollama(e) => write!(f, "ollama error: {}", e),
            ExecutionError::Transition(e) => write!(f, "transition error: {}", e),
            ExecutionError::MaxIterationsExceeded { state, limit } => {
                write!(f, "max iterations ({}) exceeded in state '{}'", limit, state)
            }
        }
    }
}

impl std::error::Error for ExecutionError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ollama_client::OllamaConfig;
    use serde_json::json;
    use tokio::net::TcpListener;

    fn bug_fix_machine() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "fix-bug",
            "initial": "planning",
            "meta": { "task_type": "bug_fix", "danger_level": "moderate" },
            "states": {
                "planning": {
                    "allowed_tools": ["read_file", "grep"],
                    "instructions": "Analyze the bug.",
                    "max_iterations": 3,
                    "on": { "PLAN_READY": "implementing", "FAIL": "failed" }
                },
                "implementing": {
                    "allowed_tools": ["read_file", "write_file"],
                    "on": { "DONE": "testing", "FAIL": "failed" }
                },
                "testing": {
                    "allowed_tools": ["read_file", "run_test"],
                    "on": {
                        "TESTS_PASS": {
                            "target": "review",
                            "requires_approval": true,
                            "approval_message": "Tests pass. Review changes?"
                        },
                        "TESTS_FAIL": "implementing",
                        "FAIL": "failed"
                    }
                },
                "review": {
                    "on": { "APPROVED": "completed", "REJECTED": "implementing" }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap()
    }

    /// Mock Ollama that returns a sequence of responses.
    async fn start_sequenced_mock(responses: Vec<String>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{}", addr);

        let responses = std::sync::Arc::new(std::sync::Mutex::new(responses.into_iter()));

        let handle = tokio::spawn(async move {
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(conn) => conn,
                    Err(_) => break,
                };

                let next_response = {
                    let mut iter = responses.lock().unwrap();
                    iter.next().unwrap_or_else(|| r#"{"transition": "FAIL", "error": "no more mock responses"}"#.into())
                };

                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut stream = stream;
                    let mut buf = vec![0u8; 8192];
                    let _ = stream.read(&mut buf).await;

                    let body = json!({
                        "choices": [{
                            "message": {
                                "role": "assistant",
                                "content": next_response
                            }
                        }]
                    });

                    let body_str = serde_json::to_string(&body).unwrap();
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body_str.len(), body_str
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                });
            }
        });

        (url, handle)
    }

    fn mock_client(url: &str) -> OllamaClient {
        OllamaClient::new(OllamaConfig {
            api_url: url.into(),
            model: "test".into(),
            temperature: 0.3,
            max_tokens: 4096,
            thinking_level: None,
        })
    }

    #[test]
    fn new_execution_starts_in_initial_state() {
        let exec = ExecutionState::new(bug_fix_machine());
        assert_eq!(exec.current_state, "planning");
        assert_eq!(exec.status, ExecutionStatus::Running);
        assert_eq!(exec.step_count, 0);
    }

    #[tokio::test]
    async fn step_advances_state_on_transition() {
        let responses = vec![
            r#"{"transition": "PLAN_READY"}"#.into(),
        ];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let mut exec = ExecutionState::new(bug_fix_machine());
        let record = exec.step(&client).await.unwrap();

        assert_eq!(record.transition_event, Some("PLAN_READY".into()));
        assert_eq!(exec.current_state, "implementing");
        assert_eq!(exec.status, ExecutionStatus::Running);
        assert_eq!(exec.step_count, 1);

        handle.abort();
    }

    #[tokio::test]
    async fn step_blocks_unauthorized_tools() {
        // LLM tries to use write_file while in planning state (only read_file, grep allowed)
        let responses = vec![
            r#"{"tool_calls": [{"name": "read_file", "args": {}}, {"name": "write_file", "args": {}}]}"#.into(),
        ];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let mut exec = ExecutionState::new(bug_fix_machine());
        let record = exec.step(&client).await.unwrap();

        assert_eq!(record.tools_allowed, vec!["read_file"]);
        assert_eq!(record.tools_blocked, vec!["write_file"]);
        // No transition — still in planning
        assert_eq!(exec.current_state, "planning");

        handle.abort();
    }

    #[tokio::test]
    async fn step_parks_at_approval_gate() {
        let responses = vec![
            r#"{"transition": "PLAN_READY"}"#.into(),
            r#"{"transition": "DONE"}"#.into(),
            r#"{"transition": "TESTS_PASS"}"#.into(),
        ];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let mut exec = ExecutionState::new(bug_fix_machine());

        // planning → implementing
        exec.step(&client).await.unwrap();
        assert_eq!(exec.current_state, "implementing");

        // implementing → testing
        exec.step(&client).await.unwrap();
        assert_eq!(exec.current_state, "testing");

        // testing → (approval gate) → parks
        exec.step(&client).await.unwrap();
        assert_eq!(exec.current_state, "testing"); // hasn't moved yet
        assert!(matches!(exec.status, ExecutionStatus::AwaitingApproval { .. }));

        if let ExecutionStatus::AwaitingApproval { message, .. } = &exec.status {
            assert_eq!(message, "Tests pass. Review changes?");
        }

        handle.abort();
    }

    #[tokio::test]
    async fn approve_resumes_execution() {
        let responses = vec![
            r#"{"transition": "PLAN_READY"}"#.into(),
            r#"{"transition": "DONE"}"#.into(),
            r#"{"transition": "TESTS_PASS"}"#.into(),
        ];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let mut exec = ExecutionState::new(bug_fix_machine());
        exec.step(&client).await.unwrap(); // → implementing
        exec.step(&client).await.unwrap(); // → testing
        exec.step(&client).await.unwrap(); // → awaiting approval

        // Approve
        exec.approve().unwrap();
        assert_eq!(exec.current_state, "review");
        assert_eq!(exec.status, ExecutionStatus::Running);

        handle.abort();
    }

    #[tokio::test]
    async fn reject_fails_execution() {
        let responses = vec![
            r#"{"transition": "PLAN_READY"}"#.into(),
            r#"{"transition": "DONE"}"#.into(),
            r#"{"transition": "TESTS_PASS"}"#.into(),
        ];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let mut exec = ExecutionState::new(bug_fix_machine());
        exec.step(&client).await.unwrap();
        exec.step(&client).await.unwrap();
        exec.step(&client).await.unwrap();

        exec.reject("changes look wrong");
        assert_eq!(exec.current_state, "failed");
        assert!(matches!(exec.status, ExecutionStatus::Failed { .. }));

        handle.abort();
    }

    #[tokio::test]
    async fn step_reaches_final_state() {
        let responses = vec![
            r#"{"transition": "PLAN_READY"}"#.into(),
            r#"{"transition": "DONE"}"#.into(),
            r#"{"transition": "TESTS_PASS"}"#.into(),
            // After approval:
            r#"{"transition": "APPROVED"}"#.into(),
        ];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let mut exec = ExecutionState::new(bug_fix_machine());
        exec.step(&client).await.unwrap(); // → implementing
        exec.step(&client).await.unwrap(); // → testing
        exec.step(&client).await.unwrap(); // → awaiting approval
        exec.approve().unwrap();            // → review

        exec.step(&client).await.unwrap(); // → completed
        assert_eq!(exec.current_state, "completed");
        assert_eq!(exec.status, ExecutionStatus::Completed);

        handle.abort();
    }

    #[tokio::test]
    async fn step_refuses_when_not_running() {
        let responses = vec![
            r#"{"transition": "FAIL", "error": "something broke"}"#.into(),
            r#"{"transition": "PLAN_READY"}"#.into(), // should never be called
        ];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let mut exec = ExecutionState::new(bug_fix_machine());
        exec.step(&client).await.unwrap(); // → failed

        let result = exec.step(&client).await;
        assert!(result.is_err());

        handle.abort();
    }

    #[tokio::test]
    async fn max_iterations_enforced() {
        // Planning state has max_iterations: 3
        let responses = vec![
            "I'm still thinking...".into(),
            "Still analyzing...".into(),
            "More analysis needed...".into(),
            "Even more...".into(), // should never reach this
        ];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let mut exec = ExecutionState::new(bug_fix_machine());
        exec.step(&client).await.unwrap(); // step 1 in planning
        exec.step(&client).await.unwrap(); // step 2 in planning
        exec.step(&client).await.unwrap(); // step 3 in planning

        // Step 4 should fail — max_iterations: 3
        let result = exec.step(&client).await;
        assert!(result.is_err());
        assert!(matches!(exec.status, ExecutionStatus::Failed { .. }));

        handle.abort();
    }

    #[tokio::test]
    async fn full_lifecycle_planning_to_completed() {
        let responses = vec![
            r#"{"transition": "PLAN_READY"}"#.into(),
            r#"{"transition": "DONE"}"#.into(),
            r#"{"transition": "TESTS_PASS"}"#.into(),
            r#"{"transition": "APPROVED"}"#.into(),
        ];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let mut exec = ExecutionState::new(bug_fix_machine());

        exec.step(&client).await.unwrap();
        assert_eq!(exec.current_state, "implementing");

        exec.step(&client).await.unwrap();
        assert_eq!(exec.current_state, "testing");

        exec.step(&client).await.unwrap();
        assert!(matches!(exec.status, ExecutionStatus::AwaitingApproval { .. }));

        exec.approve().unwrap();
        assert_eq!(exec.current_state, "review");

        exec.step(&client).await.unwrap();
        assert_eq!(exec.current_state, "completed");
        assert_eq!(exec.status, ExecutionStatus::Completed);
        assert_eq!(exec.step_count, 4);
        assert_eq!(exec.steps.len(), 4);

        handle.abort();
    }

    #[test]
    fn parse_llm_response_extracts_json() {
        let raw = r#"{"transition": "PLAN_READY"}"#;
        let action = parse_llm_response(raw);
        assert_eq!(action.transition, Some("PLAN_READY".into()));
    }

    #[test]
    fn parse_llm_response_extracts_embedded_json() {
        let raw = "I've finished analyzing. Here's my action: {\"transition\": \"DONE\"}";
        let action = parse_llm_response(raw);
        assert_eq!(action.transition, Some("DONE".into()));
    }

    #[test]
    fn parse_llm_response_handles_plain_text() {
        let raw = "I'm still working on analyzing the code...";
        let action = parse_llm_response(raw);
        assert!(action.transition.is_none());
        assert!(action.tool_calls.is_none());
    }

    #[test]
    fn parse_llm_response_extracts_tool_calls() {
        let raw = r#"{"tool_calls": [{"name": "read_file", "args": {"path": "src/main.rs"}}]}"#;
        let action = parse_llm_response(raw);
        assert!(action.transition.is_none());
        let calls = action.tool_calls.unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
    }

    #[test]
    fn parse_llm_response_extracts_bash_code_blocks() {
        let raw = "Let me check the files.\n\n```bash\nls -R\n```\n\nThat should show everything.";
        let action = parse_llm_response(raw);
        assert!(action.transition.is_none());
        let calls = action.tool_calls.unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "bash");
        assert_eq!(calls[0].args["command"], "ls -R");
    }

    #[test]
    fn parse_llm_response_extracts_multiple_code_blocks() {
        let raw = "First:\n```bash\npytest -q\n```\nThen:\n```sh\ngrep -r TODO src/\n```";
        let action = parse_llm_response(raw);
        let calls = action.tool_calls.unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].args["command"], "pytest -q");
        assert_eq!(calls[1].args["command"], "grep -r TODO src/");
    }

    #[test]
    fn parse_llm_response_ignores_non_bash_code_blocks() {
        let raw = "Here's the fix:\n```python\nprint('hello')\n```";
        let action = parse_llm_response(raw);
        assert!(action.tool_calls.is_none());
    }

    // invoke tests

    fn tdd_machine_with_invoke() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "tdd-with-debug",
            "initial": "implementing",
            "states": {
                "implementing": {
                    "on": { "DONE": "testing", "FAIL": "failed" }
                },
                "testing": {
                    "on": {
                        "TESTS_PASS": "completed",
                        "TESTS_FAIL": {
                            "invoke": "debug_machine",
                            "on_complete": "testing",
                            "on_fail": "failed",
                            "input": { "scope": "last_change" }
                        }
                    }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn invoke_transition_sets_awaiting_invoke() {
        let responses = vec![
            r#"{"transition": "DONE"}"#.into(),
            r#"{"transition": "TESTS_FAIL"}"#.into(),
        ];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let mut exec = ExecutionState::new(tdd_machine_with_invoke());
        exec.step(&client).await.unwrap(); // implementing → testing
        exec.step(&client).await.unwrap(); // testing → TESTS_FAIL → AwaitingInvoke

        match &exec.status {
            ExecutionStatus::AwaitingInvoke { machine, on_complete, on_fail, input } => {
                assert_eq!(machine, "debug_machine");
                assert_eq!(on_complete, "testing");
                assert_eq!(on_fail.as_deref(), Some("failed"));
                assert_eq!(input, &Some(json!({"scope": "last_change"})));
            }
            other => panic!("expected AwaitingInvoke, got {:?}", other),
        }

        handle.abort();
    }

    #[tokio::test]
    async fn complete_invoke_resumes_parent() {
        let responses = vec![
            r#"{"transition": "DONE"}"#.into(),
            r#"{"transition": "TESTS_FAIL"}"#.into(),
        ];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let mut exec = ExecutionState::new(tdd_machine_with_invoke());
        exec.step(&client).await.unwrap();
        exec.step(&client).await.unwrap();

        // Sub-machine completed — resume at on_complete (testing)
        exec.complete_invoke(Some(json!({"fix_applied": true}))).unwrap();

        assert_eq!(exec.current_state, "testing");
        assert_eq!(exec.status, ExecutionStatus::Running);
        assert_eq!(exec.context.get("fix_applied"), Some(&json!(true)));

        handle.abort();
    }

    #[tokio::test]
    async fn fail_invoke_goes_to_on_fail() {
        let responses = vec![
            r#"{"transition": "DONE"}"#.into(),
            r#"{"transition": "TESTS_FAIL"}"#.into(),
        ];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let mut exec = ExecutionState::new(tdd_machine_with_invoke());
        exec.step(&client).await.unwrap();
        exec.step(&client).await.unwrap();

        exec.fail_invoke("debug couldn't fix it").unwrap();

        assert_eq!(exec.current_state, "failed");
        assert!(matches!(exec.status, ExecutionStatus::Running));

        handle.abort();
    }

    #[tokio::test]
    async fn complete_invoke_when_not_awaiting_errors() {
        let exec = ExecutionState::new(tdd_machine_with_invoke());
        let result = exec.clone().complete_invoke(None);
        assert!(result.is_err());
    }
}
