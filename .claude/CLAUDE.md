# statewright

State machine guardrails for AI agents. Define workflows that control which tools your agent can use in each phase — enforced at the protocol layer, not via prompts.

## What this repo contains

- `crates/engine/` — Pure Rust state machine engine (Apache 2.0)
- `crates/agent/` — LLM agent guardrail layer
- `plugins/` — Agent plugins (Claude Code, Codex, Cursor, opencode, Pi)
- `templates/` — Pre-built workflow definitions
- `docs/specs/` — Architecture and design documents
- `docs/experiments/` — Experiment reports with data

## Quick start

Install the Claude Code plugin:

```
/plugin marketplace add statewright/statewright
/plugin install statewright
```

## Managed cloud

The MCP gateway runs as a managed service at [statewright.ai](https://statewright.ai). Sign up, create workflows, connect your agent via MCP.

## License

Apache 2.0 — portions FSL-1.1-Apache-2.0
