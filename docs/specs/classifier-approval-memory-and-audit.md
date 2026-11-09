# Approval memory and nonproduction audit

Base db69cb23503b33ba4bed4fff6a92ef86bb76a5a6. Source preparation in the existing
clean Sidecar worktree. Native get_state reports no active workflow; execution
remains shelved by the user. No deployment, workflow activation or flag enablement.

## Scope and milestones

1. Durable native classifier approval memory: once,2h,4h,8h,always, explicit
   human selection, exact invocation/project/principal/environment/policy and
   captured dependency binding, expiry/revocation/restart and server telemetry.
   Every use follows a fresh gateway classifier/policy check and returns a fresh
   one-use receipt for the current native owner/run/session/state/epoch.
   Reusable grants require supported provenance; missing evidence offers once.
   Initial supported provenance is complete validated native resource bounds
   with captured manifest dependencies, or a complete declarative native web
   request. An aggregate source tag, a hash of one unanalysed script, or a
   missing child body is insufficient. Other invocations retain once until
   their executable/configuration dependency contract is implemented.
   Native workflow-transition reviews and native platform permissions remain
   independent. Workflow metadata may restrict offered approval durations.
2. Workflow metadata classifier audit mode accepted only in trusted staging/dev
   environments. Record would-block classifier decisions; preserve independent
   workflow/scope/human/native guards. Capture sanitized local simulation cases
   as unlabelled pending review, never automatically call a blocked command safe.
3. Deterministic operation-contract recovery, same frozen corpus and comparison.
   First gated-release target >=135/269 permitted auto-pass, zero observed
   forbidden/unknown admissions. Approval reuse is measured separately.

Approval memory and audit share one scoped commit because they share snapshot
and gateway identity plumbing; stream contracts remain a separate commit.
Each receives focused tests, then one integration/review pass. Risk: authorization, provenance, races and
privacy. Independent review is read-only and bounded to changed code/receipts.
Existing canonical/index/worktrees are untouched; generated plugin copies must
be synchronized through their existing generator before candidate completion.

Observed-only budget per implementation milestone:90min normal/120min contraction,
100/140 tool calls, one affected suite after focused checks,20% protected reserve
for repair/review/commit/handoff. No hosted/private inference or corpus execution.
Exact model token counters unavailable. At contraction finish the coherent slice,
retain failures and record unpassed integration/release gates.

Audit metadata cannot select an environment, unlock explicit denials, label cases,
activate a workflow or grant an independent human-review requirement. Production
and unknown environments reject audit configuration rather than silently enabling.
Rollback reverts owned source commits; stored grants are versioned and policy-bound.
