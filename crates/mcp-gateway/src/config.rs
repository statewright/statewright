use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use statewright_engine::MachineDefinition;

/// Top-level gateway configuration with named workflows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayConfig {
    /// Named workflows.
    pub workflows: HashMap<String, MachineDefinition>,
    /// Default workflow name to load on startup.
    pub default: String,
    #[serde(default)]
    pub upstream_servers: Vec<UpstreamConfig>,
    #[serde(default)]
    pub workdir: Option<PathBuf>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub cloud_url: Option<String>,
}

/// Configuration for an upstream MCP server to proxy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpstreamConfig {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

impl GatewayConfig {
    pub fn from_file(path: &std::path::Path) -> Result<Self, String> {
        let content =
            std::fs::read_to_string(path).map_err(|e| format!("Failed to read config: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn simple_def(id: &str) -> serde_json::Value {
        json!({
            "id": id,
            "initial": "start",
            "states": {
                "start": { "on": { "DONE": "end" } },
                "end": { "type": "final" }
            },
            "guards": {}
        })
    }

    #[test]
    fn parse_multi_workflow_config() {
        let config: GatewayConfig = serde_json::from_value(json!({
            "default": "bugfix",
            "workflows": {
                "bugfix": simple_def("bugfix"),
                "etl": simple_def("etl")
            }
        }))
        .unwrap();
        assert_eq!(config.default, "bugfix");
        assert_eq!(config.workflows.len(), 2);
        assert!(config.workflows.contains_key("bugfix"));
        assert!(config.workflows.contains_key("etl"));
    }

    #[test]
    fn parse_config_with_upstreams() {
        let config: GatewayConfig = serde_json::from_value(json!({
            "default": "test",
            "workflows": {
                "test": simple_def("test")
            },
            "upstream_servers": [
                {
                    "name": "filesystem",
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
                    "env": { "NODE_ENV": "production" }
                }
            ],
            "workdir": "/project"
        }))
        .unwrap();
        assert_eq!(config.upstream_servers.len(), 1);
        assert_eq!(config.workdir, Some(PathBuf::from("/project")));
    }
}
