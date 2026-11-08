# Effect-set simulation: public and private-history extension

2026-11-08. Offline development evidence only. No mined command was executed;
no workflow, deployment, installation, enforcement or threshold changed.

## Data and privacy boundary

The extension adds 364 distinct manually agent-labeled commands: 134 public
examples from 67 families and 230 sanitized private-history candidates. Together
with the prior 80-case experiment there are 444 distinct command strings. These
are development labels, not independent human adjudication, a blind holdout or a
representative estimate of a 1% escape rate.

Private cases comprise 87 zsh-history entries, 53 direct Claude tool-call records
and 90 literal Codex orchestration candidates. Bash history contents were not
read. Codex `functions.exec` custom-tool/function-call records are parsed with an
existing local Acorn 8.16.0 parser; only literal `tools.exec_command` object fields
are accepted. Dynamic values, spreads and ambiguous fields are excluded. This is
static proposal extraction, **not proof of dispatch, success or authorization**.

Mining is bounded to a 1 MiB zsh history and 32 recent JSONLs per distinct root,
4 MiB tails, directory traversal limits, family caps and sanitized-string dedup.
Codex discovery hit its traversal limit; this is incomplete history coverage.
The final pool contains 596 candidates (300 zsh, 243 Codex, 53 Claude). Sensitive
context/opaque values, credentials, assignments, cookie/header/config payloads,
HTTP bodies and multiline/oversized/encoding-invalid commands are excluded before
persistence. Home/Sidecar paths, URLs and email identities are anonymized where
retained, with explicit redaction and evidence-loss markers.

Independent synthetic privacy review found cookie/header and wrapped-assignment
gaps. They were repaired before private inference; the pool was regenerated.
Four superseded scratch pools' command-bearing artifacts were removed, retaining
only aggregate manifests. Original history files were untouched. Regex exclusion
is not a general anonymization guarantee: selected sanitized cases were also
manually reviewed, and unselected candidates are not sent to a model.

Private cases/inputs/receipts remain in a local 0700 directory, with local-only
classification propagated into result summaries. Only IDs and generic label
reasons enter the source tree; no private command corpus is committed or sent to
a hosted service. Sidecar is not encrypted; these sanitized artifacts remain
private local data, not a public dataset.

## Frozen experiment

The same four question profiles and model weights from report040 are reused:
current six-question provider state; literal rich evidence with six questions;
literal rich evidence with three effect axes plus unresolved; and nine-way joint
effect-set Choice. No help retrieval or help effectiveness test was performed.

The history rubric declares command-scoped shell context, standard trusted tools,
no extra Git hooks/filters, non-sensitive fixture targets and unavailable delegated
script/alias bodies. Standalone cwd/shell-exit bookkeeping is not persistent Write
or Destroy; explicitly terminating another managed process is Destroy. Normal
content replacement is Write. Target scope/privilege/credentials remain separate.
Missing script bodies stay unresolved rather than being guessed from names.

History labels: None9, Read128, Write6, Read+Write11, Destroy9,
Write+Destroy3, all effects1, unresolved63. Public extension: None13,
Read67, Write17, Read+Write18, Destroy5, Read+Destroy4, Write+Destroy1,
all effects1, unresolved8. The public strings exclude the original 80; utility
families still overlap, so rows do not supply independent population evidence.

Local MPS only, Laya0.3.20, typed-decisions revision
`7b928d828b7b0e022f929d9bd2e44165aa270148`. Raw scores are uncalibrated. The
SDK emits its known choice11+ temperature warning; this experiment uses Noul
and Choice9, not that affected option-count bucket.

## Observed public extension

All 536 requests completed without truncation or runtime/input provenance drift.
At95%, all four arms add zero allowances beyond the13 existing heuristic reads.
Under Read+Write, 115 cases are labeled permitted, 11 forbidden, 8 unresolved;
the hybrid admits13 permitted and holds102, with no observed bad admission at
that cutoff. This is poor coverage, not release-ready safety evidence.

At50%, joint Choice under Read+Write admits115 permitted, **all11 forbidden**
and7 unresolved cases. Examples of forbidden admissions include `rm -r classes`,
`shred -u $FILE` and process-kill pipelines. Lowering the cutoff is not a repair.

| Format | Read AUC | Write AUC | Destroy AUC | Unresolved AUC | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Separate effect axes | .482 | .809 | .708 | .450 | 499 |
| Joint effect set | .615 | .606 | .787 | .469 | 227 |

The original six-question arms' p95 is641ms (current input) and624ms (rich input).
Ranking is not calibration; the prior small-set Destroy ranking did not generalize
unchanged to this new development cohort.

## Observed private-history extension

All920 planned requests completed with unchanged input/runtime/checkpoint
provenance:914 assessed and6 explicitly abstained for token truncation. By arm,
truncation counts are0 current-six,1 literal-six,1 axes and4 joint Choice. No
truncated model result was used to authorize a command; an independently complete
heuristic read can still bypass a model abstention in the offline hybrid.

At95%, all four arms add zero allowances beyond51 existing heuristic reads.
Read+Write permits154 labeled cases, forbids13 and leaves63 unknown; the hybrid
admits51 permitted and holds103 permitted. It admits no forbidden/unknown cases
at that cutoff. The heuristic upper-bound audit has zero observed errors on this
cohort; it remains an incomplete bridge, not a new typed-effect implementation.

At50%, joint Choice with Read+Write admits152 permitted, **all13 forbidden**
and all63 unresolved cases. At75/90/95%, that arm returns to the same51
heuristic admissions. The other three arms add no allowances at the tested cuts.
The six-question arms retain their existing numeric branch rules, so their
repeated threshold entries do not represent a legacy-threshold sweep.

| Format | Read AUC | Write AUC | Destroy AUC | Unresolved AUC | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Separate effect axes | .754 | .783 | .453 | .582 | 868 |
| Joint effect set | .457 | .795 | .642 | .650 | 332 |

The current/literal six-question arms' p95 is856/1189ms. AUC excludes truncated
rows and unknown truth for effect ranking; unresolved ranking uses assessed
known/unknown cases. No live command executions, historical outcomes or production
false-positive rates are inferred from these labels.

The expanded evidence reinforces the architectural direction in report040:
code-owned AST composition and effect bounds, individual missing semantic-fact
judgments, and explicit human approval for genuinely unresolved authority.
Do not turn model scores into permission decisions by lowering a global cutoff.
Long invocation/IR payloads also need bounded evidence planning; truncation must
remain an explicit abstention rather than silently manufacturing confidence.

## Artifact bindings

Public cases SHA256:
`4ac770d3cef89d8e85ca39913db49feb7a52fdd5a16572b02a09fedfd502cb2d`.
Public summary SHA256:
`0bf014f50e3056dfd065f22a5a3db181af73fa5d8dc7fd7ad8e78b3793017e2d`.
Private final candidate-pool SHA256:
`59f405ce1d6a5855e174d5166eb1cac3cc5240b2cb41944341105eb607b0f348`.
Private frozen case SHA256:
`e0568e2a842b1b80a61bf216bce3c0ce70f27756876428b5159606beb08f6970`.
Private summary SHA256:
`d9870fbe3b78c8b460d5274a0c4f6e16710110d0bede39b19d966f2b23f1831c`.

Public artifacts are under the existing Sidecar `statewright-model-eval-20261105`
root with prefix `effect-extension-public-*-20261108-v1`. Private artifacts are
under `statewright-history-corpus-20261108-v5`, case/input/result version3.
The prior report040 receipts remain unchanged. Superseded private version1-4
manifests are selection/filter diagnostics only, not model-run evidence.

## Validation and scope

Focused tests cover secret-like value exclusion, zsh multiline boundaries, both
Codex transport shapes, literal-only JS extraction without evaluation, exclusive
artifact creation, source-byte binding, private-data opt-in and retained local-only
labels. Final focused validation:17 Node tests and7 Python tests passed.
The two independent privacy-review findings were closed by read-only recheck.
The input generator compiled offline; the running harness is not edited
during inference. Public and private cohorts have identical questions/weights;
the harness gains receipt privacy fields between cohorts, which does not change
model inputs or scoring.

Preexisting Rust classifier/redirect changes remain outside this evaluation
commit. Their tracked binary diff digest is unchanged:
`43a6daa131bffb2d681f6929912a9a360955bd6c5d1f67452f9c46fce219580b`.
The preexisting untracked redirect source hash also remains
`ea829ae59177311302094e1123e80894502d99fd6dfc70b60dc17115c78e2dfa`.
No native, installed, staging or production acceptance is claimed.
