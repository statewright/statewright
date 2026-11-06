# Local transition-receipt discrimination

2026-11-06. Offline synthetic diagnostic; no enforcement or deployment change.

## Decision

Do not enable either tested configuration as a transition-admission authority.
The expanded cases expose false support that the earlier eight-case diagnostic
missed. Exact identity, freshness, provenance, required-result coverage and
human approval belong in deterministic code. A model may later evaluate semantic
claims only after those checks, with a separately validated contract; this
experiment neither implements nor proves that later pipeline.

## Fixed experiment

`scripts/evaluation/transition-evidence-corpus.mjs` emits 38 new public synthetic
cases with an explicit, closed criterion and a deterministic reference outcome.
Nine are supported, four contradicted, and 25 insufficient. All labels were fixed
before inference. Inputs vary current/missing/foreign identity fields, freshness
boundaries, digest/issuer verification, failed/skipped/cancelled/running checks,
missing coverage, duplicate/conflicting receipts, irrelevant failures, and
instruction-shaped notes. Expected labels and case IDs are not in model input.

These are **not human-adjudicated real workflow examples or a statistically
representative held-out benchmark**. The fixture assumes verification booleans
are meaningful synthetic facts; a model reading them does not authenticate real
evidence. Its duplicate-receipt precedence and freshness rule are explicit test
assumptions, not claims about current production guards. Its reference function
is not a general validator for arbitrary malformed contexts.

The same transition question contract as the earlier diagnostic was independently
compared and matched. Qwen's system prompt, deterministic sampling, non-thinking
mode, 192-token output limit and 4096-token input limit were unchanged. Laya's
questions and pinned runtime were unchanged. Only supplied state/criterion cases
changed. This is a cross-case diagnostic, not an isolated ablation of every
possible input difference. No prompt or threshold tuning followed the results.

Checkpoints and runtimes:

- Qwen: `mlx-community/Qwen3.5-4B-4bit`, revision
  `0e7ffd5c629ef7719d4cbc04069232580bfa9d9c`, actual MLX GPU. Observed peak GPU
  allocation 3,099,495,194 bytes; 6 GiB advisory limit was not exceeded.
- Laya: `convaiinnovations/laya`, typed-decisions, revision
  `7b928d828b7b0e022f929d9bd2e44165aa270148`, Laya 0.3.20, actual Apple MPS.
  Complete sequences were 295–500 tokens; no truncation occurred. Vendor warned
  of a temperature normalization for choice counts 11+, while this task has
  three choices. No calibrated-confidence claim is made.

Both used previously downloaded checkpoints, offline loader configuration,
and serial local runs. No model server, global configuration, private argv,
workflow operation or ledger command was used. Offline mode is not an independent
packet-capture proof. Full receipts retain package/checkpoint/runtime-source
hashes, per-case input hashes and outputs, device, and timing. Full inputs reside
in the separately frozen corpus. Pre/post provenance
matched. Qwen finished in about 57 seconds and Laya in about 15 seconds including
verification/loading. These are observed local runs, not controlled cold-start
or production throughput benchmarks.

## Results

| Configuration | Correct labels | False supported / non-supported | Missed support / supported | p50 / p95 ms |
| --- | ---: | ---: | ---: | ---: |
| Qwen 4-bit | 15/38 | 10/29 | 1/9 | 1181 / 1386 |
| Laya typed | 21/38 | 9/29 | 4/9 | 161 / 339 |

All 38 results per model were assessed; no invalid output or truncation was
counted as a successful label. These false-support counts are **not actual
authorized transitions**. No output was consumed by the live engine.

Qwen supported receipts missing candidate, owner, run, epoch or observation time;
it also supported expired/future receipts, missing issuer verification, the
string `"true"` instead of a boolean, and duplicate passing receipts. Its four
applicable failures were correctly contradicted. Twelve insufficient cases were
instead contradicted. A note instructing it to report contradiction changed an
otherwise supported case to contradicted.

Laya supported an applicable failed required check, missing coverage, still-running
or unknown-status checks, unverified issuer, string-not-boolean verification,
duplicate receipts, and both injected success claims. Reordering otherwise
identical required checks or receipts changed a supported verdict to insufficient.
Laya's higher total accuracy here does not make it safe or the best model.

## Provenance and validation

- Corpus SHA256: `f010d1e5d04aad6e4b8156f2af5d682e7869b69d1b04e7fbf3813f767bd04040`.
- Generator SHA256: `07217cdacd2246f6fc5b73fa635a872ce1ecfea5d3e7c663eb3c0efc13b840ca`.
- Qwen receipt `qwen-transition-receipts-20261106-v1.json` SHA256:
  `576a491540f7ba83f4b41c901a7300377761b46412b973827b7d5698d1ebc81f`.
- Qwen private harness SHA256:
  `f07e2c71dc6886cd14d421a554126f8121538735705d0e7dc22aa29387b56389`.
- Laya receipt `laya-transition-receipts-20261106-v1.json` SHA256:
  `b54aa53d062a0a36e79caa13e1decf95f8ddb747e011d177281b808744c5fe93`.
- Laya harness SHA256:
  `52020769e3ceda1c5fdfcc2e5005a797478bfc26ab9629ff22d616cb57c5f41c`.

Four corpus tests plus seven existing source package/version/bundle checks
passed. Existing harness checks also passed: Qwen three, Laya four, summary four.
Independent bounded source review found no must-fix issue before inference and
explicitly limited the oracle to its fixed synthetic contract. The reviewer did
not run inference or certify product behavior. Receipts remain in the private
evaluation evidence directory; old failed/superseded receipts were preserved.

## Remaining gates

The earlier command-impact measurements remain separate, inherited evidence;
this run evaluates transition receipts only. Broader human-adjudicated command
and semantic-transition corpora, an authority-preserving approval route for
uncertain effects, and actual installed TUI/Desktop approve/deny/cancel acceptance
remain open. Package tests prove source consistency, not installed UI behavior.
This diagnostic does not clear any denial ledger entry, select a production model,
or justify threshold lowering. No new installation or staging rollout occurred.

See [prior local diagnostic](032-local-judgment-diagnostics.md) for the earlier
Laya command/transition experiment and its primary checkpoint references.
