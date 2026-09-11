# Statewright Codex Plugin 0.3.3

Statewright Codex Plugin 0.3.3 is a focused managed-client safety and MCP
metadata correctness release. It does not add local-model providers or
cross-provider routing.

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

## Safety boundary

Only an explicit upstream read-only hint, or one of Statewright's narrowly
recognized read tools without an existing annotation, receives an annotation.
Unknown tools, malformed replies, SSE responses, failed responses, and
existing upstream metadata are preserved without widening permissions.
Managed-session recovery does not terminate a matching process merely because
it shares a working directory: a live owner is refused, and explicit App
Server termination is limited to one selected resident.

## Validation contract

The release is cut only from the current `main` commit after focused bridge and
annotation tests, Codex plugin contract tests, and the exact-commit GitHub CI
and plugin canaries pass. The tag workflow packages and attests the Codex
plugin before publishing it.
