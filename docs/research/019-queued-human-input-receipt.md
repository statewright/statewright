# Queued human input source receipt

> Public excerpt sanitized 2026-10-10; operational details omitted or generalized.
> Historical results below were not rerun for this documentation cleanup.

Date: 2026-09-27. Repository: Statewright.
Worktree: `.agent-worktrees/queued-human-input`. Branch:
`feat/queued-human-input`. Base: `138a8a5c47eb20d1e166627e9f0e1d2548aaf616`.
Statewright workflow: deliberately inactive under the user's current override.

## Accepted cut line

Codify non-blocking human questions in the shared Codex App Server shim used by
Desktop and TUI. Native cards and replies remain authoritative. The policy hook
asks agents to park only dependent work, continue authorized independent work,
and never infer an answer or approval. Preserve all existing approval gates.
Document, but do not enable, a future authenticated chat/SMS projection.

Excluded: outbound messages, remote reply ingestion, production publication,
workflow activation, restarting active sessions, and claims about native visual
rendering or timer persistence. Installation and fresh-session acceptance are a
separate authorized rollout boundary.

## Implementation evidence

- `plugins/executor/lib/queued-human-input.mjs`: shared additive policy and
  explicit non-blocking request normalization. Only `isBlocking === false`
  requests have the nullable legacy `autoResolutionMs` set to null.
- `plugins/executor/lib/codex-app-server-route-proxy.mjs`: shared proxy applies
  normalization and now distinguishes server requests from client responses.
  Typed correlation keys keep numeric and string JSON-RPC IDs distinct.
- `plugins/codex/scripts/sync-desktop-runtime.mjs` generated the packaged
  Desktop copies; drift check passed.
- `plugins/codex/hooks/hooks.json` adds a standalone `UserPromptSubmit` context
  hook while retaining the enforcement hook. It requires no gateway, API key,
  active workflow or filesystem lookup.
- ADR 016 records authority, privacy, lifecycle, remote projection and rollback.

## Preserved failed evidence

The first focused run failed because the implementation module did not yet
exist; this was the expected red baseline. Independent review then reproduced a
P1 protocol bug: an ID-bearing App Server question could consume an outstanding
client request's bookkeeping. It also identified numeric `7` versus string
`"7"` map collisions. The repair accepts only id-plus-result/error messages as
responses and uses typed map keys. Four new cross-host regressions cover both
cases. Fresh independent re-review found no remaining material issue.

An executor-suite attempt from `plugins/executor` was invalid because repository
fixtures resolved relative to the wrong working directory. It is not counted as
validation. The root invocation initially exposed an unavailable Pi peer
dependency. `npm ci --prefix plugins/pi --ignore-scripts --no-audit --no-fund`
installed the lockfile-pinned development dependencies; no tracked files changed.

## Validation

- Focused command: `node --test plugins/executor/tests/queued-human-input.test.mjs plugins/codex/tests/desktop-runtime-bundle.test.mjs plugins/codex/tests/plugin-runtime-contract.test.mjs`
  — 12 passed, 0 failed.
- Codex package command: `node --test plugins/codex/tests/*.test.mjs` — 136
  passed, 0 failed.
- Executor command from repository root: `node --test plugins/executor/tests/*.test.mjs`
  — 587 passed, 1 failed. The one failure is
  `public-repository-scrub.test.mjs`, listing two pre-existing private-host
  strings and one pre-existing private local-model provider name. Running that single test against
  the clean base worktree at `138a8a5` produced the identical failure. Outcome:
  inherited non-pass, unrelated to this slice, not waived or described as pass.
- `node plugins/codex/scripts/sync-desktop-runtime.mjs --check` — passed.
- `git diff --check` — passed.
- Plugin Creator validator — inherited non-pass: it rejects the already tracked
  `plugin.json` `hooks` field. The identical command against the clean base
  worktree at `138a8a5` produced the same result. The runtime contract test for
  the existing manifest and hook file passed; this slice does not rewrite the
  established manifest format.
- Independent source review: original P1 withheld approval; repaired re-review
  approved with no remaining material findings. Reviewer separately noted that
  native renderer/timer behavior and installation remain unverified.

## Residual risk and next boundary

Source and local WebSocket contracts are proven. A fresh installed TUI and
Desktop session must still show an answerable non-blocking card, continue an
independent activity, accept/dismiss a reply, and emit native resolution without
releasing an approval. Active sessions must not be restarted. Roll back by
reverting this coherent commit, regenerating Desktop runtime, and reinstalling
the prior plugin revision. Remote chat/SMS projection requires a separate schema,
authenticated responder and exact request/scope correlation milestone.
