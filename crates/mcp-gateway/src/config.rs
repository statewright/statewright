use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use statewright_engine::MachineDefinition;

/// Resolve the built-in shorthand only within the caller's owned catalog.
/// Exact entries take precedence even when disabled; availability is checked
/// separately so an explicitly disabled `engineering` never falls through.
pub(crate) fn resolve_workflow_name<'a>(
    workflows: &'a HashMap<String, MachineDefinition>,
    requested: &'a str,
) -> &'a str {
    if !workflows.contains_key(requested)
        && requested == "engineering"
        && workflows.contains_key("agentic-engineering")
    {
        "agentic-engineering"
    } else {
        requested
    }
}

pub(crate) fn workflow_enabled(definition: &MachineDefinition) -> bool {
    definition
        .meta
        .as_ref()
        .and_then(|meta| meta.enabled)
        .unwrap_or(true)
}

pub(crate) fn available_workflow_names(
    workflows: &HashMap<String, MachineDefinition>,
) -> Vec<&str> {
    let mut names = workflows
        .iter()
        .filter_map(|(name, definition)| workflow_enabled(definition).then_some(name.as_str()))
        .collect::<Vec<_>>();
    names.sort_unstable();
    names
}

/// Discovery metadata, not extra workflow records or selectable entries.
pub(crate) fn workflow_aliases(
    workflows: &HashMap<String, MachineDefinition>,
) -> HashMap<&str, &str> {
    let mut aliases = HashMap::new();
    let resolved = resolve_workflow_name(workflows, "engineering");
    if resolved != "engineering" && workflows.get(resolved).is_some_and(workflow_enabled) {
        aliases.insert("engineering", resolved);
    }
    aliases
}

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
    fn engineering_alias_is_owned_exact_first_and_not_a_catalog_record() {
        let canonical: MachineDefinition =
            serde_json::from_value(simple_def("agentic-engineering")).unwrap();
        let mut workflows = HashMap::new();
        assert_eq!(
            resolve_workflow_name(&workflows, "engineering"),
            "engineering"
        );
        assert!(workflow_aliases(&workflows).is_empty());
        workflows.insert("agentic-engineering".into(), canonical);
        assert_eq!(
            resolve_workflow_name(&workflows, "engineering"),
            "agentic-engineering"
        );
        assert_eq!(
            workflow_aliases(&workflows).get("engineering"),
            Some(&"agentic-engineering")
        );
        assert_eq!(
            available_workflow_names(&workflows),
            vec!["agentic-engineering"]
        );
        for enabled in [true, false] {
            let mut exact: MachineDefinition =
                serde_json::from_value(simple_def("engineering")).unwrap();
            exact.meta = Some(serde_json::from_value(json!({"enabled":enabled})).unwrap());
            workflows.insert("engineering".into(), exact);
            assert_eq!(
                resolve_workflow_name(&workflows, "engineering"),
                "engineering"
            );
            assert!(workflow_aliases(&workflows).is_empty());
        }
        workflows.remove("engineering");
        workflows.get_mut("agentic-engineering").unwrap().meta =
            Some(serde_json::from_value(json!({"enabled":false})).unwrap());
        assert_eq!(
            resolve_workflow_name(&workflows, "engineering"),
            "agentic-engineering"
        );
        assert!(workflow_aliases(&workflows).is_empty());
        assert!(available_workflow_names(&workflows).is_empty());
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
