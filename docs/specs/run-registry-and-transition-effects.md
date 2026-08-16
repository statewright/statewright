# Typed Run Registry and Transition Effects

Status: proposed

## Problem

Statewright currently has one flat JSON context. Guards evaluate that context
before transition data is applied, so an agent cannot report a measured result
and have the same transition branch on it. The gateway intentionally does this
to prevent client event data from bypassing a guard, but it also means a
quantitative check needs an extra completed state before it can influence a
guard.

Two related weaknesses make proof subflows less reliable than they need to be:

- The gateway currently interprets any final child state other than the literal
  `failed` as successful. A child ending in `blocked` therefore resumes its
  parent through `on_complete` rather than `on_fail`.
- A child starts from a shallowly patched context and merges its full context
  back into its parent. This has no typed input/output contract, no namespace,
  and no provenance boundary.

The goal is a durable, auditable way to sample facts, keep typed run state,
evaluate a guard against that state without advancing a model state, and route
proof success or failure correctly. It is not a general-purpose mutable global
store or an arbitrary-code escape hatch.

## Decision

Add three separate data surfaces:

| Surface | Lifetime | Purpose | Write policy |
| --- | --- | --- | --- |
| Context | state-machine run | Existing human/agent handoff data | Backward-compatible event patching |
| Run registry | one run and its child subflows | Typed facts used by guards and proofs | Declared keys, revisioned patches, audited |
| Artifact store | durable external evidence | Large outputs, logs, reports, snapshots | References only in context/registry |

There is no implicit cross-run global namespace. A future project-level shared
store must be explicit, separately authorized, access-controlled, and use
optimistic concurrency. It must not be introduced by the first registry
release.

## Core data model

The workflow definition gains an optional declared registry.

```json
{
  "registry": {
    "version": 1,
    "keys": {
      "/validation/focused/exit_code": {
        "type": "integer",
        "scope": "run",
        "writers": ["validate", "repair"],
        "required_for": ["validation_complete"]
      },
      "/validation/coverage": {
        "type": "number",
        "minimum": 0,
        "maximum": 100,
        "scope": "run",
        "writers": ["validate"]
      },
      "/proofs/native_delivery": {
        "type": "object",
        "scope": "run",
        "writers": ["native_delivery"]
      }
    }
  }
}
```

At runtime the registry contains a monotonic `revision`, declared values, and
an append-only change ledger. Every entry carries the key, old/new value hash,
writer state, action or MCP tool identity, input registry revision, timestamp,
and optional artifact reference. Values should not carry raw secrets or large
transcripts.

The MCP gateway exposes two narrowly scoped tools:

- `statewright_get_registry`: read the current values, schema summary,
  revision, and redacted provenance.
- `statewright_apply_registry_patch`: apply a JSON patch to declared keys only.
  The caller supplies `expected_revision`; the gateway validates type, writer
  state, value size, and sensitive-key policy before atomically incrementing
  the revision. This does not transition the machine or consume a state entry.

The patch tool is not a generic context-mutation tool. Existing context remains
compatible for legacy workflows; new guard-critical values belong in the
registry.

Registry keys are RFC 6901 JSON Pointers rooted at the registry value document,
not dotted strings, so a key named `a.b` can never be confused with
`{ "a": { "b": ... } }`. The new guard shape is deliberately separate from
the legacy `GuardDef.field`:

```json
{
  "source": "registry",
  "path": "/validation/coverage",
  "op": "gte",
  "value": 80
}
```

`field` continues to mean a top-level context field for existing machines.
The schema rejects a guard that combines `field` with `source` or `path`.

## Guard snapshot and transition order

The run lock linearizes the transition, but it must never be held while a
command or an MCP operation waits on the outside world. Pure `set`, `extract`,
and `assert` effects execute inside the critical section. A future external
effect uses a prepared, compare-and-swap sequence:

```text
event request
  -> lock: capture state, context, registry revision, and an effect intent id
  -> unlock: execute the bounded registered external effect
  -> lock: require the captured state and registry revision (CAS)
  -> atomically apply validated registry writes
  -> build immutable guard snapshot: context + registry + event metadata
  -> evaluate guards against that snapshot
  -> apply context patch and change state
  -> persist transition, registry revision, effect ledger, and artifact refs
  -> emit state-change event
```

If the state or revision changed while the external effect ran, the result is
discarded and the transition fails `stale_effect_snapshot`; the initial release
does not retry it automatically. An effect failure leaves the machine in its
prior state and records a typed failure. The only initial failure policy is
`record_and_abort`; a later `effect_failure_event` may be added only as a
normal declared event evaluated by the same guard rules. No effect may silently
choose another guard branch. Guard evaluation receives the snapshot, never a
mutable live object. A transition also records the registry revision it
evaluated, so a stale or conflicting write cannot be misrepresented as proof.

`guard_snapshot` is transition-local and opt-in:

```json
{
  "target": "ship",
  "guard_snapshot": { "sources": ["context", "registry"] },
  "guards": [{ "source": "registry", "path": "/validation/coverage", "op": "gte", "value": 80 }]
}
```

Its default is legacy context-only evaluation. Workflow-level defaults may be
introduced later, but only with an explicit per-transition override so an
upgrade never silently changes an existing branch.

## Safe effects

Effects are declarative and registered, not arbitrary shell or embedded
JavaScript. The initial set is:

- `set`: assign a literal, schema-validated registry value.
- `extract`: select a bounded JSON value from a named artifact or prior tool
  result using a constrained path expression.
- `assert`: evaluate a deterministic predicate and emit a typed result.
- `named_command`: invoke a pre-registered command profile with a fixed digest,
  argument schema, working-directory policy, environment allowlist, timeout,
  output cap, and result schema.
- `mcp_read`: call an explicitly registered read-only MCP operation with an
  input/output schema and redacted evidence reference.

Effects may run on `on_entry`, `pre_transition`, `on_transition`, or
`post_transition`. The first implementation only needs `pre_transition` and
`on_entry`. State transition itself remains controller-owned: a registry update
can re-evaluate a declared guard, but it cannot autonomously advance an agent
state. A future `auto_event` is allowed only for a declared deterministic
controller event with an audit record and no model turn in flight.

The first release exposes one explicit effect-failure behavior:

```json
{
  "pre_transition": [
    { "id": "coverage-check", "kind": "assert", "source": "registry", "path": "/validation/coverage", "op": "gte", "value": 80 }
  ],
  "on_effect_failure": "record_and_abort"
}
```

`record_and_abort` preserves the current state and returns a typed failure.
An `effect_failure_event` can be added later only as a separately declared
normal transition evaluated by the same guard rules. Effect identities are
unique within a workflow and every ledger entry includes its intent id, profile
digest where applicable, start/end timestamps, result status, redacted output
reference, and registry revisions before and after.

## Outcome-typed final states and subflows

Final states gain an explicit outcome:

```json
{
  "completed": { "type": "final", "outcome": "success" },
  "blocked": { "type": "final", "outcome": "failure" },
  "failed": { "type": "final", "outcome": "failure" }
}
```

The gateway determines child success from this outcome, never from a final
state name. During migration, final outcome resolution is deterministic:

1. an explicit state `outcome` wins;
2. otherwise a state listed in `meta.failure_states` resolves to `failure`;
3. otherwise the legacy literal `failed` resolves to `failure`;
4. any other legacy final resolves to `success` and produces a schema warning.

`meta.failure_states` currently arrives through `MachineMeta.extra`; validation
must normalize that value before use. A future definition version can require
explicit outcomes and elevate step 4 to an error. The gateway records the
resolution source in the child-completion ledger.

Existing invocation shorthand and its `input` field retain their current
flat-context behavior until a workflow opts into typed bindings. The opt-in
form uses an object, JSON Pointers, and distinct source/target fields:

```json
{
  "invoke": {
    "machine": "native-delivery-proof-v2",
    "input_bindings": [
      { "from": { "source": "registry", "path": "/dag/node_id" }, "to": "/node_id" },
      { "from": { "source": "context", "path": "/commit" }, "to": "/commit" }
    ],
    "output_binding": {
      "to": { "source": "registry", "path": "/proofs/native_delivery" },
      "schema": "native_delivery_proof_v1"
    }
  },
  "on_complete": "validate",
  "on_fail": "block_record"
}
```

Only the validated output binding returns to the parent. The child cannot
overwrite arbitrary parent context. The output includes `status`, `checks`,
`evidence_refs`, `side_effects_observed`, `route`, and
`input_registry_revision`. A malformed binding, missing source, or invalid
output follows `on_fail` and records a typed contract failure. The typed form
is intentionally not overloaded onto the existing untyped `input` field; it
avoids accidental behavior changes in currently deployed proof machines.

## Migration plan

1. **Final outcome correction.** Add `FinalOutcome`, normalize legacy
   `meta.failure_states`, route child finals using the ordered compatibility
   rules above, and add regression tests proving `blocked` uses `on_fail`.
2. **In-memory typed run registry.** Add schema parsing, revisioned session
   storage, read/patch MCP tools, ledger events, and tests for writer/type/CAS
   failures. No effects yet.
3. **Guard snapshots.** Add transition-local opt-in registry-aware guards with
   explicit source and JSON Pointer paths; preserve legacy top-level
   context-field behavior. Add tests for same-transition quantitative branches
   and stale revisions.
4. **Named pre-transition effects.** Start with `set`, `assert`, and bounded
   `extract` under the run lock and `record_and_abort`. Introduce external
   command/MCP profiles only after prepared-effect CAS, capability-policy, and
   artifact-redaction tests exist.
5. **Typed subflow input/output.** Add the opt-in object form without changing
   legacy `input`; migrate the Magent proof machines and verify blocked proofs
   reach `on_fail`.
6. **Durable backing store.** Reuse the operator roadmap's transactional
   state/context/log persistence for registry values and effect ledgers. Add a
   project-shared namespace only as a separately versioned capability.

## Validation matrix

- Schema rejects undeclared registry keys, invalid types, state-ineligible
  writers, invalid effect profiles, incompatible legacy/new guard fields, bad
  JSON Pointers, and final states with unknown outcomes.
- A patch with an old `expected_revision` fails without changing state,
  context, or registry.
- A `pre_transition` effect can make the current event take a quantitative
  guarded branch; a failed effect preserves the state with a typed
  `record_and_abort` result.
- An external effect whose state or revision changes before CAS is discarded;
  it cannot apply output to a later state.
- Legacy context-only guards retain their existing pre-event behavior.
- Outcome precedence tests cover explicit outcome, `meta.failure_states`, the
  `failed` literal, and an unclassified legacy final warning.
- A subflow ending `blocked` follows `on_fail`; `completed` follows
  `on_complete`; malformed child output fails closed.
- Telemetry includes requested/selected model route, registry revision,
  effect result, artifact references, and transition outcome without secrets.
- The DAG proof profile tests verify parent isolation, output namespacing, and
  no parent success after a blocked child proof.

## Usage and operational limits

The registry removes model-only sampling states, but it does not justify
unbounded effects. Default limits should be declared per effect profile:

| Limit | Initial default |
| --- | --- |
| Effects per transition | 3 |
| Effect timeout | 30 seconds |
| Captured output | 64 KiB redacted |
| Registry patch size | 16 KiB |
| Artifact payload in registry | reference only |
| CAS retries | 0; caller resamples explicitly |

The normal design/review path is seven states (five Terra/high and two
Sol/high); a bounded repair path is eleven (eight Terra/high and three
Sol/high). These counts are planning envelopes, not provider-token estimates.
Reserve capacity belongs to validation, independent review, and a compact
handoff rather than broad rediscovery.

## Non-goals

- Arbitrary JavaScript, shell snippets, or user-provided code in guards.
- A hidden global variable bag shared across projects or sessions.
- Storing secrets, full tool transcripts, contact data, or unredacted command
  output in the registry.
- Automatically transitioning a model-owned state merely because a value
  changed.
- Replacing the existing context contract in one release.

## Source grounding

- `crates/engine/src/transition.rs`: guards currently receive only the current
  context, before event data is patched.
- `crates/mcp-gateway/src/gateway.rs`: transition data is intentionally applied
  after guard resolution; child success is currently identified by the literal
  state name `failed`.
- `crates/mcp-gateway/src/session.rs`: child context is currently merged flat
  into the suspended parent's context.
- `docs/future/operator-design.md` and
  `docs/future/k8s-operator-architecture.md`: declarative actions and atomic
  state/context/transition logging are already the stated operator direction.
