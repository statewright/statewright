---
name: statewright-native
description: Select the correct local Statewright MCP tools for workflow discovery, status, connection, transitions and recovery in Codex terminal or Desktop.
---

Use only the advertised local/native MCP server `statewright` for this
conversation. Native tools may appear as `mcp__statewright__statewright_*`,
`mcp__plugin_statewright_statewright__statewright_*`, or `statewright.statewright_*`
in the UI. These are examples of host naming, not tools to invent if absent.

Do not use `codex_apps.statewright_ai.*`, `mcp__codex_apps__statewright_*`, or the
web/marketplace Statewright connector here, including for workflow listing or
status. The web connector owns a separate session; it cannot establish this
native conversation's workflow, model routing, permissions or approvals.

If the local tool is missing, fails, or requires login, report the exact local
failure and park dependent workflow actions. Use supported local tool discovery
or recovery only; do not substitute the web connector, infer live state from
saved files, execute MCP names in a shell, or retry a denied operation elsewhere.
Login and approvals still require their normal explicit user action.

Do not start a workflow merely because this skill was selected. When workflow
work is authorized, inspect local state and follow its allowed tools and exact
transitions. List local workflows before loading an exact user- or skill-selected
name; do not guess a workflow or restart an already active run.
