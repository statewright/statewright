# Confirm the native route, not the requested route

Prepared 2026-10-03, existing model-repair owner. Canonical Statewright `main`, base `85bc601e9c3f87865e9040cf450df78ec53221b0`. Repair orchestration stayed inactive. No workflow, classifier, hook, credential, security, alias, companion, or deployment change.

## Observed failure and causal reproduction

A preceding installed-client canary executed the workflow on Terra/medium,
reached its terminal state, then incorrectly retained Terra/medium for the next
ordinary turn. This is historical evidence, not live execution of this repair.

Native confirmation recorded the actual qualified provider/model/effort/tier.
The ownership store instead retained the requested bare model and a manufactured
null tier. Restoration treated that representation mismatch as a manual override
and relinquished the original route. The later manual model reset was cleanup,
not a successful automatic-restoration test.

Fresh discriminant before the fix: 15 existing cases passed; **bare-model**, **inherited-tier**, and the combined **native-canary** failed. Actual versus expected stored routes:

| Case | Actual faulty field | Expected native evidence |
|---|---|---|
| bare-model | `gpt-5.6-terra` | `openai-codex/gpt-5.6-terra` |
| inherited-tier | null | priority |
| native-canary | both mismatches | qualified Terra / medium / priority |

## Exact repair and invariants

The only runtime logic change is in the shared TUI/Desktop App Server proxy's `thread/settings/updated` confirmation handler. It now persists **actual confirmed provider/model/effort/tier**, using the existing qualification function also used at capture and restore. Absent effort/tier evidence stays absent; explicit null stays null. A missing actual provider does not confirm ownership. Store ownership rejection is propagated instead of reporting confirmation success.

No string-equality guard, manual override rule, lifecycle/finality proof, owner/thread/run/session binding, epoch, lease, or native settings-confirmation requirement was weakened. No forced Sol selection or fallback was added. The original tuple remains the captured user's tuple, not a hardcoded model.

Owned delivery paths:

- `plugins/executor/lib/codex-app-server-route-proxy.mjs`
- `plugins/executor/tests/codex-app-server-transport.test.mjs`
- generated `plugins/codex/scripts/lib/desktop-runtime/codex-app-server-route-proxy.mjs`
- `plugins/codex/.codex-plugin/plugin.json`, prepared identity `0.3.4+codex.20261003210723`

[candidate.json](candidate.json) contains all four preimage/postimage SHA256 values, binary-safe code diff SHA256 `09878cc56e23fd01c0535b55c940aa54ff4722c0a96a110941575bbb21aabe0b`, the 117 **tracked** package-input fingerprint (not a claim about ignored dependency bytes), and installed old-package hashes. Packet documentation is separate from that four-path code digest. No new worktree was created.

## Fresh validation

All cwd values below: `<statewright-checkout>`. These are local unit/WebSocket protocol/launcher fixtures, not actual native UI acceptance.

1. Red: `node --test --test-name-pattern='App Server restores the original native settings at turn end' plugins/executor/tests/codex-app-server-transport.test.mjs` — exit1, 15 passed / 3 failed, exact discriminants above.
2. Same focused command after correction — exit0, 18 passed. Tests subsequently expanded.
3. `node --test plugins/executor/tests/codex-app-server-transport.test.mjs plugins/executor/tests/workflow-route-origin.test.mjs` — exit0, 105 passed, zero failed/skipped.
4. [Affected composition command/output](affected-tests.txt) — exit0, **173 passed, zero failed/cancelled/skipped**, 14.70 seconds. Includes shared transport/origin, handoff, Desktop launcher, TUI lifecycle hooks, and generated bundle.
5. `node plugins/codex/scripts/sync-desktop-runtime.mjs` followed by `--check` — exit0. Generated source prepared only; no live install. `git diff --check` — exit0.

New coverage: independent bare-model and inherited-tier discriminants; actual inherited effort; explicit native null; the live Sol/high → bare Terra/medium/inherited priority → terminal restoration shape; same shape on deactivation; missing provider/effort/tier refusal; manual effort/tier; provider-only divergence. Existing coverage still passes for manual model changes, late overrides, compact/missing/replayed completion, failed deactivation, pause, cross-run/session/turn rejection, reconnect, partial restoration, unknown/null distinction, and preserving collaboration mode/instructions.

No full repository/executor suite claim. Earlier full-suite onboarding/scrub failures are not superseded by these focused passes. No denied command was rerun. Independent human review and fresh real TUI/Desktop acceptance remain pending; no subagent was spawned.

## Review and single delivery boundary

This is a new exact candidate; earlier candidate approvals do not authorize silently substituting these bytes. Required review: this four-path diff and prepared package, then one coordinated supported install and normal `ascodex` acceptance. No installation, restart, release, or deployment occurred in this turn. Fresh disk hashes still show installed153800 with the faulty proxy; the original QA session was preserved. No current gateway change or verification is claimed.

After approval: revalidate frozen source/package hashes, perform the normal one-shot package installation, verify installed bytes, then normal idle quit/resume through **ascodex only** in the bound QA pane. Preserve unrelated active sessions; handle any native hook trust at its actual human gate. Load the existing small workflow while QA is idle, start a genuinely new routed turn, and record native original → Terra → original settings plus a subsequent original-model turn. Repeat deactivation and manual/pause preservation as scoped; test staging Desktop with the same shared package. An in-turn workflow load or fixture receipt cannot substitute for a real routed turn.

Rollback before installation: revert only this isolated model-repair commit. After installation, use the supported version/lifecycle path; never fabricate old-cache paths or delete origin markers. The prior version has a demonstrated defect and is not a known-good acceptance target. No automatic recovery of already-relinquished old provenance is attempted; such an origin must not be invented.
