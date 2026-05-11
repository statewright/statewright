---
name: statewright
description: Start, stop, or manage statewright workflows
user-invocable: true
arguments: "[command] [workflow]"
allowed-tools: Bash(*)
---

!`bash ${CLAUDE_SKILL_DIR}/run.sh $ARGUMENTS`

IMPORTANT: If the output above shows a workflow was loaded, you MUST now call the `statewright_load_workflow` MCP tool with the same workflow name. This registers it with your MCP session for enforcement. Do this immediately without asking.
