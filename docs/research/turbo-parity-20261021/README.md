# Turbo V2 parity and unavailable-provider diagnostic — 2026-10-21

## Scope and ownership

Ben requested: "edit turbo to match v2 sans anthropic", then "and we can test a better error message".
Base: `97e1d7d516b6fb8e6d5220822934f8289f5bcb42`, initially clean
`release/codex-0.3.4-prep` checkout. Canonical unrelated edits were not touched.
Used the local `mcp__statewright__` connector, not a cloud connector. This
session reported no active workflow before and after. No workflow was activated,
following the existing skip-orchestration direction during routing repair.
The agentic-engineering/SDLC/usage skills supplied comparison, bounded scope,
source parity, regression and independent-review checks; no workflow-execution
claim is made. Scope excludes provider activation, classifier/policy changes,
pane input, native trust, installation, restart and production deployment.

## Stored workflow change

Fetched both complete stored definitions. `baseline-v2.json` is the exact V2
definition; `previous-turbo.json` is the rollback definition. Rechecked Turbo's
preimage immediately before overwrite. The supported native create/overwrite
operation succeeded and a separate get/readback exactly matched the candidate.

`workflows/agentic-engineering-v2-turbo.json` matches the captured V2 except:

- ID and context profile identify Turbo.
- Speed policy states priority for actionable Codex states.
- All actionable states use priority (four inherited default-tier values change).

All 18 states, 17 guards, capabilities, design/commit/no-change contracts and
bounded loops match V2. No executable Anthropic state remains. Frontier approval
targets record; Anthropic appears only as explicitly deferred historical metadata.
No fabricated review pass is recorded. Normal/retry/no-change/blocked graph paths
are statically tested; no live workflow run or loop-budget enforcement is claimed.
Turn/iteration budgets remain the V2 values and observed-only status; this change
does not invent new limits or pricing claims.

SHA256:

- Candidate: `d28cfc3c83e9415a3d945cd9755515b4e673273508154154731fed837820eccb`
- V2 snapshot: `2942913aebd6bebef38688239e7f0abdbd477ad08969af65201b012afff08ef5`
- Prior Turbo: `84c60b95de97163a9cfe119149c75f4206a6eb449145d4cb22516537012d1a3b`

## Error presentation change

The proxy annotates only the exact native missing-provider configuration error
whose provider equals the attempted provider. It supplies workflow/state/model,
explains that the model picker cannot override an explicit workflow route,
warns the workflow may already have advanced, and names supported recovery.
No route selection, interruption timing, approval, restoration or fallback
behavior changes. This is not the broader provider-capability preflight repair.

Both automatic handoff warning and next user-turn rejection use the same
diagnostic. Provider-auth failures, timeouts and another provider's missing
configuration retain their own error. Tests verify no extra routed turn,
no injected fallback, restoration attempt, and a usable native control connection.
Generated package source was synchronized with the existing generator; only the
route-proxy generated module changed. No package version was cut or installed.

- Executor proxy SHA256: `4dcd86ee2d91506e7d94da6b33d71fd0cb3b80b118fc91146ff171af70679b66`
- Generated proxy SHA256: `a01632271cddd46237db5a4c374c52c94bef903c9eb3fdfca83a7e44e15993a5`
  (The generator rewrites the WebSocket import; byte hashes therefore differ.)

## Executed validation

- Red focused handoff tests: 2 failures, exact old message lacked the diagnostic.
- Same two tests after implementation: 2 passes.
- `node --test plugins/executor/tests/desktop-workflow-handoff.test.mjs plugins/executor/tests/codex-app-server-transport.test.mjs plugins/executor/tests/app-server-handoff.test.mjs plugins/executor/tests/app-server-handoff-proxy.test.mjs`: 146 passed, 0 failed, 1 skipped.
- `node --test plugins/executor/tests/turbo-workflow-parity.test.mjs plugins/codex/tests/desktop-runtime-bundle.test.mjs`: 4 passed.
- Runtime sync check initially identified only the expected proxy drift;
  after generation, `node plugins/codex/scripts/sync-desktop-runtime.mjs --check` passed.
- `git diff --check`: passed.
- Strict workflow hygiene lint: both baseline V2 and new Turbo have 0 errors and
  the same 1 warning: localize has a context budget without a stated threshold
  action. Strict exit is nonzero; preserved as an inherited warning, not a pass.
- Native server accepted and stored the workflow; exact readback passed.
- Independent read-only reviewer `/root/rust_classifier_review`: no actionable
  findings on the bounded workflow/proxy/test change; static review only.

## Remaining boundary / rollback

The opt-in real native settings canary was not run. Protocol fixtures do not prove
the new warning renders in an installed TUI. Pane 6 was not restarted, resumed or
given new input; adoption by its existing run remains unverified. An updated
stored workflow is not proof an in-flight run has adopted that definition.

The normal reviewed plugin release/install/reload path is required to deliver
the new error text. No live installation is included in this task. Roll back a
workflow only by first verifying its current definition still equals this
candidate, then using the supported native overwrite with previous-turbo.json;
that restores the known unavailable Anthropic route and is not recommended
without restoring its provider. Source rollback is a scoped revert of this
change, not a reset of unrelated work or an edit to installed cache bytes.
