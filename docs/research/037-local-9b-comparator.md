# Larger local judgment comparator

2026-11-06. Offline diagnostics only; no model enablement, policy change or release.

## Decision

Do not enable this tested configuration as command or transition authority.
The larger artifact fits the observed resource budget, but does not remove
command-effect errors or false support for invalid transition evidence. Keep
identity, freshness, legal edges, capability checks and human approval in code.
This does not establish the best model or rule out a different validated use.

## Fixed comparison

Tested `mlx-community/Qwen3.5-9B-4bit` at immutable revision
`8b2b98c00a6b4d291155e4890773ca8f769aee53`. Both published weight-shard hashes
were checked at preparation, and the complete eight-file checkpoint inventory
was hashed before and after inference. Upstream training-variant provenance
remains ambiguous: the pinned card names Base in metadata and non-Base in prose.
See [lineage boundary](036-local-model-lineage-boundary.md). This is an
exact-artifact comparison, not a clean parameter-count ablation.

The existing 4B harness was retained. The separate 9B harness changed only
checkpoint identity/inventory/checksums, isolated cache/receipt paths, minimum
download disk space and the lineage annotation. Both frozen public synthetic
corpora, question definitions, system prompt, temperature zero, non-thinking
mode, 192-token output limit and 4096-token input limit were unchanged. No private
argv, model server, evaluated command execution, help retrieval or prompt tuning.

Run sequence: pinned download; one-case load/output/resource canary; original
48 cases; then 38 structured-transition cases. Each inference run finished within
its five-minute observation budget. Actual MLX GPU peak was 5,703,764,954 bytes,
below the six-GiB advisory setting. This setting is not a hard prevention boundary.
Runtime/input/harness/checkpoint provenance matched before and after both runs;
no invalid JSON, output truncation or resource-invalid cases occurred. All 20
reduced-shape command cases abstained; all 20 literal command cases and 46 total
transition cases were assessed. Offline loader settings are not packet-capture
proof. These are serial observed latencies, not controlled production throughput.

## Results

Prior 4B and Laya results below are inherited exact-receipt evidence, not fresh
reruns. Labels remain synthetic developer drafts, not independently adjudicated
held-out real-world ground truth. A 0.5 binary score threshold is diagnostic only;
scores are independent, uncalibrated judgments, not measured probabilities.

| Literal command configuration | Correct labels | False read / non-read | Missed read / read | p50 / p95 ms |
| --- | ---: | ---: | ---: | ---: |
| Prior 4B | 47/54 | 2/10 | 2/8 | 2035 / 2283 |
| New 9B | 46/54 | 1/10 | 3/8 | 2912 / 3140 |

Both configurations abstained on all 20 reduced-shape command inputs. These inputs
are not byte-equivalent to a deployed provider request. Literal text alone is not
complete delegated-code, environment or authority evidence.

The 9B result marked conditional deletion as read-only at exactly 0.5, while also
assigning write/destructive scores of 0.5. That is a false-read label under this
diagnostic, **not an actual Rust authorization or false execution allowance**.
It under-scored local mutation for deletion, process termination and compositions,
and missed read-only labels for diff/quoted data/instruction-shaped data. An opaque
tool received a 0.9 read score despite missing implementation evidence; that case
has null ground-truth labels and is excluded from the 54-label metric, not counted
as correct. No ledger entry is cleared by these results.

| Transition configuration | Original 8 correct | Structured 38 correct | False supported / 29 non-supported | Missed support / 9 supported | Structured p50 / p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Prior 4B | 6/8 | 15/38 | 10/29 | 1/9 | 1181 / 1386 |
| Prior Laya typed | 5/8 | 21/38 | 9/29 | 4/9 | 161 / 339 |
| New 9B | 8/8 | 17/38 | 7/29 | 1/9 | 1717 / 2408 |

The new configuration falsely supported missing owner/run/epoch/time, expired
and future receipts, and string-not-boolean verification. It also changed a
supported result to contradicted in the injected-denial case. Thirteen other
insufficient cases became contradicted. None of these outputs entered a live
workflow. The eight-case pass would have hidden material failures without the
expanded diagnostic. The structured test's closed reference contract and its
synthetic verification flags are not authentication of real receipts.

## Receipt identities

- Original corpus: `7d0eac67318e310e8c342e129d56db3caa89752e8facfb89f3c03edfd4c346d0`.
- Structured corpus: `f010d1e5d04aad6e4b8156f2af5d682e7869b69d1b04e7fbf3813f767bd04040`.
- 9B harness: `ff52c07de3be90223435dd1087a50d25946ee215879edfd6c4e537ca4105277f`.
- Checkpoint manifest: `89caa8036f666008eafb5caf2665292ddb9f71dacd968cb4a6e4e6be129745d6`.
- Canary receipt: `7a517a440a26a449f2224b3e0cbcf3e7e217224d5a933adde21e00ea9c190f88`.
- Original result: `2a51ecfef55faf0ba9fe72a4b7b8312115685193fed00a25cbcf5ca403e1f94b`.
- Structured result: `9cd1bd2845f49a41fa8b2ee74861896e55c1ce3aa4453408a1ccd85e4c86e6c5`.

Full private receipts retain per-case inputs/messages/token hashes, outputs,
runtime packages/source hashes, device and timing. Previous failed/superseded
receipts remain intact. Three harness contract tests passed before the download;
the canary and both complete runs passed resource/provenance/output-validity
checks, not semantic acceptance. The public note contains no local credentials,
owner identifiers or private command arguments.

## Remaining work

Do not tune thresholds against these examples or install a model based on total
accuracy. Human-adjudicated heterogeneous held-out cases and a narrower semantic
contract, downstream of deterministic evidence checks, remain required. Preserve
abstention and the separate explicit human-effect-review contract. Installed native
approval dialogs/waiting notifications and Desktop acceptance remain separate,
unfinished gates; this diagnostic does not address the current plan entitlement
boundary. No native package reinstall or staging rollout is needed for this note.
