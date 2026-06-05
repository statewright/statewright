use serde::Serialize;

/// Events emitted by the engine loop for TUI rendering and JSON streaming.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum TuiEvent {
    /// Setup phase
    Setup { files_snapshotted: usize },

    /// State machine loaded
    MachineLoaded {
        states: Vec<StateInfo>,
    },

    /// New step started
    StepStarted {
        step: u32,
        state: String,
        iteration: u32,
        max_iterations: u32,
        tools: Vec<String>,
        is_checkpoint: bool,
    },

    /// Programmatic localization results
    Localized {
        files: Vec<String>,
        test_failures: String,
        excerpt_lines: usize,
    },

    /// LLM called a tool
    ToolCall {
        name: String,
        args_preview: String,
    },

    /// Tool returned a result
    ToolResult {
        name: String,
        result_preview: String,
    },

    /// Tool was blocked by guard
    GuardBlocked {
        tool: String,
        state: String,
    },

    /// State transition
    Transition {
        from: String,
        to: String,
    },

    /// Auto-test ran
    AutoTest {
        passed: bool,
        fail_count: usize,
    },

    /// Diff stats
    DiffStats {
        file: String,
        changed: usize,
        total: usize,
    },

    /// Minimizer rejected
    MinimizerRejected {
        file: String,
        changed: usize,
        max: usize,
    },

    /// Edit gate blocked
    EditGateBlocked,

    /// Parse failure
    ParseFail { preview: String },

    /// LLM raw response
    LlmResponse { preview: String },

    /// Navigation tool
    NavAction { action: String },

    /// Approval gate
    ApprovalGate { message: String },

    /// Snapshot taken
    Snapshot,

    /// Final result
    Completed { steps: u32, success: bool },

    /// Agent reported failure
    AgentFailed { error: Option<String> },

    /// Abort (max steps)
    Aborted { max_steps: u32 },
}

/// Emit a TuiEvent as a single JSONL line to stdout.
pub fn emit_json(event: &TuiEvent) {
    if let Ok(json) = serde_json::to_string(event) {
        println!("{}", json);
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StateInfo {
    pub name: String,
    pub tools: Vec<String>,
    pub transitions: Vec<(String, String)>,
    pub max_iterations: Option<u32>,
    pub is_final: bool,
}
