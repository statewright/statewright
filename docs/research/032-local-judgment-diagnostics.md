# Local command and transition judgment diagnostics

Date: 2026-11-05 (runs completed 2026-11-06 UTC).
Status: measured offline diagnostics, not enabled enforcement or release acceptance.

## Decision

Do not enable either tested Laya checkpoint with this input/question contract.
Typed decisions improves some outcomes but still returns unsafe read judgments
and supports foreign/injected transition evidence. This rejects the tested
configuration, not every possible use of Laya. It does not establish a winning
alternative. Keep Rust policy, legal edges, identity/freshness and independent
human approvals authoritative. Do not lower thresholds to fit this corpus.

## Method and provenance

The Rust `local_judgment_inputs` example emits 20 public synthetic command
fixtures in two arms, plus eight transition-evidence fixtures. Nothing in the
command corpus executes. Labels are developer drafts, not independently
human-adjudicated ground truth or a held-out benchmark.

`current_shape` prefers the existing AST semantic request over the primary
request and nests it with the shared effect contract. It is **not byte-equivalent
to the deployed provider request**. `public_literal` adds synthetic literal shell
text and an explicit missing-delegation marker; it is not a complete canonical
IR or authorization to disclose private argv. Questions and labels are identical
between checkpoints. Help acquisition and retrieval remain deferred.

Both runs use Laya 0.3.20, Torch 2.9.0, Transformers 4.57.1 and Python 3.12.13
in an isolated environment on an Apple Mac16,11 with 24 GiB RAM, actual device
`mps`. No server, resident configuration, workflow or classifier mode changed.
Evaluation sets offline Hub/Transformers mode and uses pinned local safetensors;
this is process configuration/source evidence, not an independent packet capture.

Checkpoint repository `convaiinnovations/laya`, revision
`7b928d828b7b0e022f929d9bd2e44165aa270148`: English root and `typed-decisions`.
English weights SHA256
`891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c`;
typed weights SHA256
`4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e`.
Receipts include all five checkpoint/tokenizer/config hashes, package versions,
runtime source hashes, per-case input/question/output hashes and token counts.
All 48 cases in each run were complete and assessed; no silent device fallback.
Pre/post checkpoint and runtime/input/harness hashes matched.

Corpus SHA256: `7d0eac67318e310e8c342e129d56db3caa89752e8facfb89f3c03edfd4c346d0`.
Harness SHA256: `52020769e3ceda1c5fdfcc2e5005a797478bfc26ab9629ff22d616cb57c5f41c`.
English v2 receipt: `2dd965b0c43bdec0eca027cd415c82ee5adf991002fe6ac35427b9f16ce86a57`.
Typed v2 receipt: `a8facd01b33f31a092373146120676b0423c7e77794f270842e4f2e8c5ec0233`.

## Results

Binary scoring uses 0.5 only as a diagnostic comparison, not a production policy.
Scores are independent, uncalibrated judgments, not proven probabilities.
False-read below is not an actual granted execution; false support is not an
actual permitted transition. Null labels are excluded from correctness scoring,
but every requested answer must still satisfy its output contract.

| Checkpoint / input | Correct binary labels | False-read / non-read | Missed-read / read | p50 / p95 ms |
| --- | --- | --- | --- | --- |
| English / shape | 28/54 | 10/10 | 0/8 | 365 / 423 |
| English / literal | 29/54 | 8/10 | 0/8 | 439 / 481 |
| Typed / shape | 27/54 | 5/10 | 7/8 | 371 / 447 |
| Typed / literal | 32/54 | 2/10 | 5/8 | 440 / 472 |

English transition judgments were correct in 2/8 cases, with five false-supported
cases; typed was correct in 5/8, with two false-supported cases. Typed incorrectly
supported foreign-run and injected-instruction evidence, and treated skipped
required tests as contradicted rather than insufficient. Transition p50/p95:
English 84/139 ms, typed 89/239 ms. Eight cases cannot establish tail latency.

Load times were 5.17 s and 4.37 s; peak process RSS 1,894,301,696 and
2,923,200,512 bytes, respectively. RSS is not total accelerator memory.
Compilation/cache state is not controlled: these are observed repeats, not a
fair cold-start performance ranking. Both runs warned that a checkpoint
temperature for choice:11+ was clamped; this corpus does not use eleven options.
No confidence calibration claim follows.

## Review and executed checks

Independent review caught hashes captured after inference and malformed
unlabelled answers being counted as assessed. Both fixed before final v2 runs:
parse/hash one bounded byte capture before inference, record start source hashes
and invalidate drift, validate all requested answers before scoring. Re-review
found no further must-fix finding in this delta; it was source-only review.

The two earlier v1 receipts remain historical with the end-of-run provenance
limitation. Do not replace them or silently upgrade their evidence status.
Fresh Python harness regressions: 4 passed. Fresh Node summary regressions:
4 passed. Fresh gateway library: 421 passed, 3 ignored, 0 failed. The Rust
example initially failed to compile against private fields; a read-only accessor
and a redaction regression resolved it. No authority/threshold change resulted.

## Remaining evaluation and delivery gates

Independently adjudicate a larger heterogeneous, held-out static corpus before
tuning prompts. Compare a pinned larger reasoning model against these same
tasks; separate model, richer evidence and prompt effects. Include unknown
delegation, composition, injection, sensitivity, remote reads/writes and required
human approval. Measure useful abstention, false allowance/blocking under the
actual Rust decision path, output-contract failures, truncation and latency.
Current diagnostics alone cannot select the best open-weight model.

Native approval and waiting-notification acceptance on the actual installed
TUI/Desktop is separate and still outstanding. No local mock or model score
closes that gate. No denial-ledger entry was cleared by this evaluation.

## Primary sources

- [Pinned Laya model card](https://huggingface.co/convaiinnovations/laya/tree/7b928d828b7b0e022f929d9bd2e44165aa270148): checkpoint contents and supported input contracts.
- [Laya 0.3.20 package metadata](https://pypi.org/pypi/laya/0.3.20/json): exact installed distribution version.
- [Laya source](https://github.com/NandhaKishorM/laya): inspected for local loading/token handling; current main is not substituted for the installed runtime.

Published vendor benchmark claims were not used as our measured performance.
