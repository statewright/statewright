# Plugin release canary evidence

`require-plugin-canaries.cjs` requires successful trusted `main` push runs for
the exact release source: the complete macOS/Linux matrix, Windows canaries,
and plugin contract CI. It rechecks returned source, repository, workflow,
event and job identities instead of relying solely on REST query filters.

Required steps must have completed successfully. When GitHub returns an **empty**
job steps array, the verifier can instead consume `canary-steps.json`, produced
by that job from the runner's `steps` context. This is not reconstructed from
logs or inferred from overall job success. A nonempty but incomplete or failing
API step list never falls back to a receipt.

The two canary workflows upload v4 immutable artifacts named by matrix job and
run attempt. The receipt contains only selected step IDs, names, outcomes and
conclusions, plus repository/source/workflow/run/attempt/job identity. Outputs,
credentials and the full environment are not serialized. Both outcome and
conclusion must be successful, so `continue-on-error` cannot hide a failure.

The verifier retrieves artifacts from the selected run, verifies the archive's
SHA-256 against GitHub's artifact metadata, and checks every identity and
required step. It rejects expired, ambiguous, oversized, altered, malformed,
wrong-source and stale-attempt evidence. Archives have one fixed JSON member;
no archive paths are extracted or executed. The Linux release job uses the
runner's `unzip`; local preflight needs the same utility.

Trust remains in the reviewed workflow at the exact source and GitHub's
authenticated run/artifact service. A digest is an integrity check, not an
independent execution attestation or proof against a compromised runner.
No additional token permissions or secret are required. Older runs without
step metadata **and** without a valid receipt remain blocked; rerun the trusted
workflow containing the receipt producer, not a manual evidence fabrication.

Focused regression: `node --test plugins/executor/tests/plugin-release-workflow.test.mjs`.
