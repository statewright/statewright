# Statewright contributor guide

Statewright provides protocol-level state-machine guardrails for AI coding
agents. This repository contains the public implementation and its public
documentation; private research, operational notes, credentials, and release
coordination belong in the Auldwyrm repository.

## Repository layout

- `crates/` — Rust engine, agent, CLI, and gateway components
- `plugins/` — integrations for supported coding-agent hosts
- `templates/` — public workflow definitions
- `docs/` — public architecture, guides, specifications, and experiments
- `self-hosted/` — self-hosted UI and PocketBase integration

## Public-development rules

- Never commit credentials, private keys, customer data, or internal
  operational plans.
- Keep benchmark/release evidence reproducible and label provisional results
  clearly.
- Do not place private research or deployment coordination in this repository;
  keep it in Auldwyrm.
- Preserve existing user changes and use focused commits.

## Quick start

Install the Claude Code plugin:

```
/plugin marketplace add statewright/statewright
/plugin install statewright
```

## Managed cloud

The managed gateway is documented at [statewright.ai](https://statewright.ai).

## License

Apache 2.0 — portions FSL-1.1-Apache-2.0.
