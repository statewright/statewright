# Statewright — Operator Design

## Overview

The Statewright operator is a Kubernetes controller written in Rust using kube-rs. It manages the lifecycle of state machine definitions and instances as custom resources.

## Why Rust

- **kube-rs** (CNCF Sandbox, v3.1.0 as of March 2025): Production-ready controller runtime
- **Performance**: 68% resource reduction vs Go equivalents in production reports
- **Type safety**: Compile-time transition validation is possible via Rust's type system (the one good idea from krator)
- **Memory safety**: No GC pauses, predictable latency in reconciliation loops
- **`#[derive(CustomResource)]`**: Generates CRD scaffolding from Rust structs

### Alternative: Go + Kubebuilder

If broader contributor accessibility matters more than performance, Go + Kubebuilder is the ecosystem-standard choice. Operator SDK wraps Kubebuilder for Go projects. They share controller-runtime underneath.

Decision: Start with Rust/kube-rs. The operator is a small, focused codebase — contributor accessibility matters less than runtime efficiency for a component that manages potentially thousands of CRDs.

## CRD Definitions

### StateMachineDefinition

```rust
#[derive(CustomResource, Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[kube(
    group = "statewright.ai",
    version = "v1alpha1",
    kind = "StateMachineDefinition",
    namespaced,
    status = "StateMachineDefinitionStatus",
    shortname = "smd",
    printcolumn = r#"{"name":"Version","type":"string","jsonPath":".spec.version"}"#,
    printcolumn = r#"{"name":"States","type":"integer","jsonPath":".status.stateCount"}"#,
    printcolumn = r#"{"name":"Instances","type":"integer","jsonPath":".status.instanceCount"}"#,
    printcolumn = r#"{"name":"Age","type":"date","jsonPath":".metadata.creationTimestamp"}"#,
)]
pub struct StateMachineDefinitionSpec {
    pub version: String,
    pub initial_state: String,
    pub states: BTreeMap<String, StateSpec>,
    #[serde(default)]
    pub guards: BTreeMap<String, GuardSpec>,
    #[serde(default)]
    pub indexes: Vec<IndexSpec>,
    #[serde(default)]
    pub context_schema: Option<serde_json::Value>,
}

#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
pub struct StateSpec {
    #[serde(default)]
    pub on: BTreeMap<String, TransitionSpec>,
    #[serde(default, rename = "type")]
    pub state_type: Option<StateType>,  // "final", "parallel"
    #[serde(default)]
    pub after: Option<DelayedTransitionSpec>,  // delayed transitions
}

#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(untagged)]
pub enum TransitionSpec {
    Simple(String),  // just target state name
    Full {
        target: String,
        #[serde(default)]
        guard: Option<String>,
        #[serde(default)]
        actions: Vec<String>,
    },
}

#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
pub struct GuardSpec {
    pub condition: String,  // expression evaluated against context
}

#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
pub struct IndexSpec {
    pub field: String,
    #[serde(default)]
    pub context_path: Option<String>,  // JSONPath into context
}
```

### StateMachineInstance

```rust
#[derive(CustomResource, Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[kube(
    group = "statewright.ai",
    version = "v1alpha1",
    kind = "StateMachineInstance",
    namespaced,
    status = "StateMachineInstanceStatus",
    shortname = "smi",
    printcolumn = r#"{"name":"Definition","type":"string","jsonPath":".spec.definitionRef.name"}"#,
    printcolumn = r#"{"name":"State","type":"string","jsonPath":".status.currentState"}"#,
    printcolumn = r#"{"name":"Transitions","type":"integer","jsonPath":".status.transitionCount"}"#,
    printcolumn = r#"{"name":"Age","type":"date","jsonPath":".metadata.creationTimestamp"}"#,
)]
pub struct StateMachineInstanceSpec {
    pub definition_ref: DefinitionRef,
    #[serde(default)]
    pub initial_context: serde_json::Value,
}

#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
pub struct DefinitionRef {
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,  // None = latest
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
pub struct StateMachineInstanceStatus {
    pub current_state: String,
    pub context: serde_json::Value,
    pub transition_count: u64,
    pub version: String,
    pub last_transition: Option<TransitionRecord>,
    #[serde(default)]
    pub conditions: Vec<Condition>,
}

#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
pub struct TransitionRecord {
    pub from: String,
    pub to: String,
    pub event: String,
    pub timestamp: String,
}
```

## Reconciliation Loops

### StateMachineDefinition Reconciler

Triggered when a StateMachineDefinition CRD is created, updated, or deleted.

```
On CREATE:
  1. Validate state machine topology (all targets exist, no orphan states)
  2. Store definition metadata in Postgres (for fast query)
  3. Set status.stateCount, status.validated = true
  4. Emit Prometheus metric: smd_registered{name, version}

On UPDATE:
  → Definitions are immutable by convention. Create a new version instead.
  → If spec changes, reject via admission webhook.
  → Only metadata/labels can be updated.

On DELETE:
  1. Check for running instances referencing this definition
  2. If instances exist: block deletion (finalizer), set condition "HasInstances"
  3. If no instances: clean up Postgres metadata, allow deletion
```

### StateMachineInstance Reconciler

Triggered when an instance CRD is created, updated, or deleted.

```
On CREATE:
  1. Resolve definitionRef → get full machine definition
  2. Initialize Postgres row with initial state + context
  3. Create NATS subject: statewright.events.{namespace}.{name}
  4. Subscribe worker to instance subject
  5. Set status.currentState = definition.initialState
  6. Set labels: statewright.ai/state, statewright.ai/definition
  7. Set condition Ready = True

On STATUS UPDATE (from worker, after transition):
  1. Sync labels with new state (for kubectl queries)
  2. Update status.transitionCount
  3. Check for final state → if final, set condition Completed
  4. Emit Prometheus metrics

On DELETE:
  1. Unsubscribe NATS subject
  2. Release any held locks
  3. Archive or delete Postgres rows (configurable retention)
  4. Clean up NATS KV lock key
```

## Worker Architecture

Workers are stateless pods that process events from NATS and execute state machine transitions.

```
Worker Pod Lifecycle:
  1. Start up, connect to NATS and Postgres
  2. Register with operator (report capacity)
  3. Receive instance assignments (NATS subject subscriptions)
  4. For each event:
     a. Acquire NATS KV lock for instance
     b. Read current state from Postgres
     c. Look up machine definition
     d. Evaluate guard conditions against current context
     e. If guard passes: execute transition, compute new context
     f. Write new state + transition log atomically to Postgres
     g. Publish state change to NATS: statewright.state.{instance_id}
     h. Report new state to operator (triggers CRD status update)
     i. Release lock
  5. On shutdown: release all locks, drain NATS subscriptions gracefully
```

### Worker Scaling

- HPA based on NATS consumer lag (pending events per subject)
- Default: 3 worker replicas
- Scale up when: avg consumer lag > 100 events for > 30s
- Scale down when: avg consumer lag < 10 events for > 5m
- Max: configurable, default 20

### State Machine Execution

Workers need a state machine execution engine. Options:

1. **Embedded JS via V8 isolate** (QuickJS or Deno core): Run statechart definitions in a JavaScript runtime within the Rust worker. Maximum compatibility with existing JS state machine libraries.

2. **Native Rust state machine engine**: Parse the CRD spec and evaluate transitions natively. Faster, no JS runtime dependency.

3. **Hybrid**: Native Rust for simple transitions (90% of cases), V8 for complex guards/actions that need JavaScript evaluation.

Recommendation: Start with option 2 (native Rust). The CRD spec format is a declarative state/transition/guard model, not arbitrary JavaScript. Add JS evaluation capability later if needed for complex guard expressions.

## Admission Webhooks

### ValidatingWebhookConfiguration

```yaml
webhooks:
  - name: validate.statemachinedefinition.statewright.ai
    rules:
      - operations: ["CREATE", "UPDATE"]
        resources: ["statemachinedefinitions"]
    # Validates:
    # - All transition targets reference existing states
    # - At least one initial state exists
    # - No orphan states (unreachable from initial)
    # - Guard references resolve to defined guards
    # - Index field paths are valid

  - name: validate.statemachineinstance.statewright.ai
    rules:
      - operations: ["CREATE"]
        resources: ["statemachinainstances"]
    # Validates:
    # - definitionRef resolves to existing definition
    # - initialContext matches context schema (if defined)
    # - No duplicate instance for same definition + context key (optional)
```

### MutatingWebhookConfiguration

```yaml
webhooks:
  - name: mutate.statemachineinstance.statewright.ai
    rules:
      - operations: ["CREATE"]
        resources: ["statemachinainstances"]
    # Mutates:
    # - Adds statewright.ai/state label with initial state
    # - Adds statewright.ai/definition label
    # - Adds finalizer for cleanup
    # - Sets default context if not provided
```

## Helm Chart

```
statewright/
  Chart.yaml
  values.yaml
  templates/
    deployment.yaml          # Operator deployment
    worker-deployment.yaml   # Worker pool
    serviceaccount.yaml
    clusterrole.yaml
    clusterrolebinding.yaml
    crds/
      statemachinedefinition.yaml
      statemachinainstance.yaml
    webhooks/
      validating.yaml
      mutating.yaml
    hpa.yaml                 # Worker HPA
    servicemonitor.yaml      # Prometheus
```

### values.yaml (key fields)

```yaml
operator:
  replicas: 1
  resources:
    requests: { cpu: 100m, memory: 128Mi }
    limits: { cpu: 500m, memory: 256Mi }

workers:
  replicas: 3
  minReplicas: 1
  maxReplicas: 20
  resources:
    requests: { cpu: 250m, memory: 256Mi }
    limits: { cpu: 1000m, memory: 512Mi }

nats:
  # Use external NATS or deploy bundled
  external:
    url: ""  # nats://nats.nats.svc:4222
  bundled:
    enabled: true
    replicas: 3
    jetstream:
      enabled: true
      storage: 10Gi

postgres:
  # Use external Postgres or deploy bundled (CloudNativePG)
  external:
    host: ""
    database: statewright
  bundled:
    enabled: true
    instances: 2
    storage: 20Gi

metrics:
  enabled: true
  serviceMonitor:
    enabled: true
```

## Development Roadmap

### v0.1.0 — Minimum Viable Operator

- [ ] CRD definitions (StateMachineDefinition, StateMachineInstance)
- [ ] Basic reconciler (create/delete lifecycle)
- [ ] Postgres state storage (single table, JSONB context)
- [ ] NATS event routing (subject per instance)
- [ ] Simple transition execution (no guards, no actions)
- [ ] `kubectl get smi` with state column
- [ ] Helm chart with bundled NATS + Postgres

### v0.2.0 — Guards and Actions

- [ ] Guard evaluation (expression-based conditions on context)
- [ ] Context update actions (assign values on transition)
- [ ] NATS KV locking for sequential processing
- [ ] Transition log (append-only Postgres table)
- [ ] Label sync (state labels for kubectl queries)
- [ ] Admission webhooks (validation)

### v0.3.0 — Observability

- [ ] Prometheus metrics (transitions, instance counts, latency)
- [ ] `statewright` CLI tool
- [ ] Worker HPA based on NATS consumer lag
- [ ] Health monitoring (stale instance detection)
- [ ] Event-driven pub/sub for state changes

### v0.4.0 — Production Readiness

- [ ] Delayed transitions (after: timeout)
- [ ] Parallel states
- [ ] Instance garbage collection (TTL)
- [ ] Definition versioning and migration
- [ ] Finalizers for clean deletion
- [ ] Comprehensive integration tests

### v1.0.0 — Stable Release

- [ ] API stability guarantee
- [ ] Full documentation
- [ ] CNCF Sandbox application
- [ ] Managed cloud beta
