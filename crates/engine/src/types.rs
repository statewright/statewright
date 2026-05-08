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
    #[serde(default)]
    pub blocked_env: Option<Vec<String>>,
    /// Environment variable overrides for this state (injected as context, not enforced).
    #[serde(default)]
    pub env_overrides: Option<BTreeMap<String, String>>,
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

impl TransitionDef {
    pub fn target(&self) -> &str {
        match self {
            TransitionDef::Simple(t) => t,
            TransitionDef::Full { target, .. } => target,
            TransitionDef::Invoke { on_complete, .. } => on_complete,
        }
    }

    pub fn guard_names(&self) -> Vec<&str> {
        match self {
            TransitionDef::Simple(_) | TransitionDef::Invoke { .. } => vec![],
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
            TransitionDef::Simple(_) | TransitionDef::Invoke { .. } => false,
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
