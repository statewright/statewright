use crate::ollama_client::{NativeFunctionCall, NativeToolCall};
use crate::prompt_templates::ChatMessage;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::ops::Deref;

/// OpenAI-compatible message shape used for lossless multi-turn tool replay.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolProtocolMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<WireToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WireToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: WireFunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WireFunctionCall {
    pub name: String,
    /// OpenAI-compatible endpoints require arguments to remain JSON text.
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolInvocation {
    pub name: String,
    pub args: Value,
    pub call_id: Option<String>,
    pub argument_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolResultMessage {
    pub name: String,
    pub call_id: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProtocolWindow {
    pub messages: Vec<ToolProtocolMessage>,
    /// Calls whose executor path changed control state before recording a result.
    pub interrupted_call_ids: Vec<String>,
}

impl From<ChatMessage> for ToolProtocolMessage {
    fn from(message: ChatMessage) -> Self {
        Self::plain(message.role, message.content)
    }
}

impl From<&ChatMessage> for ToolProtocolMessage {
    fn from(message: &ChatMessage) -> Self {
        Self::plain(message.role.clone(), message.content.clone())
    }
}

impl ToolProtocolMessage {
    pub fn plain(role: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }

    pub fn assistant_tool_calls(content: String, calls: &[NativeToolCall]) -> Self {
        Self {
            role: "assistant".into(),
            content: Some(content),
            tool_calls: Some(calls.iter().map(WireToolCall::from).collect()),
            tool_call_id: None,
            name: None,
        }
    }

    pub fn tool_result(result: &ToolResultMessage) -> Self {
        Self {
            role: "tool".into(),
            content: Some(result.content.clone()),
            tool_calls: None,
            tool_call_id: Some(result.call_id.clone()),
            name: Some(result.name.clone()),
        }
    }

    pub fn to_plain(&self) -> ChatMessage {
        ChatMessage {
            role: self.role.clone(),
            content: self.content.clone().unwrap_or_default(),
        }
    }
}

impl From<&NativeToolCall> for WireToolCall {
    fn from(call: &NativeToolCall) -> Self {
        let arguments = match &call.function.arguments {
            Value::String(raw) => raw.clone(),
            value => serde_json::to_string(value).unwrap_or_else(|_| "null".into()),
        };
        Self {
            id: call.id.clone().unwrap_or_default(),
            call_type: call.call_type.clone().unwrap_or_else(|| "function".into()),
            function: WireFunctionCall {
                name: call.function.name.clone(),
                arguments,
            },
        }
    }
}

/// Plain history plus protocol-preserving overrides for native tool turns.
///
/// Existing raw-JSON call sites continue to see `ChatMessage` history through
/// `Deref`; native calls use `protocol_window` to retain call/result identity.
#[derive(Debug, Default)]
pub struct ProtocolConversation {
    plain: Vec<ChatMessage>,
    protocol_overrides: BTreeMap<usize, Vec<ToolProtocolMessage>>,
}

impl ProtocolConversation {
    pub fn push(&mut self, message: ChatMessage) {
        self.plain.push(message);
    }

    pub fn push_with_protocol(&mut self, plain: ChatMessage, protocol: Vec<ToolProtocolMessage>) {
        let index = self.plain.len();
        self.plain.push(plain);
        self.protocol_overrides.insert(index, protocol);
    }

    pub fn extend_protocol_trace(&mut self, trace: Vec<ToolProtocolMessage>) {
        for message in trace {
            let plain = message.to_plain();
            self.push_with_protocol(plain, vec![message]);
        }
    }

    pub fn push_assistant_tool_turn(&mut self, content: String, calls: &[NativeToolCall]) {
        let plain_content = if content.is_empty() {
            serde_json::to_string(calls).unwrap_or_default()
        } else {
            content.clone()
        };
        self.push_with_protocol(
            ChatMessage {
                role: "assistant".into(),
                content: plain_content,
            },
            vec![ToolProtocolMessage::assistant_tool_calls(content, calls)],
        );
    }

    pub fn push_tool_results(&mut self, plain_content: String, results: &[ToolResultMessage]) {
        let protocol = results
            .iter()
            .map(ToolProtocolMessage::tool_result)
            .collect();
        self.push_with_protocol(
            ChatMessage {
                role: "user".into(),
                content: plain_content,
            },
            protocol,
        );
    }

    pub fn protocol_window(&self, start: usize) -> Vec<ToolProtocolMessage> {
        self.protocol_window_with_diagnostics(start).messages
    }

    /// Render a valid OpenAI-compatible history even when executor control flow
    /// interrupted a tool batch. Every assistant tool call receives exactly one
    /// correlated result before any later user/assistant message.
    pub fn protocol_window_with_diagnostics(&self, start: usize) -> ProtocolWindow {
        let start = self.protocol_safe_start(start);
        let mut messages = Vec::new();
        let mut pending_calls: Vec<(String, String)> = Vec::new();
        let mut interrupted_call_ids = Vec::new();
        for (index, plain) in self.plain.iter().enumerate().skip(start) {
            let protocol = if let Some(protocol) = self.protocol_overrides.get(&index) {
                protocol.clone()
            } else {
                vec![ToolProtocolMessage::from(plain)]
            };

            for message in protocol {
                if message.role != "tool" && !pending_calls.is_empty() {
                    close_interrupted_calls(
                        &mut messages,
                        &mut pending_calls,
                        &mut interrupted_call_ids,
                    );
                }

                if message.role == "tool" {
                    if let Some(call_id) = message.tool_call_id.as_deref() {
                        pending_calls.retain(|(pending_id, _)| pending_id != call_id);
                    }
                }

                let announced_calls: Vec<(String, String)> = message
                    .tool_calls
                    .iter()
                    .flatten()
                    .map(|call| (call.id.clone(), call.function.name.clone()))
                    .collect();
                messages.push(message);
                pending_calls.extend(announced_calls);
            }
        }
        close_interrupted_calls(&mut messages, &mut pending_calls, &mut interrupted_call_ids);
        ProtocolWindow {
            messages,
            interrupted_call_ids,
        }
    }

    fn protocol_safe_start(&self, requested_start: usize) -> usize {
        let Some(protocol) = self.protocol_overrides.get(&requested_start) else {
            return requested_start;
        };
        let required_ids: Vec<&str> = protocol
            .iter()
            .filter_map(|message| message.tool_call_id.as_deref())
            .collect();
        if required_ids.is_empty() {
            return requested_start;
        }

        for index in (0..requested_start).rev() {
            let Some(candidate) = self.protocol_overrides.get(&index) else {
                continue;
            };
            let supplied_ids: Vec<&str> = candidate
                .iter()
                .flat_map(|message| message.tool_calls.iter().flatten())
                .map(|call| call.id.as_str())
                .collect();
            if required_ids
                .iter()
                .all(|required| supplied_ids.contains(required))
            {
                return index;
            }
        }
        requested_start
    }

    pub fn clear(&mut self) {
        self.plain.clear();
        self.protocol_overrides.clear();
    }
}

fn close_interrupted_calls(
    messages: &mut Vec<ToolProtocolMessage>,
    pending_calls: &mut Vec<(String, String)>,
    interrupted_call_ids: &mut Vec<String>,
) {
    for (call_id, name) in pending_calls.drain(..) {
        interrupted_call_ids.push(call_id.clone());
        messages.push(ToolProtocolMessage::tool_result(&ToolResultMessage {
            name,
            call_id,
            content: "Harness control flow changed before a correlated tool result was recorded. This call is not confirmed; retry it if it is still required.".into(),
        }));
    }
}

impl Deref for ProtocolConversation {
    type Target = [ChatMessage];

    fn deref(&self) -> &Self::Target {
        &self.plain
    }
}

pub fn canonicalize_native_calls(calls: &mut [NativeToolCall], next_call_id: &mut u64) {
    for call in calls {
        let needs_id = call.id.as_deref().is_none_or(str::is_empty);
        if needs_id {
            call.id = Some(format!("call_sw_{:09}", *next_call_id));
            *next_call_id += 1;
        }
        if call.call_type.is_none() {
            call.call_type = Some("function".into());
        }
    }
}

pub fn invocation_from_native(call: &NativeToolCall) -> ToolInvocation {
    let (args, argument_error) = normalize_arguments(&call.function.arguments);
    ToolInvocation {
        name: call.function.name.clone(),
        args,
        call_id: call.id.clone(),
        argument_error,
    }
}

pub fn unstructured_invocation(name: String, args: Value) -> ToolInvocation {
    let (args, argument_error) = normalize_arguments(&args);
    ToolInvocation {
        name,
        args,
        call_id: None,
        argument_error,
    }
}

pub fn normalize_arguments(arguments: &Value) -> (Value, Option<String>) {
    match arguments {
        Value::Object(_) => (arguments.clone(), None),
        Value::String(raw) => match serde_json::from_str::<Value>(raw) {
            Ok(value @ Value::Object(_)) => (value, None),
            Ok(value) => (
                value.clone(),
                Some(format!(
                    "tool arguments must decode to a JSON object, got {}",
                    value_type(&value)
                )),
            ),
            Err(error) => (
                arguments.clone(),
                Some(format!("tool arguments are invalid JSON: {error}")),
            ),
        },
        value => (
            value.clone(),
            Some(format!(
                "tool arguments must be a JSON object, got {}",
                value_type(value)
            )),
        ),
    }
}

fn value_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Rescue known tool-call serialization families emitted as text.
///
/// The parser accepts only names from the supplied tool vocabulary. Strategies
/// are ordered and short-circuited to avoid executing the same call twice.
pub fn rescue_text_tool_calls(text: &str, available_tools: &[String]) -> Vec<NativeToolCall> {
    let cleaned = strip_thinking_blocks(text);
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return Vec::new();
    }

    let mut calls = Vec::new();
    for body in tagged_bodies(cleaned, "<tool_call>", "</tool_call>") {
        calls.extend(extract_json_tool_calls(body, available_tools));
    }
    if !calls.is_empty() {
        return calls;
    }

    calls = extract_json_tool_calls(cleaned, available_tools);
    if !calls.is_empty() {
        return calls;
    }

    calls = parse_rehearsal_tool_calls(cleaned, available_tools);
    if !calls.is_empty() {
        return calls;
    }

    calls = parse_qwen_xml_tool_calls(cleaned, available_tools);
    if !calls.is_empty() {
        return calls;
    }

    parse_mistral_tool_calls(cleaned, available_tools)
}

fn extract_json_tool_calls(text: &str, available_tools: &[String]) -> Vec<NativeToolCall> {
    let cleaned = strip_code_fence(text.trim());
    if let Ok(value) = serde_json::from_str::<Value>(cleaned) {
        let calls = native_calls_from_value(&value, available_tools);
        if !calls.is_empty() {
            return calls;
        }
    }

    json_object_candidates(cleaned)
        .into_iter()
        .filter_map(|candidate| serde_json::from_str::<Value>(candidate).ok())
        .flat_map(|value| native_calls_from_value(&value, available_tools))
        .collect()
}

fn parse_rehearsal_tool_calls(text: &str, available_tools: &[String]) -> Vec<NativeToolCall> {
    let marker = "[ARGS]";
    let mut calls = Vec::new();
    let mut offset = 0;
    while let Some(relative_start) = text[offset..].find(marker) {
        let marker_start = offset + relative_start;
        let marker_end = marker_start + marker.len();
        let Some(name) = ascii_identifier_before(&text[..marker_start]) else {
            offset = marker_end;
            continue;
        };
        let args_start = marker_end
            + text[marker_end..]
                .bytes()
                .take_while(u8::is_ascii_whitespace)
                .count();
        let Some(arguments) = balanced_json_object_at(text, args_start) else {
            offset = marker_end;
            continue;
        };
        if available_tools.iter().any(|tool| tool == name) {
            if let Ok(value @ Value::Object(_)) = serde_json::from_str(arguments) {
                calls.push(native_tool_call(name, value));
            }
        }
        offset = args_start + arguments.len();
    }
    calls
}

fn parse_qwen_xml_tool_calls(text: &str, available_tools: &[String]) -> Vec<NativeToolCall> {
    let mut calls = Vec::new();
    let mut remainder = text;
    while let Some(start) = remainder.find("<function=") {
        remainder = &remainder[start + "<function=".len()..];
        let Some(name_end) = remainder.find('>') else {
            break;
        };
        let name = remainder[..name_end].trim();
        remainder = &remainder[name_end + 1..];
        let Some(body_end) = remainder.find("</function>") else {
            break;
        };
        let body = &remainder[..body_end];
        remainder = &remainder[body_end + "</function>".len()..];
        if !available_tools.iter().any(|tool| tool == name) {
            continue;
        }

        let mut args = serde_json::Map::new();
        let mut parameters = body;
        while let Some(parameter_start) = parameters.find("<parameter=") {
            parameters = &parameters[parameter_start + "<parameter=".len()..];
            let Some(key_end) = parameters.find('>') else {
                break;
            };
            let key = parameters[..key_end].trim();
            parameters = &parameters[key_end + 1..];
            let value_end = parameters
                .find("</parameter>")
                .or_else(|| parameters.find("<parameter="))
                .unwrap_or(parameters.len());
            let raw_value = parameters[..value_end].trim_matches('\n');
            let value = serde_json::from_str(raw_value)
                .unwrap_or_else(|_| Value::String(raw_value.to_string()));
            args.insert(key.to_string(), value);
            parameters = &parameters[value_end..];
            if let Some(rest) = parameters.strip_prefix("</parameter>") {
                parameters = rest;
            }
        }
        calls.push(native_tool_call(name, Value::Object(args)));
    }
    calls
}

fn parse_mistral_tool_calls(text: &str, available_tools: &[String]) -> Vec<NativeToolCall> {
    let marker = "[TOOL_CALLS]";
    let mut calls = Vec::new();
    let mut offset = 0;
    while let Some(relative_start) = text[offset..].find(marker) {
        let name_start = offset + relative_start + marker.len();
        let Some((name, name_end)) = ascii_identifier_after(text, name_start) else {
            offset = name_start;
            continue;
        };
        let args_start = name_end
            + text[name_end..]
                .bytes()
                .take_while(u8::is_ascii_whitespace)
                .count();
        let Some(arguments) = balanced_json_object_at(text, args_start) else {
            offset = name_end;
            continue;
        };
        if available_tools.iter().any(|tool| tool == name) {
            if let Ok(value @ Value::Object(_)) = serde_json::from_str(arguments) {
                calls.push(native_tool_call(name, value));
            }
        }
        offset = args_start + arguments.len();
    }
    calls
}

fn tagged_bodies<'a>(text: &'a str, open: &str, close: &str) -> Vec<&'a str> {
    let mut bodies = Vec::new();
    let mut remainder = text;
    while let Some(start) = remainder.find(open) {
        remainder = &remainder[start + open.len()..];
        let Some(end) = remainder.find(close) else {
            break;
        };
        bodies.push(&remainder[..end]);
        remainder = &remainder[end + close.len()..];
    }
    bodies
}

fn native_calls_from_value(value: &Value, available_tools: &[String]) -> Vec<NativeToolCall> {
    if let Some(items) = value.get("tool_calls").and_then(Value::as_array) {
        return items
            .iter()
            .flat_map(|item| native_calls_from_value(item, available_tools))
            .collect();
    }
    if let Some(items) = value.as_array() {
        return items
            .iter()
            .flat_map(|item| native_calls_from_value(item, available_tools))
            .collect();
    }

    let function = value.get("function").unwrap_or(value);
    let Some(name) = function
        .get("name")
        .or_else(|| value.get("tool"))
        .and_then(Value::as_str)
    else {
        return Vec::new();
    };
    if !available_tools.iter().any(|tool| tool == name) {
        return Vec::new();
    }
    let arguments = function
        .get("arguments")
        .or_else(|| function.get("args"))
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()));
    vec![NativeToolCall {
        id: value.get("id").and_then(Value::as_str).map(str::to_string),
        call_type: value
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| Some("function".into())),
        function: NativeFunctionCall {
            name: name.to_string(),
            arguments,
        },
    }]
}

fn native_tool_call(name: &str, arguments: Value) -> NativeToolCall {
    NativeToolCall {
        id: None,
        call_type: Some("function".into()),
        function: NativeFunctionCall {
            name: name.to_string(),
            arguments,
        },
    }
}

fn json_object_candidates(text: &str) -> Vec<&str> {
    let mut candidates = Vec::new();
    let mut start = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (index, character) in text.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        if character == '"' {
            in_string = true;
            continue;
        }
        if character == '{' {
            if depth == 0 {
                start = Some(index);
            }
            depth += 1;
        } else if character == '}' && depth > 0 {
            depth -= 1;
            if depth == 0 {
                if let Some(start) = start.take() {
                    candidates.push(&text[start..index + character.len_utf8()]);
                }
            }
        }
    }
    candidates
}

fn balanced_json_object_at(text: &str, start: usize) -> Option<&str> {
    if text.as_bytes().get(start) != Some(&b'{') {
        return None;
    }
    json_object_candidates(&text[start..]).into_iter().next()
}

fn ascii_identifier_before(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut end = bytes.len();
    while end > 0 && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    let mut start = end;
    while start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'_') {
        start -= 1;
    }
    (start < end).then_some(&text[start..end])
}

fn ascii_identifier_after(text: &str, start: usize) -> Option<(&str, usize)> {
    let bytes = text.as_bytes();
    let mut name_start = start;
    while name_start < bytes.len() && bytes[name_start].is_ascii_whitespace() {
        name_start += 1;
    }
    let mut end = name_start;
    while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
        end += 1;
    }
    (name_start < end).then_some((&text[name_start..end], end))
}

fn strip_thinking_blocks(text: &str) -> String {
    let mut cleaned = text.to_string();
    for (open, close) in [("<think>", "</think>"), ("[THINK]", "[/THINK]")] {
        while let Some(start) = cleaned.find(open) {
            let body_start = start + open.len();
            let Some(relative_end) = cleaned[body_start..].find(close) else {
                break;
            };
            let end = body_start + relative_end + close.len();
            cleaned.replace_range(start..end, "");
        }
    }
    cleaned
}

fn strip_code_fence(text: &str) -> &str {
    let Some(after_open) = text.strip_prefix("```") else {
        return text;
    };
    let after_language = after_open
        .find('\n')
        .map(|index| &after_open[index + 1..])
        .unwrap_or(after_open);
    after_language
        .strip_suffix("```")
        .unwrap_or(after_language)
        .trim()
}

pub fn fold_reasoning_into_content(content: String, reasoning: Option<&str>) -> String {
    let Some(reasoning) = reasoning.map(str::trim).filter(|value| !value.is_empty()) else {
        return content;
    };
    if content.trim().is_empty() {
        reasoning.to_string()
    } else {
        format!("{reasoning}\n\n{content}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn protocol_history_preserves_assistant_calls_and_correlated_results() {
        let mut history = ProtocolConversation::default();
        let calls = vec![NativeToolCall {
            id: Some("call_7".into()),
            call_type: Some("function".into()),
            function: NativeFunctionCall {
                name: "read_file".into(),
                arguments: json!({"path": "src/lib.rs"}),
            },
        }];
        history.push_assistant_tool_turn(String::new(), &calls);
        history.push_tool_results(
            "Tool results:\ncontents".into(),
            &[ToolResultMessage {
                name: "read_file".into(),
                call_id: "call_7".into(),
                content: "contents".into(),
            }],
        );

        let wire = history.protocol_window(0);
        assert_eq!(wire[0].role, "assistant");
        assert_eq!(wire[0].tool_calls.as_ref().unwrap()[0].id, "call_7");
        assert_eq!(wire[1].role, "tool");
        assert_eq!(wire[1].tool_call_id.as_deref(), Some("call_7"));
    }

    #[test]
    fn protocol_history_serializes_openai_tool_turn_without_flattening() {
        let mut history = ProtocolConversation::default();
        let calls = vec![NativeToolCall {
            id: Some("call_12".into()),
            call_type: Some("function".into()),
            function: NativeFunctionCall {
                name: "read_file".into(),
                arguments: json!({"path": "src/lib.rs"}),
            },
        }];
        history.push_assistant_tool_turn("inspect source".into(), &calls);
        history.push_tool_results(
            "Tool results:\ncontents".into(),
            &[ToolResultMessage {
                name: "read_file".into(),
                call_id: "call_12".into(),
                content: "contents".into(),
            }],
        );

        let wire = serde_json::to_value(history.protocol_window(0)).unwrap();
        assert_eq!(wire[0]["role"], "assistant");
        assert_eq!(
            wire[0]["tool_calls"][0]["function"]["arguments"],
            r#"{"path":"src/lib.rs"}"#
        );
        assert_eq!(wire[1]["role"], "tool");
        assert_eq!(wire[1]["tool_call_id"], "call_12");
        assert_eq!(wire[1]["content"], "contents");
    }

    #[test]
    fn protocol_window_does_not_emit_an_orphan_tool_result() {
        let mut history = ProtocolConversation::default();
        history.push(ChatMessage {
            role: "user".into(),
            content: "inspect".into(),
        });
        let calls = vec![NativeToolCall {
            id: Some("call_9".into()),
            call_type: Some("function".into()),
            function: NativeFunctionCall {
                name: "grep".into(),
                arguments: json!({"pattern": "Widget"}),
            },
        }];
        history.push_assistant_tool_turn(String::new(), &calls);
        history.push_tool_results(
            "Tool results:\nmatch".into(),
            &[ToolResultMessage {
                name: "grep".into(),
                call_id: "call_9".into(),
                content: "match".into(),
            }],
        );

        let wire = history.protocol_window(2);
        assert_eq!(wire.len(), 2);
        assert_eq!(wire[0].role, "assistant");
        assert_eq!(wire[1].role, "tool");
    }

    #[test]
    fn protocol_window_closes_interrupted_call_before_later_feedback() {
        let mut history = ProtocolConversation::default();
        let calls = vec![NativeToolCall {
            id: Some("call_interrupted".into()),
            call_type: Some("function".into()),
            function: NativeFunctionCall {
                name: "edit_block".into(),
                arguments: json!({"path": "src/lib.rs"}),
            },
        }];
        history.push_assistant_tool_turn(String::new(), &calls);
        history.push(ChatMessage {
            role: "user".into(),
            content: "Replan from fresh source evidence.".into(),
        });

        let window = history.protocol_window_with_diagnostics(0);
        let roles: Vec<&str> = window
            .messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        assert_eq!(roles, vec!["assistant", "tool", "user"]);
        assert_eq!(window.interrupted_call_ids, vec!["call_interrupted"]);
        assert_eq!(
            window.messages[1].tool_call_id.as_deref(),
            Some("call_interrupted")
        );
        assert!(
            window.messages[1]
                .content
                .as_deref()
                .unwrap()
                .contains("not confirmed")
        );
    }

    #[test]
    fn malformed_argument_text_is_not_replaced_with_empty_object() {
        let call = NativeToolCall {
            id: Some("call_bad".into()),
            call_type: Some("function".into()),
            function: NativeFunctionCall {
                name: "edit_block".into(),
                arguments: Value::String("{bad json".into()),
            },
        };
        let invocation = invocation_from_native(&call);
        assert_eq!(invocation.args, Value::String("{bad json".into()));
        assert!(invocation.argument_error.unwrap().contains("invalid JSON"));
    }

    #[test]
    fn rescues_qwen_hermes_xml_tool_call() {
        let calls = rescue_text_tool_calls(
            r#"<tool_call>{"name":"read_file","arguments":{"path":"src/lib.rs"}}</tool_call>"#,
            &["read_file".into()],
        );
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.name, "read_file");
        assert_eq!(calls[0].function.arguments["path"], "src/lib.rs");
    }

    #[test]
    fn rescues_qwen_function_parameter_tool_call() {
        let calls = rescue_text_tool_calls(
            "<function=grep><parameter=pattern>Widget</parameter><parameter=path>src</parameter></function>",
            &["grep".into()],
        );
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.arguments["pattern"], "Widget");
        assert_eq!(calls[0].function.arguments["path"], "src");
    }

    #[test]
    fn rescues_openai_tool_call_json_emitted_as_text() {
        let calls = rescue_text_tool_calls(
            r#"{"tool_calls":[{"function":{"name":"grep","arguments":"{\"pattern\":\"Widget\"}"}}]}"#,
            &["grep".into()],
        );
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.name, "grep");
        assert_eq!(
            calls[0].function.arguments,
            Value::String(r#"{"pattern":"Widget"}"#.into())
        );
    }

    #[test]
    fn rescues_embedded_forge_json_without_accepting_unknown_tools() {
        let calls = rescue_text_tool_calls(
            r#"I will inspect now: {"tool":"read_file","args":{"path":"src/lib.rs"}} then continue."#,
            &["read_file".into()],
        );
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.name, "read_file");
        assert_eq!(calls[0].function.arguments["path"], "src/lib.rs");

        let unknown = rescue_text_tool_calls(
            r#"{"tool":"invent_tool","args":{"path":"src/lib.rs"}}"#,
            &["read_file".into()],
        );
        assert!(unknown.is_empty());
    }

    #[test]
    fn rescues_qwen_rehearsal_syntax() {
        let calls = rescue_text_tool_calls(
            r#"read_file[ARGS]{"path":"src/{core}/lib.rs"}"#,
            &["read_file".into()],
        );
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.arguments["path"], "src/{core}/lib.rs");
    }

    #[test]
    fn ignores_rehearsal_inside_thinking_tags() {
        let calls = rescue_text_tool_calls(
            r#"<think>read_file[ARGS]{"path":"wrong.rs"}</think>Plain response"#,
            &["read_file".into()],
        );
        assert!(calls.is_empty());
    }

    #[test]
    fn rescues_mistral_bracket_tool_syntax() {
        let calls = rescue_text_tool_calls(
            r#"[TOOL_CALLS]grep {"pattern":"Widget","path":"src"}"#,
            &["grep".into()],
        );
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.arguments["pattern"], "Widget");
    }

    #[test]
    fn folds_reasoning_into_tool_call_content_without_dropping_answer() {
        assert_eq!(
            fold_reasoning_into_content("call next".into(), Some("inspect result")),
            "inspect result\n\ncall next"
        );
    }
}
