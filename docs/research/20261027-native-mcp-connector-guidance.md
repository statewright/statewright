# Native Statewright connector selection

## Scope and baseline

User reported a terminal agent calling `codex_apps.statewright_ai.statewright_list_workflows`
instead of the local MCP, then proposing saved-file inspection after correction.
Base: `d60ba12`, branch `staging/full-tree-source` in the existing staging source worktree.
The Codex plugin had no Statewright skill; automatic phase prompts named only
the unqualified tool, while the standalone prompt offered similarly ambiguous
workflow-list guidance. Existing native ownership checks already distinguish
local and marketplace tools; this patch does not change those checks.

The exact local `mcp__statewright__statewright_get_state` call in this session
failed with `Statewright Node response helper is unavailable`. No marketplace
fallback or workflow activation was attempted. Source work continues under
the user's existing skip-Statewright direction. No new install or restart is
included. This is a bounded guidance milestone, not another runtime repair.

## Change

- One shared native-connector guidance constant, included in every Codex
  user-prompt via the existing additive hook, executor state context, and
  automatic App Server phase handoff (shared TUI/Desktop code).
- New packaged Codex skill and an explicit connector paragraph in the existing
  Claude terminal/Desktop skill.
- Native tools must be advertised by the local `statewright` server. Naming
  examples are not permission to invent aliases. Marketplace Statewright tools
  are not a fallback, including for status/list calls.
- Missing, failing or login-required local tools require the exact failure to
  be surfaced and dependent work parked. Saved files do not prove live state.
  Login/retry/approval/policy authority is unchanged.
- Generated Codex runtime copies synchronized through the existing generator.

This is agent steering, not a hard security control or proof every model will
obey it. It does not remove or change the web connector, alter classifiers or
tool authorization, auto-start workflows, or enable new permissions.

## Executed validation

```
node --test plugins/executor/tests/native-statewright-guidance.test.mjs plugins/executor/tests/queued-human-input.test.mjs plugins/executor/tests/desktop-workflow-handoff.test.mjs plugins/codex/tests/desktop-runtime-bundle.test.mjs plugins/codex/tests/executor-bridge.test.mjs
node plugins/codex/scripts/sync-desktop-runtime.mjs --check
node --check plugins/codex/scripts/human-input-hook.mjs
node --check plugins/codex/scripts/executor-hook.mjs
git diff --check
```

56 tests: 55 passed, one opt-in native settings canary skipped, zero failures.
Package parity, syntax and whitespace passed. Tests verify dormant additive
guidance without configuration/network, active/final/custom executor contexts,
actual loopback phase-handoff prompts, native namespace guidance in both skills,
and preservation of human-input and existing executor bridge behavior.
Independent bounded read-only review found no blockers. No live model-choice
acceptance, native reload, package installation, staging deployment or publication
was performed. No build version was recut; the coordinated future package must
receive its own immutable identity before installation.

## Preservation and follow-through

Pre-existing Claude edits remain untouched: `hooks/connect.js`,
`hooks/native-execution.mjs`, `hooks/classifier-rework-gate.mjs`,
`scripts/sync-runtime.mjs`, `tests/native-connection.test.mjs`, and
`tests/native-execution.test.mjs`. Only the previously clean Claude skill is
part of this patch. No global user skill was changed.

Rollback is a scoped revert of this guidance-only commit, not removal of local
credentials, origins, caches or hooks. Next delivery gate: include the changed
source and generated files in the coordinated plugin release; follow normal
native hook review/reload and verify the agent selects the advertised local MCP
when both connectors are exposed. Local-tool failure must remain a reported
failure, never be counted as successful web-connector substitution.
