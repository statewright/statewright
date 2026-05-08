---
name: statewright
description: Start, stop, or manage statewright workflows
user-invocable: true
arguments: "[command] [workflow]"
---

Statewright workflow management. Parse the arguments to determine the action:

- `/statewright list` — Call `statewright_list_workflows()` MCP tool and show available workflows
- `/statewright <workflow-name>` — Call `statewright_start(workflow='<workflow-name>')` MCP tool to activate that workflow
- `/statewright stop` — Call `statewright_stop()` MCP tool to deactivate the current workflow
- `/statewright status` — Call `statewright_get_state()` MCP tool and show current state, allowed tools, and available transitions
- `/statewright` (no args) — Call `statewright_list_workflows()` and show available workflows with a prompt to pick one

After calling the MCP tool, briefly summarize the result. Do not ask for confirmation — execute immediately.
