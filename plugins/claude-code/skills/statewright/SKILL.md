---
name: statewright-workflows
description: Start, stop, or manage Statewright workflows through the native workspace tools.
user-invocable: false
---

Use the installed native Statewright tools, not shell scripts or another MCP
connection. The user can open the Arbiter with `/statewright`.

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
