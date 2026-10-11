# ADR 014: Authoritative System One fallthrough for opaque tool effects

## Status

Accepted for bounded implementation on 2026-09-27.

## Context

`denylist_heuristic_v1` is intended to admit operations by effect while preserving explicit denials. The Codex hook instead classifies shell text with a growing local pattern list and rejects every `opaque` result. The gateway's semantic-risk pipeline exists, but is explicitly shadow-only: it can raise a deterministic risk floor for telemetry and cannot authorize a novel safe operation. Its remote request also omitted the executable and subcommand, so it lacked enough evidence to distinguish operations such as `tmux capture-pane` and `tmux send-keys`.

This produced command-specific exceptions and repeated policy denials. It also split policy between standalone hooks and executor-owned gateway enforcement.

## Decision

Known destructive, irreversible, and external effects remain deterministic denials. Known local writes remain subject to the state's explicit `Write` denial. A deterministically opaque operation falls through to a typed System One assessment.

The assessment returns independent probabilities for read-only, may-write, reversible, destructive, irreversible, and external/account effects. Code, not the model, resolves the effect and then applies the state's capability policy:

- read-only may be admitted only at probability at least 0.90 when write probability is at most 0.10 and destructive, irreversible, and external probabilities are each at most 0.05;
- reversible local write may be admitted only at write probability at least 0.90, reversibility at least 0.80, and destructive, irreversible, and external probabilities each at most 0.05;
- disagreement, ambiguity, provider failure, timeout, malformed output, disabled evaluation, or missing structural evidence denies the operation;
- semantic inference never lowers a known high or critical deterministic classification.
- command runners whose omitted payload controls the effect (package/task runners, container or Kubernetes commands, and tmux session/input launchers) are structurally insufficient and remain denied.

Effect resolution is not itself permission. A resolved local write must still pass the state's explicit `Write` policy; a resolved read must pass any explicit read denial. Semantic escalation of an otherwise deterministic read is authoritative.

Remote evaluation receives a bounded command shape: executable, a proven first operation word for a small known command family, and whether the command delegates an omitted effect. It never receives command text, flags, operands, paths, queries, payloads, option values, or credentials. A local open-weight evaluator may use richer inputs behind the same typed contract, but it must emit the same probability vector and is subject to the same code-owned thresholds.

The authoritative path is enabled explicitly with `STATEWRIGHT_SYSTEM_ONE_FALLTHROUGH=true`. `STATEWRIGHT_SEMANTIC_RISK_PROVIDER_KIND=typesafe_system_one` uses the TypeSafe System One endpoint and `jev-latest` by default, with credentials supplied through `TYPESAFE_API_KEY` or the provider-specific token variable. `openai_compatible` keeps the same typed contract for a local/open-weight endpoint and never inherits a TypeSafe credential. The older staging shadow flag always remains telemetry-only; authorization additionally requires explicit fallthrough enablement and a workflow selecting `denylist_heuristic_v1`. The legacy policy value remains accepted as a deprecated input alias during migration.

Standalone hooks and executor-owned adapters must consume the same gateway decision contract. Shell-specific pattern additions are not an accepted repair for opaque operations.

## Alternatives rejected

- Expanding the shell `grep` allowlist: it cannot generalize and repeats the failure on every new safe command.
- Letting the model directly return allow/deny: it hides uncertainty and moves policy out of code.
- Sending raw commands to a hosted evaluator: command operands may contain secrets or proprietary data.
- Allowing opaque operations when the assessor is unavailable: this converts an optional service failure into a privilege expansion.

## Consequences

The semantic provider becomes availability-sensitive only for otherwise opaque operations. Known read, write, external, and destructive paths remain deterministic. Thresholds require calibration against representative commands before production enablement. False negatives remain safe but may require approval; false positives are constrained by high thresholds and independent risk dimensions.

## Rollout and rollback

Roll out behind the explicit denylist/heuristic policy mode. First validate the typed decision and redaction contract, then wire gateway enforcement, then replace standalone opaque denial with gateway delegation. Reinstall the plugin and managed launcher from one clean committed SHA before a live canary.

Rollback by disabling semantic authorization and returning opaque operations to fail-closed denial. Do not restore command-specific exceptions.

## Deferred workflow control pin (2026-10-08)

The process-wide environment switch is temporary rollout control, not the
intended long-term authoring surface. A follow-on design should add a workflow
metadata setting that enables or disables authoritative System One fallthrough,
with an explicit narrower override where workflow policy already supports
scoped metadata. The eventual compatibility default is expected to be enabled,
but that default must not change until native human fallthrough has packaged
Desktop acceptance evidence. This pin does not add schema, change defaults, or
alter `classifier_policy.risk_tolerance`; risk tolerance selects what may be
assessed, while the deferred setting controls whether the semantic provider is
authoritative at all.
