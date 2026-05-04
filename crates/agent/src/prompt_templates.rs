/// System prompt for state machine generation.
/// The LLM receives this + a task description and outputs a JSON state machine.
pub const GENERATION_SYSTEM_PROMPT: &str = r#"You are a planning agent. Given a task description, generate a state machine definition that constrains execution of that task.

## Output Format
Respond with a single JSON object. No markdown, no explanation, no code fences. Just valid JSON.

## Required Structure

{
  "id": "short-slug-for-this-task",
  "initial": "first_state_name",
  "meta": {
    "task_type": "bug_fix|feature_add|research|refactor|deploy",
    "danger_level": "safe|moderate|dangerous",
    "estimated_steps": 5
  },
  "states": {
    "state_name": {
      "allowed_tools": ["tool1", "tool2"],
      "instructions": "What the agent should do in this state",
      "on": {
        "EVENT_NAME": "target_state",
        "EVENT_WITH_GUARD": {
          "target": "target_state",
          "requires_approval": true,
          "approval_message": "Explain what needs approval"
        }
      }
    }
  },
  "guards": {}
}

## Required Properties

1. MUST have an initial state
2. MUST have at least one state with "type": "final"
3. MUST have a state named "failed" with "type": "final"
4. Every non-final state MUST have a transition to "failed" (directly or via FAIL event)
5. If danger_level is "moderate" or "dangerous", at least one transition MUST have "requires_approval": true
6. Destructive operations (file deletion, deployment, database mutation) MUST be gated behind an approval transition
7. The initial state MUST NOT include write/modify tools in allowed_tools for moderate/dangerous tasks
8. Every state MUST have at least one outgoing transition (except final states)
9. The state graph MUST be connected — every state reachable from initial

## Tool Categories

READ_ONLY: read_file, search_files, list_directory, grep, git_status, git_log, git_diff
WRITE: write_file, edit_file, create_file, delete_file
EXECUTE: run_command, run_test, run_build
GIT: git_add, git_commit, git_push, git_checkout, git_branch
EXTERNAL: http_request, deploy, database_query, database_mutate

## Example: Bug Fix

{
  "id": "fix-login-bug",
  "initial": "planning",
  "meta": { "task_type": "bug_fix", "danger_level": "moderate", "estimated_steps": 6 },
  "states": {
    "planning": {
      "allowed_tools": ["read_file", "search_files", "grep", "git_log", "git_diff"],
      "instructions": "Analyze the bug. Read relevant files. Identify root cause.",
      "on": { "PLAN_READY": "implementing", "FAIL": "failed" }
    },
    "implementing": {
      "allowed_tools": ["read_file", "write_file", "edit_file"],
      "instructions": "Implement the fix based on your analysis.",
      "on": { "DONE": "testing", "FAIL": "failed" }
    },
    "testing": {
      "allowed_tools": ["read_file", "run_test"],
      "instructions": "Run tests to verify the fix works and nothing is broken.",
      "on": {
        "TESTS_PASS": { "target": "review", "requires_approval": true, "approval_message": "Tests passed. Review changes before committing?" },
        "TESTS_FAIL": "implementing",
        "FAIL": "failed"
      }
    },
    "review": {
      "allowed_tools": ["read_file", "git_diff"],
      "instructions": "Present changes for human review.",
      "on": { "APPROVED": "committing", "REJECTED": "implementing" }
    },
    "committing": {
      "allowed_tools": ["git_add", "git_commit"],
      "instructions": "Stage and commit the changes.",
      "on": { "COMMITTED": "completed", "FAIL": "failed" }
    },
    "completed": { "type": "final" },
    "failed": { "type": "final" }
  },
  "guards": {}
}

## Example: Research

{
  "id": "research-topic",
  "initial": "gathering",
  "meta": { "task_type": "research", "danger_level": "safe", "estimated_steps": 4 },
  "states": {
    "gathering": {
      "allowed_tools": ["read_file", "search_files", "grep", "http_request"],
      "instructions": "Gather information from files and web sources.",
      "on": { "DATA_COLLECTED": "analyzing", "FAIL": "failed" }
    },
    "analyzing": {
      "allowed_tools": ["read_file"],
      "instructions": "Analyze gathered data and draw conclusions.",
      "on": { "ANALYSIS_DONE": "summarizing", "FAIL": "failed" }
    },
    "summarizing": {
      "allowed_tools": ["write_file"],
      "instructions": "Write a summary of findings.",
      "on": { "DONE": "completed", "FAIL": "failed" }
    },
    "completed": { "type": "final" },
    "failed": { "type": "final" }
  },
  "guards": {}
}
"#;

/// Build the full generation prompt with the task description injected.
pub fn build_generation_prompt(task_description: &str) -> Vec<ChatMessage> {
    vec![
        ChatMessage {
            role: "system".into(),
            content: GENERATION_SYSTEM_PROMPT.into(),
        },
        ChatMessage {
            role: "user".into(),
            content: task_description.into(),
        },
    ]
}

/// Build the execution prompt for a single step within the agent loop.
pub fn build_execution_prompt(
    task_description: &str,
    current_state: &str,
    instructions: Option<&str>,
    allowed_tools: &[String],
    available_transitions: &[(String, String)], // (event, target)
    context_summary: &str,
) -> Vec<ChatMessage> {
    let tools_list = if allowed_tools.is_empty() {
        "No tools available in this state.".to_string()
    } else {
        allowed_tools.join(", ")
    };

    let transitions_list: String = available_transitions
        .iter()
        .map(|(event, target)| format!("  {} → {}", event, target))
        .collect::<Vec<_>>()
        .join("\n");

    let state_instructions = instructions.unwrap_or("Proceed with the task.");

    let prompt = format!(
        r#"You are executing a task under state machine constraints. You are in the "{current_state}" state.

## Task
{task_description}

## Current State Instructions
{state_instructions}

## Allowed Tools
{tools_list}

## Context
{context_summary}

## Available Transitions
{transitions_list}

## How to Proceed
1. Use your allowed tools to make progress
2. When ready to advance, respond with a JSON object: {{"transition": "EVENT_NAME"}}
3. If you encounter an unrecoverable error: {{"transition": "FAIL", "error": "description"}}
4. Do NOT use tools not in your allowed list
5. Do NOT skip states — follow the defined transitions"#
    );

    vec![
        ChatMessage {
            role: "system".into(),
            content: prompt,
        },
        ChatMessage {
            role: "user".into(),
            content: "Proceed with the next action.".into(),
        },
    ]
}

/// A chat message for the Ollama API.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_prompt_includes_task() {
        let messages = build_generation_prompt("Fix the login bug in auth.ts");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "system");
        assert!(messages[0].content.contains("planning agent"));
        assert_eq!(messages[1].role, "user");
        assert_eq!(messages[1].content, "Fix the login bug in auth.ts");
    }

    #[test]
    fn execution_prompt_includes_state_and_tools() {
        let messages = build_execution_prompt(
            "Fix the bug",
            "planning",
            Some("Analyze the bug"),
            &["read_file".into(), "grep".into()],
            &[("PLAN_READY".into(), "implementing".into()), ("FAIL".into(), "failed".into())],
            "No progress yet",
        );
        assert_eq!(messages.len(), 2);
        assert!(messages[0].content.contains("planning"));
        assert!(messages[0].content.contains("read_file"));
        assert!(messages[0].content.contains("PLAN_READY"));
        assert!(messages[0].content.contains("Analyze the bug"));
    }

    #[test]
    fn generation_system_prompt_contains_required_sections() {
        assert!(GENERATION_SYSTEM_PROMPT.contains("Required Properties"));
        assert!(GENERATION_SYSTEM_PROMPT.contains("Tool Categories"));
        assert!(GENERATION_SYSTEM_PROMPT.contains("failed"));
        assert!(GENERATION_SYSTEM_PROMPT.contains("requires_approval"));
        assert!(GENERATION_SYSTEM_PROMPT.contains("danger_level"));
    }
}
