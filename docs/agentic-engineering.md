# Agentic engineering

The default `agentic-engineering` workflow brings a short evidence-led process
to fixes, small features, refactors and investigations. You can also ask for
`engineering`; it resolves to the same workflow, not a second copy.

Try one of these after connecting Statewright:

```
Use the engineering workflow to fix the failing test and verify the regression.
Use the engineering workflow to add input validation to this form.
Use the engineering workflow to refactor this parser without changing its behavior.
Use the engineering workflow to investigate this error. Do not edit anything.
```

## What it does

`diagnose → baseline → implement → validate → review → handoff → complete`

The agent establishes the outcome and baseline before editing, then implements
one focused change, checks it, and reviews the result. Investigations and
already-correct behavior skip implementation but retain evidence and review.
A failed check or review gets one reconciliation and repair round. If that
does not resolve the issue, the workflow stops as `blocked` with the evidence
and smallest next action. It cannot cycle through repairs indefinitely.

It uses your selected model rather than requiring a particular provider or
premium model. Compatible clients apply per-phase effort requests; other hosts
retain their settings. This starter is not the larger `agentic-engineering-v2`
profile and does not require its model-routing configuration.

## What completion means

The workflow requires a recorded passing validation result before review can
advance. Records must be nonempty text, supplied before the guarded transition.
For no-change completion, the agent must record that no change was needed and
why. These are **agent-reported evidence records**, not independent proof that
a test ran or that its conclusions are correct. Read the reported checks and
limitations. A separate review phase is not a separate reviewer.

Only implementation and repair expose source-editing capabilities. Validation
permits bounded local test/build artifacts where supported. Host permissions,
command classification and Statewright approvals still apply; the workflow
does not grant permission to commit, publish, deploy or change credentials.
No commit or paid-model upgrade is automatic. Context and time budgets are
advisory; the single-repair bound comes from the state graph itself.

## Existing installations

The onboarding migrations add this starter to every existing account, including
accounts with customized workflows or no workflows. It becomes the default;
old workflows and run history are not rewritten. You can delete the old `bugfix`
workflow when you no longer need it. New accounts receive `agentic-engineering`
through normal signup or connection onboarding.

An existing definition with the canonical name is retained, not overwritten.
An explicitly disabled definition stays disabled and is not selected as the
default. A downgrade retains added workflows rather than deleting user data.

An exact custom workflow named `engineering` takes precedence over the alias,
including when disabled. The alias never redirects around a disabled workflow.
The catalog shows canonical names; no separate alias workflow is stored.

## Definition and checks

The source is [workflows/agentic-engineering.json](../workflows/agentic-engineering.json).
Generated Claude/Codex examples and the self-hosted migration are checked for
parity with that file. The workflow tests exercise the real Rust transition
engine; migration tests use a disposable PocketBase database when installed.

```
node scripts/generate-engineering-workflow.mjs --check
node --test scripts/engineering-workflow.test.mjs scripts/engineering-accounts.test.mjs scripts/workflow-aliases.test.mjs
cargo test -p statewright-engine --test default_engineering
```

These checks validate the definition and migration behavior. They do not
replace a connected-client acceptance run or prove a particular task's result.
