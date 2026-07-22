# Build longer workflows from reusable submachines

A Statewright workflow should describe a repeatable unit of work, not the full
history of one feature request. `templates/stitch/` keeps those units small and
versioned, then composes them into a longer run. This avoids generating a new
permanent workflow for every task while preserving an auditable state boundary
around each phase.

The bundled feature stitch is:

```text
intake/localize -> decision/slice -> red/build/validate -> review
                                      | failed/unavailable
                                      v
                                 debug/triage ----> build
```

Its manifest registers six named workflows:

- `intake-localize` finds the relevant code, constraints, and prior evidence.
- `decision-slice` records the bounded plan and calls the ADR submachine.
- `red-build-validate` establishes a failing signal, implements one slice, and
  validates it.
- `debug-triage` is the only retry loop. It must produce a different hypothesis
  before returning to build.
- `adversarial-review` checks the implementation against the task, ADRs, prior
  failures, and repository history.
- `feature-dag` is the parent that invokes the other five.

## Load a stitch

Register each entry in `templates/stitch/manifest.json` with
`statewright_create_workflow`, then load the parent:

```text
statewright_load_workflow(
  name="[stitch] feature-dag v1",
  task_intent="Add session isolation to the MCP gateway"
)
```

The gateway handles `invoke` as a call stack. It suspends the parent workflow,
activates the named child, and restores the parent through `on_complete` or
`on_fail` when the child reaches a final state. A nested child unwinds through
the same mechanism; the client does not reload parent workflows by hand.

This is composition, not a permissive DAG runner. The active child owns the
current instructions, tools, guards, and validation contract. A tool call made
while `red-build-validate` is in `red`, for example, is audited against `red`
even though the root stitch is still in its broader build phase.

## Lineage and recovery

Loading a workflow whose name starts with `[stitch]` assigns one stitch ID to
the root and every invoked child. When the gateway has metering storage
configured, it also persists a `workflow_stitch` record and links each
`workflow_run` through `stitch_id` and `parent_run_id`. That record tracks the
root run, child count, status, task intent, and completion time.

Keep retries inside a designated triage submachine. A failed validation routes
to `debug-triage`, which records a new hypothesis before another build attempt.
This makes repeated solutions visible instead of letting the agent cycle
silently. If triage cannot produce a distinct next move, the stitch ends in a
blocked state rather than spending another unbounded loop.

Use [`statewright_search_references`](local-reference-recall.md) during intake,
triage, and review to retrieve prior ADRs, specs, validation artifacts, and
commits with path and hash provenance. The stitch decides when evidence is
needed; the local reference tool supplies evidence without becoming another
source of workflow state.

## When not to stitch

Use one ordinary workflow when the task has a single validation loop and every
phase shares the same tool, exit, failure, and approval contract. Stitch when a
child is reusable, needs a separate audit record, or owns a different contract.
