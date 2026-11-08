# Read / Write / Destroy simulation

2026-11-08. Offline development experiment; no command execution or enforcement change.

## Result and design consequence

The shared permission-set contract is straightforward, but neither tested Laya
format qualifies as an authorization fallback. At the predeclared 95% diagnostic
cutoff, all four model arms contributed **zero additional allowances**. The
conservative heuristic bridge supplied the same 12 read-only admissions in each
arm. This is not a safety success: abstention without useful coverage fails the
product requirement.

Destroy discrimination was promising, but Read and Write were much weaker:

| Model question format | Read rank AUC | Write rank AUC | Destroy rank AUC | Unresolved rank AUC |
| --- | ---: | ---: | ---: | ---: |
| Three effect Noul questions plus unresolved | .435 | .643 | .936 | .546 |
| Nine-way effect-set Choice | .652 | .555 | .954 | .782 |

Effect AUC excludes the nine unknown cases; unresolved AUC includes all 80.
These are in-sample descriptive rankings over agent labels, not calibration or
held-out safety evidence. High Destroy AUC alone does not establish an acceptable
false-allow operating point, nor imply that all three axes share one calibration.

In the model-only view at the 50% diagnostic cutoff, joint Choice under Read+Write admitted 57 permitted
cases, **12 forbidden cases and 8 unresolved cases**. At 75%, an all-effects phase
admitted all 71 labeled known cases and 8 unresolved cases. At90%, the RWD hybrid
does add one permitted case beyond the heuristic (13 rather than12 admissions),
with no observed forbidden/unresolved admissions on this small set. Those limited
gains do not establish a release operating point or a safety bound; selecting a
lower cutoff on this development set would not constitute calibration. The original six
score branches kept their existing numeric thresholds throughout; their repeated
threshold-curve entries are fixed-baseline comparisons, not varying legacy cuts.

The next architecture should retain three user-visible effects, let code compose
the AST/effect bounds and apply phase permissions, and ask the model only for
missing semantic facts about individual invocations. Parser status, available
source/documents, provenance and target bindings are code-owned facts; the generic
model `unresolved` score tested here is not a replacement for those facts.
Uncertainty between two already-permitted effects should not itself require a
model call. A full allowed effect set still does not resolve a missing resource
scope or unknown execution target.

TypeSafe's [Don't Call It a Decision Model](https://typesafe.ai/blog/dont-call-it-a-decision-model)
argues for atomic model judgments composed by code. That supports treating our
nine-way Choice as a comparator rather than the preferred architecture. It does
not establish that the local Laya checkpoint implements Jev's performance or
calibration. This run evaluated local Laya only; no hosted Jev calls occurred.

## Frozen experiment

80 cases: 50 selected public NL2Bash examples across utility families and 30
authored public composition/unknown cases. Imported source is pinned to
TellinaTool/nl2bash d6b9f5bdff45621d190134e31ab63b7bf7002190; the full downloaded
command-corpus digest is
7d5c09b75093710c62dd388784371bd3bfdeed5c6f3dbf8c652251d4590567f4.
Dataset license/provenance is retained by the existing corpus importer.

Masks are None=0, Read=1, Write=2, Destroy=4; combinations use bitwise OR.
Labels: None4, Read28, Write13, Read+Write13, Destroy6, Read+Destroy4,
Write+Destroy1, all effects2, unresolved9. Labels and questions were frozen before
inference. The examples are manually agent-adjudicated development data, not
human-validated, representative, blinded or held out. Family overlap and authored
siblings must not be counted as independent evidence for a 1% escape-rate claim.

The rubric treats ordinary replacement/editing as Write, resource removal as
Destroy, and substantive observation as Read. Host-created process/log bookkeeping
is excluded. Incidental implementation-level metadata reads around a write/delete
remain an acknowledged rubric ambiguity, especially for Write-only/Destroy-only
phases. Main reported policy comparisons are R, RW and RWD, which are less
sensitive to that boundary. No scope, privilege or credential permission is
conferred; local and remote fixture targets are assumed in scope for this effect
projection. Time/resource consumption and interactive-session behavior remain
separate dimensions.

Each case was sent to the same pinned local checkpoint under four arms:

1. Actual current provider-state builder and its six questions.
2. Public literal command, current execution structure and supplied environment,
   retaining the same six questions.
3. The same rich state with separate Read, Write, Destroy and unresolved Noul questions.
4. The same rich state with one Choice over eight effect combinations plus unresolved.

Only public fixture strings and explicitly authored package-script evidence enter
the state. Expected masks, reasons, case IDs and the grader's heuristic mask do
not enter model state. Current provider input does retain its existing heuristic
hints: that is part of the baseline being measured. Help excerpts were **not** an
arm of this experiment, so this run says nothing about their incremental benefit.

## Computation and checks

For joint Choice, compatible mass is the sum of probabilities for masks contained
in the allowed mask. Unresolved is outside every allowed mask. For independent
Noul scores, a conservative union bound sums unresolved and forbidden-effect
marginals; it does not assume independence. This probability interpretation needs
calibration before being used as a real probability bound.

Both model-only and heuristic-then-model views are scored for all eight permission
masks at .50/.75/.90/.95/.99. A syntax error is held regardless of model score.
The legacy six-score comparator reproduces its numeric read/local-write branches,
projecting the write branch conservatively into RW. It omits the other Rust
authority/structural gates and cannot qualify native enforcement.

The final heuristic bridge accepts only the existing full ReadOnly decision as
an upper bound {None,Read}. It intentionally makes no completeness claim for
legacy write/destroy classes. At95%, for each arm:

| Allowed effects | Labeled permitted | Correct automatic admissions | Forbidden/unresolved admissions | Hypothetical model requests |
| --- | ---: | ---: | ---: | ---: |
| R | 32 | 12 | 0 / 0 | 67 |
| RW | 58 | 12 | 0 / 0 | 67 |
| RWD | 71 | 12 | 0 / 0 | 67 |

One malformed case is held before inference in the simulated routing; 12 cases
take the read fast path; 67 remain. Actual diagnostic inference deliberately ran
all four arms on all 80 cases for paired measurement.

All **320 requests assessed on MPS**, with zero token/option truncations and
unchanged input/harness/runtime/checkpoint provenance during each batch.

| Arm | Maximum complete tokens/question | p95 inference ms |
| --- | ---: | ---: |
| Current provider / six | 468 | 605 |
| Rich literal / six | 446 | 512 |
| Rich literal / independent effects | 464 | 428 |
| Rich literal / joint effect set | 627 | 195 |

Latency includes differing question counts and fixed request order; it is not a
controlled production throughput comparison. There were no model downloads,
private command transmission, workflow actions, resident changes or deployments.

## Review corrections and retained failures

Independent review caught the initial naive conversion of legacy risk classes
into new effects. `Destructive` includes read-only `find -exec` forms;
`FileWrite` includes `rsync --delete`; `SafeOutput` includes metadata readers.
These buckets are not reusable effect proofs. The v1 summary retained those
invalid hybrid metrics and is superseded by v2. Raw inference receipts are
unchanged: the naive projection was diagnostic metadata, never model input.
The generator retains it only to make this mistake inspectable; the reviewed
scorer ignores its mask/complete fields.

Review also required stronger bindings. The final scorer verifies the original
input-file digest, frozen source corpus, exact command/delegated source, model
state/question digests, arm/task/profile identities, expected masks, coverage and
common runtime/checkpoint identity. Regression tests reject swapped tasks,
changed questions/commands and unbound receipts. The Python runner's public-data
extension preserves exclusive receipts, bounded inputs and checkpoint validation.

Validation: Rust input generator compiled and generated all three batches;
8 effect-set scoring tests and 6 Python harness tests passed. An independent
read-only reviewer checked the repaired bindings/math and read the corrected v2
artifact. The earlier full gateway481-pass receipt predates this experiment and
is not presented as a fresh full-suite run.

## Artifacts and limits

Receipts are under `/Volumes/sidecar/statewright-model-eval-20261105`:

- effect-set-cases-20261108-v1.json
- effect-set-inputs-20261108-v1-{1,2,3}.json
- effect-set-results-20261108-v1-{1,2,3}.json
- effect-set-summary-20261108-v1.json (superseded invalid hybrid conversion)
- effect-set-summary-20261108-v2.json (reviewed conversion and input bindings)

Checkpoint: convaiinnovations/laya typed-decisions, revision
7b928d828b7b0e022f929d9bd2e44165aa270148; model weights
4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e;
Laya0.3.20, requested/actual MPS. The SDK emitted its existing choice:11+
temperature-clamp warning; this run uses nine-way Choice and binary Noul, not
that bucket. All raw scores remain uncalibrated regardless.

The evaluation used the existing preparation checkout based on db7791f, including
its previously prepared structural-redirect source changes. A separate delivery
receipt records the effective source hashes and artifact hashes; HEAD alone does
not describe that dirty source. No installation, classifier enablement, guard or
threshold change is authorized by these results. Native HITL and server telemetry
acceptance, reusable approval durations and staged delivery remain outstanding.
