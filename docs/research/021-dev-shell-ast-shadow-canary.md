# Dev shell-AST shadow canary receipt

Date: 2026-09-27. Source: `f6c4c4bf9141a195c9a85752b398c36d3ef80f34`.
Scope: authenticated live canary against the development gateway only. No
staging or production promotion, authorization-mode change, or persistent
credential was performed.

## Deployment identity

The `statewright-development` deployment ran the exact image
`registry.casa.enhasa.cloud/statewright-gateway@sha256:60955824235ed6209862f42f5ee1f830af8fe63ef976dd4606e424e08c4c3673`
with `STATEWRIGHT_SHELL_AST_SHADOW=true` and `RUST_LOG=info`. Its rollout was
ready at `1/1`, and its health endpoint returned HTTP 200.

The staging namespace remained on its prior b786 image
`sha256:037c51c34f51a83968a3512646b0d0dd4da0c68629850b42a5bfbd09b711d97d`
without the AST shadow flag. Production was not addressed.

Before the live canary, `cargo test --workspace` completed successfully in the
feature worktree: the gateway suite reported 301 passing and one ignored test.
This is directly executed evidence for this milestone, not an inherited test
claim.

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
mode in development. The live `RUST_LOG=info` development setting must also be
codified in the development deployment overlay rather than relying on this
runtime adjustment. Staging remains unchanged until those gates pass.
