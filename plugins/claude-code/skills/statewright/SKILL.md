---
name: statewright-workflows
description: Start, stop, or manage Statewright workflows through the native workspace tools.
user-invocable: false
---

Use the installed native Statewright tools, not shell scripts or another MCP
connection. The user can open the Arbiter with `/statewright`.

Select only the advertised local/native server `statewright` for this terminal
or Desktop conversation. Native tools may appear as
`mcp__statewright__statewright_*`, `mcp__plugin_statewright_statewright__statewright_*`,
or `statewright.statewright_*` in the UI; never invent an unavailable alias.
Do not use `codex_apps.statewright_ai.*`, `mcp__codex_apps__statewright_*`, or the
web/marketplace Statewright connector, even for listing or status. It is a
separate session, not this native conversation's workflow, routing or approval
owner. If local tools are missing or fail, report the exact local failure and
park dependent workflow actions. Use supported local discovery/recovery only;
do not fall back to the web connector or infer live state from saved files.

When the user requests a named workflow, call `statewright_connect` with its
exact name. It connects or restores the current conversation and starts the
requested workflow when supported. A connection-required result is not a
started workflow. Let the user finish sign-in and native approval; never answer
an approval yourself or retry a refusal through another path.

Follow the returned current state's tools and transitions. Read current state
after a transition; do not restart an active run. When the user asks to disable
Statewright, call `statewright_deactivate`. Report connection, host permission,
workflow-policy and provider errors distinctly. A requested model is not proof
of the model that answered; use the returned routing receipt when available.
