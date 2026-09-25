# Statewright Codex Plugin 0.3.3

Statewright Codex Plugin 0.3.3 adds an experimental, opt-in ChatGPT Desktop
routing broker on macOS alongside managed-client safety and MCP metadata
correctness improvements. It does not patch or redistribute ChatGPT.app.

## What changed

- Statewright now preserves conservative read-only annotations on native MCP
  tool definitions as they cross the managed-client bridge.
- Native clients can therefore distinguish safe read operations from mutation
  operations when applying their approval policy.
- A resumed Codex thread now has an exclusive live-supervisor lease. A second
  launch of that exact thread is refused before it can replace the active
  resident's root-thread registration.
- Different resumed threads remain independent even when launched from the
  same checkout.
- `--kill-app-server` now identifies the attached thread and client, accepts
  `--thread-id` or `--client-id` for an explicit target, and rejects bulk
  `--all` termination.
- Opening a plugin-enabled chat once can provision **ChatGPT + Statewright** in
  the user's Applications folder. That launcher starts an isolated Desktop
  process tree whose first turn waits for native Statewright-tool registration,
  preventing a fast prompt from racing MCP startup.
- The standard launcher is bound to the production gateway and the user's
  `~/.statewright/api_key`; ordinary ChatGPT launches remain unchanged. A
  separate staging launcher is developer-only and is not created by normal
  plugin installation.

## Safety boundary

Only an explicit upstream read-only hint, or one of Statewright's narrowly
recognized read tools without an existing annotation, receives an annotation.
Unknown tools, malformed replies, SSE responses, failed responses, and
existing upstream metadata are preserved without widening permissions.
Managed-session recovery does not terminate a matching process merely because
it shares a working directory: a live owner is refused, and explicit App
Server termination is limited to one selected resident.

The Desktop broker reserves one registered Desktop thread at a time. It is
experimental: it does not support arbitrary Desktop chats or attest generated
answer correctness.

## Validation contract

The release is cut only from the current `main` commit after focused bridge,
annotation, Desktop-setup, and Codex plugin contract tests; the Desktop runtime
bundle must also be synchronized. Exact-commit GitHub CI and plugin canaries
then gate the tagged artifact. The tag workflow packages and attests the Codex
plugin before publishing it; preparing a local release commit does not publish,
push, or tag anything.
