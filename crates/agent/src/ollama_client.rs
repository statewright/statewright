use crate::prompt_templates::ChatMessage;
use serde::{Deserialize, Serialize};

/// Configuration for connecting to an Ollama instance.
#[derive(Debug, Clone)]
pub struct OllamaConfig {
    pub api_url: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
}

impl Default for OllamaConfig {
    fn default() -> Self {
        Self {
            api_url: "http://localhost:11434/v1".into(),
            model: "qwen2.5-coder:32b".into(),
            temperature: 0.3,
            max_tokens: 4096,
        }
    }
}

/// Client for calling Ollama's OpenAI-compatible API.
#[derive(Clone)]
pub struct OllamaClient {
    config: OllamaConfig,
    http: reqwest::Client,
}

// ─── Request types ────────────────────────────────────────────────────────

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ToolDefinition>>,
    /// Ollama-specific: set context window size. Default 2048 is too small
    /// for tool definitions + code context. Required for gpt-oss/reasoning models.
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<OllamaOptions>,
}

#[derive(Serialize, Clone)]
struct OllamaOptions {
    num_ctx: u32,
}

/// OpenAI-compatible tool definition for native function calling.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: FunctionDefinition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

// ─── Response types ───────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize, Debug)]
struct Choice {
    message: ResponseMessage,
}

#[derive(Deserialize, Debug)]
struct ResponseMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<NativeToolCall>>,
    /// Reasoning content from reasoning models (gpt-oss, deepseek-r1).
    /// Contains the model's chain-of-thought — invisible in content but
    /// can be injected back into conversation for multi-turn reasoning.
    #[serde(default)]
    reasoning: Option<String>,
}

/// Native tool call from the API response.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NativeToolCall {
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub call_type: Option<String>,
    pub function: NativeFunctionCall,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NativeFunctionCall {
    pub name: String,
    pub arguments: serde_json::Value,
}

// ─── Unified response ────────────────────────────────────────────────────

/// Unified response that works for both native tool calling and raw JSON modes.
#[derive(Debug, Clone)]
pub struct ChatResult {
    /// Text content from the model (may be empty if tool calls were made).
    pub content: String,
    /// Native tool calls (populated when using native tool calling mode).
    pub tool_calls: Vec<NativeToolCall>,
    /// Which mode produced this result.
    pub mode: ResponseMode,
    /// Reasoning chain from reasoning models (gpt-oss, deepseek-r1).
    /// Inject back into conversation to enable multi-turn reasoning.
    pub reasoning: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ResponseMode {
    NativeToolCalling,
    RawJson,
}

// ─── Error type ──────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum OllamaError {
    Http(reqwest::Error),
    NoResponse,
    ParseError(String),
}

impl std::fmt::Display for OllamaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OllamaError::Http(e) => write!(f, "HTTP error: {}", e),
            OllamaError::NoResponse => write!(f, "no response from Ollama"),
            OllamaError::ParseError(msg) => write!(f, "parse error: {}", msg),
        }
    }
}

impl std::error::Error for OllamaError {}

impl From<reqwest::Error> for OllamaError {
    fn from(e: reqwest::Error) -> Self {
        OllamaError::Http(e)
    }
}

// ─── Client implementation ───────────────────────────────────────────────

impl OllamaClient {
    pub fn new(config: OllamaConfig) -> Self {
        Self {
            config,
            http: reqwest::Client::new(),
        }
    }

    /// Send a chat completion request and return the raw response text.
    /// This is the raw JSON prompting path.
    pub async fn chat(&self, messages: Vec<ChatMessage>) -> Result<String, OllamaError> {
        let url = format!("{}/chat/completions", self.config.api_url);

        let request = ChatRequest {
            model: self.config.model.clone(),
            messages,
            temperature: self.config.temperature,
            max_tokens: self.config.max_tokens,
            tools: None,
            options: Some(OllamaOptions { num_ctx: 16384 }),
        };

        let response = self
            .http
            .post(&url)
            .json(&request)
            .send()
            .await?
            .error_for_status()?;

        let body: ChatResponse = response.json().await?;

        let choice = body.choices
            .into_iter()
            .next()
            .ok_or(OllamaError::NoResponse)?;

        // If content is empty but reasoning exists, use reasoning as content
        // This handles reasoning models (gpt-oss) that put everything in the thinking chain
        let content = choice.message.content.unwrap_or_default();
        if content.is_empty() {
            if let Some(reasoning) = &choice.message.reasoning {
                // Try to extract a tool call or transition from the reasoning
                if reasoning.contains("tool_calls") || reasoning.contains("transition")
                    || reasoning.contains("tool_call") || reasoning.contains("{")
                {
                    return Ok(reasoning.clone());
                }

                // Try Harmony token-level parser (if feature enabled)
                if let Some(tool_call) = crate::harmony::try_parse_harmony(reasoning) {
                    return Ok(tool_call);
                }

                // Try regex-based Harmony extraction as fallback
                if let Some(tool_call) = extract_harmony_tool_call(reasoning) {
                    return Ok(tool_call);
                }
            }
        }
        Ok(content)
    }

    /// Send a chat request with native tool definitions.
    /// Returns a ChatResult with either native tool calls or text content.
    pub async fn chat_with_tools(
        &self,
        messages: Vec<ChatMessage>,
        tools: Vec<ToolDefinition>,
    ) -> Result<ChatResult, OllamaError> {
        let url = format!("{}/chat/completions", self.config.api_url);

        let request = ChatRequest {
            model: self.config.model.clone(),
            messages,
            temperature: self.config.temperature,
            max_tokens: self.config.max_tokens,
            tools: Some(tools),
            options: Some(OllamaOptions { num_ctx: 16384 }),
        };

        let response = self
            .http
            .post(&url)
            .json(&request)
            .send()
            .await?
            .error_for_status()?;

        let body: ChatResponse = response.json().await?;

        let choice = body
            .choices
            .into_iter()
            .next()
            .ok_or(OllamaError::NoResponse)?;

        let tool_calls = choice.message.tool_calls.unwrap_or_default();
        let content = choice.message.content.unwrap_or_default();
        let reasoning = choice.message.reasoning;

        Ok(ChatResult {
            content,
            tool_calls,
            mode: ResponseMode::NativeToolCalling,
            reasoning,
        })
    }

    /// Send a chat request and parse the response as JSON.
    pub async fn chat_json<T: serde::de::DeserializeOwned>(
        &self,
        messages: Vec<ChatMessage>,
    ) -> Result<T, OllamaError> {
        let raw = self.chat(messages).await?;

        // Strip markdown code fences if the LLM wraps its output
        let cleaned = strip_code_fences(&raw);

        serde_json::from_str(&cleaned).map_err(|e| {
            OllamaError::ParseError(format!(
                "failed to parse JSON: {}. Raw response: {}",
                e,
                &raw[..raw.len().min(500)]
            ))
        })
    }
}

/// Build OpenAI-compatible tool definitions from a list of tool names.
pub fn build_tool_definitions(tool_names: &[String]) -> Vec<ToolDefinition> {
    tool_names
        .iter()
        .filter_map(|name| match name.as_str() {
            "read_file" => Some(ToolDefinition {
                tool_type: "function".into(),
                function: FunctionDefinition {
                    name: "read_file".into(),
                    description: "Read a file. Use start_line/end_line for large files. Use grep first to find relevant lines.".into(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "File path relative to working directory" },
                            "start_line": { "type": "integer", "description": "Optional: first line to read (1-indexed)" },
                            "end_line": { "type": "integer", "description": "Optional: last line to read" }
                        },
                        "required": ["path"]
                    }),
                },
            }),
            "write_file" => Some(ToolDefinition {
                tool_type: "function".into(),
                function: FunctionDefinition {
                    name: "write_file".into(),
                    description: "Write content to a file, replacing its contents entirely".into(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "File path relative to working directory" },
                            "content": { "type": "string", "description": "The complete file content to write" }
                        },
                        "required": ["path", "content"]
                    }),
                },
            }),
            "list_directory" => Some(ToolDefinition {
                tool_type: "function".into(),
                function: FunctionDefinition {
                    name: "list_directory".into(),
                    description: "List files and directories".into(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "Directory path, use '.' for current" }
                        },
                        "required": ["path"]
                    }),
                },
            }),
            "run_test" => Some(ToolDefinition {
                tool_type: "function".into(),
                function: FunctionDefinition {
                    name: "run_test".into(),
                    description: "Run the test suite (pytest)".into(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {},
                        "required": []
                    }),
                },
            }),
            "diff" => Some(ToolDefinition {
                tool_type: "function".into(),
                function: FunctionDefinition {
                    name: "diff".into(),
                    description: "Show changes between the current file and the original version".into(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "File path to diff" }
                        },
                        "required": ["path"]
                    }),
                },
            }),
            "grep" => Some(ToolDefinition {
                tool_type: "function".into(),
                function: FunctionDefinition {
                    name: "grep".into(),
                    description: "Search for a pattern in files".into(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "pattern": { "type": "string", "description": "Search pattern" },
                            "file": { "type": "string", "description": "Optional file to search in" }
                        },
                        "required": ["pattern"]
                    }),
                },
            }),
            "edit_line" => Some(ToolDefinition {
                tool_type: "function".into(),
                function: FunctionDefinition {
                    name: "edit_line".into(),
                    description: "Find and replace a single line in a file by content. More precise than write_file — use this for small fixes.".into(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "File path" },
                            "old": { "type": "string", "description": "Current line content to find" },
                            "new": { "type": "string", "description": "Replacement line content" },
                            "line": { "type": "integer", "description": "Optional line number hint for disambiguation" }
                        },
                        "required": ["path", "old", "new"]
                    }),
                },
            }),
            "edit_block" => Some(ToolDefinition {
                tool_type: "function".into(),
                function: FunctionDefinition {
                    name: "edit_block".into(),
                    description: "Find and replace a multi-line block of code. Better than edit_line for method-level changes.".into(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "File path" },
                            "old": { "type": "string", "description": "The existing code block to find (multi-line)" },
                            "new": { "type": "string", "description": "The replacement code block" }
                        },
                        "required": ["path", "old", "new"]
                    }),
                },
            }),
            "apply_patch" => Some(ToolDefinition {
                tool_type: "function".into(),
                function: FunctionDefinition {
                    name: "apply_patch".into(),
                    description: "Apply a unified diff patch to fix code. Use -/+ line format.".into(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "patch": { "type": "string", "description": "The patch in unified diff format with -old/+new lines" }
                        },
                        "required": ["patch"]
                    }),
                },
            }),
            "patch_file" => Some(ToolDefinition {
                tool_type: "function".into(),
                function: FunctionDefinition {
                    name: "patch_file".into(),
                    description: "Apply multiple line-level patches to a file. For multi-line fixes.".into(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": "File path" },
                            "patches": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "line": { "type": "integer", "description": "Line number (1-indexed)" },
                                        "old": { "type": "string", "description": "Current content" },
                                        "new": { "type": "string", "description": "Replacement content" }
                                    },
                                    "required": ["line", "old", "new"]
                                }
                            }
                        },
                        "required": ["path", "patches"]
                    }),
                },
            }),
            _ => None,
        })
        .collect()
}

/// State machine navigation tools — used in both native and raw JSON modes.
/// These are the tools that let the model interact with the state machine itself,
/// separate from the task tools (read_file, write_file, etc.).

/// Build tool definitions including state machine navigation tools (transition + get_available_actions).
pub fn build_tool_definitions_with_nav(
    tool_names: &[String],
    available_transitions: &[(String, String)],
) -> Vec<ToolDefinition> {
    let mut tools = build_tool_definitions(tool_names);

    let event_names: Vec<&str> = available_transitions.iter().map(|(e, _)| e.as_str()).collect();

    tools.push(ToolDefinition {
        tool_type: "function".into(),
        function: FunctionDefinition {
            name: "transition".into(),
            description: "Signal that you are done with the current state and want to move on.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "event": {
                        "type": "string",
                        "description": "The transition event name",
                        "enum": event_names
                    },
                    "error": {
                        "type": "string",
                        "description": "Error description (only when event is FAIL)"
                    }
                },
                "required": ["event"]
            }),
        },
    });

    tools.push(ToolDefinition {
        tool_type: "function".into(),
        function: FunctionDefinition {
            name: "get_available_actions".into(),
            description: "Ask what tools and transitions are available in the current state. Call this when unsure what to do next.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
    });

    tools
}

/// Build the raw JSON prompt section for nav tools (for models that don't support native tool calling).
/// Returns a string to append to the system prompt.
pub fn nav_tools_prompt_section(
    available_transitions: &[(String, String)],
    current_state: &str,
    allowed_tools: &[String],
    iterations_remaining: Option<u32>,
) -> String {
    let transitions_desc: Vec<String> = available_transitions
        .iter()
        .map(|(event, target)| format!("  - {}: moves to '{}'", event, target))
        .collect();

    format!(
r#"To move to the next state, respond:
{{"tool_calls": [{{"name": "transition", "args": {{"event": "EVENT_NAME"}}}}]}}

To check what you can do, respond:
{{"tool_calls": [{{"name": "get_available_actions", "args": {{}}}}]}}

Available transitions:
{}
Iterations remaining: {}"#,
        transitions_desc.join("\n"),
        iterations_remaining.map(|r| r.to_string()).unwrap_or_else(|| "unlimited".into()),
    )
}

/// Extract a tool call from Harmony-formatted reasoning text.
/// Looks for patterns like "to=functions.TOOL_NAME" followed by JSON arguments.
fn extract_harmony_tool_call(reasoning: &str) -> Option<String> {
    // Look for "to=functions.TOOL_NAME" pattern
    let func_prefix = "to=functions.";
    if let Some(idx) = reasoning.find(func_prefix) {
        let after = &reasoning[idx + func_prefix.len()..];
        // Extract function name (ends at space, newline, or special token)
        let name_end = after.find(|c: char| c.is_whitespace() || c == '<' || c == '|')
            .unwrap_or(after.len());
        let func_name = &after[..name_end];

        if func_name.is_empty() {
            return None;
        }

        // Find JSON arguments after the function name
        let remaining = &after[name_end..];
        if let Some(json_start) = remaining.find('{') {
            let json_part = &remaining[json_start..];
            // Brace-count to find balanced JSON
            let mut depth = 0i32;
            let mut in_string = false;
            let mut escape = false;
            for (i, b) in json_part.bytes().enumerate() {
                if escape { escape = false; continue; }
                match b {
                    b'\\' if in_string => escape = true,
                    b'"' => in_string = !in_string,
                    b'{' if !in_string => depth += 1,
                    b'}' if !in_string => {
                        depth -= 1;
                        if depth == 0 {
                            let args_json = &json_part[..=i];
                            return Some(format!(
                                r#"{{"tool_calls":[{{"name":"{}","args":{}}}]}}"#,
                                func_name, args_json
                            ));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    None
}

/// Strip markdown code fences from LLM output.
fn strip_code_fences(input: &str) -> String {
    let trimmed = input.trim();

    if let Some(rest) = trimmed.strip_prefix("```") {
        let after_tag = if let Some(newline_pos) = rest.find('\n') {
            &rest[newline_pos + 1..]
        } else {
            rest
        };

        if let Some(content) = after_tag.strip_suffix("```") {
            return content.trim().to_string();
        }
    }

    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_code_fences_passes_through_plain_json() {
        let input = r#"{"id": "test"}"#;
        assert_eq!(strip_code_fences(input), r#"{"id": "test"}"#);
    }

    #[test]
    fn strip_code_fences_removes_json_fence() {
        let input = "```json\n{\"id\": \"test\"}\n```";
        assert_eq!(strip_code_fences(input), r#"{"id": "test"}"#);
    }

    #[test]
    fn strip_code_fences_removes_plain_fence() {
        let input = "```\n{\"id\": \"test\"}\n```";
        assert_eq!(strip_code_fences(input), r#"{"id": "test"}"#);
    }

    #[test]
    fn strip_code_fences_handles_whitespace() {
        let input = "  ```json\n  {\"id\": \"test\"}  \n```  ";
        let result = strip_code_fences(input);
        assert!(result.contains("\"id\""));
    }

    #[test]
    fn default_config_points_to_ollama() {
        let config = OllamaConfig::default();
        assert!(config.api_url.contains("localhost:11434"));
        assert_eq!(config.temperature, 0.3);
    }

    #[test]
    fn build_tool_definitions_for_known_tools() {
        let tools = build_tool_definitions(&[
            "read_file".into(),
            "write_file".into(),
            "run_test".into(),
        ]);
        assert_eq!(tools.len(), 3);
        assert_eq!(tools[0].function.name, "read_file");
        assert_eq!(tools[1].function.name, "write_file");
        assert_eq!(tools[2].function.name, "run_test");
    }

    #[test]
    fn build_tool_definitions_skips_unknown() {
        let tools = build_tool_definitions(&["read_file".into(), "unknown_tool".into()]);
        assert_eq!(tools.len(), 1);
    }
}
