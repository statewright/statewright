# SWE-bench v34 Clean500 Handoff Spec

Status: quick handoff for another agent
Date: 2026-07-01
Owner context: drafted from chat-level result summary, not from direct access to the full 500-run artifacts.

## Caveat

The writer of this handoff does **not** have the full v34 clean500 run context picture. Treat every number below as a reported snapshot that must be scrubbed against the source artifacts before publication, HN submission, arXiv/technical-report submission, or SWE-bench leaderboard PR.

Use the repo's built-in SWE-bench reporting path and raw result artifacts as the source of truth. Do not rely on ad hoc terminal counts if Taskfile/reporting/PVC JSON artifacts are available.

## Reported Result Snapshot

Run label: `v34 clean500`

Reported full-run state:

- Observed tasks: `500 / 500`
- Corrected solves after recovery accounting: `212 / 500 = 42.4%`
- Completed PASS+FAIL denominator view: `212 / 436 = 48.6%`
- CRD official solves: `153`
- Hidden PVC solves recovered: `59`
- Infra failures: `138`
- Retryable infra failures per current classifier: `0`
- Missing final verification: `43`
- Verification unavailable: `21`

Memory-bucket split, not graphics VRAM:

- 4GB memory bucket: `154 / 393 = 39.2%` full-bucket denominator; `154 / 344 = 44.8%` completed PASS+FAIL
- 6GB memory bucket: `58 / 107 = 54.2%` full-bucket denominator; `58 / 92 = 63.0%` completed PASS+FAIL

Prior exploratory context:

- Amalgamated result across harness revisions reportedly reached `44.6%`.
- Treat this as an exploratory ceiling, not the official clean benchmark result.

## Claim Boundary

Do claim, after artifact scrub:

> Qwen3-8B plus the Statewright repair harness reached `212 / 500 = 42.4%` on a clean full-500 SWE-bench Verified run after recovery accounting.

Do not claim:

> Qwen3-8B is better than GPT-4o.

Acceptable comparative framing:

> A small open model plus a repair harness reaches or exceeds some historical GPT-4o-plus-scaffold SWE-bench baselines. The result is a harness/system result, not a base-model ranking.

## Scrub Checklist

Before publishing anything, verify:

- `scrub:source-of-truth`: identify the canonical result artifact for v34 clean500. Prefer Taskfile/reporting outputs and raw PVC JSON over ad hoc commands.
- `scrub:instance-list`: produce the exact 500 instance IDs and per-instance status.
- `scrub:solves`: prove the `212` corrected solves with instance IDs.
- `scrub:crd-vs-pvc`: explain the gap between `153` CRD official solves and `59` hidden PVC recovered solves.
- `scrub:infra`: enumerate the `138` infra failures and why current classifier marks `0` retryable.
- `scrub:verification`: enumerate `43` missing final verification and `21` verification unavailable cases.
- `scrub:pass-at-1`: confirm the run satisfies pass@1 semantics: frozen harness, one reported prediction per task, no best-of-k selection.
- `scrub:harness-freeze`: record harness commit SHA, config, prompts/templates, retry policy, tool policy, and stopping rules.
- `scrub:model`: record exact model identifier, quantization, runtime, context length, temperature, sampling params, and hardware.
- `scrub:memory-buckets`: document what 4GB/6GB memory buckets mean. Do not describe them as graphics VRAM unless independently confirmed.
- `scrub:artifacts`: collect predictions, patches, reports, logs, traces, and manifest.

## Suggested Artifact Repo Shape

If creating a public results repo or docs directory, use:

```text
README.md
TECHNICAL_REPORT.md
RESULTS.md
RUN_MANIFEST.md
REPRODUCIBILITY.md
LIMITATIONS.md
artifacts/
  all_preds.jsonl
  per_instance_results.jsonl
  solved_instances.txt
  failed_instances.txt
  recovered_pvc_solves.txt
  infra_failures.jsonl
  verification_gaps.jsonl
  logs/
  trajs/
```

Minimum public README language:

> This is a pre-submission technical report for a Statewright SWE-bench Verified run. It is not yet an official SWE-bench leaderboard entry. The current scrubbed snapshot is `212 / 500 = 42.4%` corrected solves after recovery accounting, pending final artifact audit and any official SWE-bench submission requirements.

## HN / Outreach Posture

Prefer a regular HN submission over `Show HN` unless the linked repo contains something people can run immediately. HN Show guidelines reserve Show HN for things users can try, not pure reports.

Candidate title:

> Qwen3-8B reaches 42.4% on SWE-bench Verified with a repair harness

Alternative title:

> Small models, strong harnesses: 42.4% on SWE-bench Verified with Qwen3-8B

First-comment posture:

- State that this is a pre-submission technical report.
- Give the exact denominator: `212 / 500`.
- Explain recovery accounting and unresolved verification caveats.
- Say the claim is about harness/system design, not base-model superiority.
- Invite independent scrutiny/replication without asking for upvotes or marketing help.

## Academic Collaboration Path

Current SWE-bench Verified policy reportedly requires an open research publication/technical report and at least one academic or established research-lab affiliation for new Verified submissions. Treat academic collaboration as part of the official submission path, not just PR polish.

Collaboration ask should be specific:

> We are looking for an independent audit/replication partner for a small-model SWE-bench Verified repair-harness result, with enough artifact access to validate the `212 / 500` corrected-solve claim and coauthor a technical report if the result holds up.

## Immediate Next Tasks

- `swebench:locate-v34-artifacts`: find canonical v34 clean500 artifacts.
- `swebench:recompute-results`: recompute full result table from source artifacts.
- `swebench:write-results-md`: create `RESULTS.md` with tables and caveats.
- `swebench:write-manifest`: create `RUN_MANIFEST.md` with model/harness/hardware/config.
- `swebench:write-limitations`: document contamination, verification gaps, infra failures, and recovery accounting.
- `swebench:package-artifacts`: produce shareable predictions/logs/trajs bundle.
- `swebench:prepare-hn`: draft a regular HN submission and first comment after scrub.
- `swebench:academic-outreach`: draft short notes to likely academic collaborators asking for audit/replication help.
- `swebench:official-submission`: only start SWE-bench experiments PR after artifact scrub and affiliation/publication path are clear.
