use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A complete state machine definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineDefinition {
    pub id: String,
    pub initial: String,
    #[serde(default)]
    pub context: serde_json::Value,
    pub states: BTreeMap<String, StateDef>,
    #[serde(default)]
    pub guards: BTreeMap<String, GuardDef>,
    #[serde(default)]
    pub meta: Option<MachineMeta>,
    #[serde(default)]
    pub interrupts: BTreeMap<String, InterruptDef>,
}

/// Interrupt definition — reactive auto-transition triggered by file edits.
/// Uses the History State pattern: detour to a handler state, `$return` resumes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterruptDef {
    pub trigger: InterruptTrigger,
    pub target: String,
}

/// Trigger condition for an interrupt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterruptTrigger {
    pub file_pattern: String,
}

/// Definition of a single state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateDef {
    #[serde(default)]
    pub on: BTreeMap<String, TransitionDef>,
    #[serde(rename = "type", default)]
    pub state_type: Option<StateType>,
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
    /// Blacklist: tools explicitly blocked in this state (complement of allowed_tools).
    /// When set, all tools EXCEPT these are permitted. Takes precedence if both are set.
    #[serde(default)]
    pub disallowed_tools: Option<Vec<String>>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub max_iterations: Option<u32>,
    /// Fallback target when the model emits an unrecognized transition event.
    /// Only fires on unknown events — valid transitions and FAIL are unaffected.
    /// Declared by the state machine author, not inferred.
    #[serde(default)]
    pub safe_next: Option<String>,
    /// Maximum lines that may be edited in this state.
    #[serde(default)]
    pub max_edit_lines: Option<u32>,
    /// Allowed shell commands (for Bash tool restriction).
    #[serde(default)]
    pub allowed_commands: Option<Vec<String>>,
    /// Tool name to restrict commands on (default: "Bash").
    #[serde(default)]
    pub allowed_commands_tool: Option<String>,
    /// Maximum files that may be edited in this state.
    #[serde(default)]
    pub max_files_per_state: Option<u32>,
    /// Maximum context bytes the agent may accumulate in this state.
    #[serde(default)]
    pub context_budget_bytes: Option<u64>,
    /// Environment variables blocked in this state (denied in Bash commands).
    #[serde(default, alias = "deny_env")]
    pub blocked_env: Option<Vec<String>>,
    /// Environment variable overrides for this state (injected as context, not enforced).
    #[serde(default, alias = "env")]
    pub env_overrides: Option<BTreeMap<String, String>>,
    /// Recommended model for this state (e.g. "claude-haiku-4-5-20251001", "anthropic/claude-sonnet-4-6").
    /// Clients that support programmatic model switching enforce this; others treat it as advisory.
    #[serde(default)]
    pub model: Option<String>,
    /// Thinking/reasoning effort level for this state (e.g. "high", "medium", "low", "off").
    /// Clients that support programmatic effort control enforce this; others treat it as advisory.
    #[serde(default)]
    pub thinking_level: Option<String>,
    /// When true, the orchestrating TUI should delegate this state to sw-agent
    /// via statewright_run_agent instead of doing the work itself.
    #[serde(default)]
    pub direct_execution: Option<bool>,
    /// Model escalation ladder for direct_execution states. Each entry is a
    /// {model, url} pair tried in order on failure.
    #[serde(default)]
    pub model_ladder: Option<Vec<serde_json::Value>>,
}

/// A transition triggered by an event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TransitionDef {
    /// Simple: just a target state name.
    Simple(String),
    /// Full: target + optional guard + approval gate.
    Full {
        target: String,
        #[serde(default)]
        guard: Option<String>,
        #[serde(default)]
        guards: Option<Vec<String>>,
        #[serde(default)]
        requires_approval: Option<bool>,
        #[serde(default)]
        approval_message: Option<String>,
    },
    /// Guarded: array of conditional transitions — first matching guard wins.
    Guarded(Vec<GuardedTransition>),
    /// Fork: spawn parallel branches, join when complete.
    Fork {
        fork: ForkDef,
    },
    /// Invoke: delegate to a sub-machine, then resume at on_complete.
    Invoke {
        /// Reference to the sub-machine definition to invoke.
        invoke: String,
        /// State to transition to when the sub-machine completes successfully.
        on_complete: String,
        /// State to transition to when the sub-machine fails.
        #[serde(default)]
        on_fail: Option<String>,
        /// Input data to pass to the sub-machine's initial context.
        #[serde(default)]
        input: Option<serde_json::Value>,
    },
}

/// A single conditional transition within a Guarded array.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuardedTransition {
    pub target: String,
    #[serde(default)]
    pub guard: Option<String>,
    #[serde(default)]
    pub guards: Option<Vec<String>>,
}

impl TransitionDef {
    pub fn target(&self) -> &str {
        match self {
            TransitionDef::Simple(t) => t,
            TransitionDef::Full { target, .. } => target,
            TransitionDef::Guarded(branches) => branches.first().map(|b| b.target.as_str()).unwrap_or(""),
            TransitionDef::Fork { fork } => &fork.on_complete,
            TransitionDef::Invoke { on_complete, .. } => on_complete,
        }
    }

    /// All possible target states (for reachability analysis).
    /// Unlike target() which returns only the first, this returns every branch.
    pub fn all_targets(&self) -> Vec<&str> {
        match self {
            TransitionDef::Simple(t) => vec![t],
            TransitionDef::Full { target, .. } => vec![target],
            TransitionDef::Guarded(branches) => branches.iter().map(|b| b.target.as_str()).collect(),
            TransitionDef::Fork { fork } => vec![&fork.on_complete],
            TransitionDef::Invoke { on_complete, on_fail, .. } => {
                let mut v = vec![on_complete.as_str()];
                if let Some(f) = on_fail { v.push(f.as_str()); }
                v
            }
        }
    }

    pub fn guard_names(&self) -> Vec<&str> {
        match self {
            TransitionDef::Simple(_) | TransitionDef::Invoke { .. } | TransitionDef::Fork { .. } | TransitionDef::Guarded(_) => vec![],
            TransitionDef::Full { guard, guards, .. } => {
                let mut names = Vec::new();
                if let Some(g) = guard {
                    names.push(g.as_str());
                }
                if let Some(gs) = guards {
                    for g in gs {
                        names.push(g.as_str());
                    }
                }
                names
            }
        }
    }

    pub fn requires_approval(&self) -> bool {
        match self {
            TransitionDef::Simple(_) | TransitionDef::Invoke { .. } | TransitionDef::Fork { .. } | TransitionDef::Guarded(_) => false,
            TransitionDef::Full { requires_approval, .. } => requires_approval.unwrap_or(false),
        }
    }

    /// Returns true if this transition invokes a sub-machine.
    pub fn is_invoke(&self) -> bool {
        matches!(self, TransitionDef::Invoke { .. })
    }

    /// Get the invoke details, if this is an invoke transition.
    pub fn invoke_ref(&self) -> Option<InvokeRef<'_>> {
        match self {
            TransitionDef::Invoke { invoke, on_complete, on_fail, input } => Some(InvokeRef {
                machine: invoke,
                on_complete,
                on_fail: on_fail.as_deref(),
                input: input.as_ref(),
            }),
            _ => None,
        }
    }

    /// Returns true if this transition forks into parallel branches.
    pub fn is_fork(&self) -> bool {
        matches!(self, TransitionDef::Fork { .. })
    }

    /// Get the fork details, if this is a fork transition.
    pub fn fork_ref(&self) -> Option<&ForkDef> {
        match self {
            TransitionDef::Fork { fork } => Some(fork),
            _ => None,
        }
    }
}

/// Fork definition — parallel branch execution with join.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForkDef {
    pub branches: BTreeMap<String, BranchDef>,
    #[serde(default = "default_join")]
    pub join: JoinStrategy,
    pub on_complete: String,
    #[serde(default)]
    pub on_fail: Option<String>,
}

fn default_join() -> JoinStrategy {
    JoinStrategy::All
}

/// A single branch within a fork.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchDef {
    pub initial: String,
    pub terminal: String,
}

/// Join strategy for fork completion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JoinStrategy {
    All,
    Any,
}

/// Details of a fork triggered by a transition.
#[derive(Debug, Clone)]
pub struct ForkResult {
    pub branches: BTreeMap<String, BranchDef>,
    pub join: JoinStrategy,
    pub on_complete: String,
    pub on_fail: Option<String>,
}

/// Reference to a sub-machine invocation.
#[derive(Debug, Clone)]
pub struct InvokeRef<'a> {
    pub machine: &'a str,
    pub on_complete: &'a str,
    pub on_fail: Option<&'a str>,
    pub input: Option<&'a serde_json::Value>,
}

/// Guard definition — declarative predicate on context.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuardDef {
    pub field: String,
    pub op: GuardOp,
    #[serde(default)]
    pub value: serde_json::Value,
}

/// Guard comparison operators.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardOp {
    Eq,
    Neq,
    Gt,
    Gte,
    Lt,
    Lte,
    Exists,
    NotExists,
    In,
    Contains,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateType {
    Final,
    Parallel,
}

/// Machine metadata (used by LLM agent layer).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineMeta {
    #[serde(default)]
    pub task_type: Option<String>,
    #[serde(default)]
    pub estimated_steps: Option<u32>,
    #[serde(default)]
    pub danger_level: Option<DangerLevel>,
    #[serde(default)]
    pub requires_human_approval: Option<bool>,
    #[serde(default)]
    pub capture_output: Option<bool>,
    /// Default model for states that don't specify their own.
    /// States with an explicit `model` field override this.
    #[serde(default)]
    pub default_model: Option<String>,
    /// Catch-all for forward compatibility with new meta fields.
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DangerLevel {
    Safe,
    Moderate,
    Dangerous,
}

/// Result of a transition attempt.
#[derive(Debug, Clone)]
pub struct TransitionResult {
    pub new_state: String,
    pub new_context: serde_json::Value,
    pub transitioned: bool,
    pub requires_approval: bool,
    pub approval_message: Option<String>,
    /// If set, this transition invokes a sub-machine before advancing.
    pub invoke: Option<InvokeResult>,
    /// If set, this transition forks into parallel branches.
    pub fork: Option<ForkResult>,
}

/// Details of a sub-machine invocation triggered by a transition.
#[derive(Debug, Clone)]
pub struct InvokeResult {
    /// Name/ID of the sub-machine to invoke.
    pub machine: String,
    /// State to resume at when the sub-machine completes.
    pub on_complete: String,
    /// State to resume at when the sub-machine fails.
    pub on_fail: Option<String>,
    /// Input data to pass to the sub-machine.
    pub input: Option<serde_json::Value>,
}

/// Errors from transition processing.
#[derive(Debug, Clone)]
pub enum TransitionError {
    NoMatchingTransition { state: String, event: String },
    GuardFailed { guard: String },
    StateNotFound { state: String },
    InvalidDefinition { message: String },
}

impl std::fmt::Display for TransitionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransitionError::NoMatchingTransition { state, event } => {
                write!(f, "no transition for event '{}' in state '{}'", event, state)
            }
            TransitionError::GuardFailed { guard } => {
                write!(f, "guard '{}' failed", guard)
            }
            TransitionError::StateNotFound { state } => {
                write!(f, "state '{}' not found in definition", state)
            }
            TransitionError::InvalidDefinition { message } => {
                write!(f, "invalid definition: {}", message)
            }
        }
    }
}

impl std::error::Error for TransitionError {}

/// Errors from definition validation.
#[derive(Debug, Clone)]
pub struct ValidationError {
    pub errors: Vec<String>,
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "validation errors: {}", self.errors.join("; "))
    }
}

impl std::error::Error for ValidationError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn state_def_deserializes_model_field() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "model-routing-test",
            "initial": "diagnose",
            "states": {
                "diagnose": {
                    "allowed_tools": ["Read", "Bash"],
                    "model": "claude-haiku-4-5-20251001",
                    "max_iterations": 8,
                    "on": { "DIAGNOSED": "propose_fix" }
                },
                "propose_fix": {
                    "allowed_tools": ["Read"],
                    "model": "anthropic/claude-opus-4-6",
                    "max_iterations": 3,
                    "on": { "DONE": "completed" }
                },
                "completed": { "type": "final" }
            }
        })).unwrap();

        assert_eq!(
            def.states["diagnose"].model.as_deref(),
            Some("claude-haiku-4-5-20251001")
        );
        assert_eq!(
            def.states["propose_fix"].model.as_deref(),
            Some("anthropic/claude-opus-4-6")
        );
        // Final state has no model — should be None
        assert_eq!(def.states["completed"].model, None);
    }

    #[test]
    fn state_def_model_defaults_to_none() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "no-model",
            "initial": "working",
            "states": {
                "working": {
                    "allowed_tools": ["Read"],
                    "on": { "DONE": "done" }
                },
                "done": { "type": "final" }
            }
        })).unwrap();

        assert_eq!(def.states["working"].model, None);
    }

    #[test]
    fn meta_default_model_deserializes() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "default-model-test",
            "initial": "planning",
            "meta": {
                "default_model": "anthropic/claude-opus-4-6"
            },
            "states": {
                "planning": {
                    "allowed_tools": ["Read"],
                    "on": { "DONE": "implementing" }
                },
                "implementing": {
                    "model": "claude-haiku-4-5-20251001",
                    "allowed_tools": ["Read", "Edit"],
                    "on": { "DONE": "done" }
                },
                "done": { "type": "final" }
            }
        })).unwrap();

        let meta = def.meta.unwrap();
        assert_eq!(meta.default_model.as_deref(), Some("anthropic/claude-opus-4-6"));
        // planning inherits default (no explicit model)
        assert_eq!(def.states["planning"].model, None);
        // implementing overrides
        assert_eq!(def.states["implementing"].model.as_deref(), Some("claude-haiku-4-5-20251001"));
    }

    #[test]
    fn state_def_thinking_level_deserializes() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "thinking-test",
            "initial": "planning",
            "states": {
                "planning": {
                    "allowed_tools": ["Read"],
                    "thinking_level": "high",
                    "on": { "DONE": "testing" }
                },
                "testing": {
                    "allowed_tools": ["Bash"],
                    "thinking_level": "off",
                    "on": { "DONE": "done" }
                },
                "done": { "type": "final" }
            }
        })).unwrap();

        assert_eq!(def.states["planning"].thinking_level.as_deref(), Some("high"));
        assert_eq!(def.states["testing"].thinking_level.as_deref(), Some("off"));
        assert_eq!(def.states["done"].thinking_level, None);
    }
}
