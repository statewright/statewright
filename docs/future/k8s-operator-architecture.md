# Statewright — Architecture

## Overview

Statewright is a Kubernetes-native state machine execution operator. It makes durable state machines first-class cluster resources via Custom Resource Definitions (CRDs).

The architecture splits cleanly into two planes:
- **Control Plane** (K8s operator): Lifecycle management, CRD reconciliation, resource scheduling, observability
- **Data Plane** (NATS + Postgres): High-frequency event processing, state persistence, pub/sub

This split exists because K8s and NATS are good at fundamentally different things. K8s excels at desired-state reconciliation on infrastructure timescales (seconds to minutes). NATS excels at high-throughput message routing on application timescales (milliseconds). Neither should pretend to be the other.

## System Diagram

```
┌──────────────────────────────────────────────────────────────┐
│  Kubernetes Control Plane                                     │
│                                                               │
│  ┌─────────────────────────────────┐                         │
│  │  Statewright Operator           │                         │
│  │  (Rust, kube-rs)               │                         │
│  │                                 │                         │
│  │  Reconciles:                    │                         │
│  │  - StateMachineDefinition CRDs  │                         │
│  │  - StateMachineInstance CRDs    │                         │
│  │  - Worker pool scaling          │                         │
│  │  - Health monitoring            │                         │
│  │  - Garbage collection           │                         │
│  └──────────────┬──────────────────┘                         │
│                 │                                             │
│  ┌──────────────▼──────────────────┐                         │
│  │  CRDs (etcd)                    │                         │
│  │                                 │                         │
│  │  StateMachineDefinition         │                         │
│  │  └─ states, transitions, guards │                         │
│  │  └─ versioned (immutable)       │                         │
│  │                                 │                         │
│  │  StateMachineInstance           │                         │
│  │  └─ .spec: definitionRef, ctx   │                         │
│  │  └─ .status: currentState       │                         │
│  │  └─ labels: state indexes       │                         │
│  └─────────────────────────────────┘                         │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Data Plane                                                   │
│                                                               │
│  ┌─────────────────┐    ┌──────────────────┐                 │
│  │  NATS JetStream  │    │  Worker Pods     │                 │
│  │  (Apache 2.0)    │◄──►│  (Stateless)     │                 │
│  │                  │    │                  │                 │
│  │  - Event routing │    │  - Transition exec│                 │
│  │  - Instance lock │    │  - Transition    │                 │
│  │  - Pub/sub       │    │    processing    │                 │
│  │  - Durable subs  │    │  - Guard eval    │                 │
│  └─────────────────┘    └────────┬─────────┘                 │
│                                  │                            │
│                         ┌────────▼─────────┐                 │
│                         │  PostgreSQL       │                 │
│                         │  (CloudNativePG)  │                 │
│                         │                   │                 │
│                         │  - State snapshots│                 │
│                         │  - Transition log │                 │
│                         │  - Context (JSONB)│                 │
│                         │  - Index queries  │                 │
│                         └───────────────────┘                 │
└──────────────────────────────────────────────────────────────┘
```

## Technology Stack

All components are permissively licensed. No copyleft. No bait-and-switch licenses.

| Component | Technology | License | CNCF Status | Role |
|-----------|-----------|---------|-------------|------|
| Operator framework | kube-rs 3.x | Apache 2.0 | Sandbox | CRD reconciliation, controller runtime |
| Event routing | NATS JetStream | Apache 2.0 | Incubating | Subject-based routing, durable pub/sub |
| Instance locking | NATS JetStream KV | Apache 2.0 | (part of NATS) | Atomic create for sequential processing |
| State persistence | PostgreSQL | PostgreSQL License | — | JSONB snapshots, transition log, indexes |
| K8s Postgres | CloudNativePG | Apache 2.0 | Sandbox | Postgres lifecycle on K8s |
| CNI (optional) | Cilium | Apache 2.0 | Graduated | Maglev consistent hashing bonus |

### Disqualified Technologies

| Technology | License | Date of Change | Reason |
|-----------|---------|---------------|--------|
| Redis | RSALv2/SSPL/AGPLv3 | March 2024 | Copyleft/restrictive |
| CockroachDB | Proprietary (revenue-gated) | November 2024 | Commercial restrictions |
| HashiCorp Consul/Vault | BSL 1.1 | August 2023 | Bait-and-switch |
| Redpanda | BSL 1.1 | Current | Commercial restrictions |
| Dragonfly | BSL 1.1 | Current | Commercial restrictions |

### Approved Alternatives

| Technology | License | Use Case | Notes |
|-----------|---------|----------|-------|
| Valkey | BSD 3-Clause | KV cache layer | Linux Foundation, Redis fork, matured (v9.0) |
| etcd | Apache 2.0 | Distributed locking | CNCF Graduated, alternative to NATS KV for locks |
| TiKV | Apache 2.0 | Horizontal KV scale | CNCF Graduated, if Postgres is outgrown |

## CRD Design

### StateMachineDefinition

Immutable schema defining a state machine's topology. Versioned like container image tags.

```yaml
apiVersion: statewright.ai/v1alpha1
kind: StateMachineDefinition
metadata:
  name: order-machine
spec:
  version: "1.2.0"
  initialState: draft
  context:
    schema:
      type: object
      properties:
        customerId: { type: string }
        items: { type: array }
        paymentMethod: { type: string }
  states:
    draft:
      on:
        ADD_ITEM: draft
        REMOVE_ITEM: draft
        SET_PAYMENT: draft
        SUBMIT:
          target: pending_payment
          guard: hasPaymentMethod
    pending_payment:
      on:
        CONFIRM_PAYMENT: confirmed
        PAYMENT_FAILED: draft
    confirmed:
      on:
        SHIP: shipped
        CANCEL: cancelled
    shipped:
      on:
        DELIVER: delivered
    delivered:
      type: final
    cancelled:
      type: final
  guards:
    hasPaymentMethod:
      condition: "context.paymentMethod != null"
  indexes:
    - field: status
    - field: customerId
      contextPath: context.customerId
```

### StateMachineInstance

A running instance of a machine definition. Mutable — status updates as the machine transitions.

```yaml
apiVersion: statewright.ai/v1alpha1
kind: StateMachineInstance
metadata:
  name: order-abc123
  labels:
    statewright.ai/state: draft
    statewright.ai/definition: order-machine
    statewright.ai/customer-id: cust-456
spec:
  definitionRef:
    name: order-machine
    version: "1.2.0"
  initialContext:
    customerId: "cust-456"
    items: []
status:
  currentState: draft
  context:
    customerId: "cust-456"
    items: []
  lastTransition:
    from: ""
    to: draft
    event: INIT
    timestamp: "2026-04-22T10:00:00Z"
  conditions:
    - type: Ready
      status: "True"
    - type: Healthy
      status: "True"
  transitionCount: 1
  version: "1.2.0"
```

## How NATS Covers Three Concerns

NATS JetStream is a single deployment that handles routing, locking, and pub/sub simultaneously.

### Routing

Each machine instance gets a dedicated NATS subject: `statewright.events.{instance_id}`. The worker pod that owns that instance subscribes to the subject with a queue group. Events self-route. No service mesh, no consistent hash ring.

```
Subject: statewright.events.order-abc123
Message: { "type": "CONFIRM_PAYMENT", "data": { "transactionId": "tx-789" } }
```

### Locking

NATS JetStream KV with atomic `Create` (fails if key exists). RAFT-backed linearizable writes. TTL via `MaxAge`.

```
Bucket: statewright-locks
Key: order-abc123
Value: worker-pod-3
TTL: 30s (auto-release on pod death)
```

This ensures exactly one worker processes events for a given instance at any time.

### Pub/Sub

State change notifications published to `statewright.state.{instance_id}`. Observers subscribe for real-time updates. JetStream durable consumers allow reconnecting observers to replay missed transitions.

```
Subject: statewright.state.order-abc123
Message: { "from": "draft", "to": "pending_payment", "event": "SUBMIT", "context": {...} }
```

## How PostgreSQL Handles Persistence

### Tables

```sql
-- Machine definition metadata (CRD is source of truth, this is query cache)
CREATE TABLE machine_definitions (
    name TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    spec JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Instance state snapshots
CREATE TABLE machine_instances (
    instance_id TEXT PRIMARY KEY,
    definition_name TEXT NOT NULL REFERENCES machine_definitions(name),
    definition_version TEXT NOT NULL,
    current_state TEXT NOT NULL,
    context JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Transition log (append-only)
CREATE TABLE transitions (
    id BIGSERIAL PRIMARY KEY,
    instance_id TEXT NOT NULL REFERENCES machine_instances(instance_id),
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_data JSONB,
    context_before JSONB,
    context_after JSONB,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for query performance
CREATE INDEX idx_instances_state ON machine_instances(current_state);
CREATE INDEX idx_instances_definition ON machine_instances(definition_name);
CREATE INDEX idx_instances_context ON machine_instances USING GIN(context);
CREATE INDEX idx_transitions_instance ON transitions(instance_id);
CREATE INDEX idx_transitions_timestamp ON transitions(timestamp);
```

### Atomic Transition

Each state transition is an atomic operation:

1. Acquire NATS KV lock for instance
2. Read current state from Postgres
3. Evaluate guard conditions
4. Execute transition (engine)
5. Write new state + transition log in single Postgres transaction
6. Publish state change to NATS subject
7. Update K8s CRD status (async, non-blocking)
8. Release NATS KV lock

Steps 4-6 are within the Postgres transaction. If any step fails, the transaction rolls back and the lock is released. The instance remains in its previous state.

## Operator Reconciliation

The reconciler handles lifecycle concerns, not event processing:

### What the Reconciler Does

- **Instance creation**: When a StateMachineInstance CRD is created, provision NATS subject, initialize Postgres row, set initial state
- **Definition versioning**: When a StateMachineDefinition CRD is updated, coordinate migration of instances to new version
- **Worker pool scaling**: HPA based on NATS consumer lag (pending events per subject)
- **Garbage collection**: TTL-based cleanup of completed/expired instances
- **Health monitoring**: Mark stale instances (no transitions within expected timeframe)
- **Label sync**: Keep K8s labels in sync with instance state for `kubectl get` queries

### What the Reconciler Does NOT Do

- Process individual events (that's NATS + workers)
- Execute state machine logic (that's workers)
- Store state (that's Postgres)
- Route messages (that's NATS)

This boundary is load-bearing. The reconciler touches etcd at infrastructure timescales (seconds). The data plane operates at application timescales (milliseconds). Mixing them hits etcd's hard limits (~30-40k objects, 1MiB per object, 100-500ms reconcile overhead).

## K8s-Native Observability

Everything integrates with existing K8s tooling:

```bash
# List all instances waiting for human approval
kubectl get statemachinainstances -l statewright.ai/state=awaiting_approval

# Describe instance for transition history
kubectl describe smi order-abc123

# Watch state changes in real-time
kubectl get smi --watch

# Prometheus metrics (exposed by reconciler)
statewright_transitions_total{definition="order-machine", from="draft", to="pending_payment"}
statewright_instance_count{definition="order-machine", state="confirmed"}
statewright_transition_duration_seconds{definition="order-machine", quantile="0.99"}
statewright_nats_consumer_lag{definition="order-machine"}

# GitOps with ArgoCD — machine definitions deployed like any other resource
# Kyverno policies — enforce transition constraints at admission
```

## LLM Agent Use Case

The primary use case. An LLM agent session becomes a StateMachineInstance:

```yaml
apiVersion: statewright.ai/v1alpha1
kind: StateMachineDefinition
metadata:
  name: tool-calling-agent
spec:
  version: "1.0.0"
  initialState: idle
  states:
    idle:
      on:
        START_TASK: planning
    planning:
      on:
        PLAN_READY: executing
        NEEDS_CLARIFICATION: awaiting_human_input
    awaiting_human_input:
      on:
        HUMAN_RESPONSE: planning
        CANCEL: cancelled
    executing:
      on:
        TOOL_RESULT: evaluating
        TOOL_ERROR: retrying
        DANGEROUS_ACTION: awaiting_approval
    awaiting_approval:
      on:
        APPROVE: executing
        REJECT: planning
        CANCEL: cancelled
    evaluating:
      on:
        NEEDS_MORE_TOOLS: executing
        TASK_COMPLETE: completed
        NEEDS_HUMAN_REVIEW: awaiting_approval
    retrying:
      on:
        RETRY: executing
        MAX_RETRIES: failed
    completed:
      type: final
    failed:
      type: final
    cancelled:
      type: final
```

Platform teams get:
- `kubectl get smi -l statewright.ai/state=awaiting_approval` — all agents waiting for human input
- Kyverno policies blocking transitions to dangerous states without approval
- Prometheus alerts on agents stuck in `retrying` state
- Full transition audit log in Postgres
- GitOps deploys new agent behavior definitions like any other K8s resource

## Local Agent Architecture

The K8s operator architecture above describes the production deployment model for multi-tenant, cluster-scale state machine orchestration. A second architecture exists for local development and single-machine agent workflows: the **hybrid execution model**.

### Overview

The local architecture splits execution between two binaries and an LLM inference server:

- **`statewright-gateway`** (MCP proxy): Enforces state machine guardrails at the tool-call layer. Runs as an MCP server or HTTP hook server. Intercepts tool calls from any host agent (Claude Code, Pi, Cursor, opencode), evaluates per-state tool restrictions, injects checkpoint prompts, and manages session state in memory.
- **`sw-agent`** (CLI agent): Executes LLM-driven workflow steps against a local Ollama instance. Supports per-state execution (`--state`), full workflow execution, and JSONL event streaming for gateway integration (`--json-events`).
- **Ollama**: Local LLM inference. Models run on commodity GPUs. The gateway or sw-agent selects models per state via the workflow definition's `model` field.

### System Diagram

```
┌────────────────────────────────────────────────────────────────┐
│  Host Agent (Claude Code / Pi / Cursor / opencode)             │
│                                                                │
│  ┌──────────────────────────────┐                              │
│  │  User prompt + tool calls    │                              │
│  │  (Read, Edit, Bash, etc.)    │                              │
│  └──────────────┬───────────────┘                              │
│                 │ MCP stdio / HTTP hooks                       │
│  ┌──────────────▼───────────────┐                              │
│  │  statewright-gateway         │                              │
│  │  (Rust, axum)                │                              │
│  │                              │                              │
│  │  - Pre/PostToolUse hooks     │                              │
│  │  - Per-state allowed_tools   │                              │
│  │  - Implicit transitions      │                              │
│  │  - Iteration tracking        │                              │
│  │  - Checkpoint injection      │                              │
│  │  - Stop validation           │                              │
│  │  - Bash command filtering    │                              │
│  │  - Session management        │                              │
│  └──────────────┬───────────────┘                              │
│                 │ statewright_run_agent                         │
│  ┌──────────────▼───────────────┐    ┌─────────────────────┐   │
│  │  sw-agent (CLI)              │    │  Ollama              │   │
│  │                              │◄──►│  (local inference)   │   │
│  │  - Per-state execution       │    │                      │   │
│  │  - Tool enforcement          │    │  - gemma4:31b        │   │
│  │  - Conversation management   │    │  - gpt-oss:20b       │   │
│  │  - Auto-test / minimizer     │    │  - llama3.3          │   │
│  │  - JSONL event streaming     │    │  - gemma4:e2b        │   │
│  └──────────────────────────────┘    └─────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

### Hybrid Execution Model

The gateway operates in two modes simultaneously:

1. **MCP proxy mode** (stdio): Sits between the host agent and upstream MCP servers. Intercepts tool calls, enforces per-state restrictions, and proxies allowed calls upstream. The host agent's own tools (Read, Edit, Bash) are filtered through the gateway's enforcement pipeline.

2. **Hook HTTP server** (`--hook-server`): Exposes `/hooks/state`, `/hooks/pre-tool`, `/hooks/post-tool`, and `/hooks/stop` endpoints. Claude Code hooks call these endpoints directly. The gateway evaluates tool permission and returns allow/deny decisions with optional context injection.

The `statewright_run_agent` MCP tool bridges the two: the gateway spawns `sw-agent` as a subprocess, passing a run config with model, state, tools, and context. `sw-agent` executes against Ollama and streams JSONL events back to the gateway.

### How It Differs from the K8s Architecture

| Dimension | K8s Operator | Local Agent |
|-----------|-------------|-------------|
| State persistence | PostgreSQL + etcd CRDs | In-memory (SessionManager) |
| Event routing | NATS JetStream subjects | Direct function calls |
| Worker management | HPA-scaled pod pool | Single sw-agent subprocess |
| Locking | NATS KV atomic create | Arc<RwLock> in process |
| Workflow definitions | CRDs in etcd | JSON config files or PocketBase |
| Observability | Prometheus + kubectl | JSONL events + TUI |
| Multi-tenant | Namespace isolation | Single user |

The local architecture is the development and single-agent path. The K8s architecture is the production multi-tenant path. Both share the same engine crate (`statewright-engine`) and agent crate (`statewright-agent`) for state machine evaluation and tool enforcement logic.

## Comparison to Existing Solutions

| Dimension | Statewright | StateBacked | Temporal | Restate |
|-----------|-------------|-------------|----------|---------|
| Deployment | Self-hosted K8s operator | Hosted SaaS | Self-hosted or Cloud | Self-hosted or Cloud |
| State model | Explicit FSM (CRDs) | Explicit FSM (JS) | Implicit (event history) | Implicit (journal) |
| K8s native | Yes (CRDs, labels, RBAC) | No | No | No |
| Human-in-the-loop | First-class (state parking) | Possible but not primary | Signal-based (bolted on) | Not primary |
| Debugging | kubectl + state inspection | API + dashboard | Event history replay | Journal replay |
| License | Apache 2.0 | Proprietary SaaS | MIT (server), Proprietary (cloud) | Proprietary |
| LLM agent focus | Primary use case | Not targeted | Emerging use case | Not targeted |
