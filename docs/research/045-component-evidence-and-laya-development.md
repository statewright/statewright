# Component evidence and local Laya development result

Date:2026-11-08 local /2026-11-09 UTC. Implements a preparation slice of
[the effect-contract spec](../specs/command-effect-classifier.md), not its final
policy integration or acceptance. No workflow was executed, corpus invocation
executed, provider enabled, threshold changed, package installed or deployed.

## Implemented evidence preparation

The same native Bash AST now captures invocation spans, executable, ordered
arguments, assignments, context ancestors and explicit completeness/loss. Empty
quoted arguments survive. Expansion, brace forms, assignment tilde and bounded
argument truncation cannot manufacture literal argv. Double-quote backslash
handling follows Bash semantics in both existing tokenizers.

Literal values and unsalted command hashes are excluded from ordinary serde,
Debug and semantic-provider metadata. The local corpus helper explicitly emits
values only from reviewed offline inputs; no live provider uses that projection.
Provider requests now carry the existing redacted execution structure and a
compact effect summary. Intent fingerprints retain their previous equivalence.
Effect facts still come from the strict leaf adapter: unknown behavior stays
unknown. The old six-score resolver and independent authority gates are intact.

## Source validation

- Final full affected library:503 passed,0 failed,8 ignored.
  `/Volumes/sidecar/build-tmp/statewright-component-evidence-tests-20261109-v4.log`,
  SHA256 `82c609c0067df289601ea023c01ecd4e67ddcf9328ada7b1bd93260207f85a55`.
- Initial v1 full run:500 passed,1 failed,8 ignored. The intent-fingerprint
  equivalence regression identified serialized command-specific metadata. The
  metadata was removed from request serialization; the assertion was not relaxed.
  Its failed log remains beside subsequent runs.
- Independent source review caught raw hash disclosure and false literal brace/
  tilde evidence; both were repaired and covered. Review inspected source, not
  an independent execution of the suite.
- Fresh public/private source replays remain96/115 and98/154 unnecessary holds:
  **194/269=72.1%**. No forbidden or unknown admission in this source projection.
  This remains the baseline, not an improvement or a production rejection rate.

## Public-only component-model experiment

Frozen public input SHA256:
`11dd5e43e5d4211dd42b6081807f977498ab31568bdd634803b79f2ead09cd58`.
134 parent commands,180 missing-command-component tasks in two90-task batches.
Parent labels stay outside model state. All180 assessed without reported token
truncation on local MPS. No private corpus was sent to a model in this experiment.

Pinned Laya typed-decisions revision:
`7b928d828b7b0e022f929d9bd2e44165aa270148`, package0.3.20.
Weights SHA256:
`4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e`.
The unchanged local harness verified input/runtime/loaded-checkpoint provenance.
Four questions ask resource Read, Write, Destroy and missing decisive evidence.
Full captured literal arguments and fixture context are supplied per component.
No help acquisition or unknown binary execution occurred.

| Output | Minimum | Maximum | Mean |
|---|---:|---:|---:|
| Read |.5424|.5723|.5550|
| Write |.5291|.5725|.5474|
| Destroy |.4395|.5055|.4669|
| Unresolved |.5282|.5654|.5458|

These outputs are not calibrated event probabilities. Weak separation cannot
be repaired by casually lowering confidence cutoffs. Parent-level development
ranking AUC:Destroy .810, unresolved .744, on parents with model tasks; these
are not independent holdout scores or sufficient admission evidence.

The conservative Read+Write development projection combines known bounds and
the sum of model Destroy/unresolved scores (union bound, not independence).
Unsupported components and truncated results abstain. It retains all134 parents.
At every inspected compatibility cutoff .5/.75/.9/.95/.99 it admits14/115 permitted,
holds101/115 (**87.8%**), admits0/11 forbidden and0/8 unknown. This is a different
offline effect projection, not the current Rust resolver or a replacement for
its72.1% baseline. The checkpoint/input combination is **rejected for live use**.

## Review corrections and receipts

Initial scorer v1 incorrectly joined invocation indices to the larger component
vector; redirect/unsupported nodes can shift them. That summary is invalid and
retained, not overwritten. Corrected source-span binding validates each task's
unique missing leaf, preserves known destructive lower bounds and leaves other
unknown components blocked. An intermediate guarded attempt failed before output
when it assumed missing leaves had kind command; the actual kind is unresolved.
The corrected v3 report recomputes the same aggregates from unchanged predictions.
It preserves validated runtime identities and input/result byte hashes.

Six generator/scorer unit tests pass, including shifted redirect indices,
truncation, changed state, duplicate results, nonfinite outputs and known Destroy.
No model rerun was needed for these scorer corrections.

Artifacts under `/Volumes/sidecar/statewright-model-eval-20261105/`:

- `component-fact-results-public-20261109-v1-batch-1.json`:
  `f65d7ea525933e21396c3e453f36abd7539803b9531949ac9ab48e815b3c8d7f`.
- `component-fact-results-public-20261109-v1-batch-2.json`:
  `22edc145d32b3bdbfd21b224a4c441ee28eac263bd935a4134fe87b4f1d567f4`.
- `component-fact-score-public-20261109-v3.json`:
  `e9903ca391df1ad5c3e9d440c1531ffc1df868e6b6e26ed838457c9887d6c797`.

The immutable reports contain full source/input/prediction provenance. Private
fixture/replay files stay in their existing private directory, not Git.

## Next implementation gate

Finish M2 with a typed fact-receipt contract bound to exact invocation/context,
provenance/completeness and shared resource-effect bounds; compose all components
before subset matching. Do not let legacy six-score outputs bypass the structural
guard or treat redacted metadata as complete behavior evidence. Add deterministic
general grammar/delegation evidence where justified, not command-specific blanket
allowlists. Diagnose this checkpoint's compressed scores with a small independent
sanity contract before further prompt sweeps or calibration; replacement model
comparison, if needed, must use a frozen tuning set and separate heldout families.

The under10% target is **not met**. Remaining gates include independently
adjudicated family/composition holdout, sufficient destructive negatives, provider
fact validation and real native/HITL staging acceptance. Approval memory must stay
a separate prompt-burden metric. No new install/deployment is justified by this
development result.
