use crate::prompt_templates::ChatMessage;
use crate::tool_protocol::{
    ToolProtocolMessage, fold_reasoning_into_content, rescue_text_tool_calls,
};
use serde::{Deserialize, Serialize};

/// Configuration for connecting to an Ollama instance.
#[derive(Debug, Clone)]
pub struct OllamaConfig {
    pub api_url: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    /// Per-state thinking level. Only forwarded to non-Ollama endpoints that support it
    /// (OpenAI o-series, Anthropic). Maps to `reasoning_effort` in the API request.
    /// Values: "off" (suppress), "low", "medium", "high" / "max"
    pub thinking_level: Option<String>,
}

impl Default for OllamaConfig {
    fn default() -> Self {
        Self {
            api_url: "http://localhost:11434/v1".into(),
            model: "qwen2.5-coder:32b".into(),
            temperature: 0.3,
            max_tokens: 4096,
            thinking_level: None,
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
struct ChatRequest<M> {
    model: String,
    messages: Vec<M>,
    temperature: f32,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ToolDefinition>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<String>,
    /// Ollama-specific: set context window size. Default 2048 is too small
    /// for tool definitions + code context. Required for gpt-oss/reasoning models.
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<OllamaOptions>,
    /// Reasoning effort level for OpenAI o-series and Anthropic models.
    /// Not sent to Ollama endpoints — those ignore it or may reject unknown fields.
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
}

#[derive(Serialize, Clone)]
struct OllamaOptions {
    num_ctx: u32,
    /// Max output tokens. Ollama maps this to num_predict internally.
    /// Override max_tokens for models that need long output (greenfield file writes).
    #[serde(skip_serializing_if = "Option::is_none")]
    num_predict: Option<u32>,
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
    #[serde(default, alias = "reasoning_content", alias = "thinking")]
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
    /// Transparent protocol-correction turns that must be retained in history.
    pub protocol_trace: Vec<ToolProtocolMessage>,
    pub protocol_corrections: u32,
    pub rescued_tool_call: bool,
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

fn retry_jitter_secs(max_inclusive: u64) -> u64 {
    if max_inclusive == 0 {
        return 0;
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    (nanos ^ u64::from(std::process::id())) % (max_inclusive + 1)
}

fn request_retry_base_delay_secs(attempt: u32) -> u64 {
    2u64.saturating_pow(attempt).min(32)
}

fn request_retry_delay_secs(attempt: u32) -> u64 {
    let base = request_retry_base_delay_secs(attempt);
    base + retry_jitter_secs((base / 2).max(1))
}

// ─── Thinking-level helpers ──────────────────────────────────────────────

/// Returns true for endpoints that are Ollama (local or remote Ollama instance).
/// Ollama ignores unknown request fields, but we skip `reasoning_effort` anyway
/// to avoid surprises if a future version rejects it.
fn is_ollama_endpoint(url: &str) -> bool {
    url.contains("ollama") || url.contains("localhost") || url.contains("127.0.0.1")
}

/// Map a Statewright thinking_level string to the OpenAI `reasoning_effort` value.
/// Returns None for "off" (suppress reasoning entirely — don't send the field).
fn map_thinking_level(level: &str) -> Option<String> {
    match level {
        "off" => None,
        "low" => Some("low".into()),
        "medium" => Some("medium".into()),
        "high" | "max" => Some("high".into()),
        other => Some(other.into()),
    }
}

// ─── Client implementation ───────────────────────────────────────────────

impl OllamaClient {
    pub fn new(config: OllamaConfig) -> Self {
        Self {
            config,
            http: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(30))
                .timeout(std::time::Duration::from_secs(180))
                .build()
                .expect("failed to build HTTP client"),
        }
    }

    /// Send a chat completion request and return the raw response text.
    /// This is the raw JSON prompting path.
    pub async fn chat(&self, messages: Vec<ChatMessage>) -> Result<String, OllamaError> {
        let url = format!("{}/chat/completions", self.config.api_url);

        let reasoning_effort = if !is_ollama_endpoint(&self.config.api_url) {
            self.config
                .thinking_level
                .as_deref()
                .and_then(map_thinking_level)
        } else {
            None
        };

        let request = ChatRequest {
            model: self.config.model.clone(),
            messages,
            temperature: self.config.temperature,
            max_tokens: self.config.max_tokens,
            tools: None,
            tool_choice: None,
            options: Some(OllamaOptions {
                num_ctx: 16384,
                num_predict: if self.config.max_tokens > 4096 {
                    Some(self.config.max_tokens)
                } else {
                    None
                },
            }),
            reasoning_effort,
        };

        let mut last_err: OllamaError = OllamaError::NoResponse;
        for attempt in 0u32..5 {
            let send_result = self.http.post(&url).json(&request).send().await;
            match send_result {
                Ok(resp) => match resp.error_for_status() {
                    Ok(resp) => {
                        let body: ChatResponse = resp.json().await?;
                        let choice = body
                            .choices
                            .into_iter()
                            .next()
                            .ok_or(OllamaError::NoResponse)?;
                        let content = choice.message.content.unwrap_or_default();
                        if content.is_empty() {
                            if let Some(reasoning) = &choice.message.reasoning {
                                if reasoning.contains("tool_calls")
                                    || reasoning.contains("transition")
                                    || reasoning.contains("tool_call")
                                    || reasoning.contains("{")
                                {
                                    return Ok(reasoning.clone());
                                }
                                if let Some(tool_call) =
                                    crate::harmony::try_parse_harmony(reasoning)
                                {
                                    return Ok(tool_call);
                                }
                                if let Some(tool_call) = extract_harmony_tool_call(reasoning) {
                                    return Ok(tool_call);
                                }
                            }
                        }
                        return Ok(content);
                    }
                    Err(e) => last_err = e.into(),
                },
                Err(e) => last_err = e.into(),
            }
            if attempt < 4 {
                let delay = request_retry_delay_secs(attempt);
                eprintln!(
                    "  [HTTP] attempt {} failed, retrying in {}s: {}",
                    attempt + 1,
                    delay,
                    last_err
                );
                tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
            }
        }
        Err(last_err)
    }

    /// Send a chat request with native tool definitions.
    /// Returns a ChatResult with either native tool calls or text content.
    pub async fn chat_with_tools(
        &self,
        messages: Vec<ChatMessage>,
        tools: Vec<ToolDefinition>,
    ) -> Result<ChatResult, OllamaError> {
        self.send_tool_request(messages, tools, None).await
    }

    /// Require an explicit tool action and correct Qwen text-mode slips in the
    /// same logical turn. Statewright always exposes `transition`, so a tool is
    /// a complete action vocabulary rather than a forced repository mutation.
    pub async fn chat_with_required_tools(
        &self,
        messages: Vec<ToolProtocolMessage>,
        tools: Vec<ToolDefinition>,
        max_protocol_retries: u32,
    ) -> Result<ChatResult, OllamaError> {
        let available_tools: Vec<String> = tools
            .iter()
            .map(|tool| tool.function.name.clone())
            .collect();
        let mut request_messages = messages;
        let mut protocol_trace = Vec::new();

        for attempt in 0..=max_protocol_retries {
            let mut result = self
                .send_tool_request(
                    request_messages.clone(),
                    tools.clone(),
                    Some("required".into()),
                )
                .await?;

            let mut rescued_tool_call = false;
            if result.tool_calls.is_empty() {
                result.tool_calls = rescue_text_tool_calls(&result.content, &available_tools);
                if result.tool_calls.is_empty() {
                    result.tool_calls = rescue_text_tool_calls(
                        result.reasoning.as_deref().unwrap_or_default(),
                        &available_tools,
                    );
                }
                rescued_tool_call = !result.tool_calls.is_empty();
            }
            if !result.tool_calls.is_empty() || attempt == max_protocol_retries {
                result.protocol_trace = protocol_trace;
                result.protocol_corrections = attempt;
                result.rescued_tool_call = rescued_tool_call;
                return Ok(result);
            }

            let assistant = ToolProtocolMessage::plain(
                "assistant",
                fold_reasoning_into_content(result.content, result.reasoning.as_deref()),
            );
            let correction = ToolProtocolMessage::plain(
                "user",
                format!(
                    "Your response did not contain a valid tool call. Call at least one available tool now. To finish or change state, call transition. Available tools: {}. Do not answer in prose.",
                    available_tools.join(", ")
                ),
            );
            request_messages.push(assistant.clone());
            request_messages.push(correction.clone());
            protocol_trace.push(assistant);
            protocol_trace.push(correction);
        }

        unreachable!("bounded protocol retry loop always returns")
    }

    async fn send_tool_request<M: Serialize>(
        &self,
        messages: Vec<M>,
        tools: Vec<ToolDefinition>,
        tool_choice: Option<String>,
    ) -> Result<ChatResult, OllamaError> {
        let url = format!("{}/chat/completions", self.config.api_url);

        let reasoning_effort = if !is_ollama_endpoint(&self.config.api_url) {
            self.config
                .thinking_level
                .as_deref()
                .and_then(map_thinking_level)
        } else {
            None
        };

        let request = ChatRequest {
            model: self.config.model.clone(),
            messages,
            temperature: self.config.temperature,
            max_tokens: self.config.max_tokens,
            tools: Some(tools),
            tool_choice,
            options: Some(OllamaOptions {
                num_ctx: 16384,
                num_predict: if self.config.max_tokens > 4096 {
                    Some(self.config.max_tokens)
                } else {
                    None
                },
            }),
            reasoning_effort,
        };

        let mut last_err: OllamaError = OllamaError::NoResponse;
        for attempt in 0u32..5 {
            let send_result = self.http.post(&url).json(&request).send().await;
            match send_result {
                Ok(resp) => match resp.error_for_status() {
                    Ok(resp) => {
                        let body: ChatResponse = resp.json().await?;
                        let choice = body
                            .choices
                            .into_iter()
                            .next()
                            .ok_or(OllamaError::NoResponse)?;
                        let tool_calls = choice.message.tool_calls.unwrap_or_default();
                        let content = choice.message.content.unwrap_or_default();
                        let reasoning = choice.message.reasoning;
                        return Ok(ChatResult {
                            content,
                            tool_calls,
                            mode: ResponseMode::NativeToolCalling,
                            reasoning,
                            protocol_trace: Vec::new(),
                            protocol_corrections: 0,
                            rescued_tool_call: false,
                        });
                    }
                    Err(e) => last_err = e.into(),
                },
                Err(e) => last_err = e.into(),
            }
            if attempt < 4 {
                let delay = request_retry_delay_secs(attempt);
                eprintln!(
                    "  [HTTP] attempt {} failed, retrying in {}s: {}",
                    attempt + 1,
                    delay,
                    last_err
                );
                tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
            }
        }
        Err(last_err)
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
            "write_task_reproducer" => Some(ToolDefinition {
                tool_type: "function".into(),
                function: FunctionDefinition {
                    name: "write_task_reproducer".into(),
                    description: "Write a behavioral Python scratch reproducer outside the repository patch, then qualify it against the untouched baseline in the isolated validation worktree. Import every helper used and assert desired post-fix behavior rather than the reported bug or exception. Use only issue and repository facts; never write an unconditional failing or skipped test.".into(),
                    parameters: serde_json::json!({
                        "type": "object",
                        "properties": {
                            "name": { "type": "string", "description": "Plain Python filename such as test_task_reproducer.py" },
                            "source": { "type": "string", "description": "Complete Python scratch test source exercising the issue behavior" }
                        },
                        "required": ["source"]
                    }),
                },
            }),
            "run_task_reproducer" => Some(ToolDefinition {
                tool_type: "function".into(),
                function: FunctionDefinition {
                    name: "run_task_reproducer".into(),
                    description: "Run the previously qualified scratch reproducer against the current production patch in the isolated validation worktree. Returns a typed baseline-to-candidate delta.".into(),
                    parameters: serde_json::json!({"type": "object", "properties": {}, "required": []}),
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

    let event_names: Vec<&str> = available_transitions
        .iter()
        .map(|(e, _)| e.as_str())
        .collect();

    tools.push(ToolDefinition {
        tool_type: "function".into(),
        function: FunctionDefinition {
            name: "transition".into(),
            description: "Signal that you are done with the current state and want to move on."
                .into(),
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
        iterations_remaining
            .map(|r| r.to_string())
            .unwrap_or_else(|| "unlimited".into()),
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
        let name_end = after
            .find(|c: char| c.is_whitespace() || c == '<' || c == '|')
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
                if escape {
                    escape = false;
                    continue;
                }
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
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn start_tool_mock(
        responses: Vec<serde_json::Value>,
    ) -> (
        String,
        Arc<Mutex<Vec<serde_json::Value>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&requests);
        let handle = tokio::spawn(async move {
            for response in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let read = stream.read(&mut buffer).await.unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n")
                    else {
                        continue;
                    };
                    let headers = String::from_utf8_lossy(&request[..header_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= header_end + 4 + content_length {
                        let body = &request[header_end + 4..header_end + 4 + content_length];
                        captured
                            .lock()
                            .unwrap()
                            .push(serde_json::from_slice(body).unwrap());
                        break;
                    }
                }

                let body = serde_json::to_string(&response).unwrap();
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        (format!("http://{address}"), requests, handle)
    }

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
        assert_eq!(config.thinking_level, None);
    }

    #[test]
    fn is_ollama_endpoint_detects_local() {
        assert!(is_ollama_endpoint("http://localhost:11434/v1"));
        assert!(is_ollama_endpoint("http://127.0.0.1:11434/v1"));
        assert!(is_ollama_endpoint(
            "https://qwen3-8b.ollama.casa.enhasa.cloud/v1"
        ));
    }

    #[test]
    fn is_ollama_endpoint_passes_openai() {
        assert!(!is_ollama_endpoint("https://api.openai.com/v1"));
        assert!(!is_ollama_endpoint("https://openrouter.ai/api/v1"));
        assert!(!is_ollama_endpoint("https://api.anthropic.com/v1"));
    }

    #[test]
    fn request_retry_delay_uses_exponential_backoff_with_jitter() {
        assert_eq!(request_retry_base_delay_secs(0), 1);
        assert_eq!(request_retry_base_delay_secs(1), 2);
        assert_eq!(request_retry_base_delay_secs(2), 4);
        assert_eq!(request_retry_base_delay_secs(5), 32);

        let delay = request_retry_delay_secs(3);
        assert!(
            (8..=12).contains(&delay),
            "delay should be base 8s plus bounded jitter, got {}",
            delay
        );
    }

    #[test]
    fn map_thinking_level_off_returns_none() {
        assert_eq!(map_thinking_level("off"), None);
    }

    #[test]
    fn map_thinking_level_maps_correctly() {
        assert_eq!(map_thinking_level("low"), Some("low".into()));
        assert_eq!(map_thinking_level("medium"), Some("medium".into()));
        assert_eq!(map_thinking_level("high"), Some("high".into()));
        assert_eq!(map_thinking_level("max"), Some("high".into()));
    }

    #[test]
    fn map_thinking_level_passes_through_unknown() {
        assert_eq!(map_thinking_level("auto"), Some("auto".into()));
    }

    #[test]
    fn build_tool_definitions_for_known_tools() {
        let tools =
            build_tool_definitions(&["read_file".into(), "write_file".into(), "run_test".into()]);
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

    #[test]
    fn required_tool_request_serializes_openai_protocol_fields() {
        let request = ChatRequest {
            model: "qwen3:8b".into(),
            messages: vec![ToolProtocolMessage::plain("user", "inspect the repository")],
            temperature: 0.3,
            max_tokens: 4096,
            tools: Some(build_tool_definitions_with_nav(
                &["read_file".into()],
                &[("DONE".into(), "completed".into())],
            )),
            tool_choice: Some("required".into()),
            options: None,
            reasoning_effort: None,
        };
        let wire = serde_json::to_value(request).unwrap();
        assert_eq!(wire["tool_choice"], "required");
        assert_eq!(wire["messages"][0]["role"], "user");
        assert!(
            wire["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["function"]["name"] == "transition")
        );
    }

    #[test]
    fn response_accepts_qwen_and_ollama_reasoning_field_names() {
        for (field, expected) in [
            ("reasoning", "standard"),
            ("reasoning_content", "qwen"),
            ("thinking", "ollama"),
        ] {
            let mut message = serde_json::Map::new();
            message.insert(field.into(), serde_json::Value::String(expected.into()));
            let response: ChatResponse = serde_json::from_value(serde_json::json!({
                "choices": [{"message": message}]
            }))
            .unwrap();
            assert_eq!(
                response.choices[0].message.reasoning.as_deref(),
                Some(expected)
            );
        }
    }

    #[tokio::test]
    async fn required_tool_loop_corrects_text_and_preserves_the_retry_turn() {
        let responses = vec![
            serde_json::json!({
                "choices": [{"message": {"content": "I should inspect first."}}]
            }),
            serde_json::json!({
                "choices": [{"message": {
                    "content": "",
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": "{\"path\":\"src/lib.rs\"}"
                        }
                    }]
                }}]
            }),
        ];
        let (url, requests, handle) = start_tool_mock(responses).await;
        let client = OllamaClient::new(OllamaConfig {
            api_url: url,
            model: "qwen3:8b".into(),
            temperature: 0.3,
            max_tokens: 4096,
            thinking_level: None,
        });
        let result = client
            .chat_with_required_tools(
                vec![ToolProtocolMessage::plain("user", "inspect")],
                build_tool_definitions_with_nav(
                    &["read_file".into()],
                    &[("DONE".into(), "completed".into())],
                ),
                2,
            )
            .await
            .unwrap();

        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].function.name, "read_file");
        assert_eq!(result.protocol_corrections, 1);
        assert_eq!(result.protocol_trace.len(), 2);
        handle.await.unwrap();

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["tool_choice"], "required");
        let retry_messages = requests[1]["messages"].as_array().unwrap();
        assert_eq!(
            retry_messages[retry_messages.len() - 2]["role"],
            "assistant"
        );
        assert_eq!(retry_messages[retry_messages.len() - 1]["role"], "user");
        assert!(
            retry_messages[retry_messages.len() - 1]["content"]
                .as_str()
                .unwrap()
                .contains("call transition")
        );
    }

    #[tokio::test]
    async fn required_tool_loop_rescues_embedded_tool_json_without_retry() {
        let responses = vec![serde_json::json!({
            "choices": [{"message": {
                "content": "I will inspect: {\"tool\":\"read_file\",\"args\":{\"path\":\"src/lib.rs\"}}"
            }}]
        })];
        let (url, requests, handle) = start_tool_mock(responses).await;
        let client = OllamaClient::new(OllamaConfig {
            api_url: url,
            model: "qwen3:8b".into(),
            temperature: 0.3,
            max_tokens: 4096,
            thinking_level: None,
        });
        let result = client
            .chat_with_required_tools(
                vec![ToolProtocolMessage::plain("user", "inspect")],
                build_tool_definitions_with_nav(
                    &["read_file".into()],
                    &[("DONE".into(), "completed".into())],
                ),
                2,
            )
            .await
            .unwrap();

        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].function.name, "read_file");
        assert!(result.rescued_tool_call);
        assert_eq!(result.protocol_corrections, 0);
        handle.await.unwrap();
        assert_eq!(requests.lock().unwrap().len(), 1);
    }
}
