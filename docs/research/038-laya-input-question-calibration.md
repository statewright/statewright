# Laya input and question calibration diagnostic

2026-11-08. Offline source/evaluation milestone, not model enablement.

## Measured outcome

The tested typed checkpoint is not useful as an authorization fallthrough under
the existing six-axis score policy. All seven tested input/question combinations
produced **zero read candidates** at that policy. Do not solve this by lowering
thresholds on this same small corpus.

There is a discriminating improvement worth following: read-score ordering
improved with contrastive questions and public literal evidence. That is not
probability calibration or measured production safety.

| Input/question arm | Assessed | Read ranking AUC | Raw missed reads / 10 | Read candidates | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current actual provider state / existing Noul | 24 | 0.489 | 10 | 0 | 1056 |
| Compact structure / existing Noul | 24 | 0.456 | 10 | 0 | 373 |
| Compact structure / contrastive Noul | 24 | 0.856 | 10 | 0 | 396 |
| Compact structure / five-way Choice | 24 | 0.833 | 10 | 0 | 245 |
| Compact + public literal / existing Noul | 24 | 0.889 | 8 | 0 | 401 |
| Compact + public literal / contrastive Noul | 24 | 0.911 | 9 | 0 | 419 |
| Compact + public literal / five-way Choice | 24 | 0.789 | 8 | 0 | 152 |

Each arm contains the same 24 cases: ten developer-labeled reads, nine non-reads,
five unknowns. Raw Noul read comparison uses 0.5 for diagnostics only; Choice uses
its winning class. Candidate Noul policy reproduces the existing read score
bounds (.9/.1/.05); Choice .9 and margin .2 is a diagnostic comparator, not a
production contract. No raw false-read occurred on the nine labeled non-reads
in these runs, but zero-candidate abstention is not useful safety coverage.
Unknown cases abstained under these candidate policies. No input truncated.
Ranking AUC excludes unknown labels and compares 90 read/non-read pairs per arm.
It is sensitive to this tiny, nonrepresentative fixture set.

## What changed and what did not

The production provider-state builder was extracted unchanged into one pure
function, exposed through a diagnostic accessor. The first baseline therefore
uses actual provider state rather than the older diagnostic's approximate shape.
The compact experiment includes current execution structure and local evidence,
but local shell evidence still omits literal operands and calls even some known
reads `complete:false`. The actual provider projection also lacks the newer
execution_structure field. Those are observed evidence-loss/contract boundaries,
not proof that an instruction change alone can fix the model.

The second experiment adds only public synthetic invocation text to the three
compact arms. It does not repeat the unchanged provider baseline. All command
strings are static data; none executes. There are no private argv, credential
lookups, hosted calls, downloads, servers, workflows or mode/threshold changes.
No new input format or question profile was installed into enforcement.

Questions were frozen before each run. The second run is a targeted followup
after observing missing operands, not an independent held-out evaluation. Profile
selection and hashes travel in each row. Ground-truth labels remain developer
drafts, **not human-adjudicated**. Expected labels, IDs and heuristic risk labels
are not in model state. The compact structure does contain the existing parser's
effect labels: this measures evidence-assisted judgments, not pure model skill.

Review identified that redirect and Python write_text can overwrite existing
files. Their original draft five-way labels `local_change` conflict with the
Choice definition of destruction. The original corpus/receipts are preserved;
future generator output corrects those labels to `destructive`. Reported metrics
only compare read versus non-read, unchanged by that correction. No exact
five-way effect-class accuracy claim is made.

## Runtime and evidence identity

Existing checkpoint `convaiinnovations/laya`, typed-decisions, revision
7b928d828b7b0e022f929d9bd2e44165aa270148; weights
4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e.
Existing isolated Laya0.3.20 environment, actual MPS. Both runs validate checkpoint,
input, harness and runtime pre/post hashes; provenance_unchanged=true. Offline
loader configuration is not a packet-capture claim. The vendor warning about a
clamped temperature bucket for eleven-or-more choices does not describe the
five-way/two-way questions used here; no confidence-calibration claim follows.

Receipts live under the existing Sidecar evaluation root:

- calibration-inputs-20261108-v1.json:
  2d3eddc62597188949b996094fc6ee6ee4b6bb6aa2d1ffce763913d2d7f58adb
- calibration-inputs-literal-20261108-v1.json:
  c585d802d95c46bf2d1f395deb719218e704261f72895b9ef1a99c49bc84c789
- calibration-typed-20261108-v1.json:
  911ccd18b6d32637dfaf0118a969efdd2c5ab94ee86a33042e8e837de8b9d667
- calibration-typed-literal-20261108-v1.json:
  e50bd9e51ba6b4568473284a02c0d0e6bd6e27687964ac2147b3e5b4faf4edc5

These hashes were independently computed this turn, not merely read from prior
receipts. Summaries v1/v2 remain separate artifacts; v1's empty-candidate groups
are numerically unaffected by the later metric naming/risk-bucket correction.

## Next calibration gate

1. Supply privacy-bounded, complete local invocation evidence with explicit
   provenance and loss markers; do not call missing semantics missing syntax.
   Preserve unresolved delegation and all composition/context boundaries.
2. Independently review/adjudicate effect, location, sensitivity and authority
   labels, including real heuristic-unresolved shapes. Freeze distinct tuning
   and held-out groups by command family/composition, not random near-duplicates.
3. Fit each score axis on the tuning partition only. Evaluate reliability,
   false allowance/denial, unknown abstention, useful incremental coverage under
   the actual Rust guards, truncation and latency on held-out cases. Keep a
   genuinely unreviewed test partition; these 24 explored cases are development
   data. No post-hoc threshold selection on them qualifies a release.
4. Bind any resulting calibration artifact to exact checkpoint/tokenizer/runtime,
   question/input contracts and corpus/policy digests. Drift invalidates it.
   Preserve native human fallback for missing provenance and uncertainty.

Transition-evidence calibration remains a distinct task after deterministic
legal-edge, ownership, freshness and proof checks. No command result here
qualifies transition admission. Reusable approval durations are also unfinished.

## Validation and rollback

Focused harness and summary tests, affected gateway suite, and independent
non-editing review accompany this source milestone. Review corrected a summary
bucket that called Moderate/External unresolved effects known risk. Native
approval UI, installed-runtime model delivery and staging acceptance are not
tested here. No data migration or live setting needs rollback; revert the scoped
source milestone if required and retain failed/diagnostic receipts.
