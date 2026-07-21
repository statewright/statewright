# Stitchable SDLC submachines

`templates/stitch/` contains a small, versioned library of reusable submachines.
The manifest uses the `[stitch]` prefix so named workflows are easy to discover
and safe to compose later without turning every feature into a permanent new
workflow.

The feature DAG stitches them as:

```text
intake/localize -> decision/slice -> red/build/validate -> review
                                      | failed/unavailable
                                      v
                                 debug/triage ----> build
```

Register the manifest entries with `statewright_create_workflow`, then load
`[stitch] feature-dag v1`. The gateway treats `invoke` as a submachine stack:
it activates the registered child, suspends the parent, and restores the parent
through `on_complete` or `on_fail` when the child reaches a final state. Nested
children unwind deterministically without the client manually loading parents.
`debug/triage` is the only failure loop: it must return a distinct hypothesis
before build can be attempted again.

Loading a `[stitch]` workflow creates one `workflow_stitch` identity. The root
and every invoked `workflow_run` share `stitch_id`; each child also records
`parent_run_id`. Status, run count, and the root run are accounted at the stitch
level while normal workflows retain null lineage.

For evidence retrieval, use `statewright_search_references`. It is intentionally
local and deterministic. Its lazy index lives under Git metadata, reuses
unchanged chunks, and re-ingests changed allowlisted sources on the next query.
Results include path/line, source class, source hash, commit SHA, rank reasons,
and a bounded excerpt. It is not an embeddings service or a source of
synthesized conclusions.
