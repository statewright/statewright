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
`[stitch] feature-dag v1`. The DAG uses existing `invoke` transitions; clients
or the direct agent executor run the named child machine and resume the parent.
`debug/triage` is the only failure loop: it must return a distinct hypothesis
before build can be attempted again.

For evidence retrieval, use `statewright_search_references`. It is intentionally
local and deterministic: an unchanged working tree yields the same ordered
results, each with path/line, source hash, commit SHA, rank reasons, and a
bounded excerpt. It is not an embeddings service or a source of synthesized
conclusions.
