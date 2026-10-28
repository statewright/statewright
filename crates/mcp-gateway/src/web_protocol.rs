//! MCP 2026-07-28 boundary. Legacy/native sessions retain their original path.
use crate::protocol::{JsonRpcRequest, JsonRpcResponse};
use axum::http::HeaderMap;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;

pub const VERSION: &str = "2026-07-28";
const VERSION_KEY: &str = "io.modelcontextprotocol/protocolVersion";

pub fn is_modern(request: &JsonRpcRequest, headers: &HeaderMap) -> bool {
    request
        .params
        .as_ref()
        .and_then(|p| p.get("_meta"))
        .and_then(|m| m.get(VERSION_KEY))
        .is_some()
        || headers
            .get("mcp-protocol-version")
            .is_some_and(|v| v == VERSION)
        || headers.contains_key("mcp-method")
        || request.method == "server/discover"
        || request.method.starts_with("events/")
}

pub fn validate(request: &JsonRpcRequest, headers: &HeaderMap) -> Result<(), JsonRpcResponse> {
    let p = request.params.as_ref().cloned().unwrap_or(json!({}));
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let version = p["_meta"][VERSION_KEY].as_str();
    if version.is_none()
        || version != header("mcp-protocol-version")
        || header("mcp-method") != Some(request.method.as_str())
    {
        return Err(JsonRpcResponse::error(
            request.id.clone(),
            -32020,
            "HeaderMismatch",
        ));
    }
    if version != Some(VERSION) {
        let mut error =
            JsonRpcResponse::error(request.id.clone(), -32022, "Unsupported protocol version");
        error.error.as_mut().unwrap().data =
            Some(json!({"supported":[VERSION],"requested":version}));
        return Err(error);
    }
    if request.jsonrpc != "2.0"
        || request.id.is_none()
        || !p["_meta"]["io.modelcontextprotocol/clientInfo"]["name"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
        || !p["_meta"]["io.modelcontextprotocol/clientInfo"]["version"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
        || !p["_meta"]["io.modelcontextprotocol/clientCapabilities"].is_object()
    {
        return Err(JsonRpcResponse::error(
            request.id.clone(),
            -32600,
            "Invalid request metadata",
        ));
    }
    if request.method == "tools/call" {
        let decoded = header("mcp-name").and_then(|s| {
            if let Some(encoded) = s
                .strip_prefix("=?base64?")
                .and_then(|s| s.strip_suffix("?="))
            {
                STANDARD
                    .decode(encoded)
                    .ok()
                    .and_then(|b| String::from_utf8(b).ok())
            } else {
                Some(s.to_string())
            }
        });
        if decoded.as_deref().is_none() || decoded.as_deref() != p["name"].as_str() {
            return Err(JsonRpcResponse::error(
                request.id.clone(),
                -32020,
                "HeaderMismatch",
            ));
        }
    }
    Ok(())
}

pub fn complete(mut response: JsonRpcResponse) -> JsonRpcResponse {
    if let Some(result) = response.result.as_mut().and_then(|r| r.as_object_mut()) {
        result.insert("resultType".into(), json!("complete"));
    }
    response
}

/// Application handles are explicit tool arguments, not transport sessions or
/// caller-declared ownership. The transport checks their authenticated owner.
pub fn add_handle_schema(response: &mut JsonRpcResponse) {
    if let Some(tools) = response
        .result
        .as_mut()
        .and_then(|r| r.get_mut("tools"))
        .and_then(|t| t.as_array_mut())
    {
        for tool in tools {
            tool["inputSchema"]["properties"]["run_session_id"] = json!({"type":"string",
                "description":"Opaque workflow handle returned by load_workflow. Required for subsequent state, transition, pause and deactivate calls; omit to start a NEW run. Never infer a handle from another chat."});
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modern_header_body_agreement_is_required() {
        let request = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: "tools/call".into(),
            params: Some(
                json!({"name":"test","_meta":{VERSION_KEY:VERSION,"io.modelcontextprotocol/clientInfo":{"name":"fixture","version":"1"},"io.modelcontextprotocol/clientCapabilities":{}}}),
            ),
        };
        let mut headers = HeaderMap::new();
        assert!(is_modern(&request, &headers));
        assert!(validate(&request, &headers).is_err());
        headers.insert("mcp-method", "tools/call".parse().unwrap());
        headers.insert("mcp-protocol-version", VERSION.parse().unwrap());
        headers.insert("mcp-name", "=?base64?dGVzdA==?=".parse().unwrap());
        assert!(validate(&request, &headers).is_ok());
        headers.insert("mcp-name", "other".parse().unwrap());
        assert_eq!(
            validate(&request, &headers)
                .unwrap_err()
                .error
                .unwrap()
                .code,
            -32020
        );
        headers.insert("mcp-name", "test".parse().unwrap());
        let mut future = request.clone();
        future.params.as_mut().unwrap()["_meta"][VERSION_KEY] = json!("2099-01-01");
        headers.insert("mcp-protocol-version", "2099-01-01".parse().unwrap());
        assert_eq!(
            validate(&future, &headers).unwrap_err().error.unwrap().code,
            -32022
        );
        // An MCP 2 request cannot fall into legacy session inference by
        // omitting its metadata or selecting an unsupported version.
        future.params = Some(json!({"name":"test"}));
        assert!(is_modern(&future, &headers));
        assert_eq!(
            validate(&future, &headers).unwrap_err().error.unwrap().code,
            -32020
        );
    }
}
