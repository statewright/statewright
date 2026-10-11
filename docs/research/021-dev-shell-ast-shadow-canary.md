# Dev shell-AST shadow canary receipt

> Public excerpt sanitized 2026-10-10; operational details omitted or generalized.
> Historical results below were not rerun for this documentation cleanup.

Date: 2026-09-27. Source: `f6c4c4bf9141a195c9a85752b398c36d3ef80f34`.
Scope: authenticated live canary against the development gateway only. No
staging or production promotion, authorization-mode change, or persistent
credential was performed.

## Historical validation scope

The development gateway ran with `STATEWRIGHT_SHELL_AST_SHADOW=true`.
Private image digests, rollout topology and environment operations are omitted.
The recorded workspace test run reported 301 gateway tests passing and one
ignored. These are historical results, not checks rerun for this cleanup.

## Authenticated canary

A disposable development user was created through PocketBase's public signup
flow. Its API key was minted through the supported `POST /api/keys/generate`
route, used only for the canary, and then revoked. The canary loaded the
`bugfix` workflow over the real streamable MCP endpoint and invoked
`statewright_adapter_pre_tool` for four representative `exec_command` inputs.

| Case | Authoritative legacy result | AST shadow result | Structural evidence |
| --- | --- | --- | --- |
| Compound safe read using `if`, `tmux capture-pane`, and `tail` | deny; Moderate/Unknown | Low/Local | parsed; 3 executable nodes; disagreement; AST less strict |
| Command substitution containing `git push` | deny; Moderate/Unknown | High/External | parsed; 3 executable nodes; disagreement; AST stricter |
| Quoted shell heredoc consumed by `bash` and containing `git push` | deny; Moderate/Unknown | High/External | parsed; 2 executable nodes; 1 shell heredoc; disagreement; AST stricter |
| Data heredoc redirected by `cat` whose body mentions `git push` | deny; Moderate/Local | Moderate/Local | parsed; 1 executable node; agreement |

The logs also recorded a distinct System One semantic assessment for each AST
shadow comparison. The consumer-aware data-heredoc result is important: text
that merely resembles a mutating command was not promoted to an executable
node, while executable content passed to a shell was analyzed.

Because the feature is shadow-only, the safe compound read was still denied by
the legacy path. This canary therefore validates classification telemetry; it
does not claim that the user-visible denial has been repaired yet.

## Cleanup and next gate

Cleanup used supported PocketBase interfaces. Dependent canary workflow runs,
workflows, and consents were removed before deleting the disposable users. A
temporary PocketBase superuser used for the cleanup was deleted afterward.
Read-only database verification returned zero witness users, zero witness API
keys, and zero cleanup superusers. No raw credential is retained in this
receipt or the repository.

Before making AST classification authoritative, expand the canary into a
representative denial corpus, compare false-allow and false-deny behavior,
independently review the authority/fallback rules, and prove the controlled
mode in development. Staging remains unchanged until those gates pass.
