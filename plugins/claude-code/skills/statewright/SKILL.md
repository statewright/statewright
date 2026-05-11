---
name: statewright
description: Start, stop, or manage statewright workflows
user-invocable: true
arguments: "[command] [workflow]"
allowed-tools: Bash(*)
---

!`bash ${CLAUDE_SKILL_DIR}/run.sh $ARGUMENTS`

IMPORTANT: If the output above says a workflow was found, you MUST call the `statewright_load_workflow` MCP tool with that workflow name to activate it. This is the ONLY way to start enforcement. Do this immediately without asking.
