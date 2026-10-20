# Classifier denial audit — 2026-10-20

## Coverage

This audit uses locally retained native Codex session JSONL from the regular
session root and the staging lane's managed Codex-home root. Records are
deduplicated by `(timestamp, call_id)` because the two roots mirror some
sessions. The selected cohort is the newest 100 command-hook denials before
`2026-10-20T14:00:00Z`; the cutoff excludes audit activity itself. The
accompanying [sanitized record set](classifier-denial-audit-20261020.json)
contains exactly 100 unique timestamp/call-ID pairs in descending order. It
retains only safe metadata: timestamp, opaque call ID, source-log basename,
project label, denial category, command-family label, and individual
adjudication status. Every retained status is `unreviewed`: it records an
evidence limit, not a correct/incorrect classification. Three non-command
patch events were excluded and replaced with older command-hook records; the
three replacements whose command operands were unavailable are explicitly
labelled `uninspected_record` rather than guessed.

All 100 retained records have `project` set to `unknown`; project attribution
and per-project coverage cannot be established from this artifact. This is
local-retention coverage, not a claim about other machines, cloud sessions, or
deleted logs. Patch-tool capability errors,
gateway-unavailable events, and execution failures are outside this
classifier-denial cohort. Individual false-positive adjudication and whether an
event was ordinary work or a synthetic canary are unavailable in this sanitized
artifact; `unreviewed` records that limit. Observed categories are
`uncertain_structural` (47),
`semantic_uncertain` (28), `phase_capability_denied` (15),
`separate_approval_required` (7), and `legacy_or_other` (3). The most frequent
safe command-family labels are `other` (27), `ripgrep` (15), `node` (15),
`project_task` (12), and `cargo` (9). These are event frequencies, not
false-positive rates or calibrated model probabilities.

## Findings and bounded changes

The records repeatedly contain routine local inspection and test shapes. Two
concrete gaps are independently reproducible in current source:

* `readonly_sed_print_program` accepted one print-only range but rejected a
  literal sequence such as `1,20p;40,60p`, although each clause is print-only.
* Bounded Node execution recognized `.test.mjs` and `.mjs` only. Node's native
  CommonJS and JavaScript forms need the same bounded local-execution class,
  not read authority.

The audit also found stderr-null sinks in the cohort. An AST-enabled regression
first failed against current source: the exact literal `2>/dev/null` was
classified as a file write even though the existing bounded read proof treats
that exact sink as discard. The AST now mirrors that exact exception only;
spaced, appended, stdout, expansion, and non-null redirects remain write
evidence.

## Fresh implementation evidence

The exact AST regression first failed (11 passed, 1 failed), then passed after
the targeted change as part of `shell_ast_shadow::tests` (12 passed). The
focused `denial_audit_regression` passed, `bash_classifier::tests` passed
(88 tests), and the final `risk_assessment::tests` run passed (58 tests,
including the extracted regression). JSON schema,
count, uniqueness, ordering, cutoff, and metadata-key checks passed, as did
`git diff --check`. Fresh audit-artifact verification recovered the durable
pre-edit JSON receipt and compared every 20-record slice after removing only
`adjudication_status`; all five slices and the top-level selection metadata
matched exactly. The fresh record checks found 100 exact seven-key records,
100 unique timestamp/call-ID pairs, descending timestamps before the cutoff,
and the reported category and family totals. The Rust results above predate
this metadata-only correction and are inherited evidence, not a new suite run.

S1 remains disabled and no bundle is installed by this audit. The exact
single-test Cargo form using `-- --exact` was denied by the current guard
before execution; it was not retried. The admitted module and focused test
forms above are the executed evidence.

## Safety boundary

No System One, score threshold, approval path, workflow, deployment, or
generic interpreter permission changes are included. Multi-command shell
composition, substitutions, output destinations, arbitrary Node flags,
absolute or escaping paths, non-test Node entrypoints, sed write/execute/read
commands, malformed sed programs, and missing workflow capabilities remain
denied or require their existing stronger authority.
