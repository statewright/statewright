use serde::{Deserialize, Serialize};

/// JSON-RPC 2.0 request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
    #[serde(default)]
    pub id: Option<serde_json::Value>,
}

/// JSON-RPC 2.0 response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
    pub id: Option<serde_json::Value>,
}

impl JsonRpcResponse {
    pub fn success(id: Option<serde_json::Value>, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            result: Some(result),
            error: None,
            id,
        }
    }

    pub fn error(id: Option<serde_json::Value>, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
                data: None,
            }),
            id,
        }
    }
}

/// JSON-RPC 2.0 error.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// MCP tool definition exposed to the client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<ToolAnnotations>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub input_schema: serde_json::Value,
}

/// MCP tool hints. Missing values retain the client's conservative defaults.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAnnotations {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_only_hint: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destructive_hint: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotent_hint: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_world_hint: Option<bool>,
    // Preserve upstream extensions as well as the standard hints.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl ToolAnnotations {
    pub fn read_only() -> Self {
        Self {
            read_only_hint: Some(true),
            destructive_hint: Some(false),
            open_world_hint: Some(false),
            ..Self::default()
        }
    }
}

/// Parameters for a tools/call request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallParams {
    pub name: String,
    #[serde(default)]
    pub arguments: serde_json::Value,
}

/// Content item in a tool result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResultContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: String,
}

/// Result of a tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallResult {
    pub content: Vec<ToolResultContent>,
    #[serde(default)]
    pub is_error: bool,
}

impl ToolCallResult {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![ToolResultContent {
                content_type: "text".into(),
                text: text.into(),
            }],
            is_error: false,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            content: vec![ToolResultContent {
                content_type: "text".into(),
                text: message.into(),
            }],
            is_error: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn jsonrpc_request_roundtrip() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/list".into(),
            params: Some(json!({})),
            id: Some(json!(1)),
        };
        let serialized = serde_json::to_string(&req).unwrap();
        let deserialized: JsonRpcRequest = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.method, "tools/list");
        assert_eq!(deserialized.id, Some(json!(1)));
    }

    #[test]
    fn jsonrpc_success_response() {
        let resp = JsonRpcResponse::success(Some(json!(1)), json!({"tools": []}));
        let serialized = serde_json::to_string(&resp).unwrap();
        assert!(!serialized.contains("error"));
        let deserialized: JsonRpcResponse = serde_json::from_str(&serialized).unwrap();
        assert!(deserialized.result.is_some());
        assert!(deserialized.error.is_none());
    }

    #[test]
    fn jsonrpc_error_response() {
        let resp = JsonRpcResponse::error(Some(json!(2)), -32600, "Tool blocked");
        let serialized = serde_json::to_string(&resp).unwrap();
        assert!(!serialized.contains("result"));
        let deserialized: JsonRpcResponse = serde_json::from_str(&serialized).unwrap();
        assert!(deserialized.result.is_none());
        let err = deserialized.error.unwrap();
        assert_eq!(err.code, -32600);
        assert_eq!(err.message, "Tool blocked");
    }

    #[test]
    fn tool_info_serialization() {
        let tool = ToolInfo {
            annotations: None,
            name: "read_file".into(),
            description: Some("Read a file".into()),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"]
            }),
        };
        let serialized = serde_json::to_string(&tool).unwrap();
        assert!(serialized.contains("inputSchema"));
        let deserialized: ToolInfo = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.name, "read_file");
    }

    #[test]
    fn tool_call_result_text() {
        let result = ToolCallResult::text("file contents here");
        assert!(!result.is_error);
        assert_eq!(result.content[0].text, "file contents here");
    }

    #[test]
    fn tool_annotations_preserve_upstream_fields_and_absent_defaults() {
        let upstream = json!({
            "name": "upstream_tool", "description": null, "inputSchema": {},
            "annotations": {
                "title": "Upstream tool", "readOnlyHint": false,
                "destructiveHint": true, "idempotentHint": false,
                "openWorldHint": true, "vendorHint": {"value": 1}
            }
        });
        let tool: ToolInfo = serde_json::from_value(upstream.clone()).unwrap();
        assert_eq!(serde_json::to_value(tool).unwrap(), upstream);

        let unknown = json!({"name": "unknown", "description": null, "inputSchema": {}});
        let tool: ToolInfo = serde_json::from_value(unknown.clone()).unwrap();
        assert!(tool.annotations.is_none());
        assert_eq!(serde_json::to_value(tool).unwrap(), unknown);
        assert_eq!(
            serde_json::to_value(ToolAnnotations::default()).unwrap(),
            json!({})
        );
    }

    #[test]
    fn tool_call_result_error() {
        let result = ToolCallResult::error("Tool not permitted");
        assert!(result.is_error);
        assert_eq!(result.content[0].text, "Tool not permitted");
    }
}
