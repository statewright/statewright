use crate::executor::{ExecutionState, ExecutionStatus, MachineRegistry};
use crate::ollama_client::OllamaClient;
use serde_json::Value;
use statewright_engine::MachineDefinition;

/// Orchestrates execution of state machines with sub-machine invocation.
/// When a parent machine hits an invoke transition, the orchestrator
/// creates a child execution, runs it to completion, and resumes the parent.
pub struct Orchestrator {
    registry: MachineRegistry,
    max_child_steps: u32,
    max_depth: u32,
}

impl Orchestrator {
    pub fn new(max_child_steps: u32, max_depth: u32) -> Self {
        Self {
            registry: MachineRegistry::new(),
            max_child_steps,
            max_depth,
        }
    }

    /// Register a sub-machine that can be invoked by name.
    pub fn register(&mut self, name: &str, definition: MachineDefinition) {
        self.registry.register(name, definition);
    }

    /// Run a machine to completion, handling sub-machine invocations recursively.
    /// Returns the final execution state.
    pub async fn run(
        &self,
        definition: MachineDefinition,
        client: &OllamaClient,
        max_steps: u32,
    ) -> ExecutionResult {
        self.run_at_depth(definition, client, max_steps, 0).await
    }

    fn run_at_depth<'a>(
        &'a self,
        definition: MachineDefinition,
        client: &'a OllamaClient,
        max_steps: u32,
        depth: u32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ExecutionResult> + Send + 'a>> {
        Box::pin(async move {
            if depth > self.max_depth {
                return ExecutionResult {
                    success: false,
                    final_state: "failed".into(),
                    context: Value::Null,
                    total_steps: 0,
                    invocations: 0,
                    error: Some(format!("max invoke depth ({}) exceeded", self.max_depth)),
                };
            }

            let machine_id = definition.id.clone();
            let mut exec = ExecutionState::new(definition);
            let mut total_steps = 0u32;
            let mut invocations = 0u32;

            loop {
                if total_steps >= max_steps {
                    return ExecutionResult {
                        success: false,
                        final_state: exec.current_state.clone(),
                        context: exec.context.clone(),
                        total_steps,
                        invocations,
                        error: Some(format!(
                            "max steps ({}) exceeded in '{}'",
                            max_steps, machine_id
                        )),
                    };
                }

                match &exec.status {
                    ExecutionStatus::Completed => {
                        return ExecutionResult {
                            success: true,
                            final_state: exec.current_state.clone(),
                            context: exec.context.clone(),
                            total_steps,
                            invocations,
                            error: None,
                        };
                    }
                    ExecutionStatus::Failed { error } => {
                        return ExecutionResult {
                            success: false,
                            final_state: exec.current_state.clone(),
                            context: exec.context.clone(),
                            total_steps,
                            invocations,
                            error: Some(error.clone()),
                        };
                    }
                    ExecutionStatus::AwaitingApproval { .. } => {
                        // Auto-approve in orchestrator mode
                        let _ = exec.approve();
                    }
                    ExecutionStatus::AwaitingInvoke {
                        machine,
                        on_complete,
                        on_fail,
                        input,
                    } => {
                        invocations += 1;
                        let child_machine_name = machine.clone();

                        let child_def = match self.registry.get(&child_machine_name) {
                            Some(def) => def.clone(),
                            None => {
                                let _ = exec.fail_invoke(&format!(
                                    "sub-machine '{}' not found in registry",
                                    child_machine_name
                                ));
                                continue;
                            }
                        };

                        // Run the child machine recursively
                        let child_result = self
                            .run_at_depth(child_def, client, self.max_child_steps, depth + 1)
                            .await;

                        total_steps += child_result.total_steps;
                        invocations += child_result.invocations;

                        if child_result.success {
                            let _ = exec.complete_invoke(Some(child_result.context));
                        } else {
                            let error = child_result.error.unwrap_or_else(|| "child failed".into());
                            let _ = exec.fail_invoke(&error);
                        }
                    }
                    ExecutionStatus::Running => match exec.step(client).await {
                        Ok(_record) => {
                            total_steps += 1;
                        }
                        Err(e) => {
                            return ExecutionResult {
                                success: false,
                                final_state: exec.current_state.clone(),
                                context: exec.context.clone(),
                                total_steps,
                                invocations,
                                error: Some(e.to_string()),
                            };
                        }
                    },
                }
            }
        }) // Box::pin
    }
}

/// Result of an orchestrated execution (parent + all children).
#[derive(Debug, Clone)]
pub struct ExecutionResult {
    pub success: bool,
    pub final_state: String,
    pub context: Value,
    pub total_steps: u32,
    pub invocations: u32,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::net::TcpListener;

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
                let next = {
                    let mut iter = responses.lock().unwrap();
                    iter.next()
                        .unwrap_or_else(|| r#"{"transition": "FAIL"}"#.into())
                };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut stream = stream;
                    let mut buf = vec![0u8; 8192];
                    let _ = stream.read(&mut buf).await;
                    let body = json!({
                        "choices": [{"message": {"role": "assistant", "content": next}}]
                    });
                    let body_str = serde_json::to_string(&body).unwrap();
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body_str.len(),
                        body_str
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                });
            }
        });
        (url, handle)
    }

    fn mock_client(url: &str) -> OllamaClient {
        OllamaClient::new(crate::ollama_client::OllamaConfig {
            api_url: url.into(),
            model: "test".into(),
            temperature: 0.3,
            max_tokens: 4096,
            thinking_level: None,
        })
    }

    fn parent_machine() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "parent",
            "initial": "working",
            "states": {
                "working": {
                    "on": {
                        "DONE": "completed",
                        "NEED_HELP": {
                            "invoke": "helper",
                            "on_complete": "working",
                            "on_fail": "failed"
                        },
                        "FAIL": "failed"
                    }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap()
    }

    fn helper_machine() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "helper",
            "initial": "helping",
            "states": {
                "helping": {
                    "on": {
                        "HELPED": "completed",
                        "FAIL": "failed"
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
    async fn simple_run_without_invoke() {
        let responses = vec![r#"{"transition": "DONE"}"#.into()];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let orch = Orchestrator::new(10, 3);
        let result = orch.run(parent_machine(), &client, 10).await;

        assert!(result.success);
        assert_eq!(result.final_state, "completed");
        assert_eq!(result.total_steps, 1);
        assert_eq!(result.invocations, 0);

        handle.abort();
    }

    #[tokio::test]
    async fn invoke_runs_child_then_resumes_parent() {
        let responses = vec![
            // Parent: working → NEED_HELP → AwaitingInvoke
            r#"{"transition": "NEED_HELP"}"#.into(),
            // Child (helper): helping → HELPED → completed
            r#"{"transition": "HELPED"}"#.into(),
            // Parent resumes at working → DONE → completed
            r#"{"transition": "DONE"}"#.into(),
        ];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let mut orch = Orchestrator::new(10, 3);
        orch.register("helper", helper_machine());
        let result = orch.run(parent_machine(), &client, 20).await;

        assert!(result.success);
        assert_eq!(result.final_state, "completed");
        assert_eq!(result.total_steps, 3); // 1 parent + 1 child + 1 parent
        assert_eq!(result.invocations, 1);

        handle.abort();
    }

    #[tokio::test]
    async fn child_failure_triggers_on_fail() {
        let responses = vec![
            // Parent: working → NEED_HELP
            r#"{"transition": "NEED_HELP"}"#.into(),
            // Child: helping → FAIL
            r#"{"transition": "FAIL"}"#.into(),
        ];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let mut orch = Orchestrator::new(10, 3);
        orch.register("helper", helper_machine());
        let result = orch.run(parent_machine(), &client, 20).await;

        assert!(!result.success);
        assert_eq!(result.final_state, "failed");
        assert_eq!(result.invocations, 1);

        handle.abort();
    }

    #[tokio::test]
    async fn missing_sub_machine_fails_invoke() {
        let responses = vec![r#"{"transition": "NEED_HELP"}"#.into()];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        // No helper registered
        let orch = Orchestrator::new(10, 3);
        let result = orch.run(parent_machine(), &client, 20).await;

        assert!(!result.success);
        assert_eq!(result.final_state, "failed");

        handle.abort();
    }

    #[tokio::test]
    async fn max_depth_prevents_infinite_recursion() {
        // Machine that invokes itself
        let recursive: MachineDefinition = serde_json::from_value(json!({
            "id": "recursive",
            "initial": "looping",
            "states": {
                "looping": {
                    "on": {
                        "RECURSE": {
                            "invoke": "recursive",
                            "on_complete": "completed",
                            "on_fail": "failed"
                        }
                    }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();

        let responses: Vec<String> = (0..10)
            .map(|_| r#"{"transition": "RECURSE"}"#.into())
            .collect();
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let mut orch = Orchestrator::new(10, 2); // max depth 2
        orch.register("recursive", recursive.clone());
        let result = orch.run(recursive, &client, 50).await;

        assert!(!result.success);
        // The depth error propagates up through fail_invoke chains
        assert!(!result.success);

        handle.abort();
    }

    #[tokio::test]
    async fn multiple_invocations_in_sequence() {
        let responses = vec![
            // Parent: NEED_HELP
            r#"{"transition": "NEED_HELP"}"#.into(),
            // Child 1: HELPED
            r#"{"transition": "HELPED"}"#.into(),
            // Parent resumes: NEED_HELP again
            r#"{"transition": "NEED_HELP"}"#.into(),
            // Child 2: HELPED
            r#"{"transition": "HELPED"}"#.into(),
            // Parent: DONE
            r#"{"transition": "DONE"}"#.into(),
        ];
        let (url, handle) = start_sequenced_mock(responses).await;
        let client = mock_client(&url);

        let mut orch = Orchestrator::new(10, 3);
        orch.register("helper", helper_machine());
        let result = orch.run(parent_machine(), &client, 30).await;

        assert!(result.success);
        assert_eq!(result.total_steps, 5);
        assert_eq!(result.invocations, 2);

        handle.abort();
    }
}
