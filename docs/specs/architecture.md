# Statewright — Architecture

## Overview

Statewright provides state machine guardrails for AI coding agents. The architecture splits execution between an MCP gateway that enforces per-state constraints at the tool-call layer and a CLI agent that executes LLM-driven workflow steps against local inference servers.

> The K8s operator architecture (CRDs, NATS, reconcilers) is preserved in `docs/future/k8s-operator-architecture.md`. It was never built; the actual product is the local agent architecture described here.

## Local Agent Architecture

The local architecture splits execution between two binaries and an LLM inference server:

- **`statewright-gateway`** (MCP proxy): Enforces state machine guardrails at the tool-call layer. Runs as an MCP server or HTTP hook server. Intercepts tool calls from any host agent (Claude Code, Pi, Cursor, opencode), evaluates per-state tool restrictions, injects checkpoint prompts, and manages session state in memory.
- **`sw-agent`** (CLI agent): Executes LLM-driven workflow steps against a local Ollama instance. Supports per-state execution (`--state`), full workflow execution, and JSONL event streaming for gateway integration (`--json-events`).
- **Ollama**: Local LLM inference. Models run on commodity GPUs. The gateway or sw-agent selects models per state via the workflow definition's `model` field.

### System Diagram

```
+----------------------------------------------------------------+
|  Host Agent (Claude Code / Pi / Cursor / opencode)             |
|                                                                |
|  +------------------------------+                              |
|  |  User prompt + tool calls    |                              |
|  |  (Read, Edit, Bash, etc.)    |                              |
|  +--------------+---------------+                              |
|                 | MCP stdio / HTTP hooks                       |
|  +--------------v---------------+                              |
|  |  statewright-gateway         |                              |
|  |  (Rust, axum)                |                              |
|  |                              |                              |
|  |  - Pre/PostToolUse hooks     |                              |
|  |  - Per-state allowed_tools   |                              |
|  |  - Implicit transitions      |                              |
|  |  - Iteration tracking        |                              |
|  |  - Checkpoint injection      |                              |
|  |  - Stop validation           |                              |
|  |  - Bash command filtering    |                              |
|  |  - Session management        |                              |
|  +--------------+---------------+                              |
|                 | statewright_run_agent                         |
|  +--------------v---------------+    +---------------------+   |
|  |  sw-agent (CLI)              |    |  Ollama              |   |
|  |                              |<-->|  (local inference)   |   |
|  |  - Per-state execution       |    |                      |   |
|  |  - Tool enforcement          |    |  - gemma4:31b        |   |
|  |  - Conversation management   |    |  - gpt-oss:20b       |   |
|  |  - Auto-test / minimizer     |    |  - llama3.3          |   |
|  |  - JSONL event streaming     |    |  - gemma4:e2b        |   |
|  +------------------------------+    +---------------------+   |
+----------------------------------------------------------------+
```

### Hybrid Execution Model

The gateway operates in two modes simultaneously:

1. **MCP proxy mode** (stdio): Sits between the host agent and upstream MCP servers. Intercepts tool calls, enforces per-state restrictions, and proxies allowed calls upstream. The host agent's own tools (Read, Edit, Bash) are filtered through the gateway's enforcement pipeline.

2. **Hook HTTP server** (`--hook-server`): Exposes `/hooks/state`, `/hooks/pre-tool`, `/hooks/post-tool`, and `/hooks/stop` endpoints. Claude Code hooks call these endpoints directly. The gateway evaluates tool permission and returns allow/deny decisions with optional context injection.

The `statewright_run_agent` MCP tool bridges the two: the gateway spawns `sw-agent` as a subprocess, passing a run config with model, state, tools, and context. `sw-agent` executes against Ollama and streams JSONL events back to the gateway.

## Technology Stack

All components are permissively licensed. No copyleft. No bait-and-switch licenses.

| Component | Technology | License | Role |
|-----------|-----------|---------|------|
| Gateway + Agent | Rust | MIT/Apache 2.0 | MCP proxy, CLI agent |
| HTTP layer | axum 0.8 | MIT | Gateway HTTP server |
| LLM inference | Ollama | MIT | Local model serving |
| State persistence | In-memory (SessionManager) | N/A | Session state |
| Workflow definitions | JSON config files or PocketBase | N/A | Workflow schemas |
| Event output | JSONL streaming | N/A | Gateway-agent communication |

## Comparison to Existing Solutions

| Dimension | Statewright | StateBacked | Temporal | Restate |
|-----------|-------------|-------------|----------|---------|
| Deployment | Local binary + MCP | Hosted SaaS | Self-hosted or Cloud | Self-hosted or Cloud |
| State model | Explicit FSM (JSON configs) | Explicit FSM (JS) | Implicit (event history) | Implicit (journal) |
| Human-in-the-loop | First-class (state parking) | Possible but not primary | Signal-based (bolted on) | Not primary |
| Debugging | JSONL events + TUI | API + dashboard | Event history replay | Journal replay |
| License | Apache 2.0 | Proprietary SaaS | MIT (server), Proprietary (cloud) | Proprietary |
| LLM agent focus | Primary use case | Not targeted | Emerging use case | Not targeted |
