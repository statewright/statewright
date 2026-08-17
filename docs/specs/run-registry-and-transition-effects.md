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

## Executable guards and script profiles

Declarative guards remain the fast default, but some policies are too rich for
field comparison: a release gate may need to reconcile a bounded set of test
results, an issue-state policy may need project-specific logic, or a proof may
need to inspect a structured artifact. Statewright therefore gains an opt-in
**executable guard profile**. It supports both inline code blocks and pinned
repository scripts without making the workflow definition an unrestricted host
shell.

Every executable guard receives a read-only, redacted input projection:

```json
{
  "schema_version": 1,
  "workflow": { "id": "release", "definition_digest": "sha256:..." },
  "transition": { "state": "validate", "event": "COMPLETE" },
  "context": { "commit": "abc123" },
  "registry": { "revision": 17, "values": { "validation": { "coverage": 86 } } },
  "artifacts": [{
    "name": "coverage_report",
    "ref": "artifact://coverage.json",
    "digest": "sha256:...",
    "path": "/summary",
    "value": { "coverage": 86 }
  }]
}
```

The projection contains only declared context fields, registry paths, and
bounded artifact views. An artifact view names one artifact, selects an
allowed JSON Pointer or text range, and carries a byte limit and redaction
policy. It excludes secrets, ambient environment variables, unbounded
transcripts, credentials, and undeclared registry keys. Snapshot construction
records its projection and redaction policy in the guard ledger.

Two profile forms are supported:

```json
{
  "guard_executors": {
    "release_policy_v1": {
      "kind": "inline_code",
      "runtime": "quickjs-v1",
      "code": "function guard(input) { return { pass: input.registry.values.validation.coverage >= 80, reason_code: 'coverage_threshold' }; }",
      "code_digest": "sha256:...",
      "input_projection": {
        "context_paths": ["/commit"],
        "registry_paths": ["/validation/coverage"],
        "artifact_views": [{
          "artifact": "coverage_report",
          "path": "/summary",
          "max_bytes": 4096,
          "redaction": "default-v1"
        }]
      },
      "limits": { "cpu_ms": 50, "memory_bytes": 1048576, "output_bytes": 8192 },
      "capabilities": {
        "network": "deny",
        "filesystem": { "read": [], "write": [] },
        "environment": [],
        "imports": "deny",
        "clock": "fixed",
        "random": "deny"
      }
    },
    "repo_release_policy_v1": {
      "kind": "script",
      "runtime_profile": "node-22-guard-v1",
      "path": "scripts/guards/release_policy.js",
      "content_digest": "sha256:...",
      "sandbox": "guard-readonly-v1",
      "input_projection": { "registry_paths": ["/validation/coverage"] },
      "transport": {
        "stdin": "guard_input_json",
        "stdout": "guard_result_json",
        "stderr": "redacted_evidence"
      },
      "limits": { "wall_ms": 500, "output_bytes": 8192 },
      "capabilities": {
        "network": "deny",
        "filesystem": { "read": ["repo:scripts/guards/release_policy.js"], "write": [] },
        "environment": ["LANG", "LC_ALL"]
      }
    }
  }
}
```

A named guard references a profile rather than embedding an executable payload
in a transition branch:

```json
{
  "guards": {
    "release_policy": { "executor": "release_policy_v1" }
  },
  "states": {
    "validate": {
      "on": {
        "COMPLETE": {
          "target": "release",
          "guards": ["release_policy"]
        }
      }
    }
  }
}
```

This preserves the existing named-guard model, gives validation one place to
resolve profile identities, and makes the profile digest visible wherever the
guard is used.

`quickjs-v1` is the first proposed inline runtime, with no host bindings,
module loading, clock, randomness, filesystem, environment, or network. Its
runtime instance is fresh per evaluation and must enforce CPU, memory, stack,
and output limits. The executor registry is intentionally extensible: a future
WASM runtime may offer a more strongly deterministic profile with fuel-based
execution, but no workflow may select a runtime the controller has not
registered and capability-tested. `code_digest` is computed from the canonical
UTF-8 source bytes and the source declares a global `guard(input)` function;
the runner does not infer entrypoints from arbitrary code.

A script profile is arbitrary repository logic only in the bounded sense that
its language/runtime is selected by the profile. `runtime_profile` resolves to
a controller-owned fixed interpreter, image/binary digest, argument template,
and sandbox adapter; a workflow cannot supply an executable path or arbitrary
arguments. The source path is relative to the approved workspace, its digest
is pinned, and the script receives its `GuardInput` only on stdin. Stdout must
contain exactly one `GuardResult` JSON document; bounded, redacted stderr is
evidence rather than a second result channel. The sandbox profile—not the
script—grants filesystem, environment, or network access. A source edit
invalidates the profile until its digest is deliberately updated. Scripts never
inherit the controller process environment or the current user shell.

## Docker guard executor and supervisor boundary

Docker is the preferred runtime-profile adapter when a guard needs a specific
language, package set, or native dependency. The image contains those
dependencies; Statewright does not install packages while evaluating a guard.
Every Docker profile pins an OCI image digest and a named sandbox policy:

```json
{
  "runtime_profiles": {
    "node-22-guard-docker-v1": {
      "kind": "docker",
      "image": "registry.example/statewright/guard-node22@sha256:...",
      "image_sbom_digest": "sha256:...",
      "entrypoint": ["node", "/opt/statewright/guard-runner.mjs"],
      "sandbox": "guard-docker-readonly-v1",
      "limits": {
        "wall_ms": 5000,
        "cpus": 0.5,
        "memory_bytes": 134217728,
        "pids": 64,
        "stdout_bytes": 8192,
        "stderr_bytes": 65536
      },
      "capabilities": {
        "network": "deny",
        "docker_socket": "deny",
        "privileged": false,
        "linux_capabilities": [],
        "filesystem": { "root": "read_only", "script": "read_only", "workspace": "deny" }
      }
    }
  }
}
```

The executor image is a small, profile-specific image. The following
Dockerfile is the normative starting point for the Node guard image; a later
implementation must place the equivalent source under
`containers/guard-executor/node22/Dockerfile`, build it with a digest-pinned
base-image argument, generate an SBOM, and record the resulting OCI digest in
the runtime profile. A tag alone is never an acceptable build input.

```dockerfile
# syntax=docker/dockerfile:1.7
# Required build input example:
#   --build-arg NODE_BASE_IMAGE=node:22-bookworm-slim@sha256:<verified-digest>
ARG NODE_BASE_IMAGE
FROM ${NODE_BASE_IMAGE} AS runtime

RUN groupadd --gid 65532 statewright \
 && useradd --uid 65532 --gid 65532 --no-create-home --shell /usr/sbin/nologin statewright

WORKDIR /opt/statewright
COPY --chown=65532:65532 guard-runner.mjs /opt/statewright/guard-runner.mjs

ENV NODE_ENV=production \
    HOME=/nonexistent \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

USER 65532:65532
ENTRYPOINT ["node", "/opt/statewright/guard-runner.mjs"]
```

The Docker launcher, not the workflow, expands this into an allowlisted run
policy equivalent to:

```text
docker run --rm --read-only --network none --cap-drop ALL
  --security-opt no-new-privileges:true --pids-limit 64 --cpus 0.5
  --memory 128m --memory-swap 128m --user 65532:65532
  --tmpfs /tmp:rw,noexec,nosuid,size=16m
  --mount type=bind,src=<staged-script-dir>,dst=/guard,readonly
  image@sha256:...
```

The exact flags are adapter-owned and captured in the execution receipt. No
guard container receives the Docker socket, the repository checkout, the user
home directory, a host shell, or a writable bind mount. The supervisor stages
only the requested script and its declared read-only data into a fresh
directory, verifies their digests, mounts that directory read-only, and removes
it after collecting evidence.

The existing resident Codex app-server/TUI owner is a good place to orchestrate
this work, but it is not the executor. It already owns managed-client identity,
next-turn route injection, and loopback lifecycle. Extend the trusted
Statewright supervisor with a narrow local guard-job dispatcher and an explicit
run/job authentication check:

```text
Codex TUI <-> app-server route proxy <-> resident Statewright supervisor
                                              |
                                              | authenticated GuardJob request
                                              v
                                  Docker launcher / immutable executor image
                                              |
                                              | GuardResult + JSONL diagnostics
                                              v
                                  Statewright transition CAS + evidence ledger
```

The supervisor authenticates the run identity, validates the declared profile,
stages input, starts the job, enforces wall-clock cancellation, validates the
result, and performs the final state/revision CAS. It can surface a pending or
failed guard to the TUI/mobile attention system, but the App Server protocol is
not used as a general container-execution API and the container cannot call
back into it.

### Guard executor social contract

The contract is versioned as `statewright.guard.v1`.

- **Input:** exactly one UTF-8 `GuardInput` JSON document on stdin. It is the
  redacted immutable snapshot described above, with `run_id`, `job_id`,
  `profile_id`, image/script digests, and a deadline.
- **Success exit:** exit code `0` means stdout contains exactly one UTF-8 JSON
  `GuardResult`. `pass: false` is a valid policy result and still exits `0`.
- **Failure exits:** `20` invalid input; `21` source/image integrity mismatch;
  `22` sandbox or denied-capability failure; `23` timeout/resource limit;
  `24` script/runtime failure; `25` malformed stdout/protocol failure. The
  runner maps language-specific exits to these stable Statewright codes and
  records the original exit/signal as diagnostics.
- **Stdout:** result only. Logs, banners, package-manager output, and stack
  traces on stdout are a protocol violation.
- **Stderr:** UTF-8 JSON Lines diagnostic events with `protocol`, `job_id`,
  `level`, `event`, `message`, and optional redacted `fields`. The launcher
  caps it at 64 KiB and appends one `log_truncated` event when it cuts output.
- **Result receipt:** `GuardResult` includes `status`, `pass` when status is
  `ok`, `reason_code`, `evidence_refs`, `input_digest`, `script_digest`,
  `image_digest`, `profile_id`, elapsed time, and a redacted diagnostics
  reference. Statewright rejects a receipt whose identity does not match the
  submitted job.
- **No implicit retry:** image pull, startup, timeout, exit, protocol, or CAS
  failure follows `record_and_abort`. A workflow may explicitly resample or
  request human review; it never reruns a guard silently.

Both forms must emit a small JSON `GuardResult`:

```json
{
  "pass": true,
  "reason_code": "coverage_threshold",
  "message": "coverage is 86; minimum is 80",
  "evidence_refs": ["artifact://coverage.json"]
}
```

`pass` is the only branch-controlling value. `reason_code`, message, and
evidence references are audit material subject to schema, size, and redaction
limits. An executor timeout, trap, non-zero exit, malformed result, digest
mismatch, denied capability, or stale snapshot is a typed guard failure, not a
false result and not a fallback to another branch.

An executable guard cannot mutate context, the registry, artifacts, workflow
definition, or state. When code needs to calculate and store values before a
guard runs, it uses the same registered runtime through a separately declared
`pre_transition` **script effect**. That effect may return a validated patch
only to its declared registry write paths; it then follows the existing
prepared-effect CAS and `record_and_abort` rules. Keeping "compute and write"
separate from "evaluate and branch" prevents repeated guard evaluation from
creating hidden side effects.

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

An executable guard is evaluated after pre-transition effects have formed the
immutable snapshot. It uses the same prepared/CAS discipline as an external
effect:

```text
lock: capture state, registry revision, snapshot digest, and guard intent id
  -> unlock: run bounded code or script against the read-only snapshot
  -> lock: require captured state and registry revision (CAS)
  -> apply GuardResult to the declared branch selection
```

This keeps the run lock out of arbitrary runtime execution. If another event
or registry patch wins first, the result is discarded as
`stale_guard_snapshot`; Statewright does not retry it automatically. The guard
ledger records profile id, runtime, code/script digest, input snapshot digest,
capability policy digest, limits, elapsed time, result, and evidence refs.

## Safe effects

Effects are declarative and registered; they are not an unrestricted shell or
script surface. The initial set is:

- `set`: assign a literal, schema-validated registry value.
- `extract`: select a bounded JSON value from a named artifact or prior tool
  result using a constrained path expression.
- `assert`: evaluate a deterministic predicate and emit a typed result.
- `named_command`: invoke a pre-registered command profile with a fixed digest,
  argument schema, working-directory policy, environment allowlist, timeout,
  output cap, and result schema.
- `mcp_read`: call an explicitly registered read-only MCP operation with an
  input/output schema and redacted evidence reference.
- `script`: invoke a registered inline-code or pinned-script profile as an
  effect, with declared registry write paths and the same sandbox/capability
  contract used by executable guards.

Effects may run on `on_entry`, `pre_transition`, `on_transition`, or
`post_transition`. The first implementation only needs `pre_transition` and
`on_entry`; script effects arrive only after the executable-guard sandbox
contract is validated. State transition itself remains controller-owned: a
registry update can re-evaluate a declared guard, but it cannot autonomously
advance an agent state. A future `auto_event` is allowed only for a declared
deterministic controller event with an audit record and no model turn in
flight.

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
4. **Executable guard foundation.** Add the profile schema, projection builder,
   `GuardResult` validation, ledger, QuickJS isolated-runtime spike, and the
   prepared/CAS execution path. Prove timeout, memory, import, environment,
   network, malformed-result, digest-mismatch, and stale-snapshot behavior.
5. **Docker guard-executor proof.** Build the profile-specific image from a
   digest-pinned base, generate and attach its SBOM, and implement the typed
   stdin/stdout runner plus trusted launcher. Prove no network, Docker socket,
   repository, home-directory, writable bind mount, ambient credential, or
   privileged capability reaches the container; verify protocol exits,
   resource limits, receipt identity, and evidence capture.
6. **Named pre-transition effects.** Start with `set`, `assert`, and bounded
   `extract` under the run lock and `record_and_abort`. Add script effects and
   external command/MCP profiles only after prepared-effect CAS,
   capability-policy, artifact-redaction, and executable-guard tests exist.
7. **Typed subflow input/output.** Add the opt-in object form without changing
   legacy `input`; migrate the Magent proof machines and verify blocked proofs
   reach `on_fail`.
8. **Durable backing store.** Reuse the operator roadmap's transactional
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
- Inline-code guards cannot import modules or access filesystem, environment,
  network, wall clock, or randomness; timeout, memory, stack, malformed output,
  and runtime traps fail closed with typed records.
- Artifact views are limited to declared artifacts, paths, byte caps, and
  redaction policies; an executor cannot dereference arbitrary artifact refs or
  obtain a full transcript through its input projection.
- Script guards receive only their declared JSON projection, run with a pinned
  source digest, registered runtime profile, and sandbox profile, and cannot
  inherit controller credentials or mutate the workspace, registry, context,
  or state.
- Script profiles reject arbitrary executable paths/arguments and require the
  single-document stdin/stdout transport; logs on stdout, malformed JSON, or
  an unregistered runtime profile fail closed.
- Docker profiles require an OCI digest (never a mutable tag), a recorded SBOM
  digest, the exact non-root run policy, and no Docker socket or undeclared
  mount. An inspection test proves a read-only root filesystem, `network none`,
  no added Linux capabilities, no privilege escalation, and the declared CPU,
  memory, PID, and tmpfs limits.
- The Docker runner accepts exactly one `GuardInput`, writes exactly one
  `GuardResult` on stdout, maps each contract exit code, emits only bounded
  redacted JSONL on stderr, and rejects a result with mismatched run/job,
  input, script, image, or profile identity.
- The trusted supervisor, not the App Server proxy or container, validates the
  typed `GuardJob`, stages inputs, applies timeout/cancellation, and performs
  the final CAS. A container cannot invoke the supervisor, reach a host socket,
  or request a second job.
- A script effect can patch only its declared registry paths; the same script
  cannot return a patch when configured as a guard.
- A stale executable-guard result is discarded after CAS rather than steering
  a later transition; repeated execution with the same fixed snapshot yields
  the same branch result for deterministic profiles.
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
| Inline guard CPU / memory / output | 50 ms / 1 MiB / 8 KiB |
| Script guard wall time / output | 500 ms / 8 KiB |
| Docker guard wall time / CPU / memory / PIDs | 5 s / 0.5 CPU / 128 MiB / 64 |
| Docker guard diagnostics | 64 KiB redacted JSONL; stdout result limited to 8 KiB |
| Executable guard attempts per transition | 1 |

The normal design/review path is seven states (five Terra/high and two
Sol/high); a bounded repair path is eleven (eight Terra/high and three
Sol/high). These counts are planning envelopes, not provider-token estimates.
Reserve capacity belongs to validation, independent review, and a compact
handoff rather than broad rediscovery.

## Non-goals

- Unprofiled arbitrary JavaScript, shell snippets, or user-provided code in
  guards.
- Unprofiled inline code or scripts, inherited shell environments, ambient
  credentials, implicit network access, or writable guard sandboxes.
- Docker socket/daemon access, `--privileged`, host networking, mutable image
  tags, runtime package installation, or repository/home-directory mounts in a
  guard container.
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
- `plugins/executor/lib/codex-app-server-transport.mjs`: the resident local
  App Server owner already creates the loopback runtime, starts the TUI, and
  owns route-injection lifecycle; this proposal extends that trusted owner with
  a narrow typed guard-job dispatcher rather than treating App Server traffic
  as a container protocol.
- `plugins/executor/lib/codex-app-server-route-proxy.mjs`: the proxy forwards
  JSON-RPC and injects a model route only at `turn/start`; it remains a TUI
  compatibility surface, not an executor or policy boundary.
- [Docker Engine security](https://docs.docker.com/engine/security/)
  (accessed 2026-08-16): daemon access and bind mounts are high-authority
  boundaries, so the executor never receives the Docker socket or broad host
  mounts.
- [Docker run reference](https://docs.docker.com/engine/containers/run/)
  (accessed 2026-08-16): resource and privilege restrictions are explicit run
  configuration, not secure defaults, motivating the profile-owned launcher.
- [Protect Docker daemon socket](https://docs.docker.com/engine/security/protect-access/)
  (accessed 2026-08-16): access to the daemon must stay with the trusted local
  supervisor and is never passed through to a guard job.
- [Wasmtime fuel-based interruption](https://docs.wasmtime.dev/examples-interrupting-wasm.html)
  (accessed 2026-08-16): a future WASM executor can use deterministic fuel
  limits; it is not an excuse to expose unrestricted WASI capabilities.
- [Wasmtime execution configuration](https://docs.wasmtime.dev/api/wasmtime/struct.Config.html)
  (accessed 2026-08-16): fuel and epochs do not cancel blocking host calls, so
  any subprocess or host capability still needs its own wall-clock timeout.
- [rquickjs](https://github.com/delskayn/rquickjs) (accessed 2026-08-16): a
  QuickJS binding is a candidate for the proposed isolated inline JavaScript
  executor, subject to a platform/dependency spike and the limits specified
  above.
