# ADR 014: Authoritative System One fallthrough for opaque tool effects

## Status

Accepted for bounded implementation on 2026-09-27.

## Context

`blacklist_heuristic_v1` was intended to admit operations by effect while preserving explicit denials. The Codex hook instead classifies shell text with a growing local pattern list and rejects every `opaque` result. The gateway's semantic-risk pipeline exists, but is explicitly shadow-only: it can raise a deterministic risk floor for telemetry and cannot authorize a novel safe operation. Its remote request also omitted the executable and subcommand, so it lacked enough evidence to distinguish operations such as `tmux capture-pane` and `tmux send-keys`.

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

Standalone hooks and executor-owned adapters must consume the same gateway decision contract. Shell-specific pattern additions are not an accepted repair for opaque operations.

## Alternatives rejected

- Expanding the shell `grep` allowlist: it cannot generalize and repeats the failure on every new safe command.
- Letting the model directly return allow/deny: it hides uncertainty and moves policy out of code.
- Sending raw commands to a hosted evaluator: command operands may contain secrets or proprietary data.
- Allowing opaque operations when the assessor is unavailable: this converts an optional service failure into a privilege expansion.

## Consequences

The semantic provider becomes availability-sensitive only for otherwise opaque operations. Known read, write, external, and destructive paths remain deterministic. Thresholds require calibration against representative commands before production enablement. False negatives remain safe but may require approval; false positives are constrained by high thresholds and independent risk dimensions.

## Rollout and rollback

Roll out behind the explicit blacklist/heuristic policy mode. First validate the typed decision and redaction contract, then wire gateway enforcement, then replace standalone opaque denial with gateway delegation. Reinstall the plugin and managed launcher from one clean committed SHA before a live canary.

Rollback by disabling semantic authorization and returning opaque operations to fail-closed denial. Do not restore command-specific exceptions.
