use crate::ollama_client::{OllamaClient, OllamaError};
use crate::prompt_templates;
use crate::validator::{validate_agent_machine, AgentValidationError};
use statewright_engine::MachineDefinition;

/// Result of generating a state machine from a task description.
#[derive(Debug)]
pub struct GenerationResult {
    pub definition: MachineDefinition,
    pub attempts: u32,
}

/// Errors from the generation process.
#[derive(Debug)]
pub enum GenerationError {
    Ollama(OllamaError),
    Validation(AgentValidationError),
    MaxRetriesExceeded {
        attempts: u32,
        last_error: String,
    },
}

impl std::fmt::Display for GenerationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GenerationError::Ollama(e) => write!(f, "ollama error: {}", e),
            GenerationError::Validation(e) => write!(f, "validation error: {}", e),
            GenerationError::MaxRetriesExceeded { attempts, last_error } => {
                write!(f, "failed after {} attempts: {}", attempts, last_error)
            }
        }
    }
}

impl std::error::Error for GenerationError {}

/// Generate a state machine definition from a task description using an LLM.
/// Retries up to `max_retries` times if the LLM produces invalid output,
/// feeding validation errors back into the retry prompt.
pub async fn generate_machine(
    client: &OllamaClient,
    task_description: &str,
    max_retries: u32,
) -> Result<GenerationResult, GenerationError> {
    let mut last_error = String::new();

    for attempt in 1..=max_retries {
        let messages = if attempt == 1 {
            prompt_templates::build_generation_prompt(task_description)
        } else {
            // Retry with validation errors included
            let mut msgs = prompt_templates::build_generation_prompt(task_description);
            msgs.push(prompt_templates::ChatMessage {
                role: "user".into(),
                content: format!(
                    "Your previous attempt was invalid. Fix these errors and try again:\n{}",
                    last_error
                ),
            });
            msgs
        };

        let definition: MachineDefinition = match client.chat_json(messages).await {
            Ok(def) => def,
            Err(e) => {
                last_error = e.to_string();
                continue;
            }
        };

        match validate_agent_machine(&definition) {
            Ok(()) => {
                return Ok(GenerationResult {
                    definition,
                    attempts: attempt,
                });
            }
            Err(e) => {
                last_error = e.errors.join("; ");
                continue;
            }
        }
    }

    Err(GenerationError::MaxRetriesExceeded {
        attempts: max_retries,
        last_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ollama_client::OllamaConfig;
    use tokio::net::TcpListener;

    /// A minimal mock Ollama server for testing.
    /// Returns canned JSON responses based on fixture data.
    async fn start_mock_ollama(response_json: serde_json::Value) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{}", addr);

        let handle = tokio::spawn(async move {
            // Accept connections in a loop
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(conn) => conn,
                    Err(_) => break,
                };

                let response_json = response_json.clone();
                tokio::spawn(async move {
                    handle_mock_request(stream, &response_json).await;
                });
            }
        });

        (url, handle)
    }

    async fn handle_mock_request(stream: tokio::net::TcpStream, response_json: &serde_json::Value) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let mut stream = stream;
        let mut buf = vec![0u8; 8192];
        let _ = stream.read(&mut buf).await;

        let body = serde_json::json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": serde_json::to_string(response_json).unwrap()
                }
            }]
        });

        let body_str = serde_json::to_string(&body).unwrap();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body_str.len(),
            body_str
        );
        let _ = stream.write_all(response.as_bytes()).await;
    }

    fn valid_bug_fix_json() -> serde_json::Value {
        serde_json::json!({
            "id": "fix-login-bug",
            "initial": "planning",
            "meta": { "task_type": "bug_fix", "danger_level": "moderate", "estimated_steps": 5 },
            "states": {
                "planning": {
                    "allowed_tools": ["read_file", "search_files", "grep"],
                    "instructions": "Analyze the bug.",
                    "on": { "PLAN_READY": "implementing", "FAIL": "failed" }
                },
                "implementing": {
                    "allowed_tools": ["read_file", "write_file", "edit_file"],
                    "instructions": "Fix the bug.",
                    "on": { "DONE": "testing", "FAIL": "failed" }
                },
                "testing": {
                    "allowed_tools": ["read_file", "run_test"],
                    "on": {
                        "TESTS_PASS": { "target": "review", "requires_approval": true, "approval_message": "Review?" },
                        "TESTS_FAIL": "implementing",
                        "FAIL": "failed"
                    }
                },
                "review": {
                    "allowed_tools": ["read_file"],
                    "on": { "APPROVED": "completed", "REJECTED": "implementing" }
                },
                "completed": { "type": "final" },
                "failed": { "type": "final" }
            },
            "guards": {}
        })
    }

    #[tokio::test]
    async fn generates_valid_machine_on_first_attempt() {
        let (url, handle) = start_mock_ollama(valid_bug_fix_json()).await;
        let config = OllamaConfig {
            api_url: url,
            model: "test".into(),
            temperature: 0.3,
            max_tokens: 4096,
        };
        let client = OllamaClient::new(config);

        let result = generate_machine(&client, "Fix the login bug", 3).await.unwrap();
        assert_eq!(result.attempts, 1);
        assert_eq!(result.definition.id, "fix-login-bug");
        assert_eq!(result.definition.initial, "planning");

        handle.abort();
    }

    #[tokio::test]
    async fn fails_after_max_retries_with_invalid_json() {
        // Mock returns invalid machine (no failed state)
        let bad_json = serde_json::json!({
            "id": "bad",
            "initial": "start",
            "meta": { "danger_level": "safe" },
            "states": {
                "start": { "on": { "GO": "end" } },
                "end": { "type": "final" }
            },
            "guards": {}
        });

        let (url, handle) = start_mock_ollama(bad_json).await;
        let config = OllamaConfig {
            api_url: url,
            model: "test".into(),
            temperature: 0.3,
            max_tokens: 4096,
        };
        let client = OllamaClient::new(config);

        let result = generate_machine(&client, "Do something", 2).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            GenerationError::MaxRetriesExceeded { attempts, last_error } => {
                assert_eq!(attempts, 2);
                assert!(last_error.contains("failed"), "error should mention missing failed state: {}", last_error);
            }
            other => panic!("expected MaxRetriesExceeded, got: {:?}", other),
        }

        handle.abort();
    }

    #[tokio::test]
    async fn reports_attempt_count() {
        let (url, handle) = start_mock_ollama(valid_bug_fix_json()).await;
        let config = OllamaConfig {
            api_url: url,
            model: "test".into(),
            temperature: 0.3,
            max_tokens: 4096,
        };
        let client = OllamaClient::new(config);

        let result = generate_machine(&client, "Fix a thing", 5).await.unwrap();
        assert_eq!(result.attempts, 1); // valid on first try
        assert!(result.definition.states.contains_key("planning"));

        handle.abort();
    }
}
