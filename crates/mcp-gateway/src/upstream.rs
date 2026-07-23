use std::collections::HashMap;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

use crate::config::UpstreamConfig;
use crate::protocol::{JsonRpcRequest, JsonRpcResponse, ToolCallResult, ToolInfo};

/// A running upstream MCP server process.
struct UpstreamServer {
    name: String,
    child: Child,
    stdin: tokio::process::ChildStdin,
    reader: BufReader<tokio::process::ChildStdout>,
    tools: Vec<ToolInfo>,
    next_id: u64,
}

/// Manages connections to upstream MCP tool servers.
pub struct UpstreamManager {
    servers: Vec<UpstreamServer>,
    tool_to_server: HashMap<String, usize>,
    /// Mock tools for testing (tool name → canned result). Checked before real servers.
    mock_tools: HashMap<String, (ToolInfo, ToolCallResult)>,
}

impl UpstreamManager {
    /// Start all configured upstream servers and discover their tools.
    pub async fn start(configs: Vec<UpstreamConfig>) -> Result<Self, String> {
        let mut servers = Vec::new();
        let mut tool_to_server = HashMap::new();

        for (idx, config) in configs.into_iter().enumerate() {
            let mut server = Self::spawn_server(config).await?;
            Self::initialize(&mut server).await?;
            Self::discover_tools(&mut server).await?;

            for tool in &server.tools {
                tool_to_server.insert(tool.name.clone(), idx);
            }

            servers.push(server);
        }

        Ok(Self {
            servers,
            tool_to_server,
            mock_tools: HashMap::new(),
        })
    }

    /// Create a manager with no upstream servers (for testing or custom-tools-only mode).
    pub fn empty() -> Self {
        Self {
            servers: Vec::new(),
            tool_to_server: HashMap::new(),
            mock_tools: HashMap::new(),
        }
    }

    /// Create a manager with mock tools that return canned results.
    /// Used for integration testing tool-call flows without real upstream servers.
    pub fn mock(tools: Vec<(ToolInfo, ToolCallResult)>) -> Self {
        let mock_tools: HashMap<String, (ToolInfo, ToolCallResult)> = tools
            .into_iter()
            .map(|(info, result)| (info.name.clone(), (info, result)))
            .collect();
        Self {
            servers: Vec::new(),
            tool_to_server: HashMap::new(),
            mock_tools,
        }
    }

    /// Get the combined tool list from all upstream servers (and mock tools).
    pub fn all_tools(&self) -> Vec<&ToolInfo> {
        let mut tools: Vec<&ToolInfo> = self.servers.iter().flat_map(|s| s.tools.iter()).collect();
        tools.extend(self.mock_tools.values().map(|(info, _)| info));
        tools
    }

    /// Forward a tool call to the appropriate upstream server (or return mock result).
    pub async fn call_tool(
        &mut self,
        name: &str,
        arguments: serde_json::Value,
    ) -> Result<ToolCallResult, String> {
        // Check mock tools first
        if let Some((_, result)) = self.mock_tools.get(name) {
            return Ok(result.clone());
        }

        let server_idx = self
            .tool_to_server
            .get(name)
            .ok_or_else(|| format!("No upstream server provides tool '{}'", name))?;

        let server = self
            .servers
            .get_mut(*server_idx)
            .ok_or_else(|| "Server index out of bounds".to_string())?;

        let id = server.next_id;
        server.next_id += 1;

        let request = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/call".into(),
            params: Some(serde_json::json!({
                "name": name,
                "arguments": arguments,
            })),
            id: Some(serde_json::json!(id)),
        };

        let request_line = serde_json::to_string(&request)
            .map_err(|e| format!("Failed to serialize request: {}", e))?;

        server
            .stdin
            .write_all(request_line.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to upstream: {}", e))?;
        server
            .stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Failed to write newline: {}", e))?;
        server
            .stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush: {}", e))?;

        let mut line = String::new();
        server
            .reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("Failed to read from upstream: {}", e))?;

        let response: JsonRpcResponse = serde_json::from_str(line.trim())
            .map_err(|e| format!("Failed to parse upstream response: {}", e))?;

        if let Some(error) = response.error {
            return Ok(ToolCallResult::error(error.message));
        }

        if let Some(result) = response.result {
            serde_json::from_value(result)
                .map_err(|e| format!("Failed to parse tool result: {}", e))
        } else {
            Ok(ToolCallResult::text(""))
        }
    }

    /// Gracefully shut down all upstream servers.
    pub async fn shutdown(&mut self) {
        for server in &mut self.servers {
            let _ = server.child.kill().await;
        }
    }

    async fn spawn_server(config: UpstreamConfig) -> Result<UpstreamServer, String> {
        let mut cmd = Command::new(&config.command);
        cmd.args(&config.args)
            .envs(&config.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn '{}': {}", config.name, e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture stdout".to_string())?;

        Ok(UpstreamServer {
            name: config.name,
            child,
            stdin,
            reader: BufReader::new(stdout),
            tools: Vec::new(),
            next_id: 1,
        })
    }

    async fn initialize(server: &mut UpstreamServer) -> Result<(), String> {
        let request = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "initialize".into(),
            params: Some(serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "statewright-gateway",
                    "version": env!("CARGO_PKG_VERSION")
                }
            })),
            id: Some(serde_json::json!(0)),
        };

        let request_line = serde_json::to_string(&request)
            .map_err(|e| format!("Failed to serialize initialize: {}", e))?;

        server
            .stdin
            .write_all(request_line.as_bytes())
            .await
            .map_err(|e| format!("Failed to write initialize to '{}': {}", server.name, e))?;
        server
            .stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Write newline failed: {}", e))?;
        server
            .stdin
            .flush()
            .await
            .map_err(|e| format!("Flush failed: {}", e))?;

        let mut line = String::new();
        server.reader.read_line(&mut line).await.map_err(|e| {
            format!(
                "Failed to read initialize response from '{}': {}",
                server.name, e
            )
        })?;

        // Send initialized notification
        let notification = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "notifications/initialized".into(),
            params: None,
            id: None,
        };
        let notif_line = serde_json::to_string(&notification).unwrap();
        server
            .stdin
            .write_all(notif_line.as_bytes())
            .await
            .map_err(|e| format!("Failed to write initialized notification: {}", e))?;
        server
            .stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Write newline failed: {}", e))?;
        server
            .stdin
            .flush()
            .await
            .map_err(|e| format!("Flush failed: {}", e))?;

        Ok(())
    }

    async fn discover_tools(server: &mut UpstreamServer) -> Result<(), String> {
        let request = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            method: "tools/list".into(),
            params: Some(serde_json::json!({})),
            id: Some(serde_json::json!(server.next_id)),
        };
        server.next_id += 1;

        let request_line = serde_json::to_string(&request)
            .map_err(|e| format!("Failed to serialize tools/list: {}", e))?;

        server
            .stdin
            .write_all(request_line.as_bytes())
            .await
            .map_err(|e| format!("Failed to write tools/list to '{}': {}", server.name, e))?;
        server
            .stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Write newline failed: {}", e))?;
        server
            .stdin
            .flush()
            .await
            .map_err(|e| format!("Flush failed: {}", e))?;

        let mut line = String::new();
        server.reader.read_line(&mut line).await.map_err(|e| {
            format!(
                "Failed to read tools/list response from '{}': {}",
                server.name, e
            )
        })?;

        let response: JsonRpcResponse = serde_json::from_str(line.trim())
            .map_err(|e| format!("Failed to parse tools/list response: {}", e))?;

        if let Some(result) = response.result {
            if let Some(tools) = result.get("tools") {
                server.tools = serde_json::from_value(tools.clone())
                    .map_err(|e| format!("Failed to parse tools: {}", e))?;
            }
        }

        tracing::info!(
            server = server.name,
            tools = server.tools.len(),
            "Discovered upstream tools"
        );

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_manager_has_no_tools() {
        let mgr = UpstreamManager::empty();
        assert!(mgr.all_tools().is_empty());
    }

    #[tokio::test]
    async fn call_tool_on_empty_manager_errors() {
        let mut mgr = UpstreamManager::empty();
        let result = mgr.call_tool("read_file", serde_json::json!({})).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No upstream server"));
    }

    #[test]
    fn mock_includes_tools_in_all_tools() {
        let mgr = UpstreamManager::mock(vec![
            (
                ToolInfo {
                    name: "Edit".into(),
                    description: Some("Edit".into()),
                    input_schema: serde_json::json!({}),
                },
                ToolCallResult::text("ok"),
            ),
            (
                ToolInfo {
                    name: "Read".into(),
                    description: Some("Read".into()),
                    input_schema: serde_json::json!({}),
                },
                ToolCallResult::text("ok"),
            ),
        ]);
        let names: Vec<&str> = mgr.all_tools().iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"Edit"));
        assert!(names.contains(&"Read"));
        assert_eq!(names.len(), 2);
    }

    #[tokio::test]
    async fn mock_call_tool_returns_canned_result() {
        let mut mgr = UpstreamManager::mock(vec![(
            ToolInfo {
                name: "Edit".into(),
                description: None,
                input_schema: serde_json::json!({}),
            },
            ToolCallResult::text("file edited successfully"),
        )]);
        let result = mgr
            .call_tool("Edit", serde_json::json!({"file": "test.rs"}))
            .await
            .unwrap();
        assert!(!result.is_error);
        assert_eq!(result.content[0].text, "file edited successfully");
    }

    #[tokio::test]
    async fn mock_call_tool_unknown_tool_errors() {
        let mut mgr = UpstreamManager::mock(vec![(
            ToolInfo {
                name: "Edit".into(),
                description: None,
                input_schema: serde_json::json!({}),
            },
            ToolCallResult::text("ok"),
        )]);
        let result = mgr.call_tool("Deploy", serde_json::json!({})).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No upstream server"));
    }
}
