use crate::bash_classifier;
use crate::protocol::ToolCallResult;
use crate::risk_assessment::{ResolvedEffect, RiskPipelineAssessment};
use crate::session::GatewaySession;

/// Pre-call interception result.
pub enum PreCallDecision {
    /// Allow the call to proceed.
    Allow,
    /// Block the call with an error message.
    Block(String),
    /// Allow but append a warning to the result.
    Warn(String),
}

fn pipeline_effect_has_capability(effect: ResolvedEffect, allowed_tools: &[String]) -> bool {
    let has = |names: &[&str]| {
        allowed_tools.iter().any(|allowed| {
            names
                .iter()
                .any(|candidate| allowed.eq_ignore_ascii_case(candidate))
        })
    };
    match effect {
        ResolvedEffect::ReadOnly => has(&["Read", "read_file"]),
        ResolvedEffect::LocalWrite => has(&["Write", "write_file"]),
        ResolvedEffect::DenyKnownRisk | ResolvedEffect::DenyUncertain => false,
    }
}

/// Run all pre-call interceptors. Returns Block if any interceptor rejects.
/// Returns Warn with concatenated warnings if any fire.
pub fn pre_call_check(
    session: &GatewaySession,
    tool_name: &str,
    arguments: &serde_json::Value,
) -> PreCallDecision {
    pre_call_check_with_pipeline(session, tool_name, arguments, None)
}

/// Run pre-call interceptors with the already-resolved risk pipeline. The
/// pipeline is authoritative for effect classification; command allowlists,
/// blocked environment variables, edit bounds, and state capabilities remain
/// independently enforced around it.
pub fn pre_call_check_with_pipeline(
    session: &GatewaySession,
    tool_name: &str,
    arguments: &serde_json::Value,
    pipeline: Option<&RiskPipelineAssessment>,
) -> PreCallDecision {
    if let Some(reason) = crate::enforcement::unsupported_shell_dialect_reason(tool_name, arguments)
    {
        return PreCallDecision::Block(reason.into());
    }
    let state_def = match session.definition.states.get(&session.current_state) {
        Some(s) => s,
        None => return PreCallDecision::Allow,
    };

    let mut warnings: Vec<String> = Vec::new();

    // Environment restrictions are part of the gateway's authoritative shell
    // policy. Adapters may delegate blacklist-mode decisions here, so this
    // guard must not exist only in a client hook.
    let bash_tool = state_def.allowed_commands_tool.as_deref().unwrap_or("Bash");
    if is_shell_tool(tool_name, bash_tool) {
        if let Some(blocked_env) = state_def
            .blocked_env
            .as_ref()
            .filter(|vars| !vars.is_empty())
        {
            let Some(command) = extract_command(arguments) else {
                return PreCallDecision::Block(format!(
                    "Shell invocation is missing command/cmd in state '{}'.",
                    session.current_state
                ));
            };
            if blocked_env
                .iter()
                .any(|name| bash_classifier::references_environment_variable(&command, name))
            {
                return PreCallDecision::Block(format!(
                    "Shell invocation references a blocked environment variable in state '{}'.",
                    session.current_state
                ));
            }
        }
    }

    // 1. Edit guard: reject edits exceeding max_edit_lines
    if let Some(max_lines) = state_def.max_edit_lines {
        if is_edit_tool(tool_name) {
            if let Some(line_count) = estimate_edit_lines(arguments) {
                if line_count > max_lines {
                    return PreCallDecision::Block(format!(
                        "Edit rejected: {} lines changed exceeds limit of {} for state '{}'. Break the edit into smaller changes.",
                        line_count, max_lines, session.current_state
                    ));
                }
            }
        }
    }

    // 2. Bash guard: check command against allowed_commands whitelist
    if let Some(ref allowed_cmds) = state_def.allowed_commands {
        let bash_tool = state_def.allowed_commands_tool.as_deref().unwrap_or("Bash");
        if is_shell_tool(tool_name, bash_tool) {
            let Some(command) = extract_command(arguments) else {
                return PreCallDecision::Block(format!(
                    "Shell invocation is missing command/cmd in state '{}'.",
                    session.current_state
                ));
            };
            let allowed = allowed_cmds
                .iter()
                .any(|allowed| bash_classifier::matches_allowed_command(&command, allowed));
            if !allowed {
                return PreCallDecision::Block(format!(
                    "Command rejected: '{}' is not in the allowed commands for state '{}'. Allowed: {}",
                    command,
                    session.current_state,
                    allowed_cmds.join(", ")
                ));
            }
        }
    }

    // 2b. Always apply the operation classifier after any command-prefix policy.
    // A prefix match is an optional narrowing mechanism, never a reason to skip
    // deterministic redirect/in-place/destructive checks. Exploratory states use
    // the read capabilities as their effective shell policy even though their
    // MCP tool surface is selected by semantic intent rather than an allowlist.
    if is_shell_tool(tool_name, bash_tool) {
        let exploratory_read_only = state_def.intent.as_deref() == Some("exploratory_read_only");
        let effective_tools = if exploratory_read_only {
            Some(vec![
                "Read".to_string(),
                "Grep".to_string(),
                "Glob".to_string(),
            ])
        } else {
            state_def.allowed_tools.clone()
        };
        if let Some(allowed_tools) = effective_tools {
            let Some(command) = extract_command(arguments) else {
                return PreCallDecision::Block(format!(
                    "Shell invocation is missing command/cmd in state '{}'.",
                    session.current_state
                ));
            };
            let resolved_effect = pipeline.map(RiskPipelineAssessment::resolve_effect);
            let pipeline_admitted = resolved_effect
                .is_some_and(|effect| pipeline_effect_has_capability(effect, &allowed_tools));
            if exploratory_read_only
                && !pipeline_admitted
                && bash_classifier::readonly_capabilities(&command).is_none()
            {
                return PreCallDecision::Block(format!(
                    "Bash command blocked in exploratory state '{}': only proven read-only commands are permitted.",
                    session.current_state
                ));
            }
            if !exploratory_read_only && !pipeline_admitted {
                if let Err(reason) =
                    bash_classifier::check_against_allowed(&command, &allowed_tools)
                {
                    return PreCallDecision::Block(format!(
                        "Bash command blocked in state '{}': {}",
                        session.current_state, reason
                    ));
                }
            }
        }
    }

    // 3. Edit scope limits: max files per state
    if let Some(max_files) = state_def.max_files_per_state {
        if is_edit_tool(tool_name) {
            if let Some(file_path) = extract_file_path(arguments) {
                let already_edited = session.files_edited.contains(&file_path);
                if !already_edited && session.files_edited.len() as u32 >= max_files {
                    return PreCallDecision::Block(format!(
                        "Edit rejected: already edited {} files in state '{}' (limit: {}). Transition to next state or reduce scope. Files edited: {}",
                        session.files_edited.len(),
                        session.current_state,
                        max_files,
                        session.files_edited.join(", ")
                    ));
                }
            }
        }
    }

    // 4. Read dedup: warn on repeated reads of the same file
    if is_read_tool(tool_name) {
        if let Some(file_path) = extract_file_path(arguments) {
            let read_count = session.files_read.get(&file_path).copied().unwrap_or(0);
            if read_count >= 2 {
                warnings.push(format!(
                    "[STATEWRIGHT] You have read '{}' {} times in this state. The content is already in your context.",
                    file_path, read_count
                ));
            }
        }
    }

    // 5. Context budget: warn if approaching limit
    if let Some(budget) = state_def.context_budget_bytes {
        if budget > 0 {
            let pct = (session.context_bytes as f64 / budget as f64) * 100.0;
            if pct >= 90.0 {
                warnings.push(format!(
                    "[STATEWRIGHT] Context budget: {:.0}% used ({}/{} bytes) in state '{}'. Consider transitioning.",
                    pct, session.context_bytes, budget, session.current_state
                ));
            }
        }
    }

    if warnings.is_empty() {
        PreCallDecision::Allow
    } else {
        PreCallDecision::Warn(warnings.join("\n"))
    }
}

/// Post-call tracking: update session counters based on the tool call and result.
pub fn post_call_annotations(
    tool_name: &str,
    arguments: &serde_json::Value,
    result: &ToolCallResult,
) -> PostCallUpdate {
    let mut update = PostCallUpdate::default();

    // Track file edits
    if is_edit_tool(tool_name) {
        if let Some(path) = extract_file_path(arguments) {
            update.file_edited = Some(path);
        }
    }

    // Track file reads
    if is_read_tool(tool_name) {
        if let Some(path) = extract_file_path(arguments) {
            update.file_read = Some(path);
        }
    }

    // Track result size for context budget
    let result_bytes: u64 = result.content.iter().map(|c| c.text.len() as u64).sum();
    update.result_bytes = result_bytes;

    update
}

#[derive(Default)]
pub struct PostCallUpdate {
    pub file_edited: Option<String>,
    pub file_read: Option<String>,
    pub result_bytes: u64,
}

// --- Tool identification helpers ---

fn is_edit_tool(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower == "edit"
        || lower == "write"
        || lower == "edit_file"
        || lower == "write_file"
        || lower == "multiedit"
        || lower == "apply_patch"
        || lower == "patch_file"
        || lower == "create_file"
        || lower == "create_or_update_file"
}

fn is_read_tool(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower == "read" || lower == "read_file" || lower == "cat"
}

fn estimate_edit_lines(arguments: &serde_json::Value) -> Option<u32> {
    // Check for old_string/new_string pattern (Edit tool)
    if let Some(new_str) = arguments.get("new_string").and_then(|v| v.as_str()) {
        let old_str = arguments
            .get("old_string")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let old_lines = old_str.lines().count();
        let new_lines = new_str.lines().count();
        let diff = if new_lines > old_lines {
            new_lines - old_lines
        } else {
            old_lines - new_lines
        };
        return Some(diff.max(new_lines) as u32);
    }
    // Check for content pattern (Write tool)
    if let Some(content) = arguments.get("content").and_then(|v| v.as_str()) {
        return Some(content.lines().count() as u32);
    }
    None
}

fn extract_command(arguments: &serde_json::Value) -> Option<String> {
    arguments
        .get("command")
        .or_else(|| arguments.get("cmd"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
}

fn is_shell_tool(tool_name: &str, configured_tool: &str) -> bool {
    tool_name.eq_ignore_ascii_case(configured_tool)
        || (is_native_shell_tool(configured_tool) && is_native_shell_tool(tool_name))
}

fn is_native_shell_tool(tool_name: &str) -> bool {
    matches!(
        tool_name.to_ascii_lowercase().as_str(),
        "bash" | "exec_command" | "run_command" | "shell" | "terminal"
    )
}

fn extract_file_path(arguments: &serde_json::Value) -> Option<String> {
    arguments
        .get("file_path")
        .or_else(|| arguments.get("path"))
        .or_else(|| arguments.get("file"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::GatewaySession;
    use serde_json::json;
    use statewright_engine::MachineDefinition;

    fn def_with_guards() -> MachineDefinition {
        serde_json::from_value(json!({
            "id": "test",
            "initial": "planning",
            "states": {
                "planning": {
                    "allowed_tools": ["Read", "Grep"],
                    "max_edit_lines": 10,
                    "allowed_commands": ["pytest", "cargo test"],
                    "max_files_per_state": 3,
                    "context_budget_bytes": 5000,
                    "on": { "READY": "implementing" }
                },
                "implementing": {
                    "allowed_tools": ["Read", "Write"],
                    "on": { "DONE": "completed" }
                },
                "completed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap()
    }

    fn session() -> GatewaySession {
        GatewaySession::new("test".into(), def_with_guards())
    }

    #[test]
    fn edit_guard_allows_small_edits() {
        let s = session();
        let args = json!({ "file_path": "test.py", "old_string": "a\nb", "new_string": "a\nb\nc" });
        match pre_call_check(&s, "Edit", &args) {
            PreCallDecision::Allow | PreCallDecision::Warn(_) => {}
            PreCallDecision::Block(msg) => panic!("should allow: {}", msg),
        }
    }

    #[test]
    fn edit_guard_blocks_large_edits() {
        let s = session();
        let big_content = (0..20)
            .map(|i| format!("line {}", i))
            .collect::<Vec<_>>()
            .join("\n");
        let args = json!({ "file_path": "test.py", "old_string": "a", "new_string": big_content });
        match pre_call_check(&s, "Edit", &args) {
            PreCallDecision::Block(msg) => assert!(msg.contains("exceeds limit")),
            _ => panic!("should block large edit"),
        }
    }

    #[test]
    fn bash_guard_allows_whitelisted() {
        let s = session();
        let args = json!({ "command": "pytest -x tests/" });
        match pre_call_check(&s, "Bash", &args) {
            PreCallDecision::Allow | PreCallDecision::Warn(_) => {}
            PreCallDecision::Block(msg) => panic!("should allow pytest: {}", msg),
        }
    }

    #[test]
    fn bash_guard_blocks_non_whitelisted() {
        let s = session();
        let args = json!({ "command": "rm -rf /" });
        match pre_call_check(&s, "Bash", &args) {
            PreCallDecision::Block(msg) => assert!(msg.contains("not in the allowed commands")),
            _ => panic!("should block rm"),
        }
    }

    #[test]
    fn exec_command_cmd_is_checked_against_the_bash_whitelist() {
        let s = session();
        let allowed = json!({ "cmd": "pytest -x tests/" });
        assert!(matches!(
            pre_call_check(&s, "exec_command", &allowed),
            PreCallDecision::Allow
        ));

        let denied = json!({ "cmd": "rm -rf /" });
        match pre_call_check(&s, "exec_command", &denied) {
            PreCallDecision::Block(msg) => assert!(msg.contains("not in the allowed commands")),
            _ => panic!("cmd-based exec_command must be checked"),
        }
    }

    #[test]
    fn shell_calls_without_command_or_cmd_are_blocked() {
        let s = session();
        match pre_call_check(&s, "Bash", &json!({})) {
            PreCallDecision::Block(msg) => assert!(msg.contains("missing command/cmd")),
            _ => panic!("missing shell input must fail closed"),
        }
    }

    #[test]
    fn file_scope_blocks_after_limit() {
        let mut s = session();
        s.files_edited = vec!["a.py".into(), "b.py".into(), "c.py".into()];
        let args = json!({ "file_path": "d.py", "old_string": "x", "new_string": "y" });
        match pre_call_check(&s, "Edit", &args) {
            PreCallDecision::Block(msg) => assert!(msg.contains("already edited 3 files")),
            _ => panic!("should block 4th file edit"),
        }
    }

    #[test]
    fn file_scope_allows_re_edit_same_file() {
        let mut s = session();
        s.files_edited = vec!["a.py".into(), "b.py".into(), "c.py".into()];
        let args = json!({ "file_path": "a.py", "old_string": "x", "new_string": "y" });
        match pre_call_check(&s, "Edit", &args) {
            PreCallDecision::Allow | PreCallDecision::Warn(_) => {}
            PreCallDecision::Block(msg) => panic!("should allow re-edit same file: {}", msg),
        }
    }

    #[test]
    fn read_dedup_warns_on_third_read() {
        let mut s = session();
        s.files_read.insert("test.py".into(), 2);
        let args = json!({ "file_path": "test.py" });
        match pre_call_check(&s, "Read", &args) {
            PreCallDecision::Warn(msg) => assert!(msg.contains("2 times")),
            _ => panic!("should warn on 3rd read"),
        }
    }

    #[test]
    fn context_budget_warns_at_90pct() {
        let mut s = session();
        s.context_bytes = 4600; // 92% of 5000
        let args = json!({});
        match pre_call_check(&s, "Read", &args) {
            PreCallDecision::Warn(msg) => assert!(msg.contains("Context budget")),
            _ => panic!("should warn at 92%"),
        }
    }

    #[test]
    fn no_guards_configured_allows_everything() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "test",
            "initial": "start",
            "states": {
                "start": { "on": { "DONE": "end" } },
                "end": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();
        let s = GatewaySession::new("test".into(), def);
        let args =
            json!({ "command": "rm -rf /", "file_path": "x.py", "content": "lots\nof\nlines" });
        match pre_call_check(&s, "Bash", &args) {
            PreCallDecision::Allow => {}
            other => panic!(
                "should allow when no guards configured: {:?}",
                match other {
                    PreCallDecision::Block(m) | PreCallDecision::Warn(m) => m,
                    _ => "unknown".into(),
                }
            ),
        }
    }

    // --- Bash classifier integration tests ---

    fn session_with_read_grep_glob() -> GatewaySession {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "test",
            "initial": "planning",
            "states": {
                "planning": {
                    "allowed_tools": ["Read"],
                    "on": { "READY": "implementing" }
                },
                "implementing": {
                    "allowed_tools": ["Read", "Write", "Bash"],
                    "on": { "DONE": "completed" }
                },
                "completed": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();
        GatewaySession::new("test".into(), def)
    }

    #[test]
    fn bash_cat_redirect_blocked_in_planning() {
        let s = session_with_read_grep_glob();
        let args = json!({ "command": "cat > file.rs << 'EOF'\nfn main() {}\nEOF" });
        match pre_call_check(&s, "Bash", &args) {
            PreCallDecision::Block(msg) => {
                assert!(
                    msg.contains("FileWrite"),
                    "should mention FileWrite: {}",
                    msg
                );
            }
            _ => panic!("should block cat redirect when Write not in allowed_tools"),
        }
    }

    #[test]
    fn bash_cat_read_allowed_in_planning() {
        let s = session_with_read_grep_glob();
        let args = json!({ "command": "cat src/main.rs" });
        match pre_call_check(&s, "Bash", &args) {
            PreCallDecision::Allow | PreCallDecision::Warn(_) => {}
            PreCallDecision::Block(msg) => panic!("should allow cat read: {}", msg),
        }
    }

    #[test]
    fn bash_grep_allowed_in_planning() {
        let s = session_with_read_grep_glob();
        let args = json!({ "command": "grep -rn 'TODO' src/" });
        match pre_call_check(&s, "Bash", &args) {
            PreCallDecision::Allow | PreCallDecision::Warn(_) => {}
            PreCallDecision::Block(msg) => panic!("should allow grep: {}", msg),
        }
    }

    #[test]
    fn bash_sed_inplace_blocked_in_planning() {
        let s = session_with_read_grep_glob();
        let args = json!({ "command": "sed -i 's/old/new/' file.rs" });
        match pre_call_check(&s, "Bash", &args) {
            PreCallDecision::Block(msg) => {
                assert!(
                    msg.contains("FileModify"),
                    "should mention FileModify: {}",
                    msg
                );
            }
            _ => panic!("should block sed -i when Write is not in allowed_tools"),
        }
    }

    #[test]
    fn bash_rm_blocked_in_planning() {
        let s = session_with_read_grep_glob();
        let args = json!({ "command": "rm -rf target/" });
        match pre_call_check(&s, "Bash", &args) {
            PreCallDecision::Block(msg) => {
                assert!(
                    msg.contains("Destructive"),
                    "should mention Destructive: {}",
                    msg
                );
            }
            _ => panic!("should block rm in restricted state"),
        }
    }

    #[test]
    fn bash_passthrough_allowed_in_planning() {
        let s = session_with_read_grep_glob();
        let args = json!({ "command": "echo $PATH" });
        match pre_call_check(&s, "Bash", &args) {
            PreCallDecision::Allow | PreCallDecision::Warn(_) => {}
            PreCallDecision::Block(msg) => panic!("should allow echo: {}", msg),
        }
    }

    #[test]
    fn exploratory_read_only_allows_read_shell_operations_and_blocks_writes() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "explore",
            "initial": "inspect",
            "states": {
                "inspect": {
                    "intent": "exploratory_read_only",
                    "on": {"DONE": "done"}
                },
                "done": {"type": "final"}
            }
        }))
        .unwrap();
        let session = GatewaySession::new("explore".into(), def);

        assert!(matches!(
            pre_call_check(&session, "Bash", &json!({"command": "cat Cargo.toml"})),
            PreCallDecision::Allow | PreCallDecision::Warn(_)
        ));
        assert!(matches!(
            pre_call_check(
                &session,
                "Bash",
                &json!({"command": "echo nope > output.txt"})
            ),
            PreCallDecision::Block(_)
        ));
        for command in [
            "touch output.txt",
            "python3 -c 'open(\"x\", \"w\")'",
            "git add Cargo.toml",
            "git --no-pager branch -- new-name",
            "git --no-pager tag -- new-name",
        ] {
            assert!(
                matches!(
                    pre_call_check(&session, "Bash", &json!({"command": command})),
                    PreCallDecision::Block(_)
                ),
                "must fail closed for {command}"
            );
        }
    }

    #[test]
    fn bash_classifier_runs_when_allowed_commands_set() {
        // Prefix constraints and operation classification are complementary.
        let s = session(); // has allowed_commands: ["pytest", "cargo test"]
        let args = json!({ "command": "pytest -x tests/" });
        match pre_call_check(&s, "Bash", &args) {
            PreCallDecision::Allow | PreCallDecision::Warn(_) => {}
            PreCallDecision::Block(msg) => panic!("should allow whitelisted command: {}", msg),
        }
    }

    #[test]
    fn allowed_commands_reject_shell_composition_and_prefix_collisions() {
        let s = session();
        for command in [
            "pytest; kubectl apply -f pod.yaml",
            "cargo test $(kubectl config view)",
            "pytest-malicious tests/",
        ] {
            let args = json!({ "command": command });
            match pre_call_check(&s, "Bash", &args) {
                PreCallDecision::Block(_) => {}
                _ => panic!("should block command whitelist bypass: {}", command),
            }
        }
    }

    #[test]
    fn bash_classifier_skipped_when_no_allowed_tools() {
        // No allowed_tools = unrestricted state, classifier should not run
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "test",
            "initial": "start",
            "states": {
                "start": { "on": { "DONE": "end" } },
                "end": { "type": "final" }
            },
            "guards": {}
        }))
        .unwrap();
        let s = GatewaySession::new("test".into(), def);
        let args = json!({ "command": "cat > file.rs << 'EOF'\ncontent\nEOF" });
        match pre_call_check(&s, "Bash", &args) {
            PreCallDecision::Allow => {}
            other => panic!(
                "should allow when no allowed_tools: {:?}",
                match other {
                    PreCallDecision::Block(m) | PreCallDecision::Warn(m) => m,
                    _ => "unknown".into(),
                }
            ),
        }
    }

    #[test]
    fn blocked_environment_variables_are_enforced_by_the_gateway() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "blocked-env",
            "initial": "active",
            "states": {
                "active": {
                    "blocked_env": ["TOKEN"],
                    "on": {"DONE": "done"}
                },
                "done": {"type": "final"}
            }
        }))
        .unwrap();
        let session = GatewaySession::new("blocked-env".into(), def);

        for command in [
            "TOKEN=value command",
            "env TOKEN=value command",
            "echo $TOKEN",
            "echo ${TOKEN:-fallback}",
        ] {
            match pre_call_check(&session, "exec_command", &json!({"cmd": command})) {
                PreCallDecision::Block(reason) => {
                    assert!(reason.contains("blocked environment variable"));
                    assert!(!reason.contains("TOKEN"));
                    assert!(!reason.contains(command));
                }
                _ => panic!("blocked environment reference must be denied: {command}"),
            }
        }

        for command in [
            "TOKEN_SUFFIX=value command",
            "echo $TOKEN_SUFFIX",
            "echo ordinary",
        ] {
            assert!(matches!(
                pre_call_check(&session, "exec_command", &json!({"cmd": command})),
                PreCallDecision::Allow | PreCallDecision::Warn(_)
            ));
        }
    }

    #[test]
    fn blocked_environment_variables_cover_native_shell_aliases() {
        let def: MachineDefinition = serde_json::from_value(json!({
            "id": "blocked-env-aliases",
            "initial": "active",
            "states": {
                "active": {
                    "allowed_commands_tool": "exec_command",
                    "blocked_env": ["TOKEN"],
                    "on": {"DONE": "done"}
                },
                "done": {"type": "final"}
            }
        }))
        .unwrap();
        let session = GatewaySession::new("blocked-env-aliases".into(), def);

        for tool_name in ["Bash", "exec_command", "run_command", "shell", "terminal"] {
            assert!(matches!(
                pre_call_check(&session, tool_name, &json!({"command": "echo $TOKEN"})),
                PreCallDecision::Block(_)
            ));
        }
    }
}
